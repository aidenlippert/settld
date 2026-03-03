import { createLedger, addAccount, createAccount } from "../core/ledger.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../core/crypto.js";
import { createId } from "../core/ids.js";
import { createDefaultContract } from "../core/contracts.js";
import { DEFAULT_TENANT_ID, makeScopedKey, normalizeTenantId } from "../core/tenancy.js";
import { GOVERNANCE_STREAM_ID, validateServerSignerKeyRegisteredPayload } from "../core/governance.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { applyTxRecord, createFileTxLog, TX_LOG_VERSION } from "./persistence.js";
import { processOutbox } from "./outbox.js";
import { createFsEvidenceStore, createInMemoryEvidenceStore, createS3EvidenceStore } from "../core/evidence-store.js";
import { normalizeScopes } from "../core/auth.js";
import { normalizeSignerKeyPurpose, normalizeSignerKeyStatus } from "../core/signer-keys.js";
import { MONTH_CLOSE_HOLD_POLICY, normalizeMonthCloseHoldPolicy } from "../core/month-close-hold-policy.js";
import { clampQuota } from "../core/quotas.js";
import { computeFinanceAccountMapHash, validateFinanceAccountMapV1 } from "../core/finance-account-map.js";
import { appendChainedEvent, createChainedEvent } from "../core/event-chain.js";
import { normalizeBillingPlanId } from "../core/billing-plans.js";
import { validateAgentCardV1 } from "../core/agent-card.js";
import { validateSessionV1 } from "../core/session-collab.js";
import { validateStateCheckpointV1 } from "../core/state-checkpoint.js";
import { normalizeCapabilityIdentifier } from "../core/capability-attestation.js";
import { makeOpsAuditRecord } from "../core/ops-audit.js";
import {
  buildIdentityLogEntry,
  buildIdentityLogCheckpoint,
  parseIdentityLogEntryFromAuditDetails,
  validateIdentityLogEntry,
  validateIdentityLogEntriesAppendOnly,
  IDENTITY_LOG_OPS_AUDIT_ACTION
} from "../core/identity-transparency-log.js";

const SERVER_SIGNER_FILENAME = "server-signer.json";
const NOOTERRA_PAY_KEYSET_STORE_FILENAME = "nooterra-pay-keyset-store.json";
const EMERGENCY_SCOPE_TYPE = Object.freeze({
  TENANT: "tenant",
  AGENT: "agent",
  ADAPTER: "adapter"
});
const EMERGENCY_SCOPE_TYPES = new Set(Object.values(EMERGENCY_SCOPE_TYPE));
const EMERGENCY_CONTROL_TYPE = Object.freeze({
  PAUSE: "pause",
  QUARANTINE: "quarantine",
  REVOKE: "revoke",
  KILL_SWITCH: "kill-switch"
});
const EMERGENCY_CONTROL_TYPES = Object.values(EMERGENCY_CONTROL_TYPE);
const EMERGENCY_CONTROL_TYPES_SET = new Set(EMERGENCY_CONTROL_TYPES);
const EMERGENCY_ACTION = Object.freeze({
  PAUSE: "pause",
  QUARANTINE: "quarantine",
  REVOKE: "revoke",
  KILL_SWITCH: "kill-switch",
  RESUME: "resume"
});
const EMERGENCY_ACTIONS = new Set(Object.values(EMERGENCY_ACTION));
const AUTONOMOUS_ROUTINE_STATUS = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused"
});
const AUTONOMOUS_ROUTINE_STATUSES = new Set(Object.values(AUTONOMOUS_ROUTINE_STATUS));
const AUTONOMOUS_ROUTINE_CONTROL_ACTION = Object.freeze({
  KILL_SWITCH: "kill-switch",
  RESUME: "resume"
});
const AUTONOMOUS_ROUTINE_CONTROL_ACTIONS = new Set(Object.values(AUTONOMOUS_ROUTINE_CONTROL_ACTION));

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function normalizeNooterraPayPreviousRows(rows) {
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const publicKeyPem = typeof row.publicKeyPem === "string" ? row.publicKeyPem : "";
    if (!publicKeyPem.trim()) continue;
    const derivedKeyId = keyIdFromPublicKeyPem(publicKeyPem);
    const keyId = typeof row.keyId === "string" && row.keyId.trim() !== "" ? row.keyId.trim() : derivedKeyId;
    if (keyId !== derivedKeyId) throw new Error("invalid nooterra-pay-keyset-store.json: previous[].keyId mismatch");
    if (seen.has(keyId)) continue;
    seen.add(keyId);
    const rotatedAt = typeof row.rotatedAt === "string" && row.rotatedAt.trim() !== "" ? row.rotatedAt.trim() : null;
    out.push({ keyId, publicKeyPem, rotatedAt });
  }
  return out;
}

function normalizeNooterraPayKeysetStore(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid nooterra-pay-keyset-store.json: object expected");
  }
  const active = payload.active;
  if (!active || typeof active !== "object" || Array.isArray(active)) {
    throw new Error("invalid nooterra-pay-keyset-store.json: active key missing");
  }
  const activePublicKeyPem = typeof active.publicKeyPem === "string" ? active.publicKeyPem : "";
  const activePrivateKeyPem = typeof active.privateKeyPem === "string" ? active.privateKeyPem : "";
  if (!activePublicKeyPem.trim() || !activePrivateKeyPem.trim()) {
    throw new Error("invalid nooterra-pay-keyset-store.json: active keypair missing");
  }
  const activeDerivedKeyId = keyIdFromPublicKeyPem(activePublicKeyPem);
  const activeKeyId = typeof active.keyId === "string" && active.keyId.trim() !== "" ? active.keyId.trim() : activeDerivedKeyId;
  if (activeKeyId !== activeDerivedKeyId) throw new Error("invalid nooterra-pay-keyset-store.json: active.keyId mismatch");

  const previous = normalizeNooterraPayPreviousRows(payload.previous);
  return {
    active: {
      keyId: activeKeyId,
      publicKeyPem: activePublicKeyPem,
      privateKeyPem: activePrivateKeyPem
    },
    previous
  };
}

function loadOrCreateServerSigner({ persistenceDir }) {
  if (!persistenceDir) {
    const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
    return { active: { publicKeyPem, privateKeyPem }, previous: [], source: "generated-ephemeral" };
  }

  fs.mkdirSync(persistenceDir, { recursive: true });
  const keysetStorePath = path.join(persistenceDir, NOOTERRA_PAY_KEYSET_STORE_FILENAME);
  const signerPath = path.join(persistenceDir, SERVER_SIGNER_FILENAME);
  if (fs.existsSync(keysetStorePath)) {
    const parsed = readJsonFileSafe(keysetStorePath);
    const normalized = normalizeNooterraPayKeysetStore(parsed);
    // Keep legacy signer file in sync for compatibility with existing tooling.
    fs.writeFileSync(
      signerPath,
      JSON.stringify({ publicKeyPem: normalized.active.publicKeyPem, privateKeyPem: normalized.active.privateKeyPem }, null, 2),
      "utf8"
    );
    return {
      active: { publicKeyPem: normalized.active.publicKeyPem, privateKeyPem: normalized.active.privateKeyPem },
      previous: normalized.previous,
      source: "keyset-store"
    };
  }

  if (fs.existsSync(signerPath)) {
    const parsed = JSON.parse(fs.readFileSync(signerPath, "utf8"));
    if (!parsed?.publicKeyPem || !parsed?.privateKeyPem) throw new Error("invalid server-signer.json");
    return {
      active: { publicKeyPem: parsed.publicKeyPem, privateKeyPem: parsed.privateKeyPem },
      previous: [],
      source: "legacy-signer"
    };
  }

  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  fs.writeFileSync(signerPath, JSON.stringify({ publicKeyPem, privateKeyPem }, null, 2), "utf8");
  return { active: { publicKeyPem, privateKeyPem }, previous: [], source: "generated-persistent" };
}

function normalizeEmergencyScopeType(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMERGENCY_SCOPE_TYPES.has(normalized)) throw new TypeError("scope.type must be tenant|agent|adapter");
  return normalized;
}

function normalizeEmergencyScopeId(scopeType, value) {
  if (scopeType === EMERGENCY_SCOPE_TYPE.TENANT) return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError("scope.id is required for scope.type agent|adapter");
  return normalized;
}

function normalizeEmergencyControlType(value, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || String(value).trim() === "")) return null;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMERGENCY_CONTROL_TYPES_SET.has(normalized)) throw new TypeError("controlType must be pause|quarantine|revoke|kill-switch");
  return normalized;
}

function normalizeEmergencyAction(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMERGENCY_ACTIONS.has(normalized)) throw new TypeError("action must be pause|quarantine|revoke|kill-switch|resume");
  return normalized;
}

