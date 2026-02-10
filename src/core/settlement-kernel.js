import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const TOOL_CALL_AGREEMENT_SCHEMA_VERSION = "ToolCallAgreement.v1";
export const TOOL_CALL_EVIDENCE_SCHEMA_VERSION = "ToolCallEvidence.v1";
export const FUNDING_HOLD_SCHEMA_VERSION = "FundingHold.v1";
export const TOOL_CALL_DISPUTE_OPEN_SCHEMA_VERSION = "ToolCallDisputeOpen.v1";
export const SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION = "SettlementDecisionRecord.v1";
export const SETTLEMENT_RECEIPT_SCHEMA_VERSION = "SettlementReceipt.v1";
export const SETTLEMENT_RECEIPT_V2_SCHEMA_VERSION = "SettlementReceipt.v2";
export const SETTLEMENT_ADJUSTMENT_SCHEMA_VERSION = "SettlementAdjustment.v1";

export function computeToolCallInputHashV1(input) {
  // Canonicalize input to make payer/provider/verifier hashing stable across languages.
  const normalized = normalizeForCanonicalJson(input ?? null, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function computeToolCallOutputHashV1(output) {
  const normalized = normalizeForCanonicalJson(output ?? null, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

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

function normalizeCurrency(value, name) {
  const raw = typeof value === "string" && value.trim() !== "" ? value : "USD";
  const out = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(out)) throw new TypeError(`${name} must match ^[A-Z][A-Z0-9_]{2,11}$`);
  return out;
}

function normalizeActorId(value, name) {
  return normalizeId(value, name, { min: 3, max: 128 });
}

function assertNonNegativeSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

function normalizeAcceptanceCriteria(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("acceptanceCriteria must be an object or null");
  const raw = value;
  const maxLatencyMs = raw.maxLatencyMs === undefined || raw.maxLatencyMs === null ? null : assertNonNegativeSafeInt(raw.maxLatencyMs, "acceptanceCriteria.maxLatencyMs");
  const requireOutput = raw.requireOutput === undefined || raw.requireOutput === null ? null : raw.requireOutput === true;
  const maxOutputBytes =
    raw.maxOutputBytes === undefined || raw.maxOutputBytes === null ? null : assertNonNegativeSafeInt(raw.maxOutputBytes, "acceptanceCriteria.maxOutputBytes");

  let verifier = null;
  if (raw.verifier !== undefined && raw.verifier !== null) {
    if (!raw.verifier || typeof raw.verifier !== "object" || Array.isArray(raw.verifier)) throw new TypeError("acceptanceCriteria.verifier must be an object or null");
    const kind = String(raw.verifier.kind ?? "").trim().toLowerCase();
    if (kind !== "builtin") throw new TypeError("acceptanceCriteria.verifier.kind must be builtin");
    const verifierId = normalizeId(raw.verifier.verifierId, "acceptanceCriteria.verifier.verifierId", { min: 3, max: 128 });
    verifier = { kind, verifierId };
  }

  return normalizeForCanonicalJson(
    {
      maxLatencyMs,
      requireOutput,
      maxOutputBytes,
      verifier
    },
    { path: "$" }
  );
}

function normalizeSettlementTerms(value) {
  if (value === null || value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("settlementTerms must be an object");
  const raw = value;

  const holdbackBps = raw.holdbackBps === undefined ? undefined : assertNonNegativeSafeInt(raw.holdbackBps, "settlementTerms.holdbackBps");
  if (holdbackBps !== undefined && holdbackBps > 10_000) throw new TypeError("settlementTerms.holdbackBps must be <= 10000");
  if (holdbackBps === 0) return undefined;

  const challengeWindowMs =
    raw.challengeWindowMs === undefined ? undefined : assertNonNegativeSafeInt(raw.challengeWindowMs, "settlementTerms.challengeWindowMs");

  if (holdbackBps !== undefined && holdbackBps > 0) {
    if (challengeWindowMs === undefined || challengeWindowMs <= 0) throw new TypeError("settlementTerms.challengeWindowMs must be > 0 when holdbackBps > 0");
  }
  if (holdbackBps === undefined && challengeWindowMs !== undefined) {
    throw new TypeError("settlementTerms.challengeWindowMs must be omitted when holdbackBps is omitted");
  }

  if (holdbackBps === undefined) return undefined;
  return normalizeForCanonicalJson({ holdbackBps, challengeWindowMs }, { path: "$" });
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}

export function evaluateToolCallAcceptanceV1({ agreement, evidence }) {
  // Deterministic evaluation over the evidence. No network calls.
  validateToolCallAgreementV1(agreement);
  validateToolCallEvidenceV1(evidence);

  const reasons = [];
  const summary = {};

  const criteria = normalizeAcceptanceCriteria(agreement.acceptanceCriteria ?? null);
  summary.acceptanceCriteria = criteria;

  const startedMs = Date.parse(evidence?.call?.startedAt);
  const completedMs = Date.parse(evidence?.call?.completedAt);
  const latencyMs = Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : null;
  summary.latencyMs = latencyMs;

  if (criteria?.maxLatencyMs !== null && criteria?.maxLatencyMs !== undefined && latencyMs !== null) {
    if (latencyMs > criteria.maxLatencyMs) reasons.push("latency_exceeded");
  }

  const output = evidence?.call?.output ?? null;
  summary.hasOutput = output !== null && output !== undefined;
  if (criteria?.requireOutput === true) {
    if (output === null || output === undefined) reasons.push("output_missing");
  }

  const outputCanonical = canonicalJsonStringify(normalizeForCanonicalJson(output ?? null, { path: "$" }));
  const outputBytes = utf8ByteLength(outputCanonical);
  summary.outputBytes = outputBytes;
  if (criteria?.maxOutputBytes !== null && criteria?.maxOutputBytes !== undefined) {
    if (outputBytes > criteria.maxOutputBytes) reasons.push("output_too_large");
  }

  let modality = "cryptographic";
  if (criteria?.verifier?.kind === "builtin") {
    const verifierId = String(criteria.verifier.verifierId);
    summary.deterministicVerifierId = verifierId;
    // Minimal builtin deterministic verifier: uppercase_v1.
    if (verifierId === "uppercase_v1") {
      modality = "deterministic";
      const input = evidence?.call?.input ?? null;
      const inputText = input && typeof input === "object" && !Array.isArray(input) ? input.text : null;
      const outText = output && typeof output === "object" && !Array.isArray(output) ? output.text : null;
      if (typeof inputText !== "string") reasons.push("deterministic_input_invalid");
      else if (typeof outText !== "string") reasons.push("deterministic_output_invalid");
      else if (outText !== inputText.toUpperCase()) reasons.push("deterministic_mismatch");
    } else {
      reasons.push("unknown_verifier");
    }
  }

  if (reasons.length === 0) reasons.push("acceptance_ok");
  const ok = !reasons.some((c) => c !== "acceptance_ok");
  summary.ok = ok;

  return { ok, modality, reasonCodes: reasons, evaluationSummary: summary };
}

function computeSignedObjectHash({ obj, hashField, signatureField } = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new TypeError("obj must be an object");
  assertNonEmptyString(hashField, "hashField");
  assertNonEmptyString(signatureField, "signatureField");
  const copy = { ...obj };
  delete copy[hashField];
  delete copy[signatureField];
  delete copy.artifactHash; // storage-level hash is not part of the signed core
  const normalized = normalizeForCanonicalJson(copy, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

function signObjectHash({ hashHex, signer } = {}) {
  if (!signer || typeof signer !== "object" || Array.isArray(signer)) throw new TypeError("signer is required");
  assertNonEmptyString(signer.keyId, "signer.keyId");
  assertNonEmptyString(signer.privateKeyPem, "signer.privateKeyPem");
  const signature = signHashHexEd25519(hashHex, signer.privateKeyPem);
  return {
    signerKeyId: String(signer.keyId),
    signedAt: new Date().toISOString(),
    signature
  };
}

function verifyObjectSignature({ hashHex, signature, publicKeyPem } = {}) {
  assertNonEmptyString(hashHex, "hashHex");
  assertPlainObject(signature, "signature");
  assertNonEmptyString(signature.signature, "signature.signature");
  assertNonEmptyString(publicKeyPem, "publicKeyPem");
  const ok = verifyHashHexEd25519({ hashHex, signatureBase64: signature.signature, publicKeyPem });
  if (!ok) throw new TypeError("signature invalid");
  return true;
}

export function computeFundingHoldHashV1(holdCore) {
  return computeSignedObjectHash({ obj: holdCore, hashField: "holdHash", signatureField: "signature" });
}

export function buildFundingHoldV1({
  tenantId,
  artifactId,
  agreementId,
  agreementHash,
  payerAgentId,
  amountCents,
  currency,
  lockedAt,
  expiresAt,
  signer
} = {}) {
  const at = lockedAt ?? new Date().toISOString();
  assertIsoDate(at, "lockedAt");
  const exp = expiresAt === undefined ? undefined : expiresAt;
  if (exp !== undefined && exp !== null) assertIsoDate(exp, "expiresAt");
  if (exp === null) throw new TypeError("expiresAt must be omitted or an ISO date string");
  const amt = assertNonNegativeSafeInt(amountCents, "amountCents");
  if (amt <= 0) throw new TypeError("amountCents must be positive");

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: FUNDING_HOLD_SCHEMA_VERSION,
      artifactType: FUNDING_HOLD_SCHEMA_VERSION,
      artifactId: normalizeId(artifactId, "artifactId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      agreement: {
        artifactId: normalizeId(agreementId, "agreementId", { min: 3, max: 128 }),
        agreementHash: normalizeHexHash(agreementHash, "agreementHash")
      },
      payerAgentId: normalizeActorId(payerAgentId, "payerAgentId"),
      amountCents: amt,
      currency: normalizeCurrency(currency, "currency"),
      lockedAt: at,
      ...(exp === undefined ? {} : { expiresAt: exp })
    },
    { path: "$" }
  );

  const holdHash = computeFundingHoldHashV1(normalized);
  const signature = signObjectHash({ hashHex: holdHash, signer });
  signature.signedAt = at;
  return normalizeForCanonicalJson({ ...normalized, holdHash, signature }, { path: "$" });
}

export function validateFundingHoldV1(hold) {
  assertPlainObject(hold, "hold");
  if (hold.schemaVersion !== FUNDING_HOLD_SCHEMA_VERSION) {
    throw new TypeError(`hold.schemaVersion must be ${FUNDING_HOLD_SCHEMA_VERSION}`);
  }
  normalizeId(hold.artifactId, "hold.artifactId", { min: 3, max: 128 });
  normalizeId(hold.tenantId, "hold.tenantId", { min: 1, max: 128 });
  assertPlainObject(hold.agreement, "hold.agreement");
  normalizeId(hold.agreement.artifactId, "hold.agreement.artifactId", { min: 3, max: 128 });
  normalizeHexHash(hold.agreement.agreementHash, "hold.agreement.agreementHash");
  normalizeActorId(hold.payerAgentId, "hold.payerAgentId");
  const amt = assertNonNegativeSafeInt(hold.amountCents, "hold.amountCents");
  if (amt <= 0) throw new TypeError("hold.amountCents must be positive");
  normalizeCurrency(hold.currency, "hold.currency");
  assertIsoDate(hold.lockedAt, "hold.lockedAt");
  if (hold.expiresAt !== undefined) assertIsoDate(hold.expiresAt, "hold.expiresAt");
  const hash = normalizeHexHash(hold.holdHash, "hold.holdHash");
  assertPlainObject(hold.signature, "hold.signature");
  assertNonEmptyString(hold.signature.signerKeyId, "hold.signature.signerKeyId");
  assertIsoDate(hold.signature.signedAt, "hold.signature.signedAt");
  assertNonEmptyString(hold.signature.signature, "hold.signature.signature");

  const computed = computeFundingHoldHashV1(hold);
  if (computed !== hash) throw new TypeError("holdHash mismatch");
  return true;
}

export function verifyFundingHoldV1({ hold, publicKeyPem } = {}) {
  validateFundingHoldV1(hold);
  verifyObjectSignature({ hashHex: hold.holdHash, signature: hold.signature, publicKeyPem });
  return true;
}

export function computeToolCallAgreementHashV1(agreementCore) {
  return computeSignedObjectHash({ obj: agreementCore, hashField: "agreementHash", signatureField: "signature" });
}

export function buildToolCallAgreementV1({
  tenantId,
  artifactId,
  toolId,
  toolManifestHash,
  authorityGrantId,
  authorityGrantHash,
  payerAgentId,
  payeeAgentId,
  amountCents,
  currency,
  createdAt,
  callId,
  input,
  inputHash,
  acceptanceCriteria,
  settlementTerms,
  signer
} = {}) {
  const at = createdAt ?? new Date().toISOString();
  assertIsoDate(at, "createdAt");
  const normalizedCallId = normalizeId(callId, "callId", { min: 3, max: 128 });
  const effectiveInputHash =
    typeof inputHash === "string" && inputHash.trim() !== ""
      ? normalizeHexHash(inputHash, "inputHash")
      : computeToolCallInputHashV1(input);

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_CALL_AGREEMENT_SCHEMA_VERSION,
      artifactType: TOOL_CALL_AGREEMENT_SCHEMA_VERSION,
      artifactId: normalizeId(artifactId, "artifactId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      toolId: normalizeId(toolId, "toolId", { min: 3, max: 128 }),
      toolManifestHash: normalizeHexHash(toolManifestHash, "toolManifestHash"),
      authorityGrantId: normalizeId(authorityGrantId, "authorityGrantId", { min: 3, max: 128 }),
      authorityGrantHash: normalizeHexHash(authorityGrantHash, "authorityGrantHash"),
      payerAgentId: normalizeActorId(payerAgentId, "payerAgentId"),
      payeeAgentId: normalizeActorId(payeeAgentId, "payeeAgentId"),
      amountCents: assertNonNegativeSafeInt(amountCents, "amountCents"),
      currency: normalizeCurrency(currency, "currency"),
      callId: normalizedCallId,
      inputHash: effectiveInputHash,
      acceptanceCriteria: normalizeAcceptanceCriteria(acceptanceCriteria),
      ...(normalizeSettlementTerms(settlementTerms) === undefined ? {} : { settlementTerms: normalizeSettlementTerms(settlementTerms) }),
      createdAt: at
    },
    { path: "$" }
  );

  const agreementHash = computeToolCallAgreementHashV1(normalized);
  const signature = signObjectHash({ hashHex: agreementHash, signer });
  signature.signedAt = at;

  return normalizeForCanonicalJson({ ...normalized, agreementHash, signature }, { path: "$" });
}

export function validateToolCallAgreementV1(agreement) {
  assertPlainObject(agreement, "agreement");
  if (agreement.schemaVersion !== TOOL_CALL_AGREEMENT_SCHEMA_VERSION) {
    throw new TypeError(`agreement.schemaVersion must be ${TOOL_CALL_AGREEMENT_SCHEMA_VERSION}`);
  }
  normalizeId(agreement.artifactId, "agreement.artifactId", { min: 3, max: 128 });
  normalizeId(agreement.tenantId, "agreement.tenantId", { min: 1, max: 128 });
  normalizeId(agreement.toolId, "agreement.toolId", { min: 3, max: 128 });
  normalizeHexHash(agreement.toolManifestHash, "agreement.toolManifestHash");
  normalizeId(agreement.authorityGrantId, "agreement.authorityGrantId", { min: 3, max: 128 });
  normalizeHexHash(agreement.authorityGrantHash, "agreement.authorityGrantHash");
  normalizeActorId(agreement.payerAgentId, "agreement.payerAgentId");
  normalizeActorId(agreement.payeeAgentId, "agreement.payeeAgentId");
  assertNonNegativeSafeInt(agreement.amountCents, "agreement.amountCents");
  normalizeCurrency(agreement.currency, "agreement.currency");
  normalizeId(agreement.callId, "agreement.callId", { min: 3, max: 128 });
  normalizeHexHash(agreement.inputHash, "agreement.inputHash");
  if (agreement.acceptanceCriteria !== null && agreement.acceptanceCriteria !== undefined) {
    normalizeAcceptanceCriteria(agreement.acceptanceCriteria);
  }
  if (agreement.settlementTerms !== undefined) {
    normalizeSettlementTerms(agreement.settlementTerms);
  }
  assertIsoDate(agreement.createdAt, "agreement.createdAt");
  const hash = normalizeHexHash(agreement.agreementHash, "agreement.agreementHash");
  assertPlainObject(agreement.signature, "agreement.signature");
  assertNonEmptyString(agreement.signature.signerKeyId, "agreement.signature.signerKeyId");
  assertIsoDate(agreement.signature.signedAt, "agreement.signature.signedAt");
  assertNonEmptyString(agreement.signature.signature, "agreement.signature.signature");

  const computed = computeToolCallAgreementHashV1(agreement);
  if (computed !== hash) throw new TypeError("agreementHash mismatch");
  return true;
}

export function verifyToolCallAgreementV1({ agreement, publicKeyPem } = {}) {
  validateToolCallAgreementV1(agreement);
  verifyObjectSignature({ hashHex: agreement.agreementHash, signature: agreement.signature, publicKeyPem });
  return true;
}

export function computeToolCallEvidenceHashV1(evidenceCore) {
  return computeSignedObjectHash({ obj: evidenceCore, hashField: "evidenceHash", signatureField: "signature" });
}

export function buildToolCallEvidenceV1({
  tenantId,
  artifactId,
  toolId,
  toolManifestHash,
  agreementId,
  agreementHash,
  callId,
  input,
  inputHash,
  output,
  startedAt,
  completedAt,
  signer
} = {}) {
  const start = startedAt ?? new Date().toISOString();
  const end = completedAt ?? start;
  assertIsoDate(start, "startedAt");
  assertIsoDate(end, "completedAt");
  const normalizedCallId = normalizeId(callId, "callId", { min: 3, max: 128 });
  const effectiveInputHash =
    typeof inputHash === "string" && inputHash.trim() !== ""
      ? normalizeHexHash(inputHash, "inputHash")
      : computeToolCallInputHashV1(input);

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_CALL_EVIDENCE_SCHEMA_VERSION,
      artifactType: TOOL_CALL_EVIDENCE_SCHEMA_VERSION,
      artifactId: normalizeId(artifactId, "artifactId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      toolId: normalizeId(toolId, "toolId", { min: 3, max: 128 }),
      toolManifestHash: normalizeHexHash(toolManifestHash, "toolManifestHash"),
      agreement: {
        artifactId: normalizeId(agreementId, "agreementId", { min: 3, max: 128 }),
        agreementHash: normalizeHexHash(agreementHash, "agreementHash")
      },
      call: {
        callId: normalizedCallId,
        inputHash: effectiveInputHash,
        input: input ?? null,
        output: output ?? null,
        startedAt: start,
        completedAt: end
      }
    },
    { path: "$" }
  );

  const evidenceHash = computeToolCallEvidenceHashV1(normalized);
  const signature = signObjectHash({ hashHex: evidenceHash, signer });
  signature.signedAt = end;
  return normalizeForCanonicalJson({ ...normalized, evidenceHash, signature }, { path: "$" });
}

export function validateToolCallEvidenceV1(evidence) {
  assertPlainObject(evidence, "evidence");
  if (evidence.schemaVersion !== TOOL_CALL_EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError(`evidence.schemaVersion must be ${TOOL_CALL_EVIDENCE_SCHEMA_VERSION}`);
  }
  normalizeId(evidence.artifactId, "evidence.artifactId", { min: 3, max: 128 });
  normalizeId(evidence.tenantId, "evidence.tenantId", { min: 1, max: 128 });
  normalizeId(evidence.toolId, "evidence.toolId", { min: 3, max: 128 });
  normalizeHexHash(evidence.toolManifestHash, "evidence.toolManifestHash");
  assertPlainObject(evidence.agreement, "evidence.agreement");
  normalizeId(evidence.agreement.artifactId, "evidence.agreement.artifactId", { min: 3, max: 128 });
  normalizeHexHash(evidence.agreement.agreementHash, "evidence.agreement.agreementHash");
  assertPlainObject(evidence.call, "evidence.call");
  normalizeId(evidence.call.callId, "evidence.call.callId", { min: 3, max: 128 });
  normalizeHexHash(evidence.call.inputHash, "evidence.call.inputHash");
  assertIsoDate(evidence.call.startedAt, "evidence.call.startedAt");
  assertIsoDate(evidence.call.completedAt, "evidence.call.completedAt");
  const hash = normalizeHexHash(evidence.evidenceHash, "evidence.evidenceHash");
  assertPlainObject(evidence.signature, "evidence.signature");
  assertNonEmptyString(evidence.signature.signerKeyId, "evidence.signature.signerKeyId");
  assertIsoDate(evidence.signature.signedAt, "evidence.signature.signedAt");
  assertNonEmptyString(evidence.signature.signature, "evidence.signature.signature");

  const computed = computeToolCallEvidenceHashV1(evidence);
  if (computed !== hash) throw new TypeError("evidenceHash mismatch");
  return true;
}

export function verifyToolCallEvidenceV1({ evidence, publicKeyPem } = {}) {
  validateToolCallEvidenceV1(evidence);
  verifyObjectSignature({ hashHex: evidence.evidenceHash, signature: evidence.signature, publicKeyPem });
  return true;
}

export function computeSettlementDecisionRecordHashV1(recordCore) {
  return computeSignedObjectHash({ obj: recordCore, hashField: "recordHash", signatureField: "signature" });
}

export function buildSettlementDecisionRecordV1({
  tenantId,
  artifactId,
  agreementId,
  agreementHash,
  evidenceId,
  evidenceHash,
  decision,
  modality = "cryptographic",
  verifierRef = null,
  policyRef = null,
  reasonCodes = [],
  evaluationSummary = null,
  decidedAt,
  signer
} = {}) {
  const at = decidedAt ?? new Date().toISOString();
  assertIsoDate(at, "decidedAt");
  const normalizedDecision = typeof decision === "string" ? decision.trim().toLowerCase() : "";
  if (!["approved", "held", "rejected"].includes(normalizedDecision)) {
    throw new TypeError("decision must be approved|held|rejected");
  }
  const normalizedModality = typeof modality === "string" ? modality.trim().toLowerCase() : "";
  if (!["cryptographic", "deterministic", "attested", "manual"].includes(normalizedModality)) {
    throw new TypeError("modality must be cryptographic|deterministic|attested|manual");
  }
  if (!Array.isArray(reasonCodes)) throw new TypeError("reasonCodes must be an array");
  const normalizedReasonCodes = [];
  for (const code of reasonCodes) {
    if (typeof code !== "string" || code.trim() === "") throw new TypeError("reasonCodes[] must be non-empty strings");
    if (code.length > 128) throw new TypeError("reasonCodes[] must be <= 128 chars");
    normalizedReasonCodes.push(code);
  }

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION,
      artifactType: SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION,
      artifactId: normalizeId(artifactId, "artifactId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      agreement: {
        artifactId: normalizeId(agreementId, "agreementId", { min: 3, max: 128 }),
        agreementHash: normalizeHexHash(agreementHash, "agreementHash")
      },
      evidence: {
        artifactId: normalizeId(evidenceId, "evidenceId", { min: 3, max: 128 }),
        evidenceHash: normalizeHexHash(evidenceHash, "evidenceHash")
      },
      decision: normalizedDecision,
      modality: normalizedModality,
      verifierRef: verifierRef && typeof verifierRef === "object" && !Array.isArray(verifierRef) ? verifierRef : null,
      policyRef: policyRef && typeof policyRef === "object" && !Array.isArray(policyRef) ? policyRef : null,
      reasonCodes: normalizedReasonCodes,
      evaluationSummary: evaluationSummary && typeof evaluationSummary === "object" && !Array.isArray(evaluationSummary) ? evaluationSummary : null,
      decidedAt: at
    },
    { path: "$" }
  );

  const recordHash = computeSettlementDecisionRecordHashV1(normalized);
  const signature = signObjectHash({ hashHex: recordHash, signer });
  signature.signedAt = at;
  return normalizeForCanonicalJson({ ...normalized, recordHash, signature }, { path: "$" });
}

