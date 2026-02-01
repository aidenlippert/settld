import crypto from "node:crypto";

import { createId } from "./ids.js";

export const AUTH_KEY_STATUS = Object.freeze({
  ACTIVE: "active",
  ROTATED: "rotated",
  REVOKED: "revoked"
});

const AUTH_KEY_STATUSES = new Set(Object.values(AUTH_KEY_STATUS));

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

export function normalizeAuthKeyStatus(status) {
  assertNonEmptyString(status, "status");
  const normalized = String(status).trim().toLowerCase();
  if (!AUTH_KEY_STATUSES.has(normalized)) throw new TypeError("status is not supported");
  return normalized;
}

export function normalizeScopes(scopes) {
  if (scopes === null || scopes === undefined) return [];
  if (!Array.isArray(scopes)) throw new TypeError("scopes must be an array");
  const out = [];
  const seen = new Set();
  for (const s of scopes) {
    if (typeof s !== "string" || s.trim() === "") continue;
    const v = s.trim();
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  out.sort();
  return out;
}

export function hasScope(scopes, requiredScope) {
  if (!requiredScope) return false;
  const s = scopes instanceof Set ? scopes : new Set(Array.isArray(scopes) ? scopes : []);
  if (s.has(requiredScope)) return true;

  // Write implies read for `*_read` scopes (e.g., ops_write -> ops_read).
  if (requiredScope.endsWith("_read")) {
    const implied = `${requiredScope.slice(0, -"_read".length)}_write`;
    if (s.has(implied)) return true;
  }

  return false;
}

export function authKeyId() {
  const nodeEnv = typeof process !== "undefined" && process.env ? String(process.env.NODE_ENV ?? "") : "";
  const prefix = nodeEnv === "production" ? "sk_live" : "sk_test";
  return createId(prefix);
}

export function authKeySecret({ bytes = 32 } = {}) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new TypeError("bytes must be a positive integer");
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256HexUtf8(value) {
  assertNonEmptyString(value, "value");
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashAuthKeySecret(secret) {
  return hashAuthKeySecretScrypt(secret);
}

export function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ax = a.trim();
  const bx = b.trim();
  if (ax.length !== bx.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(ax, "utf8"), Buffer.from(bx, "utf8"));
  } catch {
    return false;
  }
}

export function parseBearerAuthorizationHeader(headerValue) {
  if (typeof headerValue !== "string" || headerValue.trim() === "") return null;
  const v = headerValue.trim();
  if (!v.toLowerCase().startsWith("bearer ")) return null;
  const token = v.slice("bearer ".length).trim();
  return token ? token : null;
}

export function parseApiKeyToken(token) {
  if (typeof token !== "string" || token.trim() === "") return null;
  const raw = token.trim();
  const idx = raw.indexOf(".");
  if (idx === -1) return null;
  const keyId = raw.slice(0, idx).trim();
  const secret = raw.slice(idx + 1).trim();
  if (!keyId || !secret) return null;
  if (keyId.includes(" ") || secret.includes(" ")) return null;
  return { keyId, secret };
}

export function hashAuthKeySecretLegacy(secret) {
  assertNonEmptyString(secret, "secret");
  return sha256HexUtf8(`settld_auth_key_secret_v1:${secret}`);
}

