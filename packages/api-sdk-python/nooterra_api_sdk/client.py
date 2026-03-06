from __future__ import annotations

import json
import hashlib
import base64
import random
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterator, Optional
from urllib import error, parse, request


def _assert_non_empty_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _assert_sha256_hex(value: Any, name: str) -> str:
    raw = str(value).strip().lower() if isinstance(value, str) else ""
    if len(raw) != 64 or any(ch not in "0123456789abcdef" for ch in raw):
        raise ValueError(f"{name} must be sha256 hex")
    return raw


def _as_non_empty_string_or_none(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed if trimmed else None


def _assert_reason_code(value: Any, name: str) -> str:
    raw = _assert_non_empty_string(value, name).strip().upper()
    if not (2 <= len(raw) <= 64) or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" for ch in raw):
        raise ValueError(f"{name} must match ^[A-Z0-9_]{{2,64}}$")
    return raw


def _canonicalize(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, bool)):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            raise ValueError("Unsupported number for canonical JSON: non-finite")
        if isinstance(value, float) and value == 0.0 and str(value).startswith("-"):
            raise ValueError("Unsupported number for canonical JSON: -0")
        return value
    if isinstance(value, list):
        return [_canonicalize(item) for item in value]
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key in sorted(value.keys()):
            normalized = _canonicalize(value[key])
            if normalized is not None or value[key] is None:
                out[str(key)] = normalized
        return out
    raise ValueError(f"Unsupported value for canonical JSON: {type(value).__name__}")


def _canonical_json_dumps(value: Any) -> str:
    return json.dumps(_canonicalize(value), separators=(",", ":"), ensure_ascii=False)