export function validateSettlementDecisionRecordV1(record) {
  assertPlainObject(record, "record");
  if (record.schemaVersion !== SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION) {
    throw new TypeError(`record.schemaVersion must be ${SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION}`);
  }
  normalizeId(record.artifactId, "record.artifactId", { min: 3, max: 128 });
  normalizeId(record.tenantId, "record.tenantId", { min: 1, max: 128 });
  assertPlainObject(record.agreement, "record.agreement");
  normalizeId(record.agreement.artifactId, "record.agreement.artifactId", { min: 3, max: 128 });
  normalizeHexHash(record.agreement.agreementHash, "record.agreement.agreementHash");
  assertPlainObject(record.evidence, "record.evidence");
  normalizeId(record.evidence.artifactId, "record.evidence.artifactId", { min: 3, max: 128 });
  normalizeHexHash(record.evidence.evidenceHash, "record.evidence.evidenceHash");
  const decision = typeof record.decision === "string" ? record.decision.trim().toLowerCase() : "";
  if (!["approved", "held", "rejected"].includes(decision)) throw new TypeError("record.decision must be approved|held|rejected");
  const modality = typeof record.modality === "string" ? record.modality.trim().toLowerCase() : "";
  if (!["cryptographic", "deterministic", "attested", "manual"].includes(modality)) {
    throw new TypeError("record.modality must be cryptographic|deterministic|attested|manual");
  }
  if (!Array.isArray(record.reasonCodes)) throw new TypeError("record.reasonCodes must be an array");
  for (const code of record.reasonCodes) {
    if (typeof code !== "string" || code.trim() === "") throw new TypeError("record.reasonCodes[] must be non-empty strings");
  }
  assertIsoDate(record.decidedAt, "record.decidedAt");
  const hash = normalizeHexHash(record.recordHash, "record.recordHash");
  assertPlainObject(record.signature, "record.signature");
  assertNonEmptyString(record.signature.signerKeyId, "record.signature.signerKeyId");
  assertIsoDate(record.signature.signedAt, "record.signature.signedAt");
  assertNonEmptyString(record.signature.signature, "record.signature.signature");

  const computed = computeSettlementDecisionRecordHashV1(record);
  if (computed !== hash) throw new TypeError("recordHash mismatch");
  return true;
}

