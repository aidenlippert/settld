import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const AUTHORITY_GRANT_SCHEMA_VERSION = "AuthorityGrant.v1";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO date string`);
}

function normalizeId(value, name, { min = 1, max = 128 } = {}) {
  assertNonEmptyString(value, name);
  const out = String(value).trim();
  if (out.length < min || out.length > max) throw new TypeError(`${name} must be length ${min}..${max}`);
  if (!/^[A-Za-z0-9:_-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:_-]+$`);
  return out;
}

function normalizeHexHash(value, name) {
  assertNonEmptyString(value, name);
  const out = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be a 64-hex sha256`);
  return out;
}

function normalizeActor(value, name) {
  assertPlainObject(value, name);
  const actorType = typeof value.actorType === "string" ? value.actorType.trim().toLowerCase() : "";
  if (!actorType) throw new TypeError(`${name}.actorType is required`);
  if (!["human", "agent", "service", "system"].includes(actorType)) {
    throw new TypeError(`${name}.actorType must be human|agent|service|system`);
  }
  assertNonEmptyString(value.actorId, `${name}.actorId`);
  return normalizeForCanonicalJson({ actorType, actorId: String(value.actorId).trim() }, { path: "$" });
}

function normalizeCurrency(value) {
  const raw = typeof value === "string" && value.trim() !== "" ? value : "USD";
  const out = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(out)) throw new TypeError("limits.currency must match ^[A-Z][A-Z0-9_]{2,11}$");
  return out;
}

function normalizeToolIds(value) {
  const src = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of src) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const id = normalizeId(raw, "limits.toolIds[]", { min: 3, max: 128 });
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function normalizePinnedManifests(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("limits.pinnedManifests must be an object when provided");
  }
  const out = {};
  for (const [toolIdRaw, hashRaw] of Object.entries(value)) {
    if (!toolIdRaw || String(toolIdRaw).trim() === "") continue;
    const toolId = normalizeId(toolIdRaw, "limits.pinnedManifests.<toolId>", { min: 3, max: 128 });
    out[toolId] = normalizeHexHash(hashRaw, `limits.pinnedManifests.${toolId}`);
  }
  // Canonical JSON ordering comes from key sort; still normalize into a plain object.
  return out;
}

export function computeAuthorityGrantHashV1(grantCore) {
  if (!grantCore || typeof grantCore !== "object" || Array.isArray(grantCore)) {
    throw new TypeError("grantCore must be an object");
  }
  const copy = { ...grantCore };
  delete copy.grantHash;
  delete copy.signature;
  const normalized = normalizeForCanonicalJson(copy, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function buildAuthorityGrantV1({
  tenantId,
  grantId,
  grantedBy,
  grantedTo,
  limits,
  signer,
  at
} = {}) {
  const issuedAt = at ?? new Date().toISOString();
  assertIsoDate(issuedAt, "at");
  assertPlainObject(limits, "limits");

  const expiresAt = typeof limits.expiresAt === "string" ? limits.expiresAt.trim() : "";
  assertIsoDate(expiresAt, "limits.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new TypeError("limits.expiresAt must be later than issuedAt");
  }

  const maxPerTransactionCents = Number(limits.maxPerTransactionCents ?? 0);
  if (!Number.isSafeInteger(maxPerTransactionCents) || maxPerTransactionCents < 0) {
    throw new TypeError("limits.maxPerTransactionCents must be a non-negative safe integer");
  }

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: AUTHORITY_GRANT_SCHEMA_VERSION,
      grantId: normalizeId(grantId, "grantId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      grantedBy: normalizeActor(grantedBy, "grantedBy"),
      grantedTo: normalizeActor(grantedTo, "grantedTo"),
      limits: normalizeForCanonicalJson(
        {
          currency: normalizeCurrency(limits.currency),
          maxPerTransactionCents,
          toolIds: normalizeToolIds(limits.toolIds),
          pinnedManifests: normalizePinnedManifests(limits.pinnedManifests),
          expiresAt
        },
        { path: "$" }
      ),
      issuedAt
    },
    { path: "$" }
  );

  const grantHash = computeAuthorityGrantHashV1(normalized);

  if (!signer || typeof signer !== "object" || Array.isArray(signer)) throw new TypeError("signer is required");
  assertNonEmptyString(signer.keyId, "signer.keyId");
  assertNonEmptyString(signer.privateKeyPem, "signer.privateKeyPem");
  const signature = signHashHexEd25519(grantHash, signer.privateKeyPem);

  return normalizeForCanonicalJson(
    {
      ...normalized,
      grantHash,
      signature: {
        signerKeyId: String(signer.keyId),
        signedAt: issuedAt,
        signature
      }
    },
    { path: "$" }
  );
}

export function validateAuthorityGrantV1(grant) {
  assertPlainObject(grant, "grant");
  if (grant.schemaVersion !== AUTHORITY_GRANT_SCHEMA_VERSION) {
    throw new TypeError(`grant.schemaVersion must be ${AUTHORITY_GRANT_SCHEMA_VERSION}`);
  }
  normalizeId(grant.grantId, "grant.grantId", { min: 3, max: 128 });
  normalizeId(grant.tenantId, "grant.tenantId", { min: 1, max: 128 });
  normalizeActor(grant.grantedBy, "grant.grantedBy");
  normalizeActor(grant.grantedTo, "grant.grantedTo");
  assertPlainObject(grant.limits, "grant.limits");
  normalizeCurrency(grant.limits.currency);
  const maxPerTransactionCents = Number(grant.limits.maxPerTransactionCents ?? 0);
  if (!Number.isSafeInteger(maxPerTransactionCents) || maxPerTransactionCents < 0) {
    throw new TypeError("grant.limits.maxPerTransactionCents must be a non-negative safe integer");
  }
  normalizeToolIds(grant.limits.toolIds);
  if (grant.limits.pinnedManifests !== undefined && grant.limits.pinnedManifests !== null) {
    normalizePinnedManifests(grant.limits.pinnedManifests);
  }
  assertIsoDate(grant.issuedAt, "grant.issuedAt");
  assertIsoDate(grant.limits.expiresAt, "grant.limits.expiresAt");
  if (Date.parse(grant.limits.expiresAt) <= Date.parse(grant.issuedAt)) {
    throw new TypeError("grant.limits.expiresAt must be later than grant.issuedAt");
  }
  const grantHash = normalizeHexHash(grant.grantHash, "grant.grantHash");
  assertPlainObject(grant.signature, "grant.signature");
  assertNonEmptyString(grant.signature.signerKeyId, "grant.signature.signerKeyId");
  assertIsoDate(grant.signature.signedAt, "grant.signature.signedAt");
  assertNonEmptyString(grant.signature.signature, "grant.signature.signature");

  const computed = computeAuthorityGrantHashV1(grant);
  if (computed !== grantHash) throw new TypeError("grantHash mismatch");
  return true;
}

export function verifyAuthorityGrantV1({ grant, publicKeyPem } = {}) {
  validateAuthorityGrantV1(grant);
  assertNonEmptyString(publicKeyPem, "publicKeyPem");
  const ok = verifyHashHexEd25519({
    hashHex: grant.grantHash,
    signatureBase64: grant.signature.signature,
    publicKeyPem
  });
  if (!ok) throw new TypeError("authority grant signature invalid");
  return true;
}

export function assertAuthorityGrantAllows({ grant, at, toolId, manifestHash, amountCents, currency } = {}) {
  validateAuthorityGrantV1(grant);

  const atIso = at ?? new Date().toISOString();
  assertIsoDate(atIso, "at");
  const atMs = Date.parse(atIso);
  const expiresAtMs = Date.parse(grant.limits.expiresAt);
  if (atMs >= expiresAtMs) {
    const err = new Error("authority grant expired");
    err.code = "AUTHORITY_GRANT_EXPIRED";
    throw err;
  }

  const normalizedToolId = normalizeId(toolId, "toolId", { min: 3, max: 128 });
  const allowed = Array.isArray(grant.limits.toolIds) ? grant.limits.toolIds : [];
  if (!allowed.includes(normalizedToolId)) {
    const err = new Error("tool not allowed by authority grant");
    err.code = "AUTHORITY_GRANT_TOOL_NOT_ALLOWED";
    throw err;
  }

  const normalizedCurrency = normalizeCurrency(currency ?? grant.limits.currency);
  if (normalizedCurrency !== normalizeCurrency(grant.limits.currency)) {
    const err = new Error("currency not allowed by authority grant");
    err.code = "AUTHORITY_GRANT_CURRENCY_MISMATCH";
    throw err;
  }

  const amount = Number(amountCents ?? 0);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new TypeError("amountCents must be a non-negative safe integer");
  if (amount > Number(grant.limits.maxPerTransactionCents ?? 0)) {
    const err = new Error("amount exceeds per-transaction authority limit");
    err.code = "AUTHORITY_GRANT_SPEND_LIMIT";
    throw err;
  }

  if (manifestHash !== null && manifestHash !== undefined) {
    const pinned = grant.limits.pinnedManifests && typeof grant.limits.pinnedManifests === "object"
      ? grant.limits.pinnedManifests[normalizedToolId] ?? null
      : null;
    if (pinned) {
      const provided = normalizeHexHash(manifestHash, "manifestHash");
      if (provided !== pinned) {
        const err = new Error("tool manifest hash does not match pinned authority grant");
        err.code = "AUTHORITY_GRANT_PIN_MISMATCH";
        throw err;
      }
    }
  }

  return true;
}

