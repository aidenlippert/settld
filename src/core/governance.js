import { DEFAULT_TENANT_ID, normalizeTenantId } from "./tenancy.js";
import { normalizeMonthCloseHoldPolicy } from "./month-close-hold-policy.js";

export const GOVERNANCE_STREAM_ID = "governance";

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
  return String(value);
}

export function validateTenantPolicyUpdatedPayload(payload) {
  assertPlainObject(payload, "payload");

  const allowed = new Set(["tenantId", "policyId", "effectiveFrom", "updatedAt", "policy", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  const tenantId = normalizeTenantId(payload.tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(payload.policyId, "payload.policyId");
  const effectiveFrom = assertIsoDate(payload.effectiveFrom, "payload.effectiveFrom");
  const updatedAt = assertIsoDate(payload.updatedAt, "payload.updatedAt");
  assertPlainObject(payload.policy, "payload.policy");

  const finance = payload.policy?.finance ?? null;
  if (finance !== null && finance !== undefined) {
    assertPlainObject(finance, "payload.policy.finance");
    if (finance.monthCloseHoldPolicy !== undefined && finance.monthCloseHoldPolicy !== null) {
      normalizeMonthCloseHoldPolicy(finance.monthCloseHoldPolicy);
    }
  }

  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");

  return { ...payload, tenantId, effectiveFrom, updatedAt };
}

export function validateServerSignerKeyRegisteredPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["tenantId", "keyId", "publicKeyPem", "registeredAt", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  const tenantId = normalizeTenantId(payload.tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(payload.keyId, "payload.keyId");
  assertNonEmptyString(payload.publicKeyPem, "payload.publicKeyPem");
  const registeredAt = assertIsoDate(payload.registeredAt, "payload.registeredAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  return { ...payload, tenantId, registeredAt };
}

export function validateServerSignerKeyRotatedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["tenantId", "oldKeyId", "newKeyId", "newPublicKeyPem", "rotatedAt", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  const tenantId = normalizeTenantId(payload.tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(payload.oldKeyId, "payload.oldKeyId");
  assertNonEmptyString(payload.newKeyId, "payload.newKeyId");
  assertNonEmptyString(payload.newPublicKeyPem, "payload.newPublicKeyPem");
  const rotatedAt = assertIsoDate(payload.rotatedAt, "payload.rotatedAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  return { ...payload, tenantId, rotatedAt };
}

export function validateServerSignerKeyRevokedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["tenantId", "keyId", "revokedAt", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  const tenantId = normalizeTenantId(payload.tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(payload.keyId, "payload.keyId");
  const revokedAt = assertIsoDate(payload.revokedAt, "payload.revokedAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  return { ...payload, tenantId, revokedAt };
}