export function verifySettlementDecisionRecordV1({ record, publicKeyPem } = {}) {
  validateSettlementDecisionRecordV1(record);
  verifyObjectSignature({ hashHex: record.recordHash, signature: record.signature, publicKeyPem });
  return true;
}

export function computeSettlementReceiptHashV1(receiptCore) {
  return computeSignedObjectHash({ obj: receiptCore, hashField: "receiptHash", signatureField: "signature" });
}

export function buildSettlementReceiptV1({
  tenantId,
  artifactId,
  agreementId,
  agreementHash,
  decisionId,
  decisionHash,
  payerAgentId,
  payeeAgentId,
  amountCents,
  currency,
  settledAt,
  ledger = null,
  signer
} = {}) {
  const at = settledAt ?? new Date().toISOString();
  assertIsoDate(at, "settledAt");

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: SETTLEMENT_RECEIPT_SCHEMA_VERSION,
      artifactType: SETTLEMENT_RECEIPT_SCHEMA_VERSION,
      artifactId: normalizeId(artifactId, "artifactId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      agreement: {
        artifactId: normalizeId(agreementId, "agreementId", { min: 3, max: 128 }),
        agreementHash: normalizeHexHash(agreementHash, "agreementHash")
      },
      decision: {
        artifactId: normalizeId(decisionId, "decisionId", { min: 3, max: 128 }),
        recordHash: normalizeHexHash(decisionHash, "decisionHash")
      },
      transfer: {
        payerAgentId: normalizeActorId(payerAgentId, "payerAgentId"),
        payeeAgentId: normalizeActorId(payeeAgentId, "payeeAgentId"),
        amountCents: assertNonNegativeSafeInt(amountCents, "amountCents"),
        currency: normalizeCurrency(currency, "currency")
      },
      ledger: ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : null,
      settledAt: at
    },
    { path: "$" }
  );

  const receiptHash = computeSettlementReceiptHashV1(normalized);
  const signature = signObjectHash({ hashHex: receiptHash, signer });
  signature.signedAt = at;
  return normalizeForCanonicalJson({ ...normalized, receiptHash, signature }, { path: "$" });
}

