import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore as createMemoryStore } from "../api/store.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../core/crypto.js";
import { reduceJob } from "../core/job-reducer.js";
import { reduceRobot } from "../core/robot-reducer.js";
import { reduceOperator } from "../core/operator-reducer.js";
import { MONTH_CLOSE_BASIS, makeMonthCloseStreamId, reduceMonthClose, validateMonthClosedPayload } from "../core/month-close.js";
import { AGENT_RUN_EVENT_SCHEMA_VERSION, reduceAgentRun } from "../core/agent-runs.js";
import { normalizeInteractionDirection } from "../core/interaction-directions.js";
import { makeIdempotencyStoreKey, parseIdempotencyStoreKey } from "../core/idempotency.js";
import { DEFAULT_TENANT_ID, makeScopedKey, normalizeTenantId } from "../core/tenancy.js";
import { GOVERNANCE_STREAM_ID, validateServerSignerKeyRegisteredPayload } from "../core/governance.js";
import { applyTxRecord, TX_LOG_VERSION } from "../api/persistence.js";
import { applyJournalEntry } from "../core/ledger.js";
import { createDefaultContract } from "../core/contracts.js";
import { normalizeSignerKeyPurpose, normalizeSignerKeyStatus } from "../core/signer-keys.js";
import { allocateEntry } from "../core/allocations.js";
import { computeMonthlyStatement, parseYearMonth } from "../core/statements.js";
import { computeFinanceAccountMapHash, validateFinanceAccountMapV1 } from "../core/finance-account-map.js";
import { computeGlBatchBodyV1 } from "../core/gl-batch.js";
import { renderJournalCsvV1 } from "../core/journal-csv.js";
import { canonicalJsonStringify } from "../core/canonical-json.js";
import { buildDeterministicZipStore, sha256HexBytes } from "../core/deterministic-zip.js";
import { buildFinancePackBundleV1 } from "../core/finance-pack-bundle.js";
import { buildMonthProofBundleV1 } from "../core/proof-bundle.js";
import {
  ARTIFACT_TYPE,
  buildMonthlyStatementV1,
  buildPartyStatementV1,
  buildPayoutInstructionV1,
  buildJournalCsvV1,
  buildGlBatchV1,
  buildFinancePackBundlePointerV1,
  computeArtifactHash,
  sliceEventsThroughChainHash
} from "../core/artifacts.js";
import { createChainedEvent, appendChainedEvent } from "../core/event-chain.js";
import { computePartyStatement, computePayoutAmountCentsForStatement, jobIdFromLedgerMemo, payoutKeyFor } from "../core/party-statements.js";
import { failpoint } from "../core/failpoints.js";
import { logger } from "../core/log.js";
import { clampQuota } from "../core/quotas.js";
import { reconcileGlBatchAgainstPartyStatements } from "../../packages/artifact-verify/src/index.js";

import { createPgPool, quoteIdent } from "./pg.js";
import { migratePg } from "./migrate.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function safeSchemaName(name) {
  assertNonEmptyString(name, "schema");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new TypeError("schema must match /^[a-zA-Z_][a-zA-Z0-9_]*$/");
  }
  return name;
}

function reclaimAfterSecondsFromEnv({ fallbackSeconds = 60 } = {}) {
  const raw = typeof process !== "undefined" ? (process.env.PROXY_RECLAIM_AFTER_SECONDS ?? null) : null;
  if (raw === null || raw === undefined) return fallbackSeconds;
  const text = String(raw).trim();
  if (!text) return fallbackSeconds;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError("PROXY_RECLAIM_AFTER_SECONDS must be a positive number");
  return Math.floor(n);
}

function outboxMaxAttemptsFromEnv({ fallbackAttempts = 25 } = {}) {
  const raw = typeof process !== "undefined" ? (process.env.PROXY_OUTBOX_MAX_ATTEMPTS ?? null) : null;
  if (raw === null || raw === undefined) return fallbackAttempts;
  const text = String(raw).trim();
  if (!text) return fallbackAttempts;
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) throw new TypeError("PROXY_OUTBOX_MAX_ATTEMPTS must be a positive integer");
  return n;
}

function workerStatementTimeoutMsFromEnv({ fallbackMs = 0 } = {}) {
  const raw = typeof process !== "undefined" ? (process.env.PROXY_PG_WORKER_STATEMENT_TIMEOUT_MS ?? null) : null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) {
    throw new TypeError("PROXY_PG_WORKER_STATEMENT_TIMEOUT_MS must be a non-negative safe integer");
  }
  return Math.min(60_000, Math.floor(n));
}

function migrationsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "migrations");
}

export class PgIdempotencyConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "PgIdempotencyConflictError";
  }
}

