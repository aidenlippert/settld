import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const SUB_AGENT_WORK_ORDER_SCHEMA_VERSION = "SubAgentWorkOrder.v1";
export const SUB_AGENT_COMPLETION_RECEIPT_SCHEMA_VERSION = "SubAgentCompletionReceipt.v1";
export const SUB_AGENT_WORK_ORDER_EVIDENCE_POLICY_SCHEMA_VERSION = "WorkOrderSettlementEvidencePolicy.v1";
export const SUB_AGENT_EXECUTION_ATTESTATION_SCHEMA_VERSION = "ExecutionAttestation.v1";

export const SUB_AGENT_WORK_ORDER_STATUS = Object.freeze({
  CREATED: "created",
  ACCEPTED: "accepted",
  WORKING: "working",
  COMPLETED: "completed",
  FAILED: "failed",
  SETTLED: "settled",
  CANCELLED: "cancelled",
  DISPUTED: "disputed"
});

export const SUB_AGENT_COMPLETION_STATUS = Object.freeze({
  SUCCESS: "success",
  FAILED: "failed"
});

export const SUB_AGENT_WORK_ORDER_SETTLEMENT_STATUS = Object.freeze({
  RELEASED: "released",
  REFUNDED: "refunded"
});

export const SUB_AGENT_WORK_ORDER_EVIDENCE_KIND = Object.freeze({
  ARTIFACT: "artifact",
  HASH: "hash",
  VERIFICATION_REPORT: "verification_report",
  EXECUTION_ATTESTATION: "execution_attestation"
});

const TERMINAL_WORK_ORDER_STATUSES = new Set([
  SUB_AGENT_WORK_ORDER_STATUS.COMPLETED,
  SUB_AGENT_WORK_ORDER_STATUS.FAILED,
  SUB_AGENT_WORK_ORDER_STATUS.SETTLED,
  SUB_AGENT_WORK_ORDER_STATUS.CANCELLED
]);

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

function assertNonEmptyString(value, name, { max = 200 } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return normalized;
}

function normalizeOptionalString(value, name, { max = 2000 } = {}) {
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

function assertSha256Hex(value, name) {
  const normalized = assertNonEmptyString(value, name, { max: 64 }).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new TypeError(`${name} must be sha256 hex`);
  return normalized;
}

function normalizeCurrency(value, name = "currency") {
  const normalized = assertNonEmptyString(value ?? "USD", name, { max: 8 }).toUpperCase();
  if (!/^[A-Z0-9_]{2,8}$/.test(normalized)) throw new TypeError(`${name} must match ^[A-Z0-9_]{2,8}$`);
  return normalized;
}

function normalizeSafeInteger(value, name, { min = null, allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || value === "")) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new TypeError(`${name} must be a safe integer`);
  if (min !== null && n < min) throw new TypeError(`${name} must be >= ${min}`);
  return n;
}

function normalizeWorkOrderStatus(value, name = "status") {
  const normalized = assertNonEmptyString(value, name, { max: 32 }).toLowerCase();
  if (!Object.values(SUB_AGENT_WORK_ORDER_STATUS).includes(normalized)) {
    throw new TypeError(`${name} must be one of ${Object.values(SUB_AGENT_WORK_ORDER_STATUS).join("|")}`);
  }
  return normalized;
}

function normalizeCompletionStatus(value, name = "status") {
  const normalized = assertNonEmptyString(value, name, { max: 32 }).toLowerCase();
  if (!Object.values(SUB_AGENT_COMPLETION_STATUS).includes(normalized)) {
    throw new TypeError(`${name} must be one of ${Object.values(SUB_AGENT_COMPLETION_STATUS).join("|")}`);
  }
  return normalized;
}

function normalizeSettlementStatus(value, name = "settlement.status") {
  const normalized = assertNonEmptyString(value, name, { max: 32 }).toLowerCase();
  if (!Object.values(SUB_AGENT_WORK_ORDER_SETTLEMENT_STATUS).includes(normalized)) {
    throw new TypeError(`${name} must be one of ${Object.values(SUB_AGENT_WORK_ORDER_SETTLEMENT_STATUS).join("|")}`);
  }
  return normalized;
}

function normalizeStringArray(value, name, { max = 200 } = {}) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return [...new Set(value.map((entry, index) => assertNonEmptyString(entry, `${name}[${index}]`, { max })))];
}

function normalizeEvidenceKinds(value, name) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const out = [...new Set(value.map((entry, index) => assertNonEmptyString(entry, `${name}[${index}]`, { max: 64 }).toLowerCase()))];
  for (const kind of out) {
    if (!Object.values(SUB_AGENT_WORK_ORDER_EVIDENCE_KIND).includes(kind)) {
      throw new TypeError(`${name} must only include ${Object.values(SUB_AGENT_WORK_ORDER_EVIDENCE_KIND).join("|")}`);
    }
  }
  return out;
}

