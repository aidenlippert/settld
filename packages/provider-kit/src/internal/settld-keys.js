import { createPublicKey } from "node:crypto";

import { normalizeForCanonicalJson } from "./canonical-json.js";
import { keyIdFromPublicKeyPem } from "./crypto.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return String(value).trim();
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO date-time`);
}

function normalizeKeyId({ keyId, publicKeyPem, fieldName = "keyId" } = {}) {
  const derived = keyIdFromPublicKeyPem(publicKeyPem);
  if (keyId === null || keyId === undefined || String(keyId).trim() === "") return derived;
  const normalized = assertNonEmptyString(keyId, fieldName);
  if (normalized !== derived) throw new TypeError(`${fieldName} does not match publicKeyPem`);
  return normalized;
}

export function publicKeyPemToEd25519X(publicKeyPem) {
  if (typeof publicKeyPem !== "string" || publicKeyPem.trim() === "") throw new TypeError("publicKeyPem must be a non-empty string");
  const pem = publicKeyPem;
  let jwk;
  try {
    jwk = createPublicKey(pem).export({ format: "jwk" });
  } catch (err) {
    throw new TypeError(`publicKeyPem is not a valid Ed25519 key: ${err?.message ?? String(err ?? "")}`);
  }
  if (!jwk || typeof jwk !== "object") throw new TypeError("publicKeyPem did not export as JWK");
  if (String(jwk.kty ?? "") !== "OKP") throw new TypeError("publicKeyPem must export to JWK kty=OKP");
  if (String(jwk.crv ?? "") !== "Ed25519") throw new TypeError("publicKeyPem must export to JWK crv=Ed25519");
  const x = assertNonEmptyString(jwk.x, "jwk.x");
  return x;
}

export function ed25519XToPublicKeyPem(x) {
  const normalizedX = assertNonEmptyString(x, "x");
  try {
    const keyObj = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: normalizedX },
      format: "jwk"
    });
    return keyObj.export({ format: "pem", type: "spki" }).toString();
  } catch (err) {
    throw new TypeError(`x is not a valid Ed25519 JWK coordinate: ${err?.message ?? String(err ?? "")}`);
  }
}

export function buildSettldPayKeysetV1({ activeKey, fallbackKeys = [], refreshedAt = new Date().toISOString() } = {}) {
  if (!activeKey || typeof activeKey !== "object" || Array.isArray(activeKey)) {
    throw new TypeError("activeKey must be an object");
  }
  assertIsoDate(refreshedAt, "refreshedAt");

  const keyRows = [activeKey, ...(Array.isArray(fallbackKeys) ? fallbackKeys : [])];
  const byKid = new Map();
  for (const row of keyRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (typeof row.publicKeyPem !== "string" || row.publicKeyPem.trim() === "") throw new TypeError("publicKeyPem must be a non-empty string");
    const publicKeyPem = row.publicKeyPem;
    const kid = normalizeKeyId({ keyId: row.keyId ?? row.kid ?? null, publicKeyPem, fieldName: "keyId" });
    if (byKid.has(kid)) continue;
    byKid.set(
      kid,
      normalizeForCanonicalJson(
        {
          kty: "OKP",
          crv: "Ed25519",
          x: publicKeyPemToEd25519X(publicKeyPem),
          kid,
          use: "sig",
          alg: "EdDSA"
        },
        { path: "$" }
      )
    );
  }

  return normalizeForCanonicalJson(
    {
      keys: Array.from(byKid.values()),
      refreshedAt
    },
    { path: "$" }
  );
}

export function publicKeyPemFromSettldKeysetEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("entry must be an object");
  if (typeof entry.publicKeyPem === "string" && entry.publicKeyPem.trim() !== "") return entry.publicKeyPem;
  const kty = assertNonEmptyString(entry.kty, "entry.kty");
  const crv = assertNonEmptyString(entry.crv, "entry.crv");
  if (kty !== "OKP" || crv !== "Ed25519") throw new TypeError("entry must be an Ed25519 OKP key");
  return ed25519XToPublicKeyPem(entry.x);
}

export function keyMapFromSettldKeyset(keyset) {
  if (!keyset || typeof keyset !== "object" || Array.isArray(keyset)) throw new TypeError("keyset must be an object");
  const rows = Array.isArray(keyset.keys) ? keyset.keys : [];
  const out = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const kid = assertNonEmptyString(row.kid, "keyset.keys[].kid");
    const publicKeyPem = publicKeyPemFromSettldKeysetEntry(row);
    out.set(kid, { ...row, kid, publicKeyPem });
  }
  return out;
}
