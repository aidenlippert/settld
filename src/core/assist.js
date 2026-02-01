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

const ASSIST_PRIORITIES = new Set(["LOW", "NORMAL", "HIGH", "CRITICAL"]);

export function validateAssistRequestedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "robotId", "requestedAt", "reason", "priority"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.requestedAt, "payload.requestedAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  if (payload.priority !== undefined && payload.priority !== null) {
    assertNonEmptyString(payload.priority, "payload.priority");
    if (!ASSIST_PRIORITIES.has(payload.priority)) throw new TypeError("payload.priority is not supported");
  }
  return payload;
}

export function validateAssistQueuedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "queueId", "queuedAt", "reason", "priority"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.queueId, "payload.queueId");
  assertIsoDate(payload.queuedAt, "payload.queuedAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  if (payload.priority !== undefined && payload.priority !== null) {
    assertNonEmptyString(payload.priority, "payload.priority");
    if (!ASSIST_PRIORITIES.has(payload.priority)) throw new TypeError("payload.priority is not supported");
  }
  return payload;
}

export function validateAssistAssignedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "queueId", "operatorId", "assignedAt"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.queueId, "payload.queueId");
  assertNonEmptyString(payload.operatorId, "payload.operatorId");
  assertIsoDate(payload.assignedAt, "payload.assignedAt");
  return payload;
}

export function validateAssistAcceptedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "queueId", "operatorId", "acceptedAt"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.queueId, "payload.queueId");
  assertNonEmptyString(payload.operatorId, "payload.operatorId");
  assertIsoDate(payload.acceptedAt, "payload.acceptedAt");
  return payload;
}

export function validateAssistDeclinedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "queueId", "operatorId", "declinedAt", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.queueId, "payload.queueId");
  assertNonEmptyString(payload.operatorId, "payload.operatorId");
  assertIsoDate(payload.declinedAt, "payload.declinedAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  return payload;
}

export function validateAssistTimeoutPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "queueId", "timedOutAt", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.queueId, "payload.queueId");
  assertIsoDate(payload.timedOutAt, "payload.timedOutAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  return payload;
}

