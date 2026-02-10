import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const TOOL_CALL_AGREEMENT_SCHEMA_VERSION = "ToolCallAgreement.v1";
export const TOOL_CALL_EVIDENCE_SCHEMA_VERSION = "ToolCallEvidence.v1";
export const SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION = "SettlementDecisionRecord.v1";
export const SETTLEMENT_RECEIPT_SCHEMA_VERSION = "SettlementReceipt.v1";

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
  signer
} = {}) {
  const at = createdAt ?? new Date().toISOString();
  assertIsoDate(at, "createdAt");

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
  input,
  output,
  startedAt,
  completedAt,
  signer
} = {}) {
  const start = startedAt ?? new Date().toISOString();
  const end = completedAt ?? start;
  assertIsoDate(start, "startedAt");
  assertIsoDate(end, "completedAt");

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
  modality = "deterministic",
  verifier = null,
  policy = null,
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
  if (!["deterministic", "attestation", "manual"].includes(normalizedModality)) {
    throw new TypeError("modality must be deterministic|attestation|manual");
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
      verifier: verifier && typeof verifier === "object" && !Array.isArray(verifier) ? verifier : null,
      policy: policy && typeof policy === "object" && !Array.isArray(policy) ? policy : null,
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
  if (!["deterministic", "attestation", "manual"].includes(modality)) throw new TypeError("record.modality must be deterministic|attestation|manual");
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

