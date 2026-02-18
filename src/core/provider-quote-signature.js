import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const TOOL_PROVIDER_QUOTE_PAYLOAD_SCHEMA_VERSION = "ToolProviderQuotePayload.v1";
export const TOOL_PROVIDER_QUOTE_SIGNATURE_SCHEMA_VERSION = "ToolProviderQuoteSignature.v1";

function assertNonEmptyString(v, name) {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return v.trim();
}

function assertIsoDate(v, name) {
  const value = assertNonEmptyString(v, name);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new TypeError(`${name} must be an ISO date-time`);
  return value;
}

function assertPositiveSafeInt(v, name) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function assertOptionalId(v, name) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const out = String(v).trim();
  if (!/^[A-Za-z0-9:._/-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:._/-]+$`);
  if (out.length > 200) throw new TypeError(`${name} must be <= 200 chars`);
  return out;
}

function assertCurrency(v, name) {
  const out = assertNonEmptyString(v, name).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(out)) throw new TypeError(`${name} must match ^[A-Z][A-Z0-9_]{2,11}$`);
  return out;
}

function assertRequestBindingMode(v, name) {
  const out = assertNonEmptyString(v, name).toLowerCase();
  if (out !== "none" && out !== "strict") throw new TypeError(`${name} must be none|strict`);
  return out;
}

function assertOptionalSha256Hex(v, name) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const out = String(v).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be sha256 hex`);
  return out;
}

function assertSha256Hex(v, name) {
  const out = assertNonEmptyString(v, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be sha256 hex`);
  return out;
}

function assertNonceHex(v, name) {
  const out = assertNonEmptyString(v, name).toLowerCase();
  if (!/^[0-9a-f]{16,128}$/.test(out)) throw new TypeError(`${name} must be hex (16..128 chars)`);
  return out;
}

function normalizeBoolean(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v === null || v === undefined) return false;
  const raw = String(v).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function buildToolProviderQuotePayloadV1({
  providerId,
  toolId,
  amountCents,
  currency,
  address,
  network,
  requestBindingMode = "none",
  requestBindingSha256 = null,
  quoteRequired = false,
  quoteId = null,
  spendAuthorizationMode = "optional",
  quotedAt,
  expiresAt
} = {}) {
  const normalizedRequestBindingMode = assertRequestBindingMode(requestBindingMode, "requestBindingMode");
  const normalizedRequestBindingSha256 = assertOptionalSha256Hex(requestBindingSha256, "requestBindingSha256");
  if (normalizedRequestBindingMode === "strict" && !normalizedRequestBindingSha256) {
    throw new TypeError("requestBindingSha256 is required when requestBindingMode=strict");
  }
  const normalizedSpendAuthorizationMode = assertNonEmptyString(spendAuthorizationMode, "spendAuthorizationMode").toLowerCase();
  if (normalizedSpendAuthorizationMode !== "optional" && normalizedSpendAuthorizationMode !== "required") {
    throw new TypeError("spendAuthorizationMode must be optional|required");
  }
  const normalizedQuoteId = assertOptionalId(quoteId, "quoteId");
  const payload = normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_PROVIDER_QUOTE_PAYLOAD_SCHEMA_VERSION,
      providerId: assertOptionalId(providerId, "providerId") ?? (() => {
        throw new TypeError("providerId is required");
      })(),
      toolId: assertOptionalId(toolId, "toolId") ?? (() => {
        throw new TypeError("toolId is required");
      })(),
      amountCents: assertPositiveSafeInt(amountCents, "amountCents"),
      currency: assertCurrency(currency, "currency"),
      address: assertNonEmptyString(address, "address"),
      network: assertNonEmptyString(network, "network"),
      requestBindingMode: normalizedRequestBindingMode,
      ...(normalizedRequestBindingSha256 ? { requestBindingSha256: normalizedRequestBindingSha256 } : {}),
      quoteRequired: normalizeBoolean(quoteRequired),
      ...(normalizedQuoteId ? { quoteId: normalizedQuoteId } : {}),
      spendAuthorizationMode: normalizedSpendAuthorizationMode,
      quotedAt: assertIsoDate(quotedAt, "quotedAt"),
      expiresAt: assertIsoDate(expiresAt, "expiresAt")
    },
    { path: "$" }
  );
  if (Date.parse(payload.expiresAt) <= Date.parse(payload.quotedAt)) {
    throw new TypeError("expiresAt must be after quotedAt");
  }
  return payload;
}

export function computeToolProviderQuotePayloadHashV1({ quote } = {}) {
  const payload = buildToolProviderQuotePayloadV1(quote);
  return sha256Hex(canonicalJsonStringify(payload));
}

export function signToolProviderQuoteSignatureV1({ quote, nonce, signedAt, publicKeyPem, privateKeyPem } = {}) {
  assertNonEmptyString(publicKeyPem, "publicKeyPem");
  assertNonEmptyString(privateKeyPem, "privateKeyPem");
  const keyId = keyIdFromPublicKeyPem(publicKeyPem);
  const payload = buildToolProviderQuotePayloadV1(quote);
  const payloadHashHex = computeToolProviderQuotePayloadHashV1({ quote: payload });
  const signatureBase64 = signHashHexEd25519(payloadHashHex, privateKeyPem);
  return normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_PROVIDER_QUOTE_SIGNATURE_SCHEMA_VERSION,
      algorithm: "ed25519",
      keyId,
      signedAt: assertIsoDate(signedAt, "signedAt"),
      nonce: assertNonceHex(nonce, "nonce"),
      payloadHash: payloadHashHex,
      signatureBase64
    },
    { path: "$" }
  );
}

export function verifyToolProviderQuoteSignatureV1({ quote, signature, publicKeyPem } = {}) {
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) throw new TypeError("signature must be an object");
  assertNonEmptyString(publicKeyPem, "publicKeyPem");

  if (signature.schemaVersion !== TOOL_PROVIDER_QUOTE_SIGNATURE_SCHEMA_VERSION) {
    throw new TypeError(`signature.schemaVersion must be ${TOOL_PROVIDER_QUOTE_SIGNATURE_SCHEMA_VERSION}`);
  }
  if (String(signature.algorithm ?? "").toLowerCase() !== "ed25519") {
    throw new TypeError("signature.algorithm must be ed25519");
  }
  const expectedKeyId = keyIdFromPublicKeyPem(publicKeyPem);
  if (String(signature.keyId ?? "").trim() !== expectedKeyId) return false;

  const payloadHashHex = computeToolProviderQuotePayloadHashV1({ quote });
  if (assertSha256Hex(signature.payloadHash, "signature.payloadHash") !== payloadHashHex) return false;
  const signatureBase64 = assertNonEmptyString(signature.signatureBase64, "signature.signatureBase64");

  return verifyHashHexEd25519({ hashHex: payloadHashHex, signatureBase64, publicKeyPem });
}