function normalizeEvidencePolicyRule(rule, name) {
  assertPlainObject(rule, name);
  const minEvidenceRefs = normalizeSafeInteger(rule.minEvidenceRefs ?? 0, `${name}.minEvidenceRefs`, { min: 0 });
  const requiredKinds = normalizeEvidenceKinds(rule.requiredKinds ?? [], `${name}.requiredKinds`);
  const requireReceiptHashBinding = Boolean(rule.requireReceiptHashBinding === true);
  return normalizeForCanonicalJson(
    {
      minEvidenceRefs,
      requiredKinds,
      requireReceiptHashBinding
    },
    { path: `$.${name}` }
  );
}

function normalizeEvidencePolicy(evidencePolicy = null) {
  if (evidencePolicy === null || evidencePolicy === undefined) return null;
  assertPlainObject(evidencePolicy, "evidencePolicy");
  if (String(evidencePolicy.schemaVersion ?? "").trim() !== SUB_AGENT_WORK_ORDER_EVIDENCE_POLICY_SCHEMA_VERSION) {
    throw new TypeError(`evidencePolicy.schemaVersion must be ${SUB_AGENT_WORK_ORDER_EVIDENCE_POLICY_SCHEMA_VERSION}`);
  }
  const workOrderType = assertNonEmptyString(evidencePolicy.workOrderType ?? "generic", "evidencePolicy.workOrderType", { max: 64 }).toLowerCase();
  return normalizeForCanonicalJson(
    {
      schemaVersion: SUB_AGENT_WORK_ORDER_EVIDENCE_POLICY_SCHEMA_VERSION,
      workOrderType,
      release: normalizeEvidencePolicyRule(evidencePolicy.release ?? {}, "evidencePolicy.release"),
      refund: normalizeEvidencePolicyRule(evidencePolicy.refund ?? {}, "evidencePolicy.refund")
    },
    { path: "$.evidencePolicy" }
  );
}

function normalizeProgressEvents(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("progressEvents must be an array");
  return value.map((entry, index) => {
    assertPlainObject(entry, `progressEvents[${index}]`);
    return normalizeForCanonicalJson(
      {
        progressId: assertNonEmptyString(entry.progressId, `progressEvents[${index}].progressId`, { max: 200 }),
        eventType: assertNonEmptyString(entry.eventType ?? "progress", `progressEvents[${index}].eventType`, { max: 64 }).toLowerCase(),
        message: normalizeOptionalString(entry.message, `progressEvents[${index}].message`, { max: 2000 }),
        percentComplete: normalizeSafeInteger(entry.percentComplete ?? null, `progressEvents[${index}].percentComplete`, {
          min: 0,
          allowNull: true
        }),
        evidenceRefs: normalizeStringArray(entry.evidenceRefs ?? [], `progressEvents[${index}].evidenceRefs`, { max: 500 }),
        at: normalizeIsoDateTime(entry.at, `progressEvents[${index}].at`)
      },
      { path: `$.progressEvents[${index}]` }
    );
  });
}

function normalizePricing(pricing) {
  assertPlainObject(pricing, "pricing");
  const model = assertNonEmptyString(pricing.model ?? "fixed", "pricing.model", { max: 32 }).toLowerCase();
  if (model !== "fixed") throw new TypeError("pricing.model must be fixed");
  const amountCents = normalizeSafeInteger(pricing.amountCents, "pricing.amountCents", { min: 1 });
  const currency = normalizeCurrency(pricing.currency ?? "USD", "pricing.currency");
  return normalizeForCanonicalJson(
    {
      model,
      amountCents,
      currency,
      quoteId: normalizeOptionalString(pricing.quoteId, "pricing.quoteId", { max: 200 })
    },
    { path: "$.pricing" }
  );
}

function normalizeConstraints(constraints = null) {
  if (constraints === null || constraints === undefined) return null;
  assertPlainObject(constraints, "constraints");
  const deadlineAt = constraints.deadlineAt === null || constraints.deadlineAt === undefined ? null : normalizeIsoDateTime(constraints.deadlineAt, "constraints.deadlineAt");
  return normalizeForCanonicalJson(
    {
      maxDurationSeconds: normalizeSafeInteger(constraints.maxDurationSeconds ?? null, "constraints.maxDurationSeconds", { min: 1, allowNull: true }),
      maxCostCents: normalizeSafeInteger(constraints.maxCostCents ?? null, "constraints.maxCostCents", { min: 0, allowNull: true }),
      retryLimit: normalizeSafeInteger(constraints.retryLimit ?? null, "constraints.retryLimit", { min: 0, allowNull: true }),
      deadlineAt
    },
    { path: "$.constraints" }
  );
}

