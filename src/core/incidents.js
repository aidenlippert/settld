export const INCIDENT_TYPE = Object.freeze({
  DAMAGE_PROPERTY: "DAMAGE_PROPERTY",
  PRIVACY_VIOLATION: "PRIVACY_VIOLATION",
  SAFETY_NEAR_MISS: "SAFETY_NEAR_MISS",
  FAILURE_TO_COMPLETE: "FAILURE_TO_COMPLETE",
  BLOCKED_ZONE: "BLOCKED_ZONE",
  ACCESS_FAILURE: "ACCESS_FAILURE",
  THEFT_ALLEGATION: "THEFT_ALLEGATION",
  ROBOT_STUCK: "ROBOT_STUCK",
  UNEXPECTED_HUMAN_CONTACT: "UNEXPECTED_HUMAN_CONTACT"
});

const INCIDENT_TYPES = new Set(Object.values(INCIDENT_TYPE));

const REPORTED_BY = new Set(["customer", "operator", "ops", "system"]);

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertSeverity(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new TypeError(`${name} must be an integer in range 1..5`);
  }
}

export function validateIncidentReportedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "incidentId", "type", "severity", "summary", "description", "reportedBy", "zoneId"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.incidentId, "payload.incidentId");
  assertNonEmptyString(payload.type, "payload.type");
  if (!INCIDENT_TYPES.has(payload.type)) throw new TypeError("payload.type is not a supported incident type");
  assertSeverity(payload.severity, "payload.severity");
  assertNonEmptyString(payload.summary, "payload.summary");
  if (payload.description !== undefined) assertNonEmptyString(payload.description, "payload.description");
  if (payload.zoneId !== undefined && payload.zoneId !== null) assertNonEmptyString(payload.zoneId, "payload.zoneId");
  if (payload.reportedBy !== undefined) {
    assertNonEmptyString(payload.reportedBy, "payload.reportedBy");
    if (!REPORTED_BY.has(payload.reportedBy)) throw new TypeError("payload.reportedBy is not supported");
  }

  return payload;
}

export function validateIncidentDetectedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "incidentId", "type", "severity", "summary", "description", "signals", "zoneId"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.incidentId, "payload.incidentId");
  assertNonEmptyString(payload.type, "payload.type");
  if (!INCIDENT_TYPES.has(payload.type)) throw new TypeError("payload.type is not a supported incident type");
  assertSeverity(payload.severity, "payload.severity");
  assertNonEmptyString(payload.summary, "payload.summary");
  if (payload.description !== undefined) assertNonEmptyString(payload.description, "payload.description");
  if (payload.zoneId !== undefined && payload.zoneId !== null) assertNonEmptyString(payload.zoneId, "payload.zoneId");
  if (payload.signals !== undefined) assertPlainObject(payload.signals, "payload.signals");

  return payload;
}
