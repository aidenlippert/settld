function assertSafeInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

export function clampQuota({ tenantLimit = null, defaultLimit = 0, maxLimit = 0 } = {}) {
  if (tenantLimit !== null && tenantLimit !== undefined) assertSafeInt(tenantLimit, "tenantLimit");
  assertSafeInt(defaultLimit, "defaultLimit");
  assertSafeInt(maxLimit, "maxLimit");
  if (tenantLimit !== null && tenantLimit !== undefined && tenantLimit < 0) throw new TypeError("tenantLimit must be >= 0");
  if (defaultLimit < 0) throw new TypeError("defaultLimit must be >= 0");
  if (maxLimit < 0) throw new TypeError("maxLimit must be >= 0");

  let limit = tenantLimit === null || tenantLimit === undefined ? defaultLimit : tenantLimit;

  // Convention: 0 means "unlimited", but the platform may cap it.
  if (maxLimit > 0) {
    if (limit === 0) return maxLimit;
    return Math.min(limit, maxLimit);
  }

  return limit;
}

export function isQuotaExceeded({ current, limit }) {
  assertSafeInt(current, "current");
  assertSafeInt(limit, "limit");
  if (current < 0) throw new TypeError("current must be >= 0");
  if (limit < 0) throw new TypeError("limit must be >= 0");
  if (limit === 0) return false;
  return current >= limit;
}