export function validateSettlementReceiptV1(receipt) {
  assertPlainObject(receipt, "receipt");
  if (receipt.schemaVersion !== SETTLEMENT_RECEIPT_SCHEMA_VERSION) {
    throw new TypeError(`receipt.schemaVersion must be ${SETTLEMENT_RECEIPT_SCHEMA_VERSION}`);
  }
  normalizeId(receipt.artifactId, "receipt.artifactId", { min: 3, max: 128 });
  normalizeId(receipt.tenantId, "receipt.tenantId", { min: 1, max: 128 });
  assertPlainObject(receipt.agreement, "receipt.agreement");
  normalizeId(receipt.agreement.artifactId, "receipt.agreement.artifactId", { min: 3, max: 128 });
  normalizeHexHash(receipt.agreement.agreementHash, "receipt.agreement.agreementHash");
  assertPlainObject(receipt.decision, "receipt.decision");
  normalizeId(receipt.decision.artifactId, "receipt.decision.artifactId", { min: 3, max: 128 });
  normalizeHexHash(receipt.decision.recordHash, "receipt.decision.recordHash");
  assertPlainObject(receipt.transfer, "receipt.transfer");
  normalizeActorId(receipt.transfer.payerAgentId, "receipt.transfer.payerAgentId");
  normalizeActorId(receipt.transfer.payeeAgentId, "receipt.transfer.payeeAgentId");
  assertNonNegativeSafeInt(receipt.transfer.amountCents, "receipt.transfer.amountCents");
  normalizeCurrency(receipt.transfer.currency, "receipt.transfer.currency");
  assertIsoDate(receipt.settledAt, "receipt.settledAt");
  const hash = normalizeHexHash(receipt.receiptHash, "receipt.receiptHash");
  assertPlainObject(receipt.signature, "receipt.signature");
  assertNonEmptyString(receipt.signature.signerKeyId, "receipt.signature.signerKeyId");
  assertIsoDate(receipt.signature.signedAt, "receipt.signature.signedAt");
  assertNonEmptyString(receipt.signature.signature, "receipt.signature.signature");

  const computed = computeSettlementReceiptHashV1(receipt);
  if (computed !== hash) throw new TypeError("receiptHash mismatch");
  return true;
}

