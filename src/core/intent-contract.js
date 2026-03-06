import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const INTENT_CONTRACT_SCHEMA_VERSION = "IntentContract.v1";

export const INTENT_CONTRACT_STATUS = Object.freeze({
  PROPOSED: "proposed",
  COUNTERED: "countered",
  ACCEPTED: "accepted"
});

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertNonEmptyString(value, name, { max = 200 } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return normalized;
}

function normalizeOptionalString(value, name, { max = 200 } = {}) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return normalized;
}

function normalizeIsoDateTime(value, name) {
  const normalized = assertNonEmptyString(value, name, { max: 128 });
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${name} must be an ISO date-time`);
  return normalized;
}

function normalizeStatus(value, name = "status") {
  const normalized = assertNonEmptyString(value, name, { max: 32 }).toLowerCase();
  if (!Object.values(INTENT_CONTRACT_STATUS).includes(normalized)) {
    throw new TypeError(`${name} must be one of ${Object.values(INTENT_CONTRACT_STATUS).join("|")}`);
  }
  return normalized;
}

function normalizeSha256(value, name, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || value === "")) return null;
  const normalized = assertNonEmptyString(value, name, { max: 64 }).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new TypeError(`${name} must be sha256 hex`);
  return normalized;
}

function normalizeNonNegativeSafeInt(value, name, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || value === "")) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

function normalizeRequiredApprovals(value, name) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value.map((row, index) => {
    assertPlainObject(row, `${name}[${index}]`);
    return normalizeForCanonicalJson(
      {
        approverRole: assertNonEmptyString(row.approverRole, `${name}[${index}].approverRole`, { max: 128 }),
        minApprovals: normalizeNonNegativeSafeInt(row.minApprovals ?? 1, `${name}[${index}].minApprovals`, { allowNull: false }),
        reason: normalizeOptionalString(row.reason ?? null, `${name}[${index}].reason`, { max: 512 })
      },
      { path: `$.${name}[${index}]` }
    );
  });
}

function normalizeBudgetEnvelope(value, name) {
  assertPlainObject(value, name);
  const currency = assertNonEmptyString(value.currency ?? "USD", `${name}.currency`, { max: 8 }).toUpperCase();
  if (!/^[A-Z0-9_]{2,8}$/.test(currency)) throw new TypeError(`${name}.currency must match ^[A-Z0-9_]{2,8}$`);
  const maxAmountCents = normalizeNonNegativeSafeInt(value.maxAmountCents, `${name}.maxAmountCents`, { allowNull: false });
  const hardCap = Boolean(value.hardCap !== false);
  return normalizeForCanonicalJson(
    {
      currency,
      maxAmountCents,
      hardCap
    },
    { path: `$.${name}` }
  );
}

function buildIntentHash(intent) {
  return sha256Hex(
    canonicalJsonStringify({
      ...intent,
      intentHash: null
    })
  );
}

function normalizeIntentContractCore(rawIntent, { fieldPath = "$", allowAcceptedFields = true } = {}) {
  assertPlainObject(rawIntent, fieldPath);
  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: assertNonEmptyString(rawIntent.schemaVersion ?? INTENT_CONTRACT_SCHEMA_VERSION, `${fieldPath}.schemaVersion`, { max: 128 }),
      intentId: assertNonEmptyString(rawIntent.intentId, `${fieldPath}.intentId`, { max: 200 }),
      tenantId: assertNonEmptyString(rawIntent.tenantId, `${fieldPath}.tenantId`, { max: 128 }),
      proposerAgentId: assertNonEmptyString(rawIntent.proposerAgentId, `${fieldPath}.proposerAgentId`, { max: 200 }),
      counterpartyAgentId: assertNonEmptyString(rawIntent.counterpartyAgentId, `${fieldPath}.counterpartyAgentId`, { max: 200 }),
      objective:
        typeof rawIntent.objective === "string"
          ? assertNonEmptyString(rawIntent.objective, `${fieldPath}.objective`, { max: 2000 })
          : normalizeForCanonicalJson(rawIntent.objective, { path: `${fieldPath}.objective` }),
      constraints:
        rawIntent.constraints && typeof rawIntent.constraints === "object" && !Array.isArray(rawIntent.constraints)
          ? normalizeForCanonicalJson(rawIntent.constraints, { path: `${fieldPath}.constraints` })
          : null,
      budgetEnvelope: normalizeBudgetEnvelope(rawIntent.budgetEnvelope, `${fieldPath}.budgetEnvelope`),
      requiredApprovals: normalizeRequiredApprovals(rawIntent.requiredApprovals ?? [], `${fieldPath}.requiredApprovals`),
      successCriteria:
        rawIntent.successCriteria && typeof rawIntent.successCriteria === "object" && !Array.isArray(rawIntent.successCriteria)
          ? normalizeForCanonicalJson(rawIntent.successCriteria, { path: `${fieldPath}.successCriteria` })
          : normalizeForCanonicalJson({}, { path: `${fieldPath}.successCriteria` }),
      terminationPolicy:
        rawIntent.terminationPolicy && typeof rawIntent.terminationPolicy === "object" && !Array.isArray(rawIntent.terminationPolicy)
          ? normalizeForCanonicalJson(rawIntent.terminationPolicy, { path: `${fieldPath}.terminationPolicy` })
          : normalizeForCanonicalJson({}, { path: `${fieldPath}.terminationPolicy` }),
      counterOfIntentId: normalizeOptionalString(rawIntent.counterOfIntentId ?? null, `${fieldPath}.counterOfIntentId`, { max: 200 }),
      parentIntentHash: normalizeSha256(rawIntent.parentIntentHash ?? null, `${fieldPath}.parentIntentHash`, { allowNull: true }),
      status: normalizeStatus(rawIntent.status ?? INTENT_CONTRACT_STATUS.PROPOSED, `${fieldPath}.status`),
      acceptedByAgentId: allowAcceptedFields
        ? normalizeOptionalString(rawIntent.acceptedByAgentId ?? null, `${fieldPath}.acceptedByAgentId`, { max: 200 })
        : null,
      acceptedAt: allowAcceptedFields
        ? rawIntent.acceptedAt === null || rawIntent.acceptedAt === undefined
          ? null
          : normalizeIsoDateTime(rawIntent.acceptedAt, `${fieldPath}.acceptedAt`)
        : null,
      proposedAt: normalizeIsoDateTime(rawIntent.proposedAt, `${fieldPath}.proposedAt`),
      updatedAt: normalizeIsoDateTime(rawIntent.updatedAt, `${fieldPath}.updatedAt`),
      revision: normalizeNonNegativeSafeInt(rawIntent.revision ?? 0, `${fieldPath}.revision`, { allowNull: false }),
      metadata:
        rawIntent.metadata && typeof rawIntent.metadata === "object" && !Array.isArray(rawIntent.metadata)
          ? normalizeForCanonicalJson(rawIntent.metadata, { path: `${fieldPath}.metadata` })
          : null,
      intentHash: null
    },
    { path: fieldPath }
  );

  if (normalized.schemaVersion !== INTENT_CONTRACT_SCHEMA_VERSION) {
    throw new TypeError(`${fieldPath}.schemaVersion must be ${INTENT_CONTRACT_SCHEMA_VERSION}`);
  }
  return normalized;
}

export function buildIntentContractV1({
  intentId,
  tenantId,
  proposerAgentId,
  counterpartyAgentId,
  objective,
  constraints = null,
  budgetEnvelope,
  requiredApprovals = [],
  successCriteria = {},
  terminationPolicy = {},
  counterOfIntentId = null,
  parentIntentHash = null,
  status = INTENT_CONTRACT_STATUS.PROPOSED,
  acceptedByAgentId = null,
  acceptedAt = null,
  proposedAt = new Date().toISOString(),
  updatedAt = proposedAt,
  revision = 0,
  metadata = null
} = {}) {
  const core = normalizeIntentContractCore(
    {
      schemaVersion: INTENT_CONTRACT_SCHEMA_VERSION,
      intentId,
      tenantId,
      proposerAgentId,
      counterpartyAgentId,
      objective,
      constraints,
      budgetEnvelope,
      requiredApprovals,
      successCriteria,
      terminationPolicy,
      counterOfIntentId,
      parentIntentHash,
      status,
      acceptedByAgentId,
      acceptedAt,
      proposedAt,
      updatedAt,
      revision,
      metadata
    },
    { fieldPath: "$.intentContract", allowAcceptedFields: true }
  );
  const intentHash = buildIntentHash(core);
  const intentContract = normalizeForCanonicalJson(
    {
      ...core,
      intentHash
    },
    { path: "$.intentContract" }
  );
  validateIntentContractV1(intentContract);
  return intentContract;
}

export function validateIntentContractV1(intentContract) {
  const normalized = normalizeIntentContractCore(intentContract, {
    fieldPath: "$.intentContract",
    allowAcceptedFields: true
  });
  const providedHash = normalizeSha256(intentContract?.intentHash, "$.intentContract.intentHash", { allowNull: false });
  const expectedHash = buildIntentHash(normalized);
  if (providedHash !== expectedHash) throw new TypeError("$.intentContract.intentHash mismatch");

  if (normalized.status === INTENT_CONTRACT_STATUS.ACCEPTED) {
    if (!normalized.acceptedByAgentId) throw new TypeError("$.intentContract.acceptedByAgentId is required for accepted status");
    if (!normalized.acceptedAt) throw new TypeError("$.intentContract.acceptedAt is required for accepted status");
  } else {
    if (normalized.acceptedByAgentId !== null || normalized.acceptedAt !== null) {
      throw new TypeError("$.intentContract.accepted fields are only valid for accepted status");
    }
  }

  if (normalized.counterOfIntentId && !normalized.parentIntentHash) {
    throw new TypeError("$.intentContract.parentIntentHash is required when counterOfIntentId is set");
  }
  return true;
}

export function counterIntentContractV1({
  sourceIntent,
  intentId,
  proposerAgentId,
  objective,
  constraints = null,
  budgetEnvelope = null,
  requiredApprovals = null,
  successCriteria = null,
  terminationPolicy = null,
  proposedAt = new Date().toISOString(),
  metadata = null
} = {}) {
  validateIntentContractV1(sourceIntent);
  return buildIntentContractV1({
    intentId,
    tenantId: sourceIntent.tenantId,
    proposerAgentId,
    counterpartyAgentId: proposerAgentId === sourceIntent.proposerAgentId ? sourceIntent.counterpartyAgentId : sourceIntent.proposerAgentId,
    objective: objective ?? sourceIntent.objective,
    constraints: constraints ?? sourceIntent.constraints,
    budgetEnvelope: budgetEnvelope ?? sourceIntent.budgetEnvelope,
    requiredApprovals: requiredApprovals ?? sourceIntent.requiredApprovals,
    successCriteria: successCriteria ?? sourceIntent.successCriteria,
    terminationPolicy: terminationPolicy ?? sourceIntent.terminationPolicy,
    counterOfIntentId: sourceIntent.intentId,
    parentIntentHash: sourceIntent.intentHash,
    status: INTENT_CONTRACT_STATUS.COUNTERED,
    proposedAt,
    updatedAt: proposedAt,
    revision: 0,
    metadata
  });
}

export function acceptIntentContractV1({
  intentContract,
  acceptedByAgentId,
  acceptedAt = new Date().toISOString()
} = {}) {
  validateIntentContractV1(intentContract);
  const normalizedAcceptedByAgentId = assertNonEmptyString(acceptedByAgentId, "acceptedByAgentId", { max: 200 });
  if (normalizedAcceptedByAgentId !== String(intentContract.proposerAgentId) && normalizedAcceptedByAgentId !== String(intentContract.counterpartyAgentId)) {
    throw new TypeError("acceptedByAgentId must be a participant in the intent contract");
  }
  return buildIntentContractV1({
    ...intentContract,
    status: INTENT_CONTRACT_STATUS.ACCEPTED,
    acceptedByAgentId: normalizedAcceptedByAgentId,
    acceptedAt,
    updatedAt: acceptedAt,
    revision: Number(intentContract.revision ?? 0) + 1
  });
}