function normalizeIntentBinding(intentBinding, { fieldName = "intentBinding", allowNull = true } = {}) {
  if (intentBinding === null || intentBinding === undefined) {
    if (allowNull) return null;
    throw new TypeError(`${fieldName} is required`);
  }
  assertPlainObject(intentBinding, fieldName);
  const schemaVersion = assertNonEmptyString(intentBinding.schemaVersion ?? "IntentBinding.v1", `${fieldName}.schemaVersion`, { max: 128 });
  if (schemaVersion !== "IntentBinding.v1") {
    throw new TypeError(`${fieldName}.schemaVersion must be IntentBinding.v1`);
  }
  return normalizeForCanonicalJson(
    {
      schemaVersion,
      intentId: assertNonEmptyString(intentBinding.intentId, `${fieldName}.intentId`, { max: 200 }),
      intentHash: assertSha256Hex(intentBinding.intentHash, `${fieldName}.intentHash`),
      boundAt: normalizeIsoDateTime(intentBinding.boundAt, `${fieldName}.boundAt`)
    },
    { path: `$.${fieldName}` }
  );
}

function normalizeSettlement(settlement) {
  if (settlement === null || settlement === undefined) return null;
  assertPlainObject(settlement, "settlement");
  return normalizeForCanonicalJson(
    {
      status: normalizeSettlementStatus(settlement.status, "settlement.status"),
      traceId: normalizeOptionalString(settlement.traceId, "settlement.traceId", { max: 256 }),
      x402GateId: assertNonEmptyString(settlement.x402GateId, "settlement.x402GateId", { max: 200 }),
      x402RunId: assertNonEmptyString(settlement.x402RunId, "settlement.x402RunId", { max: 200 }),
      x402SettlementStatus: assertNonEmptyString(settlement.x402SettlementStatus, "settlement.x402SettlementStatus", { max: 64 }).toLowerCase(),
      x402ReceiptId: normalizeOptionalString(settlement.x402ReceiptId, "settlement.x402ReceiptId", { max: 200 }),
      authorityGrantRef: normalizeOptionalString(settlement.authorityGrantRef, "settlement.authorityGrantRef", { max: 200 }),
      completionReceiptId: assertNonEmptyString(settlement.completionReceiptId, "settlement.completionReceiptId", { max: 200 }),
      settledAt: normalizeIsoDateTime(settlement.settledAt, "settlement.settledAt")
    },
    { path: "$.settlement" }
  );
}

export function buildSubAgentWorkOrderV1({
  workOrderId,
  tenantId,
  parentTaskId = null,
  principalAgentId,
  subAgentId,
  requiredCapability,
  traceId = null,
  x402ToolId = null,
  x402ProviderId = null,
  specification,
  pricing,
  constraints = null,
  evidencePolicy = null,
  delegationGrantRef = null,
  authorityGrantRef = null,
  intentBinding = null,
  metadata = null,
  createdAt = new Date().toISOString()
} = {}) {
  const normalizedCreatedAt = normalizeIsoDateTime(createdAt, "createdAt");
  const normalizedSpecification = specification === null || specification === undefined ? {} : specification;
  assertPlainObject(normalizedSpecification, "specification");
  const workOrder = normalizeForCanonicalJson(
    {
      schemaVersion: SUB_AGENT_WORK_ORDER_SCHEMA_VERSION,
      workOrderId: assertNonEmptyString(workOrderId, "workOrderId", { max: 200 }),
      tenantId: assertNonEmptyString(tenantId, "tenantId", { max: 128 }),
      parentTaskId: normalizeOptionalString(parentTaskId, "parentTaskId", { max: 200 }),
      principalAgentId: assertNonEmptyString(principalAgentId, "principalAgentId", { max: 200 }),
      subAgentId: assertNonEmptyString(subAgentId, "subAgentId", { max: 200 }),
      requiredCapability: assertNonEmptyString(requiredCapability, "requiredCapability", { max: 256 }),
      traceId: normalizeOptionalString(traceId, "traceId", { max: 256 }),
      x402ToolId: normalizeOptionalString(x402ToolId, "x402ToolId", { max: 200 }),
      x402ProviderId: normalizeOptionalString(x402ProviderId, "x402ProviderId", { max: 200 }),
      specification: normalizeForCanonicalJson(normalizedSpecification, { path: "$.specification" }),
      pricing: normalizePricing(pricing),
      constraints: normalizeConstraints(constraints),
      evidencePolicy: normalizeEvidencePolicy(evidencePolicy),
      delegationGrantRef: normalizeOptionalString(delegationGrantRef, "delegationGrantRef", { max: 200 }),
      authorityGrantRef: normalizeOptionalString(authorityGrantRef, "authorityGrantRef", { max: 200 }),
      intentBinding: normalizeIntentBinding(intentBinding, { fieldName: "intentBinding", allowNull: true }),
      status: SUB_AGENT_WORK_ORDER_STATUS.CREATED,
      progressEvents: [],
      acceptedByAgentId: null,
      acceptedAt: null,
      completedAt: null,
      completionReceiptId: null,
      settlement: null,
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? normalizeForCanonicalJson(metadata, { path: "$.metadata" }) : null,
      createdAt: normalizedCreatedAt,
      updatedAt: normalizedCreatedAt,
      revision: 0
    },
    { path: "$" }
  );
  validateSubAgentWorkOrderV1(workOrder);
  return workOrder;
}