export function verifySettlementReceiptV1({ receipt, publicKeyPem } = {}) {
  validateSettlementReceiptV1(receipt);
  verifyObjectSignature({ hashHex: receipt.receiptHash, signature: receipt.signature, publicKeyPem });
  return true;
}

export function computeSettlementReceiptHashV2(receiptCore) {
  return computeSignedObjectHash({ obj: receiptCore, hashField: "receiptHash", signatureField: "signature" });
}

export function buildSettlementReceiptV2({
  tenantId,
  artifactId,
  agreementId,
  agreementHash,
  decisionId,
  decisionHash,
  payerAgentId,
  payeeAgentId,
  amountCents,
  currency,
  agreementAmountCents,
  outcome,
  retention,
  ledger,
  settledAt,
  signer
} = {}) {
  const at = settledAt ?? new Date().toISOString();
  assertIsoDate(at, "settledAt");

  const normalizedOutcome = String(outcome ?? "").trim().toLowerCase();
  const outcomes = new Set(["paid", "not_paid", "expired", "reversed"]);
  if (!outcomes.has(normalizedOutcome)) throw new TypeError("outcome must be one of paid|not_paid|expired|reversed");

  const total = assertNonNegativeSafeInt(agreementAmountCents, "agreementAmountCents");
  const transferred = assertNonNegativeSafeInt(amountCents, "amountCents");
  if (transferred > total) throw new TypeError("amountCents exceeds agreementAmountCents");

  let normalizedRetention = undefined;
  if (retention !== null && retention !== undefined) {
    if (!retention || typeof retention !== "object" || Array.isArray(retention)) throw new TypeError("retention must be an object");
    const heldAmountCents = assertNonNegativeSafeInt(retention.heldAmountCents, "retention.heldAmountCents");
    if (heldAmountCents <= 0) throw new TypeError("retention.heldAmountCents must be positive");
    const holdbackBps = assertNonNegativeSafeInt(retention.holdbackBps, "retention.holdbackBps");
    if (holdbackBps > 10_000) throw new TypeError("retention.holdbackBps must be <= 10000");
    const challengeWindowMs = assertNonNegativeSafeInt(retention.challengeWindowMs, "retention.challengeWindowMs");
    if (challengeWindowMs <= 0) throw new TypeError("retention.challengeWindowMs must be positive");
    assertIsoDate(retention.challengeUntil, "retention.challengeUntil");
    normalizedRetention = normalizeForCanonicalJson({ heldAmountCents, holdbackBps, challengeWindowMs, challengeUntil: retention.challengeUntil }, { path: "$" });
  }

  if (normalizedOutcome === "paid") {
    const held = normalizedRetention ? Number(normalizedRetention.heldAmountCents) : 0;
    if (transferred + held !== total) throw new TypeError("paid outcome requires transfer + held to equal agreementAmountCents");
  } else {
    if (normalizedRetention) throw new TypeError("retention must be omitted when outcome is not paid");
    if (transferred !== 0) throw new TypeError("non-paid outcome requires amountCents = 0");
  }

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: SETTLEMENT_RECEIPT_V2_SCHEMA_VERSION,
      artifactType: SETTLEMENT_RECEIPT_V2_SCHEMA_VERSION,
      artifactId: normalizeId(artifactId, "artifactId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      agreement: {
        artifactId: normalizeId(agreementId, "agreementId", { min: 3, max: 128 }),
        agreementHash: normalizeHexHash(agreementHash, "agreementHash")
      },
      decision: {
        artifactId: normalizeId(decisionId, "decisionId", { min: 3, max: 128 }),
        recordHash: normalizeHexHash(decisionHash, "decisionHash")
      },
      transfer: {
        payerAgentId: normalizeActorId(payerAgentId, "payerAgentId"),
        payeeAgentId: normalizeActorId(payeeAgentId, "payeeAgentId"),
        amountCents: transferred,
        currency: normalizeCurrency(currency, "currency")
      },
      agreementAmountCents: total,
      outcome: normalizedOutcome,
      ...(normalizedRetention ? { retention: normalizedRetention } : {}),
      ledger: ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : null,
      settledAt: at
    },
    { path: "$" }
  );

  const receiptHash = computeSettlementReceiptHashV2(normalized);
  const signature = signObjectHash({ hashHex: receiptHash, signer });
  signature.signedAt = at;
  return normalizeForCanonicalJson({ ...normalized, receiptHash, signature }, { path: "$" });
}

