import { createHash, sign as nodeSign } from "node:crypto";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertSha256Hex(value, name) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new TypeError(`${name} must be sha256 hex`);
  return raw;
}

function randomRequestId() {
  try {
    if (globalThis.crypto?.randomUUID) return String(globalThis.crypto.randomUUID());
  } catch {
    // ignore
  }
  return `req_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function normalizePrefix(value, fallback) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return fallback;
}

function canonicalize(value) {
  if (value === null) return null;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return value;
  if (valueType === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Unsupported number for canonical JSON: non-finite");
    if (Object.is(value, -0)) throw new TypeError("Unsupported number for canonical JSON: -0");
    return value;
  }
  if (valueType === "undefined") throw new TypeError("Unsupported value for canonical JSON: undefined");
  if (valueType === "bigint" || valueType === "function" || valueType === "symbol") {
    throw new TypeError(`Unsupported type for canonical JSON: ${valueType}`);
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (valueType === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("Unsupported object for canonical JSON: non-plain object");
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = canonicalize(value[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  throw new TypeError(`Unsupported value for canonical JSON: ${String(value)}`);
}

function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256HexUtf8(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function canonicalJsonStringifyDeterministic(value) {
  return canonicalJsonStringify(value);
}

export function computeCanonicalSha256(value) {
  return sha256HexUtf8(canonicalJsonStringify(value));
}

export function buildCanonicalEnvelope(value) {
  const canonicalJson = canonicalJsonStringify(value);
  return {
    canonicalJson,
    sha256: sha256HexUtf8(canonicalJson)
  };
}

function normalizeIsoDate(value, { fallbackNow = false, name = "timestamp" } = {}) {
  const raw =
    typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : fallbackNow
        ? new Date().toISOString()
        : null;
  if (!raw) throw new TypeError(`${name} is required`);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be an ISO date string`);
  return new Date(parsed).toISOString();
}

function asNonEmptyStringOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function assertReasonCode(value, name) {
  const raw = asNonEmptyStringOrNull(value);
  if (!raw) throw new TypeError(`${name} is required`);
  const normalized = String(raw).toUpperCase();
  if (!/^[A-Z0-9_]{2,64}$/.test(normalized)) throw new TypeError(`${name} must match ^[A-Z0-9_]{2,64}$`);
  return normalized;
}

function appendAgentCardToolDescriptorQueryParams(qs, params = {}) {
  if (params.toolId) qs.set("toolId", String(params.toolId));
  if (params.toolMcpName) qs.set("toolMcpName", String(params.toolMcpName));
  if (params.toolRiskClass) qs.set("toolRiskClass", String(params.toolRiskClass));
  if (params.toolSideEffecting !== undefined && params.toolSideEffecting !== null) {
    qs.set("toolSideEffecting", String(Boolean(params.toolSideEffecting)));
  }
  if (params.toolMaxPriceCents !== undefined && params.toolMaxPriceCents !== null) {
    qs.set("toolMaxPriceCents", String(params.toolMaxPriceCents));
  }
  if (params.toolRequiresEvidenceKind) qs.set("toolRequiresEvidenceKind", String(params.toolRequiresEvidenceKind));
}

function parseSseFrame(frameText) {
  if (typeof frameText !== "string") return null;
  const normalized = frameText.replace(/\r/g, "");
  if (normalized.trim() === "") return null;
  const lines = normalized.split("\n");
  let eventName = "message";
  let eventId = null;
  const dataLines = [];
  let sawCommentOnlyLine = false;
  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith(":")) {
      sawCommentOnlyLine = true;
      continue;
    }
    const sepIndex = line.indexOf(":");
    const field = sepIndex === -1 ? line : line.slice(0, sepIndex);
    let value = sepIndex === -1 ? "" : line.slice(sepIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value.trim() || "message";
    if (field === "id") eventId = value.trim() || null;
    if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) {
    if (sawCommentOnlyLine) return null;
    return { event: eventName, id: eventId, rawData: "", data: null };
  }
  const rawData = dataLines.join("\n");
  let data = rawData;
  if (rawData === "null") data = null;
  else {
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
  }
  return { event: eventName, id: eventId, rawData, data };
}

async function* parseSseResponse(res) {
  if (!res?.body || typeof res.body.getReader !== "function") {
    throw new TypeError("response body is not a readable stream");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const splitIndex = buffer.indexOf("\n\n");
        if (splitIndex === -1) break;
        const frame = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    const parsed = parseSseFrame(buffer);
    if (parsed) yield parsed;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // no-op
    }
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headersToRecord(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[String(k).toLowerCase()] = String(v);
  return out;
}

const PARITY_DEFAULT_RETRY_STATUS_CODES = Object.freeze([408, 409, 425, 429, 500, 502, 503, 504]);
const PARITY_REASON_CODE = Object.freeze({
  OPERATION_INVALID: "PARITY_OPERATION_INVALID",
  PAYLOAD_REQUIRED: "PARITY_PAYLOAD_REQUIRED",
  REQUIRED_FIELD_MISSING: "PARITY_REQUIRED_FIELD_MISSING",
  SHA256_FIELD_INVALID: "PARITY_SHA256_FIELD_INVALID",
  IDEMPOTENCY_KEY_REQUIRED: "PARITY_IDEMPOTENCY_KEY_REQUIRED",
  EXPECTED_PREV_CHAIN_HASH_REQUIRED: "PARITY_EXPECTED_PREV_CHAIN_HASH_REQUIRED",
  MCP_CALL_REQUIRED: "PARITY_MCP_CALL_REQUIRED",
  RESPONSE_INVALID: "PARITY_RESPONSE_INVALID",
  TRANSPORT_ERROR: "PARITY_TRANSPORT_ERROR",
  REQUEST_REJECTED: "PARITY_REQUEST_REJECTED"
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseInteger(value, fallback, { min = 0 } = {}) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new TypeError("value must be an integer");
  return parsed;
}

function normalizeRetryStatusCodes(value) {
  if (value === undefined || value === null) return new Set(PARITY_DEFAULT_RETRY_STATUS_CODES);
  if (!Array.isArray(value)) throw new TypeError("retryStatusCodes must be an array of status integers");
  const out = new Set();
  for (const raw of value) {
    const status = Number(raw);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new TypeError("retryStatusCodes must contain valid HTTP status integers");
    }
    out.add(status);
  }
  return out;
}

function normalizeRetryCodes(value) {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value)) throw new TypeError("retryCodes must be an array of non-empty strings");
  const out = new Set();
  for (const raw of value) {
    const code = asNonEmptyStringOrNull(raw);
    if (!code) throw new TypeError("retryCodes must contain non-empty strings");
    out.add(code.toUpperCase());
  }
  return out;
}

function normalizeHeadersRecord(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (rawValue === undefined || rawValue === null) continue;
    out[String(rawKey).toLowerCase()] = String(rawValue);
  }
  return out;
}

