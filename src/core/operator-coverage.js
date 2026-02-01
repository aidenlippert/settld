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

export function validateOperatorCoverageReservedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "operatorId", "startAt", "endAt", "reservationId", "zoneId"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.operatorId, "payload.operatorId");
  assertIsoDate(payload.startAt, "payload.startAt");
  assertIsoDate(payload.endAt, "payload.endAt");
  if (Date.parse(payload.startAt) >= Date.parse(payload.endAt)) throw new TypeError("payload.startAt must be before payload.endAt");
  assertNonEmptyString(payload.reservationId, "payload.reservationId");
  if (payload.zoneId !== undefined && payload.zoneId !== null) assertNonEmptyString(payload.zoneId, "payload.zoneId");
  return payload;
}

export function validateOperatorCoverageReleasedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "reservationId", "releasedAt", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.reservationId, "payload.reservationId");
  assertIsoDate(payload.releasedAt, "payload.releasedAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  return payload;
}

