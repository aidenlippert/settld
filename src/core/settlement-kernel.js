import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V1 = "SettlementDecisionRecord.v1";
export const SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V2 = "SettlementDecisionRecord.v2";
export const SETTLEMENT_POLICY_NORMALIZATION_VERSION_V1 = "v1";
// Back-compat constant for callers that treat "the decision record schema version" as a single value.
export const SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION = SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V2;
export const SETTLEMENT_RECEIPT_SCHEMA_VERSION = "SettlementReceipt.v1";

export const SETTLEMENT_FINALITY_STATE = Object.freeze({
  PENDING: "pending",
  FINAL: "final"
});

export const SETTLEMENT_FINALITY_PROVIDER = Object.freeze({
  INTERNAL_LEDGER: "internal_ledger"
});

export const SETTLEMENT_KERNEL_VERIFICATION_CODE = Object.freeze({
  SETTLEMENT_MISSING: "settlement_missing",
  SETTLEMENT_RUN_ID_MISMATCH: "settlement_run_id_mismatch",

  DECISION_RECORD_MISSING: "decision_record_missing",
  DECISION_RECORD_HASH_INVALID: "decision_record_hash_invalid",
  DECISION_RECORD_HASH_MISMATCH: "decision_record_hash_mismatch",
  DECISION_RECORD_RUN_ID_MISMATCH: "decision_record_run_id_mismatch",
  DECISION_RECORD_SETTLEMENT_ID_MISMATCH: "decision_record_settlement_id_mismatch",
  DECISION_RECORD_DECIDED_AT_INVALID: "decision_record_decided_at_invalid",
  DECISION_RECORD_POLICY_HASH_USED_MISSING: "decision_record_policy_hash_used_missing",
  DECISION_RECORD_POLICY_HASH_USED_INVALID: "decision_record_policy_hash_used_invalid",
  DECISION_RECORD_POLICY_NORMALIZATION_VERSION_INVALID: "decision_record_policy_normalization_version_invalid",
  DECISION_RECORD_VERIFICATION_METHOD_HASH_USED_INVALID: "decision_record_verification_method_hash_used_invalid",

  SETTLEMENT_RECEIPT_MISSING: "settlement_receipt_missing",
  SETTLEMENT_RECEIPT_HASH_INVALID: "settlement_receipt_hash_invalid",
  SETTLEMENT_RECEIPT_HASH_MISMATCH: "settlement_receipt_hash_mismatch",
  SETTLEMENT_RECEIPT_RUN_ID_MISMATCH: "settlement_receipt_run_id_mismatch",
  SETTLEMENT_RECEIPT_SETTLEMENT_ID_MISMATCH: "settlement_receipt_settlement_id_mismatch",
  SETTLEMENT_RECEIPT_DECISION_REF_MISSING: "settlement_receipt_decision_ref_missing",
  SETTLEMENT_RECEIPT_DECISION_ID_MISMATCH: "settlement_receipt_decision_id_mismatch",
  SETTLEMENT_RECEIPT_DECISION_HASH_MISMATCH: "settlement_receipt_decision_hash_mismatch",
  SETTLEMENT_RECEIPT_CREATED_AT_INVALID: "settlement_receipt_created_at_invalid",
  SETTLEMENT_RECEIPT_SETTLED_AT_INVALID: "settlement_receipt_settled_at_invalid",
  SETTLEMENT_RECEIPT_BEFORE_DECISION: "settlement_receipt_before_decision",
  SETTLEMENT_RECEIPT_SETTLED_BEFORE_DECISION: "settlement_receipt_settled_before_decision",
  SETTLEMENT_RECEIPT_SETTLED_BEFORE_CREATED: "settlement_receipt_settled_before_created"
});

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertIsoDate(value, name, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined)) return;
  assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO date string`);
}

function normalizeId(value, name, { min = 1, max = 200 } = {}) {
  assertNonEmptyString(value, name);
  const out = String(value).trim();
  if (out.length < min || out.length > max) throw new TypeError(`${name} must be length ${min}..${max}`);
  if (!/^[A-Za-z0-9:_-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:_-]+$`);
  return out;
}