function getValueAtPath(target, fieldPath) {
  const parts = String(fieldPath).split(".").filter(Boolean);
  let cursor = target;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function resolveRetryDelayMs(retryDelayMs, attempt) {
  if (typeof retryDelayMs === "function") {
    const computed = Number(retryDelayMs(attempt));
    if (!Number.isFinite(computed) || computed < 0) throw new TypeError("retryDelayMs(attempt) must return a non-negative number");
    return computed;
  }
  const raw = retryDelayMs === undefined || retryDelayMs === null ? 0 : Number(retryDelayMs);
  if (!Number.isFinite(raw) || raw < 0) throw new TypeError("retryDelayMs must be a non-negative number");
  return raw;
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createParityError({
  status = 500,
  code = PARITY_REASON_CODE.REQUEST_REJECTED,
  message = "request failed",
  details = null,
  requestId = null,
  retryable = false,
  attempts = 1,
  idempotencyKey = null,
  transport = "http",
  operationId = null
}) {
  const normalizedStatus = Number.isInteger(Number(status)) ? Number(status) : 500;
  const normalizedCode = asNonEmptyStringOrNull(code) ?? PARITY_REASON_CODE.REQUEST_REJECTED;
  const normalizedMessage = asNonEmptyStringOrNull(message) ?? `request failed (${normalizedStatus})`;
  const error = new Error(normalizedMessage);
  error.nooterra = {
    status: normalizedStatus,
    code: normalizedCode,
    message: normalizedMessage,
    details,
    requestId: asNonEmptyStringOrNull(requestId),
    retryable: Boolean(retryable),
    attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 1,
    idempotencyKey: asNonEmptyStringOrNull(idempotencyKey),
    transport,
    operationId: asNonEmptyStringOrNull(operationId)
  };
  return error;
}

function throwParityValidation({ code, message, details, transport, operationId, idempotencyKey }) {
  throw createParityError({
    status: 400,
    code,
    message,
    details,
    retryable: false,
    attempts: 1,
    transport,
    operationId,
    idempotencyKey
  });
}

function resolveParityOperation(operation, { transport }) {
  if (!isPlainObject(operation)) {
    throw new TypeError("operation must be an object");
  }
  const operationId = asNonEmptyStringOrNull(operation.operationId);
  if (!operationId) throw new TypeError("operation.operationId is required");
  const requiredFields = Array.isArray(operation.requiredFields) ? operation.requiredFields.map((field) => String(field)) : [];
  const sha256Fields = Array.isArray(operation.sha256Fields) ? operation.sha256Fields.map((field) => String(field)) : [];
  const idempotencyRequired =
    operation.idempotencyRequired === undefined || operation.idempotencyRequired === null
      ? true
      : Boolean(operation.idempotencyRequired);
  const expectedPrevChainHashRequired = Boolean(operation.expectedPrevChainHashRequired);
  if (transport === "http") {
    const method = asNonEmptyStringOrNull(operation.method);
    const path = asNonEmptyStringOrNull(operation.path);
    if (!method) throw new TypeError("operation.method is required for http parity adapter");
    if (!path || !path.startsWith("/")) throw new TypeError("operation.path is required for http parity adapter");
    return {
      transport,
      operationId,
      method: method.toUpperCase(),
      path,
      toolName: null,
      requiredFields,
      sha256Fields,
      idempotencyRequired,
      expectedPrevChainHashRequired
    };
  }
  const toolName = asNonEmptyStringOrNull(operation.toolName);
  if (!toolName) throw new TypeError("operation.toolName is required for mcp parity adapter");
  return {
    transport,
    operationId,
    method: null,
    path: null,
    toolName,
    requiredFields,
    sha256Fields,
    idempotencyRequired,
    expectedPrevChainHashRequired
  };
}

function validateParityPayload(payload, operation, { transport, idempotencyKey, expectedPrevChainHash }) {
  if (!isPlainObject(payload)) {
    throwParityValidation({
      code: PARITY_REASON_CODE.PAYLOAD_REQUIRED,
      message: "payload must be an object",
      transport,
      operationId: operation.operationId,
      idempotencyKey
    });
  }
  for (const fieldPath of operation.requiredFields) {
    if (!asNonEmptyStringOrNull(fieldPath)) continue;
    const value = getValueAtPath(payload, fieldPath);
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
      throwParityValidation({
        code: PARITY_REASON_CODE.REQUIRED_FIELD_MISSING,
        message: `payload.${fieldPath} is required`,
        details: { field: fieldPath },
        transport,
        operationId: operation.operationId,
        idempotencyKey
      });
    }
  }
  for (const fieldPath of operation.sha256Fields) {
    if (!asNonEmptyStringOrNull(fieldPath)) continue;
    const value = getValueAtPath(payload, fieldPath);
    try {
      assertSha256Hex(value, `payload.${fieldPath}`);
    } catch {
      throwParityValidation({
        code: PARITY_REASON_CODE.SHA256_FIELD_INVALID,
        message: `payload.${fieldPath} must be sha256 hex`,
        details: { field: fieldPath },
        transport,
        operationId: operation.operationId,
        idempotencyKey
      });
    }
  }
  if (operation.idempotencyRequired && !asNonEmptyStringOrNull(idempotencyKey)) {
    throwParityValidation({
      code: PARITY_REASON_CODE.IDEMPOTENCY_KEY_REQUIRED,
      message: "idempotencyKey is required",
      transport,
      operationId: operation.operationId
    });
  }
  if (operation.expectedPrevChainHashRequired && !asNonEmptyStringOrNull(expectedPrevChainHash)) {
    throwParityValidation({
      code: PARITY_REASON_CODE.EXPECTED_PREV_CHAIN_HASH_REQUIRED,
      message: "expectedPrevChainHash is required",
      transport,
      operationId: operation.operationId,
      idempotencyKey
    });
  }
  if (asNonEmptyStringOrNull(expectedPrevChainHash)) {
    try {
      assertSha256Hex(expectedPrevChainHash, "expectedPrevChainHash");
    } catch {
      throwParityValidation({
        code: PARITY_REASON_CODE.EXPECTED_PREV_CHAIN_HASH_REQUIRED,
        message: "expectedPrevChainHash must be sha256 hex",
        transport,
        operationId: operation.operationId,
        idempotencyKey
      });
    }
  }
}

function coerceParityError(err, context) {
  if (err?.nooterra && typeof err.nooterra === "object") {
    return createParityError({
      status: err.nooterra.status,
      code: err.nooterra.code ?? PARITY_REASON_CODE.REQUEST_REJECTED,
      message: err.nooterra.message ?? err.message,
      details: err.nooterra.details,
      requestId: err.nooterra.requestId ?? context.requestId,
      retryable: false,
      attempts: context.attempt,
      idempotencyKey: context.idempotencyKey,
      transport: context.transport,
      operationId: context.operationId
    });
  }
  return createParityError({
    status: 0,
    code: PARITY_REASON_CODE.TRANSPORT_ERROR,
    message: err?.message ?? "transport error",
    details: { causeName: err?.name ?? null },
    requestId: context.requestId,
    retryable: false,
    attempts: context.attempt,
    idempotencyKey: context.idempotencyKey,
    transport: context.transport,
    operationId: context.operationId
  });
}

export class NooterraClient {
  constructor(opts) {
    assertNonEmptyString(opts?.baseUrl, "baseUrl");
    assertNonEmptyString(opts?.tenantId, "tenantId");
    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, "");
    this.tenantId = String(opts.tenantId);
    this.protocol = opts?.protocol ? String(opts.protocol) : "1.0";
    this.apiKey = opts?.apiKey ? String(opts.apiKey) : null;
    this.xApiKey = opts?.xApiKey ? String(opts.xApiKey) : null;
    this.opsToken = opts?.opsToken ? String(opts.opsToken) : null;
    this.fetchImpl = opts?.fetch ?? fetch;
    this.userAgent = opts?.userAgent ? String(opts.userAgent) : null;
  }

  createHttpParityAdapter(opts = {}) {
    return new NooterraHttpParityAdapter(this, opts);
  }

  createMcpParityAdapter(opts = {}) {
    return new NooterraMcpParityAdapter(this, opts);
  }

  async request(method, pathname, { body, requestId, idempotencyKey, expectedPrevChainHash, principalId, signal } = {}) {
    const url = new URL(pathname, this.baseUrl);
    const rid = requestId ?? randomRequestId();

    const headers = {
      "content-type": "application/json",
      "x-proxy-tenant-id": this.tenantId,
      "x-nooterra-protocol": this.protocol,
      "x-request-id": rid
    };
    if (this.userAgent) headers["user-agent"] = this.userAgent;
    if (idempotencyKey) headers["x-idempotency-key"] = String(idempotencyKey);
    if (expectedPrevChainHash) headers["x-proxy-expected-prev-chain-hash"] = String(expectedPrevChainHash);
    if (principalId) headers["x-proxy-principal-id"] = String(principalId);
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    if (this.xApiKey) headers["x-api-key"] = this.xApiKey;
    if (this.opsToken) headers["x-proxy-ops-token"] = this.opsToken;

    const res = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });

    const outHeaders = headersToRecord(res.headers);
    const responseRequestId = outHeaders["x-request-id"] ?? null;
    const parsed = await readJson(res);
    if (!res.ok) {
      const errBody = parsed && typeof parsed === "object" ? parsed : {};
      const e = {
        status: res.status,
        code: errBody?.code ?? null,
        message: errBody?.error ?? `request failed (${res.status})`,
        details: errBody?.details,
        requestId: responseRequestId
      };
      const thrown = new Error(e.message);
      thrown.nooterra = e;
      throw thrown;
    }

    return { ok: true, status: res.status, requestId: responseRequestId, body: parsed, headers: outHeaders };
  }

  capabilities(opts) {
    return this.request("GET", "/capabilities", opts);
  }

  openApi(opts) {
    return this.request("GET", "/openapi.json", opts);
  }

  x402GateAuthorizePayment(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.gateId, "body.gateId");
    return this.request("POST", "/x402/gate/authorize-payment", { ...opts, body });
  }

  createJob(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/jobs", { ...opts, body });
  }

  getJob(jobId, opts) {
    assertNonEmptyString(jobId, "jobId");
    return this.request("GET", `/jobs/${encodeURIComponent(jobId)}`, opts);
  }

  registerAgent(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.publicKeyPem, "body.publicKeyPem");
    return this.request("POST", "/agents/register", { ...opts, body });
  }

  listAgents(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.minTrustScore !== undefined && params.minTrustScore !== null) qs.set("minTrustScore", String(params.minTrustScore));
    if (params.includeReputation !== undefined && params.includeReputation !== null) qs.set("includeReputation", String(Boolean(params.includeReputation)));
    if (params.reputationVersion) qs.set("reputationVersion", String(params.reputationVersion));
    if (params.reputationWindow) qs.set("reputationWindow", String(params.reputationWindow));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/agents${suffix}`, opts);
  }

  getAgent(agentId, opts) {
    assertNonEmptyString(agentId, "agentId");
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}`, opts);
  }

  getAgentReputation(agentId, opts = {}) {
    assertNonEmptyString(agentId, "agentId");
    const qs = new URLSearchParams();
    if (opts.reputationVersion) qs.set("reputationVersion", String(opts.reputationVersion));
    if (opts.reputationWindow) qs.set("reputationWindow", String(opts.reputationWindow));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const { reputationVersion: _rVersion, reputationWindow: _rWindow, ...requestOpts } = opts ?? {};
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/reputation${suffix}`, requestOpts);
  }

  upsertAgentCard(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/agent-cards", { ...opts, body });
  }

  getAgentCard(agentId, opts) {
    assertNonEmptyString(agentId, "agentId");
    return this.request("GET", `/agent-cards/${encodeURIComponent(agentId)}`, opts);
  }

  listAgentCards(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.agentId) qs.set("agentId", String(params.agentId));
    if (params.status) qs.set("status", String(params.status));
    if (params.visibility) qs.set("visibility", String(params.visibility));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.executionCoordinatorDid) qs.set("executionCoordinatorDid", String(params.executionCoordinatorDid));
    if (params.runtime) qs.set("runtime", String(params.runtime));
    if (params.supportsPolicyTemplate) qs.set("supportsPolicyTemplate", String(params.supportsPolicyTemplate));
    if (params.supportsEvidencePack) qs.set("supportsEvidencePack", String(params.supportsEvidencePack));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    appendAgentCardToolDescriptorQueryParams(qs, params);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/agent-cards${suffix}`, opts);
  }

  discoverAgentCards(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.visibility) qs.set("visibility", String(params.visibility));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.executionCoordinatorDid) qs.set("executionCoordinatorDid", String(params.executionCoordinatorDid));
    if (params.runtime) qs.set("runtime", String(params.runtime));
    if (params.supportsPolicyTemplate) qs.set("supportsPolicyTemplate", String(params.supportsPolicyTemplate));
    if (params.supportsEvidencePack) qs.set("supportsEvidencePack", String(params.supportsEvidencePack));
    if (params.requireCapabilityAttestation !== undefined && params.requireCapabilityAttestation !== null) {
      qs.set("requireCapabilityAttestation", String(Boolean(params.requireCapabilityAttestation)));
    }
    if (params.attestationMinLevel) qs.set("attestationMinLevel", String(params.attestationMinLevel));
    if (params.attestationIssuerAgentId) qs.set("attestationIssuerAgentId", String(params.attestationIssuerAgentId));
    if (params.includeAttestationMetadata !== undefined && params.includeAttestationMetadata !== null) {
      qs.set("includeAttestationMetadata", String(Boolean(params.includeAttestationMetadata)));
    }
    if (params.minTrustScore !== undefined && params.minTrustScore !== null) qs.set("minTrustScore", String(params.minTrustScore));
    if (params.riskTier) qs.set("riskTier", String(params.riskTier));
    if (params.includeReputation !== undefined && params.includeReputation !== null) {
      qs.set("includeReputation", String(Boolean(params.includeReputation)));
    }
    if (params.reputationVersion) qs.set("reputationVersion", String(params.reputationVersion));
    if (params.reputationWindow) qs.set("reputationWindow", String(params.reputationWindow));
    if (params.scoreStrategy) qs.set("scoreStrategy", String(params.scoreStrategy));
    if (params.requesterAgentId) qs.set("requesterAgentId", String(params.requesterAgentId));
    if (params.includeRoutingFactors !== undefined && params.includeRoutingFactors !== null) {
      qs.set("includeRoutingFactors", String(Boolean(params.includeRoutingFactors)));
    }
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    appendAgentCardToolDescriptorQueryParams(qs, params);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/agent-cards/discover${suffix}`, opts);
  }

  discoverPublicAgentCards(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.visibility) qs.set("visibility", String(params.visibility));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.executionCoordinatorDid) qs.set("executionCoordinatorDid", String(params.executionCoordinatorDid));
    if (params.runtime) qs.set("runtime", String(params.runtime));
    if (params.requireCapabilityAttestation !== undefined && params.requireCapabilityAttestation !== null) {
      qs.set("requireCapabilityAttestation", String(Boolean(params.requireCapabilityAttestation)));
    }
    if (params.attestationMinLevel) qs.set("attestationMinLevel", String(params.attestationMinLevel));
    if (params.attestationIssuerAgentId) qs.set("attestationIssuerAgentId", String(params.attestationIssuerAgentId));
    if (params.includeAttestationMetadata !== undefined && params.includeAttestationMetadata !== null) {
      qs.set("includeAttestationMetadata", String(Boolean(params.includeAttestationMetadata)));
    }
    if (params.minTrustScore !== undefined && params.minTrustScore !== null) qs.set("minTrustScore", String(params.minTrustScore));
    if (params.riskTier) qs.set("riskTier", String(params.riskTier));
    if (params.includeReputation !== undefined && params.includeReputation !== null) {
      qs.set("includeReputation", String(Boolean(params.includeReputation)));
    }
    if (params.reputationVersion) qs.set("reputationVersion", String(params.reputationVersion));
    if (params.reputationWindow) qs.set("reputationWindow", String(params.reputationWindow));
    if (params.scoreStrategy) qs.set("scoreStrategy", String(params.scoreStrategy));
    if (params.requesterAgentId) qs.set("requesterAgentId", String(params.requesterAgentId));
    if (params.includeRoutingFactors !== undefined && params.includeRoutingFactors !== null) {
      qs.set("includeRoutingFactors", String(Boolean(params.includeRoutingFactors)));
    }
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    appendAgentCardToolDescriptorQueryParams(qs, params);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/public/agent-cards/discover${suffix}`, opts);
  }

  async *streamPublicAgentCards(params = {}, opts = {}) {
    const qs = new URLSearchParams();
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.executionCoordinatorDid) qs.set("executionCoordinatorDid", String(params.executionCoordinatorDid));
    if (params.toolId) qs.set("toolId", String(params.toolId));
    if (params.toolMcpName) qs.set("toolMcpName", String(params.toolMcpName));
    if (params.toolRiskClass) qs.set("toolRiskClass", String(params.toolRiskClass));
    if (params.toolSideEffecting !== undefined && params.toolSideEffecting !== null) {
      qs.set("toolSideEffecting", String(Boolean(params.toolSideEffecting)));
    }
    if (params.toolMaxPriceCents !== undefined && params.toolMaxPriceCents !== null) {
      qs.set("toolMaxPriceCents", String(params.toolMaxPriceCents));
    }
    if (params.toolRequiresEvidenceKind) qs.set("toolRequiresEvidenceKind", String(params.toolRequiresEvidenceKind));
    if (params.status) qs.set("status", String(params.status));
    if (params.runtime) qs.set("runtime", String(params.runtime));
    if (params.sinceCursor) qs.set("sinceCursor", String(params.sinceCursor));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";

    const rid = opts.requestId ?? randomRequestId();
    const headers = {
      accept: "text/event-stream",
      "x-proxy-tenant-id": this.tenantId,
      "x-nooterra-protocol": this.protocol,
      "x-request-id": rid
    };
    if (this.userAgent) headers["user-agent"] = this.userAgent;
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    if (this.xApiKey) headers["x-api-key"] = this.xApiKey;
    if (this.opsToken) headers["x-proxy-ops-token"] = this.opsToken;
    if (opts.lastEventId) headers["last-event-id"] = String(opts.lastEventId);

    const url = new URL(`/public/agent-cards/stream${suffix}`, this.baseUrl);
    const res = await this.fetchImpl(url.toString(), { method: "GET", headers, signal: opts.signal });
    const outHeaders = headersToRecord(res.headers);
    const responseRequestId = outHeaders["x-request-id"] ?? null;
    if (!res.ok) {
      const parsed = await readJson(res);
      const errBody = parsed && typeof parsed === "object" ? parsed : {};
      const e = {
        status: res.status,
        code: errBody?.code ?? null,
        message: errBody?.error ?? `request failed (${res.status})`,
        details: errBody?.details,
        requestId: responseRequestId
      };
      const thrown = new Error(e.message);
      thrown.nooterra = e;
      throw thrown;
    }

    for await (const event of parseSseResponse(res)) {
      yield event;
    }
  }

  getPublicAgentReputationSummary(agentId, params = {}, opts) {
    assertNonEmptyString(agentId, "agentId");
    const qs = new URLSearchParams();
    if (params.reputationVersion) qs.set("reputationVersion", String(params.reputationVersion));
    if (params.reputationWindow) qs.set("reputationWindow", String(params.reputationWindow));
    if (params.asOf) qs.set("asOf", String(params.asOf));
    if (params.includeRelationships !== undefined && params.includeRelationships !== null) {
      qs.set("includeRelationships", String(Boolean(params.includeRelationships)));
    }
    if (params.relationshipLimit !== undefined && params.relationshipLimit !== null) {
      qs.set("relationshipLimit", String(params.relationshipLimit));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/public/agents/${encodeURIComponent(agentId)}/reputation-summary${suffix}`, opts);
  }

  getAgentInteractionGraphPack(agentId, params = {}, opts) {
    assertNonEmptyString(agentId, "agentId");
    const qs = new URLSearchParams();
    if (params.reputationVersion) qs.set("reputationVersion", String(params.reputationVersion));
    if (params.reputationWindow) qs.set("reputationWindow", String(params.reputationWindow));
    if (params.asOf) qs.set("asOf", String(params.asOf));
    if (params.counterpartyAgentId) qs.set("counterpartyAgentId", String(params.counterpartyAgentId));
    if (params.visibility) qs.set("visibility", String(params.visibility));
    if (params.sign !== undefined && params.sign !== null) qs.set("sign", String(Boolean(params.sign)));
    if (params.signerKeyId) qs.set("signerKeyId", String(params.signerKeyId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/interaction-graph-pack${suffix}`, opts);
  }

  listRelationships(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.agentId) qs.set("agentId", String(params.agentId));
    if (params.counterpartyAgentId) qs.set("counterpartyAgentId", String(params.counterpartyAgentId));
    if (params.reputationWindow) qs.set("reputationWindow", String(params.reputationWindow));
    if (params.asOf) qs.set("asOf", String(params.asOf));
    if (params.visibility) qs.set("visibility", String(params.visibility));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/relationships${suffix}`, opts);
  }

  searchMarketplaceAgents(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.minTrustScore !== undefined && params.minTrustScore !== null) qs.set("minTrustScore", String(params.minTrustScore));
    if (params.riskTier) qs.set("riskTier", String(params.riskTier));
    if (params.includeReputation !== undefined && params.includeReputation !== null) qs.set("includeReputation", String(Boolean(params.includeReputation)));
    if (params.reputationVersion) qs.set("reputationVersion", String(params.reputationVersion));
    if (params.reputationWindow) qs.set("reputationWindow", String(params.reputationWindow));
    if (params.scoreStrategy) qs.set("scoreStrategy", String(params.scoreStrategy));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/agents/search${suffix}`, opts);
  }

  upsertMarketplaceSettlementPolicy(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/marketplace/settlement-policies", { ...opts, body });
  }

  listMarketplaceSettlementPolicies(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.policyId) qs.set("policyId", String(params.policyId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/settlement-policies${suffix}`, opts);
  }

  getMarketplaceSettlementPolicy(policyId, policyVersion, opts) {
    assertNonEmptyString(policyId, "policyId");
    if (!Number.isSafeInteger(Number(policyVersion)) || Number(policyVersion) <= 0) {
      throw new TypeError("policyVersion must be a positive safe integer");
    }
    return this.request(
      "GET",
      `/marketplace/settlement-policies/${encodeURIComponent(policyId)}/${encodeURIComponent(String(policyVersion))}`,
      opts
    );
  }

  createMarketplaceRfq(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/marketplace/rfqs", { ...opts, body });
  }

  listMarketplaceRfqs(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.posterAgentId) qs.set("posterAgentId", String(params.posterAgentId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/rfqs${suffix}`, opts);
  }

  submitMarketplaceBid(rfqId, body, opts) {
    assertNonEmptyString(rfqId, "rfqId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`, { ...opts, body });
  }

  listMarketplaceBids(rfqId, params = {}, opts) {
    assertNonEmptyString(rfqId, "rfqId");
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.bidderAgentId) qs.set("bidderAgentId", String(params.bidderAgentId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids${suffix}`, opts);
  }

  applyMarketplaceBidCounterOffer(rfqId, bidId, body, opts) {
    assertNonEmptyString(rfqId, "rfqId");
    assertNonEmptyString(bidId, "bidId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids/${encodeURIComponent(bidId)}/counter-offer`, {
      ...opts,
      body
    });
  }

  acceptMarketplaceBid(rfqId, body, opts) {
    assertNonEmptyString(rfqId, "rfqId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/marketplace/rfqs/${encodeURIComponent(rfqId)}/accept`, { ...opts, body });
  }

  createTaskQuote(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.buyerAgentId, "body.buyerAgentId");
    assertNonEmptyString(body?.sellerAgentId, "body.sellerAgentId");
    return this.request("POST", "/task-quotes", { ...opts, body });
  }

  listTaskQuotes(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.quoteId) qs.set("quoteId", String(params.quoteId));
    if (params.buyerAgentId) qs.set("buyerAgentId", String(params.buyerAgentId));
    if (params.sellerAgentId) qs.set("sellerAgentId", String(params.sellerAgentId));
    if (params.requiredCapability) qs.set("requiredCapability", String(params.requiredCapability));
    if (params.status) qs.set("status", String(params.status));
    if (params.acceptanceId) qs.set("acceptanceId", String(params.acceptanceId));
    if (params.createdAfter) qs.set("createdAfter", String(params.createdAfter));
    if (params.createdBefore) qs.set("createdBefore", String(params.createdBefore));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/task-quotes${suffix}`, opts);
  }

  getTaskQuote(quoteId, opts) {
    assertNonEmptyString(quoteId, "quoteId");
    return this.request("GET", `/task-quotes/${encodeURIComponent(quoteId)}`, opts);
  }

  createTaskOffer(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.buyerAgentId, "body.buyerAgentId");
    assertNonEmptyString(body?.sellerAgentId, "body.sellerAgentId");
    return this.request("POST", "/task-offers", { ...opts, body });
  }

  listTaskOffers(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.offerId) qs.set("offerId", String(params.offerId));
    if (params.quoteId) qs.set("quoteId", String(params.quoteId));
    if (params.buyerAgentId) qs.set("buyerAgentId", String(params.buyerAgentId));
    if (params.sellerAgentId) qs.set("sellerAgentId", String(params.sellerAgentId));
    if (params.requiredCapability) qs.set("requiredCapability", String(params.requiredCapability));
    if (params.status) qs.set("status", String(params.status));
    if (params.acceptanceId) qs.set("acceptanceId", String(params.acceptanceId));
    if (params.createdAfter) qs.set("createdAfter", String(params.createdAfter));
    if (params.createdBefore) qs.set("createdBefore", String(params.createdBefore));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/task-offers${suffix}`, opts);
  }

  getTaskOffer(offerId, opts) {
    assertNonEmptyString(offerId, "offerId");
    return this.request("GET", `/task-offers/${encodeURIComponent(offerId)}`, opts);
  }

  createTaskAcceptance(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.quoteId, "body.quoteId");
    assertNonEmptyString(body?.offerId, "body.offerId");
    assertNonEmptyString(body?.acceptedByAgentId, "body.acceptedByAgentId");
    return this.request("POST", "/task-acceptances", { ...opts, body });
  }

  listTaskAcceptances(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.acceptanceId) qs.set("acceptanceId", String(params.acceptanceId));
    if (params.quoteId) qs.set("quoteId", String(params.quoteId));
    if (params.offerId) qs.set("offerId", String(params.offerId));
    if (params.acceptedByAgentId) qs.set("acceptedByAgentId", String(params.acceptedByAgentId));
    if (params.status) qs.set("status", String(params.status));
    if (params.createdAfter) qs.set("createdAfter", String(params.createdAfter));
    if (params.createdBefore) qs.set("createdBefore", String(params.createdBefore));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/task-acceptances${suffix}`, opts);
  }

  getTaskAcceptance(acceptanceId, opts) {
    assertNonEmptyString(acceptanceId, "acceptanceId");
    return this.request("GET", `/task-acceptances/${encodeURIComponent(acceptanceId)}`, opts);
  }

  proposeIntentContract(body, opts) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    assertNonEmptyString(body?.proposerAgentId, "body.proposerAgentId");
    assertNonEmptyString(body?.counterpartyAgentId, "body.counterpartyAgentId");
    if (body?.objective === null || body?.objective === undefined) throw new TypeError("body.objective is required");
    if (!body?.budgetEnvelope || typeof body.budgetEnvelope !== "object" || Array.isArray(body.budgetEnvelope)) {
      throw new TypeError("body.budgetEnvelope is required");
    }
    return this.request("POST", "/intents/propose", { ...opts, body });
  }

  listIntentContracts(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.intentId) qs.set("intentId", String(params.intentId));
    if (params.proposerAgentId) qs.set("proposerAgentId", String(params.proposerAgentId));
    if (params.counterpartyAgentId) qs.set("counterpartyAgentId", String(params.counterpartyAgentId));
    if (params.status) qs.set("status", String(params.status));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/intents${suffix}`, opts);
  }

  getIntentContract(intentId, opts) {
    assertNonEmptyString(intentId, "intentId");
    return this.request("GET", `/intents/${encodeURIComponent(intentId)}`, opts);
  }

  counterIntentContract(intentId, body, opts) {
    assertNonEmptyString(intentId, "intentId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    assertNonEmptyString(body?.proposerAgentId, "body.proposerAgentId");
    return this.request("POST", `/intents/${encodeURIComponent(intentId)}/counter`, { ...opts, body });
  }

  acceptIntentContract(intentId, body, opts) {
    assertNonEmptyString(intentId, "intentId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    assertNonEmptyString(body?.acceptedByAgentId, "body.acceptedByAgentId");
    return this.request("POST", `/intents/${encodeURIComponent(intentId)}/accept`, { ...opts, body });
  }

  createWorkOrder(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/work-orders", { ...opts, body });
  }

  listWorkOrders(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.workOrderId) qs.set("workOrderId", String(params.workOrderId));
    if (params.principalAgentId) qs.set("principalAgentId", String(params.principalAgentId));
    if (params.subAgentId) qs.set("subAgentId", String(params.subAgentId));
    if (params.status) qs.set("status", String(params.status));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/work-orders${suffix}`, opts);
  }

  getWorkOrder(workOrderId, opts) {
    assertNonEmptyString(workOrderId, "workOrderId");
    return this.request("GET", `/work-orders/${encodeURIComponent(workOrderId)}`, opts);
  }

  acceptWorkOrder(workOrderId, body = {}, opts) {
    assertNonEmptyString(workOrderId, "workOrderId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/work-orders/${encodeURIComponent(workOrderId)}/accept`, { ...opts, body });
  }

  progressWorkOrder(workOrderId, body, opts) {
    assertNonEmptyString(workOrderId, "workOrderId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    return this.request("POST", `/work-orders/${encodeURIComponent(workOrderId)}/progress`, { ...opts, body });
  }

  topUpWorkOrder(workOrderId, body, opts) {
    assertNonEmptyString(workOrderId, "workOrderId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    return this.request("POST", `/work-orders/${encodeURIComponent(workOrderId)}/topup`, { ...opts, body });
  }

  getWorkOrderMetering(workOrderId, params = {}, opts) {
    assertNonEmptyString(workOrderId, "workOrderId");
    const qs = new URLSearchParams();
    if (params.includeMeters !== undefined && params.includeMeters !== null) qs.set("includeMeters", String(Boolean(params.includeMeters)));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/work-orders/${encodeURIComponent(workOrderId)}/metering${suffix}`, opts);
  }

  completeWorkOrder(workOrderId, body, opts) {
    assertNonEmptyString(workOrderId, "workOrderId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    return this.request("POST", `/work-orders/${encodeURIComponent(workOrderId)}/complete`, { ...opts, body });
  }

  settleWorkOrder(workOrderId, body = {}, opts) {
    assertNonEmptyString(workOrderId, "workOrderId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/work-orders/${encodeURIComponent(workOrderId)}/settle`, { ...opts, body });
  }

  listWorkOrderReceipts(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.receiptId) qs.set("receiptId", String(params.receiptId));
    if (params.workOrderId) qs.set("workOrderId", String(params.workOrderId));
    if (params.principalAgentId) qs.set("principalAgentId", String(params.principalAgentId));
    if (params.subAgentId) qs.set("subAgentId", String(params.subAgentId));
    if (params.status) qs.set("status", String(params.status));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/work-orders/receipts${suffix}`, opts);
  }

  getWorkOrderReceipt(receiptId, opts) {
    assertNonEmptyString(receiptId, "receiptId");
    return this.request("GET", `/work-orders/receipts/${encodeURIComponent(receiptId)}`, opts);
  }

  createStateCheckpoint(body, opts) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    assertNonEmptyString(body?.ownerAgentId, "body.ownerAgentId");
    if (!body.stateRef || typeof body.stateRef !== "object" || Array.isArray(body.stateRef)) {
      throw new TypeError("body.stateRef is required");
    }
    assertNonEmptyString(body.stateRef?.artifactId, "body.stateRef.artifactId");
    assertNonEmptyString(body.stateRef?.artifactHash, "body.stateRef.artifactHash");
    if (!/^[0-9a-f]{64}$/i.test(String(body.stateRef.artifactHash))) {
      throw new TypeError("body.stateRef.artifactHash must be a sha256 hex string");
    }
    if (body.diffRefs !== null && body.diffRefs !== undefined) {
      if (!Array.isArray(body.diffRefs)) throw new TypeError("body.diffRefs must be an array");
      for (let index = 0; index < body.diffRefs.length; index += 1) {
        const ref = body.diffRefs[index];
        if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
          throw new TypeError(`body.diffRefs[${index}] must be an object`);
        }
        assertNonEmptyString(ref.artifactId, `body.diffRefs[${index}].artifactId`);
        assertNonEmptyString(ref.artifactHash, `body.diffRefs[${index}].artifactHash`);
        if (!/^[0-9a-f]{64}$/i.test(String(ref.artifactHash))) {
          throw new TypeError(`body.diffRefs[${index}].artifactHash must be a sha256 hex string`);
        }
      }
    }
    return this.request("POST", "/state-checkpoints", { ...opts, body });
  }

  listStateCheckpoints(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.checkpointId) qs.set("checkpointId", String(params.checkpointId));
    if (params.projectId) qs.set("projectId", String(params.projectId));
    if (params.sessionId) qs.set("sessionId", String(params.sessionId));
    if (params.ownerAgentId) qs.set("ownerAgentId", String(params.ownerAgentId));
    if (params.traceId) qs.set("traceId", String(params.traceId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/state-checkpoints${suffix}`, opts);
  }

  getStateCheckpoint(checkpointId, opts) {
    assertNonEmptyString(checkpointId, "checkpointId");
    return this.request("GET", `/state-checkpoints/${encodeURIComponent(checkpointId)}`, opts);
  }

  compactStateCheckpointLineage(body, opts) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    if (!Array.isArray(body.checkpoints) || body.checkpoints.length === 0) {
      throw new TypeError("body.checkpoints must be a non-empty array");
    }
    return this.request("POST", "/state-checkpoints/lineage/compact", { ...opts, body });
  }

  restoreStateCheckpointLineage(body, opts) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    if (!body.compaction || typeof body.compaction !== "object" || Array.isArray(body.compaction)) {
      throw new TypeError("body.compaction is required");
    }
    return this.request("POST", "/state-checkpoints/lineage/restore", { ...opts, body });
  }

  createSession(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/sessions", { ...opts, body });
  }

  listSessions(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.sessionId) qs.set("sessionId", String(params.sessionId));
    if (params.participantAgentId) qs.set("participantAgentId", String(params.participantAgentId));
    if (params.visibility) qs.set("visibility", String(params.visibility));
    if (params.status) qs.set("status", String(params.status));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/sessions${suffix}`, opts);
  }

  getSession(sessionId, opts) {
    assertNonEmptyString(sessionId, "sessionId");
    return this.request("GET", `/sessions/${encodeURIComponent(sessionId)}`, opts);
  }

  listSessionEvents(sessionId, params = {}, opts) {
    assertNonEmptyString(sessionId, "sessionId");
    const qs = new URLSearchParams();
    if (params.eventType) qs.set("eventType", String(params.eventType));
    if (params.sinceEventId) qs.set("sinceEventId", String(params.sinceEventId));
    if (params.checkpointConsumerId) qs.set("checkpointConsumerId", String(params.checkpointConsumerId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/sessions/${encodeURIComponent(sessionId)}/events${suffix}`, opts);
  }

  getSessionEventCheckpoint(sessionId, checkpointConsumerId, opts) {
    assertNonEmptyString(sessionId, "sessionId");
    assertNonEmptyString(checkpointConsumerId, "checkpointConsumerId");
    const qs = new URLSearchParams();
    qs.set("checkpointConsumerId", String(checkpointConsumerId));
    return this.request("GET", `/sessions/${encodeURIComponent(sessionId)}/events/checkpoint?${qs.toString()}`, opts);
  }

  ackSessionEventCheckpoint(sessionId, body, opts = {}) {
    assertNonEmptyString(sessionId, "sessionId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.checkpointConsumerId, "body.checkpointConsumerId");
    return this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/events/checkpoint`, { ...opts, body });
  }

  requeueSessionEventCheckpoint(sessionId, body, opts = {}) {
    assertNonEmptyString(sessionId, "sessionId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.checkpointConsumerId, "body.checkpointConsumerId");
    return this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/events/checkpoint/requeue`, { ...opts, body });
  }

  appendSessionEvent(sessionId, body, opts = {}) {
    assertNonEmptyString(sessionId, "sessionId");
    if (!opts?.expectedPrevChainHash) throw new TypeError("expectedPrevChainHash is required for appendSessionEvent");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.type, "body.type");
    const resolvedOpts = { ...opts };
    // Session event append is fail-closed on idempotency: default one for compatibility.
    if (!resolvedOpts.idempotencyKey) resolvedOpts.idempotencyKey = randomRequestId();
    return this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/events`, { ...resolvedOpts, body });
  }

  getSessionReplayPack(sessionId, params = {}, opts = undefined) {
    assertNonEmptyString(sessionId, "sessionId");
    let query = params;
    let requestOpts = opts;
    if (
      opts === undefined &&
      params &&
      typeof params === "object" &&
      (params.requestId !== undefined || params.signal !== undefined)
    ) {
      query = {};
      requestOpts = params;
    }
    const qs = new URLSearchParams();
    if (query?.sign !== undefined && query?.sign !== null) qs.set("sign", String(Boolean(query.sign)));
    if (query?.signerKeyId) qs.set("signerKeyId", String(query.signerKeyId));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/sessions/${encodeURIComponent(sessionId)}/replay-pack${suffix}`, requestOpts);
  }

  getSessionTranscript(sessionId, params = {}, opts = undefined) {
    assertNonEmptyString(sessionId, "sessionId");
    let query = params;
    let requestOpts = opts;
    if (
      opts === undefined &&
      params &&
      typeof params === "object" &&
      (params.requestId !== undefined || params.signal !== undefined)
    ) {
      query = {};
      requestOpts = params;
    }
    const qs = new URLSearchParams();
    if (query?.sign !== undefined && query?.sign !== null) qs.set("sign", String(Boolean(query.sign)));
    if (query?.signerKeyId) qs.set("signerKeyId", String(query.signerKeyId));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/sessions/${encodeURIComponent(sessionId)}/transcript${suffix}`, requestOpts);
  }

  async *streamSessionEvents(sessionId, params = {}, opts = {}) {
    assertNonEmptyString(sessionId, "sessionId");
    const qs = new URLSearchParams();
    if (params.eventType) qs.set("eventType", String(params.eventType));
    if (params.sinceEventId) qs.set("sinceEventId", String(params.sinceEventId));
    if (params.checkpointConsumerId) qs.set("checkpointConsumerId", String(params.checkpointConsumerId));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";

    const rid = opts.requestId ?? randomRequestId();
    const headers = {
      accept: "text/event-stream",
      "x-proxy-tenant-id": this.tenantId,
      "x-nooterra-protocol": this.protocol,
      "x-request-id": rid
    };
    if (this.userAgent) headers["user-agent"] = this.userAgent;
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    if (this.xApiKey) headers["x-api-key"] = this.xApiKey;
    if (this.opsToken) headers["x-proxy-ops-token"] = this.opsToken;
    if (opts.lastEventId) headers["last-event-id"] = String(opts.lastEventId);

    const url = new URL(`/sessions/${encodeURIComponent(sessionId)}/events/stream${suffix}`, this.baseUrl);
    const res = await this.fetchImpl(url.toString(), { method: "GET", headers, signal: opts.signal });
    const outHeaders = headersToRecord(res.headers);
    const responseRequestId = outHeaders["x-request-id"] ?? null;
    if (!res.ok) {
      const parsed = await readJson(res);
      const errBody = parsed && typeof parsed === "object" ? parsed : {};
      const e = {
        status: res.status,
        code: errBody?.code ?? null,
        message: errBody?.error ?? `request failed (${res.status})`,
        details: errBody?.details,
        requestId: responseRequestId
      };
      const thrown = new Error(e.message);
      thrown.nooterra = e;
      throw thrown;
    }

    for await (const event of parseSseResponse(res)) {
      yield event;
    }
  }

  getAgentWallet(agentId, opts) {
    assertNonEmptyString(agentId, "agentId");
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/wallet`, opts);
  }

  createDelegationGrant(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.delegatorAgentId, "body.delegatorAgentId");
    assertNonEmptyString(body?.delegateeAgentId, "body.delegateeAgentId");
    return this.request("POST", "/delegation-grants", { ...opts, body });
  }

  issueDelegationGrant(body, opts) {
    return this.createDelegationGrant(body, opts);
  }

  listDelegationGrants(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.grantId) qs.set("grantId", String(params.grantId));
    if (params.grantHash) qs.set("grantHash", String(params.grantHash).toLowerCase());
    if (params.delegatorAgentId) qs.set("delegatorAgentId", String(params.delegatorAgentId));
    if (params.delegateeAgentId) qs.set("delegateeAgentId", String(params.delegateeAgentId));
    if (params.includeRevoked !== undefined && params.includeRevoked !== null) qs.set("includeRevoked", String(Boolean(params.includeRevoked)));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/delegation-grants${suffix}`, opts);
  }

  getDelegationGrant(grantId, opts) {
    assertNonEmptyString(grantId, "grantId");
    return this.request("GET", `/delegation-grants/${encodeURIComponent(grantId)}`, opts);
  }

  revokeDelegationGrant(grantId, body = {}, opts) {
    assertNonEmptyString(grantId, "grantId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/delegation-grants/${encodeURIComponent(grantId)}/revoke`, { ...opts, body });
  }

  createAuthorityGrant(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    if (!body.principalRef || typeof body.principalRef !== "object" || Array.isArray(body.principalRef)) {
      throw new TypeError("body.principalRef is required");
    }
    assertNonEmptyString(body?.granteeAgentId, "body.granteeAgentId");
    return this.request("POST", "/authority-grants", { ...opts, body });
  }

  listAuthorityGrants(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.grantId) qs.set("grantId", String(params.grantId));
    if (params.grantHash) qs.set("grantHash", String(params.grantHash).toLowerCase());
    if (params.principalId) qs.set("principalId", String(params.principalId));
    if (params.granteeAgentId) qs.set("granteeAgentId", String(params.granteeAgentId));
    if (params.includeRevoked !== undefined && params.includeRevoked !== null) qs.set("includeRevoked", String(Boolean(params.includeRevoked)));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/authority-grants${suffix}`, opts);
  }

  getAuthorityGrant(grantId, opts) {
    assertNonEmptyString(grantId, "grantId");
    return this.request("GET", `/authority-grants/${encodeURIComponent(grantId)}`, opts);
  }

  revokeAuthorityGrant(grantId, body = {}, opts) {
    assertNonEmptyString(grantId, "grantId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/authority-grants/${encodeURIComponent(grantId)}/revoke`, { ...opts, body });
  }

  creditAgentWallet(agentId, body, opts) {
    assertNonEmptyString(agentId, "agentId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/wallet/credit`, { ...opts, body });
  }

  createAgentRun(agentId, body = {}, opts) {
    assertNonEmptyString(agentId, "agentId");
    if (!body || typeof body !== "object") throw new TypeError("body must be an object");
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/runs`, { ...opts, body });
  }

  listAgentRuns(agentId, params = {}, opts) {
    assertNonEmptyString(agentId, "agentId");
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/runs${suffix}`, opts);
  }

  getAgentRun(agentId, runId, opts) {
    assertNonEmptyString(agentId, "agentId");
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, opts);
  }

  listAgentRunEvents(agentId, runId, opts) {
    assertNonEmptyString(agentId, "agentId");
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/events`, opts);
  }

  appendAgentRunEvent(agentId, runId, body, opts) {
    assertNonEmptyString(agentId, "agentId");
    assertNonEmptyString(runId, "runId");
    if (!opts?.expectedPrevChainHash) throw new TypeError("expectedPrevChainHash is required for appendAgentRunEvent");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.type, "body.type");
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/events`, { ...opts, body });
  }

  getRunVerification(runId, opts) {
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/verification`, opts);
  }

  getRunSettlement(runId, opts) {
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/settlement`, opts);
  }

  getRunAgreement(runId, opts) {
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/agreement`, opts);
  }

  applyRunAgreementChangeOrder(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/agreement/change-order`, { ...opts, body });
  }

  cancelRunAgreement(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/agreement/cancel`, { ...opts, body });
  }

  getRunSettlementPolicyReplay(runId, opts) {
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/settlement/policy-replay`, opts);
  }

  resolveRunSettlement(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/settlement/resolve`, { ...opts, body });
  }

  opsLockToolCallHold(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/ops/tool-calls/holds/lock", { ...opts, body });
  }

  opsListToolCallHolds(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.agreementHash) qs.set("agreementHash", String(params.agreementHash));
    if (params.status) qs.set("status", String(params.status));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/ops/tool-calls/holds${suffix}`, opts);
  }

  opsGetToolCallReplayEvaluate(agreementHash, opts) {
    assertSha256Hex(agreementHash, "agreementHash");
    return this.request("GET", `/ops/tool-calls/replay-evaluate?agreementHash=${encodeURIComponent(String(agreementHash).toLowerCase())}`, opts);
  }

  opsGetToolCallHold(holdHash, opts) {
    assertNonEmptyString(holdHash, "holdHash");
    return this.request("GET", `/ops/tool-calls/holds/${encodeURIComponent(holdHash)}`, opts);
  }

  opsGetReputationFacts(params = {}, opts) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agentId = asNonEmptyStringOrNull(params.agentId);
    if (!agentId) throw new TypeError("agentId is required");
    const qs = new URLSearchParams();
    qs.set("agentId", agentId);
    const toolId = asNonEmptyStringOrNull(params.toolId);
    if (toolId) qs.set("toolId", toolId);
    if (params.window !== undefined && params.window !== null) qs.set("window", String(params.window));
    const asOf = asNonEmptyStringOrNull(params.asOf);
    if (asOf) qs.set("asOf", asOf);
    if (params.includeEvents !== undefined && params.includeEvents !== null) qs.set("includeEvents", params.includeEvents ? "1" : "0");
    return this.request("GET", `/ops/reputation/facts?${qs.toString()}`, opts);
  }

  opsRunToolCallHoldbackMaintenance(body = {}, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body must be an object");
    return this.request("POST", "/ops/maintenance/tool-call-holdback/run", { ...opts, body });
  }

  toolCallListArbitrationCases(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.agreementHash) qs.set("agreementHash", String(params.agreementHash));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/tool-calls/arbitration/cases${suffix}`, opts);
  }

  toolCallGetArbitrationCase(caseId, opts) {
    assertNonEmptyString(caseId, "caseId");
    return this.request("GET", `/tool-calls/arbitration/cases/${encodeURIComponent(caseId)}`, opts);
  }

  toolCallOpenArbitration(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/tool-calls/arbitration/open", { ...opts, body });
  }

  toolCallSubmitArbitrationVerdict(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/tool-calls/arbitration/verdict", { ...opts, body });
  }

  opsGetSettlementAdjustment(adjustmentId, opts) {
    assertNonEmptyString(adjustmentId, "adjustmentId");
    return this.request("GET", `/ops/settlement-adjustments/${encodeURIComponent(adjustmentId)}`, opts);
  }

  getArtifact(artifactId, opts) {
    assertNonEmptyString(artifactId, "artifactId");
    return this.request("GET", `/artifacts/${encodeURIComponent(artifactId)}`, opts);
  }

  createCapabilityAttestation(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.subjectAgentId, "body.subjectAgentId");
    assertNonEmptyString(body?.capability, "body.capability");
    return this.request("POST", "/capability-attestations", { ...opts, body });
  }

  listCapabilityAttestations(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.attestationId) qs.set("attestationId", String(params.attestationId));
    if (params.subjectAgentId) qs.set("subjectAgentId", String(params.subjectAgentId));
    if (params.issuerAgentId) qs.set("issuerAgentId", String(params.issuerAgentId));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.status) qs.set("status", String(params.status));
    if (params.includeInvalid !== undefined && params.includeInvalid !== null) qs.set("includeInvalid", String(Boolean(params.includeInvalid)));
    if (params.at) qs.set("at", String(params.at));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/capability-attestations${suffix}`, opts);
  }

  getCapabilityAttestation(attestationId, opts) {
    assertNonEmptyString(attestationId, "attestationId");
    return this.request("GET", `/capability-attestations/${encodeURIComponent(attestationId)}`, opts);
  }

  revokeCapabilityAttestation(attestationId, body = {}, opts) {
    assertNonEmptyString(attestationId, "attestationId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/capability-attestations/${encodeURIComponent(attestationId)}/revoke`, { ...opts, body });
  }

  async getArtifacts(params = {}, opts) {
    const artifactIdsRaw = Array.isArray(params) ? params : params?.artifactIds;
    if (!Array.isArray(artifactIdsRaw) || artifactIdsRaw.length === 0) {
      throw new TypeError("artifactIds[] is required");
    }
    const artifactIds = artifactIdsRaw.map((id, idx) => {
      const raw = asNonEmptyStringOrNull(id);
      if (!raw) throw new TypeError(`artifactIds[${idx}] must be a non-empty string`);
      return raw;
    });
    const rows = await Promise.all(
      artifactIds.map(async (artifactId) => {
        const response = await this.getArtifact(artifactId, opts);
        return { artifactId, response };
      })
    );
    return {
      artifacts: rows.map((row) => ({ artifactId: row.artifactId, artifact: row.response?.body?.artifact ?? null })),
      responses: rows.map((row) => row.response)
    };
  }

  createAgreement(params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    assertNonEmptyString(params.toolId, "params.toolId");
    assertNonEmptyString(params.callId, "params.callId");
    const manifestHash = assertSha256Hex(params.manifestHash, "params.manifestHash");
    const createdAt = normalizeIsoDate(params.createdAt, { fallbackNow: true, name: "params.createdAt" });

    const inputCanonical = canonicalJsonStringify(params.input ?? {});
    const inputHash = sha256HexUtf8(inputCanonical);

    const agreementCore = canonicalize({
      schemaVersion: "ToolCallAgreement.v1",
      toolId: String(params.toolId),
      manifestHash,
      callId: String(params.callId),
      inputHash,
      acceptanceCriteria: params.acceptanceCriteria ?? null,
      settlementTerms: params.settlementTerms ?? null,
      payerAgentId: asNonEmptyStringOrNull(params.payerAgentId),
      payeeAgentId: asNonEmptyStringOrNull(params.payeeAgentId),
      createdAt
    });
    const agreementCanonical = canonicalJsonStringify(agreementCore);
    const agreementHash = sha256HexUtf8(agreementCanonical);
    const agreement = canonicalize({ ...agreementCore, agreementHash });
    return { agreement, agreementHash, inputHash, canonicalJson: canonicalJsonStringify(agreement) };
  }

  signEvidence(params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreement = params.agreement && typeof params.agreement === "object" && !Array.isArray(params.agreement) ? params.agreement : null;
    const agreementHash = assertSha256Hex(params.agreementHash ?? agreement?.agreementHash, "agreementHash");
    const callId = asNonEmptyStringOrNull(params.callId ?? agreement?.callId);
    const inputHash = assertSha256Hex(params.inputHash ?? agreement?.inputHash, "inputHash");
    if (!callId) throw new TypeError("callId is required");

    const startedAt = normalizeIsoDate(params.startedAt, { fallbackNow: true, name: "startedAt" });
    const completedAt = normalizeIsoDate(params.completedAt ?? startedAt, { fallbackNow: true, name: "completedAt" });
    const outputCanonical = canonicalJsonStringify(params.output ?? {});
    const outputHash = sha256HexUtf8(outputCanonical);

    const evidenceCore = canonicalize({
      schemaVersion: "ToolCallEvidence.v1",
      agreementHash,
      callId,
      inputHash,
      outputHash,
      outputRef: asNonEmptyStringOrNull(params.outputRef),
      metrics: params.metrics ?? null,
      startedAt,
      completedAt,
      createdAt: normalizeIsoDate(params.createdAt ?? completedAt, { fallbackNow: true, name: "createdAt" })
    });
    const evidenceHash = sha256HexUtf8(canonicalJsonStringify(evidenceCore));

    const signerPrivateKeyPem = asNonEmptyStringOrNull(params.signerPrivateKeyPem);
    const signerKeyId = asNonEmptyStringOrNull(params.signerKeyId);
    let signature = null;
    if (signerPrivateKeyPem) {
      if (!signerKeyId) throw new TypeError("signerKeyId is required when signerPrivateKeyPem is provided");
      const signatureBase64 = nodeSign(null, Buffer.from(evidenceHash, "hex"), signerPrivateKeyPem).toString("base64");
      signature = {
        algorithm: "ed25519",
        signerKeyId,
        evidenceHash,
        signature: signatureBase64
      };
    }

    const evidence = canonicalize({
      ...evidenceCore,
      evidenceHash,
      ...(signature ? { signature } : {})
    });
    return { evidence, evidenceHash, outputHash, canonicalJson: canonicalJsonStringify(evidence) };
  }

  createHold(params = {}, opts) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreement = params.agreement && typeof params.agreement === "object" && !Array.isArray(params.agreement) ? params.agreement : null;
    const agreementHash = assertSha256Hex(params.agreementHash ?? agreement?.agreementHash, "agreementHash");
    const receiptHash = assertSha256Hex(params.receiptHash, "receiptHash");
    const payerAgentId = asNonEmptyStringOrNull(params.payerAgentId);
    const payeeAgentId = asNonEmptyStringOrNull(params.payeeAgentId);
    if (!payerAgentId) throw new TypeError("payerAgentId is required");
    if (!payeeAgentId) throw new TypeError("payeeAgentId is required");
    if (payerAgentId === payeeAgentId) throw new TypeError("payerAgentId and payeeAgentId must differ");

    const amountCents = Number(params.amountCents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
    const holdbackBps = params.holdbackBps === undefined ? 0 : Number(params.holdbackBps);
    if (!Number.isSafeInteger(holdbackBps) || holdbackBps < 0 || holdbackBps > 10_000) {
      throw new TypeError("holdbackBps must be an integer within 0..10000");
    }
    const challengeWindowMs = params.challengeWindowMs === undefined ? 0 : Number(params.challengeWindowMs);
    if (!Number.isSafeInteger(challengeWindowMs) || challengeWindowMs < 0) {
      throw new TypeError("challengeWindowMs must be a non-negative safe integer");
    }

    return this.opsLockToolCallHold(
      {
        agreementHash,
        receiptHash,
        payerAgentId,
        payeeAgentId,
        amountCents,
        currency: asNonEmptyStringOrNull(params.currency) ?? "USD",
        holdbackBps,
        challengeWindowMs
      },
      opts
    );
  }

  async settle(params = {}, opts) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreement = params.agreement && typeof params.agreement === "object" && !Array.isArray(params.agreement) ? params.agreement : null;
    const evidence = params.evidence && typeof params.evidence === "object" && !Array.isArray(params.evidence) ? params.evidence : null;
    const agreementHash = assertSha256Hex(params.agreementHash ?? agreement?.agreementHash, "agreementHash");
    const evidenceHashRaw = params.evidenceHash ?? evidence?.evidenceHash ?? null;
    const evidenceHash = evidenceHashRaw ? assertSha256Hex(evidenceHashRaw, "evidenceHash") : null;

    const amountCents = Number(params.amountCents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
    const currency = asNonEmptyStringOrNull(params.currency) ?? "USD";
    const settledAt = normalizeIsoDate(params.settledAt, { fallbackNow: true, name: "settledAt" });
    const receiptRef = canonicalize({
      schemaVersion: "ToolCallSettlementReceiptRef.v1",
      agreementHash,
      evidenceHash,
      amountCents,
      currency,
      settledAt
    });
    const receiptHash = params.receiptHash
      ? assertSha256Hex(params.receiptHash, "receiptHash")
      : sha256HexUtf8(canonicalJsonStringify(receiptRef));

    const holdResponse = await this.createHold(
      {
        agreementHash,
        receiptHash,
        payerAgentId: params.payerAgentId,
        payeeAgentId: params.payeeAgentId,
        amountCents,
        currency,
        holdbackBps: params.holdbackBps,
        challengeWindowMs: params.challengeWindowMs
      },
      opts
    );

    return {
      agreementHash,
      receiptHash,
      receiptRef,
      hold: holdResponse?.body?.hold ?? null,
      holdResponse
    };
  }

  openDispute(params = {}, opts) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreementHash = assertSha256Hex(params.agreementHash, "agreementHash");
    const receiptHash = assertSha256Hex(params.receiptHash, "receiptHash");
    const holdHash = assertSha256Hex(params.holdHash, "holdHash");
    const arbiterAgentId = asNonEmptyStringOrNull(params.arbiterAgentId);
    const summary = asNonEmptyStringOrNull(params.summary);
    if (!arbiterAgentId) throw new TypeError("arbiterAgentId is required");
    if (!summary) throw new TypeError("summary is required");

    const evidenceRefs = Array.isArray(params.evidenceRefs) ? params.evidenceRefs.map((item) => String(item)) : [];
    const adminOverride = params.adminOverride && typeof params.adminOverride === "object" && !Array.isArray(params.adminOverride)
      ? params.adminOverride
      : null;
    const overrideEnabled = adminOverride?.enabled === true;

    const providedEnvelope =
      params.disputeOpenEnvelope && typeof params.disputeOpenEnvelope === "object" && !Array.isArray(params.disputeOpenEnvelope)
        ? params.disputeOpenEnvelope
        : null;
    const openedByAgentId =
      asNonEmptyStringOrNull(params.openedByAgentId) ?? asNonEmptyStringOrNull(providedEnvelope?.openedByAgentId);

    let disputeOpenEnvelope = providedEnvelope;
    if (!disputeOpenEnvelope && !overrideEnabled) {
      if (!openedByAgentId) throw new TypeError("openedByAgentId is required when disputeOpenEnvelope is not provided");
      disputeOpenEnvelope = this.buildDisputeOpenEnvelope({
        agreementHash,
        receiptHash,
        holdHash,
        openedByAgentId,
        signerKeyId: params.signerKeyId,
        signerPrivateKeyPem: params.signerPrivateKeyPem,
        signature: params.signature,
        caseId: params.caseId,
        envelopeId: params.envelopeId,
        reasonCode: params.reasonCode,
        nonce: params.nonce,
        openedAt: params.openedAt,
        tenantId: params.tenantId
      }).disputeOpenEnvelope;
    }

    return this.toolCallOpenArbitration(
      {
        agreementHash,
        receiptHash,
        holdHash,
        ...(openedByAgentId ? { openedByAgentId } : {}),
        ...(disputeOpenEnvelope ? { disputeOpenEnvelope } : {}),
        arbiterAgentId,
        summary,
        evidenceRefs,
        ...(adminOverride ? { adminOverride } : {})
      },
      opts
    );
  }

  buildDisputeOpenEnvelope(params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreementHash = assertSha256Hex(params.agreementHash, "agreementHash");
    const receiptHash = assertSha256Hex(params.receiptHash, "receiptHash");
    const holdHash = assertSha256Hex(params.holdHash, "holdHash");
    const openedByAgentId = asNonEmptyStringOrNull(params.openedByAgentId);
    if (!openedByAgentId) throw new TypeError("openedByAgentId is required");

    const caseId = asNonEmptyStringOrNull(params.caseId) ?? `arb_case_tc_${agreementHash}`;
    const envelopeId = asNonEmptyStringOrNull(params.envelopeId) ?? `dopen_tc_${agreementHash}`;
    const signerKeyId = asNonEmptyStringOrNull(params.signerKeyId);
    if (!signerKeyId) throw new TypeError("signerKeyId is required");
    const tenantId = asNonEmptyStringOrNull(params.tenantId) ?? this.tenantId;
    const openedAt = normalizeIsoDate(params.openedAt, { fallbackNow: true, name: "openedAt" });
    const reasonCode = assertReasonCode(params.reasonCode ?? "TOOL_CALL_DISPUTE", "reasonCode");
    const nonce = asNonEmptyStringOrNull(params.nonce) ?? `nonce_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;

    const core = canonicalize({
      schemaVersion: "DisputeOpenEnvelope.v1",
      artifactType: "DisputeOpenEnvelope.v1",
      artifactId: envelopeId,
      envelopeId,
      caseId,
      tenantId,
      agreementHash,
      receiptHash,
      holdHash,
      openedByAgentId,
      openedAt,
      reasonCode,
      nonce,
      signerKeyId
    });
    const envelopeHash = sha256HexUtf8(canonicalJsonStringify(core));
    let signature = asNonEmptyStringOrNull(params.signature);
    if (!signature) {
      const signerPrivateKeyPem = asNonEmptyStringOrNull(params.signerPrivateKeyPem);
      if (!signerPrivateKeyPem) throw new TypeError("signature or signerPrivateKeyPem is required");
      signature = nodeSign(null, Buffer.from(envelopeHash, "hex"), signerPrivateKeyPem).toString("base64");
    }
    const disputeOpenEnvelope = canonicalize({ ...core, envelopeHash, signature });
    return {
      disputeOpenEnvelope,
      envelopeHash,
      canonicalJson: canonicalJsonStringify(disputeOpenEnvelope)
    };
  }

  openRunDispute(runId, body = {}, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/dispute/open`, { ...opts, body });
  }

  closeRunDispute(runId, body = {}, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/dispute/close`, { ...opts, body });
  }

  submitRunDisputeEvidence(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    assertNonEmptyString(body?.evidenceRef, "body.evidenceRef");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/dispute/evidence`, { ...opts, body });
  }

  escalateRunDispute(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    assertNonEmptyString(body?.escalationLevel, "body.escalationLevel");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/dispute/escalate`, { ...opts, body });
  }

  async firstVerifiedRun(params = {}, opts = {}) {
    if (!params || typeof params !== "object") throw new TypeError("params must be an object");
    if (!params?.payeeAgent || typeof params.payeeAgent !== "object") throw new TypeError("params.payeeAgent is required");
    assertNonEmptyString(params.payeeAgent?.publicKeyPem, "params.payeeAgent.publicKeyPem");

    const stepPrefix = normalizePrefix(
      opts.idempotencyPrefix,
      `sdk_first_verified_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    );
    const requestPrefix = normalizePrefix(opts.requestIdPrefix, randomRequestId());
    const makeStepOpts = (step, extra = {}) => ({
      signal: opts.signal,
      requestId: `${requestPrefix}_${step}`,
      idempotencyKey: `${stepPrefix}_${step}`,
      ...extra
    });

    const payeeRegistration = await this.registerAgent(params.payeeAgent, makeStepOpts("register_payee"));
    const payeeAgentId = payeeRegistration?.body?.agentIdentity?.agentId;
    assertNonEmptyString(payeeAgentId, "payeeAgentId");

    let payerRegistration = null;
    let payerCredit = null;
    let payerAgentId = null;
    if (params.payerAgent) {
      if (typeof params.payerAgent !== "object") throw new TypeError("params.payerAgent must be an object");
      assertNonEmptyString(params.payerAgent?.publicKeyPem, "params.payerAgent.publicKeyPem");
      payerRegistration = await this.registerAgent(params.payerAgent, makeStepOpts("register_payer"));
      payerAgentId = payerRegistration?.body?.agentIdentity?.agentId ?? null;
      assertNonEmptyString(payerAgentId, "payerAgentId");
    }

    const settlementAmountCents = params?.settlement?.amountCents;
    const settlementCurrency = params?.settlement?.currency ?? "USD";
    if ((settlementAmountCents !== undefined || params?.settlement?.payerAgentId) && !payerAgentId && !params?.settlement?.payerAgentId) {
      throw new TypeError("params.payerAgent or params.settlement.payerAgentId is required when settlement is requested");
    }

    if (params.payerCredit && typeof params.payerCredit !== "object") throw new TypeError("params.payerCredit must be an object");
    const payerCreditAmountCents = params?.payerCredit?.amountCents;
    if (payerCreditAmountCents !== undefined && payerCreditAmountCents !== null) {
      if (!Number.isFinite(payerCreditAmountCents) || payerCreditAmountCents <= 0) {
        throw new TypeError("params.payerCredit.amountCents must be a positive number");
      }
      if (!payerAgentId) throw new TypeError("params.payerAgent is required when params.payerCredit is provided");
      payerCredit = await this.creditAgentWallet(
        payerAgentId,
        {
          amountCents: Number(payerCreditAmountCents),
          currency: params?.payerCredit?.currency ?? settlementCurrency
        },
        makeStepOpts("credit_payer_wallet")
      );
    }

    const runBody = { ...(params.run ?? {}) };
    const settlementPayerAgentId = params?.settlement?.payerAgentId ?? payerAgentId;
    if (settlementAmountCents !== undefined && settlementAmountCents !== null) {
      if (!Number.isFinite(settlementAmountCents) || settlementAmountCents <= 0) {
        throw new TypeError("params.settlement.amountCents must be a positive number");
      }
      if (!settlementPayerAgentId) {
        throw new TypeError("params.settlement.payerAgentId or params.payerAgent is required when params.settlement.amountCents is set");
      }
      runBody.settlement = {
        payerAgentId: settlementPayerAgentId,
        amountCents: Number(settlementAmountCents),
        currency: settlementCurrency,
        ...(params?.settlement?.disputeWindowDays !== undefined ? { disputeWindowDays: params.settlement.disputeWindowDays } : {})
      };
    }

    const runCreated = await this.createAgentRun(payeeAgentId, runBody, makeStepOpts("create_run"));
    const runId = runCreated?.body?.run?.runId;
    assertNonEmptyString(runId, "runId");
    let prevChainHash = runCreated?.body?.run?.lastChainHash;
    assertNonEmptyString(prevChainHash, "runCreated.body.run.lastChainHash");

    const actor = params.actor ?? { type: "agent", id: payeeAgentId };
    const runStarted = await this.appendAgentRunEvent(
      payeeAgentId,
      runId,
      { type: "RUN_STARTED", actor, payload: params.startedPayload ?? { startedBy: "sdk.firstVerifiedRun" } },
      makeStepOpts("run_started", { expectedPrevChainHash: prevChainHash })
    );
    prevChainHash = runStarted?.body?.run?.lastChainHash;
    assertNonEmptyString(prevChainHash, "runStarted.body.run.lastChainHash");

    const evidenceRef = typeof params.evidenceRef === "string" && params.evidenceRef.trim() !== ""
      ? params.evidenceRef.trim()
      : `evidence://${runId}/output.json`;
    const runEvidenceAdded = await this.appendAgentRunEvent(
      payeeAgentId,
      runId,
      { type: "EVIDENCE_ADDED", actor, payload: params.evidencePayload ?? { evidenceRef } },
      makeStepOpts("evidence_added", { expectedPrevChainHash: prevChainHash })
    );
    prevChainHash = runEvidenceAdded?.body?.run?.lastChainHash;
    assertNonEmptyString(prevChainHash, "runEvidenceAdded.body.run.lastChainHash");

    const completedPayload = {
      outputRef: typeof params.outputRef === "string" && params.outputRef.trim() !== "" ? params.outputRef.trim() : evidenceRef,
      ...(params.completedPayload ?? {})
    };
    if (params.completedMetrics && typeof params.completedMetrics === "object") completedPayload.metrics = params.completedMetrics;
    const runCompleted = await this.appendAgentRunEvent(
      payeeAgentId,
      runId,
      { type: "RUN_COMPLETED", actor, payload: completedPayload },
      makeStepOpts("run_completed", { expectedPrevChainHash: prevChainHash })
    );

    const run = await this.getAgentRun(payeeAgentId, runId, makeStepOpts("get_run"));
    const verification = await this.getRunVerification(runId, makeStepOpts("get_verification"));

    let settlement = null;
    if (runBody.settlement || runCreated?.body?.settlement || runCompleted?.body?.settlement) {
      settlement = await this.getRunSettlement(runId, makeStepOpts("get_settlement"));
    }

    return {
      ids: { runId, payeeAgentId, payerAgentId },
      payeeRegistration,
      payerRegistration,
      payerCredit,
      runCreated,
      runStarted,
      runEvidenceAdded,
      runCompleted,
      run,
      verification,
      settlement
    };
  }

  quoteJob(jobId, body, opts) {
    assertNonEmptyString(jobId, "jobId");
    if (!opts?.expectedPrevChainHash) throw new TypeError("expectedPrevChainHash is required for quoteJob");
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/quote`, { ...opts, body });
  }

  bookJob(jobId, body, opts) {
    assertNonEmptyString(jobId, "jobId");
    if (!opts?.expectedPrevChainHash) throw new TypeError("expectedPrevChainHash is required for bookJob");
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/book`, { ...opts, body });
  }

  appendJobEvent(jobId, body, opts) {
    assertNonEmptyString(jobId, "jobId");
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/events`, { ...opts, body });
  }

  opsStatus(opts) {
    return this.request("GET", "/ops/status", opts);
  }

  listPartyStatements(params, opts) {
    assertNonEmptyString(params?.period, "period");
    const qs = new URLSearchParams({ period: String(params.period) });
    if (params.partyId) qs.set("partyId", String(params.partyId));
    if (params.status) qs.set("status", String(params.status));
    return this.request("GET", `/ops/party-statements?${qs.toString()}`, opts);
  }

  getPartyStatement(partyId, period, opts) {
    assertNonEmptyString(partyId, "partyId");
    assertNonEmptyString(period, "period");
    return this.request("GET", `/ops/party-statements/${encodeURIComponent(partyId)}/${encodeURIComponent(period)}`, opts);
  }

  enqueuePayout(partyId, period, opts) {
    assertNonEmptyString(partyId, "partyId");
    assertNonEmptyString(period, "period");
    return this.request("POST", `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(period)}/enqueue`, opts);
  }

  requestMonthClose(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.month, "month");
    return this.request("POST", "/ops/month-close", { ...opts, body });
  }

  getTenantAnalytics(tenantId, params = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    const qs = new URLSearchParams();
    if (params.month) qs.set("month", String(params.month));
    if (params.bucket) qs.set("bucket", String(params.bucket));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/analytics${suffix}`, opts);
  }

  getTenantTrustGraph(tenantId, params = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    const qs = new URLSearchParams();
    if (params.month) qs.set("month", String(params.month));
    if (params.minRuns !== undefined && params.minRuns !== null) qs.set("minRuns", String(params.minRuns));
    if (params.maxEdges !== undefined && params.maxEdges !== null) qs.set("maxEdges", String(params.maxEdges));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph${suffix}`, opts);
  }

  listTenantTrustGraphSnapshots(tenantId, params = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    const qs = new URLSearchParams();
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph/snapshots${suffix}`, opts);
  }

  createTenantTrustGraphSnapshot(tenantId, body = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph/snapshots`, { ...opts, body });
  }

  diffTenantTrustGraph(tenantId, params = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    const qs = new URLSearchParams();
    if (params.baseMonth) qs.set("baseMonth", String(params.baseMonth));
    if (params.compareMonth) qs.set("compareMonth", String(params.compareMonth));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.minRuns !== undefined && params.minRuns !== null) qs.set("minRuns", String(params.minRuns));
    if (params.maxEdges !== undefined && params.maxEdges !== null) qs.set("maxEdges", String(params.maxEdges));
    if (params.includeUnchanged !== undefined && params.includeUnchanged !== null) qs.set("includeUnchanged", String(Boolean(params.includeUnchanged)));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph/diff${suffix}`, opts);
  }
}