export async function createPgStore({ databaseUrl, schema = "public", dropSchemaOnClose = false, migrateOnStartup = true } = {}) {
  assertNonEmptyString(databaseUrl, "databaseUrl");
  schema = safeSchemaName(schema);

  const pool = await createPgPool({ databaseUrl, schema });
  if (migrateOnStartup) {
    await migratePg({ pool, migrationsDir: migrationsDir() });
  }

  const store = createMemoryStore({ persistenceDir: null });
  store.kind = "pg";
  store.pg = { pool, schema, dropSchemaOnClose, databaseUrl };
  store.persistence = null;

  // Server signer is stored in Postgres.
  const signerRow = await pool.query("SELECT public_key_pem, private_key_pem FROM server_signer WHERE id = 1");
  let serverPublicKeyPem;
  let serverPrivateKeyPem;
  if (signerRow.rows.length) {
    serverPublicKeyPem = signerRow.rows[0].public_key_pem;
    serverPrivateKeyPem = signerRow.rows[0].private_key_pem;
  } else {
    const kp = createEd25519Keypair();
    serverPublicKeyPem = kp.publicKeyPem;
    serverPrivateKeyPem = kp.privateKeyPem;
    await pool.query("INSERT INTO server_signer (id, public_key_pem, private_key_pem) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING", [
      serverPublicKeyPem,
      serverPrivateKeyPem
    ]);
    const reloaded = await pool.query("SELECT public_key_pem, private_key_pem FROM server_signer WHERE id = 1");
    if (!reloaded.rows.length) throw new Error("failed to initialize server signer");
    serverPublicKeyPem = reloaded.rows[0].public_key_pem;
    serverPrivateKeyPem = reloaded.rows[0].private_key_pem;
  }
  const serverKeyId = keyIdFromPublicKeyPem(serverPublicKeyPem);
  store.serverSigner = { keyId: serverKeyId, publicKeyPem: serverPublicKeyPem, privateKeyPem: serverPrivateKeyPem };
  store.publicKeyByKeyId.set(serverKeyId, serverPublicKeyPem);

  // Public keys.
  const keysRes = await pool.query("SELECT key_id, public_key_pem FROM public_keys");
  for (const row of keysRes.rows) {
    if (!row?.key_id || !row?.public_key_pem) continue;
    store.publicKeyByKeyId.set(String(row.key_id), String(row.public_key_pem));
  }

  async function refreshSnapshots() {
    store.jobs.clear();
    store.robots.clear();
    store.operators.clear();
    store.months.clear();
    if (!(store.agentRuns instanceof Map)) store.agentRuns = new Map();
    store.agentRuns.clear();
    if (!(store.arbitrationCases instanceof Map)) store.arbitrationCases = new Map();
    store.arbitrationCases.clear();
    if (!(store.agreementDelegations instanceof Map)) store.agreementDelegations = new Map();
    store.agreementDelegations.clear();
    if (!(store.x402Gates instanceof Map)) store.x402Gates = new Map();
    store.x402Gates.clear();
    if (!(store.toolCallHolds instanceof Map)) store.toolCallHolds = new Map();
    store.toolCallHolds.clear();
    if (!(store.settlementAdjustments instanceof Map)) store.settlementAdjustments = new Map();
    store.settlementAdjustments.clear();

    const res = await pool.query("SELECT tenant_id, aggregate_type, aggregate_id, snapshot_json FROM snapshots");
    for (const row of res.rows) {
      const tenantId = normalizeTenantId(row.tenant_id ?? DEFAULT_TENANT_ID);
      const type = row.aggregate_type;
      const id = row.aggregate_id;
      const snap = row.snapshot_json;
      if (!type || !id || !snap) continue;
      const key = makeScopedKey({ tenantId, id: String(id) });
      if (type === "job") store.jobs.set(key, { ...snap, tenantId: snap?.tenantId ?? tenantId });
      if (type === "robot") store.robots.set(key, { ...snap, tenantId: snap?.tenantId ?? tenantId });
      if (type === "operator") store.operators.set(key, { ...snap, tenantId: snap?.tenantId ?? tenantId });
      if (type === "month") store.months.set(key, { ...snap, tenantId: snap?.tenantId ?? tenantId });
      if (type === "agent_run") store.agentRuns.set(key, { ...snap, tenantId: snap?.tenantId ?? tenantId, runId: snap?.runId ?? String(id) });
      if (type === "arbitration_case") {
        store.arbitrationCases.set(key, {
          ...snap,
          tenantId: snap?.tenantId ?? tenantId,
          caseId: snap?.caseId ?? String(id)
        });
      }
      if (type === "agreement_delegation") {
        store.agreementDelegations.set(key, {
          ...snap,
          tenantId: snap?.tenantId ?? tenantId,
          delegationId: snap?.delegationId ?? String(id)
        });
      }
      if (type === "x402_gate") {
        store.x402Gates.set(key, {
          ...snap,
          tenantId: snap?.tenantId ?? tenantId,
          gateId: snap?.gateId ?? String(id)
        });
      }
      if (type === "tool_call_hold") {
        store.toolCallHolds.set(key, {
          ...snap,
          tenantId: snap?.tenantId ?? tenantId,
          holdHash: snap?.holdHash ?? String(id)
        });
      }
      if (type === "settlement_adjustment") {
        store.settlementAdjustments.set(key, {
          ...snap,
          tenantId: snap?.tenantId ?? tenantId,
          adjustmentId: snap?.adjustmentId ?? String(id)
        });
      }
    }
  }

  async function refreshEvents() {
    store.jobEvents.clear();
    store.robotEvents.clear();
    store.operatorEvents.clear();
    store.monthEvents.clear();
    if (!(store.agentRunEvents instanceof Map)) store.agentRunEvents = new Map();
    store.agentRunEvents.clear();

    const res = await pool.query(
      "SELECT tenant_id, aggregate_type, aggregate_id, event_json FROM events ORDER BY tenant_id, aggregate_type, aggregate_id, seq ASC"
    );
    for (const row of res.rows) {
      const tenantId = normalizeTenantId(row.tenant_id ?? DEFAULT_TENANT_ID);
      const type = row.aggregate_type;
      const id = row.aggregate_id;
      const event = row.event_json;
      if (!type || !id || !event) continue;
      const key = makeScopedKey({ tenantId, id: String(id) });

      if (type === "job") {
        const existing = store.jobEvents.get(key) ?? [];
        store.jobEvents.set(key, [...existing, event]);
      }
      if (type === "robot") {
        const existing = store.robotEvents.get(key) ?? [];
        store.robotEvents.set(key, [...existing, event]);
      }
      if (type === "operator") {
        const existing = store.operatorEvents.get(key) ?? [];
        store.operatorEvents.set(key, [...existing, event]);
      }
      if (type === "month") {
        const existing = store.monthEvents.get(key) ?? [];
        store.monthEvents.set(key, [...existing, event]);
      }
      if (type === "agent_run") {
        const existing = store.agentRunEvents.get(key) ?? [];
        store.agentRunEvents.set(key, [...existing, normalizeAgentRunEventRecord(event)]);
      }
    }
  }

  async function refreshIdempotency() {
    store.idempotency.clear();
    const res = await pool.query("SELECT tenant_id, principal_id, endpoint, idem_key, request_hash, status_code, response_json FROM idempotency");
    for (const row of res.rows) {
      const tenantId = normalizeTenantId(row?.tenant_id ?? DEFAULT_TENANT_ID);
      const principalId = row?.principal_id ? String(row.principal_id) : null;
      const endpoint = row?.endpoint ? String(row.endpoint) : null;
      const idemKey = row?.idem_key ? String(row.idem_key) : null;
      if (!principalId || !endpoint || !idemKey) continue;
      const storeKey = makeIdempotencyStoreKey({ tenantId, principalId, endpoint, idempotencyKey: idemKey });
      store.idempotency.set(storeKey, {
        requestHash: String(row.request_hash),
        statusCode: Number(row.status_code),
        body: row.response_json
      });
    }
  }

  async function refreshLedgerBalances() {
    // Reset in-memory balances, then hydrate from DB. (Entries are not hydrated here.)
    if (store.ledgerByTenant instanceof Map) {
      for (const ledger of store.ledgerByTenant.values()) {
        if (!ledger?.balances) continue;
        for (const accountId of ledger.balances.keys()) ledger.balances.set(accountId, 0);
      }
    } else if (store.ledger?.balances instanceof Map) {
      for (const accountId of store.ledger.balances.keys()) store.ledger.balances.set(accountId, 0);
    }

    const res = await pool.query("SELECT tenant_id, account_id, balance_cents FROM ledger_balances");
    for (const row of res.rows) {
      if (!row?.account_id) continue;
      const tenantId = normalizeTenantId(row.tenant_id ?? DEFAULT_TENANT_ID);
      const ledger = typeof store.getLedger === "function" ? store.getLedger(tenantId) : store.ledger;
      ledger.balances.set(String(row.account_id), Number(row.balance_cents));
    }
  }

  async function refreshContracts() {
    if (!(store.contracts instanceof Map)) store.contracts = new Map();
    store.contracts.clear();
    const res = await pool.query("SELECT tenant_id, contract_id, contract_json FROM contracts");
    for (const row of res.rows) {
      const tenantId = normalizeTenantId(row?.tenant_id ?? DEFAULT_TENANT_ID);
      const contractId = row?.contract_id ? String(row.contract_id) : null;
      const contract = row?.contract_json ?? null;
      if (!contractId || !contract) continue;
      const key = makeScopedKey({ tenantId, id: contractId });
      store.contracts.set(key, { ...contract, tenantId, contractId });
    }
  }

  async function refreshTenantBillingConfigs() {
    try {
      const res = await pool.query("SELECT tenant_id, billing_json FROM tenant_billing_config ORDER BY tenant_id ASC");
      for (const row of res.rows) {
        const tenantId = normalizeTenantId(row?.tenant_id ?? DEFAULT_TENANT_ID);
        const billing = row?.billing_json ?? null;
        if (!billing || typeof billing !== "object" || Array.isArray(billing)) continue;
        store.ensureTenant(tenantId);
        const cfg = store.getConfig(tenantId);
        if (!cfg || typeof cfg !== "object") continue;
        cfg.billing = JSON.parse(JSON.stringify(billing));
      }
    } catch (err) {
      if (err?.code === "42P01") return;
      throw err;
    }
  }

  async function persistTenantBillingConfig(client, { tenantId = DEFAULT_TENANT_ID, billing } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!billing || typeof billing !== "object" || Array.isArray(billing)) {
      throw new TypeError("billing config is required");
    }
    const normalizedBilling = JSON.parse(JSON.stringify(billing));
    await client.query(
      `
        INSERT INTO tenant_billing_config (tenant_id, billing_json, updated_at)
        VALUES ($1,$2, now())
        ON CONFLICT (tenant_id) DO UPDATE SET
          billing_json = EXCLUDED.billing_json,
          updated_at = now()
      `,
      [tenantId, JSON.stringify(normalizedBilling)]
    );
  }

  function parseIsoOrNull(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const ms = Date.parse(String(value));
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  }

  function parseSafeIntegerOrNull(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }

  function moneyRailOperationMapKey({ tenantId, providerId, operationId }) {
    return `${normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID)}\n${String(providerId)}\n${String(operationId)}`;
  }

  function moneyRailProviderEventMapKey({ tenantId, providerId, operationId, eventType, eventDedupeKey }) {
    return `${normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID)}\n${String(providerId)}\n${String(operationId)}\n${String(eventType)}\n${String(eventDedupeKey)}`;
  }

  function billableUsageEventMapKey({ tenantId, eventKey }) {
    return `${normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID)}\n${String(eventKey)}`;
  }

  function moneyRailOperationRowToRecord(row) {
    if (!row) return null;
    const operation = row?.operation_json ?? null;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? operation?.tenantId ?? DEFAULT_TENANT_ID);
    const providerId = row?.provider_id ? String(row.provider_id) : operation?.providerId ? String(operation.providerId) : null;
    const operationId = row?.operation_id ? String(row.operation_id) : operation?.operationId ? String(operation.operationId) : null;
    if (!providerId || !operationId) return null;

    return {
      ...operation,
      tenantId,
      providerId,
      operationId,
      direction: operation?.direction ? String(operation.direction).toLowerCase() : row?.direction ? String(row.direction).toLowerCase() : null,
      idempotencyKey:
        operation?.idempotencyKey && String(operation.idempotencyKey).trim() !== ""
          ? String(operation.idempotencyKey)
          : row?.idempotency_key
            ? String(row.idempotency_key)
            : null,
      amountCents: parseSafeIntegerOrNull(operation?.amountCents ?? row?.amount_cents),
      currency:
        operation?.currency && String(operation.currency).trim() !== ""
          ? String(operation.currency).toUpperCase()
          : row?.currency
            ? String(row.currency).toUpperCase()
            : "USD",
      counterpartyRef:
        operation?.counterpartyRef && String(operation.counterpartyRef).trim() !== ""
          ? String(operation.counterpartyRef)
          : row?.counterparty_ref
            ? String(row.counterparty_ref)
            : null,
      state: operation?.state ? String(operation.state).toLowerCase() : row?.state ? String(row.state).toLowerCase() : null,
      providerRef:
        operation?.providerRef !== undefined
          ? operation.providerRef
          : row?.provider_ref !== undefined
            ? row.provider_ref
            : null,
      reasonCode:
        operation?.reasonCode !== undefined
          ? operation.reasonCode
          : row?.reason_code !== undefined
            ? row.reason_code
            : null,
      initiatedAt: parseIsoOrNull(operation?.initiatedAt ?? row?.initiated_at),
      submittedAt: parseIsoOrNull(operation?.submittedAt ?? row?.submitted_at),
      confirmedAt: parseIsoOrNull(operation?.confirmedAt ?? row?.confirmed_at),
      failedAt: parseIsoOrNull(operation?.failedAt ?? row?.failed_at),
      cancelledAt: parseIsoOrNull(operation?.cancelledAt ?? row?.cancelled_at),
      reversedAt: parseIsoOrNull(operation?.reversedAt ?? row?.reversed_at),
      createdAt: parseIsoOrNull(operation?.createdAt ?? row?.created_at) ?? new Date(0).toISOString(),
      updatedAt: parseIsoOrNull(operation?.updatedAt ?? row?.updated_at) ?? new Date(0).toISOString(),
      metadata:
        operation?.metadata && typeof operation.metadata === "object" && !Array.isArray(operation.metadata)
          ? operation.metadata
          : row?.metadata_json ?? null,
      requestHash:
        operation?.requestHash && String(operation.requestHash).trim() !== ""
          ? String(operation.requestHash)
          : row?.request_hash
            ? String(row.request_hash)
            : null
    };
  }

  function moneyRailProviderEventRowToRecord(row) {
    if (!row) return null;
    const event = row?.event_json ?? null;
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? event?.tenantId ?? DEFAULT_TENANT_ID);
    const providerId = row?.provider_id ? String(row.provider_id) : event?.providerId ? String(event.providerId) : null;
    const operationId = row?.operation_id ? String(row.operation_id) : event?.operationId ? String(event.operationId) : null;
    const eventType = row?.event_type ? String(row.event_type).toLowerCase() : event?.eventType ? String(event.eventType).toLowerCase() : null;
    const eventDedupeKey =
      row?.event_dedupe_key && String(row.event_dedupe_key).trim() !== ""
        ? String(row.event_dedupe_key)
        : event?.eventDedupeKey && String(event.eventDedupeKey).trim() !== ""
          ? String(event.eventDedupeKey)
          : null;
    if (!providerId || !operationId || !eventType || !eventDedupeKey) return null;
    return {
      ...event,
      tenantId,
      providerId,
      operationId,
      eventType,
      eventDedupeKey,
      eventId:
        event?.eventId === null || event?.eventId === undefined
          ? row?.event_id ?? null
          : String(event.eventId),
      at: parseIsoOrNull(event?.at ?? row?.at),
      payload:
        event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? event.payload
          : row?.payload_json ?? null,
      createdAt: parseIsoOrNull(event?.createdAt ?? row?.created_at) ?? new Date(0).toISOString()
    };
  }

  function billableUsageEventRowToRecord(row) {
    if (!row) return null;
    const event = row?.event_json ?? null;
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? event?.tenantId ?? DEFAULT_TENANT_ID);
    const eventKey = row?.event_key ? String(row.event_key) : event?.eventKey ? String(event.eventKey) : null;
    if (!eventKey) return null;

    const occurredAt = parseIsoOrNull(event?.occurredAt ?? row?.occurred_at) ?? new Date(0).toISOString();
    const period =
      event?.period && /^\d{4}-\d{2}$/.test(String(event.period).trim())
        ? String(event.period).trim()
        : row?.period && /^\d{4}-\d{2}$/.test(String(row.period).trim())
          ? String(row.period).trim()
          : occurredAt.slice(0, 7);
    return {
      ...event,
      tenantId,
      eventKey,
      eventType:
        event?.eventType && String(event.eventType).trim() !== ""
          ? String(event.eventType).toLowerCase()
          : row?.event_type
            ? String(row.event_type).toLowerCase()
            : null,
      period,
      occurredAt,
      quantity: parseSafeIntegerOrNull(event?.quantity ?? row?.quantity) ?? 0,
      amountCents: parseSafeIntegerOrNull(event?.amountCents ?? row?.amount_cents),
      currency:
        event?.currency && String(event.currency).trim() !== ""
          ? String(event.currency).toUpperCase()
          : row?.currency
            ? String(row.currency).toUpperCase()
            : null,
      runId: event?.runId ?? row?.run_id ?? null,
      settlementId: event?.settlementId ?? row?.settlement_id ?? null,
      disputeId: event?.disputeId ?? row?.dispute_id ?? null,
      arbitrationCaseId: event?.arbitrationCaseId ?? row?.arbitration_case_id ?? null,
      sourceType: event?.sourceType ?? row?.source_type ?? null,
      sourceId: event?.sourceId ?? row?.source_id ?? null,
      sourceEventId: event?.sourceEventId ?? row?.source_event_id ?? null,
      eventHash:
        event?.eventHash && String(event.eventHash).trim() !== ""
          ? String(event.eventHash)
          : row?.event_hash
            ? String(row.event_hash)
            : null,
      audit:
        event?.audit && typeof event.audit === "object" && !Array.isArray(event.audit)
          ? event.audit
          : row?.audit_json ?? null,
      createdAt: parseIsoOrNull(event?.createdAt ?? row?.created_at) ?? new Date(0).toISOString()
    };
  }

  function normalizeMarketplaceDirectionForRead({ fromType, toType }) {
    return normalizeInteractionDirection({
      fromType,
      toType,
      defaultFromType: "agent",
      defaultToType: "agent",
      onInvalid: "fallback"
    });
  }

  function normalizeMarketplaceDirectionForWrite({ fromType, toType }) {
    return normalizeInteractionDirection({
      fromType,
      toType,
      defaultFromType: "agent",
      defaultToType: "agent"
    });
  }

  function normalizeAgentRunEventRecord(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return event;
    if (event.schemaVersion === AGENT_RUN_EVENT_SCHEMA_VERSION) return event;
    return { ...event, schemaVersion: AGENT_RUN_EVENT_SCHEMA_VERSION };
  }

  function marketplaceTaskRowToRecord(row) {
    const task = row?.rfq_json ?? null;
    if (!task || typeof task !== "object" || Array.isArray(task)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? task?.tenantId ?? DEFAULT_TENANT_ID);
    const rfqId = row?.rfq_id ? String(row.rfq_id) : task?.rfqId ? String(task.rfqId) : null;
    if (!rfqId) return null;

    const createdAt = parseIsoOrNull(task?.createdAt ?? row?.created_at) ?? new Date(0).toISOString();
    const updatedAt = parseIsoOrNull(task?.updatedAt ?? row?.updated_at) ?? createdAt;
    const direction = normalizeMarketplaceDirectionForRead({
      fromType: task?.fromType,
      toType: task?.toType
    });
    return {
      ...task,
      tenantId,
      rfqId,
      fromType: direction.fromType,
      toType: direction.toType,
      status: task?.status ? String(task.status) : row?.status ? String(row.status) : "open",
      capability: task?.capability ?? row?.capability ?? null,
      posterAgentId: task?.posterAgentId ?? row?.poster_agent_id ?? null,
      createdAt,
      updatedAt
    };
  }

  async function refreshMarketplaceRfqs() {
    if (!(store.marketplaceRfqs instanceof Map)) store.marketplaceRfqs = new Map();
    store.marketplaceRfqs.clear();
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, rfq_id, status, capability, poster_agent_id, created_at, updated_at, rfq_json
          FROM marketplace_rfqs
          ORDER BY tenant_id ASC, created_at DESC, rfq_id DESC
        `
      );
      for (const row of res.rows) {
        const record = marketplaceTaskRowToRecord(row);
        if (!record) continue;
        const key = makeScopedKey({ tenantId: record.tenantId, id: record.rfqId });
        store.marketplaceRfqs.set(key, record);
      }
    } catch (err) {
      if (err?.code === "42P01") return;
      throw err;
    }
  }

  function marketplaceBidRowToRecord(row) {
    const bid = row?.bid_json ?? null;
    if (!bid || typeof bid !== "object" || Array.isArray(bid)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? bid?.tenantId ?? DEFAULT_TENANT_ID);
    const rfqId = row?.rfq_id ? String(row.rfq_id) : bid?.rfqId ? String(bid.rfqId) : null;
    const bidId = row?.bid_id ? String(row.bid_id) : bid?.bidId ? String(bid.bidId) : null;
    if (!rfqId || !bidId) return null;

    let amountCents = null;
    const bidAmount = Number(bid?.amountCents);
    const rowAmount = Number(row?.amount_cents);
    if (Number.isSafeInteger(bidAmount)) amountCents = bidAmount;
    else if (Number.isSafeInteger(rowAmount)) amountCents = rowAmount;

    const createdAt = parseIsoOrNull(bid?.createdAt ?? row?.created_at) ?? new Date(0).toISOString();
    const updatedAt = parseIsoOrNull(bid?.updatedAt ?? row?.updated_at) ?? createdAt;
    const direction = normalizeMarketplaceDirectionForRead({
      fromType: bid?.fromType,
      toType: bid?.toType
    });
    return {
      ...bid,
      tenantId,
      rfqId,
      bidId,
      fromType: direction.fromType,
      toType: direction.toType,
      status: bid?.status ? String(bid.status) : row?.status ? String(row.status) : "pending",
      bidderAgentId: bid?.bidderAgentId ?? row?.bidder_agent_id ?? null,
      amountCents,
      createdAt,
      updatedAt
    };
  }

  async function refreshMarketplaceRfqBids() {
    if (!(store.marketplaceRfqBids instanceof Map)) store.marketplaceRfqBids = new Map();
    store.marketplaceRfqBids.clear();
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, rfq_id, bid_id, status, bidder_agent_id, amount_cents, created_at, updated_at, bid_json
          FROM marketplace_rfq_bids
          ORDER BY tenant_id ASC, rfq_id ASC, amount_cents ASC NULLS LAST, created_at ASC, bid_id ASC
        `
      );
      for (const row of res.rows) {
        const record = marketplaceBidRowToRecord(row);
        if (!record) continue;
        const key = makeScopedKey({ tenantId: record.tenantId, id: record.rfqId });
        const existing = store.marketplaceRfqBids.get(key) ?? [];
        store.marketplaceRfqBids.set(key, [...existing, record]);
      }
    } catch (err) {
      if (err?.code === "42P01") return;
      throw err;
    }
  }

  function tenantSettlementPolicyRowToRecord(row) {
    const policyRecord = row?.policy_json ?? null;
    if (!policyRecord || typeof policyRecord !== "object" || Array.isArray(policyRecord)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? policyRecord?.tenantId ?? DEFAULT_TENANT_ID);
    const policyId =
      row?.policy_id !== null && row?.policy_id !== undefined
        ? String(row.policy_id)
        : policyRecord?.policyId
          ? String(policyRecord.policyId)
          : null;
    const policyVersionCandidate = parseSafeIntegerOrNull(row?.policy_version ?? policyRecord?.policyVersion);
    if (!policyId || policyVersionCandidate === null || policyVersionCandidate <= 0) return null;

    const createdAt = parseIsoOrNull(policyRecord?.createdAt ?? row?.created_at) ?? new Date(0).toISOString();
    const updatedAt = parseIsoOrNull(policyRecord?.updatedAt ?? row?.updated_at) ?? createdAt;
    const policyHash = typeof (policyRecord?.policyHash ?? row?.policy_hash) === "string"
      ? String(policyRecord?.policyHash ?? row?.policy_hash)
      : null;
    const verificationMethodHash = typeof (policyRecord?.verificationMethodHash ?? row?.verification_method_hash) === "string"
      ? String(policyRecord?.verificationMethodHash ?? row?.verification_method_hash)
      : null;
    if (!policyHash || !verificationMethodHash) return null;
    return {
      ...policyRecord,
      tenantId,
      policyId,
      policyVersion: policyVersionCandidate,
      policyHash,
      verificationMethodHash,
      createdAt,
      updatedAt
    };
  }

  async function refreshTenantSettlementPolicies() {
    if (!(store.tenantSettlementPolicies instanceof Map)) store.tenantSettlementPolicies = new Map();
    store.tenantSettlementPolicies.clear();
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, policy_id, policy_version, policy_hash, verification_method_hash, created_at, updated_at, policy_json
          FROM tenant_settlement_policies
          ORDER BY tenant_id ASC, policy_id ASC, policy_version DESC
        `
      );
      for (const row of res.rows) {
        const record = tenantSettlementPolicyRowToRecord(row);
        if (!record) continue;
        const key = makeScopedKey({ tenantId: record.tenantId, id: `${record.policyId}::${record.policyVersion}` });
        store.tenantSettlementPolicies.set(key, record);
      }
    } catch (err) {
      if (err?.code === "42P01") return;
      throw err;
    }
  }

  function agentIdentityRowToRecord(row) {
    const identity = row?.identity_json ?? null;
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;

    const tenantId = normalizeTenantId(row?.tenant_id ?? identity?.tenantId ?? DEFAULT_TENANT_ID);
    const agentId = row?.agent_id ? String(row.agent_id) : identity?.agentId ? String(identity.agentId) : null;
    if (!agentId) return null;

    const createdAt = parseIsoOrNull(identity?.createdAt ?? row?.created_at) ?? new Date(0).toISOString();
    const updatedAt = parseIsoOrNull(identity?.updatedAt ?? row?.updated_at) ?? createdAt;
    const status = identity?.status ? String(identity.status) : row?.status ? String(row.status) : "active";
    const displayName = identity?.displayName ?? row?.display_name ?? null;
    const owner =
      identity?.owner && typeof identity.owner === "object" && !Array.isArray(identity.owner)
        ? { ...identity.owner }
        : row?.owner_type || row?.owner_id
          ? {
              ownerType: row?.owner_type ? String(row.owner_type) : null,
              ownerId: row?.owner_id ? String(row.owner_id) : null
            }
          : null;
    const revision = parseSafeIntegerOrNull(identity?.revision ?? row?.revision) ?? 0;

    return {
      ...identity,
      tenantId,
      agentId,
      status,
      displayName: displayName === null || displayName === undefined ? null : String(displayName),
      owner,
      revision,
      createdAt,
      updatedAt
    };
  }

  async function refreshAgentIdentities() {
    if (!(store.agentIdentities instanceof Map)) store.agentIdentities = new Map();
    store.agentIdentities.clear();
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, agent_id, status, display_name, owner_type, owner_id, revision, created_at, updated_at, identity_json
          FROM agent_identities
          ORDER BY tenant_id ASC, agent_id ASC
        `
      );
      for (const row of res.rows) {
        const record = agentIdentityRowToRecord(row);
        if (!record) continue;
        const key = makeScopedKey({ tenantId: record.tenantId, id: record.agentId });
        store.agentIdentities.set(key, record);
      }
    } catch (err) {
      if (err?.code === "42P01") return;
      throw err;
    }
  }

  async function persistAgentIdentity(client, { tenantId, agentIdentity }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!agentIdentity || typeof agentIdentity !== "object" || Array.isArray(agentIdentity)) {
      throw new TypeError("agentIdentity is required");
    }
    const agentId = agentIdentity.agentId ? String(agentIdentity.agentId) : null;
    if (!agentId) throw new TypeError("agentIdentity.agentId is required");

    const createdAt = parseIsoOrNull(agentIdentity.createdAt) ?? new Date().toISOString();
    const updatedAt = parseIsoOrNull(agentIdentity.updatedAt) ?? createdAt;
    const status = agentIdentity.status ? String(agentIdentity.status) : "active";
    const displayName =
      agentIdentity.displayName === null || agentIdentity.displayName === undefined ? null : String(agentIdentity.displayName);
    const ownerType =
      agentIdentity?.owner?.ownerType === null || agentIdentity?.owner?.ownerType === undefined
        ? null
        : String(agentIdentity.owner.ownerType);
    const ownerId =
      agentIdentity?.owner?.ownerId === null || agentIdentity?.owner?.ownerId === undefined
        ? null
        : String(agentIdentity.owner.ownerId);
    const revision = parseSafeIntegerOrNull(agentIdentity.revision) ?? 0;

    const normalizedIdentity = {
      ...agentIdentity,
      tenantId,
      agentId,
      status,
      displayName,
      owner:
        agentIdentity?.owner && typeof agentIdentity.owner === "object" && !Array.isArray(agentIdentity.owner)
          ? {
              ownerType: ownerType,
              ownerId: ownerId
            }
          : null,
      revision,
      createdAt,
      updatedAt
    };

    await client.query(
      `
        INSERT INTO agent_identities (
          tenant_id, agent_id, status, display_name, owner_type, owner_id, revision, created_at, updated_at, identity_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
          status = EXCLUDED.status,
          display_name = EXCLUDED.display_name,
          owner_type = EXCLUDED.owner_type,
          owner_id = EXCLUDED.owner_id,
          revision = EXCLUDED.revision,
          updated_at = EXCLUDED.updated_at,
          identity_json = EXCLUDED.identity_json
      `,
      [tenantId, agentId, status, displayName, ownerType, ownerId, revision, createdAt, updatedAt, JSON.stringify(normalizedIdentity)]
    );
  }

  function agentWalletRowToRecord(row) {
    const wallet = row?.wallet_json ?? null;
    if (!wallet || typeof wallet !== "object" || Array.isArray(wallet)) return null;

    const tenantId = normalizeTenantId(row?.tenant_id ?? wallet?.tenantId ?? DEFAULT_TENANT_ID);
    const agentId = row?.agent_id ? String(row.agent_id) : wallet?.agentId ? String(wallet.agentId) : null;
    if (!agentId) return null;

    const createdAt = parseIsoOrNull(wallet?.createdAt ?? row?.created_at) ?? new Date(0).toISOString();
    const updatedAt = parseIsoOrNull(wallet?.updatedAt ?? row?.updated_at) ?? createdAt;
    const currency =
      wallet?.currency && String(wallet.currency).trim() !== ""
        ? String(wallet.currency).toUpperCase()
        : row?.currency
          ? String(row.currency).toUpperCase()
          : "USD";
    const availableCents = parseSafeIntegerOrNull(wallet?.availableCents ?? row?.available_cents) ?? 0;
    const escrowLockedCents = parseSafeIntegerOrNull(wallet?.escrowLockedCents ?? row?.escrow_locked_cents) ?? 0;
    const totalCreditedCents = parseSafeIntegerOrNull(wallet?.totalCreditedCents ?? row?.total_credited_cents) ?? 0;
    const totalDebitedCents = parseSafeIntegerOrNull(wallet?.totalDebitedCents ?? row?.total_debited_cents) ?? 0;
    const revision = parseSafeIntegerOrNull(wallet?.revision ?? row?.revision) ?? 0;
    const walletId =
      wallet?.walletId && String(wallet.walletId).trim() !== ""
        ? String(wallet.walletId)
        : row?.wallet_id && String(row.wallet_id).trim() !== ""
          ? String(row.wallet_id)
          : `wallet_${agentId}`;

    return {
      ...wallet,
      tenantId,
      agentId,
      walletId,
      currency,
      availableCents,
      escrowLockedCents,
      totalCreditedCents,
      totalDebitedCents,
      revision,
      createdAt,
      updatedAt
    };
  }

  async function refreshAgentWallets() {
    if (!(store.agentWallets instanceof Map)) store.agentWallets = new Map();
    store.agentWallets.clear();
    try {
      const res = await pool.query(
        `
          SELECT
            tenant_id, agent_id, wallet_id, currency,
            available_cents, escrow_locked_cents, total_credited_cents, total_debited_cents,
            revision, created_at, updated_at, wallet_json
          FROM agent_wallets
          ORDER BY tenant_id ASC, agent_id ASC
        `
      );
      for (const row of res.rows) {
        const record = agentWalletRowToRecord(row);
        if (!record) continue;
        const key = makeScopedKey({ tenantId: record.tenantId, id: record.agentId });
        store.agentWallets.set(key, record);
      }
    } catch (err) {
      if (err?.code === "42P01") return;
      throw err;
    }
  }

  async function persistAgentWallet(client, { tenantId, wallet }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!wallet || typeof wallet !== "object" || Array.isArray(wallet)) throw new TypeError("wallet is required");
    const agentId = wallet.agentId ? String(wallet.agentId) : null;
    if (!agentId) throw new TypeError("wallet.agentId is required");

    const createdAt = parseIsoOrNull(wallet.createdAt) ?? new Date().toISOString();
    const updatedAt = parseIsoOrNull(wallet.updatedAt) ?? createdAt;
    const currency =
      wallet?.currency && String(wallet.currency).trim() !== "" ? String(wallet.currency).toUpperCase() : "USD";
    const walletId =
      wallet?.walletId && String(wallet.walletId).trim() !== "" ? String(wallet.walletId) : `wallet_${agentId}`;
    const availableCents = parseSafeIntegerOrNull(wallet.availableCents) ?? 0;
    const escrowLockedCents = parseSafeIntegerOrNull(wallet.escrowLockedCents) ?? 0;
    const totalCreditedCents = parseSafeIntegerOrNull(wallet.totalCreditedCents) ?? 0;
    const totalDebitedCents = parseSafeIntegerOrNull(wallet.totalDebitedCents) ?? 0;
    const revision = parseSafeIntegerOrNull(wallet.revision) ?? 0;

    const normalizedWallet = {
      ...wallet,
      tenantId,
      agentId,
      walletId,
      currency,
      availableCents,
      escrowLockedCents,
      totalCreditedCents,
      totalDebitedCents,
      revision,
      createdAt,
      updatedAt
    };

    await client.query(
      `
        INSERT INTO agent_wallets (
          tenant_id, agent_id, wallet_id, currency,
          available_cents, escrow_locked_cents, total_credited_cents, total_debited_cents,
          revision, created_at, updated_at, wallet_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
          wallet_id = EXCLUDED.wallet_id,
          currency = EXCLUDED.currency,
          available_cents = EXCLUDED.available_cents,
          escrow_locked_cents = EXCLUDED.escrow_locked_cents,
          total_credited_cents = EXCLUDED.total_credited_cents,
          total_debited_cents = EXCLUDED.total_debited_cents,
          revision = EXCLUDED.revision,
          updated_at = EXCLUDED.updated_at,
          wallet_json = EXCLUDED.wallet_json
      `,
      [
        tenantId,
        agentId,
        walletId,
        currency,
        availableCents,
        escrowLockedCents,
        totalCreditedCents,
        totalDebitedCents,
        revision,
        createdAt,
        updatedAt,
        JSON.stringify(normalizedWallet)
      ]
    );
  }

  function agentRunSettlementRowToRecord(row) {
    const settlement = row?.settlement_json ?? null;
    if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) return null;

    const tenantId = normalizeTenantId(row?.tenant_id ?? settlement?.tenantId ?? DEFAULT_TENANT_ID);
    const runId = row?.run_id ? String(row.run_id) : settlement?.runId ? String(settlement.runId) : null;
    if (!runId) return null;

    const createdAt = parseIsoOrNull(settlement?.createdAt ?? row?.created_at ?? row?.locked_at) ?? new Date(0).toISOString();
    const updatedAt = parseIsoOrNull(settlement?.updatedAt ?? row?.updated_at) ?? createdAt;
    const status = settlement?.status ? String(settlement.status) : row?.status ? String(row.status) : "locked";
    const agentId = settlement?.agentId ?? (row?.agent_id ? String(row.agent_id) : null);
    const payerAgentId = settlement?.payerAgentId ?? (row?.payer_agent_id ? String(row.payer_agent_id) : null);
    const amountCents = parseSafeIntegerOrNull(settlement?.amountCents ?? row?.amount_cents) ?? null;
    const revision = parseSafeIntegerOrNull(settlement?.revision ?? row?.revision) ?? 0;
    const currency =
      settlement?.currency && String(settlement.currency).trim() !== ""
        ? String(settlement.currency).toUpperCase()
        : row?.currency
          ? String(row.currency).toUpperCase()
          : "USD";
    const lockedAt = parseIsoOrNull(settlement?.lockedAt ?? row?.locked_at) ?? createdAt;
    const resolvedAt = parseIsoOrNull(settlement?.resolvedAt ?? row?.resolved_at);
    const resolutionEventId =
      settlement?.resolutionEventId && String(settlement.resolutionEventId).trim() !== ""
        ? String(settlement.resolutionEventId)
        : row?.resolution_event_id && String(row.resolution_event_id).trim() !== ""
          ? String(row.resolution_event_id)
          : null;
    const runStatus =
      settlement?.runStatus && String(settlement.runStatus).trim() !== ""
        ? String(settlement.runStatus)
        : row?.run_status && String(row.run_status).trim() !== ""
          ? String(row.run_status)
          : null;

    return {
      ...settlement,
      tenantId,
      runId,
      status,
      agentId,
      payerAgentId,
      amountCents,
      currency,
      resolutionEventId,
      runStatus,
      revision,
      lockedAt,
      resolvedAt,
      createdAt,
      updatedAt
    };
  }

  async function refreshAgentRunSettlements() {
    if (!(store.agentRunSettlements instanceof Map)) store.agentRunSettlements = new Map();
    store.agentRunSettlements.clear();
    try {
      const res = await pool.query(
        `
          SELECT
            tenant_id, run_id, status, agent_id, payer_agent_id, amount_cents, currency,
            resolution_event_id, run_status, revision, locked_at, resolved_at, created_at, updated_at, settlement_json
          FROM agent_run_settlements
          ORDER BY tenant_id ASC, run_id ASC
        `
      );
      for (const row of res.rows) {
        const record = agentRunSettlementRowToRecord(row);
        if (!record) continue;
        const key = makeScopedKey({ tenantId: record.tenantId, id: record.runId });
        store.agentRunSettlements.set(key, record);
      }
    } catch (err) {
      if (err?.code === "42P01") return;
      throw err;
    }
  }

  async function persistAgentRunSettlement(client, { tenantId, runId, settlement }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) throw new TypeError("settlement is required");
    const normalizedRunId = runId ? String(runId) : settlement.runId ? String(settlement.runId) : null;
    if (!normalizedRunId) throw new TypeError("runId is required");

    const status = settlement.status ? String(settlement.status) : "locked";
    const agentId = settlement.agentId === null || settlement.agentId === undefined ? null : String(settlement.agentId);
    const payerAgentId =
      settlement.payerAgentId === null || settlement.payerAgentId === undefined ? null : String(settlement.payerAgentId);
    const amountCents = parseSafeIntegerOrNull(settlement.amountCents);
    const currency =
      settlement?.currency && String(settlement.currency).trim() !== "" ? String(settlement.currency).toUpperCase() : "USD";
    const resolutionEventId =
      settlement.resolutionEventId === null || settlement.resolutionEventId === undefined
        ? null
        : String(settlement.resolutionEventId);
    const runStatus = settlement.runStatus === null || settlement.runStatus === undefined ? null : String(settlement.runStatus);
    const revision = parseSafeIntegerOrNull(settlement.revision) ?? 0;
    const lockedAt = parseIsoOrNull(settlement.lockedAt);
    const resolvedAt = parseIsoOrNull(settlement.resolvedAt);
    const createdAt = parseIsoOrNull(settlement.createdAt) ?? lockedAt ?? new Date().toISOString();
    const updatedAt = parseIsoOrNull(settlement.updatedAt) ?? resolvedAt ?? createdAt;

    const normalizedSettlement = {
      ...settlement,
      tenantId,
      runId: normalizedRunId,
      status,
      agentId,
      payerAgentId,
      amountCents,
      currency,
      resolutionEventId,
      runStatus,
      revision,
      lockedAt,
      resolvedAt,
      createdAt,
      updatedAt
    };

    await client.query(
      `
        INSERT INTO agent_run_settlements (
          tenant_id, run_id, status, agent_id, payer_agent_id, amount_cents, currency,
          resolution_event_id, run_status, revision, locked_at, resolved_at, created_at, updated_at, settlement_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (tenant_id, run_id) DO UPDATE SET
          status = EXCLUDED.status,
          agent_id = EXCLUDED.agent_id,
          payer_agent_id = EXCLUDED.payer_agent_id,
          amount_cents = EXCLUDED.amount_cents,
          currency = EXCLUDED.currency,
          resolution_event_id = EXCLUDED.resolution_event_id,
          run_status = EXCLUDED.run_status,
          revision = EXCLUDED.revision,
          locked_at = EXCLUDED.locked_at,
          resolved_at = EXCLUDED.resolved_at,
          updated_at = EXCLUDED.updated_at,
          settlement_json = EXCLUDED.settlement_json
      `,
      [
        tenantId,
        normalizedRunId,
        status,
        agentId,
        payerAgentId,
        amountCents,
        currency,
        resolutionEventId,
        runStatus,
        revision,
        lockedAt,
        resolvedAt,
        createdAt,
        updatedAt,
        JSON.stringify(normalizedSettlement)
      ]
    );
  }

  async function persistArbitrationCase(client, { tenantId, caseId, arbitrationCase }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!arbitrationCase || typeof arbitrationCase !== "object" || Array.isArray(arbitrationCase)) {
      throw new TypeError("arbitrationCase is required");
    }
    const normalizedCaseId = caseId ? String(caseId) : arbitrationCase.caseId ? String(arbitrationCase.caseId) : null;
    if (!normalizedCaseId) throw new TypeError("caseId is required");

    const updatedAt = parseIsoOrNull(arbitrationCase.updatedAt) ?? new Date().toISOString();
    const normalizedCase = {
      ...arbitrationCase,
      tenantId,
      caseId: normalizedCaseId,
      updatedAt
    };

    await client.query(
      `
        INSERT INTO snapshots (tenant_id, aggregate_type, aggregate_id, seq, at_chain_hash, snapshot_json, updated_at)
        VALUES ($1, 'arbitration_case', $2, 0, NULL, $3, $4)
        ON CONFLICT (tenant_id, aggregate_type, aggregate_id) DO UPDATE SET
          snapshot_json = EXCLUDED.snapshot_json,
          updated_at = EXCLUDED.updated_at
      `,
      [tenantId, normalizedCaseId, JSON.stringify(normalizedCase), updatedAt]
    );
  }

  async function persistAgreementDelegation(client, { tenantId, delegationId, delegation }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) {
      throw new TypeError("delegation is required");
    }
    const normalizedDelegationId =
      delegationId ? String(delegationId) : delegation.delegationId ? String(delegation.delegationId) : null;
    if (!normalizedDelegationId) throw new TypeError("delegationId is required");

    const updatedAt = parseIsoOrNull(delegation.updatedAt) ?? new Date().toISOString();
    const normalizedDelegation = {
      ...delegation,
      tenantId,
      delegationId: normalizedDelegationId,
      updatedAt
    };

    await client.query(
      `
        INSERT INTO snapshots (tenant_id, aggregate_type, aggregate_id, seq, at_chain_hash, snapshot_json, updated_at)
        VALUES ($1, 'agreement_delegation', $2, 0, NULL, $3, $4)
        ON CONFLICT (tenant_id, aggregate_type, aggregate_id) DO UPDATE SET
          snapshot_json = EXCLUDED.snapshot_json,
          updated_at = EXCLUDED.updated_at
      `,
      [tenantId, normalizedDelegationId, JSON.stringify(normalizedDelegation), updatedAt]
    );
  }

  async function persistX402Gate(client, { tenantId, gateId, gate }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      throw new TypeError("gate is required");
    }
    const normalizedGateId = gateId ? String(gateId) : gate.gateId ? String(gate.gateId) : gate.id ? String(gate.id) : null;
    if (!normalizedGateId) throw new TypeError("gateId is required");

    const updatedAt = parseIsoOrNull(gate.updatedAt) ?? new Date().toISOString();
    const normalizedGate = {
      ...gate,
      tenantId,
      gateId: normalizedGateId,
      updatedAt
    };

    await client.query(
      `
        INSERT INTO snapshots (tenant_id, aggregate_type, aggregate_id, seq, at_chain_hash, snapshot_json, updated_at)
        VALUES ($1, 'x402_gate', $2, 0, NULL, $3, $4)
        ON CONFLICT (tenant_id, aggregate_type, aggregate_id) DO UPDATE SET
          snapshot_json = EXCLUDED.snapshot_json,
          updated_at = EXCLUDED.updated_at
      `,
      [tenantId, normalizedGateId, JSON.stringify(normalizedGate), updatedAt]
    );
  }

  async function persistToolCallHold(client, { tenantId, holdHash, hold }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!hold || typeof hold !== "object" || Array.isArray(hold)) {
      throw new TypeError("hold is required");
    }
    const normalizedHoldHash = holdHash ? String(holdHash) : hold.holdHash ? String(hold.holdHash) : null;
    if (!normalizedHoldHash) throw new TypeError("holdHash is required");
    const updatedAt = parseIsoOrNull(hold.updatedAt) ?? new Date().toISOString();
    const normalizedHold = {
      ...hold,
      tenantId,
      holdHash: normalizedHoldHash,
      updatedAt
    };
    await client.query(
      `
        INSERT INTO snapshots (tenant_id, aggregate_type, aggregate_id, seq, at_chain_hash, snapshot_json, updated_at)
        VALUES ($1, 'tool_call_hold', $2, 0, NULL, $3, $4)
        ON CONFLICT (tenant_id, aggregate_type, aggregate_id) DO UPDATE SET
          snapshot_json = EXCLUDED.snapshot_json,
          updated_at = EXCLUDED.updated_at
      `,
      [tenantId, normalizedHoldHash, JSON.stringify(normalizedHold), updatedAt]
    );
  }

  async function persistSettlementAdjustment(client, { tenantId, adjustmentId, adjustment }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!adjustment || typeof adjustment !== "object" || Array.isArray(adjustment)) {
      throw new TypeError("adjustment is required");
    }
    const normalizedAdjustmentId =
      adjustmentId ? String(adjustmentId) : adjustment.adjustmentId ? String(adjustment.adjustmentId) : null;
    if (!normalizedAdjustmentId) throw new TypeError("adjustmentId is required");
    const updatedAt = parseIsoOrNull(adjustment.createdAt) ?? new Date().toISOString();
    const normalizedAdjustment = {
      ...adjustment,
      tenantId,
      adjustmentId: normalizedAdjustmentId
    };
    try {
      // Immutable snapshot: do not update on conflict. Uniqueness is relied upon for idempotency.
      await client.query(
        `
          INSERT INTO snapshots (tenant_id, aggregate_type, aggregate_id, seq, at_chain_hash, snapshot_json, updated_at)
          VALUES ($1, 'settlement_adjustment', $2, 0, NULL, $3, $4)
        `,
        [tenantId, normalizedAdjustmentId, JSON.stringify(normalizedAdjustment), updatedAt]
      );
    } catch (err) {
      if (err?.code === "23505") {
        const e = new Error("settlement adjustment already exists");
        e.code = "ADJUSTMENT_ALREADY_EXISTS";
        e.constraint = err?.constraint ?? null;
        throw e;
      }
      throw err;
    }
  }

  function authKeyRowToRecord(row) {
    if (!row) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? DEFAULT_TENANT_ID);
    const keyId = row?.key_id ? String(row.key_id) : null;
    if (!keyId) return null;
    return {
      tenantId,
      keyId,
      secretHash: row?.secret_hash ? String(row.secret_hash) : null,
      scopes: Array.isArray(row?.scopes) ? row.scopes.map(String) : [],
      status: row?.status ? String(row.status) : "active",
      description: row?.description === null || row?.description === undefined ? null : String(row.description),
      expiresAt: row?.expires_at ? new Date(row.expires_at).toISOString() : null,
      lastUsedAt: row?.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      rotatedAt: row?.rotated_at ? new Date(row.rotated_at).toISOString() : null,
      revokedAt: row?.revoked_at ? new Date(row.revoked_at).toISOString() : null
    };
  }

  async function refreshAuthKeys() {
    if (!(store.authKeys instanceof Map)) store.authKeys = new Map();
    store.authKeys.clear();
    try {
      const res = await pool.query(
        "SELECT tenant_id, key_id, secret_hash, scopes, status, description, expires_at, last_used_at, created_at, updated_at, rotated_at, revoked_at FROM auth_keys"
      );
      for (const row of res.rows) {
        const record = authKeyRowToRecord(row);
        if (!record) continue;
        const key = makeScopedKey({ tenantId: record.tenantId, id: record.keyId });
        store.authKeys.set(key, record);
      }
    } catch {
      // Ignore during early migrations.
    }
  }

  function signerKeyRowToRecord(row) {
    if (!row) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? DEFAULT_TENANT_ID);
    const keyId = row?.key_id ? String(row.key_id) : null;
    if (!keyId) return null;
    const publicKeyPem = row?.public_key_pem ? String(row.public_key_pem) : null;
    if (!publicKeyPem) return null;
    return {
      tenantId,
      keyId,
      publicKeyPem,
      purpose: row?.purpose ? String(row.purpose) : "server",
      status: row?.status ? String(row.status) : "active",
      description: row?.description === null || row?.description === undefined ? null : String(row.description),
      validFrom: row?.valid_from ? new Date(row.valid_from).toISOString() : null,
      validTo: row?.valid_to ? new Date(row.valid_to).toISOString() : null,
      lastUsedAt: row?.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      rotatedAt: row?.rotated_at ? new Date(row.rotated_at).toISOString() : null,
      revokedAt: row?.revoked_at ? new Date(row.revoked_at).toISOString() : null
    };
  }

  async function refreshSignerKeys() {
    if (!(store.signerKeys instanceof Map)) store.signerKeys = new Map();
    store.signerKeys.clear();
    try {
      const res = await pool.query(
        "SELECT tenant_id, key_id, public_key_pem, purpose, status, description, valid_from, valid_to, last_used_at, created_at, updated_at, rotated_at, revoked_at FROM signer_keys"
      );
      for (const row of res.rows) {
        const record = signerKeyRowToRecord(row);
        if (!record) continue;
        const key = makeScopedKey({ tenantId: record.tenantId, id: record.keyId });
        store.signerKeys.set(key, record);
        // Keep verification map hydrated.
        store.publicKeyByKeyId.set(record.keyId, record.publicKeyPem);
      }
    } catch {
      // Ignore during early migrations.
    }
  }

  function opsAuditRowToRecord(row) {
    if (!row) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? DEFAULT_TENANT_ID);
    const id = row?.id === null || row?.id === undefined ? null : Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const action = row?.action ? String(row.action) : null;
    if (!action) return null;
    const detailsHash = row?.details_hash ? String(row.details_hash) : null;
    if (!detailsHash) return null;
    return {
      id,
      tenantId,
      actorKeyId: row?.actor_key_id ? String(row.actor_key_id) : null,
      actorPrincipalId: row?.actor_principal_id ? String(row.actor_principal_id) : null,
      action,
      targetType: row?.target_type ? String(row.target_type) : null,
      targetId: row?.target_id ? String(row.target_id) : null,
      requestId: row?.request_id ? String(row.request_id) : null,
      at: row?.at ? new Date(row.at).toISOString() : null,
      detailsHash,
      details: row?.details_json ?? null
    };
  }

  async function insertOpsAuditRow(client, { tenantId, audit }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!audit || typeof audit !== "object") throw new TypeError("audit is required");
    const action = audit.action ? String(audit.action) : null;
    if (!action) throw new TypeError("audit.action is required");
    const detailsHash = audit.detailsHash ? String(audit.detailsHash) : audit.details_hash ? String(audit.details_hash) : null;
    if (!detailsHash) throw new TypeError("audit.detailsHash is required");
    const atIso = audit.at ? new Date(String(audit.at)).toISOString() : null;
    const res = await client.query(
      `
        INSERT INTO ops_audit (
          tenant_id, actor_key_id, actor_principal_id, action, target_type, target_id, request_id, at, details_hash, details_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9,$10)
        RETURNING id, tenant_id, actor_key_id, actor_principal_id, action, target_type, target_id, request_id, at, details_hash, details_json
      `,
      [
        tenantId,
        audit.actorKeyId ?? null,
        audit.actorPrincipalId ?? null,
        action,
        audit.targetType ?? null,
        audit.targetId ?? null,
        audit.requestId ?? null,
        atIso,
        detailsHash,
        audit.details ?? null
      ]
    );
    return res.rows.length ? opsAuditRowToRecord(res.rows[0]) : null;
  }

  async function seedSignerKeysFromSnapshots() {
    try {
      await pool.query("SELECT 1 FROM signer_keys LIMIT 1");
    } catch {
      return;
    }

    const tasks = [];

    for (const robot of store.robots.values()) {
      const tenantId = normalizeTenantId(robot?.tenantId ?? DEFAULT_TENANT_ID);
      const keyId = robot?.signerKeyId ? String(robot.signerKeyId) : null;
      if (!keyId) continue;
      const publicKeyPem = store.publicKeyByKeyId.get(keyId) ?? null;
      if (!publicKeyPem) continue;
      tasks.push({
        tenantId,
        keyId,
        publicKeyPem,
        purpose: "robot",
        description: robot?.id ? `backfill robot:${robot.id}` : "backfill robot"
      });
    }

    for (const op of store.operators.values()) {
      const tenantId = normalizeTenantId(op?.tenantId ?? DEFAULT_TENANT_ID);
      const keyId = op?.signerKeyId ? String(op.signerKeyId) : null;
      if (!keyId) continue;
      const publicKeyPem = store.publicKeyByKeyId.get(keyId) ?? null;
      if (!publicKeyPem) continue;
      tasks.push({
        tenantId,
        keyId,
        publicKeyPem,
        purpose: "operator",
        description: op?.id ? `backfill operator:${op.id}` : "backfill operator"
      });
    }

    for (const task of tasks) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `
          INSERT INTO signer_keys (tenant_id, key_id, public_key_pem, purpose, status, description)
          VALUES ($1,$2,$3,$4,'active',$5)
          ON CONFLICT (tenant_id, key_id) DO NOTHING
        `,
        [task.tenantId, task.keyId, task.publicKeyPem, task.purpose, task.description]
      );
    }
  }

  async function persistContract(client, { tenantId, contract }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!contract?.contractId) throw new TypeError("contract.contractId is required");

    const contractId = String(contract.contractId);
    const name = String(contract.name ?? contractId);
    const customerId = contract.customerId === null || contract.customerId === undefined ? null : String(contract.customerId);
    const siteId = contract.siteId === null || contract.siteId === undefined ? null : String(contract.siteId);
    const templateId = contract.templateId === null || contract.templateId === undefined ? null : String(contract.templateId);
    const isDefault = contract.isDefault === true;
    const createdAt = contract.createdAt ? new Date(contract.createdAt) : new Date();
    const updatedAt = contract.updatedAt ? new Date(contract.updatedAt) : new Date();

    await client.query(
      `
        INSERT INTO contracts (
          tenant_id, contract_id, name, customer_id, site_id, template_id, is_default,
          contract_json, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (tenant_id, contract_id) DO UPDATE SET
          name = EXCLUDED.name,
          customer_id = EXCLUDED.customer_id,
          site_id = EXCLUDED.site_id,
          template_id = EXCLUDED.template_id,
          is_default = EXCLUDED.is_default,
          contract_json = EXCLUDED.contract_json,
          updated_at = EXCLUDED.updated_at
      `,
      [tenantId, contractId, name, customerId, siteId, templateId, isDefault, JSON.stringify(contract), createdAt, updatedAt]
    );
  }

  async function persistMarketplaceRfq(client, { tenantId, rfq }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!rfq || typeof rfq !== "object" || Array.isArray(rfq)) throw new TypeError("rfq is required");
    const rfqId = rfq.rfqId ? String(rfq.rfqId) : null;
    if (!rfqId) throw new TypeError("rfq.rfqId is required");

    const createdAt = parseIsoOrNull(rfq.createdAt) ?? new Date().toISOString();
    const updatedAt = parseIsoOrNull(rfq.updatedAt) ?? createdAt;
    const status = rfq.status ? String(rfq.status) : "open";
    const capability = rfq.capability === null || rfq.capability === undefined ? null : String(rfq.capability);
    const posterAgentId = rfq.posterAgentId === null || rfq.posterAgentId === undefined ? null : String(rfq.posterAgentId);
    const direction = normalizeMarketplaceDirectionForWrite({
      fromType: rfq.fromType,
      toType: rfq.toType
    });

    const normalizedRfq = {
      ...rfq,
      tenantId,
      rfqId,
      fromType: direction.fromType,
      toType: direction.toType,
      status,
      capability,
      posterAgentId,
      createdAt,
      updatedAt
    };
    await client.query(
      `
        INSERT INTO marketplace_rfqs (tenant_id, rfq_id, status, capability, poster_agent_id, created_at, updated_at, rfq_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tenant_id, rfq_id) DO UPDATE SET
          status = EXCLUDED.status,
          capability = EXCLUDED.capability,
          poster_agent_id = EXCLUDED.poster_agent_id,
          updated_at = EXCLUDED.updated_at,
          rfq_json = EXCLUDED.rfq_json
      `,
      [tenantId, rfqId, status, capability, posterAgentId, createdAt, updatedAt, JSON.stringify(normalizedRfq)]
    );
  }

  async function persistMarketplaceRfqBids(client, { tenantId, rfqId, bids }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(rfqId, "rfqId");
    if (!Array.isArray(bids)) throw new TypeError("bids must be an array");
    const normalizedTaskId = String(rfqId);

    await client.query("DELETE FROM marketplace_rfq_bids WHERE tenant_id = $1 AND rfq_id = $2", [tenantId, normalizedTaskId]);

    for (const bid of bids) {
      if (!bid || typeof bid !== "object" || Array.isArray(bid)) throw new TypeError("each bid must be an object");
      const bidId = bid.bidId ? String(bid.bidId) : null;
      if (!bidId) throw new TypeError("bid.bidId is required");

      let amountCents = null;
      if (bid.amountCents !== undefined && bid.amountCents !== null) {
        const parsedAmount = Number(bid.amountCents);
        if (!Number.isSafeInteger(parsedAmount)) throw new TypeError("bid.amountCents must be a safe integer");
        amountCents = parsedAmount;
      }

      const status = bid.status ? String(bid.status) : "pending";
      const bidderAgentId = bid.bidderAgentId === null || bid.bidderAgentId === undefined ? null : String(bid.bidderAgentId);
      const createdAt = parseIsoOrNull(bid.createdAt) ?? new Date().toISOString();
      const updatedAt = parseIsoOrNull(bid.updatedAt) ?? createdAt;
      const direction = normalizeMarketplaceDirectionForWrite({
        fromType: bid.fromType,
        toType: bid.toType
      });
      const normalizedBid = {
        ...bid,
        tenantId,
        rfqId: normalizedTaskId,
        bidId,
        fromType: direction.fromType,
        toType: direction.toType,
        status,
        bidderAgentId,
        amountCents,
        createdAt,
        updatedAt
      };

      await client.query(
        `
          INSERT INTO marketplace_rfq_bids (
            tenant_id, rfq_id, bid_id, status, bidder_agent_id, amount_cents, created_at, updated_at, bid_json
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [tenantId, normalizedTaskId, bidId, status, bidderAgentId, amountCents, createdAt, updatedAt, JSON.stringify(normalizedBid)]
      );
    }
  }

  async function persistTenantSettlementPolicy(client, { tenantId, policy }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      throw new TypeError("policy is required");
    }
    const policyId = typeof policy.policyId === "string" && policy.policyId.trim() !== "" ? policy.policyId.trim() : null;
    const policyVersion = Number(policy.policyVersion);
    const policyHash = typeof policy.policyHash === "string" && policy.policyHash.trim() !== "" ? policy.policyHash.trim() : null;
    const verificationMethodHash =
      typeof policy.verificationMethodHash === "string" && policy.verificationMethodHash.trim() !== ""
        ? policy.verificationMethodHash.trim()
        : null;
    if (!policyId) throw new TypeError("policy.policyId is required");
    if (!Number.isSafeInteger(policyVersion) || policyVersion <= 0) {
      throw new TypeError("policy.policyVersion must be a positive safe integer");
    }
    if (!policyHash) throw new TypeError("policy.policyHash is required");
    if (!verificationMethodHash) throw new TypeError("policy.verificationMethodHash is required");

    const createdAt = parseIsoOrNull(policy.createdAt) ?? new Date().toISOString();
    const updatedAt = parseIsoOrNull(policy.updatedAt) ?? createdAt;
    const normalizedPolicy = {
      ...policy,
      tenantId,
      policyId,
      policyVersion,
      policyHash,
      verificationMethodHash,
      createdAt,
      updatedAt
    };

    await client.query(
      `
        INSERT INTO tenant_settlement_policies (
          tenant_id, policy_id, policy_version, policy_hash, verification_method_hash, created_at, updated_at, policy_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tenant_id, policy_id, policy_version) DO UPDATE SET
          policy_hash = EXCLUDED.policy_hash,
          verification_method_hash = EXCLUDED.verification_method_hash,
          updated_at = EXCLUDED.updated_at,
          policy_json = EXCLUDED.policy_json
      `,
      [
        tenantId,
        policyId,
        policyVersion,
        policyHash,
        verificationMethodHash,
        createdAt,
        updatedAt,
        JSON.stringify(normalizedPolicy)
      ]
    );
  }

  await refreshSnapshots();
  await refreshEvents();
  await refreshIdempotency();
  await refreshLedgerBalances();
  await refreshContracts();
  await refreshTenantBillingConfigs();
  await refreshMarketplaceRfqs();
  await refreshMarketplaceRfqBids();
  await refreshTenantSettlementPolicies();
  await refreshAgentIdentities();
  await refreshAgentWallets();
  await refreshAgentRunSettlements();
  await refreshAuthKeys();
  await seedSignerKeysFromSnapshots();
  await refreshSignerKeys();

  const workerStatementTimeoutMs = workerStatementTimeoutMsFromEnv({ fallbackMs: 0 });

  // Ensure each store has at least a default contract row.
  // (In practice tenants are created dynamically; we seed the default tenant here.)
  try {
    const defaultContract = createDefaultContract({ tenantId: DEFAULT_TENANT_ID });
    await pool.query(
      `
        INSERT INTO contracts (tenant_id, contract_id, name, customer_id, site_id, template_id, is_default, contract_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tenant_id, contract_id) DO NOTHING
      `,
      [
        DEFAULT_TENANT_ID,
        defaultContract.contractId,
        defaultContract.name,
        defaultContract.customerId,
        defaultContract.siteId,
        defaultContract.templateId,
        defaultContract.isDefault === true,
        JSON.stringify(defaultContract)
      ]
    );
    await refreshContracts();
  } catch {
    // Ignore: contracts table may not exist yet during early migrations.
  }

  function assertKnownOpKind(kind) {
    const known = new Set([
      "JOB_EVENTS_APPENDED",
      "ROBOT_EVENTS_APPENDED",
      "OPERATOR_EVENTS_APPENDED",
      "MONTH_EVENTS_APPENDED",
      "CONTRACT_UPSERT",
      "PUBLIC_KEY_PUT",
      "SIGNER_KEY_UPSERT",
      "SIGNER_KEY_STATUS_SET",
      "AGENT_IDENTITY_UPSERT",
      "AGENT_WALLET_UPSERT",
      "AGENT_RUN_EVENTS_APPENDED",
      "AGENT_RUN_SETTLEMENT_UPSERT",
      "ARBITRATION_CASE_UPSERT",
      "AGREEMENT_DELEGATION_UPSERT",
      "X402_GATE_UPSERT",
      "TOOL_CALL_HOLD_UPSERT",
      "SETTLEMENT_ADJUSTMENT_PUT",
      "MARKETPLACE_RFQ_UPSERT",
      "MARKETPLACE_RFQ_BIDS_SET",
      "TENANT_SETTLEMENT_POLICY_UPSERT",
      "IDEMPOTENCY_PUT",
      "OUTBOX_ENQUEUE",
      "INGEST_RECORDS_PUT"
    ]);
    if (!known.has(kind)) throw new TypeError(`unsupported op kind for pg store: ${kind}`);
  }

  async function withTx(arg1, arg2) {
    const options = typeof arg1 === "function" ? null : arg1;
    const fn = typeof arg1 === "function" ? arg1 : arg2;
    if (typeof fn !== "function") throw new TypeError("fn is required");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const timeoutMs = options?.statementTimeoutMs ?? null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        // Postgres does not allow parameter placeholders in `SET LOCAL ...`.
        // Use `set_config` which safely accepts bind parameters.
        await client.query("SELECT set_config('statement_timeout', $1, true)", [`${Math.floor(timeoutMs)}ms`]);
      }
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function lockAggregate(client, { tenantId, aggregateType, aggregateId }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${tenantId}:${aggregateType}:${aggregateId}`]);
  }

  async function insertEvents(client, { tenantId, aggregateType, aggregateId, events }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    await lockAggregate(client, { tenantId, aggregateType, aggregateId });

    const headRes = await client.query(
      "SELECT seq, chain_hash FROM events WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3 ORDER BY seq DESC LIMIT 1",
      [tenantId, aggregateType, aggregateId]
    );
    const head = headRes.rows[0] ?? null;
    const lastSeq = head ? Number(head.seq) : 0;
    const lastChainHash = head ? String(head.chain_hash) : null;

    const first = events[0] ?? null;
    if (first && first.prevChainHash !== lastChainHash) {
      const err = new Error("event append conflict");
      err.code = "PREV_CHAIN_HASH_MISMATCH";
      err.expectedPrevChainHash = lastChainHash;
      err.gotPrevChainHash = first.prevChainHash;
      throw err;
    }

    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      const seq = lastSeq + i + 1;

      // Enforce signer key lifecycle at the DB boundary (prevents stale caches across processes).
      if (e?.signature && e?.signerKeyId && String(e.signerKeyId) !== String(store.serverSigner?.keyId ?? "")) {
        const actorType = e?.actor?.type ? String(e.actor.type) : null;
        const requiredPurpose = actorType === "robot" ? "robot" : actorType === "operator" ? "operator" : null;
        if (!requiredPurpose) {
          const err = new Error("signer key purpose mismatch");
          err.code = "SIGNER_KEY_PURPOSE_MISMATCH";
          throw err;
        }
        try {
          const check = await client.query("SELECT status, purpose FROM signer_keys WHERE tenant_id = $1 AND key_id = $2 LIMIT 1", [
            tenantId,
            String(e.signerKeyId)
          ]);
          if (!check.rows.length) {
            const err = new Error("unknown signer key");
            err.code = "SIGNER_KEY_UNKNOWN";
            throw err;
          }
          const row = check.rows[0];
          const status = normalizeSignerKeyStatus(row.status);
          const purpose = normalizeSignerKeyPurpose(row.purpose);
          if (purpose !== requiredPurpose) {
            const err = new Error("signer key purpose mismatch");
            err.code = "SIGNER_KEY_PURPOSE_MISMATCH";
            throw err;
          }
          if (status !== "active") {
            const err = new Error("signer key is not active");
            err.code = "SIGNER_KEY_INACTIVE";
            throw err;
          }
        } catch (err) {
          // Allow during early migrations if the table doesn't exist yet.
          if (err?.code === "42P01") continue;
          throw err;
        }
      }

      await client.query(
        `
          INSERT INTO events (
            tenant_id, aggregate_type, aggregate_id, seq, event_id, chain_hash, prev_chain_hash, payload_hash,
            type, at, actor_json, payload_json, signature, signer_key_id, event_json
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `,
        [
          tenantId,
          aggregateType,
          aggregateId,
          seq,
          e.id,
          e.chainHash,
          e.prevChainHash,
          e.payloadHash,
          e.type,
          e.at,
          JSON.stringify(e.actor ?? null),
          JSON.stringify(e.payload ?? null),
          e.signature ?? null,
          e.signerKeyId ?? null,
          JSON.stringify(e)
        ]
      );
    }

    const newHeadRes = await client.query(
      "SELECT seq, chain_hash, event_json FROM events WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3 ORDER BY seq DESC LIMIT 1",
      [tenantId, aggregateType, aggregateId]
    );
    const newHead = newHeadRes.rows[0] ?? null;
    return {
      seq: newHead ? Number(newHead.seq) : lastSeq,
      chainHash: newHead ? String(newHead.chain_hash) : lastChainHash
    };
  }

  async function rebuildSnapshot(client, { tenantId, aggregateType, aggregateId }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const res = await client.query(
      "SELECT event_json FROM events WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3 ORDER BY seq ASC",
      [tenantId, aggregateType, aggregateId]
    );
    const events = res.rows.map((r) => r.event_json).filter(Boolean);
    let snapshot = null;
    if (aggregateType === "job") snapshot = reduceJob(events);
    if (aggregateType === "robot") snapshot = reduceRobot(events);
    if (aggregateType === "operator") snapshot = reduceOperator(events);
    if (aggregateType === "month") snapshot = reduceMonthClose(events);
    if (aggregateType === "agent_run") snapshot = reduceAgentRun(events.map(normalizeAgentRunEventRecord));

    if (!snapshot) return null;

    const head = events[events.length - 1] ?? null;
    const seqRes = await client.query(
      "SELECT seq, chain_hash FROM events WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3 ORDER BY seq DESC LIMIT 1",
      [tenantId, aggregateType, aggregateId]
    );
    const row = seqRes.rows[0];
    const seq = row ? Number(row.seq) : events.length;
    const chainHash = row ? String(row.chain_hash) : head?.chainHash ?? null;

    await client.query(
      `
        INSERT INTO snapshots (tenant_id, aggregate_type, aggregate_id, seq, at_chain_hash, snapshot_json)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id, aggregate_type, aggregate_id)
        DO UPDATE SET seq = EXCLUDED.seq, at_chain_hash = EXCLUDED.at_chain_hash, snapshot_json = EXCLUDED.snapshot_json, updated_at = now()
      `,
      [tenantId, aggregateType, aggregateId, seq, chainHash, JSON.stringify(snapshot)]
    );

    return snapshot;
  }

  async function persistPublicKey(client, { keyId, publicKeyPem }) {
    await client.query(
      `
        INSERT INTO public_keys (key_id, public_key_pem)
        VALUES ($1,$2)
        ON CONFLICT (key_id) DO UPDATE SET public_key_pem = EXCLUDED.public_key_pem
      `,
      [keyId, publicKeyPem]
    );
  }

  async function persistSignerKey(client, { tenantId, signerKey }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!signerKey || typeof signerKey !== "object") throw new TypeError("signerKey is required");
    const keyId = signerKey.keyId ?? signerKey.id ?? null;
    assertNonEmptyString(keyId, "signerKey.keyId");
    assertNonEmptyString(signerKey.publicKeyPem, "signerKey.publicKeyPem");
    const purpose = normalizeSignerKeyPurpose(signerKey.purpose ?? "server");
    const status = normalizeSignerKeyStatus(signerKey.status ?? "active");
    const description = signerKey.description === null || signerKey.description === undefined ? null : String(signerKey.description);
    const validFrom = signerKey.validFrom ? new Date(String(signerKey.validFrom)).toISOString() : null;
    const validTo = signerKey.validTo ? new Date(String(signerKey.validTo)).toISOString() : null;
    const lastUsedAt = signerKey.lastUsedAt ? new Date(String(signerKey.lastUsedAt)).toISOString() : null;
    const createdAt = signerKey.createdAt ? new Date(String(signerKey.createdAt)).toISOString() : new Date().toISOString();
    const updatedAt = signerKey.updatedAt ? new Date(String(signerKey.updatedAt)).toISOString() : new Date().toISOString();
    const rotatedAt = signerKey.rotatedAt ? new Date(String(signerKey.rotatedAt)).toISOString() : null;
    const revokedAt = signerKey.revokedAt ? new Date(String(signerKey.revokedAt)).toISOString() : null;

    await client.query(
      `
        INSERT INTO signer_keys (
          tenant_id, key_id, public_key_pem, purpose, status, description,
          valid_from, valid_to, last_used_at, created_at, updated_at, rotated_at, revoked_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (tenant_id, key_id) DO UPDATE SET
          public_key_pem = EXCLUDED.public_key_pem,
          purpose = EXCLUDED.purpose,
          status = EXCLUDED.status,
          description = EXCLUDED.description,
          valid_from = EXCLUDED.valid_from,
          valid_to = EXCLUDED.valid_to,
          last_used_at = COALESCE(EXCLUDED.last_used_at, signer_keys.last_used_at),
          updated_at = EXCLUDED.updated_at,
          rotated_at = COALESCE(EXCLUDED.rotated_at, signer_keys.rotated_at),
          revoked_at = COALESCE(EXCLUDED.revoked_at, signer_keys.revoked_at)
      `,
      [
        tenantId,
        String(keyId),
        String(signerKey.publicKeyPem),
        purpose,
        status,
        description,
        validFrom,
        validTo,
        lastUsedAt,
        createdAt,
        updatedAt,
        rotatedAt,
        revokedAt
      ]
    );

    // Ensure signature verification map is hydrated.
    store.publicKeyByKeyId.set(String(keyId), String(signerKey.publicKeyPem));
  }

  async function setSignerKeyStatusRow(client, { tenantId, keyId, status, at }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(keyId, "keyId");
    const normalizedStatus = normalizeSignerKeyStatus(status);
    const ts = at ? new Date(String(at)).toISOString() : new Date().toISOString();
    await client.query(
      `
        UPDATE signer_keys
        SET status = $3,
            updated_at = $4,
            rotated_at = CASE WHEN $3 = 'rotated' THEN COALESCE(rotated_at, $4) ELSE rotated_at END,
            revoked_at = CASE WHEN $3 = 'revoked' THEN COALESCE(revoked_at, $4) ELSE revoked_at END
        WHERE tenant_id = $1 AND key_id = $2
      `,
      [tenantId, keyId, normalizedStatus, ts]
    );
  }

  async function persistIdempotency(client, { key, value }) {
    const { tenantId, principalId, endpoint, idempotencyKey } = parseIdempotencyStoreKey(key);
    const lookup = async () => {
      const existing = await client.query(
        "SELECT request_hash, status_code, response_json FROM idempotency WHERE tenant_id = $1 AND principal_id = $2 AND endpoint = $3 AND idem_key = $4",
        [tenantId, principalId, endpoint, idempotencyKey]
      );
      if (!existing.rows.length) return null;
      const row = existing.rows[0];
      const requestHash = String(row.request_hash);
      if (requestHash !== value.requestHash) throw new PgIdempotencyConflictError("idempotency key conflict");
      return { requestHash, statusCode: Number(row.status_code), body: row.response_json };
    };

    const found = await lookup();
    if (found) return found;

    const inserted = await client.query(
      `
        INSERT INTO idempotency (tenant_id, principal_id, endpoint, idem_key, request_hash, status_code, response_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (tenant_id, principal_id, endpoint, idem_key) DO NOTHING
        RETURNING request_hash, status_code, response_json
      `,
      [tenantId, principalId, endpoint, idempotencyKey, value.requestHash, value.statusCode, JSON.stringify(value.body)]
    );
    if (inserted.rows.length) return value;

    // Another transaction won the race; fetch and validate requestHash.
    const raced = await lookup();
    if (raced) return raced;
    throw new Error("failed to persist idempotency key");
  }

  async function syncRobotReservation(client, jobSnapshot) {
    if (!jobSnapshot || typeof jobSnapshot !== "object") return;
    const jobId = jobSnapshot.id ?? null;
    if (typeof jobId !== "string" || jobId.trim() === "") return;
    const tenantId = normalizeTenantId(jobSnapshot.tenantId ?? DEFAULT_TENANT_ID);

    const status = jobSnapshot.status ?? null;
    const reservation = jobSnapshot.reservation ?? null;
    const robotId = reservation?.robotId ?? null;
    const startAt = reservation?.startAt ?? null;
    const endAt = reservation?.endAt ?? null;

    const active = Boolean(robotId && startAt && endAt && status !== "ABORTED" && status !== "SETTLED");
    if (!active) {
      await client.query("DELETE FROM robot_reservations WHERE tenant_id = $1 AND job_id = $2", [tenantId, jobId]);
      return;
    }

    await client.query(
      `
        INSERT INTO robot_reservations (tenant_id, job_id, robot_id, "window", updated_at)
        VALUES ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), now())
        ON CONFLICT (tenant_id, job_id)
        DO UPDATE SET robot_id = EXCLUDED.robot_id, "window" = EXCLUDED."window", updated_at = now()
      `,
      [tenantId, jobId, robotId, startAt, endAt]
    );
  }

  async function enqueueOutbox(client, { messages }) {
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const topic = message.type;
      if (typeof topic !== "string" || topic.trim() === "") continue;
      const tenantId = normalizeTenantId(message.tenantId ?? DEFAULT_TENANT_ID);
      const aggregateType = message.aggregateType ?? null;
      const aggregateId = message.aggregateId ?? message.jobId ?? message.robotId ?? message.operatorId ?? null;
      await client.query(
        "INSERT INTO outbox (tenant_id, topic, aggregate_type, aggregate_id, payload_json) VALUES ($1,$2,$3,$4,$5)",
        [tenantId, topic, aggregateType, aggregateId, JSON.stringify(message)]
      );
    }
  }

  async function upsertCorrelationRow(client, { tenantId, siteId, correlationKey, jobId, expiresAt, force = false }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(siteId, "siteId");
    assertNonEmptyString(correlationKey, "correlationKey");
    assertNonEmptyString(jobId, "jobId");

    const existing = await client.query(
      "SELECT job_id FROM correlations WHERE tenant_id = $1 AND site_id = $2 AND correlation_key = $3",
      [tenantId, siteId, correlationKey]
    );
    if (existing.rows.length) {
      const currentJobId = String(existing.rows[0].job_id);
      if (currentJobId !== jobId) {
        if (force) {
          await client.query(
            "UPDATE correlations SET job_id = $4, expires_at = $5 WHERE tenant_id = $1 AND site_id = $2 AND correlation_key = $3",
            [tenantId, siteId, correlationKey, jobId, expiresAt]
          );
          return;
        }
        const err = new Error("correlation key already linked to a different job");
        err.code = "CORRELATION_CONFLICT";
        err.existingJobId = currentJobId;
        throw err;
      }
      await client.query(
        "UPDATE correlations SET expires_at = COALESCE($5, expires_at) WHERE tenant_id = $1 AND site_id = $2 AND correlation_key = $3 AND job_id = $4",
        [tenantId, siteId, correlationKey, jobId, expiresAt]
      );
      return;
    }

    await client.query(
      "INSERT INTO correlations (tenant_id, site_id, correlation_key, job_id, expires_at) VALUES ($1,$2,$3,$4,$5)",
      [tenantId, siteId, correlationKey, jobId, expiresAt]
    );
  }

  async function persistReputationEventIndexRow(client, { tenantId, artifactId, artifactHash, artifact }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return;
    if (String(artifact.artifactType ?? artifact.schemaVersion ?? "") !== "ReputationEvent.v1") return;

    const subject = artifact.subject && typeof artifact.subject === "object" && !Array.isArray(artifact.subject) ? artifact.subject : null;
    const sourceRef = artifact.sourceRef && typeof artifact.sourceRef === "object" && !Array.isArray(artifact.sourceRef) ? artifact.sourceRef : null;
    const agentId = subject?.agentId ? String(subject.agentId).trim() : "";
    if (!agentId) return;

    const toolIdRaw = subject?.toolId ? String(subject.toolId).trim() : "";
    const toolId = toolIdRaw === "" ? null : toolIdRaw;
    const sourceKindRaw = sourceRef?.kind ? String(sourceRef.kind).trim().toLowerCase() : "";
    const sourceKind = sourceKindRaw === "" ? "unknown" : sourceKindRaw;
    const sourceHashRaw = sourceRef?.hash ? String(sourceRef.hash).trim().toLowerCase() : "";
    const sourceHash = sourceHashRaw === "" ? null : sourceHashRaw;
    const eventKindRaw = artifact?.eventKind ? String(artifact.eventKind).trim().toLowerCase() : "";
    const eventKind = eventKindRaw === "" ? "unknown" : eventKindRaw;
    const occurredAtParsed = Date.parse(String(artifact.occurredAt ?? ""));
    const occurredAt = Number.isFinite(occurredAtParsed) ? new Date(occurredAtParsed).toISOString() : new Date().toISOString();

    await client.query(
      `
        INSERT INTO reputation_event_index (
          tenant_id, artifact_id, artifact_hash, subject_agent_id, subject_tool_id, occurred_at, event_kind, source_kind, source_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (tenant_id, artifact_id) DO UPDATE SET
          artifact_hash = EXCLUDED.artifact_hash,
          subject_agent_id = EXCLUDED.subject_agent_id,
          subject_tool_id = EXCLUDED.subject_tool_id,
          occurred_at = EXCLUDED.occurred_at,
          event_kind = EXCLUDED.event_kind,
          source_kind = EXCLUDED.source_kind,
          source_hash = EXCLUDED.source_hash
      `,
      [tenantId, String(artifactId), String(artifactHash), agentId, toolId, occurredAt, eventKind, sourceKind, sourceHash]
    );
  }

	  async function persistArtifactRow(client, { tenantId, artifact }) {
	    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
	    if (!artifact || typeof artifact !== "object") throw new TypeError("artifact is required");
	    const artifactId = artifact.artifactId ?? artifact.id ?? null;
	    if (!artifactId) throw new TypeError("artifact.artifactId is required");
	    const artifactHash = artifact.artifactHash ?? null;
	    if (!artifactHash) throw new TypeError("artifact.artifactHash is required");

    const artifactType = String(artifact.artifactType ?? artifact.schemaVersion ?? "unknown");
    const jobId = String(artifact.jobId ?? "");
    const sourceEventId = typeof artifact.sourceEventId === "string" && artifact.sourceEventId.trim() !== "" ? String(artifact.sourceEventId) : "";

    // Invariant: for artifacts tied to a specific *job* source event, there must be exactly one artifact per
    // (jobId + artifactType + sourceEventId). This prevents duplicate settlement-backed certificates.
    //
    // Important: many non-job artifacts (month close statements, party statements, payout instructions, etc.) set a
    // sourceEventId but intentionally do not have a jobId. Do not apply this invariant to those artifacts.
    if (sourceEventId && jobId) {
      const existingBySource = await client.query(
        "SELECT artifact_id, artifact_hash FROM artifacts WHERE tenant_id = $1 AND job_id = $2 AND artifact_type = $3 AND source_event_id = $4 LIMIT 1",
        [tenantId, jobId, artifactType, sourceEventId]
      );
      if (existingBySource.rows.length) {
        const currentId = String(existingBySource.rows[0].artifact_id);
        const currentHash = String(existingBySource.rows[0].artifact_hash);
        if (currentHash !== String(artifactHash)) {
          const err = new Error("artifact already exists for this job/type/sourceEventId with a different hash");
          err.code = "ARTIFACT_SOURCE_EVENT_CONFLICT";
          err.existingArtifactId = currentId;
          err.existingArtifactHash = currentHash;
          err.gotArtifactHash = String(artifactHash);
          throw err;
        }
        await persistReputationEventIndexRow(client, { tenantId, artifactId: currentId, artifactHash: currentHash, artifact });
        return;
      }
    }

		    const existing = await client.query("SELECT artifact_hash FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2", [tenantId, artifactId]);
		    if (existing.rows.length) {
		      const current = String(existing.rows[0].artifact_hash);
		      if (current !== String(artifactHash)) {
		        const err = new Error("artifactId already exists with a different hash");
		        err.code = "ARTIFACT_HASH_MISMATCH";
		        err.expectedArtifactHash = current;
		        err.gotArtifactHash = String(artifactHash);
		        throw err;
		      }
		      await persistReputationEventIndexRow(client, { tenantId, artifactId, artifactHash: current, artifact });
		      return;
		    }

        // Avoid transaction-aborting unique-constraint errors (we run inside explicit transactions).
        // Handle all unique conflicts by doing nothing and then checking what already exists.
        const insertRes = await client.query(
          `
            INSERT INTO artifacts (tenant_id, artifact_id, artifact_type, job_id, at_chain_hash, source_event_id, artifact_hash, artifact_json)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT DO NOTHING
          `,
          [
            tenantId,
            String(artifactId),
            artifactType,
            jobId,
            String(artifact.atChainHash ?? artifact.eventProof?.lastChainHash ?? ""),
            sourceEventId,
            String(artifactHash),
            JSON.stringify(artifact)
          ]
        );
        if (Number(insertRes?.rowCount ?? 0) > 0) {
          await persistReputationEventIndexRow(client, { tenantId, artifactId, artifactHash, artifact });
          return;
        }

        // Someone else inserted a conflicting row under a unique constraint. Determine if it's idempotent.
        const byId = await client.query("SELECT artifact_hash FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2", [tenantId, artifactId]);
        if (byId.rows.length) {
          const current = String(byId.rows[0].artifact_hash);
          if (current === String(artifactHash)) {
            await persistReputationEventIndexRow(client, { tenantId, artifactId, artifactHash: current, artifact });
            return;
          }
          const mismatch = new Error("artifactId already exists with a different hash");
          mismatch.code = "ARTIFACT_HASH_MISMATCH";
          mismatch.expectedArtifactHash = current;
          mismatch.gotArtifactHash = String(artifactHash);
          throw mismatch;
        }

        if (sourceEventId && jobId) {
          const bySource = await client.query(
            "SELECT artifact_id, artifact_hash FROM artifacts WHERE tenant_id = $1 AND job_id = $2 AND artifact_type = $3 AND source_event_id = $4 LIMIT 1",
            [tenantId, jobId, artifactType, sourceEventId]
          );
          if (bySource.rows.length) {
            const currentId = String(bySource.rows[0].artifact_id);
            const currentHash = String(bySource.rows[0].artifact_hash);
            if (currentHash === String(artifactHash)) {
              await persistReputationEventIndexRow(client, { tenantId, artifactId: currentId, artifactHash: currentHash, artifact });
              return;
            }
            const conflict = new Error("artifact already exists for this job/type/sourceEventId with a different hash");
            conflict.code = "ARTIFACT_SOURCE_EVENT_CONFLICT";
            conflict.existingArtifactId = currentId;
            conflict.existingArtifactHash = currentHash;
            conflict.gotArtifactHash = String(artifactHash);
            throw conflict;
          }
        }

        const raced = new Error("artifact insert raced with another transaction");
        raced.code = "ARTIFACT_INSERT_RACE";
        throw raced;
		  }

  async function insertDeliveryRow(client, { tenantId, delivery }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!delivery || typeof delivery !== "object") throw new TypeError("delivery is required");
    assertNonEmptyString(delivery.destinationId, "delivery.destinationId");
    assertNonEmptyString(delivery.artifactType, "delivery.artifactType");
    assertNonEmptyString(delivery.artifactId, "delivery.artifactId");
    assertNonEmptyString(delivery.artifactHash, "delivery.artifactHash");
    assertNonEmptyString(delivery.dedupeKey, "delivery.dedupeKey");

    const res = await client.query(
      `
        INSERT INTO deliveries (tenant_id, destination_id, artifact_type, artifact_id, artifact_hash, dedupe_key, scope_key, order_seq, priority, order_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
        RETURNING id
      `,
      [
        tenantId,
        delivery.destinationId,
        delivery.artifactType,
        delivery.artifactId,
        delivery.artifactHash,
        delivery.dedupeKey,
        delivery.scopeKey ?? "",
        Number.isSafeInteger(delivery.orderSeq) ? delivery.orderSeq : 0,
        Number.isSafeInteger(delivery.priority) ? delivery.priority : 0,
        delivery.orderKey ?? null
      ]
    );
    return res.rows.length ? Number(res.rows[0].id) : null;
  }

  async function persistIngestRecords(client, { tenantId, records }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!Array.isArray(records)) throw new TypeError("records must be an array");
    for (const r of records) {
      if (!r || typeof r !== "object") continue;
      const source = r.source ?? null;
      const externalEventId = r.externalEventId ?? null;
      if (typeof source !== "string" || source.trim() === "") continue;
      if (typeof externalEventId !== "string" || externalEventId.trim() === "") continue;
      const status = r.status ?? null;
      if (typeof status !== "string" || status.trim() === "") continue;
      await client.query(
        `
          INSERT INTO ingest_records (
            tenant_id, source, external_event_id, status, reason, job_id, site_id, correlation_key,
            event_type, event_at, received_at, accepted_event_id, expires_at, record_json
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (tenant_id, source, external_event_id) DO NOTHING
        `,
        [
          tenantId,
          String(source),
          String(externalEventId),
          String(status),
          r.reason ?? null,
          r.jobId ?? null,
          r.siteId ?? null,
          r.correlationKey ?? null,
          r.type ?? null,
          r.at ? new Date(String(r.at)).toISOString() : null,
          r.receivedAt ? new Date(String(r.receivedAt)).toISOString() : null,
          r.acceptedEventId ?? null,
          r.expiresAt ? new Date(String(r.expiresAt)).toISOString() : null,
          JSON.stringify(r)
        ]
      );
    }
  }

	  async function processLedgerOutbox({ maxMessages = Number.MAX_SAFE_INTEGER } = {}) {
	    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new TypeError("maxMessages must be a non-negative safe integer");
	    const worker = "ledger_v0";

	    const processed = [];

	    while (processed.length < maxMessages) {
	      const batch = await withTx({ statementTimeoutMs: workerStatementTimeoutMs }, async (client) => {
	        const claim = await client.query(
          `
            SELECT id, payload_json
            FROM outbox
            WHERE processed_at IS NULL
              AND topic = 'LEDGER_ENTRY_APPLY'
            ORDER BY id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
          `,
          [Math.min(50, maxMessages - processed.length)]
	        );
	        if (!claim.rows.length) return [];

	        try {
	          store.metrics?.incCounter?.("outbox_claim_total", { kind: "LEDGER_ENTRY_APPLY" }, claim.rows.length);
	        } catch {}
	        logger.info("outbox.claim", { kind: "LEDGER_ENTRY_APPLY", worker, claimed: claim.rows.length });

	        const ids = claim.rows.map((r) => Number(r.id));
	        await client.query("UPDATE outbox SET worker = $1, claimed_at = now(), attempts = attempts + 1 WHERE id = ANY($2::bigint[])", [
	          worker,
	          ids
        ]);

        for (const row of claim.rows) {
          const message = row.payload_json;
          const entry = message?.entry ?? null;
          if (!entry?.id) {
            await client.query("UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1", [Number(row.id), "missing entry.id"]);
            continue;
	          }
	          const tenantId = normalizeTenantId(message?.tenantId ?? DEFAULT_TENANT_ID);

	          try {
	            logger.info("ledger.apply.start", {
	              tenantId,
	              requestId: message?.requestId ?? null,
	              outboxId: Number(row.id),
	              entryId: entry.id
	            });

	            const inserted = await client.query(
	              "INSERT INTO ledger_entries (tenant_id, entry_id, entry_json) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, entry_id) DO NOTHING RETURNING entry_id",
	              [tenantId, entry.id, JSON.stringify(entry)]
	            );

	            const jobId = typeof message?.jobId === "string" && message.jobId.trim() !== "" ? String(message.jobId) : null;

	            if (inserted.rows.length) {
	              for (const posting of entry.postings ?? []) {
	                if (!posting?.accountId || !Number.isSafeInteger(posting.amountCents)) continue;
	                await client.query(
	                  `
	                    INSERT INTO ledger_balances (tenant_id, account_id, balance_cents)
	                    VALUES ($1,$2,$3)
	                    ON CONFLICT (tenant_id, account_id) DO UPDATE SET balance_cents = ledger_balances.balance_cents + EXCLUDED.balance_cents
	                  `,
	                  [tenantId, posting.accountId, posting.amountCents]
	                );
	              }

	              // Keep in-memory balances in sync for tests and API responses.
	              try {
	                const ledger = typeof store.getLedger === "function" ? store.getLedger(tenantId) : store.ledger;
	                applyJournalEntry(ledger, entry);
	              } catch {
	                // Ignore: ledger entry is assumed already validated in core.
	              }

	              try {
	                store.metrics?.incCounter?.("ledger_apply_total", null, 1);
	              } catch {}

	              failpoint("ledger.apply.after_insert_before_outbox_done");
	            }

	            // Best-effort: persist per-party allocations if we can load the job snapshot.
	            // This must be idempotent and must not change ledger entry bytes.
	            if (jobId) {
	              try {
	                // Crash point after postings/balances are persisted but before any allocations are written.
	                // Used by deterministic kill-9 tests.
	                failpoint("ledger.apply.after_postings_before_allocations");

	                const jobRes = await client.query(
	                  "SELECT snapshot_json FROM snapshots WHERE tenant_id = $1 AND aggregate_type = 'job' AND aggregate_id = $2",
	                  [tenantId, jobId]
	                );
	                const job = jobRes.rows.length ? jobRes.rows[0].snapshot_json ?? null : null;
	                if (job && typeof job === "object") {
	                  let operatorContractDoc = null;
	                  const operatorContractHash = job?.operatorContractHash ?? null;
	                  if (typeof operatorContractHash === "string" && operatorContractHash.trim() !== "") {
	                    const cRes = await client.query(
	                      "SELECT doc_json FROM contracts_v2 WHERE tenant_id = $1 AND contract_hash = $2 LIMIT 1",
	                      [tenantId, String(operatorContractHash)]
	                    );
	                    if (cRes.rows.length) operatorContractDoc = cRes.rows[0].doc_json ?? null;
	                  }

		                  const allocations = allocateEntry({ tenantId, entry, job, operatorContractDoc, currency: "USD" });
		                  for (const a of allocations) {
		                    await client.query(
		                      `
		                        INSERT INTO ledger_allocations (tenant_id, entry_id, posting_id, account_id, party_id, party_role, currency, amount_cents)
		                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		                        ON CONFLICT (tenant_id, entry_id, posting_id, party_id) DO NOTHING
		                      `,
		                      [tenantId, a.entryId, a.postingId, a.accountId ?? null, a.partyId, a.partyRole, a.currency, a.amountCents]
		                    );
		                  }
		                }

	                // Crash point after allocations insert but before marking outbox done.
	                // Used by deterministic kill-9 tests.
	                failpoint("ledger.apply.after_allocations_before_outbox_done");
	              } catch (err) {
	                logger.error("ledger.allocations.failed", { tenantId, jobId, entryId: entry.id, err });
	                // Do not fail ledger apply if allocations cannot be persisted.
	              }
	            }

	            await client.query("UPDATE outbox SET processed_at = now(), last_error = NULL WHERE id = $1", [Number(row.id)]);
	            processed.push({ id: Number(row.id), entryId: entry.id });
	            logger.info("ledger.apply.done", {
	              tenantId,
	              requestId: message?.requestId ?? null,
	              outboxId: Number(row.id),
	              entryId: entry.id,
	              applied: inserted.rows.length > 0
	            });
	          } catch (err) {
	            try {
	              store.metrics?.incCounter?.("ledger_apply_fail_total", null, 1);
	            } catch {}
	            logger.error("ledger.apply.failed", {
	              tenantId,
	              requestId: message?.requestId ?? null,
	              outboxId: Number(row.id),
	              entryId: entry.id,
	              err
	            });
	            throw err;
	          }
	        }

	        return claim.rows;
	      });

      if (!batch.length) break;
    }

    // Refresh balances from DB to ensure correctness if multiple workers are running.
    await refreshLedgerBalances();

    return { processed, worker };
  }

  store.commitTx = async function commitTx({ at, ops, audit = null }) {
    if (!Array.isArray(ops) || ops.length === 0) throw new TypeError("commitTx requires non-empty ops[]");

    for (const op of ops) {
      if (!op?.kind) throw new TypeError("op.kind is required");
      assertKnownOpKind(op.kind);
    }

    const hasEventsAppended = ops.some((op) => typeof op?.kind === "string" && op.kind.endsWith("_EVENTS_APPENDED"));

    await withTx(async (client) => {
      for (const op of ops) {
        if (op.kind === "PUBLIC_KEY_PUT") {
          await persistPublicKey(client, { keyId: op.keyId, publicKeyPem: op.publicKeyPem });
        }
        if (op.kind === "SIGNER_KEY_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
          await persistSignerKey(client, { tenantId, signerKey: op.signerKey });
        }
        if (op.kind === "SIGNER_KEY_STATUS_SET") {
          const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
          await setSignerKeyStatusRow(client, { tenantId, keyId: op.keyId, status: op.status, at: op.at ?? at ?? new Date().toISOString() });
        }
        if (op.kind === "AGENT_IDENTITY_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.agentIdentity?.tenantId ?? DEFAULT_TENANT_ID);
          await persistAgentIdentity(client, { tenantId, agentIdentity: op.agentIdentity });
        }
        if (op.kind === "AGENT_WALLET_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.wallet?.tenantId ?? DEFAULT_TENANT_ID);
          await persistAgentWallet(client, { tenantId, wallet: op.wallet });
        }
        if (op.kind === "AGENT_RUN_EVENTS_APPENDED") {
          const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
          await insertEvents(client, { tenantId, aggregateType: "agent_run", aggregateId: op.runId, events: op.events });
          await rebuildSnapshot(client, { tenantId, aggregateType: "agent_run", aggregateId: op.runId });
        }
        if (op.kind === "AGENT_RUN_SETTLEMENT_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.settlement?.tenantId ?? DEFAULT_TENANT_ID);
          await persistAgentRunSettlement(client, { tenantId, runId: op.runId, settlement: op.settlement });
        }
        if (op.kind === "ARBITRATION_CASE_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.arbitrationCase?.tenantId ?? DEFAULT_TENANT_ID);
          await persistArbitrationCase(client, { tenantId, caseId: op.caseId, arbitrationCase: op.arbitrationCase });
        }
        if (op.kind === "AGREEMENT_DELEGATION_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.delegation?.tenantId ?? DEFAULT_TENANT_ID);
          await persistAgreementDelegation(client, { tenantId, delegationId: op.delegationId, delegation: op.delegation });
        }
        if (op.kind === "X402_GATE_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.gate?.tenantId ?? DEFAULT_TENANT_ID);
          await persistX402Gate(client, { tenantId, gateId: op.gateId, gate: op.gate });
        }
        if (op.kind === "TOOL_CALL_HOLD_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.hold?.tenantId ?? DEFAULT_TENANT_ID);
          await persistToolCallHold(client, { tenantId, holdHash: op.holdHash, hold: op.hold });
        }
        if (op.kind === "SETTLEMENT_ADJUSTMENT_PUT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.adjustment?.tenantId ?? DEFAULT_TENANT_ID);
          await persistSettlementAdjustment(client, { tenantId, adjustmentId: op.adjustmentId, adjustment: op.adjustment });
        }
        if (op.kind === "MARKETPLACE_RFQ_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.rfq?.tenantId ?? DEFAULT_TENANT_ID);
          await persistMarketplaceRfq(client, { tenantId, rfq: op.rfq });
        }
        if (op.kind === "MARKETPLACE_RFQ_BIDS_SET") {
          const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
          await persistMarketplaceRfqBids(client, { tenantId, rfqId: op.rfqId, bids: op.bids });
        }
        if (op.kind === "TENANT_SETTLEMENT_POLICY_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.policy?.tenantId ?? DEFAULT_TENANT_ID);
          await persistTenantSettlementPolicy(client, { tenantId, policy: op.policy });
        }
        if (op.kind === "JOB_EVENTS_APPENDED") {
          const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
          await insertEvents(client, { tenantId, aggregateType: "job", aggregateId: op.jobId, events: op.events });
          const snapshot = await rebuildSnapshot(client, { tenantId, aggregateType: "job", aggregateId: op.jobId });
          await syncRobotReservation(client, snapshot);
        }
        if (op.kind === "ROBOT_EVENTS_APPENDED") {
          const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
          await insertEvents(client, { tenantId, aggregateType: "robot", aggregateId: op.robotId, events: op.events });
          await rebuildSnapshot(client, { tenantId, aggregateType: "robot", aggregateId: op.robotId });
        }
        if (op.kind === "OPERATOR_EVENTS_APPENDED") {
          const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
          await insertEvents(client, { tenantId, aggregateType: "operator", aggregateId: op.operatorId, events: op.events });
          await rebuildSnapshot(client, { tenantId, aggregateType: "operator", aggregateId: op.operatorId });
        }
        if (op.kind === "MONTH_EVENTS_APPENDED") {
          const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
          await insertEvents(client, { tenantId, aggregateType: "month", aggregateId: op.monthId, events: op.events });
          await rebuildSnapshot(client, { tenantId, aggregateType: "month", aggregateId: op.monthId });
        }
        if (op.kind === "CONTRACT_UPSERT") {
          const tenantId = normalizeTenantId(op.tenantId ?? op.contract?.tenantId ?? DEFAULT_TENANT_ID);
          await persistContract(client, { tenantId, contract: op.contract });
        }
        if (op.kind === "IDEMPOTENCY_PUT") {
          await persistIdempotency(client, { key: op.key, value: op.value });
        }
        if (op.kind === "OUTBOX_ENQUEUE") {
          await enqueueOutbox(client, { messages: op.messages });
        }
        if (op.kind === "INGEST_RECORDS_PUT") {
          const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
          await persistIngestRecords(client, { tenantId, records: op.records });
        }
      }

      if (audit) {
        const tenantId = normalizeTenantId(audit?.tenantId ?? DEFAULT_TENANT_ID);
        await insertOpsAuditRow(client, { tenantId, audit });
      }
    });

    if (hasEventsAppended) failpoint("pg.append.after_commit");

    // Update in-memory projections for local process behavior (tests + single-process dev).
    try {
      applyTxRecord(store, { v: TX_LOG_VERSION, at: at ?? new Date().toISOString(), txId: "tx_pg", ops });
    } catch {
      // Ignore local projection update failures; DB is canonical.
    }

    // Apply any pending outbox-driven side-effects.
    await store.processOutbox({ maxMessages: 1000 });
  };

  store.refreshFromDb = async function refreshFromDb() {
    await refreshSnapshots();
    await refreshEvents();
    await refreshIdempotency();
    await refreshLedgerBalances();
    await refreshContracts();
    await refreshTenantBillingConfigs();
    await refreshMarketplaceRfqs();
    await refreshMarketplaceRfqBids();
    await refreshTenantSettlementPolicies();
    await refreshAgentIdentities();
    await refreshAgentWallets();
    await refreshAgentRunSettlements();
    await refreshAuthKeys();
    await refreshSignerKeys();
  };

  function agentRunSnapshotRowToRecord(row) {
    const run = row?.snapshot_json ?? null;
    if (!run || typeof run !== "object" || Array.isArray(run)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? run?.tenantId ?? DEFAULT_TENANT_ID);
    const runId = row?.aggregate_id ? String(row.aggregate_id) : run?.runId ? String(run.runId) : null;
    if (!runId) return null;
    return {
      ...run,
      tenantId,
      runId
    };
  }

  store.getAgentIdentity = async function getAgentIdentity({ tenantId = DEFAULT_TENANT_ID, agentId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(agentId, "agentId");
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, agent_id, status, display_name, owner_type, owner_id, revision, created_at, updated_at, identity_json
          FROM agent_identities
          WHERE tenant_id = $1 AND agent_id = $2
          LIMIT 1
        `,
        [tenantId, String(agentId)]
      );
      return res.rows.length ? agentIdentityRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return store.agentIdentities.get(makeScopedKey({ tenantId, id: String(agentId) })) ?? null;
    }
  };

  store.listAgentIdentities = async function listAgentIdentities({ tenantId = DEFAULT_TENANT_ID, status = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (status !== null) assertNonEmptyString(status, "status");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const statusFilter = status === null ? null : String(status).trim().toLowerCase();

    try {
      const params = [tenantId];
      const where = ["tenant_id = $1"];
      if (statusFilter !== null) {
        params.push(statusFilter);
        where.push(`lower(status) = $${params.length}`);
      }
      params.push(safeLimit);
      params.push(safeOffset);

      const res = await pool.query(
        `
          SELECT tenant_id, agent_id, status, display_name, owner_type, owner_id, revision, created_at, updated_at, identity_json
          FROM agent_identities
          WHERE ${where.join(" AND ")}
          ORDER BY agent_id ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params
      );
      return res.rows.map(agentIdentityRowToRecord).filter(Boolean);
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      const out = [];
      for (const record of store.agentIdentities.values()) {
        if (!record || typeof record !== "object") continue;
        if (normalizeTenantId(record.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (statusFilter !== null && String(record.status ?? "").toLowerCase() !== statusFilter) continue;
        out.push(record);
      }
      out.sort((left, right) => String(left.agentId ?? "").localeCompare(String(right.agentId ?? "")));
      return out.slice(safeOffset, safeOffset + safeLimit);
    }
  };

  store.getAgentWallet = async function getAgentWallet({ tenantId = DEFAULT_TENANT_ID, agentId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(agentId, "agentId");
    try {
      const res = await pool.query(
        `
          SELECT
            tenant_id, agent_id, wallet_id, currency,
            available_cents, escrow_locked_cents, total_credited_cents, total_debited_cents,
            revision, created_at, updated_at, wallet_json
          FROM agent_wallets
          WHERE tenant_id = $1 AND agent_id = $2
          LIMIT 1
        `,
        [tenantId, String(agentId)]
      );
      return res.rows.length ? agentWalletRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return store.agentWallets.get(makeScopedKey({ tenantId, id: String(agentId) })) ?? null;
    }
  };

  store.putAgentWallet = async function putAgentWallet({ tenantId = DEFAULT_TENANT_ID, wallet } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!wallet || typeof wallet !== "object" || Array.isArray(wallet)) throw new TypeError("wallet is required");
    const agentId = wallet.agentId ?? null;
    assertNonEmptyString(agentId, "wallet.agentId");
    await store.commitTx({
      at: wallet.updatedAt ?? new Date().toISOString(),
      ops: [{ kind: "AGENT_WALLET_UPSERT", tenantId, wallet: { ...wallet, tenantId, agentId: String(agentId) } }]
    });
    return store.getAgentWallet({ tenantId, agentId: String(agentId) });
  };

  store.getAgentRun = async function getAgentRun({ tenantId = DEFAULT_TENANT_ID, runId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(runId, "runId");
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, aggregate_id, snapshot_json
          FROM snapshots
          WHERE tenant_id = $1 AND aggregate_type = 'agent_run' AND aggregate_id = $2
          LIMIT 1
        `,
        [tenantId, String(runId)]
      );
      return res.rows.length ? agentRunSnapshotRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return store.agentRuns.get(makeScopedKey({ tenantId, id: String(runId) })) ?? null;
    }
  };

  store.listAgentRuns = async function listAgentRuns({ tenantId = DEFAULT_TENANT_ID, agentId = null, status = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (agentId !== null) assertNonEmptyString(agentId, "agentId");
    if (status !== null) assertNonEmptyString(status, "status");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const statusFilter = status === null ? null : String(status).trim().toLowerCase();
    const agentIdFilter = agentId === null ? null : String(agentId);

    try {
      const res = await pool.query(
        `
          SELECT tenant_id, aggregate_id, snapshot_json
          FROM snapshots
          WHERE tenant_id = $1
            AND aggregate_type = 'agent_run'
            AND ($2::text IS NULL OR snapshot_json->>'agentId' = $2)
            AND ($3::text IS NULL OR lower(snapshot_json->>'status') = $3)
          ORDER BY aggregate_id ASC
          LIMIT $4 OFFSET $5
        `,
        [tenantId, agentIdFilter, statusFilter, safeLimit, safeOffset]
      );
      return res.rows.map(agentRunSnapshotRowToRecord).filter(Boolean);
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      const out = [];
      for (const run of store.agentRuns.values()) {
        if (!run || typeof run !== "object") continue;
        if (normalizeTenantId(run.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (agentIdFilter !== null && String(run.agentId ?? "") !== agentIdFilter) continue;
        if (statusFilter !== null && String(run.status ?? "").toLowerCase() !== statusFilter) continue;
        out.push(run);
      }
      out.sort((left, right) => String(left.runId ?? "").localeCompare(String(right.runId ?? "")));
      return out.slice(safeOffset, safeOffset + safeLimit);
    }
  };

  store.countAgentRuns = async function countAgentRuns({ tenantId = DEFAULT_TENANT_ID, agentId = null, status = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (agentId !== null) assertNonEmptyString(agentId, "agentId");
    if (status !== null) assertNonEmptyString(status, "status");
    const statusFilter = status === null ? null : String(status).trim().toLowerCase();
    const agentIdFilter = agentId === null ? null : String(agentId);

    try {
      const res = await pool.query(
        `
          SELECT COUNT(*)::bigint AS c
          FROM snapshots
          WHERE tenant_id = $1
            AND aggregate_type = 'agent_run'
            AND ($2::text IS NULL OR snapshot_json->>'agentId' = $2)
            AND ($3::text IS NULL OR lower(snapshot_json->>'status') = $3)
        `,
        [tenantId, agentIdFilter, statusFilter]
      );
      const c = Number(res.rows[0]?.c ?? 0);
      return Number.isSafeInteger(c) && c >= 0 ? c : 0;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      let count = 0;
      for (const run of store.agentRuns.values()) {
        if (!run || typeof run !== "object") continue;
        if (normalizeTenantId(run.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (agentIdFilter !== null && String(run.agentId ?? "") !== agentIdFilter) continue;
        if (statusFilter !== null && String(run.status ?? "").toLowerCase() !== statusFilter) continue;
        count += 1;
      }
      return count;
    }
  };

  store.getAgentRunEvents = async function getAgentRunEvents({ tenantId = DEFAULT_TENANT_ID, runId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(runId, "runId");
    try {
      const res = await pool.query(
        `
          SELECT event_json
          FROM events
          WHERE tenant_id = $1 AND aggregate_type = 'agent_run' AND aggregate_id = $2
          ORDER BY seq ASC
        `,
        [tenantId, String(runId)]
      );
      return res.rows.map((row) => normalizeAgentRunEventRecord(row?.event_json)).filter(Boolean);
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return (store.agentRunEvents.get(makeScopedKey({ tenantId, id: String(runId) })) ?? []).map(normalizeAgentRunEventRecord);
    }
  };

  store.getAgentRunSettlement = async function getAgentRunSettlement({ tenantId = DEFAULT_TENANT_ID, runId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(runId, "runId");
    try {
      const res = await pool.query(
        `
          SELECT
            tenant_id, run_id, status, agent_id, payer_agent_id, amount_cents, currency,
            resolution_event_id, run_status, revision, locked_at, resolved_at, created_at, updated_at, settlement_json
          FROM agent_run_settlements
          WHERE tenant_id = $1 AND run_id = $2
          LIMIT 1
        `,
        [tenantId, String(runId)]
      );
      return res.rows.length ? agentRunSettlementRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return store.agentRunSettlements.get(makeScopedKey({ tenantId, id: String(runId) })) ?? null;
    }
  };

  store.sumWalletPolicySpendCentsForDay = async function sumWalletPolicySpendCentsForDay({
    tenantId = DEFAULT_TENANT_ID,
    agentId,
    dayStartIso,
    dayEndIso
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(agentId, "agentId");
    assertNonEmptyString(dayStartIso, "dayStartIso");
    assertNonEmptyString(dayEndIso, "dayEndIso");
    const startMs = Date.parse(dayStartIso);
    const endMs = Date.parse(dayEndIso);
    if (!Number.isFinite(startMs)) throw new TypeError("dayStartIso must be an ISO date string");
    if (!Number.isFinite(endMs)) throw new TypeError("dayEndIso must be an ISO date string");
    if (!(endMs > startMs)) throw new TypeError("dayEndIso must be after dayStartIso");

    let runSum = 0;
    try {
      const res = await pool.query(
        `
          SELECT COALESCE(SUM(amount_cents), 0)::bigint AS c
          FROM agent_run_settlements
          WHERE tenant_id = $1
            AND payer_agent_id = $2
            AND locked_at >= $3
            AND locked_at < $4
        `,
        [tenantId, String(agentId), String(dayStartIso), String(dayEndIso)]
      );
      const n = Number(res.rows[0]?.c ?? 0);
      runSum = Number.isSafeInteger(n) && n >= 0 ? n : 0;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      for (const row of store.agentRunSettlements.values()) {
        if (!row || typeof row !== "object") continue;
        if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (String(row.payerAgentId ?? "") !== String(agentId)) continue;
        const lockedAt = row.lockedAt ?? null;
        const lockedMs = typeof lockedAt === "string" ? Date.parse(lockedAt) : NaN;
        if (!Number.isFinite(lockedMs)) continue;
        if (lockedMs < startMs || lockedMs >= endMs) continue;
        const amountCents = Number(row.amountCents ?? 0);
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) continue;
        runSum += amountCents;
      }
    }

    let holdSum = 0;
    try {
      const res = await pool.query(
        `
          SELECT COALESCE(SUM((snapshot_json->>'heldAmountCents')::bigint), 0)::bigint AS c
          FROM snapshots
          WHERE tenant_id = $1
            AND aggregate_type = 'tool_call_hold'
            AND snapshot_json->>'payerAgentId' = $2
            AND (snapshot_json->>'createdAt')::timestamptz >= $3::timestamptz
            AND (snapshot_json->>'createdAt')::timestamptz < $4::timestamptz
        `,
        [tenantId, String(agentId), String(dayStartIso), String(dayEndIso)]
      );
      const n = Number(res.rows[0]?.c ?? 0);
      holdSum = Number.isSafeInteger(n) && n >= 0 ? n : 0;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      for (const row of store.toolCallHolds.values()) {
        if (!row || typeof row !== "object") continue;
        if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (String(row.payerAgentId ?? "") !== String(agentId)) continue;
        const createdAt = row.createdAt ?? null;
        const createdMs = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
        if (!Number.isFinite(createdMs)) continue;
        if (createdMs < startMs || createdMs >= endMs) continue;
        const heldAmountCents = Number(row.heldAmountCents ?? 0);
        if (!Number.isSafeInteger(heldAmountCents) || heldAmountCents <= 0) continue;
        holdSum += heldAmountCents;
      }
    }

    return runSum + holdSum;
  };

  function arbitrationCaseSnapshotRowToRecord(row) {
    const arbitrationCase = row?.snapshot_json ?? null;
    if (!arbitrationCase || typeof arbitrationCase !== "object" || Array.isArray(arbitrationCase)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? arbitrationCase?.tenantId ?? DEFAULT_TENANT_ID);
    const caseId = row?.aggregate_id ? String(row.aggregate_id) : arbitrationCase?.caseId ? String(arbitrationCase.caseId) : null;
    if (!caseId) return null;
    return {
      ...arbitrationCase,
      tenantId,
      caseId
    };
  }

  function toolCallHoldSnapshotRowToRecord(row) {
    const hold = row?.snapshot_json ?? null;
    if (!hold || typeof hold !== "object" || Array.isArray(hold)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? hold?.tenantId ?? DEFAULT_TENANT_ID);
    const holdHash = row?.aggregate_id ? String(row.aggregate_id) : hold?.holdHash ? String(hold.holdHash) : null;
    if (!holdHash) return null;
    return {
      ...hold,
      tenantId,
      holdHash
    };
  }

  function settlementAdjustmentSnapshotRowToRecord(row) {
    const adjustment = row?.snapshot_json ?? null;
    if (!adjustment || typeof adjustment !== "object" || Array.isArray(adjustment)) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? adjustment?.tenantId ?? DEFAULT_TENANT_ID);
    const adjustmentId =
      row?.aggregate_id ? String(row.aggregate_id) : adjustment?.adjustmentId ? String(adjustment.adjustmentId) : null;
    if (!adjustmentId) return null;
    return {
      ...adjustment,
      tenantId,
      adjustmentId
    };
  }

  store.getArbitrationCase = async function getArbitrationCase({ tenantId = DEFAULT_TENANT_ID, caseId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(caseId, "caseId");
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, aggregate_id, snapshot_json
          FROM snapshots
          WHERE tenant_id = $1 AND aggregate_type = 'arbitration_case' AND aggregate_id = $2
          LIMIT 1
        `,
        [tenantId, String(caseId)]
      );
      return res.rows.length ? arbitrationCaseSnapshotRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return store.arbitrationCases.get(makeScopedKey({ tenantId, id: String(caseId) })) ?? null;
    }
  };

  store.getToolCallHold = async function getToolCallHold({ tenantId = DEFAULT_TENANT_ID, holdHash } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(holdHash, "holdHash");
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, aggregate_id, snapshot_json
          FROM snapshots
          WHERE tenant_id = $1 AND aggregate_type = 'tool_call_hold' AND aggregate_id = $2
          LIMIT 1
        `,
        [tenantId, String(holdHash)]
      );
      return res.rows.length ? toolCallHoldSnapshotRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return store.toolCallHolds.get(makeScopedKey({ tenantId, id: String(holdHash) })) ?? null;
    }
  };

  store.listToolCallHolds = async function listToolCallHolds({
    tenantId = DEFAULT_TENANT_ID,
    agreementHash = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (agreementHash !== null) assertNonEmptyString(agreementHash, "agreementHash");
    if (status !== null) assertNonEmptyString(status, "status");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    try {
      const params = [tenantId];
      const where = ["tenant_id = $1", "aggregate_type = 'tool_call_hold'"];
      if (agreementHash !== null) {
        params.push(String(agreementHash).toLowerCase());
        where.push(`lower(snapshot_json->>'agreementHash') = $${params.length}`);
      }
      if (status !== null) {
        params.push(String(status).toLowerCase());
        where.push(`lower(snapshot_json->>'status') = $${params.length}`);
      }
      params.push(safeLimit);
      params.push(safeOffset);
      const res = await pool.query(
        `
          SELECT tenant_id, aggregate_id, snapshot_json
          FROM snapshots
          WHERE ${where.join(" AND ")}
          ORDER BY aggregate_id ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params
      );
      return res.rows.map(toolCallHoldSnapshotRowToRecord).filter(Boolean);
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      const out = [];
      const statusFilter = status === null ? null : String(status).toLowerCase();
      const agreementFilter = agreementHash === null ? null : String(agreementHash).toLowerCase();
      for (const row of store.toolCallHolds.values()) {
        if (!row || typeof row !== "object") continue;
        if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (agreementFilter && String(row.agreementHash ?? "").toLowerCase() !== agreementFilter) continue;
        if (statusFilter && String(row.status ?? "").toLowerCase() !== statusFilter) continue;
        out.push(row);
      }
      out.sort((a, b) => String(a.holdHash ?? "").localeCompare(String(b.holdHash ?? "")));
      return out.slice(safeOffset, safeOffset + safeLimit);
    }
  };

  store.getSettlementAdjustment = async function getSettlementAdjustment({ tenantId = DEFAULT_TENANT_ID, adjustmentId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(adjustmentId, "adjustmentId");
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, aggregate_id, snapshot_json
          FROM snapshots
          WHERE tenant_id = $1 AND aggregate_type = 'settlement_adjustment' AND aggregate_id = $2
          LIMIT 1
        `,
        [tenantId, String(adjustmentId)]
      );
      return res.rows.length ? settlementAdjustmentSnapshotRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return store.settlementAdjustments.get(makeScopedKey({ tenantId, id: String(adjustmentId) })) ?? null;
    }
  };

  store.listArbitrationCases = async function listArbitrationCases({
    tenantId = DEFAULT_TENANT_ID,
    runId = null,
    disputeId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (runId !== null) assertNonEmptyString(runId, "runId");
    if (disputeId !== null) assertNonEmptyString(disputeId, "disputeId");
    if (status !== null) assertNonEmptyString(status, "status");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    try {
      const params = [tenantId];
      const where = ["tenant_id = $1", "aggregate_type = 'arbitration_case'"];
      if (runId !== null) {
        params.push(String(runId));
        where.push(`snapshot_json->>'runId' = $${params.length}`);
      }
      if (disputeId !== null) {
        params.push(String(disputeId));
        where.push(`snapshot_json->>'disputeId' = $${params.length}`);
      }
      if (status !== null) {
        params.push(String(status).toLowerCase());
        where.push(`lower(snapshot_json->>'status') = $${params.length}`);
      }
      params.push(safeLimit);
      params.push(safeOffset);
      const res = await pool.query(
        `
          SELECT tenant_id, aggregate_id, snapshot_json
          FROM snapshots
          WHERE ${where.join(" AND ")}
          ORDER BY aggregate_id ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params
      );
      return res.rows.map(arbitrationCaseSnapshotRowToRecord).filter(Boolean);
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      const statusFilter = status === null ? null : String(status).toLowerCase();
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
    }
  };

  store.getMoneyRailOperation = async function getMoneyRailOperation({ tenantId = DEFAULT_TENANT_ID, providerId, operationId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(providerId, "providerId");
    assertNonEmptyString(operationId, "operationId");
    try {
      const res = await pool.query(
        `
          SELECT
            tenant_id, provider_id, operation_id, direction, idempotency_key, amount_cents, currency, counterparty_ref,
            state, provider_ref, reason_code, initiated_at, submitted_at, confirmed_at, failed_at, cancelled_at, reversed_at,
            request_hash, metadata_json, operation_json, created_at, updated_at
          FROM money_rail_operations
          WHERE tenant_id = $1 AND provider_id = $2 AND operation_id = $3
          LIMIT 1
        `,
        [tenantId, String(providerId), String(operationId)]
      );
      return res.rows.length ? moneyRailOperationRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return store.moneyRailOperations.get(moneyRailOperationMapKey({ tenantId, providerId, operationId })) ?? null;
    }
  };

  store.findMoneyRailOperationByIdempotency = async function findMoneyRailOperationByIdempotency({
    tenantId = DEFAULT_TENANT_ID,
    providerId,
    direction,
    idempotencyKey
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(providerId, "providerId");
    assertNonEmptyString(direction, "direction");
    assertNonEmptyString(idempotencyKey, "idempotencyKey");
    try {
      const res = await pool.query(
        `
          SELECT
            tenant_id, provider_id, operation_id, direction, idempotency_key, amount_cents, currency, counterparty_ref,
            state, provider_ref, reason_code, initiated_at, submitted_at, confirmed_at, failed_at, cancelled_at, reversed_at,
            request_hash, metadata_json, operation_json, created_at, updated_at
          FROM money_rail_operations
          WHERE tenant_id = $1 AND provider_id = $2 AND lower(direction) = $3 AND idempotency_key = $4
          LIMIT 1
        `,
        [tenantId, String(providerId), String(direction).toLowerCase(), String(idempotencyKey)]
      );
      return res.rows.length ? moneyRailOperationRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      for (const operation of store.moneyRailOperations.values()) {
        if (!operation || typeof operation !== "object") continue;
        if (normalizeTenantId(operation.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (String(operation.providerId ?? "") !== String(providerId)) continue;
        if (String(operation.direction ?? "").toLowerCase() !== String(direction).toLowerCase()) continue;
        if (String(operation.idempotencyKey ?? "") !== String(idempotencyKey)) continue;
        return operation;
      }
      return null;
    }
  };

  store.listMoneyRailOperations = async function listMoneyRailOperations({
    tenantId = DEFAULT_TENANT_ID,
    providerId = null,
    direction = null,
    state = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (providerId !== null) assertNonEmptyString(providerId, "providerId");
    if (direction !== null) assertNonEmptyString(direction, "direction");
    if (state !== null) assertNonEmptyString(state, "state");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    try {
      const params = [tenantId];
      const where = ["tenant_id = $1"];
      if (providerId !== null) {
        params.push(String(providerId));
        where.push(`provider_id = $${params.length}`);
      }
      if (direction !== null) {
        params.push(String(direction).toLowerCase());
        where.push(`lower(direction) = $${params.length}`);
      }
      if (state !== null) {
        params.push(String(state).toLowerCase());
        where.push(`lower(state) = $${params.length}`);
      }
      params.push(safeLimit);
      params.push(safeOffset);
      const res = await pool.query(
        `
          SELECT
            tenant_id, provider_id, operation_id, direction, idempotency_key, amount_cents, currency, counterparty_ref,
            state, provider_ref, reason_code, initiated_at, submitted_at, confirmed_at, failed_at, cancelled_at, reversed_at,
            request_hash, metadata_json, operation_json, created_at, updated_at
          FROM money_rail_operations
          WHERE ${where.join(" AND ")}
          ORDER BY operation_id ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params
      );
      return res.rows.map(moneyRailOperationRowToRecord).filter(Boolean);
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      const out = [];
      const normalizedProviderId = providerId === null ? null : String(providerId);
      const normalizedDirection = direction === null ? null : String(direction).toLowerCase();
      const normalizedState = state === null ? null : String(state).toLowerCase();
      for (const operation of store.moneyRailOperations.values()) {
        if (!operation || typeof operation !== "object") continue;
        if (normalizeTenantId(operation.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (normalizedProviderId !== null && String(operation.providerId ?? "") !== normalizedProviderId) continue;
        if (normalizedDirection !== null && String(operation.direction ?? "").toLowerCase() !== normalizedDirection) continue;
        if (normalizedState !== null && String(operation.state ?? "").toLowerCase() !== normalizedState) continue;
        out.push(operation);
      }
      out.sort((left, right) => String(left.operationId ?? "").localeCompare(String(right.operationId ?? "")));
      return out.slice(safeOffset, safeOffset + safeLimit);
    }
  };

  store.putMoneyRailOperation = async function putMoneyRailOperation({
    tenantId = DEFAULT_TENANT_ID,
    providerId,
    operation,
    requestHash = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(providerId, "providerId");
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new TypeError("operation is required");

    const operationId = assertNonEmptyString(operation.operationId ?? null, "operation.operationId");
    const direction = assertNonEmptyString(operation.direction ?? null, "operation.direction").toLowerCase();
    const idempotencyKey = assertNonEmptyString(operation.idempotencyKey ?? null, "operation.idempotencyKey");
    const amountCents = parseSafeIntegerOrNull(operation.amountCents);
    if (amountCents === null || amountCents <= 0) throw new TypeError("operation.amountCents must be a positive safe integer");
    const currency =
      operation.currency && String(operation.currency).trim() !== "" ? String(operation.currency).toUpperCase() : "USD";
    const counterpartyRef = assertNonEmptyString(operation.counterpartyRef ?? null, "operation.counterpartyRef");
    const state = assertNonEmptyString(operation.state ?? null, "operation.state").toLowerCase();
    const initiatedAt = parseIsoOrNull(operation.initiatedAt ?? operation.createdAt ?? new Date().toISOString());
    if (!initiatedAt) throw new TypeError("operation.initiatedAt must be an ISO date-time");
    const createdAt = parseIsoOrNull(operation.createdAt) ?? initiatedAt;
    const updatedAt = parseIsoOrNull(operation.updatedAt) ?? createdAt;

    const normalizedOperation = {
      ...operation,
      tenantId,
      providerId: String(providerId),
      operationId,
      direction,
      idempotencyKey,
      amountCents,
      currency,
      counterpartyRef,
      state,
      providerRef: operation.providerRef ?? null,
      reasonCode: operation.reasonCode ?? null,
      initiatedAt,
      submittedAt: parseIsoOrNull(operation.submittedAt),
      confirmedAt: parseIsoOrNull(operation.confirmedAt),
      failedAt: parseIsoOrNull(operation.failedAt),
      cancelledAt: parseIsoOrNull(operation.cancelledAt),
      reversedAt: parseIsoOrNull(operation.reversedAt),
      metadata:
        operation.metadata && typeof operation.metadata === "object" && !Array.isArray(operation.metadata)
          ? operation.metadata
          : null,
      requestHash:
        requestHash !== null && requestHash !== undefined && String(requestHash).trim() !== ""
          ? String(requestHash)
          : operation.requestHash ?? null,
      createdAt,
      updatedAt
    };

    try {
      const res = await pool.query(
        `
          INSERT INTO money_rail_operations (
            tenant_id, provider_id, operation_id, direction, idempotency_key, amount_cents, currency, counterparty_ref,
            state, provider_ref, reason_code, initiated_at, submitted_at, confirmed_at, failed_at, cancelled_at, reversed_at,
            request_hash, metadata_json, operation_json, created_at, updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
          ON CONFLICT (tenant_id, provider_id, operation_id) DO UPDATE SET
            direction = EXCLUDED.direction,
            idempotency_key = EXCLUDED.idempotency_key,
            amount_cents = EXCLUDED.amount_cents,
            currency = EXCLUDED.currency,
            counterparty_ref = EXCLUDED.counterparty_ref,
            state = EXCLUDED.state,
            provider_ref = EXCLUDED.provider_ref,
            reason_code = EXCLUDED.reason_code,
            initiated_at = EXCLUDED.initiated_at,
            submitted_at = EXCLUDED.submitted_at,
            confirmed_at = EXCLUDED.confirmed_at,
            failed_at = EXCLUDED.failed_at,
            cancelled_at = EXCLUDED.cancelled_at,
            reversed_at = EXCLUDED.reversed_at,
            request_hash = EXCLUDED.request_hash,
            metadata_json = EXCLUDED.metadata_json,
            operation_json = EXCLUDED.operation_json,
            updated_at = EXCLUDED.updated_at
          RETURNING
            tenant_id, provider_id, operation_id, direction, idempotency_key, amount_cents, currency, counterparty_ref,
            state, provider_ref, reason_code, initiated_at, submitted_at, confirmed_at, failed_at, cancelled_at, reversed_at,
            request_hash, metadata_json, operation_json, created_at, updated_at,
            (xmax = 0) AS inserted
        `,
        [
          tenantId,
          normalizedOperation.providerId,
          operationId,
          direction,
          idempotencyKey,
          amountCents,
          currency,
          counterpartyRef,
          state,
          normalizedOperation.providerRef,
          normalizedOperation.reasonCode,
          initiatedAt,
          normalizedOperation.submittedAt,
          normalizedOperation.confirmedAt,
          normalizedOperation.failedAt,
          normalizedOperation.cancelledAt,
          normalizedOperation.reversedAt,
          normalizedOperation.requestHash,
          normalizedOperation.metadata,
          normalizedOperation,
          createdAt,
          updatedAt
        ]
      );
      const record = res.rows.length ? moneyRailOperationRowToRecord(res.rows[0]) : normalizedOperation;
      return { operation: record, created: Boolean(res.rows[0]?.inserted) };
    } catch (err) {
      if (err?.code === "23505" && err?.constraint === "money_rail_operations_tenant_provider_direction_idem_key") {
        const conflict = new Error("idempotency key was already used with a different operation");
        conflict.code = "MONEY_RAIL_IDEMPOTENCY_CONFLICT";
        throw conflict;
      }
      if (err?.code !== "42P01") throw err;
      const mapKey = moneyRailOperationMapKey({ tenantId, providerId, operationId });
      const existing = store.moneyRailOperations.get(mapKey) ?? null;
      if (existing) {
        if (normalizedOperation.requestHash && existing.requestHash && String(existing.requestHash) !== String(normalizedOperation.requestHash)) {
          const conflict = new Error("operationId already exists with a different request");
          conflict.code = "MONEY_RAIL_OPERATION_CONFLICT";
          throw conflict;
        }
        const next = { ...existing, ...normalizedOperation, createdAt: existing.createdAt ?? normalizedOperation.createdAt };
        store.moneyRailOperations.set(mapKey, next);
        return { operation: next, created: false };
      }
      store.moneyRailOperations.set(mapKey, normalizedOperation);
      return { operation: normalizedOperation, created: true };
    }
  };

  store.getMoneyRailProviderEvent = async function getMoneyRailProviderEvent({
    tenantId = DEFAULT_TENANT_ID,
    providerId,
    operationId,
    eventType,
    eventDedupeKey
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(providerId, "providerId");
    assertNonEmptyString(operationId, "operationId");
    assertNonEmptyString(eventType, "eventType");
    assertNonEmptyString(eventDedupeKey, "eventDedupeKey");
    try {
      const res = await pool.query(
        `
          SELECT tenant_id, provider_id, operation_id, event_type, event_dedupe_key, event_id, at, payload_json, event_json, created_at
          FROM money_rail_provider_events
          WHERE tenant_id = $1 AND provider_id = $2 AND operation_id = $3 AND event_type = $4 AND event_dedupe_key = $5
          LIMIT 1
        `,
        [tenantId, String(providerId), String(operationId), String(eventType).toLowerCase(), String(eventDedupeKey)]
      );
      return res.rows.length ? moneyRailProviderEventRowToRecord(res.rows[0]) : null;
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      return store.moneyRailProviderEvents.get(
        moneyRailProviderEventMapKey({ tenantId, providerId, operationId, eventType: String(eventType).toLowerCase(), eventDedupeKey })
      ) ?? null;
    }
  };

  store.putMoneyRailProviderEvent = async function putMoneyRailProviderEvent({
    tenantId = DEFAULT_TENANT_ID,
    providerId,
    operationId,
    event
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(providerId, "providerId");
    assertNonEmptyString(operationId, "operationId");
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event is required");
    const eventType = assertNonEmptyString(event.eventType ?? null, "event.eventType").toLowerCase();
    const eventDedupeKey = assertNonEmptyString(event.eventDedupeKey ?? null, "event.eventDedupeKey");
    const at = parseIsoOrNull(event.at);
    if (!at) throw new TypeError("event.at must be an ISO date-time");
    const normalizedEvent = {
      ...event,
      tenantId,
      providerId: String(providerId),
      operationId: String(operationId),
      eventType,
      eventDedupeKey,
      at,
      createdAt: parseIsoOrNull(event.createdAt) ?? at
    };

    try {
      const inserted = await pool.query(
        `
          INSERT INTO money_rail_provider_events (
            tenant_id, provider_id, operation_id, event_type, event_dedupe_key, event_id, at, payload_json, event_json, created_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (tenant_id, provider_id, operation_id, event_type, event_dedupe_key) DO NOTHING
          RETURNING tenant_id, provider_id, operation_id, event_type, event_dedupe_key, event_id, at, payload_json, event_json, created_at
        `,
        [
          tenantId,
          normalizedEvent.providerId,
          normalizedEvent.operationId,
          eventType,
          eventDedupeKey,
          normalizedEvent.eventId ?? null,
          normalizedEvent.at,
          normalizedEvent.payload ?? null,
          normalizedEvent,
          normalizedEvent.createdAt
        ]
      );
      if (inserted.rows.length) {
        const record = moneyRailProviderEventRowToRecord(inserted.rows[0]) ?? normalizedEvent;
        return { event: record, created: true };
      }
      const existing = await store.getMoneyRailProviderEvent({
        tenantId,
        providerId: normalizedEvent.providerId,
        operationId: normalizedEvent.operationId,
        eventType,
        eventDedupeKey
      });
      return { event: existing ?? normalizedEvent, created: false };
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      const key = moneyRailProviderEventMapKey({
        tenantId,
        providerId: normalizedEvent.providerId,
        operationId: normalizedEvent.operationId,
        eventType,
        eventDedupeKey
      });
      const existing = store.moneyRailProviderEvents.get(key) ?? null;
      if (existing) return { event: existing, created: false };
      store.moneyRailProviderEvents.set(key, normalizedEvent);
      return { event: normalizedEvent, created: true };
    }
  };

  store.appendBillableUsageEvent = async function appendBillableUsageEvent({ tenantId = DEFAULT_TENANT_ID, event } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event is required");
    const eventKey = assertNonEmptyString(event.eventKey ?? null, "event.eventKey");
    const eventType = assertNonEmptyString(event.eventType ?? null, "event.eventType").toLowerCase();
    const occurredAt = parseIsoOrNull(event.occurredAt ?? event.createdAt ?? new Date().toISOString());
    if (!occurredAt) throw new TypeError("event.occurredAt must be an ISO date-time");
    const period =
      typeof event.period === "string" && /^\d{4}-\d{2}$/.test(event.period.trim())
        ? event.period.trim()
        : occurredAt.slice(0, 7);
    const quantity = parseSafeIntegerOrNull(event.quantity ?? 1);
    if (quantity === null || quantity < 0) throw new TypeError("event.quantity must be a non-negative safe integer");
    const amountCents = event.amountCents === null || event.amountCents === undefined ? null : parseSafeIntegerOrNull(event.amountCents);
    const normalizedEvent = {
      ...event,
      schemaVersion: event.schemaVersion ?? "BillableUsageEvent.v1",
      tenantId,
      eventKey,
      eventType,
      period,
      occurredAt,
      quantity,
      amountCents,
      currency:
        event.currency === null || event.currency === undefined || String(event.currency).trim() === ""
          ? null
          : String(event.currency).toUpperCase(),
      createdAt: parseIsoOrNull(event.createdAt) ?? occurredAt
    };

    try {
      const inserted = await pool.query(
        `
          INSERT INTO billable_usage_events (
            tenant_id, event_key, event_type, period, occurred_at, quantity, amount_cents, currency,
            run_id, settlement_id, dispute_id, arbitration_case_id, source_type, source_id, source_event_id,
            event_hash, audit_json, event_json, created_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          ON CONFLICT (tenant_id, event_key) DO NOTHING
          RETURNING
            tenant_id, event_key, event_type, period, occurred_at, quantity, amount_cents, currency,
            run_id, settlement_id, dispute_id, arbitration_case_id, source_type, source_id, source_event_id,
            event_hash, audit_json, event_json, created_at
        `,
        [
          tenantId,
          eventKey,
          eventType,
          period,
          occurredAt,
          quantity,
          amountCents,
          normalizedEvent.currency,
          normalizedEvent.runId ?? null,
          normalizedEvent.settlementId ?? null,
          normalizedEvent.disputeId ?? null,
          normalizedEvent.arbitrationCaseId ?? null,
          normalizedEvent.sourceType ?? null,
          normalizedEvent.sourceId ?? null,
          normalizedEvent.sourceEventId ?? null,
          normalizedEvent.eventHash ?? null,
          normalizedEvent.audit ?? null,
          normalizedEvent,
          normalizedEvent.createdAt
        ]
      );
      if (inserted.rows.length) {
        return { event: billableUsageEventRowToRecord(inserted.rows[0]) ?? normalizedEvent, appended: true };
      }
      const existingRes = await pool.query(
        `
          SELECT
            tenant_id, event_key, event_type, period, occurred_at, quantity, amount_cents, currency,
            run_id, settlement_id, dispute_id, arbitration_case_id, source_type, source_id, source_event_id,
            event_hash, audit_json, event_json, created_at
          FROM billable_usage_events
          WHERE tenant_id = $1 AND event_key = $2
          LIMIT 1
        `,
        [tenantId, eventKey]
      );
      const existing = existingRes.rows.length ? billableUsageEventRowToRecord(existingRes.rows[0]) : null;
      if (existing && normalizedEvent.eventHash && existing.eventHash && String(existing.eventHash) !== String(normalizedEvent.eventHash)) {
        const conflict = new Error("billable usage event key already exists with different immutable fields");
        conflict.code = "BILLABLE_USAGE_EVENT_CONFLICT";
        throw conflict;
      }
      return { event: existing ?? normalizedEvent, appended: false };
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      const key = billableUsageEventMapKey({ tenantId, eventKey });
      const existing = store.billableUsageEvents.get(key) ?? null;
      if (existing) {
        if (normalizedEvent.eventHash && existing.eventHash && String(normalizedEvent.eventHash) !== String(existing.eventHash)) {
          const conflict = new Error("billable usage event key already exists with different immutable fields");
          conflict.code = "BILLABLE_USAGE_EVENT_CONFLICT";
          throw conflict;
        }
        return { event: existing, appended: false };
      }
      store.billableUsageEvents.set(key, normalizedEvent);
      return { event: normalizedEvent, appended: true };
    }
  };

  store.listBillableUsageEvents = async function listBillableUsageEvents({
    tenantId = DEFAULT_TENANT_ID,
    period = null,
    eventType = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (period !== null && (typeof period !== "string" || !/^\d{4}-\d{2}$/.test(period.trim()))) {
      throw new TypeError("period must match YYYY-MM");
    }
    if (eventType !== null) assertNonEmptyString(eventType, "eventType");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    try {
      const params = [tenantId];
      const where = ["tenant_id = $1"];
      if (period !== null) {
        params.push(String(period).trim());
        where.push(`period = $${params.length}`);
      }
      if (eventType !== null) {
        params.push(String(eventType).toLowerCase());
        where.push(`lower(event_type) = $${params.length}`);
      }
      params.push(safeLimit);
      params.push(safeOffset);
      const res = await pool.query(
        `
          SELECT
            tenant_id, event_key, event_type, period, occurred_at, quantity, amount_cents, currency,
            run_id, settlement_id, dispute_id, arbitration_case_id, source_type, source_id, source_event_id,
            event_hash, audit_json, event_json, created_at
          FROM billable_usage_events
          WHERE ${where.join(" AND ")}
          ORDER BY occurred_at ASC, event_key ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params
      );
      return res.rows.map(billableUsageEventRowToRecord).filter(Boolean);
    } catch (err) {
      if (err?.code !== "42P01") throw err;
      const normalizedPeriod = period === null ? null : String(period).trim();
      const normalizedType = eventType === null ? null : String(eventType).toLowerCase();
      const out = [];
      for (const row of store.billableUsageEvents.values()) {
        if (!row || typeof row !== "object") continue;
        if (normalizeTenantId(row.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
        if (normalizedPeriod !== null && String(row.period ?? "") !== normalizedPeriod) continue;
        if (normalizedType !== null && String(row.eventType ?? "").toLowerCase() !== normalizedType) continue;
        out.push(row);
      }
      out.sort(
        (left, right) =>
          String(left.occurredAt ?? "").localeCompare(String(right.occurredAt ?? "")) ||
          String(left.eventKey ?? "").localeCompare(String(right.eventKey ?? ""))
      );
      return out.slice(safeOffset, safeOffset + safeLimit);
    }
  };

  store.getAuthKey = async function getAuthKey({ tenantId = DEFAULT_TENANT_ID, keyId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(keyId, "keyId");
    const res = await pool.query(
      `
        SELECT tenant_id, key_id, secret_hash, scopes, status, description, expires_at, last_used_at, created_at, updated_at, rotated_at, revoked_at
        FROM auth_keys
        WHERE tenant_id = $1 AND key_id = $2
        LIMIT 1
      `,
      [tenantId, keyId]
    );
    return res.rows.length ? authKeyRowToRecord(res.rows[0]) : null;
  };

  store.listAuthKeys = async function listAuthKeys({ tenantId = DEFAULT_TENANT_ID } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const res = await pool.query(
      `
        SELECT tenant_id, key_id, secret_hash, scopes, status, description, expires_at, last_used_at, created_at, updated_at, rotated_at, revoked_at
        FROM auth_keys
        WHERE tenant_id = $1
        ORDER BY key_id ASC
      `,
      [tenantId]
    );
    return res.rows.map(authKeyRowToRecord).filter(Boolean);
  };

  store.putAuthKey = async function putAuthKey({ tenantId = DEFAULT_TENANT_ID, authKey, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!authKey || typeof authKey !== "object") throw new TypeError("authKey is required");
    const keyId = authKey.keyId ?? authKey.id ?? null;
    assertNonEmptyString(keyId, "authKey.keyId");
    assertNonEmptyString(authKey.secretHash, "authKey.secretHash");
    const scopes = Array.isArray(authKey.scopes) ? authKey.scopes.map(String).filter(Boolean) : [];
    const status = authKey.status ? String(authKey.status) : "active";
    const description = authKey.description === null || authKey.description === undefined ? null : String(authKey.description);
    const expiresAt = authKey.expiresAt ? new Date(String(authKey.expiresAt)).toISOString() : null;
    const lastUsedAt = authKey.lastUsedAt ? new Date(String(authKey.lastUsedAt)).toISOString() : null;
    const createdAt = authKey.createdAt ? new Date(String(authKey.createdAt)).toISOString() : new Date().toISOString();
    const updatedAt = authKey.updatedAt ? new Date(String(authKey.updatedAt)).toISOString() : new Date().toISOString();
    const rotatedAt = authKey.rotatedAt ? new Date(String(authKey.rotatedAt)).toISOString() : null;
    const revokedAt = authKey.revokedAt ? new Date(String(authKey.revokedAt)).toISOString() : null;

    const record = await withTx(async (client) => {
      const res = await client.query(
        `
          INSERT INTO auth_keys (
            tenant_id, key_id, secret_hash, scopes, status, description,
            expires_at, last_used_at, created_at, updated_at, rotated_at, revoked_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (tenant_id, key_id) DO UPDATE SET
            secret_hash = EXCLUDED.secret_hash,
            scopes = EXCLUDED.scopes,
            status = EXCLUDED.status,
            description = EXCLUDED.description,
            expires_at = EXCLUDED.expires_at,
            last_used_at = COALESCE(EXCLUDED.last_used_at, auth_keys.last_used_at),
            updated_at = EXCLUDED.updated_at,
            rotated_at = COALESCE(EXCLUDED.rotated_at, auth_keys.rotated_at),
            revoked_at = COALESCE(EXCLUDED.revoked_at, auth_keys.revoked_at)
          RETURNING tenant_id, key_id, secret_hash, scopes, status, description, expires_at, last_used_at, created_at, updated_at, rotated_at, revoked_at
        `,
        [tenantId, String(keyId), String(authKey.secretHash), scopes, status, description, expiresAt, lastUsedAt, createdAt, updatedAt, rotatedAt, revokedAt]
      );
      const record = res.rows.length ? authKeyRowToRecord(res.rows[0]) : null;
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
      return record;
    });
    if (record && store.authKeys instanceof Map) {
      store.authKeys.set(makeScopedKey({ tenantId: record.tenantId, id: record.keyId }), record);
    }
    return record;
  };

  store.touchAuthKey = async function touchAuthKey({ tenantId = DEFAULT_TENANT_ID, keyId, at = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(keyId, "keyId");
    const ts = at ? new Date(String(at)).toISOString() : new Date().toISOString();
    const res = await pool.query(
      "UPDATE auth_keys SET last_used_at = $3, updated_at = $3 WHERE tenant_id = $1 AND key_id = $2",
      [tenantId, keyId, ts]
    );
    if (store.authKeys instanceof Map) {
      const key = makeScopedKey({ tenantId, id: String(keyId) });
      const existing = store.authKeys.get(key) ?? null;
      if (existing) store.authKeys.set(key, { ...existing, lastUsedAt: ts, updatedAt: ts });
    }
    return res.rowCount > 0;
  };

  store.setAuthKeyStatus = async function setAuthKeyStatus({ tenantId = DEFAULT_TENANT_ID, keyId, status, at = null, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(keyId, "keyId");
    assertNonEmptyString(status, "status");
    const ts = at ? new Date(String(at)).toISOString() : new Date().toISOString();
    const record = await withTx(async (client) => {
      const res = await client.query(
        `
          UPDATE auth_keys
          SET status = $3,
              updated_at = $4,
              rotated_at = CASE WHEN $3 = 'rotated' THEN COALESCE(rotated_at, $4) ELSE rotated_at END,
              revoked_at = CASE WHEN $3 = 'revoked' THEN COALESCE(revoked_at, $4) ELSE revoked_at END
          WHERE tenant_id = $1 AND key_id = $2
          RETURNING tenant_id, key_id, secret_hash, scopes, status, description, expires_at, last_used_at, created_at, updated_at, rotated_at, revoked_at
        `,
        [tenantId, keyId, String(status), ts]
      );
      const record = res.rows.length ? authKeyRowToRecord(res.rows[0]) : null;
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
      return record;
    });
    if (record && store.authKeys instanceof Map) {
      store.authKeys.set(makeScopedKey({ tenantId: record.tenantId, id: record.keyId }), record);
    }
    return record;
  };

  store.rotateAuthKey = async function rotateAuthKey({
    tenantId = DEFAULT_TENANT_ID,
    oldKeyId,
    newAuthKey,
    rotatedAt = null,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(oldKeyId, "oldKeyId");
    if (!newAuthKey || typeof newAuthKey !== "object") throw new TypeError("newAuthKey is required");
    const newKeyId = newAuthKey.keyId ?? newAuthKey.id ?? null;
    assertNonEmptyString(newKeyId, "newAuthKey.keyId");
    const secretHash = newAuthKey.secretHash ?? null;
    assertNonEmptyString(secretHash, "newAuthKey.secretHash");
    const ts = rotatedAt ? new Date(String(rotatedAt)).toISOString() : new Date().toISOString();

    const result = await withTx(async (client) => {
      const existing = await client.query(
        "SELECT status, scopes, description, expires_at FROM auth_keys WHERE tenant_id = $1 AND key_id = $2 LIMIT 1 FOR UPDATE",
        [tenantId, String(oldKeyId)]
      );
      if (!existing.rows.length) return null;
      const row = existing.rows[0];
      const status = row?.status ? String(row.status) : "active";
      if (status === "revoked") {
        const err = new Error("auth key is revoked");
        err.code = "AUTH_KEY_REVOKED";
        throw err;
      }

      await client.query(
        `
          UPDATE auth_keys
          SET status = 'rotated',
              updated_at = $3,
              rotated_at = COALESCE(rotated_at, $3)
          WHERE tenant_id = $1 AND key_id = $2
        `,
        [tenantId, String(oldKeyId), ts]
      );

      const scopes = Array.isArray(newAuthKey.scopes)
        ? newAuthKey.scopes.map(String).filter(Boolean)
        : Array.isArray(row?.scopes)
          ? row.scopes.map(String)
          : [];
      const description = newAuthKey.description === undefined ? (row?.description ?? null) : newAuthKey.description;
      const expiresAt =
        newAuthKey.expiresAt !== undefined
          ? newAuthKey.expiresAt
            ? new Date(String(newAuthKey.expiresAt)).toISOString()
            : null
          : row?.expires_at
            ? new Date(row.expires_at).toISOString()
            : null;

      const inserted = await client.query(
        `
          INSERT INTO auth_keys (
            tenant_id, key_id, secret_hash, scopes, status, description,
            expires_at, last_used_at, created_at, updated_at, rotated_at, revoked_at
          ) VALUES ($1,$2,$3,$4,'active',$5,$6,NULL,$7,$7,NULL,NULL)
          ON CONFLICT (tenant_id, key_id) DO UPDATE SET
            secret_hash = EXCLUDED.secret_hash,
            scopes = EXCLUDED.scopes,
            status = EXCLUDED.status,
            description = EXCLUDED.description,
            expires_at = EXCLUDED.expires_at,
            updated_at = EXCLUDED.updated_at
          RETURNING tenant_id, key_id, secret_hash, scopes, status, description, expires_at, last_used_at, created_at, updated_at, rotated_at, revoked_at
        `,
        [tenantId, String(newKeyId), String(secretHash), scopes, description === undefined ? null : description, expiresAt, ts]
      );
      const newRecord = inserted.rows.length ? authKeyRowToRecord(inserted.rows[0]) : null;

      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
      return { rotatedAt: ts, oldKeyId: String(oldKeyId), newKeyId: String(newKeyId), newKey: newRecord };
    });

    if (!result) return null;
    if (store.authKeys instanceof Map) {
      const old = await store.getAuthKey({ tenantId, keyId: String(oldKeyId) });
      const next = await store.getAuthKey({ tenantId, keyId: String(result.newKeyId) });
      if (old) store.authKeys.set(makeScopedKey({ tenantId: old.tenantId, id: old.keyId }), old);
      if (next) store.authKeys.set(makeScopedKey({ tenantId: next.tenantId, id: next.keyId }), next);
    }
    return result;
  };

  store.appendOpsAudit = async function appendOpsAudit({ tenantId = DEFAULT_TENANT_ID, audit } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    return await withTx(async (client) => {
      return await insertOpsAuditRow(client, { tenantId, audit });
    });
  };

  store.listOpsAudit = async function listOpsAudit({ tenantId = DEFAULT_TENANT_ID, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const res = await pool.query(
      `
        SELECT id, tenant_id, actor_key_id, actor_principal_id, action, target_type, target_id, request_id, at, details_hash, details_json
        FROM ops_audit
        WHERE tenant_id = $1
        ORDER BY id DESC
        LIMIT $2 OFFSET $3
      `,
      [tenantId, safeLimit, safeOffset]
    );
    return res.rows.map(opsAuditRowToRecord).filter(Boolean);
  };

  store.getSignerKey = async function getSignerKey({ tenantId = DEFAULT_TENANT_ID, keyId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(keyId, "keyId");
    const res = await pool.query(
      `
        SELECT tenant_id, key_id, public_key_pem, purpose, status, description, valid_from, valid_to, last_used_at, created_at, updated_at, rotated_at, revoked_at
        FROM signer_keys
        WHERE tenant_id = $1 AND key_id = $2
        LIMIT 1
      `,
      [tenantId, keyId]
    );
    return res.rows.length ? signerKeyRowToRecord(res.rows[0]) : null;
  };

  store.listSignerKeys = async function listSignerKeys({ tenantId = DEFAULT_TENANT_ID } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const res = await pool.query(
      `
        SELECT tenant_id, key_id, public_key_pem, purpose, status, description, valid_from, valid_to, last_used_at, created_at, updated_at, rotated_at, revoked_at
        FROM signer_keys
        WHERE tenant_id = $1
        ORDER BY key_id ASC
      `,
      [tenantId]
    );
    return res.rows.map(signerKeyRowToRecord).filter(Boolean);
  };

  function contractV2RowToRecord(row) {
    if (!row) return null;
    const tenantId = normalizeTenantId(row?.tenant_id ?? DEFAULT_TENANT_ID);
    const contractId = row?.contract_id ? String(row.contract_id) : null;
    const contractVersion = row?.contract_version === null || row?.contract_version === undefined ? null : Number(row.contract_version);
    if (!contractId || !Number.isSafeInteger(contractVersion) || contractVersion <= 0) return null;
    return {
      tenantId,
      contractId,
      contractVersion,
      status: row?.status ? String(row.status) : "DRAFT",
      effectiveFrom: row?.effective_from ? new Date(row.effective_from).toISOString() : null,
      effectiveTo: row?.effective_to ? new Date(row.effective_to).toISOString() : null,
      contractHash: row?.contract_hash ? String(row.contract_hash) : null,
      policyHash: row?.policy_hash ? String(row.policy_hash) : null,
      compilerId: row?.compiler_id ? String(row.compiler_id) : null,
      scope: {
        customerId: row?.scope_customer_id === undefined ? null : row.scope_customer_id === null ? null : String(row.scope_customer_id),
        siteId: row?.scope_site_id === undefined ? null : row.scope_site_id === null ? null : String(row.scope_site_id),
        zoneId: row?.scope_zone_id === undefined ? null : row.scope_zone_id === null ? null : String(row.scope_zone_id),
        templateId: row?.scope_template_id === undefined ? null : row.scope_template_id === null ? null : String(row.scope_template_id),
        skillId: row?.scope_skill_id === undefined ? null : row.scope_skill_id === null ? null : String(row.scope_skill_id)
      },
      doc: row?.doc_json ?? null,
      createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null
    };
  }

  store.getContractV2 = async function getContractV2({ tenantId = DEFAULT_TENANT_ID, contractId, contractVersion } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(contractId, "contractId");
    const v = Number(contractVersion);
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("contractVersion must be a positive safe integer");
    const res = await pool.query(
      `
        SELECT tenant_id, contract_id, contract_version, status, effective_from, effective_to, contract_hash, policy_hash, compiler_id,
               scope_customer_id, scope_site_id, scope_zone_id, scope_template_id, scope_skill_id, doc_json, created_at, updated_at
        FROM contracts_v2
        WHERE tenant_id = $1 AND contract_id = $2 AND contract_version = $3
        LIMIT 1
      `,
      [tenantId, String(contractId), v]
    );
    return res.rows.length ? contractV2RowToRecord(res.rows[0]) : null;
  };

  store.getContractV2ByHash = async function getContractV2ByHash({ tenantId = DEFAULT_TENANT_ID, contractHash } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(contractHash, "contractHash");
    const res = await pool.query(
      `
        SELECT tenant_id, contract_id, contract_version, status, effective_from, effective_to, contract_hash, policy_hash, compiler_id,
               scope_customer_id, scope_site_id, scope_zone_id, scope_template_id, scope_skill_id, doc_json, created_at, updated_at
        FROM contracts_v2
        WHERE tenant_id = $1 AND contract_hash = $2
        LIMIT 1
      `,
      [tenantId, String(contractHash)]
    );
    return res.rows.length ? contractV2RowToRecord(res.rows[0]) : null;
  };

  store.listContractsV2 = async function listContractsV2({ tenantId = DEFAULT_TENANT_ID, status = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (status !== null) assertNonEmptyString(status, "status");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const params = [tenantId];
    const where = ["tenant_id = $1"];
    if (status !== null) {
      params.push(String(status));
      where.push(`status = $${params.length}`);
    }
    params.push(safeLimit);
    params.push(safeOffset);
    const res = await pool.query(
      `
        SELECT tenant_id, contract_id, contract_version, status, effective_from, effective_to, contract_hash, policy_hash, compiler_id,
               scope_customer_id, scope_site_id, scope_zone_id, scope_template_id, scope_skill_id, doc_json, created_at, updated_at
        FROM contracts_v2
        WHERE ${where.join(" AND ")}
        ORDER BY contract_id ASC, contract_version DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    return res.rows.map(contractV2RowToRecord).filter(Boolean);
  };

  store.getLatestContractV2 = async function getLatestContractV2({ tenantId = DEFAULT_TENANT_ID, contractId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(contractId, "contractId");
    const res = await pool.query(
      `
        SELECT tenant_id, contract_id, contract_version, status, effective_from, effective_to, contract_hash, policy_hash, compiler_id,
               scope_customer_id, scope_site_id, scope_zone_id, scope_template_id, scope_skill_id, doc_json, created_at, updated_at
        FROM contracts_v2
        WHERE tenant_id = $1 AND contract_id = $2
        ORDER BY contract_version DESC
        LIMIT 1
      `,
      [tenantId, String(contractId)]
    );
    return res.rows.length ? contractV2RowToRecord(res.rows[0]) : null;
  };

  store.createContractDraftV2 = async function createContractDraftV2({ tenantId = DEFAULT_TENANT_ID, contractId, contractVersion, doc, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(contractId, "contractId");
    const v = Number(contractVersion);
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("contractVersion must be a positive safe integer");
    if (!doc || typeof doc !== "object") throw new TypeError("doc is required");

    await withTx(async (client) => {
      await client.query(
        `
          INSERT INTO contracts_v2 (
            tenant_id, contract_id, contract_version, status,
            scope_customer_id, scope_site_id, scope_zone_id, scope_template_id, scope_skill_id,
            doc_json
          ) VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9)
          ON CONFLICT (tenant_id, contract_id, contract_version) DO UPDATE SET
            doc_json = EXCLUDED.doc_json,
            scope_customer_id = EXCLUDED.scope_customer_id,
            scope_site_id = EXCLUDED.scope_site_id,
            scope_zone_id = EXCLUDED.scope_zone_id,
            scope_template_id = EXCLUDED.scope_template_id,
            scope_skill_id = EXCLUDED.scope_skill_id,
            updated_at = now()
          WHERE contracts_v2.status = 'DRAFT'
        `,
        [
          tenantId,
          String(contractId),
          v,
          doc?.scope?.customerId ?? null,
          doc?.scope?.siteId ?? null,
          doc?.scope?.zoneId ?? null,
          doc?.scope?.templateId ?? null,
          doc?.scope?.skillId ?? null,
          doc
        ]
      );
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });
    return store.getContractV2({ tenantId, contractId, contractVersion: v });
  };

  store.publishContractV2 = async function publishContractV2({ tenantId = DEFAULT_TENANT_ID, contractId, contractVersion, contractHash, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(contractId, "contractId");
    const v = Number(contractVersion);
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("contractVersion must be a positive safe integer");
    assertNonEmptyString(contractHash, "contractHash");

    await withTx(async (client) => {
      const current = await client.query(
        "SELECT status, contract_hash FROM contracts_v2 WHERE tenant_id = $1 AND contract_id = $2 AND contract_version = $3 LIMIT 1",
        [tenantId, String(contractId), v]
      );
      if (!current.rows.length) {
        const err = new Error("contract not found");
        err.code = "NOT_FOUND";
        throw err;
      }
      const status = String(current.rows[0].status ?? "");
      const existingHash = current.rows[0].contract_hash ? String(current.rows[0].contract_hash) : null;
      if (status !== "DRAFT" && status !== "PUBLISHED") {
        const err = new Error("contract not publishable");
        err.code = "CONTRACT_NOT_PUBLISHABLE";
        throw err;
      }
      if (existingHash && existingHash !== contractHash) {
        const err = new Error("contract hash mismatch");
        err.code = "CONTRACT_HASH_MISMATCH";
        throw err;
      }

      await client.query(
        `
          UPDATE contracts_v2
          SET status = 'PUBLISHED', contract_hash = $4, updated_at = now()
          WHERE tenant_id = $1 AND contract_id = $2 AND contract_version = $3
        `,
        [tenantId, String(contractId), v, String(contractHash)]
      );
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });
    return store.getContractV2({ tenantId, contractId, contractVersion: v });
  };

  store.putContractSignatureV2 = async function putContractSignatureV2({
    tenantId = DEFAULT_TENANT_ID,
    contractHash,
    partyRole,
    signerKeyId,
    signature,
    audit = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(contractHash, "contractHash");
    assertNonEmptyString(partyRole, "partyRole");
    assertNonEmptyString(signerKeyId, "signerKeyId");
    assertNonEmptyString(signature, "signature");

    await withTx(async (client) => {
      await client.query(
        `
          INSERT INTO contract_signatures_v2 (tenant_id, contract_hash, party_role, signer_key_id, signature)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (tenant_id, contract_hash, party_role) DO UPDATE SET
            signer_key_id = EXCLUDED.signer_key_id,
            signature = EXCLUDED.signature,
            signed_at = now()
        `,
        [tenantId, String(contractHash), String(partyRole), String(signerKeyId), String(signature)]
      );
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });
    return { ok: true };
  };

  store.listContractSignaturesV2 = async function listContractSignaturesV2({ tenantId = DEFAULT_TENANT_ID, contractHash } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(contractHash, "contractHash");
    const res = await pool.query(
      `
        SELECT tenant_id, contract_hash, party_role, signer_key_id, signature, signed_at
        FROM contract_signatures_v2
        WHERE tenant_id = $1 AND contract_hash = $2
        ORDER BY party_role ASC
      `,
      [tenantId, String(contractHash)]
    );
    return res.rows.map((row) => ({
      tenantId: normalizeTenantId(row.tenant_id ?? tenantId),
      contractHash: String(row.contract_hash),
      partyRole: String(row.party_role),
      signerKeyId: String(row.signer_key_id),
      signature: String(row.signature),
      signedAt: row.signed_at ? new Date(row.signed_at).toISOString() : null
    }));
  };

  store.activateContractV2 = async function activateContractV2({ tenantId = DEFAULT_TENANT_ID, contractId, contractVersion, policyHash, compilerId, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(contractId, "contractId");
    const v = Number(contractVersion);
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("contractVersion must be a positive safe integer");
    assertNonEmptyString(policyHash, "policyHash");
    assertNonEmptyString(compilerId, "compilerId");

    await withTx(async (client) => {
      const current = await client.query(
        "SELECT status FROM contracts_v2 WHERE tenant_id = $1 AND contract_id = $2 AND contract_version = $3 LIMIT 1",
        [tenantId, String(contractId), v]
      );
      if (!current.rows.length) {
        const err = new Error("contract not found");
        err.code = "NOT_FOUND";
        throw err;
      }
      const status = String(current.rows[0].status ?? "");
      if (status !== "PUBLISHED" && status !== "ACTIVE") {
        const err = new Error("contract not activatable");
        err.code = "CONTRACT_NOT_ACTIVATABLE";
        throw err;
      }

      await client.query(
        `
          UPDATE contracts_v2
          SET status = 'ACTIVE', policy_hash = $4, compiler_id = $5, updated_at = now()
          WHERE tenant_id = $1 AND contract_id = $2 AND contract_version = $3
        `,
        [tenantId, String(contractId), v, String(policyHash), String(compilerId)]
      );

      await client.query(
        `
          INSERT INTO contract_compilations_v2 (tenant_id, contract_hash, policy_hash, compiler_id, diagnostics_json)
          SELECT tenant_id, contract_hash, $4, $5, NULL
          FROM contracts_v2
          WHERE tenant_id = $1 AND contract_id = $2 AND contract_version = $3 AND contract_hash IS NOT NULL
          ON CONFLICT DO NOTHING
        `,
        [tenantId, String(contractId), v, String(policyHash), String(compilerId)]
      );

      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });
    return store.getContractV2({ tenantId, contractId, contractVersion: v });
  };

  store.putSignerKey = async function putSignerKey({ tenantId = DEFAULT_TENANT_ID, signerKey, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    await withTx(async (client) => {
      await persistSignerKey(client, { tenantId, signerKey });
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });
    const record = await store.getSignerKey({ tenantId, keyId: signerKey?.keyId ?? signerKey?.id ?? "" });
    if (record && store.signerKeys instanceof Map) store.signerKeys.set(makeScopedKey({ tenantId, id: record.keyId }), record);
    return record;
  };

  store.setSignerKeyStatus = async function setSignerKeyStatus({ tenantId = DEFAULT_TENANT_ID, keyId, status, at = null, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    await withTx(async (client) => {
      await setSignerKeyStatusRow(client, { tenantId, keyId, status, at: at ?? new Date().toISOString() });
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });
    const record = await store.getSignerKey({ tenantId, keyId });
    if (record && store.signerKeys instanceof Map) store.signerKeys.set(makeScopedKey({ tenantId, id: record.keyId }), record);
    return record;
  };

  store.listNotifications = async function listNotifications({ tenantId = DEFAULT_TENANT_ID, topic = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (topic !== null) assertNonEmptyString(topic, "topic");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const res = topic
      ? await pool.query(
          "SELECT id, outbox_id, topic, payload_json, created_at FROM notifications WHERE tenant_id = $1 AND topic = $2 ORDER BY id DESC LIMIT $3 OFFSET $4",
          [tenantId, topic, safeLimit, safeOffset]
        )
      : await pool.query(
          "SELECT id, outbox_id, topic, payload_json, created_at FROM notifications WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3",
          [tenantId, safeLimit, safeOffset]
        );

    return res.rows.map((row) => ({
      id: Number(row.id),
      outboxId: row.outbox_id === null ? null : Number(row.outbox_id),
      topic: String(row.topic),
      payload: row.payload_json,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
    }));
  };

  store.listLedgerEntries = async function listLedgerEntries({ tenantId = DEFAULT_TENANT_ID, memoPrefix = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (memoPrefix !== null) assertNonEmptyString(memoPrefix, "memoPrefix");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const safeLimit = Math.min(5000, limit);
    const safeOffset = offset;

    const pattern = memoPrefix ? `${memoPrefix}%` : null;
    const res = pattern
      ? await pool.query(
          "SELECT entry_json FROM ledger_entries WHERE tenant_id = $1 AND (entry_json->>'memo') LIKE $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4",
          [tenantId, pattern, safeLimit, safeOffset]
        )
      : await pool.query("SELECT entry_json FROM ledger_entries WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", [
          tenantId,
          safeLimit,
          safeOffset
        ]);

    return res.rows.map((row) => row.entry_json);
  };

  store.listLedgerAllocations = async function listLedgerAllocations({
    tenantId = DEFAULT_TENANT_ID,
    entryId = null,
    partyId = null,
    limit = 5000,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (entryId !== null) assertNonEmptyString(entryId, "entryId");
    if (partyId !== null) assertNonEmptyString(partyId, "partyId");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const safeLimit = Math.min(5000, limit);
    const safeOffset = offset;

    const where = ["tenant_id = $1"];
    const params = [tenantId];
    if (entryId !== null) {
      params.push(String(entryId));
      where.push(`entry_id = $${params.length}`);
    }
    if (partyId !== null) {
      params.push(String(partyId));
      where.push(`party_id = $${params.length}`);
    }
    params.push(safeLimit);
    params.push(safeOffset);

    const res = await pool.query(
      `
        SELECT tenant_id, entry_id, posting_id, account_id, party_id, party_role, currency, amount_cents, created_at
        FROM ledger_allocations
        WHERE ${where.join(" AND ")}
        ORDER BY entry_id ASC, posting_id ASC, party_id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    return res.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      entryId: String(row.entry_id),
      postingId: String(row.posting_id),
      accountId: row.account_id === null ? null : String(row.account_id),
      partyId: String(row.party_id),
      partyRole: String(row.party_role),
      currency: String(row.currency),
      amountCents: Number(row.amount_cents),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
    }));
  };

  store.upsertParty = async function upsertParty({ tenantId = DEFAULT_TENANT_ID, party, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!party || typeof party !== "object") throw new TypeError("party is required");
    const partyId = party.partyId ?? party.id ?? null;
    assertNonEmptyString(partyId, "party.partyId");
    const partyRole = party.partyRole ?? party.role ?? null;
    assertNonEmptyString(partyRole, "party.partyRole");
    const displayName = party.displayName ?? null;
    assertNonEmptyString(displayName, "party.displayName");
    const status = party.status ?? "active";
    assertNonEmptyString(status, "party.status");

    await withTx(async (client) => {
      await client.query(
        `
          INSERT INTO parties (tenant_id, party_id, party_role, display_name, status)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (tenant_id, party_id) DO UPDATE
            SET party_role = EXCLUDED.party_role,
                display_name = EXCLUDED.display_name,
                status = EXCLUDED.status,
                updated_at = now()
        `,
        [tenantId, String(partyId), String(partyRole), String(displayName), String(status)]
      );
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });

    return store.getParty({ tenantId, partyId: String(partyId) });
  };

  store.getParty = async function getParty({ tenantId = DEFAULT_TENANT_ID, partyId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(partyId, "partyId");
    const res = await pool.query(
      "SELECT tenant_id, party_id, party_role, display_name, status, created_at, updated_at FROM parties WHERE tenant_id = $1 AND party_id = $2 LIMIT 1",
      [tenantId, String(partyId)]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    return {
      tenantId: String(row.tenant_id),
      partyId: String(row.party_id),
      partyRole: String(row.party_role),
      displayName: String(row.display_name),
      status: String(row.status),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
  };

  store.listParties = async function listParties({ tenantId = DEFAULT_TENANT_ID, role = null, status = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (role !== null) assertNonEmptyString(role, "role");
    if (status !== null) assertNonEmptyString(status, "status");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const params = [tenantId];
    const where = ["tenant_id = $1"];
    if (role !== null) {
      params.push(String(role));
      where.push(`party_role = $${params.length}`);
    }
    if (status !== null) {
      params.push(String(status));
      where.push(`status = $${params.length}`);
    }
    params.push(safeLimit);
    params.push(safeOffset);

    const res = await pool.query(
      `
        SELECT tenant_id, party_id, party_role, display_name, status, created_at, updated_at
        FROM parties
        WHERE ${where.join(" AND ")}
        ORDER BY party_id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    return res.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      partyId: String(row.party_id),
      partyRole: String(row.party_role),
      displayName: String(row.display_name),
      status: String(row.status),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    }));
  };

  store.getFinanceAccountMap = async function getFinanceAccountMap({ tenantId = DEFAULT_TENANT_ID } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    const res = await pool.query("SELECT mapping_json FROM finance_account_maps WHERE tenant_id = $1 LIMIT 1", [tenantId]);
    if (!res.rows.length) return null;
    return res.rows[0].mapping_json ?? null;
  };

  store.getTenantBillingConfig = async function getTenantBillingConfig({ tenantId = DEFAULT_TENANT_ID } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    store.ensureTenant(tenantId);
    const cfg = store.getConfig(tenantId);
    const billing = cfg?.billing ?? null;
    return billing && typeof billing === "object" && !Array.isArray(billing) ? JSON.parse(JSON.stringify(billing)) : null;
  };

  store.putTenantBillingConfig = async function putTenantBillingConfig({ tenantId = DEFAULT_TENANT_ID, billing, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!billing || typeof billing !== "object" || Array.isArray(billing)) {
      throw new TypeError("billing config is required");
    }
    const normalizedBilling = JSON.parse(JSON.stringify(billing));
    await withTx(async (client) => {
      await persistTenantBillingConfig(client, { tenantId, billing: normalizedBilling });
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });
    store.ensureTenant(tenantId);
    const cfg = store.getConfig(tenantId);
    cfg.billing = normalizedBilling;
    return normalizedBilling;
  };

  store.putFinanceAccountMap = async function putFinanceAccountMap({ tenantId = DEFAULT_TENANT_ID, mapping, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    validateFinanceAccountMapV1(mapping);
    const mappingHash = computeFinanceAccountMapHash(mapping);

    await withTx(async (client) => {
      await client.query(
        `
          INSERT INTO finance_account_maps (tenant_id, mapping_hash, mapping_json)
          VALUES ($1,$2,$3)
          ON CONFLICT (tenant_id) DO UPDATE SET
            mapping_hash = EXCLUDED.mapping_hash,
            mapping_json = EXCLUDED.mapping_json,
            updated_at = now()
        `,
        [tenantId, String(mappingHash), JSON.stringify(mapping)]
      );
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });

    return { tenantId, mappingHash, mapping };
  };

  function partyStatementRowToRecord(row) {
    return {
      tenantId: String(row.tenant_id),
      partyId: String(row.party_id),
      period: String(row.period),
      basis: String(row.basis),
      status: String(row.status),
      statementHash: String(row.statement_hash),
      artifactId: String(row.artifact_id),
      artifactHash: String(row.artifact_hash),
      closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
  }

  store.putPartyStatement = async function putPartyStatement({ tenantId = DEFAULT_TENANT_ID, statement, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!statement || typeof statement !== "object") throw new TypeError("statement is required");
    const partyId = statement.partyId ?? null;
    const period = statement.period ?? null;
    assertNonEmptyString(partyId, "statement.partyId");
    assertNonEmptyString(period, "statement.period");
    const basis = statement.basis ?? MONTH_CLOSE_BASIS.SETTLED_AT;
    assertNonEmptyString(basis, "statement.basis");
    const status = statement.status ?? "OPEN";
    assertNonEmptyString(status, "statement.status");
    const statementHash = statement.statementHash ?? null;
    const artifactId = statement.artifactId ?? null;
    const artifactHash = statement.artifactHash ?? null;
    assertNonEmptyString(statementHash, "statement.statementHash");
    assertNonEmptyString(artifactId, "statement.artifactId");
    assertNonEmptyString(artifactHash, "statement.artifactHash");
    const closedAt = statement.closedAt ?? null;

    const record = await withTx(async (client) => {
      const existing = await client.query(
        "SELECT status, artifact_hash FROM party_statements WHERE tenant_id = $1 AND party_id = $2 AND period = $3 LIMIT 1",
        [tenantId, String(partyId), String(period)]
      );
      if (existing.rows.length && String(existing.rows[0].status ?? "") === "CLOSED") {
        const currentHash = String(existing.rows[0].artifact_hash ?? "");
        if (currentHash && currentHash !== String(artifactHash)) {
          const err = new Error("party statement is closed and cannot be changed");
          err.code = "PARTY_STATEMENT_IMMUTABLE";
          throw err;
        }
      }

      const res = await client.query(
        `
          INSERT INTO party_statements (tenant_id, party_id, period, basis, status, statement_hash, artifact_id, artifact_hash, closed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (tenant_id, party_id, period) DO UPDATE SET
            basis = EXCLUDED.basis,
            status = EXCLUDED.status,
            statement_hash = EXCLUDED.statement_hash,
            artifact_id = EXCLUDED.artifact_id,
            artifact_hash = EXCLUDED.artifact_hash,
            closed_at = EXCLUDED.closed_at,
            updated_at = now()
          RETURNING tenant_id, party_id, period, basis, status, statement_hash, artifact_id, artifact_hash, closed_at, created_at, updated_at
        `,
        [tenantId, String(partyId), String(period), String(basis), String(status), String(statementHash), String(artifactId), String(artifactHash), closedAt]
      );
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
      return res.rows.length ? partyStatementRowToRecord(res.rows[0]) : null;
    });

    if (!record) throw new Error("failed to persist party statement");
    return record;
  };

  store.getPartyStatement = async function getPartyStatement({ tenantId = DEFAULT_TENANT_ID, partyId, period } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(partyId, "partyId");
    assertNonEmptyString(period, "period");
    const res = await pool.query(
      `
        SELECT tenant_id, party_id, period, basis, status, statement_hash, artifact_id, artifact_hash, closed_at, created_at, updated_at
        FROM party_statements
        WHERE tenant_id = $1 AND party_id = $2 AND period = $3
        LIMIT 1
      `,
      [tenantId, String(partyId), String(period)]
    );
    return res.rows.length ? partyStatementRowToRecord(res.rows[0]) : null;
  };

  store.listPartyStatements = async function listPartyStatements({
    tenantId = DEFAULT_TENANT_ID,
    period = null,
    partyId = null,
    status = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (period !== null) assertNonEmptyString(period, "period");
    if (partyId !== null) assertNonEmptyString(partyId, "partyId");
    if (status !== null) assertNonEmptyString(status, "status");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");
    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const params = [tenantId];
    const where = ["tenant_id = $1"];
    if (period !== null) {
      params.push(String(period));
      where.push(`period = $${params.length}`);
    }
    if (partyId !== null) {
      params.push(String(partyId));
      where.push(`party_id = $${params.length}`);
    }
    if (status !== null) {
      params.push(String(status));
      where.push(`status = $${params.length}`);
    }
    params.push(safeLimit);
    params.push(safeOffset);

    const res = await pool.query(
      `
        SELECT tenant_id, party_id, period, basis, status, statement_hash, artifact_id, artifact_hash, closed_at, created_at, updated_at
        FROM party_statements
        WHERE ${where.join(" AND ")}
        ORDER BY period ASC, party_id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );
    return res.rows.map(partyStatementRowToRecord);
  };

  store.listAggregateEvents = async function listAggregateEvents({ tenantId = DEFAULT_TENANT_ID, aggregateType, aggregateId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(aggregateType, "aggregateType");
    assertNonEmptyString(aggregateId, "aggregateId");
    const res = await pool.query(
      `
        SELECT event_json
        FROM events
        WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
        ORDER BY seq ASC
      `,
      [tenantId, String(aggregateType), String(aggregateId)]
    );
    return res.rows.map((r) => r.event_json);
  };

  store.lookupCorrelation = async function lookupCorrelation({ tenantId = DEFAULT_TENANT_ID, siteId, correlationKey } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(siteId, "siteId");
    assertNonEmptyString(correlationKey, "correlationKey");

    const res = await pool.query(
      `
        SELECT job_id, expires_at
        FROM correlations
        WHERE tenant_id = $1 AND site_id = $2 AND correlation_key = $3
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1
      `,
      [tenantId, siteId, correlationKey]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    return { jobId: String(row.job_id), expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null };
  };

  store.upsertCorrelation = async function upsertCorrelation({
    tenantId = DEFAULT_TENANT_ID,
    siteId,
    correlationKey,
    jobId,
    expiresAt = null,
    force = false
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(siteId, "siteId");
    assertNonEmptyString(correlationKey, "correlationKey");
    assertNonEmptyString(jobId, "jobId");
    await withTx(async (client) => {
      await upsertCorrelationRow(client, { tenantId, siteId, correlationKey, jobId, expiresAt, force: force === true });
    });
    return { jobId, expiresAt };
  };

  store.listCorrelations = async function listCorrelations({ tenantId = DEFAULT_TENANT_ID, siteId = null, jobId = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (siteId !== null) assertNonEmptyString(siteId, "siteId");
    if (jobId !== null) assertNonEmptyString(jobId, "jobId");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;
    const params = [tenantId];
    const where = ["tenant_id = $1"];
    if (siteId !== null) {
      params.push(siteId);
      where.push(`site_id = $${params.length}`);
    }
    if (jobId !== null) {
      params.push(jobId);
      where.push(`job_id = $${params.length}`);
    }
    params.push(safeLimit);
    params.push(safeOffset);
    const res = await pool.query(
      `SELECT tenant_id, site_id, correlation_key, job_id, expires_at, created_at
       FROM correlations
       WHERE ${where.join(" AND ")}
       ORDER BY site_id ASC, correlation_key ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.rows.map((row) => ({
      tenantId: String(row.tenant_id ?? tenantId),
      siteId: String(row.site_id),
      correlationKey: String(row.correlation_key),
      jobId: String(row.job_id),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
    }));
  };

  store.getIngestRecord = async function getIngestRecord({ tenantId = DEFAULT_TENANT_ID, source, externalEventId } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(source, "source");
    assertNonEmptyString(externalEventId, "externalEventId");
    const res = await pool.query(
      "SELECT record_json FROM ingest_records WHERE tenant_id = $1 AND source = $2 AND external_event_id = $3 LIMIT 1",
      [tenantId, source, externalEventId]
    );
    return res.rows.length ? res.rows[0].record_json : null;
  };

  store.listIngestRecords = async function listIngestRecords({
    tenantId = DEFAULT_TENANT_ID,
    status = null,
    source = null,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (status !== null) assertNonEmptyString(status, "status");
    if (source !== null) assertNonEmptyString(source, "source");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const params = [tenantId];
    const where = ["tenant_id = $1"];
    if (status !== null) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (source !== null) {
      params.push(source);
      where.push(`source = $${params.length}`);
    }
    params.push(safeLimit);
    params.push(safeOffset);
    const res = await pool.query(
      `SELECT record_json FROM ingest_records WHERE ${where.join(" AND ")} ORDER BY received_at DESC NULLS LAST, created_at DESC LIMIT $${
        params.length - 1
      } OFFSET $${params.length}`,
      params
    );
    return res.rows.map((r) => r.record_json);
  };

  store.putArtifact = async function putArtifact({ tenantId = DEFAULT_TENANT_ID, artifact }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    await withTx(async (client) => {
      await persistArtifactRow(client, { tenantId, artifact });
    });
    return artifact;
  };

  store.getArtifact = async function getArtifact({ tenantId = DEFAULT_TENANT_ID, artifactId }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(artifactId, "artifactId");
    const res = await pool.query("SELECT artifact_json FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2", [tenantId, artifactId]);
    return res.rows.length ? res.rows[0].artifact_json : null;
  };

  store.listArtifacts = async function listArtifacts({
    tenantId = DEFAULT_TENANT_ID,
    jobId = null,
    jobIds = null,
    artifactType = null,
    sourceEventId = null,
    beforeCreatedAt = null,
    beforeArtifactId = null,
    includeDbMeta = false,
    limit = 200,
    offset = 0
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (jobId !== null) assertNonEmptyString(jobId, "jobId");
    if (jobIds !== null && jobIds !== undefined) {
      if (!Array.isArray(jobIds)) throw new TypeError("jobIds must be null or an array");
      for (const value of jobIds) assertNonEmptyString(value, "jobIds[]");
    }
    if (artifactType !== null) assertNonEmptyString(artifactType, "artifactType");
    if (sourceEventId !== null) assertNonEmptyString(sourceEventId, "sourceEventId");
    if (beforeCreatedAt !== null) assertNonEmptyString(beforeCreatedAt, "beforeCreatedAt");
    if (beforeArtifactId !== null) assertNonEmptyString(beforeArtifactId, "beforeArtifactId");
    if (includeDbMeta !== false && includeDbMeta !== true) throw new TypeError("includeDbMeta must be a boolean");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const params = [tenantId];
    const where = ["tenant_id = $1"];
    if (jobId !== null) {
      params.push(String(jobId));
      where.push(`job_id = $${params.length}`);
    }
    if (jobIds !== null && jobIds !== undefined) {
      const values = Array.from(new Set(jobIds.map((v) => String(v))));
      if (values.length === 0) return [];
      params.push(values);
      where.push(`job_id = ANY($${params.length}::text[])`);
    }
    if (artifactType !== null) {
      params.push(String(artifactType));
      where.push(`artifact_type = $${params.length}`);
    }
    if (sourceEventId !== null) {
      params.push(String(sourceEventId));
      where.push(`source_event_id = $${params.length}`);
    }
    if (beforeCreatedAt !== null || beforeArtifactId !== null) {
      if (beforeCreatedAt === null || beforeArtifactId === null) {
        throw new TypeError("beforeCreatedAt and beforeArtifactId must be provided together");
      }
      // ORDER BY created_at DESC, artifact_id DESC
      // Seek pagination condition: return rows strictly "after" the cursor in that ordering.
      params.push(String(beforeCreatedAt));
      params.push(String(beforeArtifactId));
      where.push(`(created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND artifact_id < $${params.length}))`);
    }
    params.push(safeLimit);
    params.push(safeOffset);

    if (includeDbMeta) {
      const res = await pool.query(
        `SELECT artifact_json, artifact_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text
          FROM artifacts WHERE ${where.join(
          " AND "
        )} ORDER BY created_at DESC, artifact_id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return res.rows.map((r) => ({
        artifact: r.artifact_json,
        db: { createdAt: String(r.created_at_text), artifactId: String(r.artifact_id) }
      }));
    }

    const res = await pool.query(
      `SELECT artifact_json FROM artifacts WHERE ${where.join(" AND ")} ORDER BY created_at DESC, artifact_id DESC LIMIT $${params.length - 1} OFFSET $${
        params.length
      }`,
      params
    );
    return res.rows.map((r) => r.artifact_json);
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
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    assertNonEmptyString(agentId, "agentId");
    if (toolId !== null && toolId !== undefined) assertNonEmptyString(toolId, "toolId");
    if (occurredAtGte !== null && occurredAtGte !== undefined) assertNonEmptyString(occurredAtGte, "occurredAtGte");
    if (occurredAtLte !== null && occurredAtLte !== undefined) assertNonEmptyString(occurredAtLte, "occurredAtLte");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const params = [tenantId, String(agentId)];
    const where = ["idx.tenant_id = $1", "idx.subject_agent_id = $2"];
    if (toolId !== null && toolId !== undefined) {
      params.push(String(toolId));
      where.push(`idx.subject_tool_id = $${params.length}`);
    }
    if (occurredAtGte !== null && occurredAtGte !== undefined) {
      params.push(String(occurredAtGte));
      where.push(`idx.occurred_at >= $${params.length}::timestamptz`);
    }
    if (occurredAtLte !== null && occurredAtLte !== undefined) {
      params.push(String(occurredAtLte));
      where.push(`idx.occurred_at <= $${params.length}::timestamptz`);
    }
    const safeLimit = Math.min(5000, limit);
    params.push(safeLimit);
    params.push(offset);

    const res = await pool.query(
      `
        SELECT a.artifact_json
        FROM reputation_event_index idx
        INNER JOIN artifacts a
          ON a.tenant_id = idx.tenant_id
         AND a.artifact_id = idx.artifact_id
        WHERE ${where.join(" AND ")}
        ORDER BY idx.occurred_at ASC, idx.artifact_id ASC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params
    );
    return res.rows.map((row) => row.artifact_json);
  };

  store.createDelivery = async function createDelivery({ tenantId = DEFAULT_TENANT_ID, delivery }) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!delivery || typeof delivery !== "object") throw new TypeError("delivery is required");
    const dedupeKey = delivery.dedupeKey ?? null;
    assertNonEmptyString(dedupeKey, "delivery.dedupeKey");

    const cfg = typeof store.getConfig === "function" ? store.getConfig(tenantId) : store.config;
    const requestedLimit = cfg?.quotas?.maxPendingDeliveries ?? 0;
    const platformMaxPendingDeliveriesRaw = typeof process !== "undefined" ? (process.env.PROXY_QUOTA_PLATFORM_MAX_PENDING_DELIVERIES ?? null) : null;
    const platformMaxPendingDeliveries =
      platformMaxPendingDeliveriesRaw && String(platformMaxPendingDeliveriesRaw).trim() !== "" ? Number(platformMaxPendingDeliveriesRaw) : 0;
    if (platformMaxPendingDeliveriesRaw && String(platformMaxPendingDeliveriesRaw).trim() !== "") {
      if (!Number.isSafeInteger(platformMaxPendingDeliveries) || platformMaxPendingDeliveries < 0) {
        throw new TypeError("PROXY_QUOTA_PLATFORM_MAX_PENDING_DELIVERIES must be a non-negative safe integer");
      }
    }
    const quota = clampQuota({
      tenantLimit: Number.isSafeInteger(requestedLimit) ? requestedLimit : 0,
      defaultLimit: 0,
      maxLimit: Number.isSafeInteger(platformMaxPendingDeliveries) ? platformMaxPendingDeliveries : 0
    });

    const id = await withTx(async (client) => {
      const existing = await client.query("SELECT id FROM deliveries WHERE tenant_id = $1 AND dedupe_key = $2 LIMIT 1", [tenantId, String(dedupeKey)]);
      if (existing.rows.length) return Number(existing.rows[0].id);

      if (quota > 0) {
        const countRes = await client.query("SELECT COUNT(*)::int AS count FROM deliveries WHERE tenant_id = $1 AND state = 'pending'", [tenantId]);
        const pending = Number(countRes.rows[0]?.count ?? 0);
        if (pending >= quota) {
          const err = new Error("tenant quota exceeded");
          err.code = "TENANT_QUOTA_EXCEEDED";
          err.quota = { kind: "pending_deliveries", limit: quota, current: pending };
          throw err;
        }
      }

      const insertedId = await insertDeliveryRow(client, { tenantId, delivery });
      if (insertedId !== null) return insertedId;
      const raced = await client.query("SELECT id FROM deliveries WHERE tenant_id = $1 AND dedupe_key = $2 LIMIT 1", [tenantId, String(dedupeKey)]);
      return raced.rows.length ? Number(raced.rows[0].id) : null;
    });
    return { ...delivery, id };
  };

  store.listDeliveries = async function listDeliveries({ tenantId = DEFAULT_TENANT_ID, state = null, limit = 200, offset = 0 } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (state !== null) assertNonEmptyString(state, "state");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer");

    const safeLimit = Math.min(1000, limit);
    const safeOffset = offset;

    const res = state
      ? await pool.query(
          `
            SELECT id, destination_id, artifact_type, artifact_id, artifact_hash, dedupe_key, state, attempts, next_attempt_at,
                   claimed_at, worker, last_status, last_error, delivered_at, acked_at, ack_received_at, scope_key, order_seq, priority, order_key, expires_at, created_at, updated_at
            FROM deliveries
            WHERE tenant_id = $1 AND state = $2
            ORDER BY id DESC
            LIMIT $3 OFFSET $4
          `,
          [tenantId, state, safeLimit, safeOffset]
        )
      : await pool.query(
          `
            SELECT id, destination_id, artifact_type, artifact_id, artifact_hash, dedupe_key, state, attempts, next_attempt_at,
                   claimed_at, worker, last_status, last_error, delivered_at, acked_at, ack_received_at, scope_key, order_seq, priority, order_key, expires_at, created_at, updated_at
            FROM deliveries
            WHERE tenant_id = $1
            ORDER BY id DESC
            LIMIT $2 OFFSET $3
          `,
          [tenantId, safeLimit, safeOffset]
        );

    return res.rows.map((row) => ({
      id: Number(row.id),
      tenantId,
      destinationId: String(row.destination_id),
      artifactType: String(row.artifact_type),
      artifactId: String(row.artifact_id),
      artifactHash: String(row.artifact_hash),
      dedupeKey: String(row.dedupe_key),
      state: String(row.state),
      attempts: Number(row.attempts),
      nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
      claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
      worker: row.worker ? String(row.worker) : null,
      lastStatus: row.last_status === null ? null : Number(row.last_status),
      lastError: row.last_error ? String(row.last_error) : null,
      deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
      ackedAt: row.acked_at ? new Date(row.acked_at).toISOString() : null,
      ackReceivedAt: row.ack_received_at ? new Date(row.ack_received_at).toISOString() : null,
      scopeKey: row.scope_key ? String(row.scope_key) : "",
      orderSeq: row.order_seq === null ? 0 : Number(row.order_seq),
      priority: row.priority === null ? 0 : Number(row.priority),
      orderKey: row.order_key ? String(row.order_key) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    }));
  };

  store.cleanupRetention = async function cleanupRetention({
    tenantId = DEFAULT_TENANT_ID,
    maxRows = 1000,
    maxMillis = 1500,
    dryRun = false
  } = {}) {
    const isGlobal = tenantId === null || tenantId === undefined;
    tenantId = isGlobal ? null : normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!Number.isSafeInteger(maxRows) || maxRows <= 0) throw new TypeError("maxRows must be a positive safe integer");
    const safeMax = Math.min(10_000, maxRows);
    if (!Number.isSafeInteger(maxMillis) || maxMillis <= 0) throw new TypeError("maxMillis must be a positive safe integer");
    const deadlineAtMs = Date.now() + maxMillis;

    async function withTxAndTimeout({ timeoutMs }, fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          // Postgres does not allow parameter placeholders in `SET LOCAL ...`.
          // Use `set_config` which safely accepts bind parameters.
          await client.query("SELECT set_config('statement_timeout', $1, true)", [`${Math.floor(timeoutMs)}ms`]);
        }
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {}
        throw err;
      } finally {
        client.release();
      }
    }

    function remainingMs() {
      return Math.max(0, deadlineAtMs - Date.now());
    }

    let ingestRecordsPurged = 0;
    let deliveryReceiptsPurged = 0;
    let deliveriesPurged = 0;
    let timedOut = false;

    // Ingest records: bounded by expires_at.
    try {
      const timeoutMs = remainingMs();
      if (timeoutMs <= 0) {
        timedOut = true;
      } else {
        ingestRecordsPurged = await withTxAndTimeout({ timeoutMs }, async (client) => {
          if (dryRun) {
            const { text, values } = isGlobal
              ? {
                  text: `
                    WITH doomed AS (
                      SELECT 1
                      FROM ingest_records
                      WHERE expires_at IS NOT NULL
                        AND expires_at <= now()
                      ORDER BY expires_at ASC, created_at ASC
                      LIMIT $1
                    )
                    SELECT COUNT(*)::int AS count FROM doomed
                  `,
                  values: [safeMax]
                }
              : {
                  text: `
                    WITH doomed AS (
                      SELECT 1
                      FROM ingest_records
                      WHERE tenant_id = $1
                        AND expires_at IS NOT NULL
                        AND expires_at <= now()
                      ORDER BY expires_at ASC, created_at ASC
                      LIMIT $2
                    )
                    SELECT COUNT(*)::int AS count FROM doomed
                  `,
                  values: [tenantId, safeMax]
                };
            const res = await client.query(text, values);
            return Number(res.rows[0]?.count ?? 0);
          }

          const { text, values } = isGlobal
            ? {
                text: `
                  WITH doomed AS (
                    SELECT ctid
                    FROM ingest_records
                    WHERE expires_at IS NOT NULL
                      AND expires_at <= now()
                    ORDER BY expires_at ASC, created_at ASC
                    LIMIT $1
                  )
                  DELETE FROM ingest_records
                  WHERE ctid IN (SELECT ctid FROM doomed)
                  RETURNING 1
                `,
                values: [safeMax]
              }
            : {
                text: `
                  WITH doomed AS (
                    SELECT ctid
                    FROM ingest_records
                    WHERE tenant_id = $1
                      AND expires_at IS NOT NULL
                      AND expires_at <= now()
                    ORDER BY expires_at ASC, created_at ASC
                    LIMIT $2
                  )
                  DELETE FROM ingest_records
                  WHERE ctid IN (SELECT ctid FROM doomed)
                  RETURNING 1
                `,
                values: [tenantId, safeMax]
              };
          const res = await client.query(text, values);
          return res.rowCount;
        });
      }
    } catch (err) {
      // Ignore during early migrations if the table doesn't exist yet.
      if (err?.code === "42P01") {
        ingestRecordsPurged = 0;
      } else if (err?.code === "57014") {
        timedOut = true;
      } else {
        throw err;
      }
    }

    // Deliveries: purge non-pending rows that have expired. Also purge any receipts for the deleted delivery ids.
    try {
      const timeoutMs = remainingMs();
      if (timeoutMs <= 0) {
        timedOut = true;
      } else {
        const out = await withTxAndTimeout({ timeoutMs }, async (client) => {
          if (dryRun) {
            const { text, values } = isGlobal
              ? {
                  text: `
                    WITH doomed AS (
                      SELECT id
                      FROM deliveries
                      WHERE state <> 'pending'
                        AND expires_at IS NOT NULL
                        AND expires_at <= now()
                      ORDER BY expires_at ASC, id ASC
                      LIMIT $1
                    )
                    SELECT
                      (SELECT COUNT(*)::int FROM doomed) AS deliveries_count,
                      (SELECT COUNT(*)::int FROM delivery_receipts WHERE delivery_id IN (SELECT id FROM doomed)) AS receipts_count
                  `,
                  values: [safeMax]
                }
              : {
                  text: `
                    WITH doomed AS (
                      SELECT id
                      FROM deliveries
                      WHERE tenant_id = $1
                        AND state <> 'pending'
                        AND expires_at IS NOT NULL
                        AND expires_at <= now()
                      ORDER BY expires_at ASC, id ASC
                      LIMIT $2
                    )
                    SELECT
                      (SELECT COUNT(*)::int FROM doomed) AS deliveries_count,
                      (SELECT COUNT(*)::int FROM delivery_receipts WHERE tenant_id = $1 AND delivery_id IN (SELECT id FROM doomed)) AS receipts_count
                  `,
                  values: [tenantId, safeMax]
                };
            const res = await client.query(text, values);
            return {
              deliveriesPurged: Number(res.rows[0]?.deliveries_count ?? 0),
              deliveryReceiptsPurged: Number(res.rows[0]?.receipts_count ?? 0)
            };
          }

          const { text, values } = isGlobal
            ? {
                text: `
                  WITH doomed AS (
                    SELECT id
                    FROM deliveries
                    WHERE state <> 'pending'
                      AND expires_at IS NOT NULL
                      AND expires_at <= now()
                    ORDER BY expires_at ASC, id ASC
                    LIMIT $1
                  ),
                  receipts AS (
                    DELETE FROM delivery_receipts
                    WHERE delivery_id IN (SELECT id FROM doomed)
                    RETURNING 1
                  ),
                  del AS (
                    DELETE FROM deliveries
                    WHERE id IN (SELECT id FROM doomed)
                    RETURNING 1
                  )
                  SELECT
                    (SELECT count(*)::int FROM receipts) AS receipts_deleted,
                    (SELECT count(*)::int FROM del) AS deliveries_deleted
                `,
                values: [safeMax]
              }
            : {
                text: `
                  WITH doomed AS (
                    SELECT id
                    FROM deliveries
                    WHERE tenant_id = $1
                      AND state <> 'pending'
                      AND expires_at IS NOT NULL
                      AND expires_at <= now()
                    ORDER BY expires_at ASC, id ASC
                    LIMIT $2
                  ),
                  receipts AS (
                    DELETE FROM delivery_receipts
                    WHERE tenant_id = $1
                      AND delivery_id IN (SELECT id FROM doomed)
                    RETURNING 1
                  ),
                  del AS (
                    DELETE FROM deliveries
                    WHERE tenant_id = $1
                      AND id IN (SELECT id FROM doomed)
                    RETURNING 1
                  )
                  SELECT
                    (SELECT count(*)::int FROM receipts) AS receipts_deleted,
                    (SELECT count(*)::int FROM del) AS deliveries_deleted
                `,
                values: [tenantId, safeMax]
              };
          const res = await client.query(text, values);
          return {
            deliveryReceiptsPurged: Number(res.rows[0]?.receipts_deleted ?? 0),
            deliveriesPurged: Number(res.rows[0]?.deliveries_deleted ?? 0)
          };
        });

        deliveryReceiptsPurged = Number(out?.deliveryReceiptsPurged ?? 0);
        deliveriesPurged = Number(out?.deliveriesPurged ?? 0);
      }
    } catch (err) {
      if (err?.code === "42P01") {
        deliveryReceiptsPurged = 0;
        deliveriesPurged = 0;
      } else if (err?.code === "57014") {
        timedOut = true;
      } else {
        throw err;
      }
    }

    return { tenantId, ingestRecordsPurged, deliveriesPurged, deliveryReceiptsPurged, dryRun, timedOut };
  };

  store.claimDueDeliveries = async function claimDueDeliveries({ tenantId = DEFAULT_TENANT_ID, maxMessages = 100, worker = "delivery_v1" } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new TypeError("maxMessages must be a non-negative safe integer");
    assertNonEmptyString(worker, "worker");
    const reclaimAfterSeconds = reclaimAfterSecondsFromEnv({ fallbackSeconds: 60 });

	    const claimed = await withTx({ statementTimeoutMs: workerStatementTimeoutMs }, async (client) => {
      const res = await client.query(
        `
          SELECT id, destination_id, artifact_type, artifact_id, artifact_hash, dedupe_key, scope_key, order_seq, priority, order_key, attempts
          FROM deliveries
          WHERE tenant_id = $1
            AND state = 'pending'
            AND next_attempt_at <= now()
            AND (claimed_at IS NULL OR claimed_at < now() - ($3::text || ' seconds')::interval)
          ORDER BY next_attempt_at ASC, scope_key ASC, order_seq ASC, priority ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        `,
        [tenantId, Math.min(1000, maxMessages), String(reclaimAfterSeconds)]
      );
      if (!res.rows.length) return [];
      const ids = res.rows.map((r) => Number(r.id));
      await client.query(
        "UPDATE deliveries SET worker = $2, claimed_at = now(), attempts = attempts + 1, updated_at = now() WHERE tenant_id = $1 AND id = ANY($3::bigint[])",
        [tenantId, worker, ids]
      );
      return res.rows.map((row) => ({
        id: Number(row.id),
        tenantId,
        destinationId: String(row.destination_id),
        artifactType: String(row.artifact_type),
        artifactId: String(row.artifact_id),
        artifactHash: String(row.artifact_hash),
        dedupeKey: String(row.dedupe_key),
        scopeKey: row.scope_key ? String(row.scope_key) : "",
        orderSeq: row.order_seq === null ? 0 : Number(row.order_seq),
        priority: row.priority === null ? 0 : Number(row.priority),
        orderKey: row.order_key ? String(row.order_key) : null,
        attempts: Number(row.attempts) + 1
      }));
	    });

	    if (claimed.length) {
	      logger.info("deliveries.claim", { tenantId, worker, claimed: claimed.length, reclaimAfterSeconds });
	    }
	    return claimed;
	  };

  store.updateDeliveryAttempt = async function updateDeliveryAttempt({
    tenantId = DEFAULT_TENANT_ID,
    id,
    delivered,
    state,
    nextAttemptAt,
    lastStatus,
    lastError,
    expiresAt = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("id must be a positive integer");
    if (typeof delivered !== "boolean") throw new TypeError("delivered must be a boolean");
    assertNonEmptyString(state, "state");
    if (nextAttemptAt !== null && nextAttemptAt !== undefined) assertNonEmptyString(nextAttemptAt, "nextAttemptAt");
    if (lastStatus !== null && lastStatus !== undefined && !Number.isSafeInteger(lastStatus)) throw new TypeError("lastStatus must be a safe integer");
    if (lastError !== null && lastError !== undefined && (typeof lastError !== "string" || lastError.trim() === "")) {
      throw new TypeError("lastError must be null or a non-empty string");
    }
    if (expiresAt !== null && expiresAt !== undefined) assertNonEmptyString(expiresAt, "expiresAt");

    const deliveredAtSql = delivered ? "now()" : "NULL";
    await pool.query(
      `
        UPDATE deliveries
        SET state = $3,
            next_attempt_at = COALESCE($4::timestamptz, next_attempt_at),
            claimed_at = NULL,
            last_status = $5,
            last_error = $6,
            delivered_at = ${deliveredAtSql},
            expires_at = $7::timestamptz,
            updated_at = now()
        WHERE tenant_id = $1 AND id = $2
      `,
      [tenantId, Number(id), state, nextAttemptAt ?? null, lastStatus ?? null, lastError ?? null, expiresAt ?? null]
    );
  };

  store.requeueDelivery = async function requeueDelivery({ tenantId = DEFAULT_TENANT_ID, id, audit = null } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("id must be a positive integer");
    await withTx(async (client) => {
      await client.query(
        `
          UPDATE deliveries
          SET state = 'pending',
              next_attempt_at = now(),
              claimed_at = NULL,
              worker = NULL,
              attempts = 0,
              last_status = NULL,
              last_error = NULL,
              delivered_at = NULL,
              acked_at = NULL,
              ack_received_at = NULL,
              expires_at = NULL,
              updated_at = now()
          WHERE tenant_id = $1 AND id = $2
        `,
        [tenantId, Number(id)]
      );
      if (audit) await insertOpsAuditRow(client, { tenantId, audit });
    });
  };

  store.ackDelivery = async function ackDelivery({
    tenantId = DEFAULT_TENANT_ID,
    id,
    destinationId = null,
    artifactHash = null,
    receivedAt = null
  } = {}) {
    tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("id must be a positive integer");
    if (destinationId !== null) assertNonEmptyString(destinationId, "destinationId");
    if (artifactHash !== null) assertNonEmptyString(artifactHash, "artifactHash");
    if (receivedAt !== null) assertNonEmptyString(receivedAt, "receivedAt");

    return await withTx(async (client) => {
      const rowRes = await client.query(
        `
          SELECT id, destination_id, artifact_hash, acked_at
          FROM deliveries
          WHERE tenant_id = $1 AND id = $2
          LIMIT 1
        `,
        [tenantId, Number(id)]
      );
      if (!rowRes.rows.length) return null;
      const row = rowRes.rows[0];
      if (destinationId !== null && String(row.destination_id) !== String(destinationId)) {
        throw new TypeError("delivery destinationId mismatch");
      }
      if (artifactHash !== null && String(row.artifact_hash) !== String(artifactHash)) {
        throw new TypeError("delivery artifactHash mismatch");
      }

      // Idempotent: if already acked, keep the first ack.
      if (row.acked_at) {
        await client.query(
          "INSERT INTO delivery_receipts (tenant_id, delivery_id, destination_id, artifact_hash, received_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, delivery_id) DO NOTHING",
          [tenantId, Number(id), String(row.destination_id), String(row.artifact_hash), receivedAt ?? null]
        );
        const delivery = await client.query("SELECT id, acked_at, ack_received_at FROM deliveries WHERE tenant_id = $1 AND id = $2", [tenantId, Number(id)]);
        return {
          delivery: {
            id: Number(id),
            tenantId,
            ackedAt: delivery.rows[0]?.acked_at ? new Date(delivery.rows[0].acked_at).toISOString() : null,
            ackReceivedAt: delivery.rows[0]?.ack_received_at ? new Date(delivery.rows[0].ack_received_at).toISOString() : null
          }
        };
      }

      await client.query(
        `
          UPDATE deliveries
          SET acked_at = now(),
              ack_received_at = COALESCE($3::timestamptz, ack_received_at),
              updated_at = now()
          WHERE tenant_id = $1 AND id = $2
        `,
        [tenantId, Number(id), receivedAt ?? null]
      );

      await client.query(
        "INSERT INTO delivery_receipts (tenant_id, delivery_id, destination_id, artifact_hash, received_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, delivery_id) DO NOTHING",
        [tenantId, Number(id), String(row.destination_id), String(row.artifact_hash), receivedAt ?? null]
      );

      const updated = await client.query("SELECT acked_at, ack_received_at FROM deliveries WHERE tenant_id = $1 AND id = $2", [tenantId, Number(id)]);
      return {
        delivery: {
          id: Number(id),
          tenantId,
          ackedAt: updated.rows[0]?.acked_at ? new Date(updated.rows[0].acked_at).toISOString() : null,
          ackReceivedAt: updated.rows[0]?.ack_received_at ? new Date(updated.rows[0].ack_received_at).toISOString() : null
        }
      };
    });
  };

  store.claimOutbox = async function claimOutbox({ topic, maxMessages = 100, worker = "worker" } = {}) {
    assertNonEmptyString(topic, "topic");
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new TypeError("maxMessages must be a non-negative safe integer");
    assertNonEmptyString(worker, "worker");

    // Reclaim messages that were claimed but not processed within this window.
    const reclaimAfterSeconds = reclaimAfterSecondsFromEnv({ fallbackSeconds: 60 });
    const maxAttempts = outboxMaxAttemptsFromEnv({ fallbackAttempts: 25 });

    const claimed = await withTx({ statementTimeoutMs: workerStatementTimeoutMs }, async (client) => {
      const res = await client.query(
        `
          SELECT id, payload_json, attempts
          FROM outbox
          WHERE processed_at IS NULL
            AND topic = $1
            AND (claimed_at IS NULL OR claimed_at < now() - ($3::text || ' seconds')::interval)
            AND attempts <= $4
          ORDER BY id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        `,
        [topic, Math.min(1000, maxMessages), String(reclaimAfterSeconds), maxAttempts]
      );
      if (!res.rows.length) return [];
      failpoint("outbox.claim.after_lock");
      const ids = res.rows.map((r) => Number(r.id));
      await client.query("UPDATE outbox SET worker = $1, claimed_at = now(), attempts = attempts + 1 WHERE id = ANY($2::bigint[])", [worker, ids]);
      return res.rows.map((row) => ({ id: Number(row.id), message: row.payload_json, attempts: Number(row.attempts) + 1 }));
    });

    try {
      store.metrics?.incCounter?.("outbox_claim_total", { kind: topic }, claimed.length);
    } catch {}
    if (claimed.length) logger.info("outbox.claim", { kind: topic, worker, claimed: claimed.length, reclaimAfterSeconds });

    return claimed;
  };

  store.markOutboxProcessed = async function markOutboxProcessed({ ids, lastError = null } = {}) {
    if (!Array.isArray(ids) || ids.length === 0) throw new TypeError("ids must be a non-empty array");
    const numeric = ids.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (numeric.length !== ids.length) throw new TypeError("ids must be positive integers");
    if (lastError !== null && (typeof lastError !== "string" || lastError.trim() === "")) throw new TypeError("lastError must be null or a non-empty string");

    await pool.query("UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = ANY($1::bigint[])", [numeric, lastError]);
  };

  store.markOutboxFailed = async function markOutboxFailed({ ids, lastError } = {}) {
    if (!Array.isArray(ids) || ids.length === 0) throw new TypeError("ids must be a non-empty array");
    const numeric = ids.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (numeric.length !== ids.length) throw new TypeError("ids must be positive integers");
    assertNonEmptyString(lastError, "lastError");

    await pool.query("UPDATE outbox SET claimed_at = NULL, worker = NULL, last_error = $2 WHERE id = ANY($1::bigint[])", [numeric, lastError]);
  };

  async function processNotificationsOutbox({ maxMessages = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new TypeError("maxMessages must be a non-negative safe integer");
    const worker = "notifications_v0";
    const processed = [];

    while (processed.length < maxMessages) {
      const batch = await withTx({ statementTimeoutMs: workerStatementTimeoutMs }, async (client) => {
        const claim = await client.query(
          `
            SELECT id, tenant_id, topic, payload_json
            FROM outbox
            WHERE processed_at IS NULL
              AND topic LIKE 'NOTIFY_%'
            ORDER BY id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
          `,
          [Math.min(50, maxMessages - processed.length)]
        );
        if (!claim.rows.length) return [];

        const ids = claim.rows.map((r) => Number(r.id));
        await client.query("UPDATE outbox SET worker = $1, claimed_at = now(), attempts = attempts + 1 WHERE id = ANY($2::bigint[])", [
          worker,
          ids
        ]);

        for (const row of claim.rows) {
          const outboxId = Number(row.id);
          const tenantId = normalizeTenantId(row.tenant_id ?? DEFAULT_TENANT_ID);
          const topic = String(row.topic);
          const payload = row.payload_json;
          await client.query(
            "INSERT INTO notifications (tenant_id, outbox_id, topic, payload_json) VALUES ($1,$2,$3,$4) ON CONFLICT (outbox_id) DO NOTHING",
            [tenantId, outboxId, topic, JSON.stringify(payload)]
          );
          await client.query("UPDATE outbox SET processed_at = now(), last_error = NULL WHERE id = $1", [outboxId]);
          processed.push({ id: outboxId, topic });
        }

        return claim.rows;
      });

      if (!batch.length) break;
    }

    return { processed, worker };
  }

  async function processCorrelationsOutbox({ maxMessages = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new TypeError("maxMessages must be a non-negative safe integer");
    const worker = "correlations_v0";
    const processed = [];

    while (processed.length < maxMessages) {
      const batch = await withTx({ statementTimeoutMs: workerStatementTimeoutMs }, async (client) => {
        const claim = await client.query(
          `
            SELECT id, payload_json
            FROM outbox
            WHERE processed_at IS NULL
              AND topic = 'CORRELATION_APPLY'
            ORDER BY id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
          `,
          [Math.min(50, maxMessages - processed.length)]
        );
        if (!claim.rows.length) return [];

        const ids = claim.rows.map((r) => Number(r.id));
        await client.query("UPDATE outbox SET worker = $1, claimed_at = now(), attempts = attempts + 1 WHERE id = ANY($2::bigint[])", [
          worker,
          ids
        ]);

        for (const row of claim.rows) {
          const outboxId = Number(row.id);
          const msg = row.payload_json ?? null;
          const tenantId = normalizeTenantId(msg?.tenantId ?? DEFAULT_TENANT_ID);
          try {
            await upsertCorrelationRow(client, {
              tenantId,
              siteId: msg?.siteId,
              correlationKey: msg?.correlationKey,
              jobId: msg?.jobId,
              expiresAt: msg?.expiresAt ?? null
            });
            await client.query("UPDATE outbox SET processed_at = now(), last_error = NULL WHERE id = $1", [outboxId]);
            processed.push({ id: outboxId });
          } catch (err) {
            const lastError = typeof err?.message === "string" && err.message.trim() ? err.message : String(err ?? "correlation apply failed");
            await client.query("UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1", [outboxId, lastError]);
          }
        }

        return claim.rows;
      });

      if (!batch.length) break;
    }

    return { processed, worker };
  }

  function getPendingMonthCloseRequestEvent(events) {
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    let lastRequestIndex = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e?.type === "MONTH_CLOSE_REQUESTED") {
        lastRequestIndex = i;
        break;
      }
    }
    if (lastRequestIndex === -1) return null;
    for (let i = lastRequestIndex + 1; i < events.length; i += 1) {
      const e = events[i];
      if (e?.type === "MONTH_CLOSED") return null;
    }
    return events[lastRequestIndex];
  }

  async function listMonthEventsFromDb(client, { tenantId, monthId }) {
    const res = await client.query(
      "SELECT event_json FROM events WHERE tenant_id = $1 AND aggregate_type = 'month' AND aggregate_id = $2 ORDER BY seq ASC",
      [tenantId, monthId]
    );
    return res.rows.map((r) => r.event_json);
  }

  async function listJobEventsFromDb(client, { tenantId, jobId }) {
    const res = await client.query(
      "SELECT event_json FROM events WHERE tenant_id = $1 AND aggregate_type = 'job' AND aggregate_id = $2 ORDER BY seq ASC",
      [tenantId, jobId]
    );
    return res.rows.map((r) => r.event_json);
  }

  async function processMonthCloseOutbox({ maxMessages = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new TypeError("maxMessages must be a non-negative safe integer");
    const worker = "month_close_v1";
    const processed = [];

    while (processed.length < maxMessages) {
      const batch = await withTx({ statementTimeoutMs: workerStatementTimeoutMs }, async (client) => {
        const claim = await client.query(
          `
            SELECT id, payload_json, attempts
            FROM outbox
            WHERE processed_at IS NULL
              AND topic = 'MONTH_CLOSE_REQUESTED'
            ORDER BY id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
          `,
          [Math.min(20, maxMessages - processed.length)]
        );
        if (!claim.rows.length) return [];

        const ids = claim.rows.map((r) => Number(r.id));
        await client.query("UPDATE outbox SET worker = $1, claimed_at = now(), attempts = attempts + 1 WHERE id = ANY($2::bigint[])", [
          worker,
          ids
        ]);

        for (const row of claim.rows) {
          const outboxId = Number(row.id);
          const attempts = Number.isSafeInteger(Number(row.attempts)) ? Number(row.attempts) + 1 : 1;
          const msg = row.payload_json ?? null;
          const tenantId = normalizeTenantId(msg?.tenantId ?? DEFAULT_TENANT_ID);
          const month = msg?.month ? String(msg.month) : null;
          const basis = msg?.basis ? String(msg.basis) : MONTH_CLOSE_BASIS.SETTLED_AT;
          if (!month) {
            await client.query("UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1", [outboxId, "missing month"]);
            continue;
          }

          let monthId;
          try {
            monthId = msg?.monthId ? String(msg.monthId) : makeMonthCloseStreamId({ month, basis });
          } catch (err) {
            await client.query("UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1", [outboxId, "invalid monthId"]);
            continue;
          }

          try {
            const existing = await listMonthEventsFromDb(client, { tenantId, monthId });
            if (!existing.length) {
              await client.query("UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1", [outboxId, "missing month stream"]);
              continue;
            }

            const pending = getPendingMonthCloseRequestEvent(existing);
            if (!pending) {
              await client.query("UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1", [outboxId, "no pending request"]);
              continue;
            }
            if (
              typeof msg?.sourceEventId === "string" &&
              msg.sourceEventId.trim() !== "" &&
              typeof pending.id === "string" &&
              pending.id.trim() !== "" &&
              String(pending.id) !== String(msg.sourceEventId)
            ) {
              await client.query("UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1", [outboxId, "sourceEventId mismatch"]);
              continue;
            }

            const monthBefore = reduceMonthClose(existing);
            if (monthBefore?.status === "CLOSED") {
              await client.query("UPDATE outbox SET processed_at = now(), last_error = NULL WHERE id = $1", [outboxId]);
              processed.push({ id: outboxId, status: "already_closed" });
              continue;
            }

            const stableGeneratedAt =
              (typeof msg?.at === "string" && msg.at.trim() ? String(msg.at) : null) ??
              (typeof pending?.at === "string" && pending.at.trim() ? String(pending.at) : null) ??
              (typeof pending?.payload?.requestedAt === "string" && pending.payload.requestedAt.trim() ? String(pending.payload.requestedAt) : null) ??
              new Date().toISOString();

            const period = parseYearMonth(month);
            const periodStart = period.startAt;
            const periodEnd = period.endAt;

            // Compute the MonthlyStatement using deterministic nowIso (stableGeneratedAt).
            const settledIdsRes = await client.query(
              `
                SELECT DISTINCT aggregate_id
                FROM events
                WHERE tenant_id = $1
                  AND aggregate_type = 'job'
                  AND type = 'SETTLED'
                  AND at >= $2::timestamptz
                  AND at < $3::timestamptz
              `,
              [tenantId, periodStart, periodEnd]
            );
            const jobIds = settledIdsRes.rows
              .map((r) => String(r.aggregate_id))
              .filter((id) => id && id.trim() !== "")
              .sort((a, b) => a.localeCompare(b));

            const jobs = [];
            if (jobIds.length) {
              const snapRes = await client.query(
                "SELECT aggregate_id, snapshot_json FROM snapshots WHERE tenant_id = $1 AND aggregate_type = 'job' AND aggregate_id = ANY($2::text[])",
                [tenantId, jobIds]
              );
              // Determinism: DB may return rows in arbitrary order for ANY($2), but artifacts must be hash-stable.
              const ordered = snapRes.rows
                .slice()
                .sort((a, b) => String(a.aggregate_id ?? "").localeCompare(String(b.aggregate_id ?? "")));
              for (const r of ordered) {
                jobs.push(r.snapshot_json);
              }
            }

            const eventsByJobId = new Map();
            for (const jobId of jobIds) {
              // eslint-disable-next-line no-await-in-loop
              const ev = await listJobEventsFromDb(client, { tenantId, jobId });
              eventsByJobId.set(jobId, ev);
            }

            const statement = computeMonthlyStatement({
              tenantId,
              customerId: null,
              siteId: null,
              month,
              jobs,
              getEventsForJob: (jobId) => eventsByJobId.get(String(jobId)) ?? [],
              ledgerEntries: [],
              nowIso: () => stableGeneratedAt
            });

            const sliced = pending.chainHash ? sliceEventsThroughChainHash(existing, pending.chainHash) : existing;
            const statementArtifactId = `stmt_${tenantId}_${month}_${pending.id}`;
            const body = buildMonthlyStatementV1({
              tenantId,
              month,
              basis,
              statement,
              events: sliced,
              artifactId: statementArtifactId,
              generatedAt: stableGeneratedAt
            });
            const artifactCore = { ...body, sourceEventId: pending.id, atChainHash: pending.chainHash ?? body?.eventProof?.lastChainHash ?? null };
            const statementArtifactHash = computeArtifactHash(artifactCore);
            const statementArtifact = { ...artifactCore, artifactHash: statementArtifactHash };

            await persistArtifactRow(client, { tenantId, artifact: statementArtifact });

            // Deliver the monthly statement to all destinations that accept it.
            const cfg = typeof store.getConfig === "function" ? store.getConfig(tenantId) : store.config;
            const destinations = Array.isArray(cfg?.destinations) ? cfg.destinations : [];
            for (const dest of destinations) {
              if (!dest || typeof dest !== "object") continue;
              const allowed = Array.isArray(dest.artifactTypes) && dest.artifactTypes.length ? dest.artifactTypes : null;
              if (allowed && !allowed.includes(ARTIFACT_TYPE.MONTHLY_STATEMENT_V1)) continue;
              const destinationId = dest.destinationId ?? dest.id ?? null;
              if (typeof destinationId !== "string" || destinationId.trim() === "") continue;
              const dedupeKey = `${tenantId}:${destinationId}:${ARTIFACT_TYPE.MONTHLY_STATEMENT_V1}:${statementArtifact.artifactId}:${statementArtifact.artifactHash}`;
              const scopeKey = `month:${month}`;
              const orderSeq = 0;
              const priority = 90;
              const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${statementArtifact.artifactId}`;
              await insertDeliveryRow(client, {
                tenantId,
                delivery: {
                  destinationId,
                  artifactType: ARTIFACT_TYPE.MONTHLY_STATEMENT_V1,
                  artifactId: statementArtifact.artifactId,
                  artifactHash: statementArtifact.artifactHash,
                  dedupeKey,
                  scopeKey,
                  orderSeq,
                  priority,
                  orderKey
                }
              });
            }

            // Party statements + payout instructions (Connect v1).
            const includedJobIds = new Set((statement.jobs ?? []).map((j) => String(j?.jobId ?? "")).filter((id) => id && id.trim() !== ""));

            const entryRes = await client.query(
              `
                SELECT entry_id, entry_json
                FROM ledger_entries
                WHERE tenant_id = $1
                  AND (entry_json->>'at')::timestamptz >= $2::timestamptz
                  AND (entry_json->>'at')::timestamptz < $3::timestamptz
                  AND (entry_json->>'memo') LIKE 'job:%'
              `,
              [tenantId, periodStart, periodEnd]
            );
            const entriesById = new Map();
            const includedEntryIds = [];
            for (const r of entryRes.rows) {
              const entry = r.entry_json ?? null;
              const entryId = r.entry_id ? String(r.entry_id) : entry?.id ? String(entry.id) : null;
              if (!entryId) continue;
              entriesById.set(entryId, entry);
              const jobId = jobIdFromLedgerMemo(entry?.memo ?? "");
              if (jobId && includedJobIds.has(jobId)) includedEntryIds.push(entryId);
            }

            const allocations = [];
            if (includedEntryIds.length) {
              const allocRes = await client.query(
                `
                  SELECT entry_id, posting_id, account_id, party_id, party_role, currency, amount_cents
                  FROM ledger_allocations
                  WHERE tenant_id = $1
                    AND entry_id = ANY($2::text[])
                `,
                [tenantId, includedEntryIds]
              );
              for (const r of allocRes.rows) {
                allocations.push({
                  tenantId,
                  entryId: String(r.entry_id),
                  postingId: String(r.posting_id),
                  accountId: r.account_id === null ? null : String(r.account_id),
                  partyId: String(r.party_id),
                  partyRole: String(r.party_role),
                  currency: String(r.currency),
                  amountCents: Number(r.amount_cents)
                });
              }
            }

            const allocationsByParty = new Map(); // `${partyRole}\n${partyId}` -> allocations[]
            for (const a of allocations) {
              const partyId = a.partyId ?? null;
              const partyRole = a.partyRole ?? null;
              if (!partyId || !partyRole) continue;
              const key = `${partyRole}\n${partyId}`;
              const list = allocationsByParty.get(key) ?? [];
              list.push(a);
              allocationsByParty.set(key, list);
            }

            const partyInfoByKey = new Map(); // `${partyRole}\n${partyId}` -> { partyId, partyRole, partyHash, partyStatement }

            for (const [key, partyAllocs] of allocationsByParty.entries()) {
              const [partyRole, partyId] = key.split("\n");
              const partyStatement = computePartyStatement({
                tenantId,
                partyId,
                partyRole,
                period: month,
                basis,
                allocations: partyAllocs,
                entriesById,
                currency: "USD"
              });

              const partyArtifactId = `pstmt_${tenantId}_${partyId}_${month}_${pending.id}`;
              const partyBody = buildPartyStatementV1({
                tenantId,
                partyId,
                partyRole,
                period: month,
                basis,
                statement: partyStatement,
                events: sliced,
                artifactId: partyArtifactId,
                generatedAt: stableGeneratedAt
              });
              const partyCore = { ...partyBody, sourceEventId: pending.id, atChainHash: pending.chainHash ?? partyBody?.eventProof?.lastChainHash ?? null };
              const partyHash = computeArtifactHash(partyCore);
              const partyArtifact = { ...partyCore, artifactHash: partyHash };
              await persistArtifactRow(client, { tenantId, artifact: partyArtifact });

              // Persist/close the party statement record (idempotent, immutable once closed).
              try {
                const existingStmt = await client.query(
                  "SELECT status, artifact_hash FROM party_statements WHERE tenant_id = $1 AND party_id = $2 AND period = $3 LIMIT 1",
                  [tenantId, String(partyId), String(month)]
                );
                if (existingStmt.rows.length && String(existingStmt.rows[0].status ?? "") === "CLOSED") {
                  const currentHash = String(existingStmt.rows[0].artifact_hash ?? "");
                  if (currentHash && currentHash !== String(partyHash)) {
                    const err = new Error("party statement is closed and cannot be changed");
                    err.code = "PARTY_STATEMENT_IMMUTABLE";
                    throw err;
                  }
                }
                await client.query(
                  `
                    INSERT INTO party_statements (tenant_id, party_id, period, basis, status, statement_hash, artifact_id, artifact_hash, closed_at)
                    VALUES ($1,$2,$3,$4,'CLOSED',$5,$6,$7,$8::timestamptz)
                    ON CONFLICT (tenant_id, party_id, period) DO UPDATE SET
                      basis = EXCLUDED.basis,
                      status = EXCLUDED.status,
                      statement_hash = EXCLUDED.statement_hash,
                      artifact_id = EXCLUDED.artifact_id,
                      artifact_hash = EXCLUDED.artifact_hash,
                      closed_at = EXCLUDED.closed_at,
                      updated_at = now()
                  `,
                  [tenantId, String(partyId), String(month), String(basis), String(partyHash), partyArtifactId, String(partyHash), stableGeneratedAt]
                );
              } catch (err) {
                if (err?.code === "42P01") {
                  // party_statements table may not exist during early migrations.
                } else {
                  throw err;
                }
              }

              partyInfoByKey.set(key, { partyId, partyRole, partyHash, partyStatement });

              for (const dest of destinations) {
                if (!dest || typeof dest !== "object") continue;
                const allowed = Array.isArray(dest.artifactTypes) && dest.artifactTypes.length ? dest.artifactTypes : null;
                if (allowed && !allowed.includes(ARTIFACT_TYPE.PARTY_STATEMENT_V1)) continue;
                const destinationId = dest.destinationId ?? dest.id ?? null;
                if (typeof destinationId !== "string" || destinationId.trim() === "") continue;
                const dedupeKey = `${tenantId}:${destinationId}:${ARTIFACT_TYPE.PARTY_STATEMENT_V1}:${partyArtifact.artifactId}:${partyArtifact.artifactHash}`;
                const scopeKey = `party:${partyId}:period:${month}`;
                const orderSeq = 0;
                const priority = 85;
                const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${partyArtifact.artifactId}`;
                await insertDeliveryRow(client, {
                  tenantId,
                  delivery: {
                    destinationId,
                    artifactType: ARTIFACT_TYPE.PARTY_STATEMENT_V1,
                    artifactId: partyArtifact.artifactId,
                    artifactHash: partyArtifact.artifactHash,
                    dedupeKey,
                    scopeKey,
                    orderSeq,
                    priority,
                    orderKey
                  }
                });
              }
            }

            failpoint("month_close.after_party_statements_before_payouts");

            for (const info of partyInfoByKey.values()) {
              const partyRole = info.partyRole;
              const partyId = info.partyId;
              const statementHash = info.partyHash; // payout is anchored to the party statement artifact hash
              const payoutAmountCents = computePayoutAmountCentsForStatement({ partyRole, statement: info.partyStatement });
              if (!Number.isSafeInteger(payoutAmountCents) || payoutAmountCents <= 0) continue;

              const payoutKey = payoutKeyFor({ tenantId, partyId, period: month, statementHash });
              const payoutArtifactId = `payout_${tenantId}_${partyId}_${month}_${statementHash}`;
              const payoutBody = buildPayoutInstructionV1({
                tenantId,
                partyId,
                partyRole,
                period: month,
                statementHash,
                payoutKey,
                currency: "USD",
                amountCents: payoutAmountCents,
                destinationRef: null,
                events: sliced,
                artifactId: payoutArtifactId,
                generatedAt: stableGeneratedAt
              });
              const payoutCore = { ...payoutBody, sourceEventId: pending.id, atChainHash: pending.chainHash ?? payoutBody?.eventProof?.lastChainHash ?? null };
              const payoutHash = computeArtifactHash(payoutCore);
              const payoutArtifact = { ...payoutCore, artifactHash: payoutHash };
              await persistArtifactRow(client, { tenantId, artifact: payoutArtifact });

              for (const dest of destinations) {
                if (!dest || typeof dest !== "object") continue;
                const allowed = Array.isArray(dest.artifactTypes) && dest.artifactTypes.length ? dest.artifactTypes : null;
                if (allowed && !allowed.includes(ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1)) continue;
                const destinationId = dest.destinationId ?? dest.id ?? null;
                if (typeof destinationId !== "string" || destinationId.trim() === "") continue;
                const dedupeKey = `${tenantId}:${destinationId}:${ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1}:${payoutKey}:${payoutArtifact.artifactHash}`;
                const scopeKey = `payout:${partyId}:period:${month}`;
                const orderSeq = 0;
                const priority = 95;
                const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${payoutArtifact.artifactId}`;
                await insertDeliveryRow(client, {
                  tenantId,
                  delivery: {
                    destinationId,
                    artifactType: ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1,
                    artifactId: payoutArtifact.artifactId,
                    artifactHash: payoutArtifact.artifactHash,
                    dedupeKey,
                    scopeKey,
                    orderSeq,
                    priority,
                    orderKey
                  }
                });
              }
            }

            // Finance Pack v1: GLBatch.v1 (canonical GL export input).
            let glArtifact = null;
            try {
              const allocRes = await client.query(
                `
                  SELECT
                    a.entry_id,
                    a.posting_id,
                    a.account_id,
                    a.party_id,
                    a.party_role,
                    a.currency,
                    a.amount_cents,
                    (e.entry_json->>'memo') AS memo,
                    (e.entry_json->>'at') AS at
                  FROM ledger_allocations a
                  JOIN ledger_entries e
                    ON e.tenant_id = a.tenant_id AND e.entry_id = a.entry_id
                  WHERE a.tenant_id = $1
                    AND (e.entry_json->>'at')::timestamptz >= $2::timestamptz
                    AND (e.entry_json->>'at')::timestamptz < $3::timestamptz
                  ORDER BY a.entry_id ASC, a.posting_id ASC, a.party_id ASC
                `,
                [tenantId, periodStart, periodEnd]
              );

              const allocationRows = [];
              for (const r of allocRes.rows) {
                const memo = typeof r.memo === "string" ? r.memo : "";
                const jobId = jobIdFromLedgerMemo(memo);
                if (jobId && !includedJobIds.has(jobId)) continue;
                allocationRows.push({
                  entryId: String(r.entry_id),
                  postingId: String(r.posting_id),
                  accountId: String(r.account_id),
                  partyId: String(r.party_id),
                  partyRole: String(r.party_role),
                  currency: String(r.currency),
                  amountCents: Number(r.amount_cents),
                  memo: memo || null,
                  at: typeof r.at === "string" ? r.at : null
                });
              }

              const { body: glBody } = computeGlBatchBodyV1({
                tenantId,
                period: month,
                basis,
                allocationRows,
                generatedAt: stableGeneratedAt,
                monthClose: {
                  month,
                  basis,
                  monthCloseEventId: pending.id,
                  monthlyStatementArtifactHash: statementArtifactHash
                }
              });

              const glArtifactId = `gl_${tenantId}_${month}_${pending.id}`;
              const glBatchBody = buildGlBatchV1({
                tenantId,
                period: month,
                basis,
                batch: glBody,
                events: sliced,
                artifactId: glArtifactId,
                generatedAt: stableGeneratedAt
              });
              const glCore = { ...glBatchBody, sourceEventId: pending.id, atChainHash: pending.chainHash ?? glBatchBody?.eventProof?.lastChainHash ?? null };
              const glHash = computeArtifactHash(glCore);
              glArtifact = { ...glCore, artifactHash: glHash };
              await persistArtifactRow(client, { tenantId, artifact: glArtifact });

              for (const dest of destinations) {
                if (!dest || typeof dest !== "object") continue;
                const allowed = Array.isArray(dest.artifactTypes) && dest.artifactTypes.length ? dest.artifactTypes : null;
                if (allowed && !allowed.includes(ARTIFACT_TYPE.GL_BATCH_V1)) continue;
                const destinationId = dest.destinationId ?? dest.id ?? null;
                if (typeof destinationId !== "string" || destinationId.trim() === "") continue;
                const dedupeKey = `${tenantId}:${destinationId}:${ARTIFACT_TYPE.GL_BATCH_V1}:${glArtifact.artifactId}:${glArtifact.artifactHash}`;
                const scopeKey = `glbatch:period:${month}`;
                const orderSeq = 0;
                const priority = 96;
                const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${glArtifact.artifactId}`;
                await insertDeliveryRow(client, {
                  tenantId,
                  delivery: {
                    destinationId,
                    artifactType: ARTIFACT_TYPE.GL_BATCH_V1,
                    artifactId: glArtifact.artifactId,
                    artifactHash: glArtifact.artifactHash,
                    dedupeKey,
                    scopeKey,
                    orderSeq,
                    priority,
                    orderKey
                  }
                });
              }
            } catch (err) {
              // Finance export should never corrupt month close; fail loudly and retry.
              throw err;
            }

            // Finance Pack v1: JournalCsv.v1 (delivered CSV export).
            let journalCsvGateMode = "warn";
            try {
              const mapRes = await client.query("SELECT mapping_json FROM finance_account_maps WHERE tenant_id = $1 LIMIT 1", [tenantId]);
              const accountMap = mapRes.rows.length ? mapRes.rows[0].mapping_json ?? null : null;
              journalCsvGateMode =
                accountMap && typeof accountMap === "object" && accountMap.exportPolicy?.gateMode === "strict" ? "strict" : "warn";

              if (!accountMap) {
                if (journalCsvGateMode === "strict") {
                  const err = new Error("finance export blocked: missing finance account map");
                  err.code = "FINANCE_EXPORT_BLOCKED";
                  throw err;
                }
                logger.warn("finance.export_blocked", { tenantId, kind: "journal_csv", reason: "missing_account_map", month, basis });
              } else {
                const accountMapHash = computeFinanceAccountMapHash(accountMap);
                const { csv, csvHash } = renderJournalCsvV1({ glBatchArtifact: glArtifact, accountMap });

                const csvArtifactId = `journalcsv_${tenantId}_${month}_${pending.id}`;
                const csvBody = buildJournalCsvV1({
                  tenantId,
                  period: month,
                  basis,
                  glBatchArtifactId: glArtifact.artifactId,
                  glBatchArtifactHash: glArtifact.artifactHash,
                  accountMapHash,
                  csv,
                  csvSha256: csvHash,
                  events: sliced,
                  artifactId: csvArtifactId,
                  generatedAt: stableGeneratedAt
                });
                const csvCore = { ...csvBody, sourceEventId: pending.id, atChainHash: pending.chainHash ?? csvBody?.eventProof?.lastChainHash ?? null };
                const csvArtifactHash = computeArtifactHash(csvCore);
                const csvArtifact = { ...csvCore, artifactHash: csvArtifactHash };
                await persistArtifactRow(client, { tenantId, artifact: csvArtifact });

                for (const dest of destinations) {
                  if (!dest || typeof dest !== "object") continue;
                  const allowed = Array.isArray(dest.artifactTypes) && dest.artifactTypes.length ? dest.artifactTypes : null;
                  if (allowed && !allowed.includes(ARTIFACT_TYPE.JOURNAL_CSV_V1)) continue;
                  const destinationId = dest.destinationId ?? dest.id ?? null;
                  if (typeof destinationId !== "string" || destinationId.trim() === "") continue;
                  const dedupeKey = `${tenantId}:${destinationId}:${ARTIFACT_TYPE.JOURNAL_CSV_V1}:${csvArtifact.artifactId}:${csvArtifact.artifactHash}`;
                  const scopeKey = `journalcsv:period:${month}`;
                  const orderSeq = 1;
                  const priority = 96;
                  const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${csvArtifact.artifactId}`;
                  await insertDeliveryRow(client, {
                    tenantId,
                    delivery: {
                      destinationId,
                      artifactType: ARTIFACT_TYPE.JOURNAL_CSV_V1,
                      artifactId: csvArtifact.artifactId,
                      artifactHash: csvArtifact.artifactHash,
                      dedupeKey,
                      scopeKey,
                      orderSeq,
                      priority,
                      orderKey
                    }
                  });
                }
              }
            } catch (err) {
              if (err?.code === "FINANCE_EXPORT_BLOCKED" || (journalCsvGateMode === "strict" && err?.code === "FINANCE_ACCOUNT_MAP_MISSING")) {
                const block = new Error("finance export blocked: journal CSV mapping incomplete");
                block.code = "FINANCE_EXPORT_BLOCKED";
                block.cause = err;
                throw block;
              }
              logger.warn("finance.journal_csv_failed", { tenantId, month, basis, err });
            }

            failpoint("month_close.after_payouts_before_outbox_done");

            // Append MONTH_CLOSED (server-signed) to the month stream.
            const closedAt = new Date().toISOString();
            const closedPayload = {
              tenantId,
              month,
              basis,
              closedAt,
              statementArtifactId,
              statementArtifactHash
            };
            validateMonthClosedPayload(closedPayload);
            const draft = createChainedEvent({
              streamId: monthId,
              type: "MONTH_CLOSED",
              at: closedAt,
              actor: { type: "finance", id: "month_close_v1" },
              payload: closedPayload
            });
            const next = appendChainedEvent({ events: existing, event: draft, signer: store.serverSigner });
            const closedEvent = next[next.length - 1];

            await insertEvents(client, { tenantId, aggregateType: "month", aggregateId: monthId, events: [closedEvent] });
            await rebuildSnapshot(client, { tenantId, aggregateType: "month", aggregateId: monthId });

            // Phase 2: enqueue FinancePackBundle generation as a separate outbox job (IO-heavy, safe to retry).
            try {
              await client.query(
                "INSERT INTO outbox (tenant_id, topic, aggregate_type, aggregate_id, payload_json) VALUES ($1,$2,$3,$4,$5)",
                [
                  tenantId,
                  "FINANCE_PACK_BUNDLE_ENQUEUE",
                  "month",
                  monthId,
                  JSON.stringify({
                    type: "FINANCE_PACK_BUNDLE_ENQUEUE",
                    tenantId,
                    month,
                    basis,
                    monthId,
                    sourceEventId: pending.id,
                    at: stableGeneratedAt
                  })
                ]
              );
            } catch (err) {
              // Best-effort: month close must still complete even if finance pack enqueue fails.
              logger.warn("finance_pack.enqueue_failed", { tenantId, month, basis, err });
            }

            await client.query("UPDATE outbox SET processed_at = now(), last_error = NULL WHERE id = $1", [outboxId]);
            processed.push({ id: outboxId, status: "closed", month, statementArtifactId, statementArtifactHash });
          } catch (err) {
            const lastError = typeof err?.message === "string" && err.message.trim() ? err.message : String(err ?? "month close failed");
            const maxAttempts = outboxMaxAttemptsFromEnv({ fallbackAttempts: 25 });
            if (attempts >= maxAttempts) {
              await client.query("UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1", [outboxId, `DLQ:${lastError}`]);
            } else {
              await client.query("UPDATE outbox SET claimed_at = NULL, worker = NULL, last_error = $2 WHERE id = $1", [outboxId, lastError]);
            }
          }
        }

        return claim.rows;
      });

      if (!batch.length) break;
    }

    return { processed, worker };
  }

  async function processFinancePackOutbox({ maxMessages = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new TypeError("maxMessages must be a non-negative safe integer");
    const worker = "finance_pack_v1";
    const processed = [];

    const claimed = await store.claimOutbox({ topic: "FINANCE_PACK_BUNDLE_ENQUEUE", maxMessages, worker });
    for (const row of claimed) {
      const outboxId = row.id;
      const attempts = Number.isSafeInteger(row.attempts) ? row.attempts : 1;
      const msg = row.message ?? null;
      const tenantId = normalizeTenantId(msg?.tenantId ?? DEFAULT_TENANT_ID);
      const month = msg?.month ? String(msg.month) : null;
      const basis = msg?.basis ? String(msg.basis) : MONTH_CLOSE_BASIS.SETTLED_AT;
      if (!month) {
        await store.markOutboxProcessed({ ids: [outboxId], lastError: "missing month" });
        continue;
      }

      const monthId = msg?.monthId ? String(msg.monthId) : makeMonthCloseStreamId({ month, basis });

      try {
        // 1) Load inputs from DB (no external IO).
        const loaded = await withTx({ statementTimeoutMs: workerStatementTimeoutMs }, async (client) => {
          const monthEvents = await listMonthEventsFromDb(client, { tenantId, monthId });
          if (!monthEvents.length) throw new Error("missing month stream");
          const monthState = reduceMonthClose(monthEvents);
          const createdAt =
            (typeof monthState?.requestedAt === "string" && monthState.requestedAt.trim() ? String(monthState.requestedAt) : null) ??
            (typeof monthEvents[0]?.at === "string" ? String(monthEvents[0].at) : null) ??
            new Date().toISOString();

          const artifactsRes = await client.query(
            `
              SELECT artifact_json
              FROM artifacts
              WHERE tenant_id = $1
                AND (
                  (artifact_json->>'period') = $2
                  OR (artifact_json->>'month') = $2
                )
            `,
            [tenantId, String(month)]
          );
          const monthArtifacts = artifactsRes.rows.map((r) => r.artifact_json);

          const glBatch = monthArtifacts
            .filter((a) => a?.artifactType === "GLBatch.v1")
            .sort((a, b) => String(a?.artifactId ?? "").localeCompare(String(b?.artifactId ?? "")))
            .slice(-1)[0];
          if (!glBatch) throw new Error("missing GLBatch.v1");

          const journalCsv = monthArtifacts
            .filter((a) => a?.artifactType === "JournalCsv.v1")
            .sort((a, b) => String(a?.artifactId ?? "").localeCompare(String(b?.artifactId ?? "")))
            .slice(-1)[0];

          const partyStatements = monthArtifacts.filter((a) => a?.artifactType === "PartyStatement.v1");

          const tenantGovernanceEvents = await listMonthEventsFromDb(client, { tenantId, monthId: GOVERNANCE_STREAM_ID });
          const governanceEvents = await listMonthEventsFromDb(client, { tenantId: DEFAULT_TENANT_ID, monthId: GOVERNANCE_STREAM_ID });

          return { monthEvents, monthArtifacts, glBatch, journalCsv, partyStatements, createdAt, tenantGovernanceEvents, governanceEvents };
        });

        // If JournalCsv is missing (warn gate), skip bundle generation loudly but don't poison the outbox forever.
        if (!loaded.journalCsv) {
          await store.markOutboxProcessed({ ids: [outboxId], lastError: "SKIPPED:missing JournalCsv.v1 (export blocked or disabled)" });
          processed.push({ id: outboxId, status: "skipped", reason: "missing_journal_csv", month });
          continue;
        }
        if (!loaded.partyStatements.length) throw new Error("missing PartyStatement.v1");

        const reconcile = reconcileGlBatchAgainstPartyStatements({ glBatch: loaded.glBatch, partyStatements: loaded.partyStatements });
        if (!reconcile.ok) {
          const err = new Error(`reconcile failed: ${reconcile.error}`);
          err.detail = reconcile;
          throw err;
        }

        const publicKeyByKeyId = store.publicKeyByKeyId instanceof Map ? store.publicKeyByKeyId : new Map();
        let signerKeys = [];
        if (typeof store.listSignerKeys === "function") {
          const tenantKeys = await store.listSignerKeys({ tenantId });
          const defaultKeys = await store.listSignerKeys({ tenantId: DEFAULT_TENANT_ID });
          const all = [...(tenantKeys ?? []), ...(defaultKeys ?? [])];
          const byKeyId = new Map();
          for (const r of all) {
            const keyId = r?.keyId ? String(r.keyId) : null;
            if (!keyId) continue;
            byKeyId.set(keyId, r);
          }
          signerKeys = Array.from(byKeyId.values());
        }
        const generatedAt = loaded.createdAt;
        const tenantGovernanceSnapshot = {
          streamId: GOVERNANCE_STREAM_ID,
          lastChainHash: loaded.tenantGovernanceEvents.length ? loaded.tenantGovernanceEvents[loaded.tenantGovernanceEvents.length - 1]?.chainHash ?? null : null,
          lastEventId: loaded.tenantGovernanceEvents.length ? loaded.tenantGovernanceEvents[loaded.tenantGovernanceEvents.length - 1]?.id ?? null : null
        };
        const governanceSnapshot = {
          streamId: GOVERNANCE_STREAM_ID,
          lastChainHash: loaded.governanceEvents.length ? loaded.governanceEvents[loaded.governanceEvents.length - 1]?.chainHash ?? null : null,
          lastEventId: loaded.governanceEvents.length ? loaded.governanceEvents[loaded.governanceEvents.length - 1]?.id ?? null : null
        };
        const { files: monthFiles, bundle: monthBundle } = buildMonthProofBundleV1({
          tenantId,
          period: String(month),
          basis,
          monthEvents: loaded.monthEvents,
          governanceEvents: loaded.governanceEvents,
          governanceSnapshot,
          tenantGovernanceEvents: loaded.tenantGovernanceEvents,
          tenantGovernanceSnapshot,
          artifacts: loaded.monthArtifacts,
          contractDocsByHash: new Map(),
          publicKeyByKeyId,
          signerKeys,
          manifestSigner: store?.serverSigner ? { keyId: store.serverSigner.keyId, privateKeyPem: store.serverSigner.privateKeyPem } : null,
          requireHeadAttestation: true,
          generatedAt
        });

        const protocol = "1.0";
        const reconcileBytes = new TextEncoder().encode(`${canonicalJsonStringify(reconcile)}\n`);
        const { files, bundle } = buildFinancePackBundleV1({
          tenantId,
          period: String(month),
          protocol,
          createdAt: loaded.createdAt,
          monthProofBundle: monthBundle,
          monthProofFiles: monthFiles,
          requireMonthProofAttestation: true,
          verificationReportSigner: store?.serverSigner ? { keyId: store.serverSigner.keyId, privateKeyPem: store.serverSigner.privateKeyPem } : null,
          glBatchArtifact: loaded.glBatch,
          journalCsvArtifact: loaded.journalCsv,
          reconcileReport: reconcile,
          reconcileReportBytes: reconcileBytes
        });

        // 2) Build deterministic zip bytes and store to evidence store (immutable, retry-safe).
        const zipBytes = buildDeterministicZipStore({ files, mtime: new Date(loaded.createdAt) });
        const bundleHash = sha256HexBytes(zipBytes);
        const evidenceRef = `obj://finance-pack/${String(month)}/${bundleHash}.zip`;

        // Write-once semantics (best-effort): if already present, verify hash matches.
        let alreadyExisted = false;
        try {
          const existing = await store.evidenceStore.readEvidence({ tenantId, evidenceRef });
          const existingHash = sha256HexBytes(existing.data);
          if (existingHash !== bundleHash) {
            const err = new Error("finance pack bundle already exists with different bytes");
            err.code = "FINANCE_PACK_BUNDLE_IMMUTABILITY_BREACH";
            throw err;
          }
          alreadyExisted = true;
        } catch (err) {
          if (err?.code !== "ENOENT") throw err;
        }

        if (!alreadyExisted) {
          await store.evidenceStore.putEvidence({ tenantId, evidenceRef, data: zipBytes });
        }

        failpoint("finance_pack.after_zip_store_before_pointer");

        // 3) Persist pointer artifact + enqueue deliveries (DB-only).
        const pointerArtifactId = `finance_pack_${tenantId}_${String(month)}_${bundleHash}`;
        const objectStore =
          store.evidenceStore?.kind === "s3"
            ? {
                kind: "s3",
                endpoint: store.evidenceStore.endpoint,
                region: store.evidenceStore.region,
                bucket: store.evidenceStore.bucket,
                key: typeof store.evidenceStore.keyFor === "function" ? store.evidenceStore.keyFor({ tenantId, evidenceRef }) : null,
                forcePathStyle: store.evidenceStore.forcePathStyle !== false
              }
            : { kind: store.evidenceStore?.kind ?? "unknown" };

        const pointerBody = buildFinancePackBundlePointerV1({
          tenantId,
          period: String(month),
          basis,
          bundleHash,
          bundleManifestHash: bundle.manifestHash,
          monthProofBundleHash: monthBundle.manifestHash,
          glBatchHash: String(loaded.glBatch.artifactHash),
          journalCsvHash: String(loaded.journalCsv.csvSha256),
          reconcileReportHash: sha256HexBytes(reconcileBytes),
          financeAccountMapHash: String(loaded.journalCsv.accountMapHash),
          evidenceRef,
          objectStore,
          events: loaded.monthEvents,
          artifactId: pointerArtifactId,
          generatedAt: loaded.createdAt
        });
        const pointerCore = { ...pointerBody, sourceEventId: msg?.sourceEventId ?? null, atChainHash: loaded.monthEvents.at(-1)?.chainHash ?? null };
        const pointerHash = computeArtifactHash(pointerCore);
        const pointerArtifact = { ...pointerCore, artifactHash: pointerHash };

        await withTx({ statementTimeoutMs: workerStatementTimeoutMs }, async (client) => {
          await persistArtifactRow(client, { tenantId, artifact: pointerArtifact });

          const cfg = typeof store.getConfig === "function" ? store.getConfig(tenantId) : store.config;
          const destinations = Array.isArray(cfg?.destinations) ? cfg.destinations : [];
          for (const dest of destinations) {
            if (!dest || typeof dest !== "object") continue;
            const allowed = Array.isArray(dest.artifactTypes) && dest.artifactTypes.length ? dest.artifactTypes : null;
            if (allowed && !allowed.includes(ARTIFACT_TYPE.FINANCE_PACK_BUNDLE_V1)) continue;
            const destinationId = dest.destinationId ?? dest.id ?? null;
            if (typeof destinationId !== "string" || destinationId.trim() === "") continue;
            const dedupeKey = `${tenantId}:${destinationId}:${ARTIFACT_TYPE.FINANCE_PACK_BUNDLE_V1}:${pointerArtifact.artifactId}:${pointerArtifact.artifactHash}`;
            const scopeKey = `finance_pack:period:${month}`;
            const orderSeq = 2;
            const priority = 97;
            const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${pointerArtifact.artifactId}`;
            await insertDeliveryRow(client, {
              tenantId,
              delivery: {
                destinationId,
                artifactType: ARTIFACT_TYPE.FINANCE_PACK_BUNDLE_V1,
                artifactId: pointerArtifact.artifactId,
                artifactHash: pointerArtifact.artifactHash,
                dedupeKey,
                scopeKey,
                orderSeq,
                priority,
                orderKey
              }
            });
          }
        });

        failpoint("finance_pack.after_pointer_before_outbox_done");

        await store.markOutboxProcessed({ ids: [outboxId], lastError: alreadyExisted ? "ok:already_existed" : null });
        processed.push({ id: outboxId, status: "ok", month, bundleHash, manifestHash: bundle.manifestHash });
      } catch (err) {
        const lastError = typeof err?.message === "string" && err.message.trim() ? err.message : String(err ?? "finance pack failed");
        logger.error("finance_pack.failed", { tenantId, month, basis, outboxId, err });
        if (attempts >= outboxMaxAttemptsFromEnv({ fallbackAttempts: 25 })) {
          await store.markOutboxProcessed({ ids: [outboxId], lastError: `DLQ:${lastError}` });
        } else {
          await store.markOutboxFailed({ ids: [outboxId], lastError });
        }
      }
    }

    return { processed, worker };
  }

  async function processNoopOutboxTopic({ topic, worker, maxMessages = Number.MAX_SAFE_INTEGER } = {}) {
    if (typeof topic !== "string" || topic.trim() === "") throw new TypeError("topic is required");
    if (typeof worker !== "string" || worker.trim() === "") throw new TypeError("worker is required");
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new TypeError("maxMessages must be a non-negative safe integer");

    const processed = [];

    // These topics are informational today (no worker consumes them in pg mode).
    // Drain them deterministically so ops / hosted-baseline checks don't wedge.
    while (processed.length < maxMessages) {
      const claimed = await store.claimOutbox({ topic, maxMessages: Math.min(1000, maxMessages - processed.length), worker });
      if (!claimed.length) break;
      const ids = claimed.map((r) => r.id);
      await store.markOutboxProcessed({ ids, lastError: "ok:noop" });
      for (const id of ids) processed.push({ id, status: "noop" });
    }

    return { processed, worker };
  }

  store.processOutbox = async function processOutbox({ maxMessages = 1000 } = {}) {
    const ledger = await processLedgerOutbox({ maxMessages });
    const notifications = await processNotificationsOutbox({ maxMessages });
    const correlations = await processCorrelationsOutbox({ maxMessages });
    const jobStatusChanged = await processNoopOutboxTopic({ topic: "JOB_STATUS_CHANGED", worker: "job_status_changed_v0", maxMessages });
    const jobSettled = await processNoopOutboxTopic({ topic: "JOB_SETTLED", worker: "job_settled_v0", maxMessages });
    const monthClose = await processMonthCloseOutbox({ maxMessages });
    const financePack = await processFinancePackOutbox({ maxMessages });
    return { ledger, notifications, correlations, jobStatusChanged, jobSettled, monthClose, financePack };
  };

  // Read-only ops debugging helper (used by /ops/debug/outbox).
  // Intentionally narrow: surfaces enough to diagnose stuck/DLQ outbox without direct DB access.
  store.listOutboxDebug = async function listOutboxDebug({
    topic = null,
    tenantId = null,
    includeProcessed = false,
    limit = 50
  } = {}) {
    const safeLimit = Number.isSafeInteger(Number(limit)) ? Number(limit) : 50;
    if (safeLimit <= 0 || safeLimit > 500) throw new TypeError("limit must be a safe integer between 1 and 500");
    const t = typeof topic === "string" && topic.trim() ? topic.trim() : null;
    const tenant = typeof tenantId === "string" && tenantId.trim() ? normalizeTenantId(tenantId) : null;
    const processedClause = includeProcessed ? "" : "AND processed_at IS NULL";

    return await withTx({ statementTimeoutMs: workerStatementTimeoutMs }, async (client) => {
      const params = [];
      let where = `WHERE 1=1 ${processedClause}`;
      if (t) {
        params.push(String(t));
        where += ` AND topic = $${params.length}`;
      }
      if (tenant) {
        params.push(String(tenant));
        where += ` AND tenant_id = $${params.length}`;
      }
      params.push(safeLimit);
      const sql = `
        SELECT id, tenant_id, topic, aggregate_type, aggregate_id, attempts, claimed_at, processed_at, last_error, payload_json
        FROM outbox
        ${where}
        ORDER BY id DESC
        LIMIT $${params.length}
      `;
      const res = await client.query(sql, params);
      return res.rows;
    });
  };

  store.close = async function close() {
    const schemaName = schema;
    const shouldDrop = dropSchemaOnClose && schemaName !== "public";
    await pool.end();
    if (shouldDrop) {
      const adminPool = await createPgPool({ databaseUrl, schema: "public" });
      try {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`);
      } finally {
        await adminPool.end();
      }
    }
  };

  // Bootstrap global governance with the current server signer key to avoid creating a new
  // out-of-band trust root for finance-grade bundle attestations.
  try {
    const nowAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
    const globalTenantId = DEFAULT_TENANT_ID;
    const key = makeScopedKey({ tenantId: globalTenantId, id: GOVERNANCE_STREAM_ID });
    const existing = store.monthEvents?.get?.(key) ?? [];
    const serverKeyId = store.serverSigner?.keyId ?? null;
    const serverPublicKeyPem = store.serverSigner?.publicKeyPem ?? null;
    if (serverKeyId && serverPublicKeyPem && Array.isArray(existing)) {
      const already =
        existing.some((e) => e?.type === "SERVER_SIGNER_KEY_REGISTERED" && String(e?.payload?.keyId ?? "") === String(serverKeyId)) ||
        existing.some((e) => e?.type === "SERVER_SIGNER_KEY_ROTATED" && String(e?.payload?.newKeyId ?? "") === String(serverKeyId));
      if (!already) {
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
        try {
          await store.commitTx({ at: nowAt, ops: [{ kind: "MONTH_EVENTS_APPENDED", tenantId: globalTenantId, monthId: GOVERNANCE_STREAM_ID, events: [event] }] });
        } catch (err) {
          // Idempotent under concurrency/restores: if someone else bootstrapped first, treat it as success.
          if (err?.code !== "PREV_CHAIN_HASH_MISMATCH" && err?.code !== "23505") throw err;
        }
      }
    }
  } catch (err) {
    logger.warn("governance.bootstrap_server_key.failed", { err });
  }

  return store;
}
