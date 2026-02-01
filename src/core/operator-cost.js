export const OPERATOR_COST_BASIS = Object.freeze({
  SHIFT_RATE: "SHIFT_RATE",
  CONTRACT_RATE: "CONTRACT_RATE",
  BLENDED: "BLENDED"
});

const COST_BASIS = new Set(Object.values(OPERATOR_COST_BASIS));

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertSafeInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

export function computeOperatorCostCents({ assistSeconds, rateCentsPerMinute }) {
  assertSafeInt(assistSeconds, "assistSeconds");
  if (assistSeconds < 0) throw new TypeError("assistSeconds must be >= 0");
  assertSafeInt(rateCentsPerMinute, "rateCentsPerMinute");
  if (rateCentsPerMinute < 0) throw new TypeError("rateCentsPerMinute must be >= 0");

  const billableMinutes = Math.ceil(assistSeconds / 60);
  return billableMinutes * rateCentsPerMinute;
}

export function validateOperatorCostRecordedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set([
    "jobId",
    "zoneId",
    "operatorId",
    "assistSeconds",
    "rateCentsPerMinute",
    "costCents",
    "currency",
    "basis",
    "settledEventId"
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  if (payload.zoneId !== undefined && payload.zoneId !== null) assertNonEmptyString(payload.zoneId, "payload.zoneId");
  if (payload.operatorId !== undefined && payload.operatorId !== null) assertNonEmptyString(payload.operatorId, "payload.operatorId");

  assertSafeInt(payload.assistSeconds, "payload.assistSeconds");
  if (payload.assistSeconds < 0) throw new TypeError("payload.assistSeconds must be >= 0");
  assertSafeInt(payload.rateCentsPerMinute, "payload.rateCentsPerMinute");
  if (payload.rateCentsPerMinute < 0) throw new TypeError("payload.rateCentsPerMinute must be >= 0");
  assertSafeInt(payload.costCents, "payload.costCents");
  if (payload.costCents < 0) throw new TypeError("payload.costCents must be >= 0");

  assertNonEmptyString(payload.currency, "payload.currency");
  if (payload.currency !== "USD") throw new TypeError("payload.currency is not supported");
  assertNonEmptyString(payload.basis, "payload.basis");
  if (!COST_BASIS.has(payload.basis)) throw new TypeError("payload.basis is not supported");

  if (payload.settledEventId !== undefined && payload.settledEventId !== null) {
    assertNonEmptyString(payload.settledEventId, "payload.settledEventId");
  }

  const expected = computeOperatorCostCents({
    assistSeconds: payload.assistSeconds,
    rateCentsPerMinute: payload.rateCentsPerMinute
  });
  if (payload.costCents !== expected) throw new TypeError("payload.costCents must match deterministic operator cost formula");

  return payload;
}

