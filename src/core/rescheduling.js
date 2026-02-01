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
}

function validateWindow(window, name) {
  assertPlainObject(window, name);
  const allowed = new Set(["startAt", "endAt"]);
  for (const key of Object.keys(window)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field: ${key}`);
  }
  assertIsoDate(window.startAt, `${name}.startAt`);
  assertIsoDate(window.endAt, `${name}.endAt`);
  if (Date.parse(window.startAt) >= Date.parse(window.endAt)) throw new TypeError(`${name}.startAt must be before endAt`);
}

const RESCHEDULE_REASONS = new Set(["CUSTOMER_REQUEST", "NO_SUPPLY", "ROBOT_FAILURE", "OPS"]);

export function validateJobRescheduledPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "oldWindow", "newWindow", "reason", "requestedBy", "requiresRequote", "quoteRef"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  validateWindow(payload.oldWindow, "payload.oldWindow");
  validateWindow(payload.newWindow, "payload.newWindow");
  assertNonEmptyString(payload.reason, "payload.reason");
  if (!RESCHEDULE_REASONS.has(payload.reason)) throw new TypeError("payload.reason is not supported");

  if (payload.requestedBy !== undefined && payload.requestedBy !== null) assertNonEmptyString(payload.requestedBy, "payload.requestedBy");
  if (payload.requiresRequote !== undefined && typeof payload.requiresRequote !== "boolean") {
    throw new TypeError("payload.requiresRequote must be a boolean");
  }
  if (payload.quoteRef !== undefined && payload.quoteRef !== null) assertNonEmptyString(payload.quoteRef, "payload.quoteRef");

  return payload;
}

