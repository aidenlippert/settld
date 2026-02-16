import { sha256Hex } from "./crypto.js";

export const CIRCLE_RESERVE_STATUS = Object.freeze({
  RESERVED: "reserved",
  VOIDED: "voided"
});

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return String(value).trim();
}

function normalizePositiveSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function normalizeMode(value) {
  const normalized = String(value ?? "stub").trim().toLowerCase();
  if (normalized === "stub" || normalized === "sandbox" || normalized === "test") return "stub";
  if (normalized === "fail") return "fail";
  throw new TypeError("mode must be stub|fail");
}

export function createCircleReserveAdapter({ mode = "stub", now = () => new Date().toISOString() } = {}) {
  const normalizedMode = normalizeMode(mode);
  const nowIso = () => {
    const value = typeof now === "function" ? now() : new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new TypeError("now() must return an ISO date string");
    return value;
  };

  async function reserve({
    tenantId,
    gateId,
    amountCents,
    currency = "USD",
    idempotencyKey = null,
    payerAgentId = null,
    payeeAgentId = null
  } = {}) {
    const normalizedTenantId = assertNonEmptyString(tenantId, "tenantId");
    const normalizedGateId = assertNonEmptyString(gateId, "gateId");
    const normalizedAmountCents = normalizePositiveSafeInt(amountCents, "amountCents");
    const normalizedCurrency = assertNonEmptyString(String(currency).toUpperCase(), "currency");
    const normalizedIdempotencyKey =
      idempotencyKey === null || idempotencyKey === undefined || String(idempotencyKey).trim() === ""
        ? normalizedGateId
        : String(idempotencyKey).trim();

    if (normalizedMode === "fail") {
      const err = new Error("circle reserve unavailable");
      err.code = "CIRCLE_RESERVE_UNAVAILABLE";
      throw err;
    }

    const reserveId = `circle_transfer_${sha256Hex(
      `${normalizedTenantId}\n${normalizedGateId}\n${normalizedAmountCents}\n${normalizedCurrency}\n${normalizedIdempotencyKey}\n${String(
        payerAgentId ?? ""
      )}\n${String(payeeAgentId ?? "")}`
    ).slice(0, 32)}`;
    return {
      reserveId,
      status: CIRCLE_RESERVE_STATUS.RESERVED,
      adapter: "circle",
      mode: "transfer",
      amountCents: normalizedAmountCents,
      currency: normalizedCurrency,
      createdAt: nowIso(),
      metadata: {
        idempotencyKey: normalizedIdempotencyKey
      }
    };
  }

  async function voidReserve({ reserveId } = {}) {
    const normalizedReserveId = assertNonEmptyString(reserveId, "reserveId");
    return {
      reserveId: normalizedReserveId,
      status: CIRCLE_RESERVE_STATUS.VOIDED,
      voidedAt: nowIso()
    };
  }

  return {
    providerId: "circle",
    mode: normalizedMode,
    reserve,
    void: voidReserve
  };
}
