export const ROBOT_UNHEALTHY_REASON = Object.freeze({
  BATTERY_LOW: "BATTERY_LOW",
  MOTOR_FAULT: "MOTOR_FAULT",
  SENSOR_FAILURE: "SENSOR_FAILURE",
  FALL_DETECTED: "FALL_DETECTED",
  UNKNOWN: "UNKNOWN"
});

export const ROBOT_QUARANTINE_REASON = Object.freeze({
  MANUAL: "MANUAL",
  INCIDENT: "INCIDENT",
  REPEATED_STALLS: "REPEATED_STALLS",
  HEALTH_UNHEALTHY: "HEALTH_UNHEALTHY"
});

const UNHEALTHY_REASONS = new Set(Object.values(ROBOT_UNHEALTHY_REASON));
const QUARANTINE_REASONS = new Set(Object.values(ROBOT_QUARANTINE_REASON));

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

export function validateRobotUnhealthyPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["robotId", "detectedAt", "reason", "details"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.detectedAt, "payload.detectedAt");
  assertNonEmptyString(payload.reason, "payload.reason");
  if (!UNHEALTHY_REASONS.has(payload.reason)) throw new TypeError("payload.reason is not supported");
  if (payload.details !== undefined && payload.details !== null) assertPlainObject(payload.details, "payload.details");
  return payload;
}

export function validateRobotQuarantinedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["robotId", "quarantinedAt", "reason", "until", "manualClearRequired", "jobId", "incidentId", "notes"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.quarantinedAt, "payload.quarantinedAt");
  assertNonEmptyString(payload.reason, "payload.reason");
  if (!QUARANTINE_REASONS.has(payload.reason)) throw new TypeError("payload.reason is not supported");
  if (payload.until !== undefined && payload.until !== null) assertIsoDate(payload.until, "payload.until");
  if (payload.manualClearRequired !== undefined && typeof payload.manualClearRequired !== "boolean") {
    throw new TypeError("payload.manualClearRequired must be a boolean");
  }
  if (payload.jobId !== undefined && payload.jobId !== null) assertNonEmptyString(payload.jobId, "payload.jobId");
  if (payload.incidentId !== undefined && payload.incidentId !== null) assertNonEmptyString(payload.incidentId, "payload.incidentId");
  if (payload.notes !== undefined && payload.notes !== null) assertNonEmptyString(payload.notes, "payload.notes");
  return payload;
}

export function validateRobotQuarantineClearedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["robotId", "clearedAt", "reason", "maintenanceId", "notes"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.clearedAt, "payload.clearedAt");
  assertNonEmptyString(payload.reason, "payload.reason");
  if (payload.maintenanceId !== undefined && payload.maintenanceId !== null) assertNonEmptyString(payload.maintenanceId, "payload.maintenanceId");
  if (payload.notes !== undefined && payload.notes !== null) assertNonEmptyString(payload.notes, "payload.notes");
  return payload;
}

export function validateMaintenanceRequestedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["robotId", "maintenanceId", "requestedAt", "reason", "notes"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertNonEmptyString(payload.maintenanceId, "payload.maintenanceId");
  assertIsoDate(payload.requestedAt, "payload.requestedAt");
  assertNonEmptyString(payload.reason, "payload.reason");
  if (payload.notes !== undefined && payload.notes !== null) assertNonEmptyString(payload.notes, "payload.notes");
  return payload;
}

export function validateMaintenanceCompletedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["robotId", "maintenanceId", "completedAt", "checklist", "notes"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertNonEmptyString(payload.maintenanceId, "payload.maintenanceId");
  assertIsoDate(payload.completedAt, "payload.completedAt");
  if (payload.checklist !== undefined && payload.checklist !== null) assertPlainObject(payload.checklist, "payload.checklist");
  if (payload.notes !== undefined && payload.notes !== null) assertNonEmptyString(payload.notes, "payload.notes");
  return payload;
}