function normalizeTenantId(value, name) {
  return normalizeId(value, name, { min: 1, max: 128 });
}

function normalizeHexHash(value, name, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined)) return null;
  assertNonEmptyString(value, name);
  const out = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be a 64-hex sha256`);
  return out;
}

function normalizeNullableString(value, name, { max = 256 } = {}) {
  if (value === null || value === undefined) return null;
  const out = String(value);
  if (out.length > max) throw new TypeError(`${name} must be <= ${max} chars`);
  return out;
}

function normalizeNullableBoolean(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function normalizeNullableHttpStatus(value, name) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 100 || n > 999) throw new TypeError(`${name} must be a 3-digit integer status code`);
  return n;
}

function normalizeNullableSafeInt(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new TypeError(`${name} must be an integer in range ${min}..${max}`);
  }
  return n;
}

function normalizeSettlementBindings(value, name, { allowNull = true } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new TypeError(`${name} is required`);
  }
  assertPlainObject(value, name);
  return normalizeForCanonicalJson(
    {
      authorizationRef: normalizeNullableString(value.authorizationRef, `${name}.authorizationRef`, { max: 200 }),
      token: value.token
        ? {
            kid: normalizeNullableString(value.token.kid, `${name}.token.kid`, { max: 200 }),
            sha256: normalizeHexHash(value.token.sha256, `${name}.token.sha256`, { allowNull: true }),
            expiresAt: value.token.expiresAt === null || value.token.expiresAt === undefined ? null : String(value.token.expiresAt)
          }
        : null,
      request: value.request
        ? {
            sha256: normalizeHexHash(value.request.sha256, `${name}.request.sha256`, { allowNull: true })
          }
        : null,
      response: value.response
        ? {
            status: normalizeNullableHttpStatus(value.response.status, `${name}.response.status`),
            sha256: normalizeHexHash(value.response.sha256, `${name}.response.sha256`, { allowNull: true })
          }
        : null,
      providerSig: value.providerSig
        ? {
            required: normalizeNullableBoolean(value.providerSig.required, `${name}.providerSig.required`),
            present: normalizeNullableBoolean(value.providerSig.present, `${name}.providerSig.present`),
            verified: normalizeNullableBoolean(value.providerSig.verified, `${name}.providerSig.verified`),
            providerKeyId: normalizeNullableString(value.providerSig.providerKeyId, `${name}.providerSig.providerKeyId`, { max: 200 }),
            keyJwkThumbprintSha256: normalizeHexHash(value.providerSig.keyJwkThumbprintSha256, `${name}.providerSig.keyJwkThumbprintSha256`, {
              allowNull: true
            }),
            error: normalizeNullableString(value.providerSig.error, `${name}.providerSig.error`, { max: 4000 })
          }
        : null,
      providerQuoteSig: value.providerQuoteSig
        ? {
            required: normalizeNullableBoolean(value.providerQuoteSig.required, `${name}.providerQuoteSig.required`),
            present: normalizeNullableBoolean(value.providerQuoteSig.present, `${name}.providerQuoteSig.present`),
            verified: normalizeNullableBoolean(value.providerQuoteSig.verified, `${name}.providerQuoteSig.verified`),
            providerKeyId: normalizeNullableString(value.providerQuoteSig.providerKeyId, `${name}.providerQuoteSig.providerKeyId`, {
              max: 200
            }),
            quoteId: normalizeNullableString(value.providerQuoteSig.quoteId, `${name}.providerQuoteSig.quoteId`, { max: 200 }),
            quoteSha256: normalizeHexHash(value.providerQuoteSig.quoteSha256, `${name}.providerQuoteSig.quoteSha256`, { allowNull: true }),
            keyJwkThumbprintSha256: normalizeHexHash(
              value.providerQuoteSig.keyJwkThumbprintSha256,
              `${name}.providerQuoteSig.keyJwkThumbprintSha256`,
              { allowNull: true }
            ),
            error: normalizeNullableString(value.providerQuoteSig.error, `${name}.providerQuoteSig.error`, { max: 4000 })
          }
        : null,
      reserve: value.reserve
        ? {
            adapter: normalizeNullableString(value.reserve.adapter, `${name}.reserve.adapter`, { max: 200 }),
            mode: normalizeNullableString(value.reserve.mode, `${name}.reserve.mode`, { max: 200 }),
            reserveId: normalizeNullableString(value.reserve.reserveId, `${name}.reserve.reserveId`, { max: 256 }),
            status: normalizeNullableString(value.reserve.status, `${name}.reserve.status`, { max: 64 })
          }
        : null,
      quote: value.quote
        ? {
            quoteId: normalizeNullableString(value.quote.quoteId, `${name}.quote.quoteId`, { max: 200 }),
            quoteSha256: normalizeHexHash(value.quote.quoteSha256, `${name}.quote.quoteSha256`, { allowNull: true }),
            expiresAt: value.quote.expiresAt === null || value.quote.expiresAt === undefined ? null : String(value.quote.expiresAt),
            requestBindingMode: normalizeNullableString(value.quote.requestBindingMode, `${name}.quote.requestBindingMode`, {
              max: 32
            }),
            requestBindingSha256: normalizeHexHash(value.quote.requestBindingSha256, `${name}.quote.requestBindingSha256`, {
              allowNull: true
            })
          }
        : null,
      spendAuthorization: value.spendAuthorization
        ? {
            spendAuthorizationVersion: normalizeNullableString(
              value.spendAuthorization.spendAuthorizationVersion,
              `${name}.spendAuthorization.spendAuthorizationVersion`,
              { max: 64 }
            ),
            idempotencyKey: normalizeNullableString(value.spendAuthorization.idempotencyKey, `${name}.spendAuthorization.idempotencyKey`, {
              max: 256
            }),
            nonce: normalizeNullableString(value.spendAuthorization.nonce, `${name}.spendAuthorization.nonce`, { max: 256 }),
            sponsorRef: normalizeNullableString(value.spendAuthorization.sponsorRef, `${name}.spendAuthorization.sponsorRef`, { max: 200 }),
            sponsorWalletRef: normalizeNullableString(value.spendAuthorization.sponsorWalletRef, `${name}.spendAuthorization.sponsorWalletRef`, {
              max: 200
            }),
            agentKeyId: normalizeNullableString(value.spendAuthorization.agentKeyId, `${name}.spendAuthorization.agentKeyId`, { max: 200 }),
            delegationRef: normalizeNullableString(value.spendAuthorization.delegationRef, `${name}.spendAuthorization.delegationRef`, { max: 200 }),
            policyVersion: normalizeNullableSafeInt(value.spendAuthorization.policyVersion, `${name}.spendAuthorization.policyVersion`, {
              min: 1,
              max: 1_000_000_000
            }),
            policyFingerprint: normalizeHexHash(value.spendAuthorization.policyFingerprint, `${name}.spendAuthorization.policyFingerprint`, {
              allowNull: true
            })
          }
        : null,
      policyDecisionFingerprint: value.policyDecisionFingerprint
        ? {
            fingerprintVersion: normalizeNullableString(
              value.policyDecisionFingerprint.fingerprintVersion,
              `${name}.policyDecisionFingerprint.fingerprintVersion`,
              { max: 64 }
            ),
            policyId: normalizeNullableString(value.policyDecisionFingerprint.policyId, `${name}.policyDecisionFingerprint.policyId`, {
              max: 200
            }),
            policyVersion: normalizeNullableSafeInt(value.policyDecisionFingerprint.policyVersion, `${name}.policyDecisionFingerprint.policyVersion`, {
              min: 1,
              max: 1_000_000_000
            }),
            policyHash: normalizeHexHash(value.policyDecisionFingerprint.policyHash, `${name}.policyDecisionFingerprint.policyHash`, {
              allowNull: true
            }),
            verificationMethodHash: normalizeHexHash(
              value.policyDecisionFingerprint.verificationMethodHash,
              `${name}.policyDecisionFingerprint.verificationMethodHash`,
              { allowNull: true }
            ),
            evaluationHash: normalizeHexHash(
              value.policyDecisionFingerprint.evaluationHash,
              `${name}.policyDecisionFingerprint.evaluationHash`,
              { allowNull: true }
            )
          }
        : null
    },
    { path: "$" }
  );
}

function assertNonNegativeSafeInt(value, name, { min = 0 } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new TypeError(`${name} must be a safe integer >= ${min}`);
  return n;
}

function normalizeCurrency(value, name) {
  const raw = typeof value === "string" && value.trim() !== "" ? value : "USD";
  const out = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(out)) throw new TypeError(`${name} must match ^[A-Z][A-Z0-9_]{2,11}$`);
  return out;
}

function computeKernelHash({ obj, hashField } = {}) {
  assertPlainObject(obj, "obj");
  assertNonEmptyString(hashField, "hashField");
  const copy = { ...obj };
  delete copy[hashField];
  delete copy.artifactHash; // storage-level hash must not affect kernel binding
  const normalized = normalizeForCanonicalJson(copy, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function buildSettlementDecisionRecord({
  schemaVersion = SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V2,
  decisionId,
  tenantId,
  runId,
  settlementId,
  agreementId = null,
  decisionStatus,
  decisionMode,
  decisionReason = null,
  verificationStatus = null,
  policyNormalizationVersion = undefined,
  policyHashUsed,
  verificationMethodHashUsed = undefined,
  policyRef,
  verifierRef,
  runStatus = null,
  runLastEventId = null,
  runLastChainHash = null,
  resolutionEventId = null,
  decidedAt,
  bindings = undefined
} = {}) {
  assertIsoDate(decidedAt, "decidedAt");
  const resolvedSchemaVersion = String(schemaVersion ?? "").trim();
  if (resolvedSchemaVersion !== SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V1 && resolvedSchemaVersion !== SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V2) {
    throw new TypeError("schemaVersion must be SettlementDecisionRecord.v1 or SettlementDecisionRecord.v2");
  }
  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: resolvedSchemaVersion,
      decisionId: normalizeId(decisionId, "decisionId", { min: 1, max: 200 }),
      tenantId: normalizeTenantId(tenantId, "tenantId"),
      runId: normalizeId(runId, "runId", { min: 1, max: 128 }),
      settlementId: normalizeId(settlementId, "settlementId", { min: 1, max: 200 }),
      agreementId: agreementId === null ? null : String(agreementId),
      decisionStatus: String(decisionStatus ?? "").trim(),
      decisionMode: String(decisionMode ?? "").trim(),
      decisionReason: decisionReason === null ? null : String(decisionReason),
      verificationStatus: verificationStatus === null ? null : String(verificationStatus),
      ...(resolvedSchemaVersion === SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V2
        ? {
            policyNormalizationVersion:
              policyNormalizationVersion === undefined
                ? SETTLEMENT_POLICY_NORMALIZATION_VERSION_V1
                : String(policyNormalizationVersion ?? "").trim(),
            policyHashUsed: normalizeHexHash(policyHashUsed, "policyHashUsed", { allowNull: false }),
            ...(verificationMethodHashUsed === null || verificationMethodHashUsed === undefined
              ? {}
              : {
                  verificationMethodHashUsed: normalizeHexHash(verificationMethodHashUsed, "verificationMethodHashUsed", {
                    allowNull: false
                  })
                })
          }
        : {}),
      policyRef: {
        policyHash: normalizeHexHash(policyRef?.policyHash, "policyRef.policyHash", { allowNull: true }),
        verificationMethodHash: normalizeHexHash(policyRef?.verificationMethodHash, "policyRef.verificationMethodHash", { allowNull: true })
      },
      verifierRef: {
        verifierId: verifierRef?.verifierId === null || verifierRef?.verifierId === undefined ? null : String(verifierRef.verifierId),
        verifierVersion: verifierRef?.verifierVersion === null || verifierRef?.verifierVersion === undefined ? null : String(verifierRef.verifierVersion),
        verifierHash: normalizeHexHash(verifierRef?.verifierHash, "verifierRef.verifierHash", { allowNull: true }),
        modality: verifierRef?.modality === null || verifierRef?.modality === undefined ? null : String(verifierRef.modality)
      },
      workRef: {
        runStatus: runStatus === null ? null : String(runStatus),
        runLastEventId: runLastEventId === null ? null : String(runLastEventId),
        runLastChainHash: runLastChainHash === null ? null : String(runLastChainHash),
        resolutionEventId: resolutionEventId === null ? null : String(resolutionEventId)
      },
      ...(bindings === null || bindings === undefined ? {} : { bindings: normalizeSettlementBindings(bindings, "bindings", { allowNull: false }) }),
      decidedAt: String(decidedAt)
    },
    { path: "$" }
  );

  const decisionHash = computeKernelHash({ obj: normalized, hashField: "decisionHash" });
  return normalizeForCanonicalJson({ ...normalized, decisionHash }, { path: "$" });
}

export function buildSettlementDecisionRecordV1(args) {
  return buildSettlementDecisionRecord({ ...args, schemaVersion: SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V1 });
}

export function buildSettlementDecisionRecordV2(args) {
  return buildSettlementDecisionRecord({ ...args, schemaVersion: SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V2 });
}

export function buildSettlementReceipt({
  receiptId,
  tenantId,
  runId,
  settlementId,
  decisionRecord,
  status,
  amountCents,
  releasedAmountCents,
  refundedAmountCents,
  releaseRatePct,
  currency,
  runStatus = null,
  resolutionEventId = null,
  finalityProvider = SETTLEMENT_FINALITY_PROVIDER.INTERNAL_LEDGER,
  finalityState = undefined,
  settledAt = null,
  createdAt,
  bindings = undefined
} = {}) {
  assertPlainObject(decisionRecord, "decisionRecord");
  assertIsoDate(createdAt, "createdAt");
  assertIsoDate(settledAt, "settledAt", { allowNull: true });
  const resolvedFinalityState =
    finalityState === undefined || finalityState === null
      ? String(status ?? "").trim().toLowerCase() === "locked"
        ? SETTLEMENT_FINALITY_STATE.PENDING
        : SETTLEMENT_FINALITY_STATE.FINAL
      : String(finalityState);
  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: SETTLEMENT_RECEIPT_SCHEMA_VERSION,
      receiptId: normalizeId(receiptId, "receiptId", { min: 1, max: 200 }),
      tenantId: normalizeTenantId(tenantId, "tenantId"),
      runId: normalizeId(runId, "runId", { min: 1, max: 128 }),
      settlementId: normalizeId(settlementId, "settlementId", { min: 1, max: 200 }),
      decisionRef: {
        decisionId: normalizeId(decisionRecord.decisionId, "decisionRecord.decisionId", { min: 1, max: 200 }),
        decisionHash: normalizeHexHash(decisionRecord.decisionHash, "decisionRecord.decisionHash")
      },
      status: String(status ?? "").trim(),
      amountCents: assertNonNegativeSafeInt(amountCents, "amountCents", { min: 1 }),
      releasedAmountCents: assertNonNegativeSafeInt(releasedAmountCents, "releasedAmountCents", { min: 0 }),
      refundedAmountCents: assertNonNegativeSafeInt(refundedAmountCents, "refundedAmountCents", { min: 0 }),
      releaseRatePct: assertNonNegativeSafeInt(releaseRatePct, "releaseRatePct", { min: 0 }),
      currency: normalizeCurrency(currency, "currency"),
      runStatus: runStatus === null ? null : String(runStatus),
      resolutionEventId: resolutionEventId === null ? null : String(resolutionEventId),
      finalityProvider: String(finalityProvider ?? SETTLEMENT_FINALITY_PROVIDER.INTERNAL_LEDGER),
      finalityState: resolvedFinalityState,
      settledAt: settledAt === null ? null : String(settledAt),
      ...(bindings === null || bindings === undefined ? {} : { bindings: normalizeSettlementBindings(bindings, "bindings", { allowNull: false }) }),
      createdAt: String(createdAt)
    },
    { path: "$" }
  );

  const receiptHash = computeKernelHash({ obj: normalized, hashField: "receiptHash" });
  return normalizeForCanonicalJson({ ...normalized, receiptHash }, { path: "$" });
}

export function buildSettlementReceiptV1(args) {
  return buildSettlementReceipt(args);
}

export function extractSettlementKernelArtifacts(settlement) {
  if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) {
    return { decisionRecord: null, settlementReceipt: null };
  }
  const trace = settlement.decisionTrace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return { decisionRecord: null, settlementReceipt: null };
  }
  return {
    decisionRecord: trace.decisionRecord ?? null,
    settlementReceipt: trace.settlementReceipt ?? null
  };
}

export function verifySettlementKernelArtifacts({ settlement, runId = null } = {}) {
  const errors = [];
  if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) {
    return { valid: false, errors: [SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_MISSING] };
  }

  const settlementRunId = typeof settlement.runId === "string" ? settlement.runId : null;
  if (runId !== null && runId !== undefined && String(runId) !== String(settlementRunId ?? "")) {
    errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RUN_ID_MISMATCH);
  }

  const { decisionRecord, settlementReceipt } = extractSettlementKernelArtifacts(settlement);

  let decidedAtMs = Number.NaN;
  if (!decisionRecord || typeof decisionRecord !== "object" || Array.isArray(decisionRecord)) {
    errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_MISSING);
  } else {
    const schemaVersion = typeof decisionRecord.schemaVersion === "string" ? decisionRecord.schemaVersion : "";
    if (schemaVersion === SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION_V2) {
      const normVersionRaw = decisionRecord.policyNormalizationVersion;
      if (normVersionRaw !== undefined) {
        const normVersion = typeof normVersionRaw === "string" ? normVersionRaw.trim() : "";
        if (!normVersion || normVersion.length > 64) {
          errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_POLICY_NORMALIZATION_VERSION_INVALID);
        }
      }
      const policyHashUsed = typeof decisionRecord.policyHashUsed === "string" ? decisionRecord.policyHashUsed.trim().toLowerCase() : "";
      if (!policyHashUsed) {
        errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_POLICY_HASH_USED_MISSING);
      } else if (!/^[0-9a-f]{64}$/.test(policyHashUsed)) {
        errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_POLICY_HASH_USED_INVALID);
      }
      const methodHashUsedRaw = decisionRecord.verificationMethodHashUsed;
      if (methodHashUsedRaw !== undefined) {
        const methodHashUsed = typeof methodHashUsedRaw === "string" ? methodHashUsedRaw.trim().toLowerCase() : "";
        if (!methodHashUsed || !/^[0-9a-f]{64}$/.test(methodHashUsed)) {
          errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_VERIFICATION_METHOD_HASH_USED_INVALID);
        }
      }
    }

    const decisionHashRaw = decisionRecord.decisionHash;
    const decisionHash = typeof decisionHashRaw === "string" ? decisionHashRaw.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(decisionHash)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_HASH_INVALID);
    } else {
      try {
        const computed = computeKernelHash({ obj: decisionRecord, hashField: "decisionHash" });
        if (computed !== decisionHash) errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_HASH_MISMATCH);
      } catch {
        errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_HASH_INVALID);
      }
    }

    if (settlementRunId && String(decisionRecord.runId ?? "") !== String(settlementRunId)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_RUN_ID_MISMATCH);
    }
    if (settlement.settlementId && String(decisionRecord.settlementId ?? "") !== String(settlement.settlementId)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_SETTLEMENT_ID_MISMATCH);
    }

    const decidedAt = decisionRecord.decidedAt;
    decidedAtMs = typeof decidedAt === "string" && Number.isFinite(Date.parse(decidedAt)) ? Date.parse(decidedAt) : Number.NaN;
    if (!Number.isFinite(decidedAtMs)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.DECISION_RECORD_DECIDED_AT_INVALID);
    }
  }

  if (!settlementReceipt || typeof settlementReceipt !== "object" || Array.isArray(settlementReceipt)) {
    errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_MISSING);
  } else {
    const receiptHashRaw = settlementReceipt.receiptHash;
    const receiptHash = typeof receiptHashRaw === "string" ? receiptHashRaw.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(receiptHash)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_HASH_INVALID);
    } else {
      try {
        const computed = computeKernelHash({ obj: settlementReceipt, hashField: "receiptHash" });
        if (computed !== receiptHash) errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_HASH_MISMATCH);
      } catch {
        errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_HASH_INVALID);
      }
    }

    if (settlementRunId && String(settlementReceipt.runId ?? "") !== String(settlementRunId)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_RUN_ID_MISMATCH);
    }
    if (settlement.settlementId && String(settlementReceipt.settlementId ?? "") !== String(settlement.settlementId)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_SETTLEMENT_ID_MISMATCH);
    }

    const decisionRef = settlementReceipt.decisionRef;
    if (!decisionRef || typeof decisionRef !== "object" || Array.isArray(decisionRef)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_DECISION_REF_MISSING);
    } else if (decisionRecord && typeof decisionRecord === "object" && !Array.isArray(decisionRecord)) {
      if (String(decisionRef.decisionId ?? "") !== String(decisionRecord.decisionId ?? "")) {
        errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_DECISION_ID_MISMATCH);
      }
      if (String(decisionRef.decisionHash ?? "") !== String(decisionRecord.decisionHash ?? "")) {
        errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_DECISION_HASH_MISMATCH);
      }
    }

    const createdAt = settlementReceipt.createdAt;
    const createdAtMs = typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt)) ? Date.parse(createdAt) : Number.NaN;
    if (!Number.isFinite(createdAtMs)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_CREATED_AT_INVALID);
    } else if (Number.isFinite(decidedAtMs) && createdAtMs < decidedAtMs) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_BEFORE_DECISION);
    }

    const settledAt = settlementReceipt.settledAt;
    const settledAtMs =
      settledAt === null || settledAt === undefined
        ? Number.NaN
        : typeof settledAt === "string" && Number.isFinite(Date.parse(settledAt))
          ? Date.parse(settledAt)
          : Number.NaN;
    if (settledAt !== null && settledAt !== undefined && !Number.isFinite(settledAtMs)) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_SETTLED_AT_INVALID);
    }
    if (Number.isFinite(settledAtMs) && Number.isFinite(decidedAtMs) && settledAtMs < decidedAtMs) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_SETTLED_BEFORE_DECISION);
    }
    if (Number.isFinite(settledAtMs) && Number.isFinite(createdAtMs) && settledAtMs < createdAtMs) {
      errors.push(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_SETTLED_BEFORE_CREATED);
    }
  }

  return { valid: errors.length === 0, errors };
}