export function validateSubAgentWorkOrderV1(workOrder) {
  assertPlainObject(workOrder, "workOrder");
  if (workOrder.schemaVersion !== SUB_AGENT_WORK_ORDER_SCHEMA_VERSION) {
    throw new TypeError(`workOrder.schemaVersion must be ${SUB_AGENT_WORK_ORDER_SCHEMA_VERSION}`);
  }
  assertNonEmptyString(workOrder.workOrderId, "workOrder.workOrderId", { max: 200 });
  assertNonEmptyString(workOrder.tenantId, "workOrder.tenantId", { max: 128 });
  assertNonEmptyString(workOrder.principalAgentId, "workOrder.principalAgentId", { max: 200 });
  assertNonEmptyString(workOrder.subAgentId, "workOrder.subAgentId", { max: 200 });
  assertNonEmptyString(workOrder.requiredCapability, "workOrder.requiredCapability", { max: 256 });
  if (workOrder.traceId !== null && workOrder.traceId !== undefined) {
    normalizeOptionalString(workOrder.traceId, "workOrder.traceId", { max: 256 });
  }
  if (workOrder.x402ToolId !== null && workOrder.x402ToolId !== undefined) {
    normalizeOptionalString(workOrder.x402ToolId, "workOrder.x402ToolId", { max: 200 });
  }
  if (workOrder.x402ProviderId !== null && workOrder.x402ProviderId !== undefined) {
    normalizeOptionalString(workOrder.x402ProviderId, "workOrder.x402ProviderId", { max: 200 });
  }
  normalizeWorkOrderStatus(workOrder.status, "workOrder.status");
  normalizePricing(workOrder.pricing);
  if (workOrder.constraints !== null && workOrder.constraints !== undefined) normalizeConstraints(workOrder.constraints);
  if (workOrder.evidencePolicy !== null && workOrder.evidencePolicy !== undefined) normalizeEvidencePolicy(workOrder.evidencePolicy);
  if (workOrder.delegationGrantRef !== null && workOrder.delegationGrantRef !== undefined) {
    normalizeOptionalString(workOrder.delegationGrantRef, "workOrder.delegationGrantRef", { max: 200 });
  }
  if (workOrder.authorityGrantRef !== null && workOrder.authorityGrantRef !== undefined) {
    normalizeOptionalString(workOrder.authorityGrantRef, "workOrder.authorityGrantRef", { max: 200 });
  }
  if (workOrder.intentBinding !== null && workOrder.intentBinding !== undefined) {
    normalizeIntentBinding(workOrder.intentBinding, { fieldName: "workOrder.intentBinding", allowNull: false });
  }
  normalizeIsoDateTime(workOrder.createdAt, "workOrder.createdAt");
  normalizeIsoDateTime(workOrder.updatedAt, "workOrder.updatedAt");
  if (workOrder.acceptedAt !== null && workOrder.acceptedAt !== undefined) normalizeIsoDateTime(workOrder.acceptedAt, "workOrder.acceptedAt");
  if (workOrder.completedAt !== null && workOrder.completedAt !== undefined) normalizeIsoDateTime(workOrder.completedAt, "workOrder.completedAt");
  if (workOrder.acceptedByAgentId !== null && workOrder.acceptedByAgentId !== undefined) {
    assertNonEmptyString(workOrder.acceptedByAgentId, "workOrder.acceptedByAgentId", { max: 200 });
  }
  if (workOrder.completionReceiptId !== null && workOrder.completionReceiptId !== undefined) {
    assertNonEmptyString(workOrder.completionReceiptId, "workOrder.completionReceiptId", { max: 200 });
  }
  normalizeProgressEvents(workOrder.progressEvents ?? []);
  if (workOrder.settlement !== null && workOrder.settlement !== undefined) normalizeSettlement(workOrder.settlement);
  const revision = Number(workOrder.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError("workOrder.revision must be a non-negative safe integer");
  return true;
}

export function acceptSubAgentWorkOrderV1({ workOrder, acceptedByAgentId = null, acceptedAt = new Date().toISOString() } = {}) {
  validateSubAgentWorkOrderV1(workOrder);
  const status = normalizeWorkOrderStatus(workOrder.status);
  if (TERMINAL_WORK_ORDER_STATUSES.has(status)) throw new TypeError(`work order cannot be accepted from status ${status}`);
  const normalizedAcceptedBy = assertNonEmptyString(acceptedByAgentId ?? workOrder.subAgentId, "acceptedByAgentId", { max: 200 });
  if (normalizedAcceptedBy !== String(workOrder.subAgentId)) {
    throw new TypeError("acceptedByAgentId must match workOrder.subAgentId");
  }
  const normalizedAcceptedAt = normalizeIsoDateTime(acceptedAt, "acceptedAt");
  return normalizeForCanonicalJson(
    {
      ...workOrder,
      status: SUB_AGENT_WORK_ORDER_STATUS.ACCEPTED,
      acceptedByAgentId: normalizedAcceptedBy,
      acceptedAt: normalizedAcceptedAt,
      updatedAt: normalizedAcceptedAt,
      revision: Number(workOrder.revision ?? 0) + 1
    },
    { path: "$" }
  );
}

export function appendSubAgentWorkOrderProgressV1({
  workOrder,
  progressId,
  eventType = "progress",
  message = null,
  percentComplete = null,
  evidenceRefs = [],
  at = new Date().toISOString()
} = {}) {
  validateSubAgentWorkOrderV1(workOrder);
  const status = normalizeWorkOrderStatus(workOrder.status);
  if (TERMINAL_WORK_ORDER_STATUSES.has(status)) throw new TypeError(`work order cannot accept progress in status ${status}`);
  const progressEvent = normalizeForCanonicalJson(
    {
      progressId: assertNonEmptyString(progressId, "progressId", { max: 200 }),
      eventType: assertNonEmptyString(eventType, "eventType", { max: 64 }).toLowerCase(),
      message: normalizeOptionalString(message, "message", { max: 2000 }),
      percentComplete: normalizeSafeInteger(percentComplete, "percentComplete", { min: 0, allowNull: true }),
      evidenceRefs: normalizeStringArray(evidenceRefs, "evidenceRefs", { max: 500 }),
      at: normalizeIsoDateTime(at, "at")
    },
    { path: "$.progressEvent" }
  );
  if (progressEvent.percentComplete !== null && progressEvent.percentComplete > 100) {
    throw new TypeError("percentComplete must be <= 100");
  }
  const nextProgressEvents = [...(Array.isArray(workOrder.progressEvents) ? workOrder.progressEvents : []), progressEvent];
  return normalizeForCanonicalJson(
    {
      ...workOrder,
      progressEvents: nextProgressEvents,
      status:
        status === SUB_AGENT_WORK_ORDER_STATUS.CREATED || status === SUB_AGENT_WORK_ORDER_STATUS.ACCEPTED
          ? SUB_AGENT_WORK_ORDER_STATUS.WORKING
          : status,
      updatedAt: progressEvent.at,
      revision: Number(workOrder.revision ?? 0) + 1
    },
    { path: "$" }
  );
}

function buildSubAgentCompletionReceiptHash(receipt) {
  const canonical = canonicalJsonStringify({
    ...receipt,
    receiptHash: null
  });
  return sha256Hex(canonical);
}

function buildExecutionAttestationHash(attestation) {
  const canonical = canonicalJsonStringify({
    ...attestation,
    attestationHash: null
  });
  return sha256Hex(canonical);
}

function normalizeExecutionAttestation(
  executionAttestation,
  { fieldPath = "$.executionAttestation", expectedWorkOrderId = null, allowNull = true } = {}
) {
  if (executionAttestation === null || executionAttestation === undefined) {
    if (allowNull) return null;
    throw new TypeError(`${fieldPath} is required`);
  }
  assertPlainObject(executionAttestation, fieldPath);
  const schemaVersion = assertNonEmptyString(
    executionAttestation.schemaVersion ?? SUB_AGENT_EXECUTION_ATTESTATION_SCHEMA_VERSION,
    `${fieldPath}.schemaVersion`,
    { max: 128 }
  );
  if (schemaVersion !== SUB_AGENT_EXECUTION_ATTESTATION_SCHEMA_VERSION) {
    throw new TypeError(`${fieldPath}.schemaVersion must be ${SUB_AGENT_EXECUTION_ATTESTATION_SCHEMA_VERSION}`);
  }
  const normalizedWorkOrderId = assertNonEmptyString(executionAttestation.workOrderId, `${fieldPath}.workOrderId`, { max: 200 });
  if (expectedWorkOrderId !== null && expectedWorkOrderId !== undefined && String(expectedWorkOrderId) !== normalizedWorkOrderId) {
    throw new TypeError(`${fieldPath}.workOrderId must match workOrder.workOrderId`);
  }
  const attestationBase = normalizeForCanonicalJson(
    {
      schemaVersion: SUB_AGENT_EXECUTION_ATTESTATION_SCHEMA_VERSION,
      attestationId: assertNonEmptyString(executionAttestation.attestationId, `${fieldPath}.attestationId`, { max: 200 }),
      workOrderId: normalizedWorkOrderId,
      executionId: assertNonEmptyString(executionAttestation.executionId, `${fieldPath}.executionId`, { max: 200 }),
      attester: assertNonEmptyString(executionAttestation.attester, `${fieldPath}.attester`, { max: 200 }),
      evidenceHash: assertSha256Hex(executionAttestation.evidenceHash, `${fieldPath}.evidenceHash`),
      attestedAt: normalizeIsoDateTime(executionAttestation.attestedAt, `${fieldPath}.attestedAt`),
      runtime:
        executionAttestation.runtime && typeof executionAttestation.runtime === "object" && !Array.isArray(executionAttestation.runtime)
          ? normalizeForCanonicalJson(executionAttestation.runtime, { path: `${fieldPath}.runtime` })
          : null,
      signerKeyId: normalizeOptionalString(executionAttestation.signerKeyId, `${fieldPath}.signerKeyId`, { max: 200 }),
      signature: normalizeOptionalString(executionAttestation.signature, `${fieldPath}.signature`, { max: 8192 }),
      metadata:
        executionAttestation.metadata && typeof executionAttestation.metadata === "object" && !Array.isArray(executionAttestation.metadata)
          ? normalizeForCanonicalJson(executionAttestation.metadata, { path: `${fieldPath}.metadata` })
          : null,
      attestationHash: null
    },
    { path: fieldPath }
  );
  const computedHash = buildExecutionAttestationHash(attestationBase);
  const providedHash =
    executionAttestation.attestationHash === null ||
    executionAttestation.attestationHash === undefined ||
    String(executionAttestation.attestationHash).trim() === ""
      ? null
      : assertSha256Hex(executionAttestation.attestationHash, `${fieldPath}.attestationHash`);
  if (providedHash && providedHash !== computedHash) {
    throw new TypeError(`${fieldPath}.attestationHash mismatch`);
  }
  return normalizeForCanonicalJson(
    {
      ...attestationBase,
      attestationHash: computedHash
    },
    { path: fieldPath }
  );
}

export function buildExecutionAttestationV1({
  attestationId,
  workOrderId,
  executionId,
  attester,
  evidenceHash,
  attestedAt = new Date().toISOString(),
  runtime = null,
  signerKeyId = null,
  signature = null,
  metadata = null
} = {}) {
  return normalizeExecutionAttestation(
    {
      schemaVersion: SUB_AGENT_EXECUTION_ATTESTATION_SCHEMA_VERSION,
      attestationId,
      workOrderId,
      executionId,
      attester,
      evidenceHash,
      attestedAt,
      runtime,
      signerKeyId,
      signature,
      metadata
    },
    { fieldPath: "$.executionAttestation", expectedWorkOrderId: workOrderId, allowNull: false }
  );
}

export function buildSubAgentCompletionReceiptV1({
  receiptId,
  tenantId,
  workOrder,
  status = SUB_AGENT_COMPLETION_STATUS.SUCCESS,
  outputs = null,
  metrics = null,
  evidenceRefs = [],
  executionAttestation = null,
  amountCents = null,
  currency = null,
  intentHash = null,
  traceId = null,
  deliveredAt = new Date().toISOString(),
  metadata = null
} = {}) {
  validateSubAgentWorkOrderV1(workOrder);
  const normalizedStatus = normalizeCompletionStatus(status, "status");
  const normalizedDeliveredAt = normalizeIsoDateTime(deliveredAt, "deliveredAt");
  const resolvedAmountCents =
    amountCents === null || amountCents === undefined
      ? normalizeSafeInteger(workOrder?.pricing?.amountCents, "workOrder.pricing.amountCents", { min: 1 })
      : normalizeSafeInteger(amountCents, "amountCents", { min: 0 });
  const resolvedCurrency = normalizeCurrency(currency ?? workOrder?.pricing?.currency ?? "USD", "currency");
  const receiptBase = normalizeForCanonicalJson(
    {
      schemaVersion: SUB_AGENT_COMPLETION_RECEIPT_SCHEMA_VERSION,
      receiptId: assertNonEmptyString(receiptId, "receiptId", { max: 200 }),
      tenantId: assertNonEmptyString(tenantId, "tenantId", { max: 128 }),
      workOrderId: assertNonEmptyString(workOrder.workOrderId, "workOrder.workOrderId", { max: 200 }),
      principalAgentId: assertNonEmptyString(workOrder.principalAgentId, "workOrder.principalAgentId", { max: 200 }),
      subAgentId: assertNonEmptyString(workOrder.subAgentId, "workOrder.subAgentId", { max: 200 }),
      status: normalizedStatus,
      traceId: normalizeOptionalString(traceId, "traceId", { max: 256 }),
      outputs:
        outputs && typeof outputs === "object" && !Array.isArray(outputs)
          ? normalizeForCanonicalJson(outputs, { path: "$.outputs" })
          : Array.isArray(outputs)
            ? outputs.map((entry, index) => normalizeForCanonicalJson(entry, { path: `$.outputs[${index}]` }))
            : null,
      metrics: metrics && typeof metrics === "object" && !Array.isArray(metrics) ? normalizeForCanonicalJson(metrics, { path: "$.metrics" }) : null,
      evidenceRefs: normalizeStringArray(evidenceRefs, "evidenceRefs", { max: 500 }),
      executionAttestation: normalizeExecutionAttestation(executionAttestation, {
        fieldPath: "$.executionAttestation",
        expectedWorkOrderId: workOrder.workOrderId,
        allowNull: true
      }),
      settlementQuote: {
        amountCents: resolvedAmountCents,
        currency: resolvedCurrency
      },
      intentHash: intentHash === null || intentHash === undefined ? normalizeOptionalString(workOrder?.intentBinding?.intentHash ?? null, "intentHash", { max: 64 }) : assertSha256Hex(intentHash, "intentHash"),
      deliveredAt: normalizedDeliveredAt,
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? normalizeForCanonicalJson(metadata, { path: "$.metadata" }) : null,
      receiptHash: null
    },
    { path: "$" }
  );
  const receiptHash = buildSubAgentCompletionReceiptHash(receiptBase);
  const receipt = normalizeForCanonicalJson({ ...receiptBase, receiptHash }, { path: "$" });
  validateSubAgentCompletionReceiptV1(receipt);
  return receipt;
}

export function validateSubAgentCompletionReceiptV1(receipt) {
  assertPlainObject(receipt, "receipt");
  if (receipt.schemaVersion !== SUB_AGENT_COMPLETION_RECEIPT_SCHEMA_VERSION) {
    throw new TypeError(`receipt.schemaVersion must be ${SUB_AGENT_COMPLETION_RECEIPT_SCHEMA_VERSION}`);
  }
  assertNonEmptyString(receipt.receiptId, "receipt.receiptId", { max: 200 });
  assertNonEmptyString(receipt.tenantId, "receipt.tenantId", { max: 128 });
  assertNonEmptyString(receipt.workOrderId, "receipt.workOrderId", { max: 200 });
  assertNonEmptyString(receipt.principalAgentId, "receipt.principalAgentId", { max: 200 });
  assertNonEmptyString(receipt.subAgentId, "receipt.subAgentId", { max: 200 });
  normalizeCompletionStatus(receipt.status, "receipt.status");
  if (receipt.traceId !== null && receipt.traceId !== undefined) {
    normalizeOptionalString(receipt.traceId, "receipt.traceId", { max: 256 });
  }
  normalizeIsoDateTime(receipt.deliveredAt, "receipt.deliveredAt");
  assertPlainObject(receipt.settlementQuote, "receipt.settlementQuote");
  normalizeSafeInteger(receipt.settlementQuote.amountCents, "receipt.settlementQuote.amountCents", { min: 0 });
  normalizeCurrency(receipt.settlementQuote.currency, "receipt.settlementQuote.currency");
  if (receipt.intentHash !== null && receipt.intentHash !== undefined) {
    assertSha256Hex(receipt.intentHash, "receipt.intentHash");
  }
  normalizeStringArray(receipt.evidenceRefs ?? [], "receipt.evidenceRefs", { max: 500 });
  if (receipt.executionAttestation !== null && receipt.executionAttestation !== undefined) {
    normalizeExecutionAttestation(receipt.executionAttestation, {
      fieldPath: "$.executionAttestation",
      expectedWorkOrderId: receipt.workOrderId,
      allowNull: true
    });
  }
  const expectedHash = buildSubAgentCompletionReceiptHash(receipt);
  const actualHash = assertNonEmptyString(receipt.receiptHash, "receipt.receiptHash", { max: 64 }).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(actualHash)) throw new TypeError("receipt.receiptHash must be sha256 hex");
  if (actualHash !== expectedHash.toLowerCase()) throw new TypeError("receipt.receiptHash mismatch");
  return true;
}

