import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const DISPUTE_OPEN_ENVELOPE_SCHEMA_VERSION = "DisputeOpenEnvelope.v1";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function normalizeId(value, name, { min = 1, max = 240 } = {}) {
  assertNonEmptyString(value, name);
  const out = String(value).trim();
  if (out.length < min || out.length > max) throw new TypeError(`${name} must be length ${min}..${max}`);
  if (!/^[A-Za-z0-9:_-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:_-]+$`);
  return out;
}

function normalizeSha256(value, name) {
  assertNonEmptyString(value, name);
  const out = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be a 64-hex sha256`);
  return out;
}

function normalizeIsoDate(value, name) {
  assertNonEmptyString(value, name);
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be an ISO date string`);
  return new Date(parsed).toISOString();
}

function normalizeReasonCode(value, name) {
  assertNonEmptyString(value, name);
  const out = String(value).trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,64}$/.test(out)) throw new TypeError(`${name} must match ^[A-Z0-9_]{2,64}$`);
  return out;
}

function normalizeSignature(value, name) {
  assertNonEmptyString(value, name);
  return String(value).trim();
}

export function buildDisputeOpenEnvelopeCoreV1({
  envelopeId,
  caseId,
  tenantId,
  agreementHash,
  receiptHash,
  holdHash,
  openedByAgentId,
  openedAt,
  reasonCode,
  nonce,
  signerKeyId
} = {}) {
  const openedAtIso = normalizeIsoDate(openedAt ?? new Date().toISOString(), "openedAt");
  const normalizedEnvelopeId = normalizeId(envelopeId, "envelopeId", { min: 3, max: 240 });
  const normalizedCaseId = normalizeId(caseId, "caseId", { min: 3, max: 240 });
  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: DISPUTE_OPEN_ENVELOPE_SCHEMA_VERSION,
      artifactType: DISPUTE_OPEN_ENVELOPE_SCHEMA_VERSION,
      artifactId: normalizedEnvelopeId,
      envelopeId: normalizedEnvelopeId,
      caseId: normalizedCaseId,
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      agreementHash: normalizeSha256(agreementHash, "agreementHash"),
      receiptHash: normalizeSha256(receiptHash, "receiptHash"),
      holdHash: normalizeSha256(holdHash, "holdHash"),
      openedByAgentId: normalizeId(openedByAgentId, "openedByAgentId", { min: 3, max: 128 }),
      openedAt: openedAtIso,
      reasonCode: normalizeReasonCode(reasonCode, "reasonCode"),
      nonce: normalizeId(nonce, "nonce", { min: 8, max: 240 }),
      signerKeyId: normalizeId(signerKeyId, "signerKeyId", { min: 8, max: 240 })
    },
    { path: "$" }
  );
  return normalized;
}

export function computeDisputeOpenEnvelopeHashV1(envelopeCore) {
  assertPlainObject(envelopeCore, "envelopeCore");
  const copy = { ...envelopeCore };
  delete copy.envelopeHash;
  delete copy.signature;
  delete copy.artifactHash;
  const normalized = normalizeForCanonicalJson(copy, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function buildDisputeOpenEnvelopeV1({
  envelopeId,
  caseId,
  tenantId,
  agreementHash,
  receiptHash,
  holdHash,
  openedByAgentId,
  openedAt,
  reasonCode,
  nonce,
  signerKeyId,
  signature
} = {}) {
  const core = buildDisputeOpenEnvelopeCoreV1({
    envelopeId,
    caseId,
    tenantId,
    agreementHash,
    receiptHash,
    holdHash,
    openedByAgentId,
    openedAt,
    reasonCode,
    nonce,
    signerKeyId
  });
  const envelopeHash = computeDisputeOpenEnvelopeHashV1(core);
  return normalizeForCanonicalJson(
    {
      ...core,
      envelopeHash,
      signature: normalizeSignature(signature, "signature")
    },
    { path: "$" }
  );
}

export function validateDisputeOpenEnvelopeV1(envelope) {
  assertPlainObject(envelope, "envelope");
  if (envelope.schemaVersion !== DISPUTE_OPEN_ENVELOPE_SCHEMA_VERSION) {
    throw new TypeError(`envelope.schemaVersion must be ${DISPUTE_OPEN_ENVELOPE_SCHEMA_VERSION}`);
  }
  if (envelope.artifactType !== DISPUTE_OPEN_ENVELOPE_SCHEMA_VERSION) {
    throw new TypeError(`envelope.artifactType must be ${DISPUTE_OPEN_ENVELOPE_SCHEMA_VERSION}`);
  }
  const envelopeId = normalizeId(envelope.envelopeId, "envelope.envelopeId", { min: 3, max: 240 });
  const artifactId = normalizeId(envelope.artifactId, "envelope.artifactId", { min: 3, max: 240 });
  if (artifactId !== envelopeId) throw new TypeError("envelope.artifactId must equal envelope.envelopeId");
  normalizeId(envelope.caseId, "envelope.caseId", { min: 3, max: 240 });
  normalizeId(envelope.tenantId, "envelope.tenantId", { min: 1, max: 128 });
  normalizeSha256(envelope.agreementHash, "envelope.agreementHash");
  normalizeSha256(envelope.receiptHash, "envelope.receiptHash");
  normalizeSha256(envelope.holdHash, "envelope.holdHash");
  normalizeId(envelope.openedByAgentId, "envelope.openedByAgentId", { min: 3, max: 128 });
  normalizeIsoDate(envelope.openedAt, "envelope.openedAt");
  normalizeReasonCode(envelope.reasonCode, "envelope.reasonCode");
  normalizeId(envelope.nonce, "envelope.nonce", { min: 8, max: 240 });
  normalizeId(envelope.signerKeyId, "envelope.signerKeyId", { min: 8, max: 240 });
  normalizeSignature(envelope.signature, "envelope.signature");
  const envelopeHash = normalizeSha256(envelope.envelopeHash, "envelope.envelopeHash");
  const computed = computeDisputeOpenEnvelopeHashV1(envelope);
  if (computed !== envelopeHash) throw new TypeError("envelopeHash mismatch");
  return true;
}
