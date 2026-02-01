const CANCEL_REASONS = new Set(["CUSTOMER_REQUEST", "OPS", "NO_SUPPLY", "ROBOT_FAILURE", "ACCESS_FAILURE", "SYSTEM"]);

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new TypeError(`${name} must be an ISO date string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function validateJobCancelledPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "cancelledAt", "reason", "requestedBy"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertIsoDate(payload.cancelledAt, "payload.cancelledAt");
  assertNonEmptyString(payload.reason, "payload.reason");
  if (!CANCEL_REASONS.has(payload.reason)) throw new TypeError("payload.reason is not supported");
  if (payload.requestedBy !== undefined && payload.requestedBy !== null) assertNonEmptyString(payload.requestedBy, "payload.requestedBy");
  return payload;
}