export function validateSettlementReceiptV2(receipt) {
  assertPlainObject(receipt, "receipt");
  if (receipt.schemaVersion !== SETTLEMENT_RECEIPT_V2_SCHEMA_VERSION) {
    throw new TypeError(`receipt.schemaVersion must be ${SETTLEMENT_RECEIPT_V2_SCHEMA_VERSION}`);
  }
  normalizeId(receipt.artifactId, "receipt.artifactId", { min: 3, max: 128 });
  normalizeId(receipt.tenantId, "receipt.tenantId", { min: 1, max: 128 });
  assertPlainObject(receipt.agreement, "receipt.agreement");
  normalizeId(receipt.agreement.artifactId, "receipt.agreement.artifactId", { min: 3, max: 128 });
  normalizeHexHash(receipt.agreement.agreementHash, "receipt.agreement.agreementHash");
  assertPlainObject(receipt.decision, "receipt.decision");
  normalizeId(receipt.decision.artifactId, "receipt.decision.artifactId", { min: 3, max: 128 });
  normalizeHexHash(receipt.decision.recordHash, "receipt.decision.recordHash");
  assertPlainObject(receipt.transfer, "receipt.transfer");
  normalizeActorId(receipt.transfer.payerAgentId, "receipt.transfer.payerAgentId");
  normalizeActorId(receipt.transfer.payeeAgentId, "receipt.transfer.payeeAgentId");
  const transferred = assertNonNegativeSafeInt(receipt.transfer.amountCents, "receipt.transfer.amountCents");
  normalizeCurrency(receipt.transfer.currency, "receipt.transfer.currency");
  const total = assertNonNegativeSafeInt(receipt.agreementAmountCents, "receipt.agreementAmountCents");
  if (transferred > total) throw new TypeError("receipt.transfer.amountCents exceeds receipt.agreementAmountCents");
  const outcome = String(receipt.outcome ?? "").trim().toLowerCase();
  const outcomes = new Set(["paid", "not_paid", "expired", "reversed"]);
  if (!outcomes.has(outcome)) throw new TypeError("receipt.outcome must be one of paid|not_paid|expired|reversed");
  if (receipt.retention !== undefined) {
    if (!receipt.retention || typeof receipt.retention !== "object" || Array.isArray(receipt.retention)) throw new TypeError("receipt.retention must be an object");
    const heldAmountCents = assertNonNegativeSafeInt(receipt.retention.heldAmountCents, "receipt.retention.heldAmountCents");
    if (heldAmountCents <= 0) throw new TypeError("receipt.retention.heldAmountCents must be positive");
    const holdbackBps = assertNonNegativeSafeInt(receipt.retention.holdbackBps, "receipt.retention.holdbackBps");
    if (holdbackBps > 10_000) throw new TypeError("receipt.retention.holdbackBps must be <= 10000");
    const challengeWindowMs = assertNonNegativeSafeInt(receipt.retention.challengeWindowMs, "receipt.retention.challengeWindowMs");
    if (challengeWindowMs <= 0) throw new TypeError("receipt.retention.challengeWindowMs must be positive");
    assertIsoDate(receipt.retention.challengeUntil, "receipt.retention.challengeUntil");
  }
  if (outcome === "paid") {
    const held = receipt.retention ? Number(receipt.retention.heldAmountCents ?? 0) : 0;
    if (transferred + held !== total) throw new TypeError("paid receipt must satisfy transfer + held == agreementAmountCents");
  } else {
    if (receipt.retention !== undefined) throw new TypeError("receipt.retention must be omitted when outcome is not paid");
    if (transferred !== 0) throw new TypeError("non-paid receipt requires transfer.amountCents = 0");
  }
  assertIsoDate(receipt.settledAt, "receipt.settledAt");
  const hash = normalizeHexHash(receipt.receiptHash, "receipt.receiptHash");
  assertPlainObject(receipt.signature, "receipt.signature");
  assertNonEmptyString(receipt.signature.signerKeyId, "receipt.signature.signerKeyId");
  assertIsoDate(receipt.signature.signedAt, "receipt.signature.signedAt");
  assertNonEmptyString(receipt.signature.signature, "receipt.signature.signature");

  const computed = computeSettlementReceiptHashV2(receipt);
  if (computed !== hash) throw new TypeError("receiptHash mismatch");
  return true;
}