function normalizeEmergencyResumeControlTypes(value) {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? EMERGENCY_CONTROL_TYPES : [value];
  const dedupe = new Set();
  for (const item of values) {
    dedupe.add(normalizeEmergencyControlType(item, { allowNull: false }));
  }
  const out = Array.from(dedupe.values());
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

export function createStore({ persistenceDir = null, serverSignerKeypair = null } = {}) {
  const resolvedServerSignerKeypair =
    serverSignerKeypair && typeof serverSignerKeypair === "object"
      ? {
          publicKeyPem: serverSignerKeypair.publicKeyPem,
          privateKeyPem: serverSignerKeypair.privateKeyPem
        }
      : null;
  if (serverSignerKeypair && (!resolvedServerSignerKeypair?.publicKeyPem || !resolvedServerSignerKeypair?.privateKeyPem)) {
    throw new Error("invalid serverSignerKeypair");
  }

  const loadedServerSigner =
    resolvedServerSignerKeypair === null
      ? loadOrCreateServerSigner({ persistenceDir })
      : {
          active: {
            publicKeyPem: resolvedServerSignerKeypair.publicKeyPem,
            privateKeyPem: resolvedServerSignerKeypair.privateKeyPem
          },
          previous: [],
          source: "explicit-override"
        };
  const { publicKeyPem: serverPublicKeyPem, privateKeyPem: serverPrivateKeyPem } = loadedServerSigner.active;
  const serverKeyId = keyIdFromPublicKeyPem(serverPublicKeyPem);

  function parseEvidenceRetentionMaxDaysByTenant() {
    if (typeof process === "undefined") return new Map();
    const raw = process.env.PROXY_EVIDENCE_RETENTION_MAX_DAYS_BY_TENANT;
    if (!raw || String(raw).trim() === "") return new Map();
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch (err) {
      throw new Error(`invalid PROXY_EVIDENCE_RETENTION_MAX_DAYS_BY_TENANT JSON: ${err?.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("PROXY_EVIDENCE_RETENTION_MAX_DAYS_BY_TENANT must be a JSON object");
    }
    const map = new Map();
    for (const [tenantIdRaw, maxRaw] of Object.entries(parsed)) {
      const tenantId = normalizeTenantId(tenantIdRaw);
      const maxDays = Number(maxRaw);
      if (!Number.isSafeInteger(maxDays) || maxDays <= 0) {
        throw new Error(`PROXY_EVIDENCE_RETENTION_MAX_DAYS_BY_TENANT.${tenantId} must be a positive integer`);
      }
      map.set(tenantId, maxDays);
    }
    return map;
  }

  const evidenceRetentionMaxDaysByTenant = parseEvidenceRetentionMaxDaysByTenant();

  function parseMonthCloseHoldPolicyByTenant() {
    if (typeof process === "undefined") return new Map();
    const raw = process.env.PROXY_MONTH_CLOSE_HOLD_POLICY_BY_TENANT;
    if (!raw || String(raw).trim() === "") return new Map();
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch (err) {
      throw new Error(`invalid PROXY_MONTH_CLOSE_HOLD_POLICY_BY_TENANT JSON: ${err?.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("PROXY_MONTH_CLOSE_HOLD_POLICY_BY_TENANT must be a JSON object of tenantId -> policy");
    }
    const map = new Map();
    for (const [tenantIdRaw, policyRaw] of Object.entries(parsed)) {
      if (!tenantIdRaw) continue;
      map.set(normalizeTenantId(tenantIdRaw), normalizeMonthCloseHoldPolicy(policyRaw));
    }
    return map;
  }

  const monthCloseHoldPolicyByTenant = parseMonthCloseHoldPolicyByTenant();

  const defaultMonthCloseHoldPolicy = (() => {
    if (typeof process === "undefined") return MONTH_CLOSE_HOLD_POLICY.BLOCK_HOLDS_ORIGINATED_IN_PERIOD;
    try {
      return normalizeMonthCloseHoldPolicy(process.env.PROXY_MONTH_CLOSE_HOLD_POLICY ?? null);
    } catch {
      return MONTH_CLOSE_HOLD_POLICY.BLOCK_HOLDS_ORIGINATED_IN_PERIOD;
    }
  })();
  const defaultEvidenceRetentionMaxDaysRaw = typeof process !== "undefined" ? process.env.PROXY_EVIDENCE_RETENTION_MAX_DAYS : null;
  const defaultEvidenceRetentionMaxDays = defaultEvidenceRetentionMaxDaysRaw ? Number(defaultEvidenceRetentionMaxDaysRaw) : 365;
  if (!Number.isSafeInteger(defaultEvidenceRetentionMaxDays) || defaultEvidenceRetentionMaxDays <= 0) {
    throw new Error("PROXY_EVIDENCE_RETENTION_MAX_DAYS must be a positive integer");
  }

  function parseNonNegativeIntEnv(name, fallback) {
    const raw = typeof process !== "undefined" ? process.env[name] : null;
    if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative safe integer`);
    return n;
  }

  const ingestRecordsRetentionDays = parseNonNegativeIntEnv("PROXY_RETENTION_INGEST_RECORDS_DAYS", 0);
  const deliveriesRetentionDays = parseNonNegativeIntEnv("PROXY_RETENTION_DELIVERIES_DAYS", 0);
  const deliveryDlqRetentionDays = parseNonNegativeIntEnv("PROXY_RETENTION_DELIVERY_DLQ_DAYS", deliveriesRetentionDays);

  const maxOpenJobs = parseNonNegativeIntEnv("PROXY_QUOTA_MAX_OPEN_JOBS", 0);
  const maxPendingDeliveries = parseNonNegativeIntEnv("PROXY_QUOTA_MAX_PENDING_DELIVERIES", 0);
  const maxIngestDlqDepth = parseNonNegativeIntEnv("PROXY_QUOTA_MAX_INGEST_DLQ_DEPTH", 0);
  const maxEvidenceRefsPerJob = parseNonNegativeIntEnv("PROXY_QUOTA_MAX_EVIDENCE_REFS_PER_JOB", 0);
  const maxArtifactsPerJobType = parseNonNegativeIntEnv("PROXY_QUOTA_MAX_ARTIFACTS_PER_JOB_TYPE", 0);
  const platformMaxPendingDeliveries = parseNonNegativeIntEnv("PROXY_QUOTA_PLATFORM_MAX_PENDING_DELIVERIES", 0);
  const defaultBillingPlan = (() => {
    const raw = typeof process !== "undefined" ? process.env.PROXY_BILLING_DEFAULT_PLAN : null;
    if (raw === null || raw === undefined || String(raw).trim() === "") return "free";
    return normalizeBillingPlanId(raw, { allowNull: false, defaultPlan: "free" });
  })();

  function createTenantLedger() {
    const ledger = createLedger();
    addAccount(ledger, createAccount({ id: "acct_cash", name: "Cash (Payment Processor Clearing)", type: "asset" }));
    addAccount(ledger, createAccount({ id: "acct_customer_escrow", name: "Customer Escrow", type: "liability" }));
    addAccount(ledger, createAccount({ id: "acct_platform_revenue", name: "Platform Revenue", type: "revenue" }));
    addAccount(ledger, createAccount({ id: "acct_owner_payable", name: "Owner Payable", type: "liability" }));
    addAccount(ledger, createAccount({ id: "acct_operator_payable", name: "Operator Payable", type: "liability" }));
    addAccount(ledger, createAccount({ id: "acct_developer_royalty_payable", name: "Developer Royalties Payable", type: "liability" }));
    addAccount(ledger, createAccount({ id: "acct_insurance_reserve", name: "Insurance Reserve", type: "reserve" }));
    addAccount(ledger, createAccount({ id: "acct_coverage_reserve", name: "Coverage Reserve", type: "reserve" }));
    addAccount(ledger, createAccount({ id: "acct_coverage_unearned", name: "Coverage Unearned (Deferred)", type: "liability" }));
    addAccount(ledger, createAccount({ id: "acct_coverage_revenue", name: "Coverage Revenue", type: "revenue" }));
    addAccount(ledger, createAccount({ id: "acct_coverage_payout_expense", name: "Coverage Payout Expense", type: "expense" }));
    addAccount(ledger, createAccount({ id: "acct_insurer_receivable", name: "Insurer Receivable", type: "asset" }));
    addAccount(ledger, createAccount({ id: "acct_operator_chargeback_receivable", name: "Operator Chargeback Receivable", type: "asset" }));
    addAccount(ledger, createAccount({ id: "acct_claims_expense", name: "Claims Expense", type: "expense" }));
    addAccount(ledger, createAccount({ id: "acct_claims_payable", name: "Claims Payable", type: "liability" }));
    addAccount(ledger, createAccount({ id: "acct_operator_labor_expense", name: "Operator Labor Expense", type: "expense" }));
    addAccount(ledger, createAccount({ id: "acct_operator_cost_accrued", name: "Operator Cost Accrued", type: "liability" }));
    addAccount(ledger, createAccount({ id: "acct_sla_credits_expense", name: "SLA Credits Expense", type: "expense" }));
    addAccount(ledger, createAccount({ id: "acct_customer_credits_payable", name: "Customer Credits Payable", type: "liability" }));
    return ledger;
  }

  const ledgerByTenant = new Map();
  ledgerByTenant.set(DEFAULT_TENANT_ID, createTenantLedger());

  const configByTenant = new Map();
  configByTenant.set(DEFAULT_TENANT_ID, {
    operatorCost: {
      basis: "SHIFT_RATE",
      rateCentsPerMinuteByZone: { default: 0 }
    },
    slaCredits: {
      enabled: false,
      defaultAmountCents: 0,
      maxAmountCents: 0
    },
    evidenceRetentionMaxDays: evidenceRetentionMaxDaysByTenant.get(DEFAULT_TENANT_ID) ?? defaultEvidenceRetentionMaxDays,
    retention: {
      ingestRecordsDays: ingestRecordsRetentionDays,
      deliveriesDays: deliveriesRetentionDays,
      deliveryDlqDays: deliveryDlqRetentionDays
    },
    quotas: {
      maxOpenJobs,
      maxPendingDeliveries,
      maxIngestDlqDepth,
      maxEvidenceRefsPerJob,
      maxArtifactsPerJobType
    },
    finance: {
      accountMap: null,
      monthCloseHoldPolicy: defaultMonthCloseHoldPolicy
    },
    billing: {
      plan: defaultBillingPlan,
      planOverrides: null,
      hardLimitEnforced: true
    }
  });

  const publicKeyByKeyId = new Map();
  publicKeyByKeyId.set(serverKeyId, serverPublicKeyPem);

  const store = {
    kind: "memory",
    jobs: new Map(), // `${tenantId}\n${jobId}` -> snapshot
    jobEvents: new Map(), // `${tenantId}\n${jobId}` -> chained events
    months: new Map(), // `${tenantId}\n${monthStreamId}` -> snapshot
    monthEvents: new Map(), // `${tenantId}\n${monthStreamId}` -> chained events
    robots: new Map(), // `${tenantId}\n${robotId}` -> snapshot
    robotEvents: new Map(), // `${tenantId}\n${robotId}` -> chained events
    operators: new Map(), // `${tenantId}\n${operatorId}` -> snapshot
    operatorEvents: new Map(), // `${tenantId}\n${operatorId}` -> chained events
    agentIdentities: new Map(), // `${tenantId}\n${agentId}` -> AgentIdentity.v1 record
    agentCards: new Map(), // `${tenantId}\n${agentId}` -> AgentCard.v1 record
    agentCardAbuseReports: new Map(), // `${tenantId}\n${reportId}` -> AgentCardAbuseReport.v1
    sessions: new Map(), // `${tenantId}\n${sessionId}` -> Session.v1 record
    sessionEvents: new Map(), // `${tenantId}\n${sessionId}` -> SessionEvent.v1[] (chained envelope records)
    stateCheckpoints: new Map(), // `${tenantId}\n${checkpointId}` -> StateCheckpoint.v1
    agentPassports: new Map(), // `${tenantId}\n${agentId}` -> AgentPassport.v1 record
    agentWallets: new Map(), // `${tenantId}\n${agentId}` -> AgentWallet.v1 record
    agentRuns: new Map(), // `${tenantId}\n${runId}` -> AgentRun.v1 snapshot
    agentRunEvents: new Map(), // `${tenantId}\n${runId}` -> AgentEvent.v1[]
    agentRunSettlements: new Map(), // `${tenantId}\n${runId}` -> AgentRunSettlement.v1
    arbitrationCases: new Map(), // `${tenantId}\n${caseId}` -> ArbitrationCase.v1 snapshot
    agreementDelegations: new Map(), // `${tenantId}\n${delegationId}` -> AgreementDelegation.v1
    delegationGrants: new Map(), // `${tenantId}\n${grantId}` -> DelegationGrant.v1
    authorityGrants: new Map(), // `${tenantId}\n${grantId}` -> AuthorityGrant.v1
    taskQuotes: new Map(), // `${tenantId}\n${quoteId}` -> TaskQuote.v1
    taskOffers: new Map(), // `${tenantId}\n${offerId}` -> TaskOffer.v1
    taskAcceptances: new Map(), // `${tenantId}\n${acceptanceId}` -> TaskAcceptance.v1
    intentContracts: new Map(), // `${tenantId}\n${intentId}` -> IntentContract.v1
    capabilityAttestations: new Map(), // `${tenantId}\n${attestationId}` -> CapabilityAttestation.v1
    subAgentWorkOrders: new Map(), // `${tenantId}\n${workOrderId}` -> SubAgentWorkOrder.v1
    subAgentCompletionReceipts: new Map(), // `${tenantId}\n${receiptId}` -> SubAgentCompletionReceipt.v1
    x402Gates: new Map(), // `${tenantId}\n${gateId}` -> X402 gate record (internal API surface)
    x402Receipts: new Map(), // `${tenantId}\n${receiptId}` -> immutable X402ReceiptRecord.v1 base record
    x402WalletPolicies: new Map(), // `${tenantId}\n${sponsorWalletRef}::${policyRef}::${policyVersion}` -> X402WalletPolicy.v1
    x402ZkVerificationKeys: new Map(), // `${tenantId}\n${verificationKeyId}` -> X402ZkVerificationKey.v1
    x402ReversalEvents: new Map(), // `${tenantId}\n${eventId}` -> X402GateReversalEvent.v1
    x402ReversalNonceUsage: new Map(), // `${tenantId}\n${sponsorRef}\n${nonce}` -> X402ReversalNonceUsage.v1
    x402ReversalCommandUsage: new Map(), // `${tenantId}\n${commandId}` -> X402ReversalCommandUsage.v1
    x402Escalations: new Map(), // `${tenantId}\n${escalationId}` -> X402AuthorizationEscalation.v1
    x402EscalationEvents: new Map(), // `${tenantId}\n${eventId}` -> X402AuthorizationEscalationEvent.v1
    x402EscalationOverrideUsage: new Map(), // `${tenantId}\n${overrideId}` -> X402EscalationOverrideUsage.v1
    x402AgentLifecycles: new Map(), // `${tenantId}\n${agentId}` -> X402AgentLifecycle.v1
    x402WebhookEndpoints: new Map(), // `${tenantId}\n${endpointId}` -> X402WebhookEndpoint.v1
    emergencyControlEvents: new Map(), // `${tenantId}\n${eventId}` -> OpsEmergencyControlEvent.v1
    emergencyControlState: new Map(), // `${tenantId}\n${scopeType}::${scopeId}::${controlType}` -> OpsEmergencyControlState.v1
    autonomousRoutinePolicies: new Map(), // `${tenantId}\n${routineId}` -> AutonomousRoutinePolicy.v1
    autonomousRoutineControlEvents: new Map(), // `${tenantId}\n${incidentId}` -> AutonomousRoutineControlEvent.v1
    autonomousRoutineExecutions: new Map(), // `${tenantId}\n${routineId}::${executionId}` -> AutonomousRoutineExecutionReceipt.v1
    toolCallHolds: new Map(), // `${tenantId}\n${holdHash}` -> FundingHold.v1 snapshot
    settlementAdjustments: new Map(), // `${tenantId}\n${adjustmentId}` -> SettlementAdjustment.v1 snapshot
    moneyRailOperations: new Map(), // `${tenantId}\n${providerId}\n${operationId}` -> MoneyRailOperation.v1
    moneyRailProviderEvents: new Map(), // `${tenantId}\n${providerId}\n${operationId}\n${eventType}\n${eventDedupeKey}` -> MoneyRailProviderEvent.v1
    billableUsageEvents: new Map(), // `${tenantId}\n${eventKey}` -> BillableUsageEvent.v1
    financeReconciliationTriages: new Map(), // `${tenantId}\n${triageKey}` -> FinanceReconciliationTriage.v1
    marketplaceRfqs: new Map(), // `${tenantId}\n${rfqId}` -> MarketplaceRfq.v1
    marketplaceRfqBids: new Map(), // `${tenantId}\n${rfqId}` -> MarketplaceBid.v1[]
    marketplaceProviderPublications: new Map(), // `${tenantId}\n${providerRef}` -> MarketplaceProviderPublication.v1
    marketplaceCapabilityListings: new Map(), // `${tenantId}\n${listingId}` -> MarketplaceCapabilityListing.v1
    tenantSettlementPolicies: new Map(), // `${tenantId}\n${policyId}\n${policyVersion}` -> TenantSettlementPolicy.v1
    tenantSettlementPolicyRollouts: new Map(), // `${tenantId}\nrollout` -> TenantSettlementPolicyRollout.v1
	    contracts: new Map(), // `${tenantId}\n${contractId}` -> contract
	    idempotency: new Map(),
	    publicKeyByKeyId,
	    serverSigner: { keyId: serverKeyId, publicKeyPem: serverPublicKeyPem, privateKeyPem: serverPrivateKeyPem },
      nooterraPayFallbackKeys: loadedServerSigner.previous.map((row) => ({ keyId: row.keyId, publicKeyPem: row.publicKeyPem })),
	    ledgerByTenant,
	    // Back-compat: keep store.ledger and store.config as the default tenant's objects.
	    ledger: ledgerByTenant.get(DEFAULT_TENANT_ID),
	    configByTenant,
	    config: configByTenant.get(DEFAULT_TENANT_ID),
	    parties: new Map(), // `${tenantId}\n${partyId}` -> party record
	    partyStatements: new Map(), // `${tenantId}\n${partyId}\n${period}` -> party statement record
	    ledgerAllocations: new Map(), // `${tenantId}\n${entryId}\n${postingId}\n${partyId}` -> allocation
	    notifications: [],
	    outbox: [],
	    outboxCursor: 0,
    dispatchCursor: 0,
    operatorQueueCursor: 0,
    robotHealthCursor: 0,
    jobAccountingCursor: 0,
    monthCloseCursor: 0,
    artifactCursor: 0,
    deliveryCursor: 0,
    x402WinddownReversalCursor: 0,
    persistence: persistenceDir ? createFileTxLog({ dir: persistenceDir }) : null
  };

  // Allow createApi to inject a deterministic clock for tests/workers.
  store.nowIso = () => new Date().toISOString();

  const evidenceStoreKind =
    typeof process !== "undefined" && process.env.PROXY_EVIDENCE_STORE ? String(process.env.PROXY_EVIDENCE_STORE) : "fs";
  const evidenceDir =
    typeof process !== "undefined" && process.env.PROXY_EVIDENCE_DIR
      ? String(process.env.PROXY_EVIDENCE_DIR)
      : persistenceDir
        ? path.join(persistenceDir, "evidence")
        : path.join(os.tmpdir(), createId("proxy_evidence"));
  if (evidenceStoreKind === "memory") {
    store.evidenceStore = createInMemoryEvidenceStore();
  } else if (evidenceStoreKind === "s3" || evidenceStoreKind === "minio") {
    if (typeof process === "undefined") throw new Error("s3 evidence store requires process.env configuration");
    const endpoint = process.env.PROXY_EVIDENCE_S3_ENDPOINT;
    const region = process.env.PROXY_EVIDENCE_S3_REGION ?? "us-east-1";
    const bucket = process.env.PROXY_EVIDENCE_S3_BUCKET;
    const accessKeyId = process.env.PROXY_EVIDENCE_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.PROXY_EVIDENCE_S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY;
    const forcePathStyle = (process.env.PROXY_EVIDENCE_S3_FORCE_PATH_STYLE ?? "1") !== "0";
    store.evidenceStore = createS3EvidenceStore({
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle
    });
  } else {
    store.evidenceStore = createFsEvidenceStore({ rootDir: evidenceDir });
  }

  store.ensureTenant = function ensureTenant(tenantId) {
    tenantId = normalizeTenantId(tenantId);
    if (!store.ledgerByTenant.has(tenantId)) store.ledgerByTenant.set(tenantId, createTenantLedger());
    if (!store.configByTenant.has(tenantId)) {
      const base = store.configByTenant.get(DEFAULT_TENANT_ID);
      store.configByTenant.set(tenantId, JSON.parse(JSON.stringify(base)));
    }
    const cfg = store.configByTenant.get(tenantId);
    if (cfg && typeof cfg === "object") {
      const override = evidenceRetentionMaxDaysByTenant.get(tenantId);
      if (override) cfg.evidenceRetentionMaxDays = override;
      const policyOverride = monthCloseHoldPolicyByTenant.get(tenantId);
      if (policyOverride) {
        if (!cfg.finance) cfg.finance = {};
        cfg.finance.monthCloseHoldPolicy = policyOverride;
      }
    }
    if (store.contracts instanceof Map) {
      const defaultKey = makeScopedKey({ tenantId, id: "contract_default" });
      if (!store.contracts.has(defaultKey)) store.contracts.set(defaultKey, createDefaultContract({ tenantId }));
    }
  };

  store.getLedger = function getLedger(tenantId) {
    tenantId = normalizeTenantId(tenantId);
    store.ensureTenant(tenantId);
    return store.ledgerByTenant.get(tenantId);
  };

  store.getConfig = function getConfig(tenantId) {
    tenantId = normalizeTenantId(tenantId);
    store.ensureTenant(tenantId);
    return store.configByTenant.get(tenantId);
  };

  store.getTenantBillingConfig = async function getTenantBillingConfig({ tenantId = DEFAULT_TENANT_ID } = {}) {
    tenantId = normalizeTenantId(tenantId);
    store.ensureTenant(tenantId);
    const cfg = store.configByTenant.get(tenantId);
    const billing = cfg?.billing ?? null;
    return billing && typeof billing === "object" && !Array.isArray(billing) ? JSON.parse(JSON.stringify(billing)) : null;
  };

  store.putTenantBillingConfig = async function putTenantBillingConfig({ tenantId = DEFAULT_TENANT_ID, billing, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    store.ensureTenant(tenantId);
    if (!billing || typeof billing !== "object" || Array.isArray(billing)) {
      throw new TypeError("billing config is required");
    }
    const normalizedBilling = JSON.parse(JSON.stringify(billing));
    const cfg = store.configByTenant.get(tenantId);
    cfg.billing = normalizedBilling;
    if (audit) {
      await store.appendOpsAudit({ tenantId, audit });
    }
    return normalizedBilling;
  };

  store.getFinanceAccountMap = async function getFinanceAccountMap({ tenantId = DEFAULT_TENANT_ID } = {}) {
    tenantId = normalizeTenantId(tenantId);
    store.ensureTenant(tenantId);
    const cfg = store.configByTenant.get(tenantId);
    const map = cfg?.finance?.accountMap ?? null;
    return map && typeof map === "object" ? map : null;
  };

  store.putFinanceAccountMap = async function putFinanceAccountMap({ tenantId = DEFAULT_TENANT_ID, mapping, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    store.ensureTenant(tenantId);
    validateFinanceAccountMapV1(mapping);

    const cfg = store.configByTenant.get(tenantId);
    if (!cfg.finance) cfg.finance = {};
    cfg.finance.accountMap = mapping;

    if (audit) {
      await store.appendOpsAudit({ tenantId, audit });
    }

    return { tenantId, mappingHash: computeFinanceAccountMapHash(mapping), mapping };
  };

  // Ensure the default tenant is initialized (ledger/config/contract).
  store.ensureTenant(DEFAULT_TENANT_ID);

  store.commitTx = function commitTx({ at = new Date().toISOString(), ops, audit = null }) {
    if (!Array.isArray(ops) || ops.length === 0) throw new TypeError("commitTx requires non-empty ops[]");
    const nextOps = [...ops];
    if (audit) {
      const tenantId = normalizeTenantId(audit?.tenantId ?? DEFAULT_TENANT_ID);
      store.ensureTenant(tenantId);
      store.opsAuditSeq = Number.isSafeInteger(store.opsAuditSeq) ? store.opsAuditSeq : 0;
      store.opsAuditSeq += 1;
      const id = store.opsAuditSeq;
      const recordAudit = { ...(audit ?? {}), id, tenantId, at: audit?.at ?? at };
      nextOps.push({ kind: "OPS_AUDIT_APPEND", tenantId, audit: recordAudit });
    }
    const record = { v: TX_LOG_VERSION, at, txId: createId("tx"), ops: nextOps };
    if (store.persistence) store.persistence.append(record);
    applyTxRecord(store, record);
    processOutbox(store);
  };

  store.processOutbox = function processOutboxInStore({ maxMessages = Number.MAX_SAFE_INTEGER } = {}) {
    processOutbox(store, { maxMessages });
  };

  store.listNotifications = function listNotifications({ tenantId = null, topic = null, limit = 200, offset = 0 } = {}) {
    if (tenantId !== null) tenantId = normalizeTenantId(tenantId);
    if (topic !== null && (typeof topic !== "string" || topic.trim() === "")) throw new TypeError("topic must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const all = Array.isArray(store.notifications) ? store.notifications : [];
    const filteredByTenant = tenantId === null ? all : all.filter((n) => normalizeTenantId(n?.tenantId) === tenantId);
    const filtered = topic ? filteredByTenant.filter((n) => n?.topic === topic) : filteredByTenant;
    // Most recent first (highest outbox index).
    const sorted = [...filtered].sort((a, b) => (Number(b?.outboxIndex) || 0) - (Number(a?.outboxIndex) || 0));
    return sorted.slice(safeOffset, safeOffset + safeLimit);
  };

  store.listLedgerEntries = function listLedgerEntries({ tenantId = DEFAULT_TENANT_ID, memoPrefix = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (memoPrefix !== null && (typeof memoPrefix !== "string" || memoPrefix.trim() === "")) throw new TypeError("memoPrefix must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const safeLimit = Math.min(5000, limit);
    const safeOffset = offset;
    const ledger = typeof store.getLedger === "function" ? store.getLedger(tenantId) : store.ledger;
    const all = Array.isArray(ledger?.entries) ? ledger.entries : [];
    const filtered = memoPrefix ? all.filter((e) => typeof e?.memo === "string" && e.memo.startsWith(memoPrefix)) : all;
    return filtered.slice(safeOffset, safeOffset + safeLimit);
  };

  store.upsertParty = async function upsertParty({ tenantId = DEFAULT_TENANT_ID, party, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!party || typeof party !== "object") throw new TypeError("party is required");
    const partyId = party.partyId ?? party.id ?? null;
    if (typeof partyId !== "string" || partyId.trim() === "") throw new TypeError("party.partyId is required");
    const partyRole = party.partyRole ?? party.role ?? null;
    if (typeof partyRole !== "string" || partyRole.trim() === "") throw new TypeError("party.partyRole is required");
    const displayName = party.displayName ?? null;
    if (typeof displayName !== "string" || displayName.trim() === "") throw new TypeError("party.displayName is required");
    const status = party.status ?? "active";
    if (typeof status !== "string" || status.trim() === "") throw new TypeError("party.status is required");

    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const key = makeScopedKey({ tenantId, id: String(partyId) });
    const existing = store.parties.get(key) ?? null;
    const record = {
      tenantId,
      partyId: String(partyId),
      partyRole: String(partyRole),
      displayName: String(displayName),
      status: String(status),
      createdAt: existing?.createdAt ?? nowAt,
      updatedAt: nowAt
    };
    store.parties.set(key, record);
    if (audit && typeof store.appendOpsAudit === "function") {
      await store.appendOpsAudit({ tenantId, audit });
    }
    return record;
  };

  store.getParty = async function getParty({ tenantId = DEFAULT_TENANT_ID, partyId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof partyId !== "string" || partyId.trim() === "") throw new TypeError("partyId is required");
    return store.parties.get(makeScopedKey({ tenantId, id: String(partyId) })) ?? null;
  };

  store.listParties = async function listParties({ tenantId = DEFAULT_TENANT_ID, role = null, status = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (role !== null && (typeof role !== "string" || role.trim() === "")) throw new TypeError("role must be null or a non-empty string");
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const p of store.parties.values()) {
      if (!p || typeof p !== "object") continue;
      if (normalizeTenantId(p.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (role !== null && String(p.partyRole ?? "") !== String(role)) continue;
      if (status !== null && String(p.status ?? "") !== String(status)) continue;
      out.push(p);
    }
    out.sort((a, b) => String(a.partyId ?? "").localeCompare(String(b.partyId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.listLedgerAllocations = async function listLedgerAllocations({ tenantId = DEFAULT_TENANT_ID, entryId = null, partyId = null, limit = 5000, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (entryId !== null && (typeof entryId !== "string" || entryId.trim() === "")) throw new TypeError("entryId must be null or a non-empty string");
    if (partyId !== null && (typeof partyId !== "string" || partyId.trim() === "")) throw new TypeError("partyId must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(5000, limit);
    const safeOffset = offset;
    const out = [];
    for (const a of store.ledgerAllocations.values()) {
      if (!a || typeof a !== "object") continue;
      if (normalizeTenantId(a.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (entryId !== null && String(a.entryId ?? "") !== String(entryId)) continue;
      if (partyId !== null && String(a.partyId ?? "") !== String(partyId)) continue;
      out.push(a);
    }
    out.sort((a, b) => String(a.entryId ?? "").localeCompare(String(b.entryId ?? "")) || String(a.postingId ?? "").localeCompare(String(b.postingId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.putPartyStatement = async function putPartyStatement({ tenantId = DEFAULT_TENANT_ID, statement, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!statement || typeof statement !== "object") throw new TypeError("statement is required");
    const partyId = statement.partyId ?? null;
    const period = statement.period ?? null;
    if (typeof partyId !== "string" || partyId.trim() === "") throw new TypeError("statement.partyId is required");
    if (typeof period !== "string" || period.trim() === "") throw new TypeError("statement.period is required");
    const status = statement.status ?? "OPEN";
    if (typeof status !== "string" || status.trim() === "") throw new TypeError("statement.status is required");
    const statementHash = statement.statementHash ?? null;
    const artifactId = statement.artifactId ?? null;
    const artifactHash = statement.artifactHash ?? null;
    if (typeof statementHash !== "string" || statementHash.trim() === "") throw new TypeError("statement.statementHash is required");
    if (typeof artifactId !== "string" || artifactId.trim() === "") throw new TypeError("statement.artifactId is required");
    if (typeof artifactHash !== "string" || artifactHash.trim() === "") throw new TypeError("statement.artifactHash is required");

    const key = `${tenantId}\n${String(partyId)}\n${String(period)}`;
    const existing = store.partyStatements.get(key) ?? null;
    if (existing && String(existing.status ?? "") === "CLOSED") {
      if (String(existing.artifactHash ?? "") !== String(artifactHash)) {
        const err = new Error("party statement is closed and cannot be changed");
        err.code = "PARTY_STATEMENT_IMMUTABLE";
        throw err;
      }
      return existing;
    }

    const now = new Date().toISOString();
    const createdAt = existing?.createdAt ?? now;
    const record = {
      tenantId,
      partyId: String(partyId),
      period: String(period),
      basis: statement.basis ?? "settledAt",
      status: String(status),
      statementHash: String(statementHash),
      artifactId: String(artifactId),
      artifactHash: String(artifactHash),
      closedAt: statement.closedAt ?? null,
      createdAt,
      updatedAt: now
    };
    store.partyStatements.set(key, record);
    if (audit && typeof store.appendOpsAudit === "function") {
      await store.appendOpsAudit({ tenantId, audit });
    }
    return record;
  };

  store.getPartyStatement = async function getPartyStatement({ tenantId = DEFAULT_TENANT_ID, partyId, period } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof partyId !== "string" || partyId.trim() === "") throw new TypeError("partyId is required");
    if (typeof period !== "string" || period.trim() === "") throw new TypeError("period is required");
    const key = `${tenantId}\n${String(partyId)}\n${String(period)}`;
    return store.partyStatements.get(key) ?? null;
  };

  store.listPartyStatements = async function listPartyStatements({
    tenantId = DEFAULT_TENANT_ID,
    period = null,
    partyId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (period !== null && (typeof period !== "string" || period.trim() === "")) throw new TypeError("period must be null or a non-empty string");
    if (partyId !== null && (typeof partyId !== "string" || partyId.trim() === "")) throw new TypeError("partyId must be null or a non-empty string");
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const s of store.partyStatements.values()) {
      if (!s || typeof s !== "object") continue;
      if (normalizeTenantId(s.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (period !== null && String(s.period ?? "") !== String(period)) continue;
      if (partyId !== null && String(s.partyId ?? "") !== String(partyId)) continue;
      if (status !== null && String(s.status ?? "") !== String(status)) continue;
      out.push(s);
    }
    out.sort((a, b) => String(a.period ?? "").localeCompare(String(b.period ?? "")) || String(a.partyId ?? "").localeCompare(String(b.partyId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.putAgentIdentity = async function putAgentIdentity({ tenantId = DEFAULT_TENANT_ID, agentIdentity, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!agentIdentity || typeof agentIdentity !== "object" || Array.isArray(agentIdentity)) throw new TypeError("agentIdentity is required");

    const agentId = agentIdentity.agentId ?? agentIdentity.id ?? null;
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("agentIdentity.agentId is required");

    const owner = agentIdentity.owner ?? null;
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) throw new TypeError("agentIdentity.owner is required");
    const ownerType = owner.ownerType ?? null;
    const ownerId = owner.ownerId ?? null;
    if (ownerType !== "human" && ownerType !== "business" && ownerType !== "service") {
      throw new TypeError("agentIdentity.owner.ownerType must be human|business|service");
    }
    if (typeof ownerId !== "string" || ownerId.trim() === "") throw new TypeError("agentIdentity.owner.ownerId is required");

    const keys = agentIdentity.keys ?? null;
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new TypeError("agentIdentity.keys is required");
    const keyId = keys.keyId ?? null;
    const algorithm = keys.algorithm ?? null;
    const publicKeyPem = keys.publicKeyPem ?? null;
    if (typeof keyId !== "string" || keyId.trim() === "") throw new TypeError("agentIdentity.keys.keyId is required");
    if (String(algorithm ?? "").toLowerCase() !== "ed25519") throw new TypeError("agentIdentity.keys.algorithm must be ed25519");
    if (typeof publicKeyPem !== "string" || publicKeyPem.trim() === "") throw new TypeError("agentIdentity.keys.publicKeyPem is required");

    const displayName = agentIdentity.displayName ?? null;
    if (typeof displayName !== "string" || displayName.trim() === "") throw new TypeError("agentIdentity.displayName is required");

    const status = String(agentIdentity.status ?? "active").trim().toLowerCase();
    if (status !== "active" && status !== "suspended" && status !== "revoked") {
      throw new TypeError("agentIdentity.status must be active|suspended|revoked");
    }

    const capabilitiesIn = Array.isArray(agentIdentity.capabilities) ? agentIdentity.capabilities : [];
    const capabilitySet = new Set();
    for (let index = 0; index < capabilitiesIn.length; index += 1) {
      const raw = capabilitiesIn[index];
      const candidate = String(raw ?? "").trim();
      if (!candidate) continue;
      capabilitySet.add(normalizeCapabilityIdentifier(candidate, { name: `agentIdentity.capabilities[${index}]` }));
    }
    const capabilities = Array.from(capabilitySet.values()).sort((left, right) => left.localeCompare(right));

    const walletPolicyIn = agentIdentity.walletPolicy;
    if (walletPolicyIn !== undefined && walletPolicyIn !== null && (typeof walletPolicyIn !== "object" || Array.isArray(walletPolicyIn))) {
      throw new TypeError("agentIdentity.walletPolicy must be an object or null");
    }
    let walletPolicy = null;
    if (walletPolicyIn && typeof walletPolicyIn === "object" && !Array.isArray(walletPolicyIn)) {
      const allowedWalletPolicyFields = new Set(["maxPerTransactionCents", "maxDailyCents", "requireApprovalAboveCents"]);
      for (const key of Object.keys(walletPolicyIn)) {
        if (!allowedWalletPolicyFields.has(key)) throw new TypeError(`agentIdentity.walletPolicy contains unknown field: ${key}`);
      }
      walletPolicy = {};
      for (const field of allowedWalletPolicyFields) {
        const raw = walletPolicyIn[field];
        if (raw === undefined || raw === null) continue;
        const amount = Number(raw);
        if (!Number.isSafeInteger(amount) || amount < 0) throw new TypeError(`agentIdentity.walletPolicy.${field} must be a non-negative integer`);
        walletPolicy[field] = amount;
      }
    }

    const metadataIn = agentIdentity.metadata;
    if (metadataIn !== undefined && metadataIn !== null && (typeof metadataIn !== "object" || Array.isArray(metadataIn))) {
      throw new TypeError("agentIdentity.metadata must be an object or null");
    }

    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const key = makeScopedKey({ tenantId, id: String(agentId) });
    const existing = store.agentIdentities.get(key) ?? null;
    if (existing) {
      const err = new Error("agent identity already exists");
      err.code = "AGENT_IDENTITY_EXISTS";
      throw err;
    }
    const createdAt = typeof existing?.createdAt === "string" && existing.createdAt.trim() !== "" ? existing.createdAt : nowAt;

    const record = {
      schemaVersion: "AgentIdentity.v1",
      agentId: String(agentId),
      tenantId,
      displayName: String(displayName),
      description: typeof agentIdentity.description === "string" && agentIdentity.description.trim() !== "" ? agentIdentity.description : null,
      status,
      owner: {
        ownerType: String(ownerType),
        ownerId: String(ownerId)
      },
      keys: {
        keyId: String(keyId),
        algorithm: "ed25519",
        publicKeyPem: String(publicKeyPem)
      },
      capabilities,
      walletPolicy,
      metadata:
        metadataIn && typeof metadataIn === "object" && !Array.isArray(metadataIn)
          ? { ...metadataIn }
          : null,
      revision:
        Number.isSafeInteger(agentIdentity.revision) && agentIdentity.revision >= 0
          ? Number(agentIdentity.revision)
          : 0,
      createdAt,
      updatedAt: nowAt
    };

    const ops = [
      { kind: "AGENT_IDENTITY_UPSERT", tenantId, agentIdentity: record },
      { kind: "PUBLIC_KEY_PUT", keyId: String(keyId), publicKeyPem: String(publicKeyPem) }
    ];
    await store.commitTx({ at: nowAt, ops, audit });
    return store.getAgentIdentity({ tenantId, agentId: String(agentId) });
  };

  store.getAgentIdentity = async function getAgentIdentity({ tenantId = DEFAULT_TENANT_ID, agentId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("agentId is required");
    const key = makeScopedKey({ tenantId, id: String(agentId) });
    return store.agentIdentities.get(key) ?? null;
  };

  store.listAgentIdentities = async function listAgentIdentities({ tenantId = DEFAULT_TENANT_ID, status = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.agentIdentities.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (statusFilter !== null && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.agentId ?? "").localeCompare(String(right.agentId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  function assertIdentityLogAuditObject(value, name) {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
    return value;
  }

  function collectIdentityLogEntriesFromOpsAudit({ tenantId = DEFAULT_TENANT_ID } = {}) {
    tenantId = normalizeTenantId(tenantId);
    const rows = [];
    if (!(store.opsAudit instanceof Map)) return rows;
    for (const row of store.opsAudit.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(row.action ?? "") !== IDENTITY_LOG_OPS_AUDIT_ACTION) continue;
      let entry = null;
      try {
        entry = parseIdentityLogEntryFromAuditDetails(row.details, { allowNull: false });
      } catch (err) {
        const wrapped = new Error(`identity log audit entry is invalid: ${err?.message ?? String(err)}`);
        wrapped.code = "IDENTITY_LOG_AUDIT_INVALID";
        wrapped.details = { auditId: row.id ?? null };
        throw wrapped;
      }
      if (normalizeTenantId(entry.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) {
        const wrapped = new Error("identity log entry tenant mismatch");
        wrapped.code = "IDENTITY_LOG_TENANT_MISMATCH";
        wrapped.details = { auditId: row.id ?? null, entryId: entry.entryId ?? null };
        throw wrapped;
      }
      rows.push(entry);
    }
    return validateIdentityLogEntriesAppendOnly(rows);
  }

  store.getIdentityLogEntry = async function getIdentityLogEntry({ tenantId = DEFAULT_TENANT_ID, entryId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof entryId !== "string" || entryId.trim() === "") throw new TypeError("entryId is required");
    const normalizedEntryId = String(entryId).trim();
    const rows = collectIdentityLogEntriesFromOpsAudit({ tenantId });
    return rows.find((row) => row.entryId === normalizedEntryId) ?? null;
  };

  store.listIdentityLogEntries = async function listIdentityLogEntries({
    tenantId = DEFAULT_TENANT_ID,
    agentId = null,
    eventType = null,
    entryId = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (agentId !== null && (typeof agentId !== "string" || agentId.trim() === "")) throw new TypeError("agentId must be null or non-empty string");
    if (eventType !== null && (typeof eventType !== "string" || eventType.trim() === "")) throw new TypeError("eventType must be null or non-empty string");
    if (entryId !== null && (typeof entryId !== "string" || entryId.trim() === "")) throw new TypeError("entryId must be null or non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const agentFilter = agentId ? String(agentId).trim() : null;
    const eventFilter = eventType ? String(eventType).trim().toLowerCase() : null;
    const entryFilter = entryId ? String(entryId).trim() : null;

    const all = collectIdentityLogEntriesFromOpsAudit({ tenantId });
    const filtered = [];
    for (const row of all) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (agentFilter && String(row.agentId ?? "") !== agentFilter) continue;
      if (eventFilter && String(row.eventType ?? "").toLowerCase() !== eventFilter) continue;
      if (entryFilter && String(row.entryId ?? "") !== entryFilter) continue;
      filtered.push(row);
    }
    return filtered.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getIdentityLogCheckpoint = async function getIdentityLogCheckpoint({ tenantId = DEFAULT_TENANT_ID, generatedAt = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    const entries = collectIdentityLogEntriesFromOpsAudit({ tenantId });
    return buildIdentityLogCheckpoint({ tenantId, entries, generatedAt });
  };

  store.appendIdentityLogEntry = async function appendIdentityLogEntry({ tenantId = DEFAULT_TENANT_ID, entry, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("entry is required");
    const normalizedEntry =
      typeof entry.entryHash === "string" && entry.entryHash.trim() !== ""
        ? validateIdentityLogEntry({ ...entry, tenantId })
        : buildIdentityLogEntry({ ...entry, tenantId });
    const existingEntries = collectIdentityLogEntriesFromOpsAudit({ tenantId });
    const existingById = existingEntries.find((row) => row.entryId === normalizedEntry.entryId) ?? null;
    if (existingById) {
      if (existingById.entryHash === normalizedEntry.entryHash) return existingById;
      const err = new Error("identity log entry conflict for entryId");
      err.code = "IDENTITY_LOG_ENTRY_CONFLICT";
      err.details = { entryId: normalizedEntry.entryId };
      throw err;
    }
    const expectedLogIndex = existingEntries.length;
    if (normalizedEntry.logIndex !== expectedLogIndex) {
      const err = new Error("identity log index mismatch");
      err.code = "IDENTITY_LOG_INDEX_MISMATCH";
      err.details = { expectedLogIndex, actualLogIndex: normalizedEntry.logIndex };
      throw err;
    }
    const expectedPrevEntryHash = expectedLogIndex === 0 ? null : existingEntries[expectedLogIndex - 1].entryHash;
    if ((normalizedEntry.prevEntryHash ?? null) !== expectedPrevEntryHash) {
      const err = new Error("identity log prevEntryHash mismatch");
      err.code = "IDENTITY_LOG_PREV_HASH_MISMATCH";
      err.details = { expectedPrevEntryHash, actualPrevEntryHash: normalizedEntry.prevEntryHash ?? null };
      throw err;
    }

    const auditInput = assertIdentityLogAuditObject(audit, "audit");
    const detailsInput =
      auditInput?.details && typeof auditInput.details === "object" && !Array.isArray(auditInput.details)
        ? auditInput.details
        : {};
    const identityAudit = makeOpsAuditRecord({
      tenantId,
      actorKeyId: auditInput?.actorKeyId ?? null,
      actorPrincipalId: auditInput?.actorPrincipalId ?? null,
      requestId: auditInput?.requestId ?? null,
      action: IDENTITY_LOG_OPS_AUDIT_ACTION,
      targetType: "identity_log_entry",
      targetId: normalizedEntry.entryId,
      at: auditInput?.at ?? normalizedEntry.recordedAt,
      details: {
        ...detailsInput,
        entry: normalizedEntry
      }
    });
    await store.appendOpsAudit({ tenantId, audit: identityAudit });
    return normalizedEntry;
  };

  store.appendIdentityLogEvent = async function appendIdentityLogEvent({
    tenantId = DEFAULT_TENANT_ID,
    agentId,
    eventType,
    beforeIdentity = null,
    afterIdentity = null,
    reasonCode = null,
    reason = null,
    metadata = null,
    occurredAt = null,
    recordedAt = null,
    entryId = null,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("agentId is required");
    const existingEntries = collectIdentityLogEntriesFromOpsAudit({ tenantId });
    const logIndex = existingEntries.length;
    const prevEntryHash = logIndex === 0 ? null : existingEntries[logIndex - 1].entryHash;
    const normalizedAfterIdentity =
      afterIdentity && typeof afterIdentity === "object" && !Array.isArray(afterIdentity) ? afterIdentity : {};
    const normalizedBeforeIdentity =
      beforeIdentity && typeof beforeIdentity === "object" && !Array.isArray(beforeIdentity) ? beforeIdentity : null;

    const entry = buildIdentityLogEntry({
      entryId: entryId ?? createId("idlog"),
      tenantId,
      agentId: String(agentId).trim(),
      eventType,
      logIndex,
      prevEntryHash,
      keyIdBefore: normalizedBeforeIdentity?.keys?.keyId ?? null,
      keyIdAfter: normalizedAfterIdentity?.keys?.keyId ?? null,
      statusBefore: normalizedBeforeIdentity?.status ?? null,
      statusAfter: normalizedAfterIdentity?.status ?? null,
      capabilitiesBefore: Array.isArray(normalizedBeforeIdentity?.capabilities) ? normalizedBeforeIdentity.capabilities : [],
      capabilitiesAfter: Array.isArray(normalizedAfterIdentity?.capabilities) ? normalizedAfterIdentity.capabilities : [],
      reasonCode,
      reason,
      occurredAt: occurredAt ?? normalizedAfterIdentity?.updatedAt ?? new Date().toISOString(),
      recordedAt: recordedAt ?? new Date().toISOString(),
      metadata
    });
    return await store.appendIdentityLogEntry({ tenantId, entry, audit });
  };

  store.getAgentCard = async function getAgentCard({ tenantId = DEFAULT_TENANT_ID, agentId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("agentId is required");
    return store.agentCards.get(makeScopedKey({ tenantId, id: String(agentId) })) ?? null;
  };

  store.putAgentCardAbuseReport = async function putAgentCardAbuseReport({ tenantId = DEFAULT_TENANT_ID, report, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!report || typeof report !== "object" || Array.isArray(report)) throw new TypeError("report is required");
    const reportId = typeof report.reportId === "string" ? report.reportId.trim() : "";
    if (!reportId) throw new TypeError("report.reportId is required");
    const at = report.updatedAt ?? report.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "AGENT_CARD_ABUSE_REPORT_UPSERT", tenantId, reportId, report: { ...report, tenantId, reportId } }],
      audit
    });
    return store.agentCardAbuseReports.get(makeScopedKey({ tenantId, id: reportId })) ?? null;
  };

  store.getAgentCardAbuseReport = async function getAgentCardAbuseReport({ tenantId = DEFAULT_TENANT_ID, reportId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof reportId !== "string" || reportId.trim() === "") throw new TypeError("reportId is required");
    return store.agentCardAbuseReports.get(makeScopedKey({ tenantId, id: String(reportId) })) ?? null;
  };

  store.listAgentCardAbuseReports = async function listAgentCardAbuseReports({
    tenantId = DEFAULT_TENANT_ID,
    subjectAgentId = null,
    reasonCode = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (subjectAgentId !== null && (typeof subjectAgentId !== "string" || subjectAgentId.trim() === "")) {
      throw new TypeError("subjectAgentId must be null or a non-empty string");
    }
    if (reasonCode !== null && (typeof reasonCode !== "string" || reasonCode.trim() === "")) {
      throw new TypeError("reasonCode must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const subjectFilter = subjectAgentId ? subjectAgentId.trim() : null;
    const reasonFilter = reasonCode ? reasonCode.trim().toUpperCase() : null;

    const out = [];
    for (const row of store.agentCardAbuseReports.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (subjectFilter && String(row.subjectAgentId ?? "") !== subjectFilter) continue;
      if (reasonFilter && String(row.reasonCode ?? "").toUpperCase() !== reasonFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftAt = Number.isFinite(Date.parse(String(left?.createdAt ?? ""))) ? Date.parse(String(left.createdAt)) : Number.NaN;
      const rightAt = Number.isFinite(Date.parse(String(right?.createdAt ?? ""))) ? Date.parse(String(right.createdAt)) : Number.NaN;
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt;
      return String(left?.reportId ?? "").localeCompare(String(right?.reportId ?? ""));
    });
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.putAgentCard = async function putAgentCard({ tenantId = DEFAULT_TENANT_ID, agentCard, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!agentCard || typeof agentCard !== "object" || Array.isArray(agentCard)) throw new TypeError("agentCard is required");
    validateAgentCardV1(agentCard);
    const agentId = typeof agentCard.agentId === "string" ? agentCard.agentId.trim() : "";
    if (!agentId) throw new TypeError("agentCard.agentId is required");
    const key = makeScopedKey({ tenantId, id: String(agentId) });
    const at = agentCard.updatedAt ?? agentCard.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "AGENT_CARD_UPSERT", tenantId, agentId, agentCard: { ...agentCard, tenantId, agentId } }],
      audit
    });
    return store.agentCards.get(key) ?? null;
  };

  function normalizeAgentCardToolDescriptorFilterState({
    toolId = null,
    toolMcpName = null,
    toolRiskClass = null,
    toolSideEffecting = null,
    toolMaxPriceCents = null,
    toolRequiresEvidenceKind = null
  } = {}) {
    const toolIdFilter = toolId === null || toolId === undefined || String(toolId).trim() === "" ? null : String(toolId).trim();
    const toolMcpNameFilter =
      toolMcpName === null || toolMcpName === undefined || String(toolMcpName).trim() === "" ? null : String(toolMcpName).trim().toLowerCase();
    const toolRiskClassFilter =
      toolRiskClass === null || toolRiskClass === undefined || String(toolRiskClass).trim() === ""
        ? null
        : String(toolRiskClass).trim().toLowerCase();
    if (
      toolRiskClassFilter !== null &&
      toolRiskClassFilter !== "read" &&
      toolRiskClassFilter !== "compute" &&
      toolRiskClassFilter !== "action" &&
      toolRiskClassFilter !== "financial"
    ) {
      throw new TypeError("toolRiskClass must be read|compute|action|financial");
    }
    const toolSideEffectingFilter =
      toolSideEffecting === null || toolSideEffecting === undefined
        ? null
        : typeof toolSideEffecting === "boolean"
          ? toolSideEffecting
          : (() => {
              throw new TypeError("toolSideEffecting must be boolean");
            })();
    const toolMaxPriceCentsFilter =
      toolMaxPriceCents === null || toolMaxPriceCents === undefined || toolMaxPriceCents === ""
        ? null
        : (() => {
            const parsed = Number(toolMaxPriceCents);
            if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("toolMaxPriceCents must be a non-negative safe integer");
            return parsed;
          })();
    const toolRequiresEvidenceKindFilter =
      toolRequiresEvidenceKind === null || toolRequiresEvidenceKind === undefined || String(toolRequiresEvidenceKind).trim() === ""
        ? null
        : String(toolRequiresEvidenceKind).trim().toLowerCase();
    if (
      toolRequiresEvidenceKindFilter !== null &&
      toolRequiresEvidenceKindFilter !== "artifact" &&
      toolRequiresEvidenceKindFilter !== "hash" &&
      toolRequiresEvidenceKindFilter !== "verification_report" &&
      toolRequiresEvidenceKindFilter !== "execution_attestation"
    ) {
      throw new TypeError("toolRequiresEvidenceKind must be artifact|hash|verification_report|execution_attestation");
    }
    const hasToolDescriptorFilter =
      toolIdFilter !== null ||
      toolMcpNameFilter !== null ||
      toolRiskClassFilter !== null ||
      toolSideEffectingFilter !== null ||
      toolMaxPriceCentsFilter !== null ||
      toolRequiresEvidenceKindFilter !== null;
    return {
      hasToolDescriptorFilter,
      toolIdFilter,
      toolMcpNameFilter,
      toolRiskClassFilter,
      toolSideEffectingFilter,
      toolMaxPriceCentsFilter,
      toolRequiresEvidenceKindFilter
    };
  }

  function agentCardMatchesToolDescriptorFilters(row, state) {
    if (!state?.hasToolDescriptorFilter) return true;
    const tools = Array.isArray(row?.tools) ? row.tools : [];
    if (tools.length === 0) return false;
    return tools.some((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
      const descriptorToolId = typeof tool.toolId === "string" ? tool.toolId.trim() : "";
      if (state.toolIdFilter !== null && descriptorToolId !== state.toolIdFilter) return false;
      const descriptorMcpName = typeof tool.mcpToolName === "string" ? tool.mcpToolName.trim().toLowerCase() : "";
      if (state.toolMcpNameFilter !== null && descriptorMcpName !== state.toolMcpNameFilter) return false;
      const descriptorRiskClass = typeof tool.riskClass === "string" ? tool.riskClass.trim().toLowerCase() : "";
      if (state.toolRiskClassFilter !== null && descriptorRiskClass !== state.toolRiskClassFilter) return false;
      const descriptorSideEffecting = tool.sideEffecting === true;
      if (state.toolSideEffectingFilter !== null && descriptorSideEffecting !== state.toolSideEffectingFilter) return false;
      const descriptorAmountCents = Number(tool?.pricing?.amountCents);
      if (
        state.toolMaxPriceCentsFilter !== null &&
        (!Number.isSafeInteger(descriptorAmountCents) || descriptorAmountCents > state.toolMaxPriceCentsFilter)
      ) {
        return false;
      }
      if (state.toolRequiresEvidenceKindFilter !== null) {
        const evidenceKinds = Array.isArray(tool.requiresEvidenceKinds)
          ? tool.requiresEvidenceKinds.map((entry) => String(entry ?? "").trim().toLowerCase())
          : [];
        if (!evidenceKinds.includes(state.toolRequiresEvidenceKindFilter)) return false;
      }
      return true;
    });
  }

  function compareAgentCardDiscoveryTenantOrder(left, right) {
    return String(left?.agentId ?? "").localeCompare(String(right?.agentId ?? ""));
  }

  function compareAgentCardDiscoveryPublicOrder(left, right) {
    const tenantOrder = String(left?.tenantId ?? "").localeCompare(String(right?.tenantId ?? ""));
    if (tenantOrder !== 0) return tenantOrder;
    return compareAgentCardDiscoveryTenantOrder(left, right);
  }

  store.listAgentCards = async function listAgentCards({
    tenantId = DEFAULT_TENANT_ID,
    agentId = null,
    status = null,
    visibility = null,
    capability = null,
    executionCoordinatorDid = null,
    toolId = null,
    toolMcpName = null,
    toolRiskClass = null,
    toolSideEffecting = null,
    toolMaxPriceCents = null,
    toolRequiresEvidenceKind = null,
    runtime = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (agentId !== null && (typeof agentId !== "string" || agentId.trim() === "")) throw new TypeError("agentId must be null or a non-empty string");
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (visibility !== null && (typeof visibility !== "string" || visibility.trim() === "")) throw new TypeError("visibility must be null or a non-empty string");
    if (capability !== null && (typeof capability !== "string" || capability.trim() === "")) throw new TypeError("capability must be null or a non-empty string");
    if (executionCoordinatorDid !== null && (typeof executionCoordinatorDid !== "string" || executionCoordinatorDid.trim() === "")) {
      throw new TypeError("executionCoordinatorDid must be null or a non-empty string");
    }
    if (runtime !== null && (typeof runtime !== "string" || runtime.trim() === "")) throw new TypeError("runtime must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const agentFilter = agentId ? String(agentId).trim() : null;
    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const visibilityFilter = visibility ? String(visibility).trim().toLowerCase() : null;
    const capabilityFilter = capability ? normalizeCapabilityIdentifier(capability, { name: "capability" }) : null;
    const executionCoordinatorDidFilter = executionCoordinatorDid ? String(executionCoordinatorDid).trim() : null;
    const toolFilterState = normalizeAgentCardToolDescriptorFilterState({
      toolId,
      toolMcpName,
      toolRiskClass,
      toolSideEffecting,
      toolMaxPriceCents,
      toolRequiresEvidenceKind
    });
    const runtimeFilter = runtime ? String(runtime).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.agentCards.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (agentFilter && String(row.agentId ?? "") !== agentFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      if (visibilityFilter && String(row.visibility ?? "").toLowerCase() !== visibilityFilter) continue;
      if (executionCoordinatorDidFilter && String(row.executionCoordinatorDid ?? "") !== executionCoordinatorDidFilter) continue;
      if (runtimeFilter) {
        const rowRuntime =
          row?.host && typeof row.host === "object" && !Array.isArray(row.host) && typeof row.host.runtime === "string"
            ? row.host.runtime.trim().toLowerCase()
            : "";
        if (rowRuntime !== runtimeFilter) continue;
      }
      if (capabilityFilter) {
        const caps = Array.isArray(row.capabilities) ? row.capabilities : [];
        if (!caps.includes(capabilityFilter)) continue;
      }
      if (!agentCardMatchesToolDescriptorFilters(row, toolFilterState)) continue;
      out.push(row);
    }
    out.sort(compareAgentCardDiscoveryTenantOrder);
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.listAgentCardsPublic = async function listAgentCardsPublic({
    agentId = null,
    status = null,
    visibility = "public",
    capability = null,
    executionCoordinatorDid = null,
    toolId = null,
    toolMcpName = null,
    toolRiskClass = null,
    toolSideEffecting = null,
    toolMaxPriceCents = null,
    toolRequiresEvidenceKind = null,
    runtime = null,
    limit = 200,
    offset = 0
  } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    if (agentId !== null && (typeof agentId !== "string" || agentId.trim() === "")) {
      throw new TypeError("agentId must be null or a non-empty string");
    }
    if (visibility !== null && visibility !== undefined && String(visibility).trim().toLowerCase() !== "public") {
      throw new TypeError("visibility must be public");
    }
    const agentIdFilter = agentId === null || agentId === undefined || String(agentId).trim() === "" ? null : String(agentId).trim();
    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const capabilityFilter = capability ? normalizeCapabilityIdentifier(capability, { name: "capability" }) : null;
    const executionCoordinatorDidFilter = executionCoordinatorDid ? String(executionCoordinatorDid).trim() : null;
    const toolFilterState = normalizeAgentCardToolDescriptorFilterState({
      toolId,
      toolMcpName,
      toolRiskClass,
      toolSideEffecting,
      toolMaxPriceCents,
      toolRequiresEvidenceKind
    });
    const runtimeFilter = runtime ? String(runtime).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.agentCards.values()) {
      if (!row || typeof row !== "object") continue;
      if (String(row.visibility ?? "").toLowerCase() !== "public") continue;
      if (agentIdFilter !== null && String(row.agentId ?? "") !== agentIdFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      if (executionCoordinatorDidFilter && String(row.executionCoordinatorDid ?? "") !== executionCoordinatorDidFilter) continue;
      if (runtimeFilter) {
        const rowRuntime =
          row?.host && typeof row.host === "object" && !Array.isArray(row.host) && typeof row.host.runtime === "string"
            ? row.host.runtime.trim().toLowerCase()
            : "";
        if (rowRuntime !== runtimeFilter) continue;
      }
      if (capabilityFilter) {
        const caps = Array.isArray(row.capabilities) ? row.capabilities : [];
        if (!caps.includes(capabilityFilter)) continue;
      }
      if (!agentCardMatchesToolDescriptorFilters(row, toolFilterState)) continue;
      out.push(row);
    }
    out.sort(compareAgentCardDiscoveryPublicOrder);
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getSession = async function getSession({ tenantId = DEFAULT_TENANT_ID, sessionId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof sessionId !== "string" || sessionId.trim() === "") throw new TypeError("sessionId is required");
    return store.sessions.get(makeScopedKey({ tenantId, id: String(sessionId) })) ?? null;
  };

  store.putSession = async function putSession({ tenantId = DEFAULT_TENANT_ID, session, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!session || typeof session !== "object" || Array.isArray(session)) throw new TypeError("session is required");
    validateSessionV1(session);
    const sessionId = session.sessionId ?? null;
    if (typeof sessionId !== "string" || sessionId.trim() === "") throw new TypeError("session.sessionId is required");
    const at = session.updatedAt ?? session.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "SESSION_UPSERT", tenantId, sessionId, session: { ...session, tenantId, sessionId } }],
      audit
    });
    return store.sessions.get(makeScopedKey({ tenantId, id: String(sessionId) })) ?? null;
  };

  store.listSessions = async function listSessions({
    tenantId = DEFAULT_TENANT_ID,
    sessionId = null,
    visibility = null,
    participantAgentId = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (sessionId !== null && (typeof sessionId !== "string" || sessionId.trim() === "")) throw new TypeError("sessionId must be null or a non-empty string");
    if (visibility !== null && (typeof visibility !== "string" || visibility.trim() === "")) throw new TypeError("visibility must be null or a non-empty string");
    if (participantAgentId !== null && (typeof participantAgentId !== "string" || participantAgentId.trim() === "")) {
      throw new TypeError("participantAgentId must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const sessionFilter = sessionId ? String(sessionId).trim() : null;
    const visibilityFilter = visibility ? String(visibility).trim().toLowerCase() : null;
    const participantFilter = participantAgentId ? String(participantAgentId).trim() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.sessions.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (sessionFilter && String(row.sessionId ?? "") !== sessionFilter) continue;
      if (visibilityFilter && String(row.visibility ?? "").toLowerCase() !== visibilityFilter) continue;
      if (participantFilter) {
        const participants = Array.isArray(row.participants) ? row.participants : [];
        if (!participants.includes(participantFilter)) continue;
      }
      out.push(row);
    }
    out.sort((left, right) => String(left.sessionId ?? "").localeCompare(String(right.sessionId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getSessionEvents = async function getSessionEvents({ tenantId = DEFAULT_TENANT_ID, sessionId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof sessionId !== "string" || sessionId.trim() === "") throw new TypeError("sessionId is required");
    return store.sessionEvents.get(makeScopedKey({ tenantId, id: String(sessionId) })) ?? [];
  };

  store.getIdempotencyRecord = async function getIdempotencyRecord({ key } = {}) {
    if (typeof key !== "string" || key.trim() === "") throw new TypeError("key is required");
    return store.idempotency.get(String(key)) ?? null;
  };

  store.getStateCheckpoint = async function getStateCheckpoint({ tenantId = DEFAULT_TENANT_ID, checkpointId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof checkpointId !== "string" || checkpointId.trim() === "") throw new TypeError("checkpointId is required");
    return store.stateCheckpoints.get(makeScopedKey({ tenantId, id: String(checkpointId) })) ?? null;
  };

  store.putStateCheckpoint = async function putStateCheckpoint({ tenantId = DEFAULT_TENANT_ID, stateCheckpoint, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!stateCheckpoint || typeof stateCheckpoint !== "object" || Array.isArray(stateCheckpoint)) {
      throw new TypeError("stateCheckpoint is required");
    }
    validateStateCheckpointV1(stateCheckpoint);
    const checkpointId = stateCheckpoint.checkpointId ?? null;
    if (typeof checkpointId !== "string" || checkpointId.trim() === "") {
      throw new TypeError("stateCheckpoint.checkpointId is required");
    }
    const at = stateCheckpoint.updatedAt ?? stateCheckpoint.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "STATE_CHECKPOINT_UPSERT", tenantId, checkpointId, stateCheckpoint: { ...stateCheckpoint, tenantId, checkpointId } }],
      audit
    });
    return store.stateCheckpoints.get(makeScopedKey({ tenantId, id: String(checkpointId) })) ?? null;
  };

  store.listStateCheckpoints = async function listStateCheckpoints({
    tenantId = DEFAULT_TENANT_ID,
    checkpointId = null,
    projectId = null,
    sessionId = null,
    ownerAgentId = null,
    traceId = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (checkpointId !== null && (typeof checkpointId !== "string" || checkpointId.trim() === "")) {
      throw new TypeError("checkpointId must be null or a non-empty string");
    }
    if (projectId !== null && (typeof projectId !== "string" || projectId.trim() === "")) {
      throw new TypeError("projectId must be null or a non-empty string");
    }
    if (sessionId !== null && (typeof sessionId !== "string" || sessionId.trim() === "")) {
      throw new TypeError("sessionId must be null or a non-empty string");
    }
    if (ownerAgentId !== null && (typeof ownerAgentId !== "string" || ownerAgentId.trim() === "")) {
      throw new TypeError("ownerAgentId must be null or a non-empty string");
    }
    if (traceId !== null && (typeof traceId !== "string" || traceId.trim() === "")) {
      throw new TypeError("traceId must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const checkpointFilter = checkpointId ? String(checkpointId).trim() : null;
    const projectFilter = projectId ? String(projectId).trim() : null;
    const sessionFilter = sessionId ? String(sessionId).trim() : null;
    const ownerFilter = ownerAgentId ? String(ownerAgentId).trim() : null;
    const traceFilter = traceId ? String(traceId).trim() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.stateCheckpoints.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (checkpointFilter && String(row.checkpointId ?? "") !== checkpointFilter) continue;
      if (projectFilter && String(row.projectId ?? "") !== projectFilter) continue;
      if (sessionFilter && String(row.sessionId ?? "") !== sessionFilter) continue;
      if (ownerFilter && String(row.ownerAgentId ?? "") !== ownerFilter) continue;
      if (traceFilter && String(row.traceId ?? "") !== traceFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.checkpointId ?? "").localeCompare(String(right.checkpointId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.putAgentPassport = async function putAgentPassport({ tenantId = DEFAULT_TENANT_ID, agentPassport, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!agentPassport || typeof agentPassport !== "object" || Array.isArray(agentPassport)) {
      throw new TypeError("agentPassport is required");
    }
    const agentId = typeof agentPassport.agentId === "string" ? agentPassport.agentId.trim() : "";
    if (!agentId) throw new TypeError("agentPassport.agentId is required");
    const status = typeof agentPassport.status === "string" ? agentPassport.status.trim().toLowerCase() : "";
    if (status !== "active" && status !== "suspended" && status !== "revoked") {
      throw new TypeError("agentPassport.status must be active|suspended|revoked");
    }
    const at = agentPassport.updatedAt ?? agentPassport.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [
        {
          kind: "AGENT_PASSPORT_UPSERT",
          tenantId,
          agentId,
          agentPassport: { ...agentPassport, tenantId, agentId, status }
        }
      ],
      audit
    });
    return store.agentPassports.get(makeScopedKey({ tenantId, id: agentId })) ?? null;
  };

  store.getAgentPassport = async function getAgentPassport({ tenantId = DEFAULT_TENANT_ID, agentId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("agentId is required");
    return store.agentPassports.get(makeScopedKey({ tenantId, id: String(agentId) })) ?? null;
  };

  store.getAgentWallet = async function getAgentWallet({ tenantId = DEFAULT_TENANT_ID, agentId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("agentId is required");
    return store.agentWallets.get(makeScopedKey({ tenantId, id: String(agentId) })) ?? null;
  };

  store.putAgentWallet = async function putAgentWallet({ tenantId = DEFAULT_TENANT_ID, wallet } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!wallet || typeof wallet !== "object" || Array.isArray(wallet)) throw new TypeError("wallet is required");
    const agentId = wallet.agentId ?? null;
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("wallet.agentId is required");
    const key = makeScopedKey({ tenantId, id: String(agentId) });
    await store.commitTx({ at: wallet.updatedAt ?? new Date().toISOString(), ops: [{ kind: "AGENT_WALLET_UPSERT", tenantId, wallet: { ...wallet, tenantId, agentId } }] });
    return store.agentWallets.get(key) ?? null;
  };

  store.getAgentRun = async function getAgentRun({ tenantId = DEFAULT_TENANT_ID, runId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof runId !== "string" || runId.trim() === "") throw new TypeError("runId is required");
    return store.agentRuns.get(makeScopedKey({ tenantId, id: String(runId) })) ?? null;
  };

  store.listAgentRuns = async function listAgentRuns({ tenantId = DEFAULT_TENANT_ID, agentId = null, status = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (agentId !== null && (typeof agentId !== "string" || agentId.trim() === "")) throw new TypeError("agentId must be null or a non-empty string");
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.agentRuns.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (agentId !== null && String(row.agentId ?? "") !== String(agentId)) continue;
      if (statusFilter !== null && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.runId ?? "").localeCompare(String(right.runId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getAgentRunEvents = async function getAgentRunEvents({ tenantId = DEFAULT_TENANT_ID, runId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof runId !== "string" || runId.trim() === "") throw new TypeError("runId is required");
    return store.agentRunEvents.get(makeScopedKey({ tenantId, id: String(runId) })) ?? [];
  };

  store.getAgentRunSettlement = async function getAgentRunSettlement({ tenantId = DEFAULT_TENANT_ID, runId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof runId !== "string" || runId.trim() === "") throw new TypeError("runId is required");
    return store.agentRunSettlements.get(makeScopedKey({ tenantId, id: String(runId) })) ?? null;
  };

  store.sumWalletPolicySpendCentsForDay = async function sumWalletPolicySpendCentsForDay({
    tenantId = DEFAULT_TENANT_ID,
    agentId,
    dayStartIso,
    dayEndIso
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("agentId is required");
    if (typeof dayStartIso !== "string" || dayStartIso.trim() === "" || !Number.isFinite(Date.parse(dayStartIso))) {
      throw new TypeError("dayStartIso must be an ISO date string");
    }
    if (typeof dayEndIso !== "string" || dayEndIso.trim() === "" || !Number.isFinite(Date.parse(dayEndIso))) {
      throw new TypeError("dayEndIso must be an ISO date string");
    }
    const startMs = Date.parse(dayStartIso);
    const endMs = Date.parse(dayEndIso);
    if (!(endMs > startMs)) throw new TypeError("dayEndIso must be after dayStartIso");

    let total = 0;

    // Agent run settlements lock escrow for the full settlement amount.
    for (const row of store.agentRunSettlements.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(row.payerAgentId ?? "") !== String(agentId)) continue;
      const lockedAt = row.lockedAt ?? null;
      const lockedMs = typeof lockedAt === "string" ? Date.parse(lockedAt) : NaN;
      if (!Number.isFinite(lockedMs) || lockedMs < startMs || lockedMs >= endMs) continue;
      const amountCents = Number(row.amountCents ?? 0);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) continue;
      total += amountCents;
    }

    // Tool-call holds lock escrow for the holdback amount only.
    for (const row of store.toolCallHolds.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(row.payerAgentId ?? "") !== String(agentId)) continue;
      const createdAt = row.createdAt ?? null;
      const createdMs = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
      if (!Number.isFinite(createdMs) || createdMs < startMs || createdMs >= endMs) continue;
      const heldAmountCents = Number(row.heldAmountCents ?? 0);
      if (!Number.isSafeInteger(heldAmountCents) || heldAmountCents <= 0) continue;
      total += heldAmountCents;
    }

    return total;
  };

  store.getArbitrationCase = async function getArbitrationCase({ tenantId = DEFAULT_TENANT_ID, caseId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof caseId !== "string" || caseId.trim() === "") throw new TypeError("caseId is required");
    return store.arbitrationCases.get(makeScopedKey({ tenantId, id: String(caseId) })) ?? null;
  };

  store.getAgreementDelegation = async function getAgreementDelegation({ tenantId = DEFAULT_TENANT_ID, delegationId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof delegationId !== "string" || delegationId.trim() === "") throw new TypeError("delegationId is required");
    return store.agreementDelegations.get(makeScopedKey({ tenantId, id: String(delegationId) })) ?? null;
  };

  store.putAgreementDelegation = async function putAgreementDelegation({ tenantId = DEFAULT_TENANT_ID, delegation, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) throw new TypeError("delegation is required");
    const delegationId = delegation.delegationId ?? null;
    if (typeof delegationId !== "string" || delegationId.trim() === "") throw new TypeError("delegation.delegationId is required");
    const key = makeScopedKey({ tenantId, id: String(delegationId) });
    const at = delegation.updatedAt ?? new Date().toISOString();
    await store.commitTx({ at, ops: [{ kind: "AGREEMENT_DELEGATION_UPSERT", tenantId, delegationId, delegation: { ...delegation, tenantId, delegationId } }], audit });
    return store.agreementDelegations.get(key) ?? null;
  };

  store.listAgreementDelegations = async function listAgreementDelegations({
    tenantId = DEFAULT_TENANT_ID,
    parentAgreementHash = null,
    childAgreementHash = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (parentAgreementHash !== null && (typeof parentAgreementHash !== "string" || parentAgreementHash.trim() === "")) {
      throw new TypeError("parentAgreementHash must be null or a non-empty string");
    }
    if (childAgreementHash !== null && (typeof childAgreementHash !== "string" || childAgreementHash.trim() === "")) {
      throw new TypeError("childAgreementHash must be null or a non-empty string");
    }
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const parentFilter = parentAgreementHash ? String(parentAgreementHash).trim().toLowerCase() : null;
    const childFilter = childAgreementHash ? String(childAgreementHash).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.agreementDelegations.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (parentFilter && String(row.parentAgreementHash ?? "").toLowerCase() !== parentFilter) continue;
      if (childFilter && String(row.childAgreementHash ?? "").toLowerCase() !== childFilter) continue;
      if (statusFilter !== null && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.delegationId ?? "").localeCompare(String(right.delegationId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getDelegationGrant = async function getDelegationGrant({ tenantId = DEFAULT_TENANT_ID, grantId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof grantId !== "string" || grantId.trim() === "") throw new TypeError("grantId is required");
    return store.delegationGrants.get(makeScopedKey({ tenantId, id: String(grantId) })) ?? null;
  };

  store.putDelegationGrant = async function putDelegationGrant({ tenantId = DEFAULT_TENANT_ID, delegationGrant, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!delegationGrant || typeof delegationGrant !== "object" || Array.isArray(delegationGrant)) {
      throw new TypeError("delegationGrant is required");
    }
    const grantId = delegationGrant.grantId ?? null;
    if (typeof grantId !== "string" || grantId.trim() === "") throw new TypeError("delegationGrant.grantId is required");
    const key = makeScopedKey({ tenantId, id: String(grantId) });
    const at = delegationGrant.updatedAt ?? delegationGrant.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "DELEGATION_GRANT_UPSERT", tenantId, grantId, delegationGrant: { ...delegationGrant, tenantId, grantId } }],
      audit
    });
    return store.delegationGrants.get(key) ?? null;
  };

  store.listDelegationGrants = async function listDelegationGrants({
    tenantId = DEFAULT_TENANT_ID,
    grantId = null,
    grantHash = null,
    delegatorAgentId = null,
    delegateeAgentId = null,
    includeRevoked = true,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (grantId !== null && (typeof grantId !== "string" || grantId.trim() === "")) throw new TypeError("grantId must be null or a non-empty string");
    if (grantHash !== null && (typeof grantHash !== "string" || grantHash.trim() === "")) {
      throw new TypeError("grantHash must be null or a non-empty string");
    }
    if (delegatorAgentId !== null && (typeof delegatorAgentId !== "string" || delegatorAgentId.trim() === "")) {
      throw new TypeError("delegatorAgentId must be null or a non-empty string");
    }
    if (delegateeAgentId !== null && (typeof delegateeAgentId !== "string" || delegateeAgentId.trim() === "")) {
      throw new TypeError("delegateeAgentId must be null or a non-empty string");
    }
    if (includeRevoked !== true && includeRevoked !== false) throw new TypeError("includeRevoked must be a boolean");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const grantIdFilter = grantId ? String(grantId).trim() : null;
    const grantHashFilter = grantHash ? String(grantHash).trim().toLowerCase() : null;
    const delegatorFilter = delegatorAgentId ? String(delegatorAgentId).trim() : null;
    const delegateeFilter = delegateeAgentId ? String(delegateeAgentId).trim() : null;
    const safeLimit = Math.min(1000, limit);
    const out = [];
    for (const row of store.delegationGrants.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (grantIdFilter && String(row.grantId ?? "") !== grantIdFilter) continue;
      if (grantHashFilter && String(row.grantHash ?? "").toLowerCase() !== grantHashFilter) continue;
      if (delegatorFilter && String(row.delegatorAgentId ?? "") !== delegatorFilter) continue;
      if (delegateeFilter && String(row.delegateeAgentId ?? "") !== delegateeFilter) continue;
      if (!includeRevoked) {
        const revokedAt =
          row?.revocation && typeof row.revocation === "object" && !Array.isArray(row.revocation)
            ? row.revocation.revokedAt
            : null;
        if (typeof revokedAt === "string" && revokedAt.trim() !== "") continue;
      }
      out.push(row);
    }
    out.sort((left, right) => String(left.grantId ?? "").localeCompare(String(right.grantId ?? "")));
    return out.slice(offset, offset + safeLimit);
  };

  store.getAuthorityGrant = async function getAuthorityGrant({ tenantId = DEFAULT_TENANT_ID, grantId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof grantId !== "string" || grantId.trim() === "") throw new TypeError("grantId is required");
    return store.authorityGrants.get(makeScopedKey({ tenantId, id: String(grantId) })) ?? null;
  };

  store.putAuthorityGrant = async function putAuthorityGrant({ tenantId = DEFAULT_TENANT_ID, authorityGrant, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!authorityGrant || typeof authorityGrant !== "object" || Array.isArray(authorityGrant)) {
      throw new TypeError("authorityGrant is required");
    }
    const grantId = authorityGrant.grantId ?? null;
    if (typeof grantId !== "string" || grantId.trim() === "") throw new TypeError("authorityGrant.grantId is required");
    const key = makeScopedKey({ tenantId, id: String(grantId) });
    const at = authorityGrant.updatedAt ?? authorityGrant.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "AUTHORITY_GRANT_UPSERT", tenantId, grantId, authorityGrant: { ...authorityGrant, tenantId, grantId } }],
      audit
    });
    return store.authorityGrants.get(key) ?? null;
  };

  store.listAuthorityGrants = async function listAuthorityGrants({
    tenantId = DEFAULT_TENANT_ID,
    grantId = null,
    grantHash = null,
    principalId = null,
    granteeAgentId = null,
    includeRevoked = true,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (grantId !== null && (typeof grantId !== "string" || grantId.trim() === "")) throw new TypeError("grantId must be null or a non-empty string");
    if (grantHash !== null && (typeof grantHash !== "string" || grantHash.trim() === "")) {
      throw new TypeError("grantHash must be null or a non-empty string");
    }
    if (principalId !== null && (typeof principalId !== "string" || principalId.trim() === "")) {
      throw new TypeError("principalId must be null or a non-empty string");
    }
    if (granteeAgentId !== null && (typeof granteeAgentId !== "string" || granteeAgentId.trim() === "")) {
      throw new TypeError("granteeAgentId must be null or a non-empty string");
    }
    if (includeRevoked !== true && includeRevoked !== false) throw new TypeError("includeRevoked must be a boolean");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const grantIdFilter = grantId ? String(grantId).trim() : null;
    const grantHashFilter = grantHash ? String(grantHash).trim().toLowerCase() : null;
    const principalFilter = principalId ? String(principalId).trim() : null;
    const granteeFilter = granteeAgentId ? String(granteeAgentId).trim() : null;
    const safeLimit = Math.min(1000, limit);
    const out = [];
    for (const row of store.authorityGrants.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (grantIdFilter && String(row.grantId ?? "") !== grantIdFilter) continue;
      if (grantHashFilter && String(row.grantHash ?? "").toLowerCase() !== grantHashFilter) continue;
      if (principalFilter && String(row?.principalRef?.principalId ?? "") !== principalFilter) continue;
      if (granteeFilter && String(row.granteeAgentId ?? "") !== granteeFilter) continue;
      if (!includeRevoked) {
        const revokedAt =
          row?.revocation && typeof row.revocation === "object" && !Array.isArray(row.revocation)
            ? row.revocation.revokedAt
            : null;
        if (typeof revokedAt === "string" && revokedAt.trim() !== "") continue;
      }
      out.push(row);
    }
    out.sort((left, right) => String(left.grantId ?? "").localeCompare(String(right.grantId ?? "")));
    return out.slice(offset, offset + safeLimit);
  };

  store.getTaskQuote = async function getTaskQuote({ tenantId = DEFAULT_TENANT_ID, quoteId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof quoteId !== "string" || quoteId.trim() === "") throw new TypeError("quoteId is required");
    return store.taskQuotes.get(makeScopedKey({ tenantId, id: String(quoteId) })) ?? null;
  };

  store.putTaskQuote = async function putTaskQuote({ tenantId = DEFAULT_TENANT_ID, taskQuote, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!taskQuote || typeof taskQuote !== "object" || Array.isArray(taskQuote)) {
      throw new TypeError("taskQuote is required");
    }
    const quoteId = taskQuote.quoteId ?? null;
    if (typeof quoteId !== "string" || quoteId.trim() === "") throw new TypeError("taskQuote.quoteId is required");
    const at = taskQuote.updatedAt ?? taskQuote.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "TASK_QUOTE_UPSERT", tenantId, quoteId, taskQuote: { ...taskQuote, tenantId, quoteId } }],
      audit
    });
    return store.taskQuotes.get(makeScopedKey({ tenantId, id: String(quoteId) })) ?? null;
  };

  store.listTaskQuotes = async function listTaskQuotes({
    tenantId = DEFAULT_TENANT_ID,
    quoteId = null,
    buyerAgentId = null,
    sellerAgentId = null,
    requiredCapability = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (quoteId !== null && (typeof quoteId !== "string" || quoteId.trim() === "")) throw new TypeError("quoteId must be null or a non-empty string");
    if (buyerAgentId !== null && (typeof buyerAgentId !== "string" || buyerAgentId.trim() === "")) {
      throw new TypeError("buyerAgentId must be null or a non-empty string");
    }
    if (sellerAgentId !== null && (typeof sellerAgentId !== "string" || sellerAgentId.trim() === "")) {
      throw new TypeError("sellerAgentId must be null or a non-empty string");
    }
    if (requiredCapability !== null && (typeof requiredCapability !== "string" || requiredCapability.trim() === "")) {
      throw new TypeError("requiredCapability must be null or a non-empty string");
    }
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const quoteIdFilter = quoteId ? String(quoteId).trim() : null;
    const buyerFilter = buyerAgentId ? String(buyerAgentId).trim() : null;
    const sellerFilter = sellerAgentId ? String(sellerAgentId).trim() : null;
    const capabilityFilter = requiredCapability ? String(requiredCapability).trim() : null;
    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const out = [];
    for (const row of store.taskQuotes.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (quoteIdFilter && String(row.quoteId ?? "") !== quoteIdFilter) continue;
      if (buyerFilter && String(row.buyerAgentId ?? "") !== buyerFilter) continue;
      if (sellerFilter && String(row.sellerAgentId ?? "") !== sellerFilter) continue;
      if (capabilityFilter && String(row.requiredCapability ?? "") !== capabilityFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.quoteId ?? "").localeCompare(String(right.quoteId ?? "")));
    return out.slice(offset, offset + safeLimit);
  };

  store.getTaskOffer = async function getTaskOffer({ tenantId = DEFAULT_TENANT_ID, offerId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof offerId !== "string" || offerId.trim() === "") throw new TypeError("offerId is required");
    return store.taskOffers.get(makeScopedKey({ tenantId, id: String(offerId) })) ?? null;
  };

  store.putTaskOffer = async function putTaskOffer({ tenantId = DEFAULT_TENANT_ID, taskOffer, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!taskOffer || typeof taskOffer !== "object" || Array.isArray(taskOffer)) {
      throw new TypeError("taskOffer is required");
    }
    const offerId = taskOffer.offerId ?? null;
    if (typeof offerId !== "string" || offerId.trim() === "") throw new TypeError("taskOffer.offerId is required");
    const at = taskOffer.updatedAt ?? taskOffer.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "TASK_OFFER_UPSERT", tenantId, offerId, taskOffer: { ...taskOffer, tenantId, offerId } }],
      audit
    });
    return store.taskOffers.get(makeScopedKey({ tenantId, id: String(offerId) })) ?? null;
  };

  store.listTaskOffers = async function listTaskOffers({
    tenantId = DEFAULT_TENANT_ID,
    offerId = null,
    buyerAgentId = null,
    sellerAgentId = null,
    quoteId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (offerId !== null && (typeof offerId !== "string" || offerId.trim() === "")) throw new TypeError("offerId must be null or a non-empty string");
    if (buyerAgentId !== null && (typeof buyerAgentId !== "string" || buyerAgentId.trim() === "")) {
      throw new TypeError("buyerAgentId must be null or a non-empty string");
    }
    if (sellerAgentId !== null && (typeof sellerAgentId !== "string" || sellerAgentId.trim() === "")) {
      throw new TypeError("sellerAgentId must be null or a non-empty string");
    }
    if (quoteId !== null && (typeof quoteId !== "string" || quoteId.trim() === "")) throw new TypeError("quoteId must be null or a non-empty string");
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const offerIdFilter = offerId ? String(offerId).trim() : null;
    const buyerFilter = buyerAgentId ? String(buyerAgentId).trim() : null;
    const sellerFilter = sellerAgentId ? String(sellerAgentId).trim() : null;
    const quoteFilter = quoteId ? String(quoteId).trim() : null;
    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const out = [];
    for (const row of store.taskOffers.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (offerIdFilter && String(row.offerId ?? "") !== offerIdFilter) continue;
      if (buyerFilter && String(row.buyerAgentId ?? "") !== buyerFilter) continue;
      if (sellerFilter && String(row.sellerAgentId ?? "") !== sellerFilter) continue;
      if (quoteFilter && String(row?.quoteRef?.quoteId ?? "") !== quoteFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.offerId ?? "").localeCompare(String(right.offerId ?? "")));
    return out.slice(offset, offset + safeLimit);
  };

  store.getTaskAcceptance = async function getTaskAcceptance({ tenantId = DEFAULT_TENANT_ID, acceptanceId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof acceptanceId !== "string" || acceptanceId.trim() === "") throw new TypeError("acceptanceId is required");
    return store.taskAcceptances.get(makeScopedKey({ tenantId, id: String(acceptanceId) })) ?? null;
  };

  store.putTaskAcceptance = async function putTaskAcceptance({ tenantId = DEFAULT_TENANT_ID, taskAcceptance, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!taskAcceptance || typeof taskAcceptance !== "object" || Array.isArray(taskAcceptance)) {
      throw new TypeError("taskAcceptance is required");
    }
    const acceptanceId = taskAcceptance.acceptanceId ?? null;
    if (typeof acceptanceId !== "string" || acceptanceId.trim() === "") throw new TypeError("taskAcceptance.acceptanceId is required");
    const at = taskAcceptance.updatedAt ?? taskAcceptance.acceptedAt ?? taskAcceptance.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "TASK_ACCEPTANCE_UPSERT", tenantId, acceptanceId, taskAcceptance: { ...taskAcceptance, tenantId, acceptanceId } }],
      audit
    });
    return store.taskAcceptances.get(makeScopedKey({ tenantId, id: String(acceptanceId) })) ?? null;
  };

  store.listTaskAcceptances = async function listTaskAcceptances({
    tenantId = DEFAULT_TENANT_ID,
    acceptanceId = null,
    buyerAgentId = null,
    sellerAgentId = null,
    quoteId = null,
    offerId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (acceptanceId !== null && (typeof acceptanceId !== "string" || acceptanceId.trim() === "")) {
      throw new TypeError("acceptanceId must be null or a non-empty string");
    }
    if (buyerAgentId !== null && (typeof buyerAgentId !== "string" || buyerAgentId.trim() === "")) {
      throw new TypeError("buyerAgentId must be null or a non-empty string");
    }
    if (sellerAgentId !== null && (typeof sellerAgentId !== "string" || sellerAgentId.trim() === "")) {
      throw new TypeError("sellerAgentId must be null or a non-empty string");
    }
    if (quoteId !== null && (typeof quoteId !== "string" || quoteId.trim() === "")) throw new TypeError("quoteId must be null or a non-empty string");
    if (offerId !== null && (typeof offerId !== "string" || offerId.trim() === "")) throw new TypeError("offerId must be null or a non-empty string");
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const acceptanceIdFilter = acceptanceId ? String(acceptanceId).trim() : null;
    const buyerFilter = buyerAgentId ? String(buyerAgentId).trim() : null;
    const sellerFilter = sellerAgentId ? String(sellerAgentId).trim() : null;
    const quoteFilter = quoteId ? String(quoteId).trim() : null;
    const offerFilter = offerId ? String(offerId).trim() : null;
    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const out = [];
    for (const row of store.taskAcceptances.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (acceptanceIdFilter && String(row.acceptanceId ?? "") !== acceptanceIdFilter) continue;
      if (buyerFilter && String(row.buyerAgentId ?? "") !== buyerFilter) continue;
      if (sellerFilter && String(row.sellerAgentId ?? "") !== sellerFilter) continue;
      if (quoteFilter && String(row?.quoteRef?.quoteId ?? "") !== quoteFilter) continue;
      if (offerFilter && String(row?.offerRef?.offerId ?? "") !== offerFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.acceptanceId ?? "").localeCompare(String(right.acceptanceId ?? "")));
    return out.slice(offset, offset + safeLimit);
  };

  store.getCapabilityAttestation = async function getCapabilityAttestation({ tenantId = DEFAULT_TENANT_ID, attestationId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof attestationId !== "string" || attestationId.trim() === "") throw new TypeError("attestationId is required");
    return store.capabilityAttestations.get(makeScopedKey({ tenantId, id: String(attestationId) })) ?? null;
  };

  store.putCapabilityAttestation = async function putCapabilityAttestation({
    tenantId = DEFAULT_TENANT_ID,
    capabilityAttestation,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!capabilityAttestation || typeof capabilityAttestation !== "object" || Array.isArray(capabilityAttestation)) {
      throw new TypeError("capabilityAttestation is required");
    }
    const attestationId = capabilityAttestation.attestationId ?? null;
    if (typeof attestationId !== "string" || attestationId.trim() === "") throw new TypeError("capabilityAttestation.attestationId is required");
    normalizeCapabilityIdentifier(capabilityAttestation.capability, { name: "capabilityAttestation.capability" });
    const at = capabilityAttestation.updatedAt ?? capabilityAttestation.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "CAPABILITY_ATTESTATION_UPSERT", tenantId, attestationId, capabilityAttestation: { ...capabilityAttestation, tenantId, attestationId } }],
      audit
    });
    return store.capabilityAttestations.get(makeScopedKey({ tenantId, id: String(attestationId) })) ?? null;
  };

  store.listCapabilityAttestations = async function listCapabilityAttestations({
    tenantId = DEFAULT_TENANT_ID,
    attestationId = null,
    subjectAgentId = null,
    issuerAgentId = null,
    capability = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (attestationId !== null && (typeof attestationId !== "string" || attestationId.trim() === "")) {
      throw new TypeError("attestationId must be null or a non-empty string");
    }
    if (subjectAgentId !== null && (typeof subjectAgentId !== "string" || subjectAgentId.trim() === "")) {
      throw new TypeError("subjectAgentId must be null or a non-empty string");
    }
    if (issuerAgentId !== null && (typeof issuerAgentId !== "string" || issuerAgentId.trim() === "")) {
      throw new TypeError("issuerAgentId must be null or a non-empty string");
    }
    if (capability !== null && (typeof capability !== "string" || capability.trim() === "")) {
      throw new TypeError("capability must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const attestationIdFilter = attestationId ? String(attestationId).trim() : null;
    const subjectAgentIdFilter = subjectAgentId ? String(subjectAgentId).trim() : null;
    const issuerAgentIdFilter = issuerAgentId ? String(issuerAgentId).trim() : null;
    const capabilityFilter = capability ? normalizeCapabilityIdentifier(capability, { name: "capability" }) : null;
    const safeLimit = Math.min(1000, limit);

    const out = [];
    for (const row of store.capabilityAttestations.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (attestationIdFilter && String(row.attestationId ?? "") !== attestationIdFilter) continue;
      if (subjectAgentIdFilter && String(row.subjectAgentId ?? "") !== subjectAgentIdFilter) continue;
      if (issuerAgentIdFilter && String(row.issuerAgentId ?? "") !== issuerAgentIdFilter) continue;
      if (capabilityFilter && String(row.capability ?? "") !== capabilityFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.attestationId ?? "").localeCompare(String(right.attestationId ?? "")));
    return out.slice(offset, offset + safeLimit);
  };

  store.getIntentContract = async function getIntentContract({ tenantId = DEFAULT_TENANT_ID, intentId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof intentId !== "string" || intentId.trim() === "") throw new TypeError("intentId is required");
    return store.intentContracts.get(makeScopedKey({ tenantId, id: String(intentId) })) ?? null;
  };

  store.putIntentContract = async function putIntentContract({ tenantId = DEFAULT_TENANT_ID, intentContract, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!intentContract || typeof intentContract !== "object" || Array.isArray(intentContract)) {
      throw new TypeError("intentContract is required");
    }
    const intentId = intentContract.intentId ?? null;
    if (typeof intentId !== "string" || intentId.trim() === "") throw new TypeError("intentContract.intentId is required");
    const at = intentContract.updatedAt ?? intentContract.proposedAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "INTENT_CONTRACT_UPSERT", tenantId, intentId, intentContract: { ...intentContract, tenantId, intentId } }],
      audit
    });
    return store.intentContracts.get(makeScopedKey({ tenantId, id: String(intentId) })) ?? null;
  };

  store.listIntentContracts = async function listIntentContracts({
    tenantId = DEFAULT_TENANT_ID,
    intentId = null,
    proposerAgentId = null,
    counterpartyAgentId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (intentId !== null && (typeof intentId !== "string" || intentId.trim() === "")) {
      throw new TypeError("intentId must be null or a non-empty string");
    }
    if (proposerAgentId !== null && (typeof proposerAgentId !== "string" || proposerAgentId.trim() === "")) {
      throw new TypeError("proposerAgentId must be null or a non-empty string");
    }
    if (counterpartyAgentId !== null && (typeof counterpartyAgentId !== "string" || counterpartyAgentId.trim() === "")) {
      throw new TypeError("counterpartyAgentId must be null or a non-empty string");
    }
    if (status !== null && (typeof status !== "string" || status.trim() === "")) {
      throw new TypeError("status must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const intentIdFilter = intentId ? String(intentId).trim() : null;
    const proposerFilter = proposerAgentId ? String(proposerAgentId).trim() : null;
    const counterpartyFilter = counterpartyAgentId ? String(counterpartyAgentId).trim() : null;
    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const out = [];
    for (const row of store.intentContracts.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (intentIdFilter && String(row.intentId ?? "") !== intentIdFilter) continue;
      if (proposerFilter && String(row.proposerAgentId ?? "") !== proposerFilter) continue;
      if (counterpartyFilter && String(row.counterpartyAgentId ?? "") !== counterpartyFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.intentId ?? "").localeCompare(String(right.intentId ?? "")));
    return out.slice(offset, offset + safeLimit);
  };

  store.getSubAgentWorkOrder = async function getSubAgentWorkOrder({ tenantId = DEFAULT_TENANT_ID, workOrderId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof workOrderId !== "string" || workOrderId.trim() === "") throw new TypeError("workOrderId is required");
    return store.subAgentWorkOrders.get(makeScopedKey({ tenantId, id: String(workOrderId) })) ?? null;
  };

  store.putSubAgentWorkOrder = async function putSubAgentWorkOrder({ tenantId = DEFAULT_TENANT_ID, workOrder, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!workOrder || typeof workOrder !== "object" || Array.isArray(workOrder)) throw new TypeError("workOrder is required");
    const workOrderId = workOrder.workOrderId ?? null;
    if (typeof workOrderId !== "string" || workOrderId.trim() === "") throw new TypeError("workOrder.workOrderId is required");
    const at = workOrder.updatedAt ?? workOrder.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "SUB_AGENT_WORK_ORDER_UPSERT", tenantId, workOrderId, workOrder: { ...workOrder, tenantId, workOrderId } }],
      audit
    });
    return store.subAgentWorkOrders.get(makeScopedKey({ tenantId, id: String(workOrderId) })) ?? null;
  };

  store.listSubAgentWorkOrders = async function listSubAgentWorkOrders({
    tenantId = DEFAULT_TENANT_ID,
    workOrderId = null,
    principalAgentId = null,
    subAgentId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (workOrderId !== null && (typeof workOrderId !== "string" || workOrderId.trim() === "")) {
      throw new TypeError("workOrderId must be null or a non-empty string");
    }
    if (principalAgentId !== null && (typeof principalAgentId !== "string" || principalAgentId.trim() === "")) {
      throw new TypeError("principalAgentId must be null or a non-empty string");
    }
    if (subAgentId !== null && (typeof subAgentId !== "string" || subAgentId.trim() === "")) {
      throw new TypeError("subAgentId must be null or a non-empty string");
    }
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const workOrderIdFilter = workOrderId ? String(workOrderId).trim() : null;
    const principalFilter = principalAgentId ? String(principalAgentId).trim() : null;
    const subAgentFilter = subAgentId ? String(subAgentId).trim() : null;
    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.subAgentWorkOrders.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (workOrderIdFilter && String(row.workOrderId ?? "") !== workOrderIdFilter) continue;
      if (principalFilter && String(row.principalAgentId ?? "") !== principalFilter) continue;
      if (subAgentFilter && String(row.subAgentId ?? "") !== subAgentFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.workOrderId ?? "").localeCompare(String(right.workOrderId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getSubAgentCompletionReceipt = async function getSubAgentCompletionReceipt({ tenantId = DEFAULT_TENANT_ID, receiptId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof receiptId !== "string" || receiptId.trim() === "") throw new TypeError("receiptId is required");
    return store.subAgentCompletionReceipts.get(makeScopedKey({ tenantId, id: String(receiptId) })) ?? null;
  };

  store.putSubAgentCompletionReceipt = async function putSubAgentCompletionReceipt({
    tenantId = DEFAULT_TENANT_ID,
    completionReceipt,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!completionReceipt || typeof completionReceipt !== "object" || Array.isArray(completionReceipt)) {
      throw new TypeError("completionReceipt is required");
    }
    const receiptId = completionReceipt.receiptId ?? null;
    if (typeof receiptId !== "string" || receiptId.trim() === "") throw new TypeError("completionReceipt.receiptId is required");
    const at = completionReceipt.deliveredAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [
        {
          kind: "SUB_AGENT_COMPLETION_RECEIPT_UPSERT",
          tenantId,
          receiptId,
          completionReceipt: { ...completionReceipt, tenantId, receiptId }
        }
      ],
      audit
    });
    return store.subAgentCompletionReceipts.get(makeScopedKey({ tenantId, id: String(receiptId) })) ?? null;
  };

  store.listSubAgentCompletionReceipts = async function listSubAgentCompletionReceipts({
    tenantId = DEFAULT_TENANT_ID,
    receiptId = null,
    workOrderId = null,
    principalAgentId = null,
    subAgentId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (receiptId !== null && (typeof receiptId !== "string" || receiptId.trim() === "")) throw new TypeError("receiptId must be null or a non-empty string");
    if (workOrderId !== null && (typeof workOrderId !== "string" || workOrderId.trim() === "")) throw new TypeError("workOrderId must be null or a non-empty string");
    if (principalAgentId !== null && (typeof principalAgentId !== "string" || principalAgentId.trim() === "")) {
      throw new TypeError("principalAgentId must be null or a non-empty string");
    }
    if (subAgentId !== null && (typeof subAgentId !== "string" || subAgentId.trim() === "")) {
      throw new TypeError("subAgentId must be null or a non-empty string");
    }
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const receiptIdFilter = receiptId ? String(receiptId).trim() : null;
    const workOrderFilter = workOrderId ? String(workOrderId).trim() : null;
    const principalFilter = principalAgentId ? String(principalAgentId).trim() : null;
    const subAgentFilter = subAgentId ? String(subAgentId).trim() : null;
    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.subAgentCompletionReceipts.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (receiptIdFilter && String(row.receiptId ?? "") !== receiptIdFilter) continue;
      if (workOrderFilter && String(row.workOrderId ?? "") !== workOrderFilter) continue;
      if (principalFilter && String(row.principalAgentId ?? "") !== principalFilter) continue;
      if (subAgentFilter && String(row.subAgentId ?? "") !== subAgentFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.receiptId ?? "").localeCompare(String(right.receiptId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getX402Gate = async function getX402Gate({ tenantId = DEFAULT_TENANT_ID, gateId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof gateId !== "string" || gateId.trim() === "") throw new TypeError("gateId is required");
    return store.x402Gates.get(makeScopedKey({ tenantId, id: String(gateId) })) ?? null;
  };

  store.putX402Gate = async function putX402Gate({ tenantId = DEFAULT_TENANT_ID, gate, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) throw new TypeError("gate is required");
    const gateId = gate.gateId ?? gate.id ?? null;
    if (typeof gateId !== "string" || gateId.trim() === "") throw new TypeError("gate.gateId is required");
    const key = makeScopedKey({ tenantId, id: String(gateId) });
    const at = gate.updatedAt ?? gate.createdAt ?? new Date().toISOString();
    await store.commitTx({ at, ops: [{ kind: "X402_GATE_UPSERT", tenantId, gateId, gate: { ...gate, tenantId, gateId: String(gateId) } }], audit });
    return store.x402Gates.get(key) ?? null;
  };

  store.putX402AgentLifecycle = async function putX402AgentLifecycle({ tenantId = DEFAULT_TENANT_ID, agentLifecycle, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!agentLifecycle || typeof agentLifecycle !== "object" || Array.isArray(agentLifecycle)) {
      throw new TypeError("agentLifecycle is required");
    }
    const agentId = typeof agentLifecycle.agentId === "string" ? agentLifecycle.agentId.trim() : "";
    if (!agentId) throw new TypeError("agentLifecycle.agentId is required");
    const status = typeof agentLifecycle.status === "string" ? agentLifecycle.status.trim().toLowerCase() : "";
    if (
      status !== "provisioned" &&
      status !== "active" &&
      status !== "throttled" &&
      status !== "suspended" &&
      status !== "quarantined" &&
      status !== "decommissioned" &&
      status !== "frozen" &&
      status !== "archived"
    ) {
      throw new TypeError(
        "agentLifecycle.status must be provisioned|active|throttled|suspended|quarantined|decommissioned|frozen|archived"
      );
    }
    const at = agentLifecycle.updatedAt ?? agentLifecycle.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [
        {
          kind: "X402_AGENT_LIFECYCLE_UPSERT",
          tenantId,
          agentId,
          agentLifecycle: { ...agentLifecycle, tenantId, agentId, status }
        }
      ],
      audit
    });
    return store.x402AgentLifecycles.get(makeScopedKey({ tenantId, id: agentId })) ?? null;
  };

  store.getX402AgentLifecycle = async function getX402AgentLifecycle({ tenantId = DEFAULT_TENANT_ID, agentId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("agentId is required");
    return store.x402AgentLifecycles.get(makeScopedKey({ tenantId, id: String(agentId) })) ?? null;
  };

  function x402WalletPolicyStoreKey({ tenantId, sponsorWalletRef, policyRef, policyVersion }) {
    const normalizedTenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const normalizedSponsorWalletRef = typeof sponsorWalletRef === "string" ? sponsorWalletRef.trim() : "";
    const normalizedPolicyRef = typeof policyRef === "string" ? policyRef.trim() : "";
    const normalizedPolicyVersion = Number(policyVersion);
    if (!normalizedSponsorWalletRef) throw new TypeError("sponsorWalletRef is required");
    if (!normalizedPolicyRef) throw new TypeError("policyRef is required");
    if (!Number.isSafeInteger(normalizedPolicyVersion) || normalizedPolicyVersion <= 0) {
      throw new TypeError("policyVersion must be a positive safe integer");
    }
    return makeScopedKey({
      tenantId: normalizedTenantId,
      id: `${normalizedSponsorWalletRef}::${normalizedPolicyRef}::${normalizedPolicyVersion}`
    });
  }

  function x402WebhookEndpointStoreKey({ tenantId, endpointId }) {
    const normalizedTenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const normalizedEndpointId = typeof endpointId === "string" ? endpointId.trim() : "";
    if (!normalizedEndpointId) throw new TypeError("endpointId is required");
    return makeScopedKey({ tenantId: normalizedTenantId, id: normalizedEndpointId });
  }

  function x402ZkVerificationKeyStoreKey({ tenantId, verificationKeyId }) {
    const normalizedTenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const normalizedVerificationKeyId = typeof verificationKeyId === "string" ? verificationKeyId.trim() : "";
    if (!normalizedVerificationKeyId) throw new TypeError("verificationKeyId is required");
    return makeScopedKey({ tenantId: normalizedTenantId, id: normalizedVerificationKeyId });
  }

  store.putX402WalletPolicy = async function putX402WalletPolicy({ tenantId = DEFAULT_TENANT_ID, policy, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("policy is required");
    const sponsorWalletRef = typeof policy.sponsorWalletRef === "string" ? policy.sponsorWalletRef.trim() : "";
    const policyRef = typeof policy.policyRef === "string" ? policy.policyRef.trim() : "";
    const policyVersion = Number(policy.policyVersion);
    if (!sponsorWalletRef) throw new TypeError("policy.sponsorWalletRef is required");
    if (!policyRef) throw new TypeError("policy.policyRef is required");
    if (!Number.isSafeInteger(policyVersion) || policyVersion <= 0) throw new TypeError("policy.policyVersion must be a positive safe integer");
    const key = x402WalletPolicyStoreKey({ tenantId, sponsorWalletRef, policyRef, policyVersion });
    const at = policy.updatedAt ?? policy.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [
        {
          kind: "X402_WALLET_POLICY_UPSERT",
          tenantId,
          policy: { ...policy, tenantId, sponsorWalletRef, policyRef, policyVersion }
        }
      ],
      audit
    });
    return store.x402WalletPolicies.get(key) ?? null;
  };

  store.getX402WalletPolicy = async function getX402WalletPolicy({
    tenantId = DEFAULT_TENANT_ID,
    sponsorWalletRef,
    policyRef,
    policyVersion
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    const key = x402WalletPolicyStoreKey({ tenantId, sponsorWalletRef, policyRef, policyVersion });
    return store.x402WalletPolicies.get(key) ?? null;
  };

  store.listX402WalletPolicies = async function listX402WalletPolicies({
    tenantId = DEFAULT_TENANT_ID,
    sponsorWalletRef = null,
    sponsorRef = null,
    policyRef = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (sponsorWalletRef !== null && (typeof sponsorWalletRef !== "string" || sponsorWalletRef.trim() === "")) {
      throw new TypeError("sponsorWalletRef must be null or a non-empty string");
    }
    if (sponsorRef !== null && (typeof sponsorRef !== "string" || sponsorRef.trim() === "")) {
      throw new TypeError("sponsorRef must be null or a non-empty string");
    }
    if (policyRef !== null && (typeof policyRef !== "string" || policyRef.trim() === "")) {
      throw new TypeError("policyRef must be null or a non-empty string");
    }
    if (status !== null && (typeof status !== "string" || status.trim() === "")) {
      throw new TypeError("status must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const sponsorWalletFilter = sponsorWalletRef ? sponsorWalletRef.trim() : null;
    const sponsorFilter = sponsorRef ? sponsorRef.trim() : null;
    const policyFilter = policyRef ? policyRef.trim() : null;
    const statusFilter = status ? status.trim().toLowerCase() : null;
    const out = [];
    for (const row of store.x402WalletPolicies.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (sponsorWalletFilter && String(row.sponsorWalletRef ?? "") !== sponsorWalletFilter) continue;
      if (sponsorFilter && String(row.sponsorRef ?? "") !== sponsorFilter) continue;
      if (policyFilter && String(row.policyRef ?? "") !== policyFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftAt = Number.isFinite(Date.parse(String(left?.updatedAt ?? ""))) ? Date.parse(String(left.updatedAt)) : Number.NaN;
      const rightAt = Number.isFinite(Date.parse(String(right?.updatedAt ?? ""))) ? Date.parse(String(right.updatedAt)) : Number.NaN;
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && rightAt !== leftAt) return rightAt - leftAt;
      const sponsorOrder = String(left?.sponsorWalletRef ?? "").localeCompare(String(right?.sponsorWalletRef ?? ""));
      if (sponsorOrder !== 0) return sponsorOrder;
      const policyOrder = String(left?.policyRef ?? "").localeCompare(String(right?.policyRef ?? ""));
      if (policyOrder !== 0) return policyOrder;
      return Number(right?.policyVersion ?? 0) - Number(left?.policyVersion ?? 0);
    });
    return out.slice(offset, offset + Math.min(1000, limit));
  };

  store.putX402ZkVerificationKey = async function putX402ZkVerificationKey({
    tenantId = DEFAULT_TENANT_ID,
    verificationKey,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!verificationKey || typeof verificationKey !== "object" || Array.isArray(verificationKey)) {
      throw new TypeError("verificationKey is required");
    }
    const verificationKeyId = typeof verificationKey.verificationKeyId === "string" ? verificationKey.verificationKeyId.trim() : "";
    if (!verificationKeyId) throw new TypeError("verificationKey.verificationKeyId is required");
    const key = x402ZkVerificationKeyStoreKey({ tenantId, verificationKeyId });
    const at = verificationKey.updatedAt ?? verificationKey.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [
        {
          kind: "X402_ZK_VERIFICATION_KEY_PUT",
          tenantId,
          verificationKeyId,
          verificationKey: { ...verificationKey, tenantId, verificationKeyId }
        }
      ],
      audit
    });
    return store.x402ZkVerificationKeys.get(key) ?? null;
  };

  store.getX402ZkVerificationKey = async function getX402ZkVerificationKey({
    tenantId = DEFAULT_TENANT_ID,
    verificationKeyId
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    return store.x402ZkVerificationKeys.get(x402ZkVerificationKeyStoreKey({ tenantId, verificationKeyId })) ?? null;
  };

  store.listX402ZkVerificationKeys = async function listX402ZkVerificationKeys({
    tenantId = DEFAULT_TENANT_ID,
    protocol = null,
    providerRef = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (protocol !== null && (typeof protocol !== "string" || protocol.trim() === "")) {
      throw new TypeError("protocol must be null or a non-empty string");
    }
    if (providerRef !== null && (typeof providerRef !== "string" || providerRef.trim() === "")) {
      throw new TypeError("providerRef must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const protocolFilter = protocol ? protocol.trim().toLowerCase() : null;
    const providerRefFilter = providerRef ? providerRef.trim() : null;
    const out = [];
    for (const row of store.x402ZkVerificationKeys.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (protocolFilter && String(row.protocol ?? "").trim().toLowerCase() !== protocolFilter) continue;
      if (providerRefFilter && String(row.providerRef ?? "") !== providerRefFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftAt = Number.isFinite(Date.parse(String(left?.createdAt ?? ""))) ? Date.parse(String(left.createdAt)) : Number.NaN;
      const rightAt = Number.isFinite(Date.parse(String(right?.createdAt ?? ""))) ? Date.parse(String(right.createdAt)) : Number.NaN;
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && rightAt !== leftAt) return rightAt - leftAt;
      return String(left?.verificationKeyId ?? "").localeCompare(String(right?.verificationKeyId ?? ""));
    });
    return out.slice(offset, offset + Math.min(1000, limit));
  };

  store.putX402WebhookEndpoint = async function putX402WebhookEndpoint({ tenantId = DEFAULT_TENANT_ID, endpoint, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) throw new TypeError("endpoint is required");
    const endpointId = typeof endpoint.endpointId === "string" ? endpoint.endpointId.trim() : "";
    if (!endpointId) throw new TypeError("endpoint.endpointId is required");
    const at = endpoint.updatedAt ?? endpoint.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "X402_WEBHOOK_ENDPOINT_UPSERT", tenantId, endpointId, endpoint: { ...endpoint, tenantId, endpointId } }],
      audit
    });
    return store.x402WebhookEndpoints.get(x402WebhookEndpointStoreKey({ tenantId, endpointId })) ?? null;
  };

  store.getX402WebhookEndpoint = async function getX402WebhookEndpoint({ tenantId = DEFAULT_TENANT_ID, endpointId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    return store.x402WebhookEndpoints.get(x402WebhookEndpointStoreKey({ tenantId, endpointId })) ?? null;
  };

  store.listX402WebhookEndpoints = async function listX402WebhookEndpoints({
    tenantId = DEFAULT_TENANT_ID,
    endpointId = null,
    destinationId = null,
    status = null,
    event = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (endpointId !== null && (typeof endpointId !== "string" || endpointId.trim() === "")) {
      throw new TypeError("endpointId must be null or a non-empty string");
    }
    if (destinationId !== null && (typeof destinationId !== "string" || destinationId.trim() === "")) {
      throw new TypeError("destinationId must be null or a non-empty string");
    }
    if (status !== null && (typeof status !== "string" || status.trim() === "")) {
      throw new TypeError("status must be null or a non-empty string");
    }
    if (event !== null && (typeof event !== "string" || event.trim() === "")) {
      throw new TypeError("event must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const endpointFilter = endpointId ? endpointId.trim() : null;
    const destinationFilter = destinationId ? destinationId.trim() : null;
    const statusFilter = status ? status.trim().toLowerCase() : null;
    const eventFilter = event ? event.trim().toLowerCase() : null;
    const out = [];
    for (const row of store.x402WebhookEndpoints.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (endpointFilter && String(row.endpointId ?? "") !== endpointFilter) continue;
      if (destinationFilter && String(row.destinationId ?? "") !== destinationFilter) continue;
      if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      if (eventFilter) {
        const events = Array.isArray(row.events) ? row.events.map((value) => String(value).trim().toLowerCase()) : [];
        if (!events.includes(eventFilter)) continue;
      }
      out.push(row);
    }
    out.sort((left, right) => {
      const leftAt = Number.isFinite(Date.parse(String(left?.updatedAt ?? ""))) ? Date.parse(String(left.updatedAt)) : Number.NaN;
      const rightAt = Number.isFinite(Date.parse(String(right?.updatedAt ?? ""))) ? Date.parse(String(right.updatedAt)) : Number.NaN;
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && rightAt !== leftAt) return rightAt - leftAt;
      return String(left?.endpointId ?? "").localeCompare(String(right?.endpointId ?? ""));
    });
    return out.slice(offset, offset + Math.min(1000, limit));
  };

  store.recordX402WebhookEndpointDeliveryResult = async function recordX402WebhookEndpointDeliveryResult({
    tenantId = DEFAULT_TENANT_ID,
    destinationId,
    deliveredAt = new Date().toISOString(),
    success,
    failureReason = null,
    statusCode = null,
    autoDisableThreshold = null,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof destinationId !== "string" || destinationId.trim() === "") throw new TypeError("destinationId is required");
    const matched = await store.listX402WebhookEndpoints({ tenantId, destinationId: destinationId.trim(), limit: 1, offset: 0 });
    const endpoint = Array.isArray(matched) && matched.length > 0 ? matched[0] : null;
    if (!endpoint) return null;
    if (String(endpoint.status ?? "").toLowerCase() === "revoked") return endpoint;
    const thresholdRaw = autoDisableThreshold ?? store.x402WebhookAutoDisableFailures ?? 10;
    const threshold = Number.isSafeInteger(Number(thresholdRaw)) && Number(thresholdRaw) > 0 ? Number(thresholdRaw) : 10;
    const next = {
      ...endpoint,
      updatedAt: deliveredAt,
      lastDeliveryAt: deliveredAt
    };
    if (success) {
      next.consecutiveFailures = 0;
      next.lastFailureReason = null;
      next.lastFailureAt = null;
      next.lastFailureStatusCode = null;
    } else {
      const prevFailures = Number.isSafeInteger(Number(endpoint.consecutiveFailures)) ? Number(endpoint.consecutiveFailures) : 0;
      next.consecutiveFailures = prevFailures + 1;
      next.lastFailureReason = failureReason ? String(failureReason) : "delivery_failed";
      next.lastFailureAt = deliveredAt;
      next.lastFailureStatusCode = Number.isSafeInteger(Number(statusCode)) ? Number(statusCode) : null;
      if (String(endpoint.status ?? "").toLowerCase() === "active" && next.consecutiveFailures >= threshold) {
        next.status = "disabled";
        next.disabledAt = deliveredAt;
      }
    }
    return store.putX402WebhookEndpoint({ tenantId, endpoint: next, audit });
  };

  function x402ReversalNonceStoreKey({ tenantId, sponsorRef, nonce }) {
    const normalizedTenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const normalizedSponsorRef = typeof sponsorRef === "string" ? sponsorRef.trim() : "";
    const normalizedNonce = typeof nonce === "string" ? nonce.trim() : "";
    if (!normalizedSponsorRef) throw new TypeError("sponsorRef is required");
    if (!normalizedNonce) throw new TypeError("nonce is required");
    return `${normalizedTenantId}\n${normalizedSponsorRef}\n${normalizedNonce}`;
  }

  store.putX402ReversalEvent = async function putX402ReversalEvent({ tenantId = DEFAULT_TENANT_ID, gateId, event, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof gateId !== "string" || gateId.trim() === "") throw new TypeError("gateId is required");
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event is required");
    const eventId = event.eventId ?? event.id ?? null;
    if (typeof eventId !== "string" || eventId.trim() === "") throw new TypeError("event.eventId is required");
    const at = event.occurredAt ?? event.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "X402_REVERSAL_EVENT_APPEND", tenantId, gateId: String(gateId), eventId: String(eventId), event: { ...event, tenantId, gateId: String(gateId), eventId: String(eventId) } }],
      audit
    });
    return store.x402ReversalEvents.get(makeScopedKey({ tenantId, id: String(eventId) })) ?? null;
  };

  store.getX402ReversalEvent = async function getX402ReversalEvent({ tenantId = DEFAULT_TENANT_ID, eventId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof eventId !== "string" || eventId.trim() === "") throw new TypeError("eventId is required");
    return store.x402ReversalEvents.get(makeScopedKey({ tenantId, id: String(eventId) })) ?? null;
  };

  store.listX402ReversalEvents = async function listX402ReversalEvents({
    tenantId = DEFAULT_TENANT_ID,
    gateId = null,
    receiptId = null,
    action = null,
    from = null,
    to = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (gateId !== null && (typeof gateId !== "string" || gateId.trim() === "")) throw new TypeError("gateId must be null or a non-empty string");
    if (receiptId !== null && (typeof receiptId !== "string" || receiptId.trim() === "")) throw new TypeError("receiptId must be null or a non-empty string");
    if (action !== null && (typeof action !== "string" || action.trim() === "")) throw new TypeError("action must be null or a non-empty string");
    if (from !== null && !Number.isFinite(Date.parse(String(from)))) throw new TypeError("from must be null or an ISO date-time");
    if (to !== null && !Number.isFinite(Date.parse(String(to)))) throw new TypeError("to must be null or an ISO date-time");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const normalizedGateId = gateId ? gateId.trim() : null;
    const normalizedReceiptId = receiptId ? receiptId.trim() : null;
    const normalizedAction = action ? action.trim().toLowerCase() : null;
    const fromMs = from ? Date.parse(String(from)) : null;
    const toMs = to ? Date.parse(String(to)) : null;

    const out = [];
    for (const row of store.x402ReversalEvents.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (normalizedGateId && String(row.gateId ?? "") !== normalizedGateId) continue;
      if (normalizedReceiptId && String(row.receiptId ?? "") !== normalizedReceiptId) continue;
      if (normalizedAction && String(row.action ?? "").toLowerCase() !== normalizedAction) continue;
      const occurredAtMs = Number.isFinite(Date.parse(String(row.occurredAt ?? ""))) ? Date.parse(String(row.occurredAt)) : Number.NaN;
      if (fromMs !== null && (!Number.isFinite(occurredAtMs) || occurredAtMs < fromMs)) continue;
      if (toMs !== null && (!Number.isFinite(occurredAtMs) || occurredAtMs > toMs)) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftMs = Number.isFinite(Date.parse(String(left?.occurredAt ?? ""))) ? Date.parse(String(left.occurredAt)) : Number.NaN;
      const rightMs = Number.isFinite(Date.parse(String(right?.occurredAt ?? ""))) ? Date.parse(String(right.occurredAt)) : Number.NaN;
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return rightMs - leftMs;
      return String(left?.eventId ?? "").localeCompare(String(right?.eventId ?? ""));
    });
    return out.slice(offset, offset + Math.min(1000, limit));
  };

  store.putX402ReversalNonceUsage = async function putX402ReversalNonceUsage({ tenantId = DEFAULT_TENANT_ID, usage, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new TypeError("usage is required");
    const sponsorRef = typeof usage.sponsorRef === "string" ? usage.sponsorRef.trim() : "";
    const nonce = typeof usage.nonce === "string" ? usage.nonce.trim() : "";
    if (!sponsorRef) throw new TypeError("usage.sponsorRef is required");
    if (!nonce) throw new TypeError("usage.nonce is required");
    const at = usage.usedAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "X402_REVERSAL_NONCE_PUT", tenantId, sponsorRef, nonce, usage: { ...usage, tenantId, sponsorRef, nonce } }],
      audit
    });
    return store.x402ReversalNonceUsage.get(x402ReversalNonceStoreKey({ tenantId, sponsorRef, nonce })) ?? null;
  };

  store.getX402ReversalNonceUsage = async function getX402ReversalNonceUsage({ tenantId = DEFAULT_TENANT_ID, sponsorRef, nonce } = {}) {
    tenantId = normalizeTenantId(tenantId);
    return store.x402ReversalNonceUsage.get(x402ReversalNonceStoreKey({ tenantId, sponsorRef, nonce })) ?? null;
  };

  store.putX402ReversalCommandUsage = async function putX402ReversalCommandUsage({ tenantId = DEFAULT_TENANT_ID, usage, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new TypeError("usage is required");
    const commandId = typeof usage.commandId === "string" ? usage.commandId.trim() : "";
    if (!commandId) throw new TypeError("usage.commandId is required");
    const at = usage.usedAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "X402_REVERSAL_COMMAND_PUT", tenantId, commandId, usage: { ...usage, tenantId, commandId } }],
      audit
    });
    return store.x402ReversalCommandUsage.get(makeScopedKey({ tenantId, id: commandId })) ?? null;
  };

  store.getX402ReversalCommandUsage = async function getX402ReversalCommandUsage({ tenantId = DEFAULT_TENANT_ID, commandId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof commandId !== "string" || commandId.trim() === "") throw new TypeError("commandId is required");
    return store.x402ReversalCommandUsage.get(makeScopedKey({ tenantId, id: commandId.trim() })) ?? null;
  };

  store.putX402Escalation = async function putX402Escalation({ tenantId = DEFAULT_TENANT_ID, escalation, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!escalation || typeof escalation !== "object" || Array.isArray(escalation)) throw new TypeError("escalation is required");
    const escalationId = typeof escalation.escalationId === "string" ? escalation.escalationId.trim() : "";
    if (!escalationId) throw new TypeError("escalation.escalationId is required");
    const at = escalation.updatedAt ?? escalation.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "X402_ESCALATION_UPSERT", tenantId, escalationId, escalation: { ...escalation, tenantId, escalationId } }],
      audit
    });
    return store.x402Escalations.get(makeScopedKey({ tenantId, id: escalationId })) ?? null;
  };

  store.getX402Escalation = async function getX402Escalation({ tenantId = DEFAULT_TENANT_ID, escalationId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof escalationId !== "string" || escalationId.trim() === "") throw new TypeError("escalationId is required");
    return store.x402Escalations.get(makeScopedKey({ tenantId, id: escalationId.trim() })) ?? null;
  };

  store.listX402Escalations = async function listX402Escalations({
    tenantId = DEFAULT_TENANT_ID,
    gateId = null,
    agentId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (gateId !== null && (typeof gateId !== "string" || gateId.trim() === "")) throw new TypeError("gateId must be null or a non-empty string");
    if (agentId !== null && (typeof agentId !== "string" || agentId.trim() === "")) throw new TypeError("agentId must be null or a non-empty string");
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const normalizedGateId = gateId ? gateId.trim() : null;
    const normalizedAgentId = agentId ? agentId.trim() : null;
    const normalizedStatus = status ? status.trim().toLowerCase() : null;
    const out = [];
    for (const row of store.x402Escalations.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (normalizedGateId && String(row.gateId ?? "") !== normalizedGateId) continue;
      if (
        normalizedAgentId &&
        String(
          row.requesterAgentId ??
            row.payerAgentId ??
            null
        ).trim() !== normalizedAgentId
      ) {
        continue;
      }
      if (normalizedStatus && String(row.status ?? "").toLowerCase() !== normalizedStatus) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftMs = Number.isFinite(Date.parse(String(left?.updatedAt ?? ""))) ? Date.parse(String(left.updatedAt)) : Number.NaN;
      const rightMs = Number.isFinite(Date.parse(String(right?.updatedAt ?? ""))) ? Date.parse(String(right.updatedAt)) : Number.NaN;
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return rightMs - leftMs;
      return String(left?.escalationId ?? "").localeCompare(String(right?.escalationId ?? ""));
    });
    return out.slice(offset, offset + Math.min(1000, limit));
  };

  store.appendX402EscalationEvent = async function appendX402EscalationEvent({ tenantId = DEFAULT_TENANT_ID, event, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event is required");
    const eventId = typeof event.eventId === "string" ? event.eventId.trim() : "";
    const escalationId = typeof event.escalationId === "string" ? event.escalationId.trim() : "";
    if (!eventId) throw new TypeError("event.eventId is required");
    if (!escalationId) throw new TypeError("event.escalationId is required");
    const at = event.occurredAt ?? event.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "X402_ESCALATION_EVENT_APPEND", tenantId, eventId, escalationId, event: { ...event, tenantId, eventId, escalationId } }],
      audit
    });
    return store.x402EscalationEvents.get(makeScopedKey({ tenantId, id: eventId })) ?? null;
  };

  store.listX402EscalationEvents = async function listX402EscalationEvents({
    tenantId = DEFAULT_TENANT_ID,
    escalationId = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (escalationId !== null && (typeof escalationId !== "string" || escalationId.trim() === "")) {
      throw new TypeError("escalationId must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const normalizedEscalationId = escalationId ? escalationId.trim() : null;
    const out = [];
    for (const row of store.x402EscalationEvents.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (normalizedEscalationId && String(row.escalationId ?? "") !== normalizedEscalationId) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftMs = Number.isFinite(Date.parse(String(left?.occurredAt ?? ""))) ? Date.parse(String(left.occurredAt)) : Number.NaN;
      const rightMs = Number.isFinite(Date.parse(String(right?.occurredAt ?? ""))) ? Date.parse(String(right.occurredAt)) : Number.NaN;
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
      return String(left?.eventId ?? "").localeCompare(String(right?.eventId ?? ""));
    });
    return out.slice(offset, offset + Math.min(1000, limit));
  };

  store.putX402EscalationOverrideUsage = async function putX402EscalationOverrideUsage({ tenantId = DEFAULT_TENANT_ID, usage, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new TypeError("usage is required");
    const overrideId = typeof usage.overrideId === "string" ? usage.overrideId.trim() : "";
    if (!overrideId) throw new TypeError("usage.overrideId is required");
    const at = usage.usedAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "X402_ESCALATION_OVERRIDE_USAGE_PUT", tenantId, overrideId, usage: { ...usage, tenantId, overrideId } }],
      audit
    });
    return store.x402EscalationOverrideUsage.get(makeScopedKey({ tenantId, id: overrideId })) ?? null;
  };

  store.getX402EscalationOverrideUsage = async function getX402EscalationOverrideUsage({
    tenantId = DEFAULT_TENANT_ID,
    overrideId
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof overrideId !== "string" || overrideId.trim() === "") throw new TypeError("overrideId is required");
    return store.x402EscalationOverrideUsage.get(makeScopedKey({ tenantId, id: overrideId.trim() })) ?? null;
  };

  function x402ReceiptStoreKey({ tenantId, receiptId }) {
    const normalizedTenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const normalizedReceiptId = typeof receiptId === "string" ? receiptId.trim() : "";
    if (!normalizedReceiptId) throw new TypeError("receiptId is required");
    return makeScopedKey({ tenantId: normalizedTenantId, id: normalizedReceiptId });
  }

  function listX402ReversalEventsForReceiptSync({ tenantId = DEFAULT_TENANT_ID, receiptId } = {}) {
    const normalizedTenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const normalizedReceiptId = typeof receiptId === "string" ? receiptId.trim() : "";
    if (!normalizedReceiptId) return [];
    const out = [];
    for (const row of store.x402ReversalEvents.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== normalizedTenantId) continue;
      if (String(row.receiptId ?? "") !== normalizedReceiptId) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftMs = Number.isFinite(Date.parse(String(left?.occurredAt ?? ""))) ? Date.parse(String(left.occurredAt)) : Number.NaN;
      const rightMs = Number.isFinite(Date.parse(String(right?.occurredAt ?? ""))) ? Date.parse(String(right.occurredAt)) : Number.NaN;
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
      return String(left?.eventId ?? "").localeCompare(String(right?.eventId ?? ""));
    });
    return out;
  }

  function toX402ReceiptRecord({ tenantId, gate, settlement: settlementInput = null, includeReversalContext = true } = {}) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) return null;
    const runId = typeof gate.runId === "string" && gate.runId.trim() !== "" ? gate.runId.trim() : null;
    const settlement =
      settlementInput && typeof settlementInput === "object" && !Array.isArray(settlementInput)
        ? settlementInput
        : runId && store.agentRunSettlements instanceof Map
          ? store.agentRunSettlements.get(makeScopedKey({ tenantId, id: runId })) ?? null
          : null;
    const decisionTrace =
      settlement?.decisionTrace && typeof settlement.decisionTrace === "object" && !Array.isArray(settlement.decisionTrace)
        ? settlement.decisionTrace
        : gate.decisionTrace && typeof gate.decisionTrace === "object" && !Array.isArray(gate.decisionTrace)
          ? gate.decisionTrace
          : null;
    const settlementReceipt =
      decisionTrace?.settlementReceipt && typeof decisionTrace.settlementReceipt === "object" && !Array.isArray(decisionTrace.settlementReceipt)
        ? decisionTrace.settlementReceipt
        : null;
    if (!settlementReceipt) return null;
    const receiptId = typeof settlementReceipt.receiptId === "string" ? settlementReceipt.receiptId.trim() : "";
    if (!receiptId) return null;
    const bindings =
      decisionTrace?.bindings && typeof decisionTrace.bindings === "object" && !Array.isArray(decisionTrace.bindings)
        ? decisionTrace.bindings
        : null;
    const verificationContext =
      gate?.verificationContext && typeof gate.verificationContext === "object" && !Array.isArray(gate.verificationContext)
        ? gate.verificationContext
        : gate?.decision?.verificationContext &&
            typeof gate.decision.verificationContext === "object" &&
            !Array.isArray(gate.decision.verificationContext)
          ? gate.decision.verificationContext
          : null;
    const sponsorRef =
      typeof bindings?.spendAuthorization?.sponsorRef === "string" && bindings.spendAuthorization.sponsorRef.trim() !== ""
        ? bindings.spendAuthorization.sponsorRef.trim()
        : null;
    const sponsorWalletRef =
      typeof bindings?.spendAuthorization?.sponsorWalletRef === "string" && bindings.spendAuthorization.sponsorWalletRef.trim() !== ""
        ? bindings.spendAuthorization.sponsorWalletRef.trim()
        : null;
    const agentKeyId =
      typeof bindings?.spendAuthorization?.agentKeyId === "string" && bindings.spendAuthorization.agentKeyId.trim() !== ""
        ? bindings.spendAuthorization.agentKeyId.trim()
        : null;
    const settledAt =
      typeof settlementReceipt.settledAt === "string" && settlementReceipt.settledAt.trim() !== ""
        ? settlementReceipt.settledAt.trim()
        : typeof gate.resolvedAt === "string" && gate.resolvedAt.trim() !== ""
          ? gate.resolvedAt.trim()
          : null;
    const base = {
      schemaVersion: "X402ReceiptRecord.v1",
      tenantId,
      receiptId,
      gateId: typeof gate.gateId === "string" ? gate.gateId : null,
      runId,
      payerAgentId: typeof gate.payerAgentId === "string" ? gate.payerAgentId : null,
      providerId: typeof gate.payeeAgentId === "string" ? gate.payeeAgentId : null,
      toolId:
        typeof gate.toolId === "string" && gate.toolId.trim() !== ""
          ? gate.toolId.trim()
          : typeof gate?.quote?.toolId === "string" && gate.quote.toolId.trim() !== ""
            ? gate.quote.toolId.trim()
            : null,
      sponsorRef,
      sponsorWalletRef,
      agentKeyId,
      settlementState:
        typeof settlementReceipt.status === "string" && settlementReceipt.status.trim() !== ""
          ? settlementReceipt.status.trim().toLowerCase()
          : typeof settlement?.status === "string" && settlement.status.trim() !== ""
            ? settlement.status.trim().toLowerCase()
            : null,
      verificationStatus:
        typeof decisionTrace?.verificationStatus === "string" && decisionTrace.verificationStatus.trim() !== ""
          ? decisionTrace.verificationStatus.trim().toLowerCase()
          : null,
      settledAt,
      createdAt:
        typeof settlementReceipt.createdAt === "string" && settlementReceipt.createdAt.trim() !== ""
          ? settlementReceipt.createdAt.trim()
          : null,
      updatedAt:
        typeof gate.updatedAt === "string" && gate.updatedAt.trim() !== ""
          ? gate.updatedAt.trim()
          : typeof settledAt === "string"
            ? settledAt
            : null,
      evidenceRefs: Array.isArray(gate.evidenceRefs) ? gate.evidenceRefs.slice() : [],
      verificationContext,
      bindings,
      providerSignature:
        gate?.providerSignature && typeof gate.providerSignature === "object" && !Array.isArray(gate.providerSignature)
          ? gate.providerSignature
          : null,
      providerQuoteSignature:
        gate?.providerQuoteSignature && typeof gate.providerQuoteSignature === "object" && !Array.isArray(gate.providerQuoteSignature)
          ? gate.providerQuoteSignature
          : null,
      providerQuotePayload:
        gate?.providerQuotePayload && typeof gate.providerQuotePayload === "object" && !Array.isArray(gate.providerQuotePayload)
          ? gate.providerQuotePayload
          : null,
      zkProof:
        gate?.zkProof && typeof gate.zkProof === "object" && !Array.isArray(gate.zkProof)
          ? gate.zkProof
          : null,
      decisionRecord:
        decisionTrace?.decisionRecord && typeof decisionTrace.decisionRecord === "object" && !Array.isArray(decisionTrace.decisionRecord)
          ? decisionTrace.decisionRecord
          : null,
      settlementReceipt
    };
    if (!includeReversalContext) return base;
    return {
      ...base,
      reversal:
        gate?.reversal && typeof gate.reversal === "object" && !Array.isArray(gate.reversal)
          ? gate.reversal
          : null,
      reversalEvents: listX402ReversalEventsForReceiptSync({ tenantId, receiptId })
    };
  }

  function normalizeX402ReceiptRecordForStorage({ receipt } = {}) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
    const stableUpdatedAt =
      typeof receipt.createdAt === "string" && receipt.createdAt.trim() !== ""
        ? receipt.createdAt
        : typeof receipt.settledAt === "string" && receipt.settledAt.trim() !== ""
          ? receipt.settledAt
          : typeof receipt.updatedAt === "string" && receipt.updatedAt.trim() !== ""
            ? receipt.updatedAt
            : new Date().toISOString();
    const normalized = {
      ...receipt,
      reversal: null,
      reversalEvents: [],
      updatedAt: stableUpdatedAt
    };
    return normalized;
  }

  function projectX402ReceiptRecord({ tenantId, receipt } = {}) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
    const receiptId = typeof receipt.receiptId === "string" ? receipt.receiptId.trim() : "";
    if (!receiptId) return null;
    const gateId = typeof receipt.gateId === "string" ? receipt.gateId.trim() : "";
    const gate =
      gateId && store.x402Gates instanceof Map
        ? store.x402Gates.get(makeScopedKey({ tenantId, id: gateId })) ?? null
        : null;
    const reversalEvents = listX402ReversalEventsForReceiptSync({ tenantId, receiptId });
    const latestEvent = reversalEvents.length > 0 ? reversalEvents[reversalEvents.length - 1] : null;
    const derivedState =
      typeof latestEvent?.settlementStatusAfter === "string" && latestEvent.settlementStatusAfter.trim() !== ""
        ? latestEvent.settlementStatusAfter.trim().toLowerCase()
        : null;
    const updatedAtCandidates = [receipt.updatedAt, latestEvent?.occurredAt]
      .map((value) => (typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null))
      .filter(Boolean);
    const updatedAt = updatedAtCandidates.length > 0 ? updatedAtCandidates.sort((a, b) => Date.parse(a) - Date.parse(b))[updatedAtCandidates.length - 1] : null;
    return {
      ...receipt,
      settlementState: derivedState ?? receipt.settlementState ?? null,
      updatedAt: updatedAt ?? receipt.updatedAt ?? null,
      reversal:
        gate?.reversal && typeof gate.reversal === "object" && !Array.isArray(gate.reversal)
          ? gate.reversal
          : receipt?.reversal && typeof receipt.reversal === "object" && !Array.isArray(receipt.reversal)
            ? receipt.reversal
            : null,
      reversalEvents
    };
  }

  function compareX402ReceiptRecords(left, right) {
    const leftMs = Number.isFinite(Date.parse(String(left?.settledAt ?? ""))) ? Date.parse(String(left.settledAt)) : Number.NaN;
    const rightMs = Number.isFinite(Date.parse(String(right?.settledAt ?? ""))) ? Date.parse(String(right.settledAt)) : Number.NaN;
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return rightMs - leftMs;
    return String(left?.receiptId ?? "").localeCompare(String(right?.receiptId ?? ""));
  }

  function encodeX402ReceiptCursor(record) {
    const settledAt = typeof record?.settledAt === "string" && record.settledAt.trim() !== "" ? new Date(Date.parse(record.settledAt)).toISOString() : null;
    const receiptId = typeof record?.receiptId === "string" && record.receiptId.trim() !== "" ? record.receiptId.trim() : null;
    if (!settledAt || !receiptId) return null;
    return Buffer.from(JSON.stringify({ settledAt, receiptId }), "utf8").toString("base64url");
  }

  function decodeX402ReceiptCursor(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === "") return null;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(String(raw).trim(), "base64url").toString("utf8"));
    } catch {
      throw new TypeError("cursor must be base64url-encoded JSON");
    }
    const settledAt = typeof parsed?.settledAt === "string" && Number.isFinite(Date.parse(parsed.settledAt)) ? new Date(Date.parse(parsed.settledAt)).toISOString() : null;
    const receiptId = typeof parsed?.receiptId === "string" && parsed.receiptId.trim() !== "" ? parsed.receiptId.trim() : null;
    if (!settledAt || !receiptId) throw new TypeError("cursor is invalid");
    return { settledAt, receiptId };
  }

  function isReceiptAfterCursor(record, cursor) {
    if (!cursor) return true;
    const recordMs = Number.isFinite(Date.parse(String(record?.settledAt ?? ""))) ? Date.parse(String(record.settledAt)) : Number.NaN;
    const cursorMs = Date.parse(cursor.settledAt);
    if (!Number.isFinite(recordMs)) return false;
    if (recordMs < cursorMs) return true;
    if (recordMs > cursorMs) return false;
    return String(record?.receiptId ?? "") > String(cursor.receiptId ?? "");
  }

  function listX402ReceiptCandidates({ tenantId }) {
    const byReceiptId = new Map();
    if (store.x402Receipts instanceof Map) {
      for (const row of store.x402Receipts.values()) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        const receiptId = typeof row.receiptId === "string" ? row.receiptId.trim() : "";
        if (!receiptId) continue;
        byReceiptId.set(receiptId, projectX402ReceiptRecord({ tenantId, receipt: row }));
      }
    }
    if (byReceiptId.size === 0 && store.x402Gates instanceof Map) {
      for (const gate of store.x402Gates.values()) {
        if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
        if (normalizeTenantId(gate.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        const derived = toX402ReceiptRecord({ tenantId, gate, includeReversalContext: true });
        if (!derived) continue;
        const receiptId = typeof derived.receiptId === "string" ? derived.receiptId.trim() : "";
        if (!receiptId) continue;
        byReceiptId.set(receiptId, derived);
      }
    }
    return Array.from(byReceiptId.values()).filter(Boolean);
  }

  store.deriveX402ReceiptRecord = function deriveX402ReceiptRecord({
    tenantId = DEFAULT_TENANT_ID,
    gate,
    settlement = null,
    includeReversalContext = false
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    const derived = toX402ReceiptRecord({ tenantId, gate, settlement, includeReversalContext });
    return normalizeX402ReceiptRecordForStorage({ receipt: derived });
  };

  store.putX402Receipt = async function putX402Receipt({ tenantId = DEFAULT_TENANT_ID, receipt, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    const normalized = normalizeX402ReceiptRecordForStorage({ receipt });
    if (!normalized) throw new TypeError("receipt is required");
    const receiptId = typeof normalized.receiptId === "string" ? normalized.receiptId.trim() : "";
    if (!receiptId) throw new TypeError("receipt.receiptId is required");
    const key = x402ReceiptStoreKey({ tenantId, receiptId });
    const at =
      typeof normalized.updatedAt === "string" && normalized.updatedAt.trim() !== ""
        ? normalized.updatedAt
        : typeof normalized.createdAt === "string" && normalized.createdAt.trim() !== ""
          ? normalized.createdAt
          : new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "X402_RECEIPT_PUT", tenantId, receiptId, receipt: { ...normalized, tenantId, receiptId } }],
      audit
    });
    return store.x402Receipts.get(key) ?? null;
  };

  store.getX402Receipt = async function getX402Receipt({ tenantId = DEFAULT_TENANT_ID, receiptId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof receiptId !== "string" || receiptId.trim() === "") throw new TypeError("receiptId is required");
    const wanted = receiptId.trim();
    const key = x402ReceiptStoreKey({ tenantId, receiptId: wanted });
    const stored = store.x402Receipts instanceof Map ? store.x402Receipts.get(key) ?? null : null;
    if (stored) return projectX402ReceiptRecord({ tenantId, receipt: stored });
    for (const gate of store.x402Gates.values()) {
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
      if (normalizeTenantId(gate.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      const receipt = toX402ReceiptRecord({ tenantId, gate, includeReversalContext: true });
      if (!receipt) continue;
      if (String(receipt.receiptId ?? "") === wanted) return receipt;
    }
    return null;
  };

  store.listX402ReceiptsPage = async function listX402ReceiptsPage({
    tenantId = DEFAULT_TENANT_ID,
    agentId = null,
    sponsorId = null,
    sponsorWalletRef = null,
    toolId = null,
    state = null,
    from = null,
    to = null,
    limit = 200,
    offset = 0,
    cursor = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (agentId !== null && (typeof agentId !== "string" || agentId.trim() === "")) throw new TypeError("agentId must be null or a non-empty string");
    if (sponsorId !== null && (typeof sponsorId !== "string" || sponsorId.trim() === "")) throw new TypeError("sponsorId must be null or a non-empty string");
    if (sponsorWalletRef !== null && (typeof sponsorWalletRef !== "string" || sponsorWalletRef.trim() === "")) {
      throw new TypeError("sponsorWalletRef must be null or a non-empty string");
    }
    if (toolId !== null && (typeof toolId !== "string" || toolId.trim() === "")) throw new TypeError("toolId must be null or a non-empty string");
    if (state !== null && (typeof state !== "string" || state.trim() === "")) throw new TypeError("state must be null or a non-empty string");
    if (from !== null && !Number.isFinite(Date.parse(String(from)))) throw new TypeError("from must be null or an ISO date-time");
    if (to !== null && !Number.isFinite(Date.parse(String(to)))) throw new TypeError("to must be null or an ISO date-time");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const normalizedAgentId = agentId ? agentId.trim() : null;
    const normalizedSponsorId = sponsorId ? sponsorId.trim() : null;
    const normalizedSponsorWalletRef = sponsorWalletRef ? sponsorWalletRef.trim() : null;
    const normalizedToolId = toolId ? toolId.trim() : null;
    const normalizedState = state ? state.trim().toLowerCase() : null;
    const fromMs = from ? Date.parse(String(from)) : null;
    const toMs = to ? Date.parse(String(to)) : null;
    const decodedCursor = cursor === null ? null : decodeX402ReceiptCursor(cursor);

    const all = listX402ReceiptCandidates({ tenantId });
    const filtered = all.filter((receipt) => {
      if (!receipt) return false;
      if (
        normalizedAgentId &&
        String(receipt.payerAgentId ?? "") !== normalizedAgentId &&
        String(receipt.providerId ?? "") !== normalizedAgentId &&
        String(receipt.agentKeyId ?? "") !== normalizedAgentId
      ) {
        return false;
      }
      if (normalizedSponsorId && String(receipt.sponsorRef ?? "") !== normalizedSponsorId) return false;
      if (normalizedSponsorWalletRef && String(receipt.sponsorWalletRef ?? "") !== normalizedSponsorWalletRef) return false;
      if (normalizedToolId && String(receipt.toolId ?? "") !== normalizedToolId) return false;
      if (normalizedState && String(receipt.settlementState ?? "").toLowerCase() !== normalizedState) return false;
      const settledAtMs = Number.isFinite(Date.parse(String(receipt.settledAt ?? ""))) ? Date.parse(String(receipt.settledAt)) : Number.NaN;
      if (fromMs !== null && (!Number.isFinite(settledAtMs) || settledAtMs < fromMs)) return false;
      if (toMs !== null && (!Number.isFinite(settledAtMs) || settledAtMs > toMs)) return false;
      return true;
    });

    filtered.sort(compareX402ReceiptRecords);
    const cursorFiltered = decodedCursor ? filtered.filter((row) => isReceiptAfterCursor(row, decodedCursor)) : filtered;
    const paged = cursorFiltered.slice(offset, offset + Math.min(1000, limit));
    const hasMore = cursorFiltered.length > offset + paged.length;
    const nextCursor = hasMore && paged.length > 0 ? encodeX402ReceiptCursor(paged[paged.length - 1]) : null;
    return { receipts: paged, nextCursor };
  };

  store.listX402Receipts = async function listX402Receipts(args = {}) {
    const page = await store.listX402ReceiptsPage(args);
    return page.receipts;
  };

  store.listArbitrationCases = async function listArbitrationCases({
    tenantId = DEFAULT_TENANT_ID,
    runId = null,
    disputeId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (runId !== null && (typeof runId !== "string" || runId.trim() === "")) throw new TypeError("runId must be null or a non-empty string");
    if (disputeId !== null && (typeof disputeId !== "string" || disputeId.trim() === "")) throw new TypeError("disputeId must be null or a non-empty string");
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const statusFilter = status ? String(status).trim().toLowerCase() : null;
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.arbitrationCases.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (runId !== null && String(row.runId ?? "") !== String(runId)) continue;
      if (disputeId !== null && String(row.disputeId ?? "") !== String(disputeId)) continue;
      if (statusFilter !== null && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
      out.push(row);
    }
    out.sort((left, right) => String(left.caseId ?? "").localeCompare(String(right.caseId ?? "")));
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  function assertNonEmptyString(value, name) {
    if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
    return value.trim();
  }

  function normalizeOptionalIso(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (!Number.isFinite(Date.parse(text))) throw new TypeError("invalid ISO date-time");
    return new Date(text).toISOString();
  }

  function moneyRailOperationStoreKey({ tenantId, providerId, operationId }) {
    return `${normalizeTenantId(tenantId)}\n${assertNonEmptyString(providerId, "providerId")}\n${assertNonEmptyString(operationId, "operationId")}`;
  }

  function moneyRailProviderEventStoreKey({ tenantId, providerId, operationId, eventType, eventDedupeKey }) {
    return `${normalizeTenantId(tenantId)}\n${assertNonEmptyString(providerId, "providerId")}\n${assertNonEmptyString(operationId, "operationId")}\n${assertNonEmptyString(eventType, "eventType")}\n${assertNonEmptyString(eventDedupeKey, "eventDedupeKey")}`;
  }

  function billableUsageEventStoreKey({ tenantId, eventKey }) {
    return `${normalizeTenantId(tenantId)}\n${assertNonEmptyString(eventKey, "eventKey")}`;
  }

  function financeReconciliationTriageStoreKey({ tenantId, triageKey }) {
    return `${normalizeTenantId(tenantId)}\n${assertNonEmptyString(triageKey, "triageKey")}`;
  }

  function marketplaceProviderPublicationStoreKey({ tenantId, providerRef }) {
    return `${normalizeTenantId(tenantId)}\n${assertNonEmptyString(providerRef, "providerRef")}`;
  }

  function marketplaceCapabilityListingStoreKey({ tenantId, listingId }) {
    return `${normalizeTenantId(tenantId)}\n${assertNonEmptyString(listingId, "listingId")}`;
  }

  store.getMoneyRailOperation = async function getMoneyRailOperation({ tenantId = DEFAULT_TENANT_ID, providerId, operationId } = {}) {
    const key = moneyRailOperationStoreKey({ tenantId, providerId, operationId });
    return store.moneyRailOperations.get(key) ?? null;
  };

  store.findMoneyRailOperationByIdempotency = async function findMoneyRailOperationByIdempotency({
    tenantId = DEFAULT_TENANT_ID,
    providerId,
    direction,
    idempotencyKey
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    providerId = assertNonEmptyString(providerId, "providerId");
    direction = assertNonEmptyString(direction, "direction").toLowerCase();
    idempotencyKey = assertNonEmptyString(idempotencyKey, "idempotencyKey");
    for (const operation of store.moneyRailOperations.values()) {
      if (!operation || typeof operation !== "object") continue;
      if (normalizeTenantId(operation.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(operation.providerId ?? "") !== providerId) continue;
      if (String(operation.direction ?? "").toLowerCase() !== direction) continue;
      if (String(operation.idempotencyKey ?? "") !== idempotencyKey) continue;
      return operation;
    }
    return null;
  };

  store.listMoneyRailOperations = async function listMoneyRailOperations({
    tenantId = DEFAULT_TENANT_ID,
    providerId = null,
    direction = null,
    state = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (providerId !== null) providerId = assertNonEmptyString(providerId, "providerId");
    if (direction !== null) direction = assertNonEmptyString(direction, "direction").toLowerCase();
    if (state !== null) state = assertNonEmptyString(state, "state").toLowerCase();
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const out = [];
    for (const operation of store.moneyRailOperations.values()) {
      if (!operation || typeof operation !== "object") continue;
      if (normalizeTenantId(operation.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (providerId !== null && String(operation.providerId ?? "") !== providerId) continue;
      if (direction !== null && String(operation.direction ?? "").toLowerCase() !== direction) continue;
      if (state !== null && String(operation.state ?? "").toLowerCase() !== state) continue;
      out.push(operation);
    }
    out.sort((left, right) => String(left.operationId ?? "").localeCompare(String(right.operationId ?? "")));
    return out.slice(offset, offset + Math.min(1000, limit));
  };

  store.putMoneyRailOperation = async function putMoneyRailOperation({
    tenantId = DEFAULT_TENANT_ID,
    providerId,
    operation,
    requestHash = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    providerId = assertNonEmptyString(providerId, "providerId");
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new TypeError("operation is required");
    const operationId = assertNonEmptyString(operation.operationId ?? null, "operation.operationId");
    const direction = assertNonEmptyString(operation.direction ?? null, "operation.direction").toLowerCase();
    const idempotencyKey = assertNonEmptyString(operation.idempotencyKey ?? null, "operation.idempotencyKey");
    const opKey = moneyRailOperationStoreKey({ tenantId, providerId, operationId });

    for (const existing of store.moneyRailOperations.values()) {
      if (!existing || typeof existing !== "object") continue;
      if (normalizeTenantId(existing.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(existing.providerId ?? "") !== providerId) continue;
      if (String(existing.direction ?? "").toLowerCase() !== direction) continue;
      if (String(existing.idempotencyKey ?? "") !== idempotencyKey) continue;
      if (String(existing.operationId ?? "") !== operationId) {
        const err = new Error("idempotency key was already used with a different operation");
        err.code = "MONEY_RAIL_IDEMPOTENCY_CONFLICT";
        throw err;
      }
    }

    const existingById = store.moneyRailOperations.get(opKey) ?? null;
    if (existingById && requestHash && existingById.requestHash && String(existingById.requestHash) !== String(requestHash)) {
      const err = new Error("operationId already exists with a different request");
      err.code = "MONEY_RAIL_OPERATION_CONFLICT";
      throw err;
    }
    const next = {
      ...operation,
      tenantId,
      providerId,
      operationId,
      direction,
      idempotencyKey,
      requestHash:
        requestHash && String(requestHash).trim() !== ""
          ? String(requestHash)
          : existingById?.requestHash && String(existingById.requestHash).trim() !== ""
            ? String(existingById.requestHash)
            : null
    };
    store.moneyRailOperations.set(opKey, next);
    return { operation: next, created: !existingById };
  };

  store.getMoneyRailProviderEvent = async function getMoneyRailProviderEvent({
    tenantId = DEFAULT_TENANT_ID,
    providerId,
    operationId,
    eventType,
    eventDedupeKey
  } = {}) {
    const key = moneyRailProviderEventStoreKey({ tenantId, providerId, operationId, eventType, eventDedupeKey });
    return store.moneyRailProviderEvents.get(key) ?? null;
  };

  store.putMoneyRailProviderEvent = async function putMoneyRailProviderEvent({
    tenantId = DEFAULT_TENANT_ID,
    providerId,
    operationId,
    event
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    providerId = assertNonEmptyString(providerId, "providerId");
    operationId = assertNonEmptyString(operationId, "operationId");
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event is required");
    const eventType = assertNonEmptyString(event.eventType ?? null, "event.eventType").toLowerCase();
    const eventDedupeKey = assertNonEmptyString(event.eventDedupeKey ?? null, "event.eventDedupeKey");
    const key = moneyRailProviderEventStoreKey({ tenantId, providerId, operationId, eventType, eventDedupeKey });
    const existing = store.moneyRailProviderEvents.get(key) ?? null;
    if (existing) return { event: existing, created: false };

    const normalizedEvent = {
      ...event,
      tenantId,
      providerId,
      operationId,
      eventType,
      eventDedupeKey
    };
    store.moneyRailProviderEvents.set(key, normalizedEvent);
    return { event: normalizedEvent, created: true };
  };

  store.appendBillableUsageEvent = async function appendBillableUsageEvent({ tenantId = DEFAULT_TENANT_ID, event } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event is required");
    const eventKey = assertNonEmptyString(event.eventKey ?? null, "event.eventKey");
    const eventType = assertNonEmptyString(event.eventType ?? null, "event.eventType").toLowerCase();
    const occurredAt = normalizeOptionalIso(event.occurredAt ?? event.createdAt ?? new Date().toISOString());
    const period =
      typeof event.period === "string" && /^\d{4}-\d{2}$/.test(event.period.trim())
        ? event.period.trim()
        : String((occurredAt ?? new Date().toISOString()).slice(0, 7));
    const key = billableUsageEventStoreKey({ tenantId, eventKey });
    const existing = store.billableUsageEvents.get(key) ?? null;
    if (existing) {
      if (event.eventHash && existing.eventHash && String(event.eventHash) !== String(existing.eventHash)) {
        const err = new Error("billable usage event key already exists with different immutable fields");
        err.code = "BILLABLE_USAGE_EVENT_CONFLICT";
        throw err;
      }
      return { event: existing, appended: false };
    }

    const quantityRaw = Number(event.quantity ?? 1);
    const quantity = Number.isSafeInteger(quantityRaw) && quantityRaw >= 0 ? quantityRaw : 1;
    const amountRaw = event.amountCents === null || event.amountCents === undefined ? null : Number(event.amountCents);
    const amountCents = amountRaw === null ? null : Number.isSafeInteger(amountRaw) ? amountRaw : null;
    const normalized = {
      ...event,
      schemaVersion: event.schemaVersion ?? "BillableUsageEvent.v1",
      tenantId,
      eventKey,
      eventType,
      period,
      occurredAt: occurredAt ?? new Date().toISOString(),
      quantity,
      amountCents,
      currency:
        event.currency === null || event.currency === undefined || String(event.currency).trim() === ""
          ? null
          : String(event.currency).trim().toUpperCase(),
      createdAt: normalizeOptionalIso(event.createdAt) ?? new Date().toISOString()
    };
    store.billableUsageEvents.set(key, normalized);
    return { event: normalized, appended: true };
  };

  store.listBillableUsageEvents = async function listBillableUsageEvents({
    tenantId = DEFAULT_TENANT_ID,
    period = null,
    eventType = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (period !== null && (typeof period !== "string" || !/^\d{4}-\d{2}$/.test(period.trim()))) {
      throw new TypeError("period must match YYYY-MM");
    }
    if (eventType !== null) eventType = assertNonEmptyString(eventType, "eventType").toLowerCase();
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const normalizedPeriod = period ? period.trim() : null;
    const out = [];
    for (const row of store.billableUsageEvents.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (normalizedPeriod !== null && String(row.period ?? "") !== normalizedPeriod) continue;
      if (eventType !== null && String(row.eventType ?? "").toLowerCase() !== eventType) continue;
      out.push(row);
    }
    out.sort(
      (left, right) =>
        String(left.occurredAt ?? "").localeCompare(String(right.occurredAt ?? "")) ||
        String(left.eventKey ?? "").localeCompare(String(right.eventKey ?? ""))
    );
    return out.slice(offset, offset + Math.min(1000, limit));
  };

  store.getFinanceReconciliationTriage = async function getFinanceReconciliationTriage({
    tenantId = DEFAULT_TENANT_ID,
    triageKey
  } = {}) {
    const key = financeReconciliationTriageStoreKey({ tenantId, triageKey });
    return store.financeReconciliationTriages.get(key) ?? null;
  };

  store.putFinanceReconciliationTriage = async function putFinanceReconciliationTriage({
    tenantId = DEFAULT_TENANT_ID,
    triage,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!triage || typeof triage !== "object" || Array.isArray(triage)) throw new TypeError("triage is required");
    const triageKey = assertNonEmptyString(triage.triageKey ?? null, "triage.triageKey");
    const sourceType = assertNonEmptyString(triage.sourceType ?? null, "triage.sourceType").toLowerCase();
    const mismatchType = assertNonEmptyString(triage.mismatchType ?? null, "triage.mismatchType");
    const mismatchKey = assertNonEmptyString(triage.mismatchKey ?? null, "triage.mismatchKey");
    const period = assertNonEmptyString(triage.period ?? null, "triage.period");
    const status = assertNonEmptyString(triage.status ?? null, "triage.status").toLowerCase();
    if (!/^\d{4}-\d{2}$/.test(period)) throw new TypeError("triage.period must match YYYY-MM");
    const key = financeReconciliationTriageStoreKey({ tenantId, triageKey });
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const existing = store.financeReconciliationTriages.get(key) ?? null;
    const normalized = {
      schemaVersion: triage.schemaVersion ?? "FinanceReconciliationTriage.v1",
      tenantId,
      triageKey,
      sourceType,
      period,
      providerId:
        triage.providerId === null || triage.providerId === undefined || String(triage.providerId).trim() === ""
          ? null
          : String(triage.providerId).trim(),
      mismatchType,
      mismatchKey,
      mismatchCode:
        triage.mismatchCode === null || triage.mismatchCode === undefined || String(triage.mismatchCode).trim() === ""
          ? null
          : String(triage.mismatchCode).trim(),
      severity:
        triage.severity === null || triage.severity === undefined || String(triage.severity).trim() === ""
          ? null
          : String(triage.severity).trim().toLowerCase(),
      status,
      ownerPrincipalId:
        triage.ownerPrincipalId === null || triage.ownerPrincipalId === undefined || String(triage.ownerPrincipalId).trim() === ""
          ? null
          : String(triage.ownerPrincipalId).trim(),
      notes:
        triage.notes === null || triage.notes === undefined || String(triage.notes).trim() === ""
          ? null
          : String(triage.notes).trim(),
      sourceReportHash:
        triage.sourceReportHash === null || triage.sourceReportHash === undefined || String(triage.sourceReportHash).trim() === ""
          ? null
          : String(triage.sourceReportHash).trim(),
      metadata:
        triage.metadata && typeof triage.metadata === "object" && !Array.isArray(triage.metadata)
          ? { ...triage.metadata }
          : null,
      actionLog: Array.isArray(triage.actionLog) ? triage.actionLog.slice(0, 50) : existing?.actionLog ?? [],
      revision:
        Number.isSafeInteger(triage.revision) && triage.revision > 0
          ? Number(triage.revision)
          : Number(existing?.revision ?? 0) + 1,
      createdAt: normalizeOptionalIso(triage.createdAt) ?? existing?.createdAt ?? nowAt,
      updatedAt: normalizeOptionalIso(triage.updatedAt) ?? nowAt,
      resolvedAt: normalizeOptionalIso(triage.resolvedAt) ?? null,
      resolvedByPrincipalId:
        triage.resolvedByPrincipalId === null || triage.resolvedByPrincipalId === undefined || String(triage.resolvedByPrincipalId).trim() === ""
          ? null
          : String(triage.resolvedByPrincipalId).trim()
    };
    store.financeReconciliationTriages.set(key, normalized);
    if (audit && typeof store.appendOpsAudit === "function") {
      await store.appendOpsAudit({ tenantId, audit });
    }
    return normalized;
  };

  store.listFinanceReconciliationTriages = async function listFinanceReconciliationTriages({
    tenantId = DEFAULT_TENANT_ID,
    period = null,
    status = null,
    sourceType = null,
    providerId = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (period !== null && (typeof period !== "string" || !/^\d{4}-\d{2}$/.test(period.trim()))) {
      throw new TypeError("period must match YYYY-MM");
    }
    if (status !== null) status = assertNonEmptyString(status, "status").toLowerCase();
    if (sourceType !== null) sourceType = assertNonEmptyString(sourceType, "sourceType").toLowerCase();
    if (providerId !== null) providerId = assertNonEmptyString(providerId, "providerId");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const out = [];
    const normalizedPeriod = period ? period.trim() : null;
    for (const triage of store.financeReconciliationTriages.values()) {
      if (!triage || typeof triage !== "object") continue;
      if (normalizeTenantId(triage.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (normalizedPeriod !== null && String(triage.period ?? "") !== normalizedPeriod) continue;
      if (status !== null && String(triage.status ?? "").toLowerCase() !== status) continue;
      if (sourceType !== null && String(triage.sourceType ?? "").toLowerCase() !== sourceType) continue;
      if (providerId !== null && String(triage.providerId ?? "") !== providerId) continue;
      out.push(triage);
    }
    out.sort((left, right) => {
      const leftMs = Date.parse(String(left?.updatedAt ?? left?.createdAt ?? ""));
      const rightMs = Date.parse(String(right?.updatedAt ?? right?.createdAt ?? ""));
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && rightMs !== leftMs) return rightMs - leftMs;
      return String(left?.triageKey ?? "").localeCompare(String(right?.triageKey ?? ""));
    });
    return out.slice(offset, offset + Math.min(1000, limit));
  };

  store.getMarketplaceProviderPublication = async function getMarketplaceProviderPublication({
    tenantId = DEFAULT_TENANT_ID,
    providerId = null,
    providerRef = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!(store.marketplaceProviderPublications instanceof Map)) return null;
    const normalizedProviderRef =
      providerRef === null || providerRef === undefined || String(providerRef).trim() === "" ? null : String(providerRef).trim();
    if (normalizedProviderRef) {
      const byRef = store.marketplaceProviderPublications.get(
        marketplaceProviderPublicationStoreKey({ tenantId, providerRef: normalizedProviderRef })
      );
      if (byRef) return byRef;
    }

    const normalizedProviderId =
      providerId === null || providerId === undefined || String(providerId).trim() === "" ? null : String(providerId).trim();
    if (!normalizedProviderId) return null;

    const byScopedId = store.marketplaceProviderPublications.get(
      marketplaceProviderPublicationStoreKey({ tenantId, providerRef: normalizedProviderId })
    );
    if (byScopedId) return byScopedId;

    let found = null;
    for (const row of store.marketplaceProviderPublications.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(row.providerId ?? "").trim() !== normalizedProviderId) continue;
      if (!found) {
        found = row;
        continue;
      }
      const foundAt = Date.parse(String(found.updatedAt ?? found.publishedAt ?? ""));
      const rowAt = Date.parse(String(row.updatedAt ?? row.publishedAt ?? ""));
      if (Number.isFinite(rowAt) && (!Number.isFinite(foundAt) || rowAt > foundAt)) {
        found = row;
      }
    }
    return found;
  };

  store.listMarketplaceProviderPublications = async function listMarketplaceProviderPublications({
    tenantId = DEFAULT_TENANT_ID,
    status = "certified",
    providerId = null,
    providerRef = null,
    search = null,
    toolId = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!(store.marketplaceProviderPublications instanceof Map)) return [];

    const statusFilter = status === null || status === undefined ? "certified" : String(status).trim().toLowerCase() || "certified";
    const providerFilter =
      providerId === null || providerId === undefined || String(providerId).trim() === "" ? null : String(providerId).trim();
    const providerRefFilter =
      providerRef === null || providerRef === undefined || String(providerRef).trim() === "" ? null : String(providerRef).trim();
    const searchFilter = search === null || search === undefined || String(search).trim() === "" ? null : String(search).trim().toLowerCase();
    const toolFilter = toolId === null || toolId === undefined || String(toolId).trim() === "" ? null : String(toolId).trim();

    const out = [];
    for (const row of store.marketplaceProviderPublications.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      const rowStatus = String(row.status ?? "draft").toLowerCase();
      if (statusFilter !== "all" && rowStatus !== statusFilter) continue;
      if (providerFilter && String(row.providerId ?? "") !== providerFilter && String(row.providerRef ?? "") !== providerFilter) continue;
      if (providerRefFilter && String(row.providerRef ?? "") !== providerRefFilter) continue;
      if (toolFilter) {
        const tools = Array.isArray(row?.manifest?.tools) ? row.manifest.tools : [];
        const hasTool = tools.some((tool) => String(tool?.toolId ?? "") === toolFilter);
        if (!hasTool) continue;
      }
      if (searchFilter) {
        const tools = Array.isArray(row?.manifest?.tools) ? row.manifest.tools : [];
        const haystack = [
          row.providerId,
          row.providerRef,
          row.description,
          row.baseUrl,
          row.status,
          ...(Array.isArray(row.tags) ? row.tags : []),
          ...tools.map((tool) => `${tool?.toolId ?? ""} ${tool?.mcpToolName ?? ""} ${tool?.description ?? ""}`)
        ]
          .map((value) => String(value ?? "").toLowerCase())
          .join(" ");
        if (!haystack.includes(searchFilter)) continue;
      }
      out.push(row);
    }

    out.sort((left, right) => {
      const leftAt = Date.parse(String(left.updatedAt ?? left.publishedAt ?? ""));
      const rightAt = Date.parse(String(right.updatedAt ?? right.publishedAt ?? ""));
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && rightAt !== leftAt) return rightAt - leftAt;
      const providerIdOrder = String(left.providerId ?? "").localeCompare(String(right.providerId ?? ""));
      if (providerIdOrder !== 0) return providerIdOrder;
      return String(left.providerRef ?? "").localeCompare(String(right.providerRef ?? ""));
    });
    return out;
  };

  store.getMarketplaceCapabilityListing = async function getMarketplaceCapabilityListing({
    tenantId = DEFAULT_TENANT_ID,
    listingId
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!(store.marketplaceCapabilityListings instanceof Map)) return null;
    const normalizedListingId =
      listingId === null || listingId === undefined || String(listingId).trim() === "" ? null : String(listingId).trim();
    if (!normalizedListingId) return null;
    return store.marketplaceCapabilityListings.get(
      marketplaceCapabilityListingStoreKey({ tenantId, listingId: normalizedListingId })
    ) ?? null;
  };

  store.listMarketplaceCapabilityListings = async function listMarketplaceCapabilityListings({
    tenantId = DEFAULT_TENANT_ID,
    status = "all",
    capability = null,
    sellerAgentId = null,
    search = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!(store.marketplaceCapabilityListings instanceof Map)) return [];

    const statusFilter = status === null || status === undefined ? "all" : String(status).trim().toLowerCase() || "all";
    const capabilityFilter =
      capability === null || capability === undefined || String(capability).trim() === "" ? null : String(capability).trim();
    const sellerFilter =
      sellerAgentId === null || sellerAgentId === undefined || String(sellerAgentId).trim() === "" ? null : String(sellerAgentId).trim();
    const searchFilter = search === null || search === undefined || String(search).trim() === "" ? null : String(search).trim().toLowerCase();

    const out = [];
    for (const row of store.marketplaceCapabilityListings.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      const rowStatus = String(row.status ?? "active").toLowerCase();
      if (statusFilter !== "all" && rowStatus !== statusFilter) continue;
      if (capabilityFilter && String(row.capability ?? "") !== capabilityFilter) continue;
      if (sellerFilter && String(row.sellerAgentId ?? "") !== sellerFilter) continue;
      if (searchFilter) {
        const haystack = [
          row.listingId,
          row.capability,
          row.title,
          row.description,
          row.category,
          ...(Array.isArray(row.tags) ? row.tags : [])
        ]
          .map((value) => String(value ?? "").toLowerCase())
          .join(" ");
        if (!haystack.includes(searchFilter)) continue;
      }
      out.push(row);
    }
    out.sort((left, right) => {
      const leftAt = Date.parse(String(left.updatedAt ?? left.createdAt ?? ""));
      const rightAt = Date.parse(String(right.updatedAt ?? right.createdAt ?? ""));
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && rightAt !== leftAt) return rightAt - leftAt;
      return String(left.listingId ?? "").localeCompare(String(right.listingId ?? ""));
    });
    return out;
  };

  store.refreshFromDb = async function refreshFromDb() {
    // No-op for in-memory store.
  };

  store.listAggregateEvents = async function listAggregateEvents({ tenantId = DEFAULT_TENANT_ID, aggregateType, aggregateId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof aggregateType !== "string" || aggregateType.trim() === "") throw new TypeError("aggregateType is required");
    if (typeof aggregateId !== "string" || aggregateId.trim() === "") throw new TypeError("aggregateId is required");
    const key = makeScopedKey({ tenantId, id: String(aggregateId) });
    if (aggregateType === "job") return store.jobEvents.get(key) ?? [];
    if (aggregateType === "robot") return store.robotEvents.get(key) ?? [];
    if (aggregateType === "operator") return store.operatorEvents.get(key) ?? [];
    if (aggregateType === "agent_run") return store.agentRunEvents.get(key) ?? [];
    if (aggregateType === "month") return store.monthEvents.get(key) ?? [];
    throw new TypeError(`unsupported aggregateType: ${aggregateType}`);
  };

  store.artifacts = new Map(); // `${tenantId}\n${artifactId}` -> artifact record
  store.deliveries = new Map(); // `${tenantId}\n${deliveryId}` -> delivery record
  store.deliveryReceipts = new Map(); // `${tenantId}\n${deliveryId}` -> receipt record
  store.deliverySeq = 0;
  store.correlations = new Map(); // `${tenantId}\n${siteId}\n${correlationKey}` -> { jobId, expiresAt, createdAt }
  store.ingestRecords = new Map(); // `${tenantId}\n${source}\n${externalEventId}` -> record
  store.authKeys = new Map(); // `${tenantId}\n${keyId}` -> auth key record
  store.signerKeys = new Map(); // `${tenantId}\n${keyId}` -> signer key record
  store.opsAudit = new Map(); // `${tenantId}\n${auditId}` -> ops audit record
  store.opsAuditSeq = 0;
  store.contractsV2 = new Map(); // `${tenantId}\n${contractId}\n${contractVersion}` -> contract v2 record
  store.contractSignaturesV2 = new Map(); // `${tenantId}\n${contractHash}\n${partyRole}` -> signature record

  store.putArtifact = async function putArtifact({ tenantId = DEFAULT_TENANT_ID, artifact }) {
    tenantId = normalizeTenantId(tenantId);
    if (!artifact || typeof artifact !== "object") throw new TypeError("artifact is required");
    const artifactId = artifact.artifactId ?? artifact.id ?? null;
    if (typeof artifactId !== "string" || artifactId.trim() === "") throw new TypeError("artifact.artifactId is required");
    const artifactType = artifact.artifactType ?? artifact.schemaVersion ?? null;
    const jobId = artifact.jobId ?? null;
    const sourceEventIdRaw = artifact.sourceEventId ?? null;
    const sourceEventId = typeof sourceEventIdRaw === "string" && sourceEventIdRaw.trim() !== "" ? sourceEventIdRaw : null;
    const key = makeScopedKey({ tenantId, id: String(artifactId) });

    // Invariant: for artifacts tied to a specific source event, there must be exactly one artifact per
    // (jobId + artifactType + sourceEventId). This prevents duplicate settlement-backed certificates.
    if (sourceEventId && typeof artifactType === "string" && artifactType.trim() && typeof jobId === "string" && jobId.trim()) {
      for (const existing of store.artifacts.values()) {
        if (!existing || typeof existing !== "object") continue;
        if (normalizeTenantId(existing.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (String(existing.jobId ?? "") !== String(jobId)) continue;
        if (String(existing.artifactType ?? existing.schemaVersion ?? "") !== String(artifactType)) continue;
        if (String(existing.sourceEventId ?? "") !== String(sourceEventId)) continue;

        const current = existing?.artifactHash ?? null;
        const next = artifact?.artifactHash ?? null;
        if (typeof current === "string" && current.trim() && typeof next === "string" && next.trim() && String(current) === String(next)) {
          return existing;
        }
        const err = new Error("artifact already exists for this job/type/sourceEventId with a different hash");
        err.code = "ARTIFACT_SOURCE_EVENT_CONFLICT";
        err.existingArtifactId = existing?.artifactId ?? existing?.id ?? null;
        err.existingArtifactHash = current;
        err.gotArtifactHash = next;
        throw err;
      }
    }

    const existing = store.artifacts.get(key);
    if (existing) {
      const current = existing?.artifactHash ?? null;
      const next = artifact?.artifactHash ?? null;
      if (typeof current === "string" && current.trim() && typeof next === "string" && next.trim() && String(current) !== String(next)) {
        const err = new Error("artifactId already exists with a different hash");
        err.code = "ARTIFACT_HASH_MISMATCH";
        err.expectedArtifactHash = String(current);
        err.gotArtifactHash = String(next);
        throw err;
      }
      return existing;
    }
    store.artifacts.set(key, { ...artifact, tenantId, artifactId: String(artifactId) });
    return store.artifacts.get(key);
  };

  store.listArtifacts = async function listArtifacts({
    tenantId = DEFAULT_TENANT_ID,
    jobId = null,
    jobIds = null,
    artifactType = null,
    sourceEventId = null,
    sessionId = null,
    taskId = null,
    projectId = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    let jobIdSet = null;
    if (jobIds !== null && jobIds !== undefined) {
      if (!Array.isArray(jobIds)) throw new TypeError("jobIds must be null or an array");
      jobIdSet = new Set();
      for (const item of jobIds) {
        if (typeof item !== "string" || item.trim() === "") throw new TypeError("jobIds[] must be non-empty strings");
        jobIdSet.add(String(item));
      }
    }
    if (sessionId !== null && (typeof sessionId !== "string" || sessionId.trim() === "")) throw new TypeError("sessionId must be null or a non-empty string");
    if (taskId !== null && (typeof taskId !== "string" || taskId.trim() === "")) throw new TypeError("taskId must be null or a non-empty string");
    if (projectId !== null && (typeof projectId !== "string" || projectId.trim() === "")) throw new TypeError("projectId must be null or a non-empty string");
    const all = [];
    const sourceFilter = typeof sourceEventId === "string" && sourceEventId.trim() !== "" ? String(sourceEventId) : null;
    const typeFilter = typeof artifactType === "string" && artifactType.trim() !== "" ? String(artifactType) : null;
    const sessionFilter = typeof sessionId === "string" && sessionId.trim() !== "" ? String(sessionId) : null;
    const taskFilter = typeof taskId === "string" && taskId.trim() !== "" ? String(taskId) : null;
    const projectFilter = typeof projectId === "string" && projectId.trim() !== "" ? String(projectId) : null;
    const readAccessScopeField = (artifact, field) => {
      const fromAccessScope =
        artifact?.accessScope && typeof artifact.accessScope === "object" && !Array.isArray(artifact.accessScope)
          ? artifact.accessScope[field]
          : undefined;
      const candidate = fromAccessScope !== undefined ? fromAccessScope : artifact?.[field];
      return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
    };
    for (const art of store.artifacts.values()) {
      if (!art || typeof art !== "object") continue;
      if (normalizeTenantId(art.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (jobId !== null && String(art.jobId ?? "") !== String(jobId)) continue;
      if (jobIdSet && !jobIdSet.has(String(art.jobId ?? ""))) continue;
      if (typeFilter !== null && String(art.artifactType ?? art.schemaVersion ?? "") !== typeFilter) continue;
      if (sourceFilter !== null && String(art.sourceEventId ?? "") !== sourceFilter) continue;
      if (sessionFilter !== null && readAccessScopeField(art, "sessionId") !== sessionFilter) continue;
      if (taskFilter !== null && readAccessScopeField(art, "taskId") !== taskFilter) continue;
      if (projectFilter !== null && readAccessScopeField(art, "projectId") !== projectFilter) continue;
      all.push(art);
    }
    all.sort((a, b) => String(a.artifactId ?? "").localeCompare(String(b.artifactId ?? "")));
    return all;
  };

  store.listReputationEvents = async function listReputationEvents({
    tenantId = DEFAULT_TENANT_ID,
    agentId,
    toolId = null,
    occurredAtGte = null,
    occurredAtLte = null,
    limit = 1000,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof agentId !== "string" || agentId.trim() === "") throw new TypeError("agentId is required");
    if (toolId !== null && toolId !== undefined && (typeof toolId !== "string" || toolId.trim() === "")) {
      throw new TypeError("toolId must be null or a non-empty string");
    }
    if (occurredAtGte !== null && occurredAtGte !== undefined && !Number.isFinite(Date.parse(String(occurredAtGte)))) {
      throw new TypeError("occurredAtGte must be an ISO date-time");
    }
    if (occurredAtLte !== null && occurredAtLte !== undefined && !Number.isFinite(Date.parse(String(occurredAtLte)))) {
      throw new TypeError("occurredAtLte must be an ISO date-time");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const minMs = occurredAtGte ? Date.parse(String(occurredAtGte)) : Number.NaN;
    const maxMs = occurredAtLte ? Date.parse(String(occurredAtLte)) : Number.NaN;
    const out = [];
    for (const art of store.artifacts.values()) {
      if (!art || typeof art !== "object" || Array.isArray(art)) continue;
      if (normalizeTenantId(art.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(art.schemaVersion ?? "") !== "ReputationEvent.v1") continue;
      const subject = art.subject && typeof art.subject === "object" && !Array.isArray(art.subject) ? art.subject : null;
      if (!subject) continue;
      if (String(subject.agentId ?? "") !== String(agentId)) continue;
      if (toolId !== null && toolId !== undefined && String(subject.toolId ?? "") !== String(toolId)) continue;
      const occurredAtMs = Date.parse(String(art.occurredAt ?? ""));
      if (!Number.isFinite(occurredAtMs)) continue;
      if (Number.isFinite(minMs) && occurredAtMs < minMs) continue;
      if (Number.isFinite(maxMs) && occurredAtMs > maxMs) continue;
      out.push(art);
    }
    out.sort((left, right) => {
      const leftMs = Date.parse(String(left?.occurredAt ?? ""));
      const rightMs = Date.parse(String(right?.occurredAt ?? ""));
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
      return String(left?.eventId ?? "").localeCompare(String(right?.eventId ?? ""));
    });
    return out.slice(offset, offset + Math.min(5000, limit));
  };

  store.getArtifact = async function getArtifact({ tenantId = DEFAULT_TENANT_ID, artifactId }) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof artifactId !== "string" || artifactId.trim() === "") throw new TypeError("artifactId is required");
    const key = makeScopedKey({ tenantId, id: String(artifactId) });
    return store.artifacts.get(key) ?? null;
  };

  store.createDelivery = async function createDelivery({ tenantId = DEFAULT_TENANT_ID, delivery }) {
    tenantId = normalizeTenantId(tenantId);
    if (!delivery || typeof delivery !== "object") throw new TypeError("delivery is required");
    const dedupeKey = delivery.dedupeKey ?? null;
    if (typeof dedupeKey !== "string" || dedupeKey.trim() === "") throw new TypeError("delivery.dedupeKey is required");

    // Enforce dedupe per-tenant.
    for (const existing of store.deliveries.values()) {
      if (!existing || typeof existing !== "object") continue;
      if (normalizeTenantId(existing.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(existing.dedupeKey ?? "") === dedupeKey) return existing;
    }

    const cfg = typeof store.getConfig === "function" ? store.getConfig(tenantId) : store.config;
    const requestedLimit = cfg?.quotas?.maxPendingDeliveries ?? 0;
    const quota = clampQuota({
      tenantLimit: Number.isSafeInteger(requestedLimit) ? requestedLimit : 0,
      defaultLimit: 0,
      maxLimit: platformMaxPendingDeliveries
    });
    if (quota > 0) {
      let pending = 0;
      for (const d of store.deliveries.values()) {
        if (!d || typeof d !== "object") continue;
        if (normalizeTenantId(d.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (d.state !== "pending") continue;
        pending += 1;
        if (pending >= quota) break;
      }
      if (pending >= quota) {
        const err = new Error("tenant quota exceeded");
        err.code = "TENANT_QUOTA_EXCEEDED";
        err.quota = { kind: "pending_deliveries", limit: quota, current: pending };
        throw err;
      }
    }

    store.deliverySeq += 1;
    const deliveryId = `dlv_${store.deliverySeq}`;
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const scopeKey = delivery.scopeKey !== undefined && delivery.scopeKey !== null ? String(delivery.scopeKey) : "";
    const orderSeq = Number.isSafeInteger(delivery.orderSeq) ? delivery.orderSeq : 0;
    const priority = Number.isSafeInteger(delivery.priority) ? delivery.priority : 0;
    const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${deliveryId}`;
    const record = {
      deliveryId,
      tenantId,
      createdAt: nowAt,
      state: "pending",
      attempts: 0,
      nextAttemptAt: nowAt,
      claimedAt: null,
      worker: null,
      lastStatus: null,
      lastError: null,
      deliveredAt: null,
      ackedAt: null,
      ackReceivedAt: null,
      ackArtifactHash: null,
      expiresAt: null,
      scopeKey,
      orderSeq,
      priority,
      orderKey,
      ...delivery
    };
    store.deliveries.set(makeScopedKey({ tenantId, id: deliveryId }), record);
    return record;
  };

  store.listDeliveries = async function listDeliveries({ tenantId = DEFAULT_TENANT_ID, state = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (state !== null && (typeof state !== "string" || state.trim() === "")) throw new TypeError("state must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const all = [];
    for (const d of store.deliveries.values()) {
      if (!d || typeof d !== "object") continue;
      if (normalizeTenantId(d.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (state !== null && d.state !== state) continue;
      all.push(d);
    }
    all.sort((a, b) => String(a.deliveryId ?? "").localeCompare(String(b.deliveryId ?? "")));
    return all.slice(offset, offset + Math.min(1000, limit));
  };

  store.requeueDelivery = async function requeueDelivery({ tenantId = DEFAULT_TENANT_ID, deliveryId }) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof deliveryId !== "string" || deliveryId.trim() === "") throw new TypeError("deliveryId is required");
    const key = makeScopedKey({ tenantId, id: deliveryId });
    const existing = store.deliveries.get(key);
    if (!existing) return null;
    const now = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const next = {
      ...existing,
      state: "pending",
      attempts: 0,
      nextAttemptAt: now,
      claimedAt: null,
      worker: null,
      lastStatus: null,
      lastError: null,
      deliveredAt: null,
      ackedAt: null,
      ackReceivedAt: null,
      ackArtifactHash: null,
      expiresAt: null,
      updatedAt: now
    };
    store.deliveries.set(key, next);
    return next;
  };

  store.ackDelivery = async function ackDelivery({
    tenantId = DEFAULT_TENANT_ID,
    deliveryId,
    destinationId = null,
    artifactHash = null,
    receivedAt = null,
    nowIso = typeof store.nowIso === "function" ? store.nowIso : () => new Date().toISOString()
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof deliveryId !== "string" || deliveryId.trim() === "") throw new TypeError("deliveryId is required");
    const key = makeScopedKey({ tenantId, id: deliveryId });
    const delivery = store.deliveries.get(key) ?? null;
    if (!delivery) return null;
    if (destinationId !== null && String(delivery.destinationId ?? "") !== String(destinationId)) {
      throw new TypeError("delivery destinationId mismatch");
    }
    if (artifactHash !== null && String(delivery.artifactHash ?? "") !== String(artifactHash)) {
      throw new TypeError("delivery artifactHash mismatch");
    }

    if (delivery.ackedAt) {
      const existingReceipt = store.deliveryReceipts.get(key) ?? null;
      return { delivery, receipt: existingReceipt };
    }

    const ackedAt = nowIso();
    const receipt = {
      tenantId,
      deliveryId,
      destinationId: delivery.destinationId ?? null,
      artifactId: delivery.artifactId ?? null,
      artifactHash: delivery.artifactHash ?? null,
      receivedAt: receivedAt ?? null,
      ackedAt
    };
    const next = {
      ...delivery,
      ackedAt,
      ackReceivedAt: receivedAt ?? null,
      ackArtifactHash: delivery.artifactHash ?? null,
      updatedAt: ackedAt
    };
    store.deliveries.set(key, next);
    store.deliveryReceipts.set(key, receipt);
    return { delivery: next, receipt };
  };

  store.lookupCorrelation = async function lookupCorrelation({
    tenantId = DEFAULT_TENANT_ID,
    siteId,
    correlationKey,
    nowIso = typeof store.nowIso === "function" ? store.nowIso : () => new Date().toISOString()
  }) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof siteId !== "string" || siteId.trim() === "") throw new TypeError("siteId is required");
    if (typeof correlationKey !== "string" || correlationKey.trim() === "") throw new TypeError("correlationKey is required");
    const key = `${tenantId}\n${siteId}\n${correlationKey}`;
    const row = store.correlations.get(key) ?? null;
    if (!row) return null;
    if (row.expiresAt) {
      const nowMs = Date.parse(nowIso());
      const expMs = Date.parse(row.expiresAt);
      if (Number.isFinite(nowMs) && Number.isFinite(expMs) && nowMs >= expMs) return null;
    }
    return { jobId: row.jobId, expiresAt: row.expiresAt ?? null };
  };

  store.upsertCorrelation = async function upsertCorrelation({
    tenantId = DEFAULT_TENANT_ID,
    siteId,
    correlationKey,
    jobId,
    expiresAt = null,
    force = false
  }) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof siteId !== "string" || siteId.trim() === "") throw new TypeError("siteId is required");
    if (typeof correlationKey !== "string" || correlationKey.trim() === "") throw new TypeError("correlationKey is required");
    if (typeof jobId !== "string" || jobId.trim() === "") throw new TypeError("jobId is required");
    const key = `${tenantId}\n${siteId}\n${correlationKey}`;
    const existing = store.correlations.get(key);
    if (existing && existing.jobId !== jobId && !force) {
      const err = new Error("correlation key already linked to a different job");
      err.code = "CORRELATION_CONFLICT";
      err.existingJobId = existing.jobId;
      throw err;
    }
    store.correlations.set(key, { tenantId, siteId, correlationKey, jobId, expiresAt, createdAt: existing?.createdAt ?? new Date().toISOString() });
    return { jobId, expiresAt };
  };

  store.listCorrelations = async function listCorrelations({ tenantId = DEFAULT_TENANT_ID, siteId = null, jobId = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (siteId !== null && (typeof siteId !== "string" || siteId.trim() === "")) throw new TypeError("siteId must be null or a non-empty string");
    if (jobId !== null && (typeof jobId !== "string" || jobId.trim() === "")) throw new TypeError("jobId must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const all = [];
    for (const row of store.correlations.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (siteId !== null && String(row.siteId ?? "") !== siteId) continue;
      if (jobId !== null && String(row.jobId ?? "") !== jobId) continue;
      all.push(row);
    }
    all.sort((a, b) => String(a.siteId ?? "").localeCompare(String(b.siteId ?? "")) || String(a.correlationKey ?? "").localeCompare(String(b.correlationKey ?? "")));
    return all.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getIngestRecord = async function getIngestRecord({ tenantId = DEFAULT_TENANT_ID, source, externalEventId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof source !== "string" || source.trim() === "") throw new TypeError("source is required");
    if (typeof externalEventId !== "string" || externalEventId.trim() === "") throw new TypeError("externalEventId is required");
    return store.ingestRecords.get(`${tenantId}\n${source}\n${externalEventId}`) ?? null;
  };

  store.putIngestRecords = async function putIngestRecords({ tenantId = DEFAULT_TENANT_ID, records } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!Array.isArray(records)) throw new TypeError("records must be an array");
    for (const r of records) {
      if (!r || typeof r !== "object") continue;
      const source = r.source ?? null;
      const externalEventId = r.externalEventId ?? null;
      if (typeof source !== "string" || source.trim() === "") continue;
      if (typeof externalEventId !== "string" || externalEventId.trim() === "") continue;
      const key = `${tenantId}\n${String(source)}\n${String(externalEventId)}`;
      if (store.ingestRecords.has(key)) continue;
      store.ingestRecords.set(key, { ...r, tenantId, source: String(source), externalEventId: String(externalEventId) });
    }
  };

  store.listIngestRecords = async function listIngestRecords({
    tenantId = DEFAULT_TENANT_ID,
    status = null,
    source = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or a non-empty string");
    if (source !== null && (typeof source !== "string" || source.trim() === "")) throw new TypeError("source must be null or a non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const all = [];
    for (const r of store.ingestRecords.values()) {
      if (!r || typeof r !== "object") continue;
      if (normalizeTenantId(r.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (status !== null && String(r.status ?? "") !== status) continue;
      if (source !== null && String(r.source ?? "") !== source) continue;
      all.push(r);
    }
    all.sort((a, b) => String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? "")));
    return all.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getAuthKey = async function getAuthKey({ tenantId = DEFAULT_TENANT_ID, keyId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof keyId !== "string" || keyId.trim() === "") throw new TypeError("keyId is required");
    const key = makeScopedKey({ tenantId, id: String(keyId) });
    return store.authKeys.get(key) ?? null;
  };

  store.putAuthKey = async function putAuthKey({ tenantId = DEFAULT_TENANT_ID, authKey, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!authKey || typeof authKey !== "object") throw new TypeError("authKey is required");
    const keyId = authKey.keyId ?? authKey.id ?? null;
    if (typeof keyId !== "string" || keyId.trim() === "") throw new TypeError("authKey.keyId is required");
    const secretHash = authKey.secretHash ?? null;
    if (typeof secretHash !== "string" || secretHash.trim() === "") throw new TypeError("authKey.secretHash is required");

    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const scopes = normalizeScopes(authKey.scopes ?? []);
    const status = typeof authKey.status === "string" && authKey.status.trim() ? String(authKey.status).trim().toLowerCase() : "active";

    store.ensureTenant(tenantId);
    await store.commitTx({
      at: nowAt,
      ops: [
        {
          kind: "AUTH_KEY_UPSERT",
          tenantId,
          authKey: {
            tenantId,
            keyId: String(keyId),
            secretHash: String(secretHash),
            scopes,
            status,
            description: authKey.description ?? null,
            expiresAt: authKey.expiresAt ?? null,
            createdAt: authKey.createdAt ?? nowAt,
            updatedAt: nowAt,
            lastUsedAt: authKey.lastUsedAt ?? null,
            rotatedAt: authKey.rotatedAt ?? null,
            revokedAt: authKey.revokedAt ?? null
          }
        }
      ],
      audit
    });

    return store.getAuthKey({ tenantId, keyId: String(keyId) });
  };

  store.touchAuthKey = async function touchAuthKey({ tenantId = DEFAULT_TENANT_ID, keyId, at = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof keyId !== "string" || keyId.trim() === "") throw new TypeError("keyId is required");
    const nowAt = at ?? (typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString());
    const key = makeScopedKey({ tenantId, id: String(keyId) });
    const existing = store.authKeys.get(key);
    if (!existing) return false;
    store.authKeys.set(key, { ...existing, lastUsedAt: nowAt, updatedAt: nowAt });
    return true;
  };

  store.setAuthKeyStatus = async function setAuthKeyStatus({ tenantId = DEFAULT_TENANT_ID, keyId, status, at = null, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof keyId !== "string" || keyId.trim() === "") throw new TypeError("keyId is required");
    if (typeof status !== "string" || status.trim() === "") throw new TypeError("status is required");
    const nowAt = at ?? (typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString());
    await store.commitTx({
      at: nowAt,
      ops: [
        {
          kind: "AUTH_KEY_STATUS_SET",
          tenantId,
          keyId: String(keyId),
          status: String(status).trim().toLowerCase(),
          rotatedAt: status === "rotated" ? nowAt : undefined,
          revokedAt: status === "revoked" ? nowAt : undefined
        }
      ],
      audit
    });
    return store.getAuthKey({ tenantId, keyId: String(keyId) });
  };

  store.rotateAuthKey = async function rotateAuthKey({
    tenantId = DEFAULT_TENANT_ID,
    oldKeyId,
    newAuthKey,
    rotatedAt = null,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof oldKeyId !== "string" || oldKeyId.trim() === "") throw new TypeError("oldKeyId is required");
    if (!newAuthKey || typeof newAuthKey !== "object") throw new TypeError("newAuthKey is required");
    const newKeyId = newAuthKey.keyId ?? newAuthKey.id ?? null;
    if (typeof newKeyId !== "string" || newKeyId.trim() === "") throw new TypeError("newAuthKey.keyId is required");
    const secretHash = newAuthKey.secretHash ?? null;
    if (typeof secretHash !== "string" || secretHash.trim() === "") throw new TypeError("newAuthKey.secretHash is required");

    const nowAt = rotatedAt ?? (typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString());
    const existing = await store.getAuthKey({ tenantId, keyId: String(oldKeyId) });
    if (!existing) return null;
    if (existing.status === "revoked") {
      const err = new Error("auth key is revoked");
      err.code = "AUTH_KEY_REVOKED";
      throw err;
    }

    const scopes = normalizeScopes(newAuthKey.scopes ?? existing.scopes ?? []);
    const expiresAt = newAuthKey.expiresAt ?? existing.expiresAt ?? null;
    const description = newAuthKey.description ?? existing.description ?? null;

    await store.commitTx({
      at: nowAt,
      ops: [
        { kind: "AUTH_KEY_STATUS_SET", tenantId, keyId: String(oldKeyId), status: "rotated", rotatedAt: nowAt },
        {
          kind: "AUTH_KEY_UPSERT",
          tenantId,
          authKey: {
            tenantId,
            keyId: String(newKeyId),
            secretHash: String(secretHash),
            scopes,
            status: "active",
            description,
            expiresAt,
            createdAt: nowAt,
            updatedAt: nowAt,
            lastUsedAt: null,
            rotatedAt: null,
            revokedAt: null
          }
        }
      ],
      audit
    });

    return {
      rotatedAt: nowAt,
      oldKeyId: String(oldKeyId),
      newKeyId: String(newKeyId),
      oldKey: await store.getAuthKey({ tenantId, keyId: String(oldKeyId) }),
      newKey: await store.getAuthKey({ tenantId, keyId: String(newKeyId) })
    };
  };

  store.listAuthKeys = async function listAuthKeys({ tenantId = DEFAULT_TENANT_ID } = {}) {
    tenantId = normalizeTenantId(tenantId);
    const all = [];
    for (const v of store.authKeys.values()) {
      if (!v || typeof v !== "object") continue;
      if (normalizeTenantId(v.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      all.push(v);
    }
    all.sort((a, b) => String(a.keyId ?? "").localeCompare(String(b.keyId ?? "")));
    return all;
  };

  store.appendOpsAudit = async function appendOpsAudit({ tenantId = DEFAULT_TENANT_ID, audit }) {
    tenantId = normalizeTenantId(tenantId);
    if (!audit || typeof audit !== "object") throw new TypeError("audit is required");
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();

    store.ensureTenant(tenantId);
    store.opsAuditSeq += 1;
    const id = store.opsAuditSeq;
    const record = { ...audit, id, tenantId, at: audit?.at ?? nowAt };
    await store.commitTx({ at: nowAt, ops: [{ kind: "OPS_AUDIT_APPEND", tenantId, audit: record }] });
    return record;
  };

  store.listOpsAudit = async function listOpsAudit({ tenantId = DEFAULT_TENANT_ID, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const all = [];
    for (const row of store.opsAudit.values()) {
      if (!row || typeof row !== "object") continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      all.push(row);
    }
    all.sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
    return all.slice(safeOffset, safeOffset + safeLimit);
  };

  store.appendEmergencyControlEvent = async function appendEmergencyControlEvent({ tenantId = DEFAULT_TENANT_ID, event, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event is required");

    const eventId = assertNonEmptyString(event.eventId ?? event.id ?? null, "event.eventId");
    const action = normalizeEmergencyAction(event.action ?? null);
    const scopeInput = event.scope && typeof event.scope === "object" && !Array.isArray(event.scope) ? event.scope : {};
    const scopeType = normalizeEmergencyScopeType(scopeInput.type ?? event.scopeType ?? EMERGENCY_SCOPE_TYPE.TENANT);
    const scopeId = normalizeEmergencyScopeId(scopeType, scopeInput.id ?? event.scopeId ?? null);
    const controlType =
      action === EMERGENCY_ACTION.RESUME
        ? normalizeEmergencyControlType(event.controlType ?? null, { allowNull: true })
        : normalizeEmergencyControlType(event.controlType ?? action, { allowNull: false });
    const resumeControlTypes =
      action === EMERGENCY_ACTION.RESUME
        ? normalizeEmergencyResumeControlTypes(event.resumeControlTypes ?? (controlType ? [controlType] : null))
        : [];

    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const effectiveAt =
      typeof event.effectiveAt === "string" && event.effectiveAt.trim() !== "" ? event.effectiveAt.trim() : nowAt;
    const createdAt = typeof event.createdAt === "string" && event.createdAt.trim() !== "" ? event.createdAt.trim() : nowAt;
    const normalizedEvent = {
      ...event,
      schemaVersion:
        typeof event.schemaVersion === "string" && event.schemaVersion.trim() !== ""
          ? event.schemaVersion.trim()
          : "OpsEmergencyControlEvent.v1",
      eventId,
      tenantId,
      action,
      controlType,
      resumeControlTypes,
      scope: { type: scopeType, id: scopeId },
      effectiveAt,
      createdAt
    };

    await store.commitTx({ at: effectiveAt, ops: [{ kind: "EMERGENCY_CONTROL_EVENT_APPEND", tenantId, event: normalizedEvent }], audit });
    return store.emergencyControlEvents.get(makeScopedKey({ tenantId, id: eventId })) ?? normalizedEvent;
  };

  store.listEmergencyControlEvents = async function listEmergencyControlEvents({
    tenantId = DEFAULT_TENANT_ID,
    action = null,
    scopeType = null,
    scopeId = null,
    controlType = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (action !== null) action = normalizeEmergencyAction(action);
    if (scopeType !== null) scopeType = normalizeEmergencyScopeType(scopeType);
    if (controlType !== null) controlType = normalizeEmergencyControlType(controlType, { allowNull: false });
    if (scopeId !== null && (typeof scopeId !== "string" || scopeId.trim() === "")) {
      throw new TypeError("scopeId must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const out = [];
    for (const row of store.emergencyControlEvents.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (action !== null && String(row.action ?? "").toLowerCase() !== action) continue;
      const rowScope = row.scope && typeof row.scope === "object" && !Array.isArray(row.scope) ? row.scope : {};
      if (scopeType !== null && String(rowScope.type ?? "").toLowerCase() !== scopeType) continue;
      if (scopeId !== null && String(rowScope.id ?? "") !== scopeId) continue;
      if (controlType !== null && String(row.controlType ?? "").toLowerCase() !== controlType) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftMs = Number.isFinite(Date.parse(String(left?.effectiveAt ?? ""))) ? Date.parse(String(left.effectiveAt)) : Number.NaN;
      const rightMs = Number.isFinite(Date.parse(String(right?.effectiveAt ?? ""))) ? Date.parse(String(right.effectiveAt)) : Number.NaN;
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && rightMs !== leftMs) return rightMs - leftMs;
      return String(left?.eventId ?? "").localeCompare(String(right?.eventId ?? ""));
    });
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.listEmergencyControlState = async function listEmergencyControlState({
    tenantId = DEFAULT_TENANT_ID,
    active = null,
    scopeType = null,
    scopeId = null,
    controlType = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (active !== null && typeof active !== "boolean") throw new TypeError("active must be null or boolean");
    if (scopeType !== null) scopeType = normalizeEmergencyScopeType(scopeType);
    if (controlType !== null) controlType = normalizeEmergencyControlType(controlType, { allowNull: false });
    if (scopeId !== null && (typeof scopeId !== "string" || scopeId.trim() === "")) {
      throw new TypeError("scopeId must be null or a non-empty string");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const out = [];
    for (const row of store.emergencyControlState.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (active !== null && Boolean(row.active) !== active) continue;
      if (scopeType !== null && String(row.scopeType ?? "").toLowerCase() !== scopeType) continue;
      if (scopeId !== null && String(row.scopeId ?? "") !== scopeId) continue;
      if (controlType !== null && String(row.controlType ?? "").toLowerCase() !== controlType) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftMs = Number.isFinite(Date.parse(String(left?.updatedAt ?? ""))) ? Date.parse(String(left.updatedAt)) : Number.NaN;
      const rightMs = Number.isFinite(Date.parse(String(right?.updatedAt ?? ""))) ? Date.parse(String(right.updatedAt)) : Number.NaN;
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && rightMs !== leftMs) return rightMs - leftMs;
      const leftScope = `${String(left?.scopeType ?? "")}:${String(left?.scopeId ?? "")}`;
      const rightScope = `${String(right?.scopeType ?? "")}:${String(right?.scopeId ?? "")}`;
      const scopeOrder = leftScope.localeCompare(rightScope);
      if (scopeOrder !== 0) return scopeOrder;
      return String(left?.controlType ?? "").localeCompare(String(right?.controlType ?? ""));
    });
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.findEmergencyControlBlock = async function findEmergencyControlBlock({
    tenantId = DEFAULT_TENANT_ID,
    controlTypes = null,
    agentIds = [],
    adapterIds = []
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    const allowedControlTypes = controlTypes === null ? null : new Set(normalizeEmergencyResumeControlTypes(controlTypes));
    const normalizedAgentIds = new Set((Array.isArray(agentIds) ? agentIds : []).map((value) => String(value ?? "").trim()).filter(Boolean));
    const normalizedAdapterIds = new Set((Array.isArray(adapterIds) ? adapterIds : []).map((value) => String(value ?? "").trim()).filter(Boolean));
    const controlPriority = new Map([
      [EMERGENCY_CONTROL_TYPE.KILL_SWITCH, 0],
      [EMERGENCY_CONTROL_TYPE.REVOKE, 1],
      [EMERGENCY_CONTROL_TYPE.QUARANTINE, 2],
      [EMERGENCY_CONTROL_TYPE.PAUSE, 3]
    ]);
    const scopePriority = new Map([
      [EMERGENCY_SCOPE_TYPE.AGENT, 0],
      [EMERGENCY_SCOPE_TYPE.ADAPTER, 1],
      [EMERGENCY_SCOPE_TYPE.TENANT, 2]
    ]);

    const matches = [];
    for (const row of store.emergencyControlState.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (row.active !== true) continue;
      const rowControlType = normalizeEmergencyControlType(row.controlType ?? null, { allowNull: false });
      if (allowedControlTypes && !allowedControlTypes.has(rowControlType)) continue;
      const rowScopeType = normalizeEmergencyScopeType(row.scopeType ?? null);
      const rowScopeId = row.scopeId === null || row.scopeId === undefined ? null : String(row.scopeId);
      if (rowScopeType === EMERGENCY_SCOPE_TYPE.AGENT && !normalizedAgentIds.has(String(rowScopeId ?? ""))) continue;
      if (rowScopeType === EMERGENCY_SCOPE_TYPE.ADAPTER && !normalizedAdapterIds.has(String(rowScopeId ?? ""))) continue;
      matches.push({
        ...row,
        controlType: rowControlType,
        scopeType: rowScopeType,
        scopeId: rowScopeId
      });
    }
    matches.sort((left, right) => {
      const leftControl = controlPriority.get(left.controlType) ?? 100;
      const rightControl = controlPriority.get(right.controlType) ?? 100;
      if (leftControl !== rightControl) return leftControl - rightControl;
      const leftScope = scopePriority.get(left.scopeType) ?? 100;
      const rightScope = scopePriority.get(right.scopeType) ?? 100;
      if (leftScope !== rightScope) return leftScope - rightScope;
      const leftMs = Number.isFinite(Date.parse(String(left?.updatedAt ?? ""))) ? Date.parse(String(left.updatedAt)) : Number.NaN;
      const rightMs = Number.isFinite(Date.parse(String(right?.updatedAt ?? ""))) ? Date.parse(String(right.updatedAt)) : Number.NaN;
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && rightMs !== leftMs) return rightMs - leftMs;
      return String(left?.lastEventId ?? "").localeCompare(String(right?.lastEventId ?? ""));
    });
    return matches[0] ?? null;
  };

  function normalizeAutonomousRoutineStatus(value, { allowNull = false } = {}) {
    if (allowNull && (value === null || value === undefined || String(value).trim() === "")) return null;
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!AUTONOMOUS_ROUTINE_STATUSES.has(normalized)) throw new TypeError("routine.status must be active|paused");
    return normalized;
  }

  function normalizeAutonomousRoutineControlAction(value) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!AUTONOMOUS_ROUTINE_CONTROL_ACTIONS.has(normalized)) throw new TypeError("action must be kill-switch|resume");
    return normalized;
  }

  function autonomousRoutinePolicyStoreKey({ tenantId, routineId }) {
    return makeScopedKey({ tenantId: normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID), id: assertNonEmptyString(routineId, "routineId") });
  }

  function autonomousRoutineExecutionStoreKey({ tenantId, routineId, executionId }) {
    return makeScopedKey({
      tenantId: normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID),
      id: `${assertNonEmptyString(routineId, "routineId")}::${assertNonEmptyString(executionId, "executionId")}`
    });
  }

  function normalizeAutonomousRoutineSpendLimit(value, fieldPath) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${fieldPath} must be a non-negative safe integer`);
    return parsed;
  }

  store.putAutonomousRoutinePolicy = async function putAutonomousRoutinePolicy({ tenantId = DEFAULT_TENANT_ID, routine, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!routine || typeof routine !== "object" || Array.isArray(routine)) throw new TypeError("routine is required");
    const routineId = assertNonEmptyString(routine.routineId ?? routine.id ?? null, "routine.routineId");
    const status = normalizeAutonomousRoutineStatus(routine.status ?? AUTONOMOUS_ROUTINE_STATUS.ACTIVE, { allowNull: false });
    const spendingLimits =
      routine.spendingLimits && typeof routine.spendingLimits === "object" && !Array.isArray(routine.spendingLimits)
        ? routine.spendingLimits
        : (() => {
            throw new TypeError("routine.spendingLimits is required");
          })();
    const currency = assertNonEmptyString(spendingLimits.currency ?? null, "routine.spendingLimits.currency").toUpperCase();
    const maxPerExecutionMicros = normalizeAutonomousRoutineSpendLimit(
      spendingLimits.maxPerExecutionMicros ?? null,
      "routine.spendingLimits.maxPerExecutionMicros"
    );
    const maxPerDayMicros = normalizeAutonomousRoutineSpendLimit(
      spendingLimits.maxPerDayMicros ?? null,
      "routine.spendingLimits.maxPerDayMicros"
    );
    if (maxPerDayMicros < maxPerExecutionMicros) {
      throw new TypeError("routine.spendingLimits.maxPerDayMicros must be greater than or equal to maxPerExecutionMicros");
    }
    const killSwitch =
      routine.killSwitch && typeof routine.killSwitch === "object" && !Array.isArray(routine.killSwitch) ? routine.killSwitch : {};
    if (killSwitch.active !== undefined && typeof killSwitch.active !== "boolean") {
      throw new TypeError("routine.killSwitch.active must be boolean when provided");
    }
    const revision = killSwitch.revision === undefined || killSwitch.revision === null ? 0 : Number(killSwitch.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError("routine.killSwitch.revision must be a non-negative safe integer");

    const normalizedRoutine = {
      ...routine,
      tenantId,
      routineId,
      status,
      spendingLimits: {
        ...spendingLimits,
        currency,
        maxPerExecutionMicros,
        maxPerDayMicros
      },
      killSwitch: {
        active: killSwitch.active === true,
        revision,
        updatedAt: typeof killSwitch.updatedAt === "string" && killSwitch.updatedAt.trim() !== "" ? killSwitch.updatedAt.trim() : null,
        reasonCode:
          killSwitch.reasonCode === null || killSwitch.reasonCode === undefined || String(killSwitch.reasonCode).trim() === ""
            ? null
            : String(killSwitch.reasonCode).trim(),
        reason:
          killSwitch.reason === null || killSwitch.reason === undefined || String(killSwitch.reason).trim() === ""
            ? null
            : String(killSwitch.reason).trim(),
        lastIncidentId:
          killSwitch.lastIncidentId === null || killSwitch.lastIncidentId === undefined || String(killSwitch.lastIncidentId).trim() === ""
            ? null
            : String(killSwitch.lastIncidentId).trim()
      }
    };
    const at = normalizedRoutine.updatedAt ?? normalizedRoutine.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "AUTONOMOUS_ROUTINE_POLICY_UPSERT", tenantId, routine: normalizedRoutine }],
      audit
    });
    return store.autonomousRoutinePolicies.get(autonomousRoutinePolicyStoreKey({ tenantId, routineId })) ?? null;
  };

  store.getAutonomousRoutinePolicy = async function getAutonomousRoutinePolicy({ tenantId = DEFAULT_TENANT_ID, routineId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    return store.autonomousRoutinePolicies.get(autonomousRoutinePolicyStoreKey({ tenantId, routineId })) ?? null;
  };

  store.listAutonomousRoutinePolicies = async function listAutonomousRoutinePolicies({
    tenantId = DEFAULT_TENANT_ID,
    status = null,
    killSwitchActive = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (status !== null) status = normalizeAutonomousRoutineStatus(status, { allowNull: false });
    if (killSwitchActive !== null && typeof killSwitchActive !== "boolean") throw new TypeError("killSwitchActive must be null or boolean");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.autonomousRoutinePolicies.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (status !== null && String(row.status ?? "").toLowerCase() !== status) continue;
      if (killSwitchActive !== null && Boolean(row?.killSwitch?.active) !== killSwitchActive) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftAt = Number.isFinite(Date.parse(String(left?.updatedAt ?? ""))) ? Date.parse(String(left.updatedAt)) : Number.NaN;
      const rightAt = Number.isFinite(Date.parse(String(right?.updatedAt ?? ""))) ? Date.parse(String(right.updatedAt)) : Number.NaN;
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && rightAt !== leftAt) return rightAt - leftAt;
      return String(left?.routineId ?? "").localeCompare(String(right?.routineId ?? ""));
    });
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.appendAutonomousRoutineControlEvent = async function appendAutonomousRoutineControlEvent({
    tenantId = DEFAULT_TENANT_ID,
    event,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event is required");
    const incidentId = assertNonEmptyString(event.incidentId ?? event.eventId ?? event.id ?? null, "event.incidentId");
    const routineId = assertNonEmptyString(event.routineId ?? null, "event.routineId");
    const action = normalizeAutonomousRoutineControlAction(event.action ?? null);
    const existingRoutine = await store.getAutonomousRoutinePolicy({ tenantId, routineId });
    if (!existingRoutine) throw new TypeError("event.routineId was not found");
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const effectiveAt = typeof event.effectiveAt === "string" && event.effectiveAt.trim() !== "" ? event.effectiveAt.trim() : nowAt;
    const createdAt = typeof event.createdAt === "string" && event.createdAt.trim() !== "" ? event.createdAt.trim() : nowAt;
    const normalizedEvent = {
      ...event,
      schemaVersion:
        typeof event.schemaVersion === "string" && event.schemaVersion.trim() !== ""
          ? event.schemaVersion.trim()
          : "AutonomousRoutineControlEvent.v1",
      incidentId,
      tenantId,
      routineId,
      action,
      effectiveAt,
      createdAt
    };
    await store.commitTx({
      at: effectiveAt,
      ops: [{ kind: "AUTONOMOUS_ROUTINE_CONTROL_EVENT_APPEND", tenantId, event: normalizedEvent }],
      audit
    });
    return store.autonomousRoutineControlEvents.get(makeScopedKey({ tenantId, id: incidentId })) ?? null;
  };

  store.listAutonomousRoutineControlEvents = async function listAutonomousRoutineControlEvents({
    tenantId = DEFAULT_TENANT_ID,
    routineId = null,
    action = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (routineId !== null) routineId = assertNonEmptyString(routineId, "routineId");
    if (action !== null) action = normalizeAutonomousRoutineControlAction(action);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.autonomousRoutineControlEvents.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (routineId !== null && String(row.routineId ?? "") !== routineId) continue;
      if (action !== null && String(row.action ?? "").toLowerCase() !== action) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftAt = Number.isFinite(Date.parse(String(left?.effectiveAt ?? ""))) ? Date.parse(String(left.effectiveAt)) : Number.NaN;
      const rightAt = Number.isFinite(Date.parse(String(right?.effectiveAt ?? ""))) ? Date.parse(String(right.effectiveAt)) : Number.NaN;
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && rightAt !== leftAt) return rightAt - leftAt;
      return String(left?.incidentId ?? "").localeCompare(String(right?.incidentId ?? ""));
    });
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.appendAutonomousRoutineExecution = async function appendAutonomousRoutineExecution({
    tenantId = DEFAULT_TENANT_ID,
    execution,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!execution || typeof execution !== "object" || Array.isArray(execution)) throw new TypeError("execution is required");
    const routineId = assertNonEmptyString(execution.routineId ?? null, "execution.routineId");
    const executionId = assertNonEmptyString(execution.executionId ?? execution.id ?? null, "execution.executionId");
    const existingRoutine = await store.getAutonomousRoutinePolicy({ tenantId, routineId });
    if (!existingRoutine) throw new TypeError("execution.routineId was not found");
    const decision =
      execution.decision && typeof execution.decision === "object" && !Array.isArray(execution.decision)
        ? execution.decision
        : (() => {
            throw new TypeError("execution.decision is required");
          })();
    if (typeof decision.allowed !== "boolean") throw new TypeError("execution.decision.allowed must be boolean");
    const normalizedExecution = {
      ...execution,
      schemaVersion:
        typeof execution.schemaVersion === "string" && execution.schemaVersion.trim() !== ""
          ? execution.schemaVersion.trim()
          : "AutonomousRoutineExecutionReceipt.v1",
      tenantId,
      routineId,
      executionId
    };
    const at = normalizedExecution.executedAt ?? normalizedExecution.createdAt ?? new Date().toISOString();
    await store.commitTx({
      at,
      ops: [{ kind: "AUTONOMOUS_ROUTINE_EXECUTION_APPEND", tenantId, execution: normalizedExecution }],
      audit
    });
    return store.autonomousRoutineExecutions.get(autonomousRoutineExecutionStoreKey({ tenantId, routineId, executionId })) ?? null;
  };

  store.listAutonomousRoutineExecutions = async function listAutonomousRoutineExecutions({
    tenantId = DEFAULT_TENANT_ID,
    routineId = null,
    allowed = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (routineId !== null) routineId = assertNonEmptyString(routineId, "routineId");
    if (allowed !== null && typeof allowed !== "boolean") throw new TypeError("allowed must be null or boolean");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(2000, limit);
    const safeOffset = offset;
    const out = [];
    for (const row of store.autonomousRoutineExecutions.values()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (routineId !== null && String(row.routineId ?? "") !== routineId) continue;
      if (allowed !== null && Boolean(row?.decision?.allowed) !== allowed) continue;
      out.push(row);
    }
    out.sort((left, right) => {
      const leftAt = Number.isFinite(Date.parse(String(left?.executedAt ?? ""))) ? Date.parse(String(left.executedAt)) : Number.NaN;
      const rightAt = Number.isFinite(Date.parse(String(right?.executedAt ?? ""))) ? Date.parse(String(right.executedAt)) : Number.NaN;
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && rightAt !== leftAt) return rightAt - leftAt;
      return String(left?.executionId ?? "").localeCompare(String(right?.executionId ?? ""));
    });
    return out.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getSignerKey = async function getSignerKey({ tenantId = DEFAULT_TENANT_ID, keyId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof keyId !== "string" || keyId.trim() === "") throw new TypeError("keyId is required");
    const key = makeScopedKey({ tenantId, id: String(keyId) });
    return store.signerKeys.get(key) ?? null;
  };

  store.putSignerKey = async function putSignerKey({ tenantId = DEFAULT_TENANT_ID, signerKey, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (!signerKey || typeof signerKey !== "object") throw new TypeError("signerKey is required");
    const keyId = signerKey.keyId ?? signerKey.id ?? null;
    if (typeof keyId !== "string" || keyId.trim() === "") throw new TypeError("signerKey.keyId is required");
    const publicKeyPem = signerKey.publicKeyPem ?? null;
    if (typeof publicKeyPem !== "string" || publicKeyPem.trim() === "") throw new TypeError("signerKey.publicKeyPem is required");
    const purpose = normalizeSignerKeyPurpose(signerKey.purpose ?? "server");
    const status = normalizeSignerKeyStatus(signerKey.status ?? "active");

    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    await store.commitTx({
      at: nowAt,
      ops: [
        {
          kind: "SIGNER_KEY_UPSERT",
          tenantId,
          signerKey: {
            tenantId,
            keyId: String(keyId),
            publicKeyPem: String(publicKeyPem),
            purpose,
            status,
            description: signerKey.description ?? null,
            validFrom: signerKey.validFrom ?? null,
            validTo: signerKey.validTo ?? null,
            createdAt: signerKey.createdAt ?? nowAt,
            updatedAt: nowAt,
            lastUsedAt: signerKey.lastUsedAt ?? null,
            rotatedAt: signerKey.rotatedAt ?? null,
            revokedAt: signerKey.revokedAt ?? null
          }
        }
      ],
      audit
    });

    return store.getSignerKey({ tenantId, keyId: String(keyId) });
  };

  store.setSignerKeyStatus = async function setSignerKeyStatus({ tenantId = DEFAULT_TENANT_ID, keyId, status, at = null, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof keyId !== "string" || keyId.trim() === "") throw new TypeError("keyId is required");
    const normalizedStatus = normalizeSignerKeyStatus(status);
    const nowAt = at ?? (typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString());
    await store.commitTx({
      at: nowAt,
      ops: [
        {
          kind: "SIGNER_KEY_STATUS_SET",
          tenantId,
          keyId: String(keyId),
          status: normalizedStatus,
          rotatedAt: normalizedStatus === "rotated" ? nowAt : undefined,
          revokedAt: normalizedStatus === "revoked" ? nowAt : undefined
        }
      ],
      audit
    });
    return store.getSignerKey({ tenantId, keyId: String(keyId) });
  };

  store.listSignerKeys = async function listSignerKeys({ tenantId = DEFAULT_TENANT_ID } = {}) {
    tenantId = normalizeTenantId(tenantId);
    const all = [];
    for (const v of store.signerKeys.values()) {
      if (!v || typeof v !== "object") continue;
      if (normalizeTenantId(v.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      all.push(v);
    }
    all.sort((a, b) => String(a.keyId ?? "").localeCompare(String(b.keyId ?? "")));
    return all;
  };

  store.getContractV2 = async function getContractV2({ tenantId = DEFAULT_TENANT_ID, contractId, contractVersion } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof contractId !== "string" || contractId.trim() === "") throw new TypeError("contractId is required");
    const v = Number(contractVersion);
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("contractVersion must be a positive safe integer");
    const key = `${tenantId}\n${String(contractId)}\n${String(v)}`;
    return store.contractsV2.get(key) ?? null;
  };

  store.getContractV2ByHash = async function getContractV2ByHash({ tenantId = DEFAULT_TENANT_ID, contractHash } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof contractHash !== "string" || contractHash.trim() === "") throw new TypeError("contractHash is required");
    for (const c of store.contractsV2.values()) {
      if (!c || typeof c !== "object") continue;
      if (normalizeTenantId(c.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(c.contractHash ?? "") !== String(contractHash)) continue;
      return c;
    }
    return null;
  };

  store.listContractsV2 = async function listContractsV2({ tenantId = DEFAULT_TENANT_ID, status = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (status !== null && (typeof status !== "string" || status.trim() === "")) throw new TypeError("status must be null or non-empty string");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const all = [];
    for (const c of store.contractsV2.values()) {
      if (!c || typeof c !== "object") continue;
      if (normalizeTenantId(c.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (status !== null && String(c.status ?? "") !== String(status)) continue;
      all.push(c);
    }
    all.sort((a, b) => String(a.contractId ?? "").localeCompare(String(b.contractId ?? "")) || Number(b.contractVersion ?? 0) - Number(a.contractVersion ?? 0));
    return all.slice(safeOffset, safeOffset + safeLimit);
  };

  store.getLatestContractV2 = async function getLatestContractV2({ tenantId = DEFAULT_TENANT_ID, contractId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof contractId !== "string" || contractId.trim() === "") throw new TypeError("contractId is required");
    let best = null;
    for (const c of store.contractsV2.values()) {
      if (!c || typeof c !== "object") continue;
      if (normalizeTenantId(c.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(c.contractId ?? "") !== String(contractId)) continue;
      if (!best || Number(c.contractVersion ?? 0) > Number(best.contractVersion ?? 0)) best = c;
    }
    return best;
  };

  store.createContractDraftV2 = async function createContractDraftV2({ tenantId = DEFAULT_TENANT_ID, contractId, contractVersion, doc, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof contractId !== "string" || contractId.trim() === "") throw new TypeError("contractId is required");
    const v = Number(contractVersion);
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("contractVersion must be a positive safe integer");
    if (!doc || typeof doc !== "object") throw new TypeError("doc is required");
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const key = `${tenantId}\n${String(contractId)}\n${String(v)}`;
    const existing = store.contractsV2.get(key) ?? null;
    if (existing && String(existing.status ?? "") !== "DRAFT") {
      const err = new Error("contract is not editable");
      err.code = "CONTRACT_NOT_EDITABLE";
      throw err;
    }
    const record = {
      tenantId,
      contractId: String(contractId),
      contractVersion: v,
      status: "DRAFT",
      effectiveFrom: doc?.effective?.from ?? null,
      effectiveTo: doc?.effective?.to ?? null,
      contractHash: existing?.contractHash ?? null,
      policyHash: existing?.policyHash ?? null,
      compilerId: existing?.compilerId ?? null,
      scope: { ...(doc?.scope ?? {}) },
      doc,
      createdAt: existing?.createdAt ?? nowAt,
      updatedAt: nowAt
    };
    store.contractsV2.set(key, record);
    if (audit && typeof store.appendOpsAudit === "function") {
      await store.appendOpsAudit({ tenantId, audit });
    }
    return store.getContractV2({ tenantId, contractId: String(contractId), contractVersion: v });
  };

  store.publishContractV2 = async function publishContractV2({ tenantId = DEFAULT_TENANT_ID, contractId, contractVersion, contractHash, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof contractId !== "string" || contractId.trim() === "") throw new TypeError("contractId is required");
    const v = Number(contractVersion);
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("contractVersion must be a positive safe integer");
    if (typeof contractHash !== "string" || contractHash.trim() === "") throw new TypeError("contractHash is required");
    const key = `${tenantId}\n${String(contractId)}\n${String(v)}`;
    const existing = store.contractsV2.get(key) ?? null;
    if (!existing) {
      const err = new Error("contract not found");
      err.code = "NOT_FOUND";
      throw err;
    }
    if (existing.contractHash && existing.contractHash !== contractHash) {
      const err = new Error("contract hash mismatch");
      err.code = "CONTRACT_HASH_MISMATCH";
      throw err;
    }
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const next = { ...existing, status: "PUBLISHED", contractHash: String(contractHash), updatedAt: nowAt };
    store.contractsV2.set(key, next);
    if (audit && typeof store.appendOpsAudit === "function") {
      await store.appendOpsAudit({ tenantId, audit });
    }
    return store.getContractV2({ tenantId, contractId: String(contractId), contractVersion: v });
  };

  store.putContractSignatureV2 = async function putContractSignatureV2({ tenantId = DEFAULT_TENANT_ID, contractHash, partyRole, signerKeyId, signature, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof contractHash !== "string" || contractHash.trim() === "") throw new TypeError("contractHash is required");
    if (typeof partyRole !== "string" || partyRole.trim() === "") throw new TypeError("partyRole is required");
    if (typeof signerKeyId !== "string" || signerKeyId.trim() === "") throw new TypeError("signerKeyId is required");
    if (typeof signature !== "string" || signature.trim() === "") throw new TypeError("signature is required");
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const key = `${tenantId}\n${String(contractHash)}\n${String(partyRole)}`;
    store.contractSignaturesV2.set(key, {
      tenantId,
      contractHash: String(contractHash),
      partyRole: String(partyRole),
      signerKeyId: String(signerKeyId),
      signature: String(signature),
      signedAt: nowAt
    });
    if (audit && typeof store.appendOpsAudit === "function") {
      await store.appendOpsAudit({ tenantId, audit });
    }
    return { ok: true };
  };

  store.listContractSignaturesV2 = async function listContractSignaturesV2({ tenantId = DEFAULT_TENANT_ID, contractHash } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof contractHash !== "string" || contractHash.trim() === "") throw new TypeError("contractHash is required");
    const out = [];
    for (const s of store.contractSignaturesV2.values()) {
      if (!s || typeof s !== "object") continue;
      if (normalizeTenantId(s.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (String(s.contractHash ?? "") !== String(contractHash)) continue;
      out.push(s);
    }
    out.sort((a, b) => String(a.partyRole ?? "").localeCompare(String(b.partyRole ?? "")));
    return out;
  };

  store.activateContractV2 = async function activateContractV2({ tenantId = DEFAULT_TENANT_ID, contractId, contractVersion, policyHash, compilerId, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof contractId !== "string" || contractId.trim() === "") throw new TypeError("contractId is required");
    const v = Number(contractVersion);
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("contractVersion must be a positive safe integer");
    if (typeof policyHash !== "string" || policyHash.trim() === "") throw new TypeError("policyHash is required");
    if (typeof compilerId !== "string" || compilerId.trim() === "") throw new TypeError("compilerId is required");
    const key = `${tenantId}\n${String(contractId)}\n${String(v)}`;
    const existing = store.contractsV2.get(key) ?? null;
    if (!existing) {
      const err = new Error("contract not found");
      err.code = "NOT_FOUND";
      throw err;
    }
    const status = String(existing.status ?? "");
    if (status !== "PUBLISHED" && status !== "ACTIVE") {
      const err = new Error("contract not activatable");
      err.code = "CONTRACT_NOT_ACTIVATABLE";
      throw err;
    }
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    store.contractsV2.set(key, { ...existing, status: "ACTIVE", policyHash: String(policyHash), compilerId: String(compilerId), updatedAt: nowAt });
    if (audit && typeof store.appendOpsAudit === "function") {
      await store.appendOpsAudit({ tenantId, audit });
    }
    return store.getContractV2({ tenantId, contractId: String(contractId), contractVersion: v });
  };

  store.close = function close() {
    store.persistence?.close();
  };

  if (store.persistence) {
    const records = store.persistence.load();
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      if (record.v !== TX_LOG_VERSION) continue;
      try {
        applyTxRecord(store, record);
      } catch (err) {
        throw new Error(`failed to replay tx log: ${err?.message}`);
      }
    }

    // Catch up any durable side-effects driven via outbox (e.g. ledger application).
    processOutbox(store);
  }

  // Bootstrap global governance with the current server signer key. This prevents
  // finance-grade proof bundles from introducing a new out-of-band trust root.
  // Must run after tx-log replay (if enabled) to avoid conflicting re-appends.
  (function bootstrapGlobalGovernanceServerSignerKey() {
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const globalTenantId = DEFAULT_TENANT_ID;
    const key = makeScopedKey({ tenantId: globalTenantId, id: GOVERNANCE_STREAM_ID });
    const existing = store.monthEvents.get(key) ?? [];
    const serverKeyId = store.serverSigner?.keyId ?? null;
    const serverPublicKeyPem = store.serverSigner?.publicKeyPem ?? null;
    if (!serverKeyId || !serverPublicKeyPem) return;

    const already =
      existing.some((e) => e?.type === "SERVER_SIGNER_KEY_REGISTERED" && String(e?.payload?.keyId ?? "") === String(serverKeyId)) ||
      existing.some((e) => e?.type === "SERVER_SIGNER_KEY_ROTATED" && String(e?.payload?.newKeyId ?? "") === String(serverKeyId));
    if (already) return;

    const payload = validateServerSignerKeyRegisteredPayload({
      tenantId: globalTenantId,
      keyId: String(serverKeyId),
      publicKeyPem: String(serverPublicKeyPem),
      registeredAt: nowAt,
      reason: "bootstrap"
    });
    const draft = createChainedEvent({
      streamId: GOVERNANCE_STREAM_ID,
      type: "SERVER_SIGNER_KEY_REGISTERED",
      at: payload.registeredAt,
      actor: { type: "ops", id: "bootstrap" },
      payload,
      id: `evt_bootstrap_server_signer_registered_${String(serverKeyId)}`
    });
    const next = appendChainedEvent({ events: existing, event: draft, signer: store.serverSigner });
    const event = next[next.length - 1];
    store.commitTx({ at: nowAt, ops: [{ kind: "MONTH_EVENTS_APPENDED", tenantId: globalTenantId, monthId: GOVERNANCE_STREAM_ID, events: [event] }] });
  })();

  return store;
}