export function completeSubAgentWorkOrderV1({ workOrder, completionReceipt, completedAt = null } = {}) {
  validateSubAgentWorkOrderV1(workOrder);
  validateSubAgentCompletionReceiptV1(completionReceipt);
  if (String(completionReceipt.workOrderId) !== String(workOrder.workOrderId)) {
    throw new TypeError("completion receipt workOrderId mismatch");
  }
  const status = normalizeWorkOrderStatus(workOrder.status);
  if (TERMINAL_WORK_ORDER_STATUSES.has(status)) throw new TypeError(`work order cannot be completed from status ${status}`);
  const resolvedCompletedAt =
    completedAt === null || completedAt === undefined
      ? normalizeIsoDateTime(completionReceipt.deliveredAt, "completionReceipt.deliveredAt")
      : normalizeIsoDateTime(completedAt, "completedAt");
  const nextStatus =
    completionReceipt.status === SUB_AGENT_COMPLETION_STATUS.SUCCESS
      ? SUB_AGENT_WORK_ORDER_STATUS.COMPLETED
      : SUB_AGENT_WORK_ORDER_STATUS.FAILED;
  return normalizeForCanonicalJson(
    {
      ...workOrder,
      status: nextStatus,
      completedAt: resolvedCompletedAt,
      completionReceiptId: completionReceipt.receiptId,
      updatedAt: resolvedCompletedAt,
      revision: Number(workOrder.revision ?? 0) + 1
    },
    { path: "$" }
  );
}

