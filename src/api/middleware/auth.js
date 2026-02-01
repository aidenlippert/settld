import { hasScope, parseApiKeyToken, parseBearerAuthorizationHeader, verifyAuthKeySecret } from "../../core/auth.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "../../core/tenancy.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function parseHeader(req, name) {
  if (!req?.headers) return null;
  const lower = String(name).toLowerCase();
  const v = req.headers[lower] ?? req.headers[name] ?? null;
  return v === null || v === undefined ? null : String(v);
}

export function requireScope(scopes, scope) {
  return hasScope(scopes, scope);
}

export async function authenticateRequest({
  req,
  store,
  tenantId = DEFAULT_TENANT_ID,
  legacyTokenScopes = new Map(),
  nowIso = () => new Date().toISOString(),
  touchMinSeconds = null
} = {}) {
  if (!req) throw new TypeError("req is required");
  if (!store) throw new TypeError("store is required");
  tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);

  const authz = parseHeader(req, "authorization");
  const bearer = parseBearerAuthorizationHeader(authz);
  const apiKeyHeader = parseHeader(req, "x-proxy-api-key");

  const token = apiKeyHeader ? String(apiKeyHeader).trim() : bearer ? String(bearer).trim() : null;
  if (token) {
    const parsed = parseApiKeyToken(token);
    if (parsed) {
      const { keyId, secret } = parsed;
      assertNonEmptyString(keyId, "keyId");
      assertNonEmptyString(secret, "secret");

      const record =
        typeof store.getAuthKey === "function"
          ? await store.getAuthKey({ tenantId, keyId })
          : store.authKeys?.get?.(`${tenantId}\n${keyId}`) ?? null;

      if (!record) return { ok: false, reason: "unknown_key" };
      if (record.status && record.status !== "active") return { ok: false, reason: "key_inactive" };

      const expiresAt = record.expiresAt ?? null;
      if (expiresAt) {
        const expMs = Date.parse(String(expiresAt));
        const nowMs = Date.parse(nowIso());
        if (Number.isFinite(expMs) && Number.isFinite(nowMs) && nowMs >= expMs) {
          return { ok: false, reason: "expired" };
        }
      }

      const storedHash = record.secretHash ?? null;
      const verify = verifyAuthKeySecret({ secret, secretHash: storedHash });
      if (!verify.ok) {
        return { ok: false, reason: "bad_secret" };
      }

      try {
        if (typeof store.touchAuthKey === "function") {
          const minSecondsRaw =
            touchMinSeconds !== null && touchMinSeconds !== undefined
              ? Number(touchMinSeconds)
              : typeof process !== "undefined"
                ? Number(process.env.PROXY_AUTH_KEY_TOUCH_MIN_SECONDS ?? 60)
                : 60;
          const minSeconds = Number.isFinite(minSecondsRaw) && minSecondsRaw >= 0 ? minSecondsRaw : 60;
          const lastMs = record.lastUsedAt ? Date.parse(String(record.lastUsedAt)) : NaN;
          const nowAt = nowIso();
          const nowMs = Date.parse(nowAt);
          const shouldTouch =
            !Number.isFinite(lastMs) || !Number.isFinite(nowMs) || minSeconds === 0 ? true : nowMs - lastMs >= minSeconds * 1000;
          if (shouldTouch) {
            await store.touchAuthKey({ tenantId, keyId, at: nowAt });
          }
        }
      } catch {
        // Best-effort; auth should not fail hard on last_used_at updates.
      }

      const scopes = new Set(Array.isArray(record.scopes) ? record.scopes : []);
      return { ok: true, tenantId, principalId: `auth:${keyId}`, scopes, method: "api_key", keyId };
    }

    // Legacy ops token (pre-hardening). Accepted only if configured explicitly.
    const legacy = legacyTokenScopes.get(token);
    if (legacy) return { ok: true, tenantId, principalId: `legacy_ops:${token}`, scopes: legacy, method: "legacy_ops_token" };
  }

  const legacyHeader = parseHeader(req, "x-proxy-ops-token");
  if (legacyHeader && legacyTokenScopes.size) {
    const legacyToken = String(legacyHeader).trim();
    const legacy = legacyTokenScopes.get(legacyToken);
    if (legacy) return { ok: true, tenantId, principalId: `legacy_ops:${legacyToken}`, scopes: legacy, method: "legacy_ops_token" };
  }

  return { ok: false, reason: "missing" };
}