class NooterraParityAdapterBase {
  constructor(client, { transport, maxAttempts = 3, retryStatusCodes, retryCodes, retryDelayMs = 0 } = {}) {
    if (!client || typeof client.request !== "function") throw new TypeError("client with request() is required");
    if (transport !== "http" && transport !== "mcp") throw new TypeError("transport must be http or mcp");
    this.client = client;
    this.transport = transport;
    this.maxAttempts = parseInteger(maxAttempts, 3, { min: 1 });
    this.retryStatusCodes = normalizeRetryStatusCodes(retryStatusCodes);
    this.retryCodes = normalizeRetryCodes(retryCodes);
    this.retryDelayMs = retryDelayMs;
  }

  isRetryable(error) {
    const status = Number(error?.nooterra?.status);
    const code = asNonEmptyStringOrNull(error?.nooterra?.code);
    if (!Number.isInteger(status) || status <= 0) return true;
    if (this.retryStatusCodes.has(status)) return true;
    if (code && this.retryCodes.has(code.toUpperCase())) return true;
    return false;
  }

  async invoke(operation, payload, opts = {}) {
    let resolvedOperation;
    try {
      resolvedOperation = resolveParityOperation(operation, { transport: this.transport });
    } catch (err) {
      throwParityValidation({
        code: PARITY_REASON_CODE.OPERATION_INVALID,
        message: err?.message ?? "operation is invalid",
        transport: this.transport,
        operationId: operation?.operationId
      });
    }
    const requestId = asNonEmptyStringOrNull(opts?.requestId) ?? randomRequestId();
    const idempotencyKey = asNonEmptyStringOrNull(opts?.idempotencyKey);
    const expectedPrevChainHash = asNonEmptyStringOrNull(opts?.expectedPrevChainHash);
    validateParityPayload(payload, resolvedOperation, {
      transport: this.transport,
      idempotencyKey,
      expectedPrevChainHash
    });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const rawResponse = await this.invokeOnce(resolvedOperation, payload, {
          requestId,
          idempotencyKey,
          expectedPrevChainHash,
          signal: opts?.signal
        });
        const responseHeaders = normalizeHeadersRecord(rawResponse?.headers);
        const requestIdFromResponse = asNonEmptyStringOrNull(rawResponse?.requestId) ?? asNonEmptyStringOrNull(responseHeaders["x-request-id"]);
        const status = Number(rawResponse?.status);
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          throw createParityError({
            status: 502,
            code: PARITY_REASON_CODE.RESPONSE_INVALID,
            message: "transport response missing valid status",
            requestId: requestIdFromResponse ?? requestId,
            idempotencyKey,
            transport: this.transport,
            operationId: resolvedOperation.operationId
          });
        }
        if (rawResponse?.ok === false || status >= 400) {
          throw createParityError({
            status,
            code: rawResponse?.code ?? PARITY_REASON_CODE.REQUEST_REJECTED,
            message: rawResponse?.message ?? `request failed (${status})`,
            details: rawResponse?.details,
            requestId: requestIdFromResponse ?? requestId,
            idempotencyKey,
            transport: this.transport,
            operationId: resolvedOperation.operationId
          });
        }
        return {
          ok: true,
          status,
          requestId: requestIdFromResponse ?? null,
          body: rawResponse?.body ?? null,
          headers: responseHeaders,
          transport: this.transport,
          operationId: resolvedOperation.operationId,
          idempotencyKey,
          attempts: attempt
        };
      } catch (err) {
        const parityError = coerceParityError(err, {
          attempt,
          requestId,
          idempotencyKey,
          transport: this.transport,
          operationId: resolvedOperation.operationId
        });
        const retryable = this.isRetryable(parityError);
        parityError.nooterra.retryable = retryable;
        parityError.nooterra.attempts = attempt;
        if (!retryable || attempt >= this.maxAttempts) throw parityError;
        await sleepMs(resolveRetryDelayMs(this.retryDelayMs, attempt));
      }
    }
    throw createParityError({
      status: 500,
      code: PARITY_REASON_CODE.REQUEST_REJECTED,
      message: "request failed",
      idempotencyKey,
      transport: this.transport,
      operationId: resolvedOperation.operationId
    });
  }

  // eslint-disable-next-line class-methods-use-this
  async invokeOnce() {
    throw new Error("invokeOnce() must be implemented");
  }
}

