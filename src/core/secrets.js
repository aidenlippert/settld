import fs from "node:fs/promises";

import { normalizeTenantId } from "./tenancy.js";

export const SECRET_ERROR_CODE = Object.freeze({
  REF_INVALID: "SECRET_REF_INVALID",
  PROVIDER_FORBIDDEN: "SECRET_PROVIDER_FORBIDDEN",
  PROVIDER_UNAVAILABLE: "SECRET_PROVIDER_UNAVAILABLE",
  NOT_FOUND: "SECRET_NOT_FOUND",
  READ_FAILED: "SECRET_READ_FAILED"
});

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function parseTtlSeconds(raw, { fallbackSeconds = 30 } = {}) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallbackSeconds;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError("secrets cache TTL must be a positive number");
  return Math.floor(n);
}

export class SecretRefError extends Error {
  constructor(code, message, { cause, provider, tenantId, ref } = {}) {
    super(message);
    this.name = "SecretRefError";
    this.code = code;
    if (provider) this.provider = provider;
    if (tenantId) this.tenantId = tenantId;
    if (ref) this.ref = ref;
    if (cause) this.cause = cause;
  }
}

function isDevEnv() {
  const env = typeof process !== "undefined" ? process.env.NODE_ENV : "";
  return env === "development";
}

function splitRef(ref) {
  assertNonEmptyString(ref, "ref");
  const idx = ref.indexOf(":");
  if (idx === -1) {
    return { provider: "opaque", key: ref.trim() };
  }
  const provider = ref.slice(0, idx).trim().toLowerCase();
  const key = ref.slice(idx + 1);
  if (!provider) throw new SecretRefError(SECRET_ERROR_CODE.REF_INVALID, "secret ref is missing provider", { ref });
  if (!key || String(key).trim() === "") throw new SecretRefError(SECRET_ERROR_CODE.REF_INVALID, "secret ref is missing key", { ref, provider });
  return { provider, key: String(key) };
}

function normalizeSecretValue(value) {
  const v = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  // K8s secrets commonly have a trailing newline.
  return v.replace(/\r?\n$/, "");
}

export function createSecretsProvider({
  allowEnv = typeof process !== "undefined" && (process.env.PROXY_ENABLE_ENV_SECRETS === "1" || isDevEnv()),
  cacheTtlSeconds = typeof process !== "undefined" ? parseTtlSeconds(process.env.PROXY_SECRETS_CACHE_TTL_SECONDS, { fallbackSeconds: 30 }) : 30
} = {}) {
  if (!Number.isSafeInteger(cacheTtlSeconds) || cacheTtlSeconds <= 0) throw new TypeError("cacheTtlSeconds must be a positive integer");

  const cache = new Map(); // `${tenantId}\n${ref}` -> { expiresAtMs, secret }

  async function readEnvSecret({ tenantId, ref, key }) {
    if (!allowEnv) throw new SecretRefError(SECRET_ERROR_CODE.PROVIDER_FORBIDDEN, "env secrets provider is disabled", { provider: "env", tenantId, ref });
    const name = String(key).trim();
    if (!/^[A-Z0-9_]+$/.test(name)) {
      throw new SecretRefError(SECRET_ERROR_CODE.REF_INVALID, "env secret ref must be env:NAME", { provider: "env", tenantId, ref });
    }
    const value = typeof process !== "undefined" ? process.env[name] : undefined;
    if (typeof value !== "string" || value.trim() === "") {
      throw new SecretRefError(SECRET_ERROR_CODE.NOT_FOUND, "secret not found", { provider: "env", tenantId, ref });
    }
    return { type: "string", value: normalizeSecretValue(value), metadata: { provider: "env", name } };
  }

  async function readFileSecret({ tenantId, ref, key }) {
    const p = String(key);
    // Require an absolute path so refs are unambiguous in production.
    if (!p.startsWith("/")) throw new SecretRefError(SECRET_ERROR_CODE.REF_INVALID, "file secret ref must be file:/absolute/path", { provider: "file", tenantId, ref });
    let data;
    try {
      data = await fs.readFile(p, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") throw new SecretRefError(SECRET_ERROR_CODE.NOT_FOUND, "secret not found", { provider: "file", tenantId, ref, cause: err });
      throw new SecretRefError(SECRET_ERROR_CODE.READ_FAILED, "failed to read secret", { provider: "file", tenantId, ref, cause: err });
    }
    const value = normalizeSecretValue(data);
    if (!value || value.trim() === "") throw new SecretRefError(SECRET_ERROR_CODE.NOT_FOUND, "secret is empty", { provider: "file", tenantId, ref });
    return { type: "string", value, metadata: { provider: "file", path: p } };
  }

  async function readVaultSecret({ tenantId, ref }) {
    throw new SecretRefError(SECRET_ERROR_CODE.PROVIDER_UNAVAILABLE, "vault secrets provider is not configured", { provider: "vault", tenantId, ref });
  }

  async function getSecret({ tenantId, ref }) {
    tenantId = normalizeTenantId(tenantId);
    assertNonEmptyString(ref, "ref");
    const key = `${tenantId}\n${ref}`;
    const nowMs = Date.now();
    const cached = cache.get(key) ?? null;
    if (cached && Number.isFinite(cached.expiresAtMs) && cached.expiresAtMs > nowMs) return cached.secret;

    const { provider, key: providerKey } = splitRef(ref);

    let secret;
    if (provider === "env") {
      secret = await readEnvSecret({ tenantId, ref, key: providerKey });
    } else if (provider === "file") {
      secret = await readFileSecret({ tenantId, ref, key: providerKey });
    } else if (provider === "vault") {
      secret = await readVaultSecret({ tenantId, ref });
    } else {
      throw new SecretRefError(SECRET_ERROR_CODE.REF_INVALID, "unsupported secret provider", { provider, tenantId, ref });
    }

    cache.set(key, { expiresAtMs: nowMs + cacheTtlSeconds * 1000, secret });
    return secret;
  }

  return Object.freeze({ getSecret });
}