export function settleSubAgentWorkOrderV1({
  workOrder,
  completionReceiptId,
  completionReceipt = null,
  settlement,
  settledAt = new Date().toISOString()
} = {}) {
  validateSubAgentWorkOrderV1(workOrder);
  if (completionReceipt !== null && completionReceipt !== undefined) {
    validateSubAgentCompletionReceiptV1(completionReceipt);
  }
  const currentStatus = normalizeWorkOrderStatus(workOrder.status);
  if (currentStatus !== SUB_AGENT_WORK_ORDER_STATUS.COMPLETED && currentStatus !== SUB_AGENT_WORK_ORDER_STATUS.FAILED) {
    throw new TypeError(`work order cannot be settled from status ${currentStatus}`);
  }
  const normalizedReceiptId = assertNonEmptyString(completionReceiptId, "completionReceiptId", { max: 200 });
  if (String(workOrder.completionReceiptId ?? "") !== normalizedReceiptId) {
    throw new TypeError("completionReceiptId does not match work order");
  }
  const normalizedSettledAt = normalizeIsoDateTime(settledAt, "settledAt");
  const normalizedSettlement = normalizeSettlement({
    ...settlement,
    completionReceiptId: normalizedReceiptId,
    settledAt: settlement?.settledAt ?? normalizedSettledAt
  });
  const maxCostCents = normalizeSafeInteger(workOrder?.constraints?.maxCostCents ?? null, "workOrder.constraints.maxCostCents", {
    min: 0,
    allowNull: true
  });
  const settlementAmountCents =
    completionReceipt && typeof completionReceipt === "object" && completionReceipt.settlementQuote
      ? normalizeSafeInteger(completionReceipt.settlementQuote.amountCents, "completionReceipt.settlementQuote.amountCents", { min: 0 })
      : normalizeSafeInteger(workOrder?.pricing?.amountCents, "workOrder.pricing.amountCents", { min: 1 });
  if (maxCostCents !== null && settlementAmountCents > maxCostCents) {
    throw new TypeError("settlement amount exceeds work order constraints.maxCostCents");
  }
  return normalizeForCanonicalJson(
    {
      ...workOrder,
      status: SUB_AGENT_WORK_ORDER_STATUS.SETTLED,
      settlement: normalizedSettlement,
      updatedAt: normalizedSettledAt,
      revision: Number(workOrder.revision ?? 0) + 1
    },
    { path: "$" }
  );
}
