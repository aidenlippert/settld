import { parseYearMonth } from "./statements.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "./tenancy.js";

export const FINANCE_STREAM_ID = "finance";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new TypeError(`${name} must be an ISO date string`);
  return value;
}

function assertSafeCents(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer (cents)`);
}

export function validateInsurerReimbursementRecordedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["tenantId", "reimbursementId", "insurerId", "amountCents", "currency", "month", "recordedAt", "reference"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  const tenantId = normalizeTenantId(payload.tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(payload.reimbursementId, "payload.reimbursementId");
  assertNonEmptyString(payload.insurerId, "payload.insurerId");
  assertSafeCents(payload.amountCents, "payload.amountCents");
  if (payload.amountCents <= 0) throw new TypeError("payload.amountCents must be positive");
  assertNonEmptyString(payload.currency, "payload.currency");
  if (payload.currency !== "USD") throw new TypeError("payload.currency is not supported");

  assertNonEmptyString(payload.month, "payload.month");
  const period = parseYearMonth(payload.month);

  const recordedAt = assertIsoDate(payload.recordedAt, "payload.recordedAt");
  const t = Date.parse(recordedAt);
  const startMs = Date.parse(period.startAt);
  const endMs = Date.parse(period.endAt);
  if (Number.isFinite(t) && Number.isFinite(startMs) && Number.isFinite(endMs) && (t < startMs || t >= endMs)) {
    throw new TypeError("payload.recordedAt must fall within payload.month");
  }

  if (payload.reference !== undefined && payload.reference !== null) assertNonEmptyString(payload.reference, "payload.reference");

  return { ...payload, tenantId, recordedAt };
}