export class NooterraHttpParityAdapter extends NooterraParityAdapterBase {
  constructor(client, opts = {}) {
    super(client, { ...opts, transport: "http" });
  }

  async invokeOnce(operation, payload, { requestId, idempotencyKey, expectedPrevChainHash, signal }) {
    return this.client.request(operation.method, operation.path, {
      body: payload,
      requestId,
      idempotencyKey,
      expectedPrevChainHash,
      signal
    });
  }
}

export class NooterraMcpParityAdapter extends NooterraParityAdapterBase {
  constructor(client, opts = {}) {
    super(client, { ...opts, transport: "mcp" });
    this.callTool = opts?.callTool ?? null;
  }

  async invokeOnce(operation, payload, { requestId, idempotencyKey, expectedPrevChainHash, signal }) {
    if (typeof this.callTool !== "function") {
      throwParityValidation({
        code: PARITY_REASON_CODE.MCP_CALL_REQUIRED,
        message: "callTool function is required",
        transport: this.transport,
        operationId: operation.operationId,
        idempotencyKey
      });
    }
    const raw = await this.callTool(operation.toolName, {
      operationId: operation.operationId,
      payload,
      requestId,
      idempotencyKey,
      expectedPrevChainHash,
      signal,
      headers: {
        "x-request-id": requestId,
        ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        ...(expectedPrevChainHash ? { "x-proxy-expected-prev-chain-hash": expectedPrevChainHash } : {})
      }
    });
    if (!isPlainObject(raw)) {
      throw createParityError({
        status: 502,
        code: PARITY_REASON_CODE.RESPONSE_INVALID,
        message: "mcp response must be an object",
        requestId,
        idempotencyKey,
        transport: this.transport,
        operationId: operation.operationId
      });
    }
    const headers = normalizeHeadersRecord(raw.headers);
    const responseRequestId = asNonEmptyStringOrNull(raw.requestId) ?? asNonEmptyStringOrNull(headers["x-request-id"]) ?? requestId;
    const defaultStatus = raw.ok === false || raw.error !== undefined ? 500 : 200;
    const rawStatus = raw.status === undefined || raw.status === null ? defaultStatus : Number(raw.status);
    if (!Number.isInteger(rawStatus) || rawStatus < 100 || rawStatus > 599) {
      throw createParityError({
        status: 502,
        code: PARITY_REASON_CODE.RESPONSE_INVALID,
        message: "mcp response status must be a valid HTTP status integer",
        requestId: responseRequestId,
        idempotencyKey,
        transport: this.transport,
        operationId: operation.operationId
      });
    }
    if (raw.ok === false || raw.error !== undefined || rawStatus >= 400) {
      const errorBody = isPlainObject(raw.error) ? raw.error : {};
      throw createParityError({
        status: Number(errorBody.status) || rawStatus,
        code: raw.code ?? errorBody.code ?? PARITY_REASON_CODE.REQUEST_REJECTED,
        message: raw.message ?? errorBody.message ?? errorBody.error ?? `request failed (${rawStatus})`,
        details: raw.details ?? errorBody.details,
        requestId: responseRequestId,
        idempotencyKey,
        transport: this.transport,
        operationId: operation.operationId
      });
    }
    return {
      ok: true,
      status: rawStatus,
      requestId: responseRequestId,
      headers,
      body: raw.body ?? raw.result ?? raw.data ?? null
    };
  }
}
