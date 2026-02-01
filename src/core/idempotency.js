function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertNoNewlines(value, name) {
  if (value.includes("\n") || value.includes("\r")) throw new TypeError(`${name} must not contain newlines`);
}

export function normalizePrincipalId(headers, { headerName = "x-proxy-principal-id", defaultPrincipalId = "anon" } = {}) {
  const raw = headers?.[headerName] ?? headers?.[headerName.toLowerCase()] ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return defaultPrincipalId;
  const principalId = String(raw);
  assertNonEmptyString(principalId, "principalId");
  assertNoNewlines(principalId, "principalId");
  if (principalId.length > 200) throw new TypeError("principalId is too long");
  return principalId;
}

export function makeIdempotencyEndpoint({ method, path }) {
  assertNonEmptyString(method, "method");
  assertNonEmptyString(path, "path");
  const endpoint = `${method.toUpperCase()} ${path}`;
  assertNoNewlines(endpoint, "endpoint");
  if (endpoint.length > 500) throw new TypeError("endpoint is too long");
  return endpoint;
}

export function makeIdempotencyStoreKey({ tenantId, principalId, endpoint, idempotencyKey }) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNoNewlines(tenantId, "tenantId");
  assertNonEmptyString(principalId, "principalId");
  assertNoNewlines(principalId, "principalId");
  assertNonEmptyString(endpoint, "endpoint");
  assertNoNewlines(endpoint, "endpoint");
  assertNonEmptyString(idempotencyKey, "idempotencyKey");
  assertNoNewlines(idempotencyKey, "idempotencyKey");
  if (idempotencyKey.length > 500) throw new TypeError("idempotencyKey is too long");
  return `${tenantId}\n${principalId}\n${endpoint}\n${idempotencyKey}`;
}

export function parseIdempotencyStoreKey(storeKey) {
  assertNonEmptyString(storeKey, "storeKey");
  const parts = storeKey.split("\n");
  if (parts.length !== 4) throw new TypeError("invalid idempotency store key");
  const [tenantId, principalId, endpoint, idempotencyKey] = parts;
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(principalId, "principalId");
  assertNonEmptyString(endpoint, "endpoint");
  assertNonEmptyString(idempotencyKey, "idempotencyKey");
  return { tenantId, principalId, endpoint, idempotencyKey };
}
