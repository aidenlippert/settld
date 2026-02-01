const ACCESS_METHODS = new Set(["SMART_LOCK_CODE", "BUILDING_CONCIERGE", "ON_SITE_OWNER", "DOCKED_IN_BUILDING"]);

const FORBIDDEN_KEY_RE = /(pass(word|code)?|pin|secret|token|lockcode|accesscode|code)$/i;

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

function assertStringArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  for (const item of value) assertNonEmptyString(item, `${name}[]`);
}

function findForbiddenKey(value, path = "") {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY_RE.test(key)) return path ? `${path}.${key}` : key;
    const hit = findForbiddenKey(value[key], path ? `${path}.${key}` : key);
    if (hit) return hit;
  }

  return null;
}

export function assertNoAccessSecrets(payload) {
  const hit = findForbiddenKey(payload);
  if (hit) throw new TypeError(`access payload contains forbidden key: ${hit}`);
}

export function validateAccessPlanIssuedPayload(payload) {
  assertPlainObject(payload, "payload");
  assertNoAccessSecrets(payload);

  const allowed = new Set(["jobId", "accessPlanId", "method", "credentialRef", "scope", "validFrom", "validTo", "revocable", "requestedBy"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.accessPlanId, "payload.accessPlanId");

  assertNonEmptyString(payload.method, "payload.method");
  if (!ACCESS_METHODS.has(payload.method)) throw new TypeError("payload.method is not a supported access method");

  assertNonEmptyString(payload.credentialRef, "payload.credentialRef");
  if (!payload.credentialRef.startsWith("vault://")) throw new TypeError("payload.credentialRef must start with vault://");

  if (payload.scope !== undefined) {
    assertPlainObject(payload.scope, "payload.scope");
    const scopeAllowed = new Set(["areas", "noGo"]);
    for (const key of Object.keys(payload.scope)) {
      if (!scopeAllowed.has(key)) throw new TypeError(`payload.scope contains unknown field: ${key}`);
    }
    if (payload.scope.areas !== undefined) assertStringArray(payload.scope.areas, "payload.scope.areas");
    if (payload.scope.noGo !== undefined) assertStringArray(payload.scope.noGo, "payload.scope.noGo");
  }

  assertIsoDate(payload.validFrom, "payload.validFrom");
  assertIsoDate(payload.validTo, "payload.validTo");
  if (Date.parse(payload.validFrom) >= Date.parse(payload.validTo)) throw new TypeError("payload.validFrom must be before payload.validTo");

  if (typeof payload.revocable !== "boolean") throw new TypeError("payload.revocable must be a boolean");
  if (payload.requestedBy !== undefined) assertNonEmptyString(payload.requestedBy, "payload.requestedBy");

  return payload;
}

export function validateAccessResultPayload(payload, { name }) {
  assertPlainObject(payload, "payload");
  assertNoAccessSecrets(payload);
  const allowed = new Set(["jobId", "accessPlanId", "method", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.accessPlanId, "payload.accessPlanId");
  if (payload.method !== undefined) {
    assertNonEmptyString(payload.method, "payload.method");
    if (!ACCESS_METHODS.has(payload.method)) throw new TypeError("payload.method is not a supported access method");
  }
  if (payload.reason !== undefined) assertNonEmptyString(payload.reason, "payload.reason");
  return payload;
}

export function validateAccessRevokedPayload(payload) {
  assertPlainObject(payload, "payload");
  assertNoAccessSecrets(payload);
  const allowed = new Set(["jobId", "accessPlanId", "requestedBy", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.accessPlanId, "payload.accessPlanId");
  if (payload.requestedBy !== undefined) assertNonEmptyString(payload.requestedBy, "payload.requestedBy");
  if (payload.reason !== undefined) assertNonEmptyString(payload.reason, "payload.reason");
  return payload;
}

export function isWithinAccessWindow({ at, validFrom, validTo }) {
  const t = Date.parse(at);
  const from = Date.parse(validFrom);
  const to = Date.parse(validTo);
  return Number.isFinite(t) && Number.isFinite(from) && Number.isFinite(to) && t >= from && t <= to;
}

export function getAccessMethodFromPlan(plan) {
  return plan?.method ?? null;
}

