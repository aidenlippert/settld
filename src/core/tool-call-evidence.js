import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex, signHashHexEd25519 } from "./crypto.js";

export const TOOL_CALL_EVIDENCE_SCHEMA_VERSION = "ToolCallEvidence.v1";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return String(value).trim();
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO date string`);
  return new Date(Date.parse(value)).toISOString();
}

function normalizeSha256Hex(value, name) {
  assertNonEmptyString(value, name);
  const out = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be a 64-hex sha256`);
  return out;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out : null;
}

export function computeToolCallOutputHashV1(output) {
  const canonical = canonicalJsonStringify(output ?? {});
  return sha256Hex(canonical);
}

export function computeToolCallEvidenceHashV1(evidenceCore) {
  assertPlainObject(evidenceCore, "evidenceCore");
  const copy = { ...evidenceCore };
  delete copy.evidenceHash;
  delete copy.signature;
  const normalized = normalizeForCanonicalJson(copy, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function buildToolCallEvidenceV1({
  agreementHash,
  callId,
  inputHash,
  output = {},
  outputHash = null,
  outputRef = null,
  metrics = null,
  startedAt = new Date().toISOString(),
  completedAt = null,
  createdAt = null,
  signerKeyId = null,
  signerPrivateKeyPem = null
} = {}) {
  const startedAtIso = assertIsoDate(startedAt, "startedAt");
  const completedAtIso = assertIsoDate(completedAt ?? startedAtIso, "completedAt");
  const createdAtIso = assertIsoDate(createdAt ?? completedAtIso, "createdAt");

  const computedOutputHash =
    outputHash === null || outputHash === undefined ? computeToolCallOutputHashV1(output) : normalizeSha256Hex(outputHash, "outputHash");

  const core = normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_CALL_EVIDENCE_SCHEMA_VERSION,
      agreementHash: normalizeSha256Hex(agreementHash, "agreementHash"),
      callId: assertNonEmptyString(String(callId ?? ""), "callId"),
      inputHash: normalizeSha256Hex(inputHash, "inputHash"),
      outputHash: computedOutputHash,
      outputRef: outputRef === undefined ? null : normalizeNullableString(outputRef),
      metrics: metrics === undefined ? null : metrics,
      startedAt: startedAtIso,
      completedAt: completedAtIso,
      createdAt: createdAtIso
    },
    { path: "$" }
  );

  const evidenceHash = computeToolCallEvidenceHashV1(core);

  let signature = null;
  const normalizedSignerKeyId = signerKeyId === null || signerKeyId === undefined ? null : normalizeNullableString(signerKeyId);
  const normalizedSignerPrivateKeyPem =
    signerPrivateKeyPem === null || signerPrivateKeyPem === undefined ? null : normalizeNullableString(signerPrivateKeyPem);
  if (normalizedSignerPrivateKeyPem) {
    if (!normalizedSignerKeyId) throw new TypeError("signerKeyId is required when signerPrivateKeyPem is provided");
    signature = {
      algorithm: "ed25519",
      signerKeyId: normalizedSignerKeyId,
      evidenceHash,
      signature: signHashHexEd25519(evidenceHash, normalizedSignerPrivateKeyPem)
    };
  }

  return normalizeForCanonicalJson({ ...core, evidenceHash, ...(signature ? { signature } : {}) }, { path: "$" });
}

export function validateToolCallEvidenceV1(evidence) {
  assertPlainObject(evidence, "evidence");
  if (evidence.schemaVersion !== TOOL_CALL_EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError(`evidence.schemaVersion must be ${TOOL_CALL_EVIDENCE_SCHEMA_VERSION}`);
  }
  normalizeSha256Hex(evidence.agreementHash, "evidence.agreementHash");
  assertNonEmptyString(evidence.callId, "evidence.callId");
  normalizeSha256Hex(evidence.inputHash, "evidence.inputHash");
  normalizeSha256Hex(evidence.outputHash, "evidence.outputHash");

  if (Object.prototype.hasOwnProperty.call(evidence, "outputRef")) {
    normalizeNullableString(evidence.outputRef ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(evidence, "metrics") && evidence.metrics !== null && evidence.metrics !== undefined) {
    assertPlainObject(evidence.metrics, "evidence.metrics");
  }

  assertIsoDate(evidence.startedAt, "evidence.startedAt");
  assertIsoDate(evidence.completedAt, "evidence.completedAt");
  assertIsoDate(evidence.createdAt, "evidence.createdAt");

  const evidenceHash = normalizeSha256Hex(evidence.evidenceHash, "evidence.evidenceHash");
  const computed = computeToolCallEvidenceHashV1(evidence);
  if (computed !== evidenceHash) throw new TypeError("evidenceHash mismatch");

  if (Object.prototype.hasOwnProperty.call(evidence, "signature") && evidence.signature !== null && evidence.signature !== undefined) {
    const sig = evidence.signature;
    if (!sig || typeof sig !== "object" || Array.isArray(sig)) throw new TypeError("evidence.signature must be an object");
    if (sig.algorithm !== "ed25519") throw new TypeError("evidence.signature.algorithm must be ed25519");
    assertNonEmptyString(sig.signerKeyId, "evidence.signature.signerKeyId");
    const sigEvidenceHash = normalizeSha256Hex(sig.evidenceHash, "evidence.signature.evidenceHash");
    if (sigEvidenceHash !== evidenceHash) throw new TypeError("evidence.signature.evidenceHash mismatch");
    assertNonEmptyString(sig.signature, "evidence.signature.signature");
  }

  return true;
}

