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

function assertSafeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
}

function assertAvailabilityWindow(window, name) {
  assertPlainObject(window, name);
  const allowed = new Set(["startAt", "endAt"]);
  for (const key of Object.keys(window)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field: ${key}`);
  }
  assertIsoDate(window.startAt, `${name}.startAt`);
  assertIsoDate(window.endAt, `${name}.endAt`);
  const start = Date.parse(window.startAt);
  const end = Date.parse(window.endAt);
  if (start >= end) throw new TypeError(`${name}.startAt must be before endAt`);
}

export function validateRobotRegisteredPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set([
    "robotId",
    "tenantId",
    "ownerId",
    "capabilities",
    "trustScore",
    "signerKeyId",
    "name",
    "homeZoneId",
    "currentZoneId"
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.robotId, "payload.robotId");
  if (payload.tenantId !== undefined && payload.tenantId !== null) assertNonEmptyString(payload.tenantId, "payload.tenantId");
  if (payload.ownerId !== undefined && payload.ownerId !== null) assertNonEmptyString(payload.ownerId, "payload.ownerId");
  if (payload.capabilities !== undefined) assertPlainObject(payload.capabilities, "payload.capabilities");
  if (payload.trustScore !== undefined) {
    assertSafeNumber(payload.trustScore, "payload.trustScore");
    if (payload.trustScore < 0 || payload.trustScore > 1) throw new TypeError("payload.trustScore must be within 0..1");
  }
  if (payload.signerKeyId !== undefined && payload.signerKeyId !== null) assertNonEmptyString(payload.signerKeyId, "payload.signerKeyId");
  if (payload.name !== undefined && payload.name !== null) assertNonEmptyString(payload.name, "payload.name");
  if (payload.homeZoneId !== undefined && payload.homeZoneId !== null) assertNonEmptyString(payload.homeZoneId, "payload.homeZoneId");
  if (payload.currentZoneId !== undefined && payload.currentZoneId !== null) assertNonEmptyString(payload.currentZoneId, "payload.currentZoneId");

  return payload;
}

export function validateRobotHeartbeatPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["batteryPct", "status", "location", "errorCodes", "selfCheckStatus", "healthScore"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  if (payload.batteryPct !== undefined) {
    assertSafeNumber(payload.batteryPct, "payload.batteryPct");
    if (payload.batteryPct < 0 || payload.batteryPct > 1) throw new TypeError("payload.batteryPct must be within 0..1");
  }
  if (payload.status !== undefined) assertNonEmptyString(payload.status, "payload.status");
  if (payload.location !== undefined) assertPlainObject(payload.location, "payload.location");
  if (payload.errorCodes !== undefined && payload.errorCodes !== null) {
    if (!Array.isArray(payload.errorCodes)) throw new TypeError("payload.errorCodes must be an array");
    for (const c of payload.errorCodes) assertNonEmptyString(c, "payload.errorCodes[]");
  }
  if (payload.selfCheckStatus !== undefined && payload.selfCheckStatus !== null) {
    assertNonEmptyString(payload.selfCheckStatus, "payload.selfCheckStatus");
  }
  if (payload.healthScore !== undefined && payload.healthScore !== null) {
    if (!Number.isSafeInteger(payload.healthScore)) throw new TypeError("payload.healthScore must be a safe integer");
    if (payload.healthScore < 0 || payload.healthScore > 100) throw new TypeError("payload.healthScore must be within 0..100");
  }
  return payload;
}

export function validateRobotAvailabilitySetPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["robotId", "availability", "timezone"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.robotId, "payload.robotId");

  if (!Array.isArray(payload.availability) || payload.availability.length === 0) {
    throw new TypeError("payload.availability must be a non-empty array");
  }
  for (let i = 0; i < payload.availability.length; i += 1) {
    assertAvailabilityWindow(payload.availability[i], `payload.availability[${i}]`);
  }

  // Require windows to be non-overlapping to keep dispatch deterministic.
  const sorted = payload.availability
    .map((w) => ({ ...w, start: Date.parse(w.startAt), end: Date.parse(w.endAt) }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end) throw new TypeError("payload.availability windows must not overlap");
  }

  if (payload.timezone !== undefined) assertNonEmptyString(payload.timezone, "payload.timezone");
  return payload;
}

export function validateRobotStatusChangedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["robotId", "status", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertNonEmptyString(payload.status, "payload.status");
  if (payload.reason !== undefined) assertNonEmptyString(payload.reason, "payload.reason");
  return payload;
}

export function windowsOverlap(a, b) {
  const aStart = Date.parse(a.startAt);
  const aEnd = Date.parse(a.endAt);
  const bStart = Date.parse(b.startAt);
  const bEnd = Date.parse(b.endAt);
  return Number.isFinite(aStart) && Number.isFinite(aEnd) && Number.isFinite(bStart) && Number.isFinite(bEnd) && aStart < bEnd && bStart < aEnd;
}

export function robotIsAvailableForWindow(robot, window) {
  if (!robot) return false;
  if (robot.status && robot.status !== "active") return false;
  if (!window?.startAt || !window?.endAt) return false;
  const start = Date.parse(window.startAt);
  const end = Date.parse(window.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return false;

  const availability = Array.isArray(robot.availability) ? robot.availability : [];
  return availability.some((w) => Date.parse(w.startAt) <= start && Date.parse(w.endAt) >= end);
}