function scryptParamsFromEnv() {
  const defaults = { N: 16384, r: 8, p: 1, keyLen: 32, saltBytes: 16 };
  if (typeof process === "undefined" || !process.env) return defaults;
  const rawN = process.env.PROXY_AUTH_KEY_SCRYPT_N;
  const rawR = process.env.PROXY_AUTH_KEY_SCRYPT_R;
  const rawP = process.env.PROXY_AUTH_KEY_SCRYPT_P;
  const rawKeyLen = process.env.PROXY_AUTH_KEY_SCRYPT_KEYLEN;
  const rawSaltBytes = process.env.PROXY_AUTH_KEY_SCRYPT_SALT_BYTES;

  const next = { ...defaults };
  if (rawN && String(rawN).trim() !== "") next.N = Number(rawN);
  if (rawR && String(rawR).trim() !== "") next.r = Number(rawR);
  if (rawP && String(rawP).trim() !== "") next.p = Number(rawP);
  if (rawKeyLen && String(rawKeyLen).trim() !== "") next.keyLen = Number(rawKeyLen);
  if (rawSaltBytes && String(rawSaltBytes).trim() !== "") next.saltBytes = Number(rawSaltBytes);

  if (!Number.isSafeInteger(next.N) || next.N < 1024) throw new TypeError("PROXY_AUTH_KEY_SCRYPT_N must be a safe integer >= 1024");
  if (!Number.isSafeInteger(next.r) || next.r <= 0) throw new TypeError("PROXY_AUTH_KEY_SCRYPT_R must be a positive safe integer");
  if (!Number.isSafeInteger(next.p) || next.p <= 0) throw new TypeError("PROXY_AUTH_KEY_SCRYPT_P must be a positive safe integer");
  if (!Number.isSafeInteger(next.keyLen) || next.keyLen <= 0) throw new TypeError("PROXY_AUTH_KEY_SCRYPT_KEYLEN must be a positive safe integer");
  if (!Number.isSafeInteger(next.saltBytes) || next.saltBytes <= 0) throw new TypeError("PROXY_AUTH_KEY_SCRYPT_SALT_BYTES must be a positive safe integer");

  return next;
}

export function hashAuthKeySecretScrypt(secret) {
  assertNonEmptyString(secret, "secret");
  const { N, r, p, keyLen, saltBytes } = scryptParamsFromEnv();
  const salt = crypto.randomBytes(saltBytes);
  const maxmem = 32 * 1024 * 1024; // prevent pathological settings from exhausting memory
  const derived = crypto.scryptSync(`settld_auth_key_secret_v2:${secret}`, salt, keyLen, { N, r, p, maxmem });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyAuthKeySecret({ secret, secretHash }) {
  assertNonEmptyString(secret, "secret");
  if (typeof secretHash !== "string" || secretHash.trim() === "") return { ok: false, scheme: null, needsRehash: false };
  const stored = secretHash.trim();

  if (stored.startsWith("scrypt$")) {
    const parts = stored.split("$");
    if (parts.length !== 6) return { ok: false, scheme: "scrypt", needsRehash: false };
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const saltB64 = parts[4];
    const hashB64 = parts[5];
    if (!Number.isSafeInteger(N) || N <= 0) return { ok: false, scheme: "scrypt", needsRehash: false };
    if (!Number.isSafeInteger(r) || r <= 0) return { ok: false, scheme: "scrypt", needsRehash: false };
    if (!Number.isSafeInteger(p) || p <= 0) return { ok: false, scheme: "scrypt", needsRehash: false };
    let salt;
    let expected;
    try {
      salt = Buffer.from(String(saltB64), "base64url");
      expected = Buffer.from(String(hashB64), "base64url");
    } catch {
      return { ok: false, scheme: "scrypt", needsRehash: false };
    }
    if (!salt.length || !expected.length) return { ok: false, scheme: "scrypt", needsRehash: false };

    try {
      const maxmem = 32 * 1024 * 1024;
      const got = crypto.scryptSync(`settld_auth_key_secret_v2:${secret}`, salt, expected.length, { N, r, p, maxmem });
      const ok = expected.length === got.length && crypto.timingSafeEqual(expected, got);
      return { ok, scheme: "scrypt", needsRehash: false };
    } catch {
      return { ok: false, scheme: "scrypt", needsRehash: false };
    }
  }

  // Legacy v1: sha256HexUtf8(`settld_auth_key_secret_v1:${secret}`)
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    const presented = hashAuthKeySecretLegacy(secret);
    const ok = timingSafeEqualHex(presented, stored);
    return { ok, scheme: "sha256", needsRehash: ok };
  }

  return { ok: false, scheme: null, needsRehash: false };
}
