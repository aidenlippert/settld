import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const TOOL_CALL_AGREEMENT_SCHEMA_VERSION = "ToolCallAgreement.v1";

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

function normalizeNullableId(value, name) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out : null;
}

export function computeToolCallInputHashV1(input) {
  const canonical = canonicalJsonStringify(input ?? {});
  return sha256Hex(canonical);
}

export function computeToolCallAgreementHashV1(agreementCore) {
  assertPlainObject(agreementCore, "agreementCore");
  const copy = { ...agreementCore };
  delete copy.agreementHash;
  const normalized = normalizeForCanonicalJson(copy, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function buildToolCallAgreementV1({
  toolId,
  manifestHash,
  callId,
  input = {},
  inputHash = null,
  acceptanceCriteria = null,
  settlementTerms = null,
  payerAgentId = null,
  payeeAgentId = null,
  createdAt = new Date().toISOString()
} = {}) {
  const at = assertIsoDate(createdAt, "createdAt");

  const computedInputHash = inputHash === null || inputHash === undefined ? computeToolCallInputHashV1(input) : normalizeSha256Hex(inputHash, "inputHash");

  const core = normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_CALL_AGREEMENT_SCHEMA_VERSION,
      toolId: assertNonEmptyString(String(toolId ?? ""), "toolId"),
      manifestHash: normalizeSha256Hex(manifestHash, "manifestHash"),
      callId: assertNonEmptyString(String(callId ?? ""), "callId"),
      inputHash: computedInputHash,
      acceptanceCriteria: acceptanceCriteria === undefined ? null : acceptanceCriteria,
      settlementTerms: settlementTerms === undefined ? null : settlementTerms,
      payerAgentId: normalizeNullableId(payerAgentId, "payerAgentId"),
      payeeAgentId: normalizeNullableId(payeeAgentId, "payeeAgentId"),
      createdAt: at
    },
    { path: "$" }
  );
  const agreementHash = computeToolCallAgreementHashV1(core);
  return normalizeForCanonicalJson({ ...core, agreementHash }, { path: "$" });
}

export function validateToolCallAgreementV1(agreement) {
  assertPlainObject(agreement, "agreement");
  if (agreement.schemaVersion !== TOOL_CALL_AGREEMENT_SCHEMA_VERSION) {
    throw new TypeError(`agreement.schemaVersion must be ${TOOL_CALL_AGREEMENT_SCHEMA_VERSION}`);
  }
  assertNonEmptyString(agreement.toolId, "agreement.toolId");
  normalizeSha256Hex(agreement.manifestHash, "agreement.manifestHash");
  assertNonEmptyString(agreement.callId, "agreement.callId");
  normalizeSha256Hex(agreement.inputHash, "agreement.inputHash");

  if (agreement.acceptanceCriteria !== null && agreement.acceptanceCriteria !== undefined) {
    assertPlainObject(agreement.acceptanceCriteria, "agreement.acceptanceCriteria");
  }
  if (agreement.settlementTerms !== null && agreement.settlementTerms !== undefined) {
    assertPlainObject(agreement.settlementTerms, "agreement.settlementTerms");
  }

  normalizeNullableId(agreement.payerAgentId ?? null, "agreement.payerAgentId");
  normalizeNullableId(agreement.payeeAgentId ?? null, "agreement.payeeAgentId");

  assertIsoDate(agreement.createdAt, "agreement.createdAt");

  const agreementHash = normalizeSha256Hex(agreement.agreementHash, "agreement.agreementHash");
  const computed = computeToolCallAgreementHashV1(agreement);
  if (computed !== agreementHash) throw new TypeError("agreementHash mismatch");
  return true;
}

