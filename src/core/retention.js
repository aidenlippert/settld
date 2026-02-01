function assertSafeInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

export function clampRetentionDays({ tenantDays = null, defaultDays = 0, maxDays = 0 } = {}) {
  if (tenantDays !== null && tenantDays !== undefined) assertSafeInt(tenantDays, "tenantDays");
  assertSafeInt(defaultDays, "defaultDays");
  assertSafeInt(maxDays, "maxDays");
  if (tenantDays !== null && tenantDays !== undefined && tenantDays < 0) throw new TypeError("tenantDays must be >= 0");
  if (defaultDays < 0) throw new TypeError("defaultDays must be >= 0");
  if (maxDays < 0) throw new TypeError("maxDays must be >= 0");

  let days = tenantDays === null || tenantDays === undefined ? defaultDays : tenantDays;

  // Convention: 0 means "no explicit tenant retention" (infinite) but the platform may cap it.
  if (maxDays > 0) {
    if (days === 0) return maxDays;
    return Math.min(days, maxDays);
  }

  return days;
}

export function computeExpiresAtIso({ at, retentionDays }) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) return null;
  if (typeof at !== "string" || at.trim() === "") throw new TypeError("at must be a non-empty ISO date string");
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new TypeError("at must be an ISO date string");
  const expiresMs = atMs + retentionDays * 24 * 60 * 60_000;
  return new Date(expiresMs).toISOString();
}