def _sha256_hex_utf8(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sign_hash_hex_ed25519_base64(hash_hex: str, signer_private_key_pem: str) -> str:
    normalized_hash_hex = _assert_sha256_hex(hash_hex, "hash_hex")
    pem = _assert_non_empty_string(signer_private_key_pem, "signerPrivateKeyPem")
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except Exception as exc:
        raise ValueError("signerPrivateKeyPem signing requires the cryptography package") from exc
    try:
        private_key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
    except Exception as exc:
        raise ValueError("signerPrivateKeyPem must be a valid Ed25519 private key PEM") from exc
    if not isinstance(private_key, Ed25519PrivateKey):
        raise ValueError("signerPrivateKeyPem must be an Ed25519 private key PEM")
    signature_bytes = private_key.sign(bytes.fromhex(normalized_hash_hex))
    return base64.b64encode(signature_bytes).decode("ascii")


def _normalize_iso_date(value: Any, *, fallback_now: bool = False, name: str = "timestamp") -> str:
    if isinstance(value, str) and value.strip():
        raw = value.strip()
    elif fallback_now:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    else:
        raise ValueError(f"{name} is required")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception as exc:
        raise ValueError(f"{name} must be an ISO date string") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _random_request_id() -> str:
    return f"req_{uuid.uuid4().hex}"


def _normalize_prefix(value: Optional[str], fallback: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return fallback


def _decode_sse_data(raw_data: str) -> Any:
    if raw_data == "null":
        return None
    try:
        return json.loads(raw_data)
    except Exception:
        return raw_data


class NooterraApiError(Exception):
    def __init__(
        self,
        *,
        status: int,
        message: str,
        code: Optional[str] = None,
        details: Any = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details
        self.request_id = request_id

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "code": self.code,
            "message": str(self),
            "details": self.details,
            "requestId": self.request_id,
        }


_PARITY_DEFAULT_RETRY_STATUS_CODES = frozenset({408, 409, 425, 429, 500, 502, 503, 504})
_PARITY_REASON_CODE = {
    "OPERATION_INVALID": "PARITY_OPERATION_INVALID",
    "PAYLOAD_REQUIRED": "PARITY_PAYLOAD_REQUIRED",
    "REQUIRED_FIELD_MISSING": "PARITY_REQUIRED_FIELD_MISSING",
    "SHA256_FIELD_INVALID": "PARITY_SHA256_FIELD_INVALID",
    "IDEMPOTENCY_KEY_REQUIRED": "PARITY_IDEMPOTENCY_KEY_REQUIRED",
    "EXPECTED_PREV_CHAIN_HASH_REQUIRED": "PARITY_EXPECTED_PREV_CHAIN_HASH_REQUIRED",
    "MCP_CALL_REQUIRED": "PARITY_MCP_CALL_REQUIRED",
    "RESPONSE_INVALID": "PARITY_RESPONSE_INVALID",
    "TRANSPORT_ERROR": "PARITY_TRANSPORT_ERROR",
    "REQUEST_REJECTED": "PARITY_REQUEST_REJECTED",
}


def _normalize_headers_record(value: Any) -> Dict[str, str]:
    if not isinstance(value, dict):
        return {}
    out: Dict[str, str] = {}
    for raw_key, raw_value in value.items():
        if raw_value is None:
            continue
        out[str(raw_key).lower()] = str(raw_value)
    return out


def _get_value_at_path(target: Any, field_path: str) -> Any:
    parts = [part for part in str(field_path).split(".") if part]
    cursor = target
    for part in parts:
        if not isinstance(cursor, dict) or part not in cursor:
            return None
        cursor = cursor.get(part)
    return cursor


def _normalize_retry_status_codes(value: Any) -> set[int]:
    if value is None:
        return set(_PARITY_DEFAULT_RETRY_STATUS_CODES)
    if not isinstance(value, list):
        raise ValueError("retry_status_codes must be a list of status integers")
    out: set[int] = set()
    for raw in value:
        status = int(raw)
        if status < 100 or status > 599:
            raise ValueError("retry_status_codes must contain valid HTTP status integers")
        out.add(status)
    return out


def _normalize_retry_codes(value: Any) -> set[str]:
    if value is None:
        return set()
    if not isinstance(value, list):
        raise ValueError("retry_codes must be a list of non-empty strings")
    out: set[str] = set()
    for raw in value:
        code = _as_non_empty_string_or_none(raw)
        if code is None:
            raise ValueError("retry_codes must contain non-empty strings")
        out.add(code.upper())
    return out


def _resolve_retry_delay_seconds(retry_delay_seconds: Any, attempt: int) -> float:
    if callable(retry_delay_seconds):
        value = float(retry_delay_seconds(attempt))
    elif retry_delay_seconds is None:
        value = 0.0
    else:
        value = float(retry_delay_seconds)
    if value < 0:
        raise ValueError("retry_delay_seconds must be a non-negative number")
    return value


def _coerce_http_status_or_none(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        parsed = int(str(value).strip()) if isinstance(value, str) else int(value)
    except Exception:
        return None
    if parsed < 100 or parsed > 599:
        return None
    return parsed


class NooterraParityError(NooterraApiError):
    def __init__(
        self,
        *,
        status: int,
        message: str,
        code: Optional[str] = None,
        details: Any = None,
        request_id: Optional[str] = None,
        retryable: bool = False,
        attempts: int = 1,
        idempotency_key: Optional[str] = None,
        transport: str = "http",
        operation_id: Optional[str] = None,
    ) -> None:
        super().__init__(status=status, message=message, code=code, details=details, request_id=request_id)
        self.retryable = bool(retryable)
        self.attempts = int(attempts) if int(attempts) > 0 else 1
        self.idempotency_key = idempotency_key
        self.transport = transport
        self.operation_id = operation_id

    def to_dict(self) -> Dict[str, Any]:
        out = super().to_dict()
        out.update(
            {
                "retryable": self.retryable,
                "attempts": self.attempts,
                "idempotencyKey": self.idempotency_key,
                "transport": self.transport,
                "operationId": self.operation_id,
            }
        )
        return out


def _create_parity_error(
    *,
    status: int = 500,
    code: str = _PARITY_REASON_CODE["REQUEST_REJECTED"],
    message: str = "request failed",
    details: Any = None,
    request_id: Optional[str] = None,
    retryable: bool = False,
    attempts: int = 1,
    idempotency_key: Optional[str] = None,
    transport: str = "http",
    operation_id: Optional[str] = None,
) -> NooterraParityError:
    normalized_message = _as_non_empty_string_or_none(message) or f"request failed ({status})"
    normalized_code = _as_non_empty_string_or_none(code) or _PARITY_REASON_CODE["REQUEST_REJECTED"]
    return NooterraParityError(
        status=int(status),
        code=normalized_code,
        message=normalized_message,
        details=details,
        request_id=_as_non_empty_string_or_none(request_id),
        retryable=retryable,
        attempts=attempts,
        idempotency_key=_as_non_empty_string_or_none(idempotency_key),
        transport=transport,
        operation_id=_as_non_empty_string_or_none(operation_id),
    )


def _raise_parity_validation_error(
    *,
    code: str,
    message: str,
    transport: str,
    operation_id: Optional[str],
    idempotency_key: Optional[str] = None,
    details: Any = None,
) -> None:
    raise _create_parity_error(
        status=400,
        code=code,
        message=message,
        details=details,
        request_id=None,
        retryable=False,
        attempts=1,
        idempotency_key=idempotency_key,
        transport=transport,
        operation_id=operation_id,
    )


def _resolve_parity_operation(operation: Dict[str, Any], *, transport: str) -> Dict[str, Any]:
    if not isinstance(operation, dict):
        raise ValueError("operation must be an object")
    operation_id = _as_non_empty_string_or_none(operation.get("operationId"))
    if operation_id is None:
        raise ValueError("operation.operationId is required")
    required_fields = [str(item) for item in operation.get("requiredFields", [])] if isinstance(operation.get("requiredFields"), list) else []
    sha256_fields = [str(item) for item in operation.get("sha256Fields", [])] if isinstance(operation.get("sha256Fields"), list) else []
    if operation.get("idempotencyRequired") is None:
        idempotency_required = True
    else:
        idempotency_required = bool(operation.get("idempotencyRequired"))
    expected_prev_chain_hash_required = bool(operation.get("expectedPrevChainHashRequired"))
    if transport == "http":
        method = _as_non_empty_string_or_none(operation.get("method"))
        path = _as_non_empty_string_or_none(operation.get("path"))
        if method is None:
            raise ValueError("operation.method is required for http parity adapter")
        if path is None or not path.startswith("/"):
            raise ValueError("operation.path is required for http parity adapter")
        return {
            "transport": transport,
            "operationId": operation_id,
            "method": method.upper(),
            "path": path,
            "toolName": None,
            "requiredFields": required_fields,
            "sha256Fields": sha256_fields,
            "idempotencyRequired": idempotency_required,
            "expectedPrevChainHashRequired": expected_prev_chain_hash_required,
        }
    tool_name = _as_non_empty_string_or_none(operation.get("toolName"))
    if tool_name is None:
        raise ValueError("operation.toolName is required for mcp parity adapter")
    return {
        "transport": transport,
        "operationId": operation_id,
        "method": None,
        "path": None,
        "toolName": tool_name,
        "requiredFields": required_fields,
        "sha256Fields": sha256_fields,
        "idempotencyRequired": idempotency_required,
        "expectedPrevChainHashRequired": expected_prev_chain_hash_required,
    }


def _validate_parity_payload(
    payload: Any,
    operation: Dict[str, Any],
    *,
    transport: str,
    idempotency_key: Optional[str],
    expected_prev_chain_hash: Optional[str],
) -> None:
    if not isinstance(payload, dict):
        _raise_parity_validation_error(
            code=_PARITY_REASON_CODE["PAYLOAD_REQUIRED"],
            message="payload must be an object",
            transport=transport,
            operation_id=operation.get("operationId"),
            idempotency_key=idempotency_key,
        )
    for field_path in operation.get("requiredFields", []):
        value = _get_value_at_path(payload, str(field_path))
        if value is None or (isinstance(value, str) and value.strip() == ""):
            _raise_parity_validation_error(
                code=_PARITY_REASON_CODE["REQUIRED_FIELD_MISSING"],
                message=f"payload.{field_path} is required",
                transport=transport,
                operation_id=operation.get("operationId"),
                idempotency_key=idempotency_key,
                details={"field": str(field_path)},
            )
    for field_path in operation.get("sha256Fields", []):
        value = _get_value_at_path(payload, str(field_path))
        try:
            _assert_sha256_hex(value, f"payload.{field_path}")
        except Exception:
            _raise_parity_validation_error(
                code=_PARITY_REASON_CODE["SHA256_FIELD_INVALID"],
                message=f"payload.{field_path} must be sha256 hex",
                transport=transport,
                operation_id=operation.get("operationId"),
                idempotency_key=idempotency_key,
                details={"field": str(field_path)},
            )
    if operation.get("idempotencyRequired") and _as_non_empty_string_or_none(idempotency_key) is None:
        _raise_parity_validation_error(
            code=_PARITY_REASON_CODE["IDEMPOTENCY_KEY_REQUIRED"],
            message="idempotency_key is required",
            transport=transport,
            operation_id=operation.get("operationId"),
        )
    if operation.get("expectedPrevChainHashRequired") and _as_non_empty_string_or_none(expected_prev_chain_hash) is None:
        _raise_parity_validation_error(
            code=_PARITY_REASON_CODE["EXPECTED_PREV_CHAIN_HASH_REQUIRED"],
            message="expected_prev_chain_hash is required",
            transport=transport,
            operation_id=operation.get("operationId"),
            idempotency_key=idempotency_key,
        )
    if _as_non_empty_string_or_none(expected_prev_chain_hash) is not None:
        try:
            _assert_sha256_hex(expected_prev_chain_hash, "expected_prev_chain_hash")
        except Exception:
            _raise_parity_validation_error(
                code=_PARITY_REASON_CODE["EXPECTED_PREV_CHAIN_HASH_REQUIRED"],
                message="expected_prev_chain_hash must be sha256 hex",
                transport=transport,
                operation_id=operation.get("operationId"),
                idempotency_key=idempotency_key,
            )


def _coerce_parity_error(
    exc: Exception,
    *,
    transport: str,
    operation_id: str,
    request_id: str,
    idempotency_key: Optional[str],
    attempt: int,
) -> NooterraParityError:
    if isinstance(exc, NooterraParityError):
        return _create_parity_error(
            status=exc.status,
            code=exc.code or _PARITY_REASON_CODE["REQUEST_REJECTED"],
            message=str(exc),
            details=exc.details,
            request_id=exc.request_id or request_id,
            retryable=exc.retryable,
            attempts=attempt,
            idempotency_key=idempotency_key,
            transport=transport,
            operation_id=operation_id,
        )
    if isinstance(exc, NooterraApiError):
        return _create_parity_error(
            status=exc.status,
            code=exc.code or _PARITY_REASON_CODE["REQUEST_REJECTED"],
            message=str(exc),
            details=exc.details,
            request_id=exc.request_id or request_id,
            retryable=False,
            attempts=attempt,
            idempotency_key=idempotency_key,
            transport=transport,
            operation_id=operation_id,
        )
    return _create_parity_error(
        status=0,
        code=_PARITY_REASON_CODE["TRANSPORT_ERROR"],
        message=str(exc) if str(exc) else "transport error",
        details={"causeName": type(exc).__name__},
        request_id=request_id,
        retryable=False,
        attempts=attempt,
        idempotency_key=idempotency_key,
        transport=transport,
        operation_id=operation_id,
    )


class _NooterraParityAdapterBase:
    def __init__(
        self,
        *,
        client: "NooterraClient",
        transport: str,
        max_attempts: int = 3,
        retry_status_codes: Optional[list[int]] = None,
        retry_codes: Optional[list[str]] = None,
        retry_delay_seconds: Any = 0.0,
    ) -> None:
        self.client = client
        self.transport = transport
        self.max_attempts = int(max_attempts)
        if self.max_attempts <= 0:
            raise ValueError("max_attempts must be a positive integer")
        self.retry_status_codes = _normalize_retry_status_codes(retry_status_codes)
        self.retry_codes = _normalize_retry_codes(retry_codes)
        self.retry_delay_seconds = retry_delay_seconds

    def _is_retryable(self, parity_error: NooterraParityError) -> bool:
        status = int(parity_error.status)
        code = _as_non_empty_string_or_none(parity_error.code)
        if status <= 0:
            return True
        if status in self.retry_status_codes:
            return True
        if code is not None and code.upper() in self.retry_codes:
            return True
        return False

    def invoke(
        self,
        operation: Dict[str, Any],
        payload: Dict[str, Any],
        *,
        request_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        expected_prev_chain_hash: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
        signal: Any = None,
    ) -> Dict[str, Any]:
        try:
            resolved_operation = _resolve_parity_operation(operation, transport=self.transport)
        except Exception as exc:
            _raise_parity_validation_error(
                code=_PARITY_REASON_CODE["OPERATION_INVALID"],
                message=str(exc) if str(exc) else "operation is invalid",
                transport=self.transport,
                operation_id=operation.get("operationId") if isinstance(operation, dict) else None,
                idempotency_key=idempotency_key,
            )
        resolved_request_id = _as_non_empty_string_or_none(request_id) or _random_request_id()
        resolved_idempotency_key = _as_non_empty_string_or_none(idempotency_key)
        resolved_expected_prev_chain_hash = _as_non_empty_string_or_none(expected_prev_chain_hash)
        _validate_parity_payload(
            payload,
            resolved_operation,
            transport=self.transport,
            idempotency_key=resolved_idempotency_key,
            expected_prev_chain_hash=resolved_expected_prev_chain_hash,
        )

        for attempt in range(1, self.max_attempts + 1):
            try:
                raw = self._invoke_once(
                    resolved_operation,
                    payload,
                    request_id=resolved_request_id,
                    idempotency_key=resolved_idempotency_key,
                    expected_prev_chain_hash=resolved_expected_prev_chain_hash,
                    timeout_seconds=timeout_seconds,
                    signal=signal,
                )
                if not isinstance(raw, dict):
                    raise _create_parity_error(
                        status=502,
                        code=_PARITY_REASON_CODE["RESPONSE_INVALID"],
                        message="transport response must be an object",
                        request_id=resolved_request_id,
                        idempotency_key=resolved_idempotency_key,
                        transport=self.transport,
                        operation_id=resolved_operation.get("operationId"),
                    )
                headers = _normalize_headers_record(raw.get("headers"))
                request_id_out = _as_non_empty_string_or_none(raw.get("requestId")) or headers.get("x-request-id")
                status = raw.get("status")
                if not isinstance(status, int):
                    raise _create_parity_error(
                        status=502,
                        code=_PARITY_REASON_CODE["RESPONSE_INVALID"],
                        message="transport response missing valid status",
                        request_id=request_id_out or resolved_request_id,
                        idempotency_key=resolved_idempotency_key,
                        transport=self.transport,
                        operation_id=resolved_operation.get("operationId"),
                    )
                if bool(raw.get("ok")) is False or status >= 400:
                    raise _create_parity_error(
                        status=status,
                        code=_as_non_empty_string_or_none(raw.get("code")) or _PARITY_REASON_CODE["REQUEST_REJECTED"],
                        message=_as_non_empty_string_or_none(raw.get("message")) or f"request failed ({status})",
                        details=raw.get("details"),
                        request_id=request_id_out or resolved_request_id,
                        idempotency_key=resolved_idempotency_key,
                        transport=self.transport,
                        operation_id=resolved_operation.get("operationId"),
                    )
                return {
                    "ok": True,
                    "status": status,
                    "requestId": request_id_out,
                    "body": raw.get("body"),
                    "headers": headers,
                    "transport": self.transport,
                    "operationId": resolved_operation.get("operationId"),
                    "idempotencyKey": resolved_idempotency_key,
                    "attempts": attempt,
                }
            except Exception as exc:
                parity_error = _coerce_parity_error(
                    exc,
                    transport=self.transport,
                    operation_id=str(resolved_operation.get("operationId")),
                    request_id=resolved_request_id,
                    idempotency_key=resolved_idempotency_key,
                    attempt=attempt,
                )
                parity_error.retryable = self._is_retryable(parity_error)
                parity_error.attempts = attempt
                if (not parity_error.retryable) or attempt >= self.max_attempts:
                    raise parity_error
                delay_seconds = _resolve_retry_delay_seconds(self.retry_delay_seconds, attempt)
                if delay_seconds > 0:
                    time.sleep(delay_seconds)
        raise _create_parity_error(
            status=500,
            code=_PARITY_REASON_CODE["REQUEST_REJECTED"],
            message="request failed",
            request_id=resolved_request_id,
            idempotency_key=resolved_idempotency_key,
            transport=self.transport,
            operation_id=str(resolved_operation.get("operationId")),
        )

    def _invoke_once(
        self,
        operation: Dict[str, Any],
        payload: Dict[str, Any],
        *,
        request_id: str,
        idempotency_key: Optional[str],
        expected_prev_chain_hash: Optional[str],
        timeout_seconds: Optional[float],
        signal: Any,
    ) -> Dict[str, Any]:
        raise NotImplementedError


class NooterraHttpParityAdapter(_NooterraParityAdapterBase):
    def __init__(self, *, client: "NooterraClient", **opts: Any) -> None:
        super().__init__(client=client, transport="http", **opts)

    def _invoke_once(
        self,
        operation: Dict[str, Any],
        payload: Dict[str, Any],
        *,
        request_id: str,
        idempotency_key: Optional[str],
        expected_prev_chain_hash: Optional[str],
        timeout_seconds: Optional[float],
        signal: Any,
    ) -> Dict[str, Any]:
        _ = signal  # signal is accepted for API symmetry with JS adapter.
        return self.client._request(
            operation.get("method"),
            operation.get("path"),
            body=payload,
            request_id=request_id,
            idempotency_key=idempotency_key,
            expected_prev_chain_hash=expected_prev_chain_hash,
            timeout_seconds=timeout_seconds,
        )


class NooterraMcpParityAdapter(_NooterraParityAdapterBase):
    def __init__(
        self,
        *,
        client: "NooterraClient",
        call_tool: Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]] = None,
        **opts: Any,
    ) -> None:
        super().__init__(client=client, transport="mcp", **opts)
        self.call_tool = call_tool

    def _invoke_once(
        self,
        operation: Dict[str, Any],
        payload: Dict[str, Any],
        *,
        request_id: str,
        idempotency_key: Optional[str],
        expected_prev_chain_hash: Optional[str],
        timeout_seconds: Optional[float],
        signal: Any,
    ) -> Dict[str, Any]:
        if not callable(self.call_tool):
            _raise_parity_validation_error(
                code=_PARITY_REASON_CODE["MCP_CALL_REQUIRED"],
                message="call_tool function is required",
                transport=self.transport,
                operation_id=operation.get("operationId"),
                idempotency_key=idempotency_key,
            )
        raw = self.call_tool(
            str(operation.get("toolName")),
            {
                "operationId": operation.get("operationId"),
                "payload": payload,
                "requestId": request_id,
                "idempotencyKey": idempotency_key,
                "expectedPrevChainHash": expected_prev_chain_hash,
                "timeoutSeconds": timeout_seconds,
                "signal": signal,
                "headers": {
                    "x-request-id": request_id,
                    **({"x-idempotency-key": idempotency_key} if idempotency_key else {}),
                    **({"x-proxy-expected-prev-chain-hash": expected_prev_chain_hash} if expected_prev_chain_hash else {}),
                },
            },
        )
        if not isinstance(raw, dict):
            raise _create_parity_error(
                status=502,
                code=_PARITY_REASON_CODE["RESPONSE_INVALID"],
                message="mcp response must be an object",
                request_id=request_id,
                idempotency_key=idempotency_key,
                transport=self.transport,
                operation_id=operation.get("operationId"),
            )
        headers = _normalize_headers_record(raw.get("headers"))
        response_request_id = _as_non_empty_string_or_none(raw.get("requestId")) or headers.get("x-request-id") or request_id
        default_status = 500 if (raw.get("ok") is False or raw.get("error") is not None) else 200
        try:
            status = int(raw.get("status")) if raw.get("status") is not None else default_status
        except Exception:
            raise _create_parity_error(
                status=502,
                code=_PARITY_REASON_CODE["RESPONSE_INVALID"],
                message="mcp response status must be a valid HTTP status integer",
                request_id=response_request_id,
                idempotency_key=idempotency_key,
                transport=self.transport,
                operation_id=operation.get("operationId"),
            )
        if raw.get("ok") is False or raw.get("error") is not None or status >= 400:
            err_body = raw.get("error") if isinstance(raw.get("error"), dict) else {}
            error_status = _coerce_http_status_or_none(err_body.get("status"))
            raise _create_parity_error(
                status=error_status if error_status is not None else status,
                code=_as_non_empty_string_or_none(raw.get("code"))
                or _as_non_empty_string_or_none(err_body.get("code"))
                or _PARITY_REASON_CODE["REQUEST_REJECTED"],
                message=_as_non_empty_string_or_none(raw.get("message"))
                or _as_non_empty_string_or_none(err_body.get("message"))
                or _as_non_empty_string_or_none(err_body.get("error"))
                or f"request failed ({status})",
                details=raw.get("details") if raw.get("details") is not None else err_body.get("details"),
                request_id=response_request_id,
                idempotency_key=idempotency_key,
                transport=self.transport,
                operation_id=operation.get("operationId"),
            )
        return {
            "ok": True,
            "status": status,
            "requestId": response_request_id,
            "headers": headers,
            "body": raw.get("body", raw.get("result", raw.get("data"))),
        }


class NooterraClient:
    def __init__(
        self,
        *,
        base_url: str,
        tenant_id: str,
        protocol: str = "1.0",
        api_key: Optional[str] = None,
        x_api_key: Optional[str] = None,
        ops_token: Optional[str] = None,
        user_agent: Optional[str] = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        self.base_url = _assert_non_empty_string(base_url, "base_url").rstrip("/")
        self.tenant_id = _assert_non_empty_string(tenant_id, "tenant_id")
        self.protocol = protocol
        self.api_key = api_key
        self.x_api_key = x_api_key
        self.ops_token = ops_token
        self.user_agent = user_agent
        self.timeout_seconds = timeout_seconds

    def create_http_parity_adapter(self, **opts: Any) -> NooterraHttpParityAdapter:
        return NooterraHttpParityAdapter(client=self, **opts)

    def create_mcp_parity_adapter(
        self,
        *,
        call_tool: Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]] = None,
        **opts: Any,
    ) -> NooterraMcpParityAdapter:
        return NooterraMcpParityAdapter(client=self, call_tool=call_tool, **opts)

    def _query_suffix(self, query: Optional[Dict[str, Any]] = None, *, allowed_keys: Optional[list[str]] = None) -> str:
        if not isinstance(query, dict):
            return ""
        params: Dict[str, str] = {}
        keys = allowed_keys if isinstance(allowed_keys, list) else list(query.keys())
        for key in keys:
            if not isinstance(key, str) or not key:
                continue
            if key not in query:
                continue
            value = query.get(key)
            if value is None:
                continue
            if isinstance(value, bool):
                params[key] = "true" if value else "false"
            else:
                params[key] = str(value)
        if not params:
            return ""
        return f"?{parse.urlencode(params)}"

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Dict[str, Any]] = None,
        request_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        expected_prev_chain_hash: Optional[str] = None,
        principal_id: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        rid = request_id if request_id else _random_request_id()
        headers = {
            "content-type": "application/json",
            "x-proxy-tenant-id": self.tenant_id,
            "x-nooterra-protocol": self.protocol,
            "x-request-id": rid,
        }
        if self.user_agent:
            headers["user-agent"] = self.user_agent
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        if self.x_api_key:
            headers["x-api-key"] = str(self.x_api_key)
        if self.ops_token:
            headers["x-proxy-ops-token"] = str(self.ops_token)
        if idempotency_key:
            headers["x-idempotency-key"] = str(idempotency_key)
        if expected_prev_chain_hash:
            headers["x-proxy-expected-prev-chain-hash"] = str(expected_prev_chain_hash)
        if isinstance(principal_id, str) and principal_id.strip():
            headers["x-proxy-principal-id"] = principal_id.strip()

        url = parse.urljoin(f"{self.base_url}/", path.lstrip("/"))
        payload = None if body is None else json.dumps(body).encode("utf-8")
        req = request.Request(url=url, data=payload, method=method, headers=headers)
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        try:
            with request.urlopen(req, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
                parsed = None
                if raw:
                    try:
                        parsed = json.loads(raw)
                    except json.JSONDecodeError:
                        parsed = {"raw": raw}
                response_headers = {str(k).lower(): str(v) for k, v in response.headers.items()}
                return {
                    "ok": True,
                    "status": int(response.status),
                    "requestId": response_headers.get("x-request-id"),
                    "body": parsed,
                    "headers": response_headers,
                }
        except error.HTTPError as http_error:
            raw = http_error.read().decode("utf-8")
            parsed: Any = {}
            if raw:
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = {"raw": raw}
            response_headers = {str(k).lower(): str(v) for k, v in http_error.headers.items()}
            raise NooterraApiError(
                status=int(http_error.code),
                code=parsed.get("code") if isinstance(parsed, dict) else None,
                message=parsed.get("error", f"request failed ({http_error.code})") if isinstance(parsed, dict) else f"request failed ({http_error.code})",
                details=parsed.get("details") if isinstance(parsed, dict) else None,
                request_id=response_headers.get("x-request-id"),
            ) from http_error

    def register_agent(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("publicKeyPem"), "body.publicKeyPem")
        return self._request("POST", "/agents/register", body=body, **opts)

    def credit_agent_wallet(self, agent_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(agent_id, "agent_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", f"/agents/{parse.quote(agent_id, safe='')}/wallet/credit", body=body, **opts)

    def get_agent_wallet(self, agent_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(agent_id, "agent_id")
        return self._request("GET", f"/agents/{parse.quote(agent_id, safe='')}/wallet", **opts)

    def create_agent_run(self, agent_id: str, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(agent_id, "agent_id")
        run_body = {} if body is None else body
        if not isinstance(run_body, dict):
            raise ValueError("body must be an object")
        return self._request("POST", f"/agents/{parse.quote(agent_id, safe='')}/runs", body=run_body, **opts)

    def append_agent_run_event(
        self,
        agent_id: str,
        run_id: str,
        body: Dict[str, Any],
        *,
        expected_prev_chain_hash: str,
        **opts: Any,
    ) -> Dict[str, Any]:
        _assert_non_empty_string(agent_id, "agent_id")
        _assert_non_empty_string(run_id, "run_id")
        _assert_non_empty_string(expected_prev_chain_hash, "expected_prev_chain_hash")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("type"), "body.type")
        return self._request(
            "POST",
            f"/agents/{parse.quote(agent_id, safe='')}/runs/{parse.quote(run_id, safe='')}/events",
            body=body,
            expected_prev_chain_hash=expected_prev_chain_hash,
            **opts,
        )

    def get_agent_run(self, agent_id: str, run_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(agent_id, "agent_id")
        _assert_non_empty_string(run_id, "run_id")
        return self._request("GET", f"/agents/{parse.quote(agent_id, safe='')}/runs/{parse.quote(run_id, safe='')}", **opts)

    def list_agent_run_events(self, agent_id: str, run_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(agent_id, "agent_id")
        _assert_non_empty_string(run_id, "run_id")
        return self._request("GET", f"/agents/{parse.quote(agent_id, safe='')}/runs/{parse.quote(run_id, safe='')}/events", **opts)

    def get_run_verification(self, run_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(run_id, "run_id")
        return self._request("GET", f"/runs/{parse.quote(run_id, safe='')}/verification", **opts)

    def get_run_settlement(self, run_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(run_id, "run_id")
        return self._request("GET", f"/runs/{parse.quote(run_id, safe='')}/settlement", **opts)

    def get_run_settlement_policy_replay(self, run_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(run_id, "run_id")
        return self._request("GET", f"/runs/{parse.quote(run_id, safe='')}/settlement/policy-replay", **opts)

    def resolve_run_settlement(self, run_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(run_id, "run_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", f"/runs/{parse.quote(run_id, safe='')}/settlement/resolve", body=body, **opts)

    def upsert_agent_card(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("agentId"), "body.agentId")
        return self._request("POST", "/agent-cards", body=body, **opts)

    def list_agent_cards(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=[
                "agentId",
                "status",
                "visibility",
                "capability",
                "executionCoordinatorDid",
                "runtime",
                "supportsPolicyTemplate",
                "supportsEvidencePack",
                "limit",
                "offset",
                "toolId",
                "toolMcpName",
                "toolRiskClass",
                "toolSideEffecting",
                "toolMaxPriceCents",
                "toolRequiresEvidenceKind",
            ],
        )
        return self._request("GET", f"/agent-cards{suffix}", **opts)

    def get_agent_card(self, agent_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(agent_id, "agent_id")
        return self._request("GET", f"/agent-cards/{parse.quote(agent_id, safe='')}", **opts)

    def discover_agent_cards(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=[
                "capability",
                "toolId",
                "toolMcpName",
                "toolRiskClass",
                "toolSideEffecting",
                "toolMaxPriceCents",
                "toolRequiresEvidenceKind",
                "supportsPolicyTemplate",
                "supportsEvidencePack",
                "visibility",
                "executionCoordinatorDid",
                "runtime",
                "status",
                "requireCapabilityAttestation",
                "attestationMinLevel",
                "attestationIssuerAgentId",
                "includeAttestationMetadata",
                "minTrustScore",
                "riskTier",
                "includeReputation",
                "includeRoutingFactors",
                "reputationVersion",
                "reputationWindow",
                "scoreStrategy",
                "requesterAgentId",
                "limit",
                "offset",
            ],
        )
        return self._request("GET", f"/agent-cards/discover{suffix}", **opts)

    def discover_public_agent_cards(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=[
                "capability",
                "toolId",
                "toolMcpName",
                "toolRiskClass",
                "toolSideEffecting",
                "toolMaxPriceCents",
                "toolRequiresEvidenceKind",
                "supportsPolicyTemplate",
                "supportsEvidencePack",
                "visibility",
                "executionCoordinatorDid",
                "runtime",
                "status",
                "requireCapabilityAttestation",
                "attestationMinLevel",
                "attestationIssuerAgentId",
                "includeAttestationMetadata",
                "minTrustScore",
                "riskTier",
                "includeReputation",
                "includeRoutingFactors",
                "reputationVersion",
                "reputationWindow",
                "scoreStrategy",
                "requesterAgentId",
                "limit",
                "offset",
            ],
        )
        return self._request("GET", f"/public/agent-cards/discover{suffix}", **opts)

    def stream_public_agent_cards(
        self,
        query: Optional[Dict[str, Any]] = None,
        *,
        request_id: Optional[str] = None,
        last_event_id: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Iterator[Dict[str, Any]]:
        suffix = self._query_suffix(
            query,
            allowed_keys=[
                "capability",
                "toolId",
                "toolMcpName",
                "toolRiskClass",
                "toolSideEffecting",
                "toolMaxPriceCents",
                "toolRequiresEvidenceKind",
                "status",
                "executionCoordinatorDid",
                "runtime",
                "sinceCursor",
            ],
        )
        rid = request_id if request_id else _random_request_id()
        headers: Dict[str, str] = {
            "accept": "text/event-stream",
            "x-proxy-tenant-id": self.tenant_id,
            "x-nooterra-protocol": self.protocol,
            "x-request-id": rid,
        }
        if self.user_agent:
            headers["user-agent"] = self.user_agent
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        if self.x_api_key:
            headers["x-api-key"] = str(self.x_api_key)
        if self.ops_token:
            headers["x-proxy-ops-token"] = str(self.ops_token)
        if isinstance(last_event_id, str) and last_event_id.strip():
            headers["last-event-id"] = last_event_id.strip()

        url = parse.urljoin(
            f"{self.base_url}/",
            f"public/agent-cards/stream{suffix}".lstrip("/"),
        )
        req = request.Request(url=url, data=None, method="GET", headers=headers)
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds

        try:
            with request.urlopen(req, timeout=timeout) as response:
                event_name = "message"
                event_id: Optional[str] = None
                data_lines: list[str] = []
                saw_comment_only_line = False
                saw_field_line = False

                def emit_event() -> Optional[Dict[str, Any]]:
                    nonlocal event_name, event_id, data_lines, saw_comment_only_line, saw_field_line
                    if len(data_lines) == 0:
                        if saw_comment_only_line or not saw_field_line:
                            out = None
                        else:
                            out = {"event": event_name, "id": event_id, "rawData": "", "data": None}
                    else:
                        raw_data = "\n".join(data_lines)
                        out = {
                            "event": event_name,
                            "id": event_id,
                            "rawData": raw_data,
                            "data": _decode_sse_data(raw_data),
                        }
                    event_name = "message"
                    event_id = None
                    data_lines = []
                    saw_comment_only_line = False
                    saw_field_line = False
                    return out

                while True:
                    chunk = response.readline()
                    if not chunk:
                        break
                    line = chunk.decode("utf-8", errors="replace").rstrip("\r\n")
                    if line == "":
                        parsed_event = emit_event()
                        if parsed_event is not None:
                            yield parsed_event
                        continue
                    if line.startswith(":"):
                        saw_comment_only_line = True
                        continue
                    saw_field_line = True
                    field, sep, value = line.partition(":")
                    if sep:
                        if value.startswith(" "):
                            value = value[1:]
                    else:
                        value = ""
                    if field == "event":
                        event_name = value.strip() or "message"
                    elif field == "id":
                        event_id = value.strip() or None
                    elif field == "data":
                        data_lines.append(value)

                parsed_event = emit_event()
                if parsed_event is not None:
                    yield parsed_event
        except error.HTTPError as http_error:
            raw = http_error.read().decode("utf-8")
            parsed: Any = {}
            if raw:
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = {"raw": raw}
            response_headers = {str(k).lower(): str(v) for k, v in http_error.headers.items()}
            raise NooterraApiError(
                status=int(http_error.code),
                code=parsed.get("code") if isinstance(parsed, dict) else None,
                message=parsed.get("error", f"request failed ({http_error.code})") if isinstance(parsed, dict) else f"request failed ({http_error.code})",
                details=parsed.get("details") if isinstance(parsed, dict) else None,
                request_id=response_headers.get("x-request-id"),
            ) from http_error

    def get_public_agent_reputation_summary(
        self,
        agent_id: str,
        query: Optional[Dict[str, Any]] = None,
        **opts: Any,
    ) -> Dict[str, Any]:
        _assert_non_empty_string(agent_id, "agent_id")
        suffix = self._query_suffix(
            query,
            allowed_keys=[
                "reputationVersion",
                "reputationWindow",
                "asOf",
                "includeRelationships",
                "relationshipLimit",
            ],
        )
        return self._request("GET", f"/public/agents/{parse.quote(agent_id, safe='')}/reputation-summary{suffix}", **opts)

    def get_agent_interaction_graph_pack(
        self,
        agent_id: str,
        query: Optional[Dict[str, Any]] = None,
        **opts: Any,
    ) -> Dict[str, Any]:
        _assert_non_empty_string(agent_id, "agent_id")
        suffix = self._query_suffix(
            query,
            allowed_keys=[
                "reputationVersion",
                "reputationWindow",
                "asOf",
                "counterpartyAgentId",
                "visibility",
                "sign",
                "signerKeyId",
                "limit",
                "offset",
            ],
        )
        return self._request("GET", f"/agents/{parse.quote(agent_id, safe='')}/interaction-graph-pack{suffix}", **opts)

    def list_relationships(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=[
                "agentId",
                "counterpartyAgentId",
                "reputationWindow",
                "asOf",
                "visibility",
                "limit",
                "offset",
            ],
        )
        return self._request("GET", f"/relationships{suffix}", **opts)

    def issue_delegation_grant(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("delegatorAgentId"), "body.delegatorAgentId")
        _assert_non_empty_string(body.get("delegateeAgentId"), "body.delegateeAgentId")
        return self._request("POST", "/delegation-grants", body=body, **opts)

    def list_delegation_grants(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        normalized_query = query
        if isinstance(query, dict) and isinstance(query.get("grantHash"), str):
            normalized_query = {**query, "grantHash": str(query.get("grantHash")).lower()}
        suffix = self._query_suffix(
            normalized_query,
            allowed_keys=["grantId", "grantHash", "delegatorAgentId", "delegateeAgentId", "includeRevoked", "limit", "offset"],
        )
        return self._request("GET", f"/delegation-grants{suffix}", **opts)

    def get_delegation_grant(self, grant_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(grant_id, "grant_id")
        return self._request("GET", f"/delegation-grants/{parse.quote(grant_id, safe='')}", **opts)

    def revoke_delegation_grant(self, grant_id: str, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(grant_id, "grant_id")
        payload = {} if body is None else body
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return self._request("POST", f"/delegation-grants/{parse.quote(grant_id, safe='')}/revoke", body=payload, **opts)

    def issue_authority_grant(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        principal_ref = body.get("principalRef")
        if not isinstance(principal_ref, dict):
            raise ValueError("body.principalRef is required")
        _assert_non_empty_string(body.get("granteeAgentId"), "body.granteeAgentId")
        return self._request("POST", "/authority-grants", body=body, **opts)

    def list_authority_grants(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        normalized_query = query
        if isinstance(query, dict) and isinstance(query.get("grantHash"), str):
            normalized_query = {**query, "grantHash": str(query.get("grantHash")).lower()}
        suffix = self._query_suffix(
            normalized_query,
            allowed_keys=["grantId", "grantHash", "granteeAgentId", "principalId", "includeRevoked", "limit", "offset"],
        )
        return self._request("GET", f"/authority-grants{suffix}", **opts)

    def get_authority_grant(self, grant_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(grant_id, "grant_id")
        return self._request("GET", f"/authority-grants/{parse.quote(grant_id, safe='')}", **opts)

    def revoke_authority_grant(self, grant_id: str, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(grant_id, "grant_id")
        payload = {} if body is None else body
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return self._request("POST", f"/authority-grants/{parse.quote(grant_id, safe='')}/revoke", body=payload, **opts)

    def create_task_quote(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/task-quotes", body=body, **opts)

    def list_task_quotes(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=["quoteId", "status", "sellerAgentId", "buyerAgentId", "requiredCapability", "limit", "offset"],
        )
        return self._request("GET", f"/task-quotes{suffix}", **opts)

    def get_task_quote(self, quote_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(quote_id, "quote_id")
        return self._request("GET", f"/task-quotes/{parse.quote(quote_id, safe='')}", **opts)

    def create_task_offer(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/task-offers", body=body, **opts)

    def list_task_offers(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=["offerId", "status", "buyerAgentId", "sellerAgentId", "quoteId", "limit", "offset"],
        )
        return self._request("GET", f"/task-offers{suffix}", **opts)

    def get_task_offer(self, offer_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(offer_id, "offer_id")
        return self._request("GET", f"/task-offers/{parse.quote(offer_id, safe='')}", **opts)

    def create_task_acceptance(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/task-acceptances", body=body, **opts)

    def list_task_acceptances(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=["acceptanceId", "status", "buyerAgentId", "sellerAgentId", "quoteId", "offerId", "limit", "offset"],
        )
        return self._request("GET", f"/task-acceptances{suffix}", **opts)

    def get_task_acceptance(self, acceptance_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(acceptance_id, "acceptance_id")
        return self._request("GET", f"/task-acceptances/{parse.quote(acceptance_id, safe='')}", **opts)

    def propose_intent_contract(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("proposerAgentId"), "body.proposerAgentId")
        _assert_non_empty_string(body.get("counterpartyAgentId"), "body.counterpartyAgentId")
        if body.get("objective") is None:
            raise ValueError("body.objective is required")
        budget_envelope = body.get("budgetEnvelope")
        if not isinstance(budget_envelope, dict):
            raise ValueError("body.budgetEnvelope is required")
        return self._request("POST", "/intents/propose", body=body, **opts)

    def list_intent_contracts(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=["intentId", "proposerAgentId", "counterpartyAgentId", "status", "limit", "offset"],
        )
        return self._request("GET", f"/intents{suffix}", **opts)

    def get_intent_contract(self, intent_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(intent_id, "intent_id")
        return self._request("GET", f"/intents/{parse.quote(intent_id, safe='')}", **opts)

    def counter_intent_contract(self, intent_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(intent_id, "intent_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("proposerAgentId"), "body.proposerAgentId")
        return self._request("POST", f"/intents/{parse.quote(intent_id, safe='')}/counter", body=body, **opts)

    def accept_intent_contract(self, intent_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(intent_id, "intent_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("acceptedByAgentId"), "body.acceptedByAgentId")
        return self._request("POST", f"/intents/{parse.quote(intent_id, safe='')}/accept", body=body, **opts)

    def create_work_order(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/work-orders", body=body, **opts)

    def list_work_orders(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(query, allowed_keys=["workOrderId", "principalAgentId", "subAgentId", "status", "limit", "offset"])
        return self._request("GET", f"/work-orders{suffix}", **opts)

    def get_work_order(self, work_order_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(work_order_id, "work_order_id")
        return self._request("GET", f"/work-orders/{parse.quote(work_order_id, safe='')}", **opts)

    def accept_work_order(self, work_order_id: str, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(work_order_id, "work_order_id")
        payload = {} if body is None else body
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return self._request("POST", f"/work-orders/{parse.quote(work_order_id, safe='')}/accept", body=payload, **opts)

    def progress_work_order(self, work_order_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(work_order_id, "work_order_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", f"/work-orders/{parse.quote(work_order_id, safe='')}/progress", body=body, **opts)

    def top_up_work_order(self, work_order_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(work_order_id, "work_order_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", f"/work-orders/{parse.quote(work_order_id, safe='')}/topup", body=body, **opts)

    def get_work_order_metering(
        self,
        work_order_id: str,
        query: Optional[Dict[str, Any]] = None,
        **opts: Any,
    ) -> Dict[str, Any]:
        _assert_non_empty_string(work_order_id, "work_order_id")
        params: Dict[str, Any] = {}
        if isinstance(query, dict):
            if query.get("includeMeters") is not None:
                params["includeMeters"] = "true" if bool(query.get("includeMeters")) else "false"
            if query.get("include_meters") is not None:
                params["includeMeters"] = "true" if bool(query.get("include_meters")) else "false"
            for key in ("limit", "offset"):
                if query.get(key) is not None:
                    params[key] = query.get(key)
        suffix = f"?{parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/work-orders/{parse.quote(work_order_id, safe='')}/metering{suffix}", **opts)

    def complete_work_order(self, work_order_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(work_order_id, "work_order_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", f"/work-orders/{parse.quote(work_order_id, safe='')}/complete", body=body, **opts)

    def settle_work_order(self, work_order_id: str, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(work_order_id, "work_order_id")
        payload = {} if body is None else body
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return self._request("POST", f"/work-orders/{parse.quote(work_order_id, safe='')}/settle", body=payload, **opts)

    def list_work_order_receipts(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=["receiptId", "workOrderId", "principalAgentId", "subAgentId", "status", "limit", "offset"],
        )
        return self._request("GET", f"/work-orders/receipts{suffix}", **opts)

    def get_work_order_receipt(self, receipt_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(receipt_id, "receipt_id")
        return self._request("GET", f"/work-orders/receipts/{parse.quote(receipt_id, safe='')}", **opts)

    def create_state_checkpoint(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("ownerAgentId"), "body.ownerAgentId")
        state_ref = body.get("stateRef")
        if not isinstance(state_ref, dict):
            raise ValueError("body.stateRef is required")
        _assert_non_empty_string(state_ref.get("artifactId"), "body.stateRef.artifactId")
        _assert_sha256_hex(state_ref.get("artifactHash"), "body.stateRef.artifactHash")
        diff_refs = body.get("diffRefs")
        if diff_refs is not None:
            if not isinstance(diff_refs, list):
                raise ValueError("body.diffRefs must be an array")
            for index, ref in enumerate(diff_refs):
                if not isinstance(ref, dict):
                    raise ValueError(f"body.diffRefs[{index}] must be an object")
                _assert_non_empty_string(ref.get("artifactId"), f"body.diffRefs[{index}].artifactId")
                _assert_sha256_hex(ref.get("artifactHash"), f"body.diffRefs[{index}].artifactHash")
        return self._request("POST", "/state-checkpoints", body=body, **opts)

    def list_state_checkpoints(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=["checkpointId", "projectId", "sessionId", "ownerAgentId", "traceId", "limit", "offset"],
        )
        return self._request("GET", f"/state-checkpoints{suffix}", **opts)

    def get_state_checkpoint(self, checkpoint_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(checkpoint_id, "checkpoint_id")
        return self._request("GET", f"/state-checkpoints/{parse.quote(checkpoint_id, safe='')}", **opts)

    def create_session(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/sessions", body=body, **opts)

    def list_sessions(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(query, allowed_keys=["sessionId", "participantAgentId", "visibility", "status", "limit", "offset"])
        return self._request("GET", f"/sessions{suffix}", **opts)

    def get_session(self, session_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(session_id, "session_id")
        return self._request("GET", f"/sessions/{parse.quote(session_id, safe='')}", **opts)

    def append_session_event(self, session_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(session_id, "session_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        resolved_opts = dict(opts)
        expected_prev_chain_hash = _as_non_empty_string_or_none(resolved_opts.get("expected_prev_chain_hash"))
        if expected_prev_chain_hash is None:
            expected_prev_chain_hash = _as_non_empty_string_or_none(resolved_opts.get("expectedPrevChainHash"))
        if expected_prev_chain_hash is None:
            raise ValueError("expectedPrevChainHash is required for append_session_event")
        resolved_type = _as_non_empty_string_or_none(body.get("type"))
        payload = body
        if resolved_type is None:
            legacy_event_type = _as_non_empty_string_or_none(body.get("eventType"))
            if legacy_event_type is None:
                raise ValueError("body.type is required")
            payload = {**body, "type": legacy_event_type}
        # Session event append is fail-closed on idempotency: default one for compatibility.
        if not resolved_opts.get("idempotency_key"):
            resolved_opts["idempotency_key"] = _random_request_id()
        resolved_opts.pop("expected_prev_chain_hash", None)
        resolved_opts.pop("expectedPrevChainHash", None)
        return self._request(
            "POST",
            f"/sessions/{parse.quote(session_id, safe='')}/events",
            body=payload,
            expected_prev_chain_hash=expected_prev_chain_hash,
            **resolved_opts,
        )

    def list_session_events(self, session_id: str, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(session_id, "session_id")
        suffix = self._query_suffix(query, allowed_keys=["eventType", "limit", "offset", "sinceEventId", "checkpointConsumerId"])
        return self._request("GET", f"/sessions/{parse.quote(session_id, safe='')}/events{suffix}", **opts)

    def get_session_event_checkpoint(self, session_id: str, checkpoint_consumer_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(session_id, "session_id")
        _assert_non_empty_string(checkpoint_consumer_id, "checkpoint_consumer_id")
        suffix = self._query_suffix({"checkpointConsumerId": checkpoint_consumer_id}, allowed_keys=["checkpointConsumerId"])
        return self._request("GET", f"/sessions/{parse.quote(session_id, safe='')}/events/checkpoint{suffix}", **opts)

    def ack_session_event_checkpoint(self, session_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(session_id, "session_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("checkpointConsumerId"), "body.checkpointConsumerId")
        return self._request("POST", f"/sessions/{parse.quote(session_id, safe='')}/events/checkpoint", body=body, **opts)

    def requeue_session_event_checkpoint(self, session_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(session_id, "session_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("checkpointConsumerId"), "body.checkpointConsumerId")
        return self._request("POST", f"/sessions/{parse.quote(session_id, safe='')}/events/checkpoint/requeue", body=body, **opts)

    def stream_session_events(
        self,
        session_id: str,
        query: Optional[Dict[str, Any]] = None,
        *,
        request_id: Optional[str] = None,
        last_event_id: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Iterator[Dict[str, Any]]:
        _assert_non_empty_string(session_id, "session_id")
        suffix = self._query_suffix(query, allowed_keys=["eventType", "sinceEventId", "checkpointConsumerId"])
        rid = request_id if request_id else _random_request_id()
        headers: Dict[str, str] = {
            "accept": "text/event-stream",
            "x-proxy-tenant-id": self.tenant_id,
            "x-nooterra-protocol": self.protocol,
            "x-request-id": rid,
        }
        if self.user_agent:
            headers["user-agent"] = self.user_agent
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        if self.x_api_key:
            headers["x-api-key"] = str(self.x_api_key)
        if self.ops_token:
            headers["x-proxy-ops-token"] = str(self.ops_token)
        if isinstance(last_event_id, str) and last_event_id.strip():
            headers["last-event-id"] = last_event_id.strip()

        url = parse.urljoin(
            f"{self.base_url}/",
            f"sessions/{parse.quote(session_id, safe='')}/events/stream{suffix}".lstrip("/"),
        )
        req = request.Request(url=url, data=None, method="GET", headers=headers)
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds

        try:
            with request.urlopen(req, timeout=timeout) as response:
                event_name = "message"
                event_id: Optional[str] = None
                data_lines: list[str] = []
                saw_comment_only_line = False
                saw_field_line = False

                def emit_event() -> Optional[Dict[str, Any]]:
                    nonlocal event_name, event_id, data_lines, saw_comment_only_line, saw_field_line
                    if len(data_lines) == 0:
                        if saw_comment_only_line or not saw_field_line:
                            out = None
                        else:
                            out = {"event": event_name, "id": event_id, "rawData": "", "data": None}
                    else:
                        raw_data = "\n".join(data_lines)
                        out = {
                            "event": event_name,
                            "id": event_id,
                            "rawData": raw_data,
                            "data": _decode_sse_data(raw_data),
                        }
                    event_name = "message"
                    event_id = None
                    data_lines = []
                    saw_comment_only_line = False
                    saw_field_line = False
                    return out

                while True:
                    chunk = response.readline()
                    if not chunk:
                        break
                    line = chunk.decode("utf-8", errors="replace").rstrip("\r\n")
                    if line == "":
                        parsed_event = emit_event()
                        if parsed_event is not None:
                            yield parsed_event
                        continue
                    if line.startswith(":"):
                        saw_comment_only_line = True
                        continue
                    saw_field_line = True
                    field, sep, value = line.partition(":")
                    if sep:
                        if value.startswith(" "):
                            value = value[1:]
                    else:
                        value = ""
                    if field == "event":
                        event_name = value.strip() or "message"
                    elif field == "id":
                        event_id = value.strip() or None
                    elif field == "data":
                        data_lines.append(value)

                parsed_event = emit_event()
                if parsed_event is not None:
                    yield parsed_event
        except error.HTTPError as http_error:
            raw = http_error.read().decode("utf-8")
            parsed: Any = {}
            if raw:
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = {"raw": raw}
            response_headers = {str(k).lower(): str(v) for k, v in http_error.headers.items()}
            raise NooterraApiError(
                status=int(http_error.code),
                code=parsed.get("code") if isinstance(parsed, dict) else None,
                message=parsed.get("error", f"request failed ({http_error.code})") if isinstance(parsed, dict) else f"request failed ({http_error.code})",
                details=parsed.get("details") if isinstance(parsed, dict) else None,
                request_id=response_headers.get("x-request-id"),
            ) from http_error

    def get_session_replay_pack(self, session_id: str, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(session_id, "session_id")
        suffix = self._query_suffix(query, allowed_keys=["sign", "signerKeyId"])
        return self._request("GET", f"/sessions/{parse.quote(session_id, safe='')}/replay-pack{suffix}", **opts)

    def get_session_transcript(self, session_id: str, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(session_id, "session_id")
        suffix = self._query_suffix(query, allowed_keys=["sign", "signerKeyId"])
        return self._request("GET", f"/sessions/{parse.quote(session_id, safe='')}/transcript{suffix}", **opts)

    def create_capability_attestation(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/capability-attestations", body=body, **opts)

    def list_capability_attestations(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        suffix = self._query_suffix(
            query,
            allowed_keys=["attestationId", "subjectAgentId", "issuerAgentId", "capability", "status", "includeInvalid", "at", "limit", "offset"],
        )
        return self._request("GET", f"/capability-attestations{suffix}", **opts)

    def get_capability_attestation(self, attestation_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(attestation_id, "attestation_id")
        return self._request("GET", f"/capability-attestations/{parse.quote(attestation_id, safe='')}", **opts)

    def revoke_capability_attestation(self, attestation_id: str, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(attestation_id, "attestation_id")
        payload = {} if body is None else body
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return self._request("POST", f"/capability-attestations/{parse.quote(attestation_id, safe='')}/revoke", body=payload, **opts)

    def ops_lock_tool_call_hold(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/ops/tool-calls/holds/lock", body=body, **opts)

    def ops_list_tool_call_holds(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        params: Dict[str, Any] = {}
        if isinstance(query, dict):
            for key in ("agreementHash", "status", "limit", "offset"):
                if query.get(key) is not None:
                    params[key] = query.get(key)
        suffix = f"?{parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/ops/tool-calls/holds{suffix}", **opts)

    def ops_get_tool_call_replay_evaluate(self, agreement_hash: str, **opts: Any) -> Dict[str, Any]:
        agreement_hash_norm = _assert_sha256_hex(agreement_hash, "agreement_hash")
        qs = parse.urlencode({"agreementHash": agreement_hash_norm})
        return self._request("GET", f"/ops/tool-calls/replay-evaluate?{qs}", **opts)

    def ops_get_tool_call_hold(self, hold_hash: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(hold_hash, "hold_hash")
        return self._request("GET", f"/ops/tool-calls/holds/{parse.quote(hold_hash, safe='')}", **opts)

    def ops_get_reputation_facts(self, query: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(query, dict):
            raise ValueError("query must be an object")
        agent_id = _as_non_empty_string_or_none(query.get("agentId")) or _as_non_empty_string_or_none(query.get("agent_id"))
        if not agent_id:
            raise ValueError("agentId is required")
        params: Dict[str, Any] = {"agentId": agent_id}
        tool_id = _as_non_empty_string_or_none(query.get("toolId")) or _as_non_empty_string_or_none(query.get("tool_id"))
        if tool_id:
            params["toolId"] = tool_id
        if query.get("window") is not None:
            params["window"] = str(query.get("window"))
        as_of = _as_non_empty_string_or_none(query.get("asOf")) or _as_non_empty_string_or_none(query.get("as_of"))
        if as_of:
            params["asOf"] = as_of
        include_events = query.get("includeEvents")
        if include_events is None:
            include_events = query.get("include_events")
        if include_events is not None:
            params["includeEvents"] = "1" if bool(include_events) else "0"
        return self._request("GET", f"/ops/reputation/facts?{parse.urlencode(params)}", **opts)

    def ops_run_tool_call_holdback_maintenance(self, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        payload = {} if body is None else body
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return self._request("POST", "/ops/maintenance/tool-call-holdback/run", body=payload, **opts)

    def tool_call_list_arbitration_cases(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        params: Dict[str, Any] = {}
        if isinstance(query, dict):
            for key in ("agreementHash", "status"):
                if query.get(key) is not None:
                    params[key] = query.get(key)
        suffix = f"?{parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/tool-calls/arbitration/cases{suffix}", **opts)

    def tool_call_get_arbitration_case(self, case_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(case_id, "case_id")
        return self._request("GET", f"/tool-calls/arbitration/cases/{parse.quote(case_id, safe='')}", **opts)

    def tool_call_open_arbitration(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/tool-calls/arbitration/open", body=body, **opts)

    def tool_call_submit_arbitration_verdict(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/tool-calls/arbitration/verdict", body=body, **opts)

    def ops_get_settlement_adjustment(self, adjustment_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(adjustment_id, "adjustment_id")
        return self._request("GET", f"/ops/settlement-adjustments/{parse.quote(adjustment_id, safe='')}", **opts)

    def get_artifact(self, artifact_id: str, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(artifact_id, "artifact_id")
        return self._request("GET", f"/artifacts/{parse.quote(artifact_id, safe='')}", **opts)

    def get_artifacts(self, artifact_ids: list[str], **opts: Any) -> Dict[str, Any]:
        if not isinstance(artifact_ids, list) or len(artifact_ids) == 0:
            raise ValueError("artifact_ids[] is required")
        rows = []
        responses = []
        for idx, artifact_id in enumerate(artifact_ids):
            aid = _assert_non_empty_string(artifact_id, f"artifact_ids[{idx}]")
            response = self.get_artifact(aid, **opts)
            rows.append({"artifactId": aid, "artifact": response.get("body", {}).get("artifact") if isinstance(response.get("body"), dict) else None})
            responses.append(response)
        return {"artifacts": rows, "responses": responses}

    def create_agreement(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        tool_id = _assert_non_empty_string(params.get("toolId"), "params.toolId")
        call_id = _assert_non_empty_string(params.get("callId"), "params.callId")
        manifest_hash = _assert_sha256_hex(params.get("manifestHash"), "params.manifestHash")
        created_at = _normalize_iso_date(params.get("createdAt"), fallback_now=True, name="params.createdAt")
        input_canonical = _canonical_json_dumps(params.get("input", {}))
        input_hash = _sha256_hex_utf8(input_canonical)
        agreement_core = _canonicalize(
            {
                "schemaVersion": "ToolCallAgreement.v1",
                "toolId": tool_id,
                "manifestHash": manifest_hash,
                "callId": call_id,
                "inputHash": input_hash,
                "acceptanceCriteria": params.get("acceptanceCriteria"),
                "settlementTerms": params.get("settlementTerms"),
                "payerAgentId": _as_non_empty_string_or_none(params.get("payerAgentId")),
                "payeeAgentId": _as_non_empty_string_or_none(params.get("payeeAgentId")),
                "createdAt": created_at,
            }
        )
        agreement_hash = _sha256_hex_utf8(_canonical_json_dumps(agreement_core))
        agreement = _canonicalize({**agreement_core, "agreementHash": agreement_hash})
        return {
            "agreement": agreement,
            "agreementHash": agreement_hash,
            "inputHash": input_hash,
            "canonicalJson": _canonical_json_dumps(agreement),
        }

    def sign_evidence(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        agreement = params.get("agreement") if isinstance(params.get("agreement"), dict) else {}
        agreement_hash = _assert_sha256_hex(params.get("agreementHash", agreement.get("agreementHash")), "agreementHash")
        call_id = _assert_non_empty_string(params.get("callId", agreement.get("callId")), "callId")
        input_hash = _assert_sha256_hex(params.get("inputHash", agreement.get("inputHash")), "inputHash")
        started_at = _normalize_iso_date(params.get("startedAt"), fallback_now=True, name="startedAt")
        completed_at = _normalize_iso_date(params.get("completedAt", started_at), fallback_now=True, name="completedAt")
        output_canonical = _canonical_json_dumps(params.get("output", {}))
        output_hash = _sha256_hex_utf8(output_canonical)
        evidence_core = _canonicalize(
            {
                "schemaVersion": "ToolCallEvidence.v1",
                "agreementHash": agreement_hash,
                "callId": call_id,
                "inputHash": input_hash,
                "outputHash": output_hash,
                "outputRef": _as_non_empty_string_or_none(params.get("outputRef")),
                "metrics": params.get("metrics"),
                "startedAt": started_at,
                "completedAt": completed_at,
                "createdAt": _normalize_iso_date(params.get("createdAt", completed_at), fallback_now=True, name="createdAt"),
            }
        )
        evidence_hash = _sha256_hex_utf8(_canonical_json_dumps(evidence_core))
        signer_private_key_pem = _as_non_empty_string_or_none(params.get("signerPrivateKeyPem"))
        signer_key_id = _as_non_empty_string_or_none(params.get("signerKeyId"))
        signature = None
        if signer_private_key_pem is not None:
            if signer_key_id is None:
                raise ValueError("signerKeyId is required when signerPrivateKeyPem is provided")
            signature = _canonicalize(
                {
                    "algorithm": "ed25519",
                    "signerKeyId": signer_key_id,
                    "evidenceHash": evidence_hash,
                    "signature": _sign_hash_hex_ed25519_base64(evidence_hash, signer_private_key_pem),
                }
            )
        evidence = _canonicalize({**evidence_core, "evidenceHash": evidence_hash, **({"signature": signature} if signature is not None else {})})
        return {
            "evidence": evidence,
            "evidenceHash": evidence_hash,
            "outputHash": output_hash,
            "canonicalJson": _canonical_json_dumps(evidence),
        }

    def create_hold(self, params: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        agreement = params.get("agreement") if isinstance(params.get("agreement"), dict) else {}
        agreement_hash = _assert_sha256_hex(params.get("agreementHash", agreement.get("agreementHash")), "agreementHash")
        receipt_hash = _assert_sha256_hex(params.get("receiptHash"), "receiptHash")
        payer_agent_id = _assert_non_empty_string(params.get("payerAgentId"), "payerAgentId")
        payee_agent_id = _assert_non_empty_string(params.get("payeeAgentId"), "payeeAgentId")
        if payer_agent_id == payee_agent_id:
            raise ValueError("payerAgentId and payeeAgentId must differ")
        amount_cents = params.get("amountCents")
        if not isinstance(amount_cents, int) or amount_cents <= 0:
            raise ValueError("amountCents must be a positive safe integer")
        holdback_bps = int(params.get("holdbackBps", 0))
        if holdback_bps < 0 or holdback_bps > 10000:
            raise ValueError("holdbackBps must be an integer within 0..10000")
        challenge_window_ms = int(params.get("challengeWindowMs", 0))
        if challenge_window_ms < 0:
            raise ValueError("challengeWindowMs must be a non-negative safe integer")
        return self.ops_lock_tool_call_hold(
            {
                "agreementHash": agreement_hash,
                "receiptHash": receipt_hash,
                "payerAgentId": payer_agent_id,
                "payeeAgentId": payee_agent_id,
                "amountCents": amount_cents,
                "currency": _as_non_empty_string_or_none(params.get("currency")) or "USD",
                "holdbackBps": holdback_bps,
                "challengeWindowMs": challenge_window_ms,
            },
            **opts,
        )

    def settle(self, params: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        agreement = params.get("agreement") if isinstance(params.get("agreement"), dict) else {}
        evidence = params.get("evidence") if isinstance(params.get("evidence"), dict) else {}
        agreement_hash = _assert_sha256_hex(params.get("agreementHash", agreement.get("agreementHash")), "agreementHash")
        evidence_hash = params.get("evidenceHash", evidence.get("evidenceHash"))
        evidence_hash_norm = _assert_sha256_hex(evidence_hash, "evidenceHash") if evidence_hash else None
        amount_cents = params.get("amountCents")
        if not isinstance(amount_cents, int) or amount_cents <= 0:
            raise ValueError("amountCents must be a positive safe integer")
        currency = _as_non_empty_string_or_none(params.get("currency")) or "USD"
        settled_at = _normalize_iso_date(params.get("settledAt"), fallback_now=True, name="settledAt")
        receipt_ref = _canonicalize(
            {
                "schemaVersion": "ToolCallSettlementReceiptRef.v1",
                "agreementHash": agreement_hash,
                "evidenceHash": evidence_hash_norm,
                "amountCents": amount_cents,
                "currency": currency,
                "settledAt": settled_at,
            }
        )
        receipt_hash = (
            _assert_sha256_hex(params.get("receiptHash"), "receiptHash")
            if params.get("receiptHash") is not None
            else _sha256_hex_utf8(_canonical_json_dumps(receipt_ref))
        )
        hold_response = self.create_hold(
            {
                "agreementHash": agreement_hash,
                "receiptHash": receipt_hash,
                "payerAgentId": params.get("payerAgentId"),
                "payeeAgentId": params.get("payeeAgentId"),
                "amountCents": amount_cents,
                "currency": currency,
                "holdbackBps": params.get("holdbackBps", 0),
                "challengeWindowMs": params.get("challengeWindowMs", 0),
            },
            **opts,
        )
        hold_body = hold_response.get("body", {}) if isinstance(hold_response.get("body"), dict) else {}
        return {
            "agreementHash": agreement_hash,
            "receiptHash": receipt_hash,
            "receiptRef": receipt_ref,
            "hold": hold_body.get("hold"),
            "holdResponse": hold_response,
        }

    def open_dispute(self, params: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        agreement_hash = _assert_sha256_hex(params.get("agreementHash"), "agreementHash")
        receipt_hash = _assert_sha256_hex(params.get("receiptHash"), "receiptHash")
        hold_hash = _assert_sha256_hex(params.get("holdHash"), "holdHash")
        arbiter_agent_id = _assert_non_empty_string(params.get("arbiterAgentId"), "arbiterAgentId")
        summary = _assert_non_empty_string(params.get("summary"), "summary")
        evidence_refs = params.get("evidenceRefs") if isinstance(params.get("evidenceRefs"), list) else []
        admin_override = params.get("adminOverride") if isinstance(params.get("adminOverride"), dict) else None
        override_enabled = bool(admin_override.get("enabled")) if isinstance(admin_override, dict) else False
        dispute_open_envelope = params.get("disputeOpenEnvelope") if isinstance(params.get("disputeOpenEnvelope"), dict) else None
        opened_by_agent_id = _as_non_empty_string_or_none(params.get("openedByAgentId"))
        if opened_by_agent_id is None and isinstance(dispute_open_envelope, dict):
            opened_by_agent_id = _as_non_empty_string_or_none(dispute_open_envelope.get("openedByAgentId"))
        if dispute_open_envelope is None and not override_enabled:
            if opened_by_agent_id is None:
                raise ValueError("openedByAgentId is required when disputeOpenEnvelope is not provided")
            dispute_open_envelope = self.build_dispute_open_envelope(
                {
                    "agreementHash": agreement_hash,
                    "receiptHash": receipt_hash,
                    "holdHash": hold_hash,
                    "openedByAgentId": opened_by_agent_id,
                    "signerKeyId": params.get("signerKeyId"),
                    "signerPrivateKeyPem": params.get("signerPrivateKeyPem"),
                    "signature": params.get("signature"),
                    "caseId": params.get("caseId"),
                    "envelopeId": params.get("envelopeId"),
                    "reasonCode": params.get("reasonCode"),
                    "nonce": params.get("nonce"),
                    "openedAt": params.get("openedAt"),
                    "tenantId": params.get("tenantId"),
                }
            )["disputeOpenEnvelope"]
        body: Dict[str, Any] = {
            "agreementHash": agreement_hash,
            "receiptHash": receipt_hash,
            "holdHash": hold_hash,
            "arbiterAgentId": arbiter_agent_id,
            "summary": summary,
            "evidenceRefs": [str(item) for item in evidence_refs],
        }
        if opened_by_agent_id is not None:
            body["openedByAgentId"] = opened_by_agent_id
        if dispute_open_envelope is not None:
            body["disputeOpenEnvelope"] = dispute_open_envelope
        if admin_override is not None:
            body["adminOverride"] = admin_override
        return self.tool_call_open_arbitration(body, **opts)

    def build_dispute_open_envelope(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        agreement_hash = _assert_sha256_hex(params.get("agreementHash"), "agreementHash")
        receipt_hash = _assert_sha256_hex(params.get("receiptHash"), "receiptHash")
        hold_hash = _assert_sha256_hex(params.get("holdHash"), "holdHash")
        opened_by_agent_id = _assert_non_empty_string(params.get("openedByAgentId"), "openedByAgentId")
        signer_key_id = _assert_non_empty_string(params.get("signerKeyId"), "signerKeyId")
        signature = _as_non_empty_string_or_none(params.get("signature"))
        case_id = _as_non_empty_string_or_none(params.get("caseId")) or f"arb_case_tc_{agreement_hash}"
        envelope_id = _as_non_empty_string_or_none(params.get("envelopeId")) or f"dopen_tc_{agreement_hash}"
        tenant_id = _as_non_empty_string_or_none(params.get("tenantId")) or self.tenant_id
        opened_at = _normalize_iso_date(params.get("openedAt"), fallback_now=True, name="openedAt")
        reason_code = _assert_reason_code(params.get("reasonCode") or "TOOL_CALL_DISPUTE", "reasonCode")
        nonce = _as_non_empty_string_or_none(params.get("nonce")) or f"nonce_{uuid.uuid4().hex[:16]}"
        core = _canonicalize(
            {
                "schemaVersion": "DisputeOpenEnvelope.v1",
                "artifactType": "DisputeOpenEnvelope.v1",
                "artifactId": envelope_id,
                "envelopeId": envelope_id,
                "caseId": case_id,
                "tenantId": tenant_id,
                "agreementHash": agreement_hash,
                "receiptHash": receipt_hash,
                "holdHash": hold_hash,
                "openedByAgentId": opened_by_agent_id,
                "openedAt": opened_at,
                "reasonCode": reason_code,
                "nonce": nonce,
                "signerKeyId": signer_key_id,
            }
        )
        envelope_hash = _sha256_hex_utf8(_canonical_json_dumps(core))
        if signature is None:
            signer_private_key_pem = _as_non_empty_string_or_none(params.get("signerPrivateKeyPem"))
            if signer_private_key_pem is None:
                raise ValueError("signature or signerPrivateKeyPem is required")
            signature = _sign_hash_hex_ed25519_base64(envelope_hash, signer_private_key_pem)
        dispute_open_envelope = _canonicalize({**core, "envelopeHash": envelope_hash, "signature": signature})
        return {
            "disputeOpenEnvelope": dispute_open_envelope,
            "envelopeHash": envelope_hash,
            "canonicalJson": _canonical_json_dumps(dispute_open_envelope),
        }

    def open_run_dispute(self, run_id: str, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(run_id, "run_id")
        payload = {} if body is None else body
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return self._request("POST", f"/runs/{parse.quote(run_id, safe='')}/dispute/open", body=payload, **opts)

    def close_run_dispute(self, run_id: str, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(run_id, "run_id")
        payload = {} if body is None else body
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return self._request("POST", f"/runs/{parse.quote(run_id, safe='')}/dispute/close", body=payload, **opts)

    def submit_run_dispute_evidence(self, run_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(run_id, "run_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("evidenceRef"), "body.evidenceRef")
        return self._request("POST", f"/runs/{parse.quote(run_id, safe='')}/dispute/evidence", body=body, **opts)

    def escalate_run_dispute(self, run_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(run_id, "run_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("escalationLevel"), "body.escalationLevel")
        return self._request("POST", f"/runs/{parse.quote(run_id, safe='')}/dispute/escalate", body=body, **opts)

    def create_marketplace_rfq(self, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", "/marketplace/rfqs", body=body, **opts)

    def list_marketplace_rfqs(self, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        params = {}
        if isinstance(query, dict):
            for key in ("status", "capability", "posterAgentId", "limit", "offset"):
                if query.get(key) is not None:
                    params[key] = query.get(key)
        suffix = f"?{parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/marketplace/rfqs{suffix}", **opts)

    def submit_marketplace_bid(self, rfq_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(rfq_id, "rfq_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        return self._request("POST", f"/marketplace/rfqs/{parse.quote(rfq_id, safe='')}/bids", body=body, **opts)

    def list_marketplace_bids(self, rfq_id: str, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(rfq_id, "rfq_id")
        params = {}
        if isinstance(query, dict):
            for key in ("status", "bidderAgentId", "limit", "offset"):
                if query.get(key) is not None:
                    params[key] = query.get(key)
        suffix = f"?{parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/marketplace/rfqs/{parse.quote(rfq_id, safe='')}/bids{suffix}", **opts)

    def accept_marketplace_bid(self, rfq_id: str, body: Dict[str, Any], **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(rfq_id, "rfq_id")
        if not isinstance(body, dict):
            raise ValueError("body is required")
        _assert_non_empty_string(body.get("bidId"), "body.bidId")
        return self._request("POST", f"/marketplace/rfqs/{parse.quote(rfq_id, safe='')}/accept", body=body, **opts)

    def get_tenant_analytics(self, tenant_id: str, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(tenant_id, "tenant_id")
        params = {}
        if isinstance(query, dict):
            for key in ("month", "bucket", "limit"):
                if query.get(key) is not None:
                    params[key] = query.get(key)
        suffix = f"?{parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/v1/tenants/{parse.quote(tenant_id, safe='')}/analytics{suffix}", **opts)

    def get_tenant_trust_graph(self, tenant_id: str, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(tenant_id, "tenant_id")
        params = {}
        if isinstance(query, dict):
            for key in ("month", "minRuns", "maxEdges"):
                if query.get(key) is not None:
                    params[key] = query.get(key)
        suffix = f"?{parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/v1/tenants/{parse.quote(tenant_id, safe='')}/trust-graph{suffix}", **opts)

    def list_tenant_trust_graph_snapshots(self, tenant_id: str, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(tenant_id, "tenant_id")
        params = {}
        if isinstance(query, dict) and query.get("limit") is not None:
            params["limit"] = query.get("limit")
        suffix = f"?{parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/v1/tenants/{parse.quote(tenant_id, safe='')}/trust-graph/snapshots{suffix}", **opts)

    def create_tenant_trust_graph_snapshot(self, tenant_id: str, body: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(tenant_id, "tenant_id")
        payload = {} if body is None else body
        if not isinstance(payload, dict):
            raise ValueError("body must be an object")
        return self._request("POST", f"/v1/tenants/{parse.quote(tenant_id, safe='')}/trust-graph/snapshots", body=payload, **opts)

    def diff_tenant_trust_graph(self, tenant_id: str, query: Optional[Dict[str, Any]] = None, **opts: Any) -> Dict[str, Any]:
        _assert_non_empty_string(tenant_id, "tenant_id")
        params = {}
        if isinstance(query, dict):
            for key in ("baseMonth", "compareMonth", "limit", "minRuns", "maxEdges", "includeUnchanged"):
                if query.get(key) is not None:
                    params[key] = query.get(key)
        suffix = f"?{parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/v1/tenants/{parse.quote(tenant_id, safe='')}/trust-graph/diff{suffix}", **opts)

    def first_paid_rfq(
        self,
        params: Dict[str, Any],
        *,
        idempotency_prefix: Optional[str] = None,
        request_id_prefix: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise ValueError("params must be an object")

        poster_agent = params.get("poster_agent")
        bidder_agent = params.get("bidder_agent")
        if not isinstance(poster_agent, dict):
            raise ValueError("params.poster_agent is required")
        if not isinstance(bidder_agent, dict):
            raise ValueError("params.bidder_agent is required")
        _assert_non_empty_string(poster_agent.get("publicKeyPem"), "params.poster_agent.publicKeyPem")
        _assert_non_empty_string(bidder_agent.get("publicKeyPem"), "params.bidder_agent.publicKeyPem")

        step_prefix = _normalize_prefix(
            idempotency_prefix,
            f"sdk_first_paid_rfq_{int(time.time() * 1000):x}_{random.randint(0, 0xFFFFFF):06x}",
        )
        request_prefix = _normalize_prefix(request_id_prefix, _random_request_id())

        def make_step_opts(step: str, **extra: Any) -> Dict[str, Any]:
            out = {
                "request_id": f"{request_prefix}_{step}",
                "idempotency_key": f"{step_prefix}_{step}",
                "timeout_seconds": timeout_seconds,
            }
            out.update(extra)
            return out

        poster_registration = self.register_agent(poster_agent, **make_step_opts("register_poster"))
        poster_agent_id = poster_registration.get("body", {}).get("agentIdentity", {}).get("agentId")
        _assert_non_empty_string(poster_agent_id, "poster_agent_id")

        bidder_registration = self.register_agent(bidder_agent, **make_step_opts("register_bidder"))
        bidder_agent_id = bidder_registration.get("body", {}).get("agentIdentity", {}).get("agentId")
        _assert_non_empty_string(bidder_agent_id, "bidder_agent_id")

        accepted_by_registration = None
        accepted_by_agent_id = poster_agent_id
        accepted_by_agent = params.get("accepted_by_agent")
        if accepted_by_agent is not None:
            if not isinstance(accepted_by_agent, dict):
                raise ValueError("params.accepted_by_agent must be an object")
            _assert_non_empty_string(accepted_by_agent.get("publicKeyPem"), "params.accepted_by_agent.publicKeyPem")
            accepted_by_registration = self.register_agent(accepted_by_agent, **make_step_opts("register_accepting_agent"))
            accepted_by_agent_id = accepted_by_registration.get("body", {}).get("agentIdentity", {}).get("agentId")
            _assert_non_empty_string(accepted_by_agent_id, "accepted_by_agent_id")

        payer_credit = params.get("payer_credit")
        credit_result = None
        if payer_credit is not None:
            if not isinstance(payer_credit, dict):
                raise ValueError("params.payer_credit must be an object")
            amount_cents = payer_credit.get("amountCents")
            if not isinstance(amount_cents, (int, float)) or amount_cents <= 0:
                raise ValueError("params.payer_credit.amountCents must be a positive number")
            credit_result = self.credit_agent_wallet(
                poster_agent_id,
                {
                    "amountCents": int(amount_cents),
                    "currency": payer_credit.get("currency", "USD"),
                },
                **make_step_opts("credit_poster_wallet"),
            )

        rfq_defaults = {
            "rfqId": f"rfq_{step_prefix}",
            "title": "SDK paid rfq",
            "capability": "general",
            "posterAgentId": poster_agent_id,
            "budgetCents": 1000,
            "currency": "USD",
        }
        rfq_body = {**rfq_defaults, **(params.get("rfq") if isinstance(params.get("rfq"), dict) else {})}
        rfq_body["posterAgentId"] = poster_agent_id
        create_rfq = self.create_marketplace_rfq(rfq_body, **make_step_opts("create_rfq"))
        rfq = create_rfq.get("body", {}).get("rfq", {}) if isinstance(create_rfq.get("body"), dict) else {}
        rfq_id = rfq.get("rfqId")
        _assert_non_empty_string(rfq_id, "rfq_id")

        bid_defaults = {
            "bidId": f"bid_{step_prefix}",
            "bidderAgentId": bidder_agent_id,
            "amountCents": int(rfq_body.get("budgetCents", 1000)),
            "currency": str(rfq_body.get("currency", "USD")),
            "etaSeconds": 900,
        }
        bid_body = {**bid_defaults, **(params.get("bid") if isinstance(params.get("bid"), dict) else {})}
        bid_body["bidderAgentId"] = bidder_agent_id
        submit_bid = self.submit_marketplace_bid(rfq_id, bid_body, **make_step_opts("submit_bid"))
        bid = submit_bid.get("body", {}).get("bid", {}) if isinstance(submit_bid.get("body"), dict) else {}
        bid_id = bid.get("bidId")
        _assert_non_empty_string(bid_id, "bid_id")

        settlement_config = params.get("settlement") if isinstance(params.get("settlement"), dict) else {}
        accept_defaults = {
            "bidId": bid_id,
            "acceptedByAgentId": accepted_by_agent_id,
            "settlement": {
                "payerAgentId": poster_agent_id,
                "amountCents": int(bid_body.get("amountCents")),
                "currency": str(bid_body.get("currency", rfq_body.get("currency", "USD"))),
            },
        }
        accept_body = {**accept_defaults, **(params.get("accept") if isinstance(params.get("accept"), dict) else {})}
        if not isinstance(accept_body.get("settlement"), dict):
            accept_body["settlement"] = {}
        accept_body["settlement"] = {**accept_defaults["settlement"], **accept_body["settlement"], **settlement_config}
        accept_bid = self.accept_marketplace_bid(rfq_id, accept_body, **make_step_opts("accept_bid"))
        accepted_body = accept_bid.get("body", {}) if isinstance(accept_bid.get("body"), dict) else {}
        run = accepted_body.get("run", {}) if isinstance(accepted_body.get("run"), dict) else {}
        run_id = run.get("runId")
        _assert_non_empty_string(run_id, "run_id")

        final_event = None
        final_run = run
        final_settlement = accepted_body.get("settlement")
        if params.get("auto_complete", True):
            prev_chain_hash = run.get("lastChainHash")
            _assert_non_empty_string(prev_chain_hash, "run.lastChainHash")
            completed_payload = dict(params.get("completed_payload") or {})
            completed_payload.setdefault("outputRef", f"evidence://{run_id}/result.json")
            if isinstance(params.get("completed_metrics"), dict):
                completed_payload["metrics"] = params.get("completed_metrics")
            elif "metrics" not in completed_payload:
                completed_payload["metrics"] = {"settlementReleaseRatePct": 100}
            completed = self.append_agent_run_event(
                bidder_agent_id,
                run_id,
                {"type": "RUN_COMPLETED", "actor": {"type": "agent", "id": bidder_agent_id}, "payload": completed_payload},
                expected_prev_chain_hash=prev_chain_hash,
                **make_step_opts("run_completed"),
            )
            completed_body = completed.get("body", {}) if isinstance(completed.get("body"), dict) else {}
            final_event = completed_body.get("event")
            final_run = completed_body.get("run", final_run)
            final_settlement = completed_body.get("settlement", final_settlement)

        verification = self.get_run_verification(run_id, **make_step_opts("verification", idempotency_key=None))
        settlement = self.get_run_settlement(run_id, **make_step_opts("settlement", idempotency_key=None))

        return {
            "ids": {
                "poster_agent_id": poster_agent_id,
                "bidder_agent_id": bidder_agent_id,
                "accepted_by_agent_id": accepted_by_agent_id,
                "rfq_id": rfq_id,
                "bid_id": bid_id,
                "run_id": run_id,
            },
            "poster_registration": poster_registration,
            "bidder_registration": bidder_registration,
            "accepted_by_registration": accepted_by_registration,
            "payer_credit": credit_result,
            "create_rfq": create_rfq,
            "submit_bid": submit_bid,
            "accept_bid": accept_bid,
            "final_event": final_event,
            "final_run": final_run,
            "final_settlement": final_settlement,
            "verification": verification,
            "settlement": settlement,
        }

    def first_verified_run(
        self,
        params: Dict[str, Any],
        *,
        idempotency_prefix: Optional[str] = None,
        request_id_prefix: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        payee_agent = params.get("payee_agent")
        if not isinstance(payee_agent, dict):
            raise ValueError("params.payee_agent is required")
        _assert_non_empty_string(payee_agent.get("publicKeyPem"), "params.payee_agent.publicKeyPem")

        step_prefix = _normalize_prefix(
            idempotency_prefix,
            f"sdk_first_verified_run_{int(time.time() * 1000):x}_{random.randint(0, 0xFFFFFF):06x}",
        )
        request_prefix = _normalize_prefix(request_id_prefix, _random_request_id())

        def make_step_opts(step: str, **extra: Any) -> Dict[str, Any]:
            out = {
                "request_id": f"{request_prefix}_{step}",
                "idempotency_key": f"{step_prefix}_{step}",
                "timeout_seconds": timeout_seconds,
            }
            out.update(extra)
            return out

        payee_registration = self.register_agent(payee_agent, **make_step_opts("register_payee"))
        payee_agent_id = payee_registration.get("body", {}).get("agentIdentity", {}).get("agentId")
        _assert_non_empty_string(payee_agent_id, "payee_agent_id")

        payer_registration = None
        payer_credit = None
        payer_agent_id = None
        payer_agent = params.get("payer_agent")
        if payer_agent is not None:
            if not isinstance(payer_agent, dict):
                raise ValueError("params.payer_agent must be an object")
            _assert_non_empty_string(payer_agent.get("publicKeyPem"), "params.payer_agent.publicKeyPem")
            payer_registration = self.register_agent(payer_agent, **make_step_opts("register_payer"))
            payer_agent_id = payer_registration.get("body", {}).get("agentIdentity", {}).get("agentId")
            _assert_non_empty_string(payer_agent_id, "payer_agent_id")

        settlement = params.get("settlement") if isinstance(params.get("settlement"), dict) else None
        settlement_amount_cents = settlement.get("amountCents") if settlement else None
        settlement_currency = settlement.get("currency", "USD") if settlement else "USD"
        settlement_payer_agent_id = (
            settlement.get("payerAgentId")
            if settlement and isinstance(settlement.get("payerAgentId"), str)
            else payer_agent_id
        )
        if settlement_amount_cents is not None and settlement_payer_agent_id is None:
            raise ValueError("params.payer_agent or params.settlement.payerAgentId is required when settlement is requested")

        payer_credit_input = params.get("payer_credit")
        if payer_credit_input is not None:
            if not isinstance(payer_credit_input, dict):
                raise ValueError("params.payer_credit must be an object")
            payer_credit_amount = payer_credit_input.get("amountCents")
            if not isinstance(payer_credit_amount, (int, float)) or payer_credit_amount <= 0:
                raise ValueError("params.payer_credit.amountCents must be a positive number")
            if not payer_agent_id:
                raise ValueError("params.payer_agent is required when params.payer_credit is provided")
            payer_credit = self.credit_agent_wallet(
                payer_agent_id,
                {
                    "amountCents": int(payer_credit_amount),
                    "currency": payer_credit_input.get("currency", settlement_currency),
                },
                **make_step_opts("credit_payer_wallet"),
            )

        run_body = dict(params.get("run") or {})
        if settlement_amount_cents is not None:
            if not isinstance(settlement_amount_cents, (int, float)) or settlement_amount_cents <= 0:
                raise ValueError("params.settlement.amountCents must be a positive number")
            run_body["settlement"] = {
                "payerAgentId": settlement_payer_agent_id,
                "amountCents": int(settlement_amount_cents),
                "currency": settlement_currency,
            }

        run_created = self.create_agent_run(payee_agent_id, run_body, **make_step_opts("create_run"))
        run_id = run_created.get("body", {}).get("run", {}).get("runId")
        _assert_non_empty_string(run_id, "run_id")
        prev_chain_hash = run_created.get("body", {}).get("run", {}).get("lastChainHash")
        _assert_non_empty_string(prev_chain_hash, "run_created.body.run.lastChainHash")

        actor = params.get("actor") or {"type": "agent", "id": payee_agent_id}
        started_payload = params.get("started_payload") or {"startedBy": "sdk.first_verified_run"}
        run_started = self.append_agent_run_event(
            payee_agent_id,
            run_id,
            {"type": "RUN_STARTED", "actor": actor, "payload": started_payload},
            expected_prev_chain_hash=prev_chain_hash,
            **make_step_opts("run_started"),
        )
        prev_chain_hash = run_started.get("body", {}).get("run", {}).get("lastChainHash")
        _assert_non_empty_string(prev_chain_hash, "run_started.body.run.lastChainHash")

        evidence_ref = params.get("evidence_ref") if isinstance(params.get("evidence_ref"), str) and params.get("evidence_ref").strip() else f"evidence://{run_id}/output.json"
        evidence_payload = params.get("evidence_payload") if isinstance(params.get("evidence_payload"), dict) else {"evidenceRef": evidence_ref}
        run_evidence_added = self.append_agent_run_event(
            payee_agent_id,
            run_id,
            {"type": "EVIDENCE_ADDED", "actor": actor, "payload": evidence_payload},
            expected_prev_chain_hash=prev_chain_hash,
            **make_step_opts("evidence_added"),
        )
        prev_chain_hash = run_evidence_added.get("body", {}).get("run", {}).get("lastChainHash")
        _assert_non_empty_string(prev_chain_hash, "run_evidence_added.body.run.lastChainHash")

        completed_payload = dict(params.get("completed_payload") or {})
        output_ref = params.get("output_ref") if isinstance(params.get("output_ref"), str) and params.get("output_ref").strip() else evidence_ref
        completed_payload["outputRef"] = output_ref
        if isinstance(params.get("completed_metrics"), dict):
            completed_payload["metrics"] = params.get("completed_metrics")
        run_completed = self.append_agent_run_event(
            payee_agent_id,
            run_id,
            {"type": "RUN_COMPLETED", "actor": actor, "payload": completed_payload},
            expected_prev_chain_hash=prev_chain_hash,
            **make_step_opts("run_completed"),
        )

        run = self.get_agent_run(payee_agent_id, run_id, **make_step_opts("get_run"))
        verification = self.get_run_verification(run_id, **make_step_opts("get_verification"))
        settlement_out = None
        if run_body.get("settlement") or run_created.get("body", {}).get("settlement") or run_completed.get("body", {}).get("settlement"):
            settlement_out = self.get_run_settlement(run_id, **make_step_opts("get_settlement"))

        return {
            "ids": {"run_id": run_id, "payee_agent_id": payee_agent_id, "payer_agent_id": payer_agent_id},
            "payee_registration": payee_registration,
            "payer_registration": payer_registration,
            "payer_credit": payer_credit,
            "run_created": run_created,
            "run_started": run_started,
            "run_evidence_added": run_evidence_added,
            "run_completed": run_completed,
            "run": run,
            "verification": verification,
            "settlement": settlement_out,
        }