export function verifySettlementReceiptV2({ receipt, publicKeyPem } = {}) {
  validateSettlementReceiptV2(receipt);
  verifyObjectSignature({ hashHex: receipt.receiptHash, signature: receipt.signature, publicKeyPem });
  return true;
}

export function computeSettlementAdjustmentHashV1(adjustmentCore) {
  return computeSignedObjectHash({ obj: adjustmentCore, hashField: "adjustmentHash", signatureField: "signature" });
}

export function buildSettlementAdjustmentV1({
  tenantId,
  artifactId,
  agreementId,
  agreementHash,
  receiptId,
  receiptHash,
  payerAgentId,
  payeeAgentId,
  currency,
  kind,
  releaseToPayeeCents,
  refundToPayerCents,
  appliedAt,
  ledger,
  signer
} = {}) {
  const at = appliedAt ?? new Date().toISOString();
  assertIsoDate(at, "appliedAt");

  const normalizedKind = normalizeId(kind, "kind", { min: 3, max: 64 }).toLowerCase();
  const kinds = new Set(["holdback_release", "holdback_refund", "holdback_split"]);
  if (!kinds.has(normalizedKind)) throw new TypeError("kind must be holdback_release|holdback_refund|holdback_split");

  const rel = assertNonNegativeSafeInt(releaseToPayeeCents ?? 0, "releaseToPayeeCents");
  const ref = assertNonNegativeSafeInt(refundToPayerCents ?? 0, "refundToPayerCents");
  if (rel === 0 && ref === 0) throw new TypeError("at least one of releaseToPayeeCents or refundToPayerCents must be positive");

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: SETTLEMENT_ADJUSTMENT_SCHEMA_VERSION,
      artifactType: SETTLEMENT_ADJUSTMENT_SCHEMA_VERSION,
      artifactId: normalizeId(artifactId, "artifactId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      agreement: {
        artifactId: normalizeId(agreementId, "agreementId", { min: 3, max: 128 }),
        agreementHash: normalizeHexHash(agreementHash, "agreementHash")
      },
      receipt: {
        artifactId: normalizeId(receiptId, "receiptId", { min: 3, max: 128 }),
        receiptHash: normalizeHexHash(receiptHash, "receiptHash")
      },
      payerAgentId: normalizeActorId(payerAgentId, "payerAgentId"),
      payeeAgentId: normalizeActorId(payeeAgentId, "payeeAgentId"),
      currency: normalizeCurrency(currency, "currency"),
      kind: normalizedKind,
      amounts: { releaseToPayeeCents: rel, refundToPayerCents: ref },
      ledger: ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : null,
      appliedAt: at
    },
    { path: "$" }
  );

  const adjustmentHash = computeSettlementAdjustmentHashV1(normalized);
  const signature = signObjectHash({ hashHex: adjustmentHash, signer });
  signature.signedAt = at;
  return normalizeForCanonicalJson({ ...normalized, adjustmentHash, signature }, { path: "$" });
}

export function validateSettlementAdjustmentV1(adjustment) {
  assertPlainObject(adjustment, "adjustment");
  if (adjustment.schemaVersion !== SETTLEMENT_ADJUSTMENT_SCHEMA_VERSION) {
    throw new TypeError(`adjustment.schemaVersion must be ${SETTLEMENT_ADJUSTMENT_SCHEMA_VERSION}`);
  }
  normalizeId(adjustment.artifactId, "adjustment.artifactId", { min: 3, max: 128 });
  normalizeId(adjustment.tenantId, "adjustment.tenantId", { min: 1, max: 128 });
  assertPlainObject(adjustment.agreement, "adjustment.agreement");
  normalizeId(adjustment.agreement.artifactId, "adjustment.agreement.artifactId", { min: 3, max: 128 });
  normalizeHexHash(adjustment.agreement.agreementHash, "adjustment.agreement.agreementHash");
  assertPlainObject(adjustment.receipt, "adjustment.receipt");
  normalizeId(adjustment.receipt.artifactId, "adjustment.receipt.artifactId", { min: 3, max: 128 });
  normalizeHexHash(adjustment.receipt.receiptHash, "adjustment.receipt.receiptHash");
  normalizeActorId(adjustment.payerAgentId, "adjustment.payerAgentId");
  normalizeActorId(adjustment.payeeAgentId, "adjustment.payeeAgentId");
  normalizeCurrency(adjustment.currency, "adjustment.currency");
  const kind = normalizeId(adjustment.kind, "adjustment.kind", { min: 3, max: 64 }).toLowerCase();
  const kinds = new Set(["holdback_release", "holdback_refund", "holdback_split"]);
  if (!kinds.has(kind)) throw new TypeError("adjustment.kind must be holdback_release|holdback_refund|holdback_split");
  assertPlainObject(adjustment.amounts, "adjustment.amounts");
  const rel = assertNonNegativeSafeInt(adjustment.amounts.releaseToPayeeCents ?? 0, "adjustment.amounts.releaseToPayeeCents");
  const ref = assertNonNegativeSafeInt(adjustment.amounts.refundToPayerCents ?? 0, "adjustment.amounts.refundToPayerCents");
  if (rel === 0 && ref === 0) throw new TypeError("adjustment.amounts must include a non-zero releaseToPayeeCents and/or refundToPayerCents");
  assertIsoDate(adjustment.appliedAt, "adjustment.appliedAt");
  const hash = normalizeHexHash(adjustment.adjustmentHash, "adjustment.adjustmentHash");
  assertPlainObject(adjustment.signature, "adjustment.signature");
  assertNonEmptyString(adjustment.signature.signerKeyId, "adjustment.signature.signerKeyId");
  assertIsoDate(adjustment.signature.signedAt, "adjustment.signature.signedAt");
  assertNonEmptyString(adjustment.signature.signature, "adjustment.signature.signature");

  const computed = computeSettlementAdjustmentHashV1(adjustment);
  if (computed !== hash) throw new TypeError("adjustmentHash mismatch");
  return true;
}

