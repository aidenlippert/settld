import { normalizeForCanonicalJson } from "./canonical-json.js";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return String(value).trim();
}

function normalizeCurrency(value, name) {
  const raw = typeof value === "string" && value.trim() !== "" ? value : "USD";
  const out = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(out)) throw new TypeError(`${name} must match ^[A-Z][A-Z0-9_]{2,11}$`);
  return out;
}

function normalizeNonNegativeSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

function normalizePositiveSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function parseKeyValueHeader(text) {
  const out = {};
  for (const part of String(text ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

export function buildX402SettlementTerms({
  amountCents,
  currency = "USD",
  disputeWindowDays = 0,
  disputeWindowMs = null,
  holdbackBps = 0,
  evidenceRequirements = null,
  slaPolicy = null
} = {}) {
  const normalizedDisputeWindowMs =
    disputeWindowMs === null || disputeWindowMs === undefined ? null : normalizeNonNegativeSafeInt(disputeWindowMs, "disputeWindowMs");
  const normalizedDisputeWindowDays =
    normalizedDisputeWindowMs !== null ? Math.ceil(normalizedDisputeWindowMs / 86_400_000) : normalizeNonNegativeSafeInt(disputeWindowDays, "disputeWindowDays");
  const normalizedHoldbackBps = normalizeNonNegativeSafeInt(holdbackBps, "holdbackBps");
  if (normalizedHoldbackBps > 10_000) throw new TypeError("holdbackBps must be within 0..10000");
  const terms = {
    amountCents: normalizePositiveSafeInt(amountCents, "amountCents"),
    currency: normalizeCurrency(currency, "currency"),
    disputeWindowDays: normalizedDisputeWindowDays,
    disputeWindowMs: normalizedDisputeWindowMs,
    holdbackBps: normalizedHoldbackBps,
    evidenceRequirements: evidenceRequirements && typeof evidenceRequirements === "object" ? evidenceRequirements : null,
    slaPolicy: slaPolicy && typeof slaPolicy === "object" ? slaPolicy : null
  };
  return normalizeForCanonicalJson(terms, { path: "$" });
}

// Best-effort parsing of upstream x402-style 402 metadata.
// This does not attempt to be the x402 spec; it normalizes common "key=value; ..." or JSON payloads.
export function parseX402PaymentRequired(response402Headers) {
  if (response402Headers === null || response402Headers === undefined) return { ok: false, error: "missing headers" };

  const headerValue = (() => {
    if (typeof response402Headers === "string") return response402Headers;
    if (response402Headers && typeof response402Headers === "object") {
      const raw =
        response402Headers["x-payment-required"] ??
        response402Headers["X-Payment-Required"] ??
        response402Headers["payment-required"] ??
        response402Headers["Payment-Required"] ??
        null;
      return raw === null || raw === undefined ? "" : String(Array.isArray(raw) ? raw[0] : raw);
    }
    return "";
  })();

  const text = String(headerValue ?? "").trim();
  if (!text) return { ok: false, error: "missing x-payment-required" };

  // JSON payload case.
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "invalid json header" };
      return { ok: true, raw: text, fields: normalizeForCanonicalJson(parsed, { path: "$" }) };
    } catch (err) {
      return { ok: false, error: "invalid json header", message: err?.message ?? String(err ?? "") };
    }
  }

  const fields = parseKeyValueHeader(text);
  return { ok: true, raw: text, fields: normalizeForCanonicalJson(fields, { path: "$" }) };
}

// Placeholder: the "gate" middleware wiring is environment-specific (proxy framework, upstream fetch, etc.).
// Keep it as an explicit adapter surface rather than baking a single HTTP stack into the kernel.
export function createX402GateMiddleware() {
  throw new Error("createX402GateMiddleware is not implemented in this repo (use API endpoints or build an adapter)");
}
