export const DEFAULT_TENANT_ID = "tenant_default";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertNoNewlines(value, name) {
  if (value.includes("\n") || value.includes("\r")) throw new TypeError(`${name} must not contain newlines`);
}

export function normalizeTenantId(value, { defaultTenantId = DEFAULT_TENANT_ID } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultTenantId;
  const tenantId = String(value).trim();
  assertNonEmptyString(tenantId, "tenantId");
  assertNoNewlines(tenantId, "tenantId");
  if (tenantId.length > 200) throw new TypeError("tenantId is too long");
  return tenantId;
}

export function normalizeCustomerId(value, { defaultCustomerId = null } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultCustomerId;
  const customerId = String(value).trim();
  assertNonEmptyString(customerId, "customerId");
  assertNoNewlines(customerId, "customerId");
  if (customerId.length > 200) throw new TypeError("customerId is too long");
  return customerId;
}

export function normalizeSiteId(value, { defaultSiteId = null } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultSiteId;
  const siteId = String(value).trim();
  assertNonEmptyString(siteId, "siteId");
  assertNoNewlines(siteId, "siteId");
  if (siteId.length > 200) throw new TypeError("siteId is too long");
  return siteId;
}

export function makeScopedKey({ tenantId, id }) {
  tenantId = normalizeTenantId(tenantId);
  assertNonEmptyString(id, "id");
  assertNoNewlines(id, "id");
  if (id.length > 500) throw new TypeError("id is too long");
  return `${tenantId}\n${id}`;
}

export function parseScopedKey(key) {
  assertNonEmptyString(key, "key");
  const parts = key.split("\n");
  if (parts.length !== 2) throw new TypeError("invalid scoped key");
  const [tenantId, id] = parts;
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(id, "id");
  return { tenantId, id };
}

