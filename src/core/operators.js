function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function validateOperatorRegisteredPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["operatorId", "tenantId", "name", "signerKeyId"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.operatorId, "payload.operatorId");
  if (payload.tenantId !== undefined && payload.tenantId !== null) assertNonEmptyString(payload.tenantId, "payload.tenantId");
  if (payload.name !== undefined && payload.name !== null) assertNonEmptyString(payload.name, "payload.name");
  if (payload.signerKeyId !== undefined && payload.signerKeyId !== null) assertNonEmptyString(payload.signerKeyId, "payload.signerKeyId");
  return payload;
}

export function validateOperatorShiftOpenedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["operatorId", "shiftId", "zoneId", "maxConcurrentJobs"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.operatorId, "payload.operatorId");
  if (payload.shiftId !== undefined && payload.shiftId !== null) assertNonEmptyString(payload.shiftId, "payload.shiftId");
  if (payload.zoneId !== undefined && payload.zoneId !== null) assertNonEmptyString(payload.zoneId, "payload.zoneId");
  if (payload.maxConcurrentJobs !== undefined && payload.maxConcurrentJobs !== null) {
    if (!Number.isSafeInteger(payload.maxConcurrentJobs) || payload.maxConcurrentJobs <= 0) {
      throw new TypeError("payload.maxConcurrentJobs must be a positive safe integer");
    }
  }
  return payload;
}

export function validateOperatorShiftClosedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["operatorId", "shiftId", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.operatorId, "payload.operatorId");
  if (payload.shiftId !== undefined && payload.shiftId !== null) assertNonEmptyString(payload.shiftId, "payload.shiftId");
  if (payload.reason !== undefined) assertNonEmptyString(payload.reason, "payload.reason");
  return payload;
}