export function verifySettlementAdjustmentV1({ adjustment, publicKeyPem } = {}) {
  validateSettlementAdjustmentV1(adjustment);
  verifyObjectSignature({ hashHex: adjustment.adjustmentHash, signature: adjustment.signature, publicKeyPem });
  return true;
}

function normalizeUniqueStringArray(value, name, { maxItems = 1000, maxLen = 512 } = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > maxItems) throw new TypeError(`${name} must have <= ${maxItems} items`);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== "string" || item.trim() === "") throw new TypeError(`${name}[${i}] must be a non-empty string`);
    const normalized = item.trim();
    if (normalized.length > maxLen) throw new TypeError(`${name}[${i}] must be length <= ${maxLen}`);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function computeToolCallDisputeOpenHashV1(disputeCore) {
  return computeSignedObjectHash({ obj: disputeCore, hashField: "disputeHash", signatureField: "signature" });
}

export function buildToolCallDisputeOpenV1({
  tenantId,
  artifactId,
  toolId,
  agreementId,
  agreementHash,
  receiptId,
  receiptHash,
  openedByAgentId,
  reasonCode = null,
  reason = null,
  evidenceRefs = [],
  openedAt,
  signer
} = {}) {
  const at = openedAt ?? new Date().toISOString();
  assertIsoDate(at, "openedAt");

  const normalizedReasonCode =
    reasonCode === null || reasonCode === undefined
      ? null
      : typeof reasonCode === "string" && reasonCode.trim() !== ""
        ? reasonCode.trim()
        : null;
  if (reasonCode !== null && reasonCode !== undefined && !normalizedReasonCode) throw new TypeError("reasonCode must be a non-empty string when provided");

  const normalizedReason =
    reason === null || reason === undefined
      ? null
      : typeof reason === "string" && reason.trim() !== ""
        ? reason.trim()
        : null;
  if (reason !== null && reason !== undefined && !normalizedReason) throw new TypeError("reason must be a non-empty string when provided");

  const normalizedEvidenceRefs = normalizeUniqueStringArray(evidenceRefs ?? [], "evidenceRefs");

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_CALL_DISPUTE_OPEN_SCHEMA_VERSION,
      artifactType: TOOL_CALL_DISPUTE_OPEN_SCHEMA_VERSION,
      artifactId: normalizeId(artifactId, "artifactId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      toolId: normalizeId(toolId, "toolId", { min: 3, max: 128 }),
      agreement: {
        artifactId: normalizeId(agreementId, "agreementId", { min: 3, max: 128 }),
        agreementHash: normalizeHexHash(agreementHash, "agreementHash")
      },
      receipt: {
        artifactId: normalizeId(receiptId, "receiptId", { min: 3, max: 128 }),
        receiptHash: normalizeHexHash(receiptHash, "receiptHash")
      },
      openedByAgentId: normalizeActorId(openedByAgentId, "openedByAgentId"),
      reasonCode: normalizedReasonCode,
      reason: normalizedReason,
      evidenceRefs: normalizedEvidenceRefs,
      openedAt: at
    },
    { path: "$" }
  );

  const disputeHash = computeToolCallDisputeOpenHashV1(normalized);
  const signature = signObjectHash({ hashHex: disputeHash, signer });
  signature.signedAt = at;
  return normalizeForCanonicalJson({ ...normalized, disputeHash, signature }, { path: "$" });
}

export function validateToolCallDisputeOpenV1(disputeOpen) {
  assertPlainObject(disputeOpen, "disputeOpen");
  if (disputeOpen.schemaVersion !== TOOL_CALL_DISPUTE_OPEN_SCHEMA_VERSION) {
    throw new TypeError(`disputeOpen.schemaVersion must be ${TOOL_CALL_DISPUTE_OPEN_SCHEMA_VERSION}`);
  }
  normalizeId(disputeOpen.artifactId, "disputeOpen.artifactId", { min: 3, max: 128 });
  normalizeId(disputeOpen.tenantId, "disputeOpen.tenantId", { min: 1, max: 128 });
  normalizeId(disputeOpen.toolId, "disputeOpen.toolId", { min: 3, max: 128 });
  assertPlainObject(disputeOpen.agreement, "disputeOpen.agreement");
  normalizeId(disputeOpen.agreement.artifactId, "disputeOpen.agreement.artifactId", { min: 3, max: 128 });
  normalizeHexHash(disputeOpen.agreement.agreementHash, "disputeOpen.agreement.agreementHash");
  assertPlainObject(disputeOpen.receipt, "disputeOpen.receipt");
  normalizeId(disputeOpen.receipt.artifactId, "disputeOpen.receipt.artifactId", { min: 3, max: 128 });
  normalizeHexHash(disputeOpen.receipt.receiptHash, "disputeOpen.receipt.receiptHash");
  normalizeActorId(disputeOpen.openedByAgentId, "disputeOpen.openedByAgentId");
  if (disputeOpen.reasonCode !== null && disputeOpen.reasonCode !== undefined) {
    assertNonEmptyString(disputeOpen.reasonCode, "disputeOpen.reasonCode");
  }
  if (disputeOpen.reason !== null && disputeOpen.reason !== undefined) {
    assertNonEmptyString(disputeOpen.reason, "disputeOpen.reason");
  }
  normalizeUniqueStringArray(disputeOpen.evidenceRefs ?? [], "disputeOpen.evidenceRefs");
  assertIsoDate(disputeOpen.openedAt, "disputeOpen.openedAt");
  const hash = normalizeHexHash(disputeOpen.disputeHash, "disputeOpen.disputeHash");
  assertPlainObject(disputeOpen.signature, "disputeOpen.signature");
  assertNonEmptyString(disputeOpen.signature.signerKeyId, "disputeOpen.signature.signerKeyId");
  assertIsoDate(disputeOpen.signature.signedAt, "disputeOpen.signature.signedAt");
  assertNonEmptyString(disputeOpen.signature.signature, "disputeOpen.signature.signature");

  const computed = computeToolCallDisputeOpenHashV1(disputeOpen);
  if (computed !== hash) throw new TypeError("disputeHash mismatch");
  return true;
}

export function verifyToolCallDisputeOpenV1({ disputeOpen, publicKeyPem } = {}) {
  validateToolCallDisputeOpenV1(disputeOpen);
  verifyObjectSignature({ hashHex: disputeOpen.disputeHash, signature: disputeOpen.signature, publicKeyPem });
  return true;
}
