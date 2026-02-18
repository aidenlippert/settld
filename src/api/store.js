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

const SERVER_SIGNER_FILENAME = "server-signer.json";
const SETTLD_PAY_KEYSET_STORE_FILENAME = "settld-pay-keyset-store.json";

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function normalizeSettldPayPreviousRows(rows) {
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const publicKeyPem = typeof row.publicKeyPem === "string" ? row.publicKeyPem : "";
    if (!publicKeyPem.trim()) continue;
    const derivedKeyId = keyIdFromPublicKeyPem(publicKeyPem);
    const keyId = typeof row.keyId === "string" && row.keyId.trim() !== "" ? row.keyId.trim() : derivedKeyId;
    if (keyId !== derivedKeyId) throw new Error("invalid settld-pay-keyset-store.json: previous[].keyId mismatch");
    if (seen.has(keyId)) continue;
    seen.add(keyId);
    const rotatedAt = typeof row.rotatedAt === "string" && row.rotatedAt.trim() !== "" ? row.rotatedAt.trim() : null;
    out.push({ keyId, publicKeyPem, rotatedAt });
  }
  return out;
}

function normalizeSettldPayKeysetStore(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid settld-pay-keyset-store.json: object expected");
  }
  const active = payload.active;
  if (!active || typeof active !== "object" || Array.isArray(active)) {
    throw new Error("invalid settld-pay-keyset-store.json: active key missing");
  }
  const activePublicKeyPem = typeof active.publicKeyPem === "string" ? active.publicKeyPem : "";
  const activePrivateKeyPem = typeof active.privateKeyPem === "string" ? active.privateKeyPem : "";
  if (!activePublicKeyPem.trim() || !activePrivateKeyPem.trim()) {
    throw new Error("invalid settld-pay-keyset-store.json: active keypair missing");
  }
  const activeDerivedKeyId = keyIdFromPublicKeyPem(activePublicKeyPem);
  const activeKeyId = typeof active.keyId === "string" && active.keyId.trim() !== "" ? active.keyId.trim() : activeDerivedKeyId;
  if (activeKeyId !== activeDerivedKeyId) throw new Error("invalid settld-pay-keyset-store.json: active.keyId mismatch");

  const previous = normalizeSettldPayPreviousRows(payload.previous);
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
  const keysetStorePath = path.join(persistenceDir, SETTLD_PAY_KEYSET_STORE_FILENAME);
  const signerPath = path.join(persistenceDir, SERVER_SIGNER_FILENAME);
  if (fs.existsSync(keysetStorePath)) {
    const parsed = readJsonFileSafe(keysetStorePath);
    const normalized = normalizeSettldPayKeysetStore(parsed);
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
    agentWallets: new Map(), // `${tenantId}\n${agentId}` -> AgentWallet.v1 record
    agentRuns: new Map(), // `${tenantId}\n${runId}` -> AgentRun.v1 snapshot
    agentRunEvents: new Map(), // `${tenantId}\n${runId}` -> AgentEvent.v1[]
    agentRunSettlements: new Map(), // `${tenantId}\n${runId}` -> AgentRunSettlement.v1
    arbitrationCases: new Map(), // `${tenantId}\n${caseId}` -> ArbitrationCase.v1 snapshot
    agreementDelegations: new Map(), // `${tenantId}\n${delegationId}` -> AgreementDelegation.v1
    x402Gates: new Map(), // `${tenantId}\n${gateId}` -> X402 gate record (internal API surface)
    toolCallHolds: new Map(), // `${tenantId}\n${holdHash}` -> FundingHold.v1 snapshot
    settlementAdjustments: new Map(), // `${tenantId}\n${adjustmentId}` -> SettlementAdjustment.v1 snapshot
    moneyRailOperations: new Map(), // `${tenantId}\n${providerId}\n${operationId}` -> MoneyRailOperation.v1
    moneyRailProviderEvents: new Map(), // `${tenantId}\n${providerId}\n${operationId}\n${eventType}\n${eventDedupeKey}` -> MoneyRailProviderEvent.v1
    billableUsageEvents: new Map(), // `${tenantId}\n${eventKey}` -> BillableUsageEvent.v1
    financeReconciliationTriages: new Map(), // `${tenantId}\n${triageKey}` -> FinanceReconciliationTriage.v1
    marketplaceRfqs: new Map(), // `${tenantId}\n${rfqId}` -> MarketplaceRfq.v1
    marketplaceRfqBids: new Map(), // `${tenantId}\n${rfqId}` -> MarketplaceBid.v1[]
    marketplaceProviderPublications: new Map(), // `${tenantId}\n${providerId}` -> MarketplaceProviderPublication.v1
    tenantSettlementPolicies: new Map(), // `${tenantId}\n${policyId}\n${policyVersion}` -> TenantSettlementPolicy.v1
    tenantSettlementPolicyRollouts: new Map(), // `${tenantId}\nrollout` -> TenantSettlementPolicyRollout.v1
	    contracts: new Map(), // `${tenantId}\n${contractId}` -> contract
	    idempotency: new Map(),
	    publicKeyByKeyId,
	    serverSigner: { keyId: serverKeyId, publicKeyPem: serverPublicKeyPem, privateKeyPem: serverPrivateKeyPem },
      settldPayFallbackKeys: loadedServerSigner.previous.map((row) => ({ keyId: row.keyId, publicKeyPem: row.publicKeyPem })),
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
    const capabilities = [...new Set(capabilitiesIn.map((value) => String(value ?? "").trim()).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right)
    );

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

  function toX402ReceiptRecord({ tenantId, gate } = {}) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) return null;
    const runId = typeof gate.runId === "string" && gate.runId.trim() !== "" ? gate.runId.trim() : null;
    const settlement =
      runId && store.agentRunSettlements instanceof Map
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
    const bindings = decisionTrace?.bindings && typeof decisionTrace.bindings === "object" && !Array.isArray(decisionTrace.bindings) ? decisionTrace.bindings : null;
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
    return {
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
      reversal:
        gate?.reversal && typeof gate.reversal === "object" && !Array.isArray(gate.reversal)
          ? gate.reversal
          : null,
      decisionRecord:
        decisionTrace?.decisionRecord && typeof decisionTrace.decisionRecord === "object" && !Array.isArray(decisionTrace.decisionRecord)
          ? decisionTrace.decisionRecord
          : null,
      settlementReceipt
    };
  }

  store.getX402Receipt = async function getX402Receipt({ tenantId = DEFAULT_TENANT_ID, receiptId } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (typeof receiptId !== "string" || receiptId.trim() === "") throw new TypeError("receiptId is required");
    const wanted = receiptId.trim();
    for (const gate of store.x402Gates.values()) {
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
      if (normalizeTenantId(gate.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      const receipt = toX402ReceiptRecord({ tenantId, gate });
      if (!receipt) continue;
      if (String(receipt.receiptId ?? "") === wanted) return receipt;
    }
    return null;
  };

  store.listX402Receipts = async function listX402Receipts({
    tenantId = DEFAULT_TENANT_ID,
    agentId = null,
    sponsorId = null,
    toolId = null,
    state = null,
    from = null,
    to = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId);
    if (agentId !== null && (typeof agentId !== "string" || agentId.trim() === "")) throw new TypeError("agentId must be null or a non-empty string");
    if (sponsorId !== null && (typeof sponsorId !== "string" || sponsorId.trim() === "")) throw new TypeError("sponsorId must be null or a non-empty string");
    if (toolId !== null && (typeof toolId !== "string" || toolId.trim() === "")) throw new TypeError("toolId must be null or a non-empty string");
    if (state !== null && (typeof state !== "string" || state.trim() === "")) throw new TypeError("state must be null or a non-empty string");
    if (from !== null && !Number.isFinite(Date.parse(String(from)))) throw new TypeError("from must be null or an ISO date-time");
    if (to !== null && !Number.isFinite(Date.parse(String(to)))) throw new TypeError("to must be null or an ISO date-time");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const normalizedAgentId = agentId ? agentId.trim() : null;
    const normalizedSponsorId = sponsorId ? sponsorId.trim() : null;
    const normalizedToolId = toolId ? toolId.trim() : null;
    const normalizedState = state ? state.trim().toLowerCase() : null;
    const fromMs = from ? Date.parse(String(from)) : null;
    const toMs = to ? Date.parse(String(to)) : null;
    const out = [];

    for (const gate of store.x402Gates.values()) {
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
      if (normalizeTenantId(gate.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      const receipt = toX402ReceiptRecord({ tenantId, gate });
      if (!receipt) continue;
      if (
        normalizedAgentId &&
        String(receipt.payerAgentId ?? "") !== normalizedAgentId &&
        String(receipt.providerId ?? "") !== normalizedAgentId &&
        String(receipt.agentKeyId ?? "") !== normalizedAgentId
      ) {
        continue;
      }
      if (normalizedSponsorId && String(receipt.sponsorRef ?? "") !== normalizedSponsorId) continue;
      if (normalizedToolId && String(receipt.toolId ?? "") !== normalizedToolId) continue;
      if (normalizedState && String(receipt.settlementState ?? "").toLowerCase() !== normalizedState) continue;
      const settledAtMs = Number.isFinite(Date.parse(String(receipt.settledAt ?? ""))) ? Date.parse(String(receipt.settledAt)) : Number.NaN;
      if (fromMs !== null && (!Number.isFinite(settledAtMs) || settledAtMs < fromMs)) continue;
      if (toMs !== null && (!Number.isFinite(settledAtMs) || settledAtMs > toMs)) continue;
      out.push(receipt);
    }

    out.sort((left, right) => {
      const leftMs = Number.isFinite(Date.parse(String(left?.settledAt ?? ""))) ? Date.parse(String(left.settledAt)) : Number.NaN;
      const rightMs = Number.isFinite(Date.parse(String(right?.settledAt ?? ""))) ? Date.parse(String(right.settledAt)) : Number.NaN;
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return rightMs - leftMs;
      return String(left?.receiptId ?? "").localeCompare(String(right?.receiptId ?? ""));
    });
    return out.slice(offset, offset + Math.min(1000, limit));
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

  store.listArtifacts = async function listArtifacts({ tenantId = DEFAULT_TENANT_ID, jobId = null, jobIds = null, artifactType = null, sourceEventId = null } = {}) {
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
    const all = [];
    const sourceFilter = typeof sourceEventId === "string" && sourceEventId.trim() !== "" ? String(sourceEventId) : null;
    const typeFilter = typeof artifactType === "string" && artifactType.trim() !== "" ? String(artifactType) : null;
    for (const art of store.artifacts.values()) {
      if (!art || typeof art !== "object") continue;
      if (normalizeTenantId(art.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
      if (jobId !== null && String(art.jobId ?? "") !== String(jobId)) continue;
      if (jobIdSet && !jobIdSet.has(String(art.jobId ?? ""))) continue;
      if (typeFilter !== null && String(art.artifactType ?? art.schemaVersion ?? "") !== typeFilter) continue;
      if (sourceFilter !== null && String(art.sourceEventId ?? "") !== sourceFilter) continue;
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
