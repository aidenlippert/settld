export class RequestBodyError extends Error {
  constructor(statusCode, message, { cause } = {}) {
    super(message);
    this.name = "RequestBodyError";
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

function inferReasonCode({ statusCode, message, details }) {
  const msg = typeof message === "string" ? message.trim() : "";
  const lower = msg.toLowerCase();
  const detailsMessage =
    details && typeof details === "object" && !Array.isArray(details) && typeof details.message === "string" ? details.message : null;

  if (statusCode === 429 || lower === "rate limit exceeded") return "RATE_LIMITED";
  if (statusCode === 403 && lower === "forbidden") return "FORBIDDEN";
  if (statusCode === 404 && (lower === "not found" || lower.endsWith(" not found"))) return "NOT_FOUND";
  if (statusCode === 409 && lower.startsWith("idempotency key conflict")) return "IDEMPOTENCY_CONFLICT";
  if (lower === "request body too large") return "BODY_TOO_LARGE";
  if (lower === "invalid json body") return "SCHEMA_INVALID";
  if (lower === "json body is required") return "SCHEMA_INVALID";
  if (lower.startsWith("invalid ") || lower.endsWith(" is required") || lower.includes(" are required") || lower.startsWith("missing required")) {
    return "SCHEMA_INVALID";
  }
  if (lower === "event.at is too far in the future") return "FUTURE_TIMESTAMP";
  if (lower === "too many events in request") return "INGEST_MAX_EVENTS_EXCEEDED";
  if (lower === "missing precondition") return "MISSING_PRECONDITION";

  if ((lower === "invalid payload" || lower === "event rejected") && typeof detailsMessage === "string") {
    const m = detailsMessage.match(/\((URL_[A-Z0-9_]+)\)/);
    if (m && m[1]) return m[1];
  }

  if (lower === "event chain verification failed") {
    const err =
      details && typeof details === "object" && !Array.isArray(details) ? (details.error ?? details.message ?? null) : details;
    const text = typeof err === "string" ? err.toLowerCase() : "";
    if (text.includes("signature invalid")) return "SIG_INVALID";
    if (text.includes("unknown signerkeyid")) return "SIGNER_UNKNOWN";
    if (text.includes("prevchainhash mismatch") || text.includes("payloadhash mismatch") || text.includes("chainhash mismatch")) {
      return "CHAIN_BREAK";
    }
    return "CHAIN_BREAK";
  }

  if (lower === "signature policy rejected") {
    const text = typeof detailsMessage === "string" ? detailsMessage.toLowerCase() : "";
    if (text.includes("unknown signer key")) return "SIGNER_UNKNOWN";
    if (text.includes("signer key is not active") || text.includes("revoked")) return "SIGNER_REVOKED";
    if (text.includes("purpose mismatch")) return "SIGNER_PURPOSE_MISMATCH";
    return "SIGNATURE_POLICY";
  }

  if (lower === "job transition rejected") return "TRANSITION_ILLEGAL";
  if (lower === "invalid event envelope" || lower === "invalid actor" || lower === "invalid payload") return "SCHEMA_INVALID";
  if (lower === "event rejected") return "EVENT_REJECTED";

  return "UNKNOWN";
}

function defaultMaxBodyBytes() {
  const raw = typeof process !== "undefined" ? process.env.PROXY_MAX_BODY_BYTES : null;
  if (!raw || String(raw).trim() === "") return 1_000_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError("PROXY_MAX_BODY_BYTES must be a positive number");
  return Math.floor(parsed);
}

export async function readJsonBody(req, { maxBytes = defaultMaxBodyBytes() } = {}) {
  const contentType = req.headers["content-type"] ?? "";
  const isJson = contentType.includes("application/json") || contentType.includes("+json");
  if (!isJson) return null;

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive safe integer");

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      throw new RequestBodyError(413, "request body too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new RequestBodyError(400, "invalid JSON body", { cause: err });
  }
}

export function sendJson(res, statusCode, body) {
  const payload = body === undefined ? "" : JSON.stringify(body, null, 2);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(payload);
}

export function sendText(res, statusCode, body, { contentType = "text/plain; charset=utf-8" } = {}) {
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  res.end(body ?? "");
}

export function sendError(res, statusCode, message, details, { code = null } = {}) {
  const reasonCode = code ?? inferReasonCode({ statusCode, message, details });
  try {
    res.__settldErrorCode = reasonCode;
    res.__settldErrorMessage = message;
  } catch {
    // ignore
  }
  sendJson(res, statusCode, { error: message, code: reasonCode, details });
}
