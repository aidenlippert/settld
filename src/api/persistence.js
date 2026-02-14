import fs from "node:fs";
import path from "node:path";

import { applyJournalEntry } from "../core/ledger.js";
import { reduceJob } from "../core/job-reducer.js";
import { reduceRobot } from "../core/robot-reducer.js";
import { reduceOperator } from "../core/operator-reducer.js";
import { reduceMonthClose } from "../core/month-close.js";
import { AGENT_RUN_EVENT_SCHEMA_VERSION, reduceAgentRun } from "../core/agent-runs.js";
import { normalizeInteractionDirection } from "../core/interaction-directions.js";
import { DEFAULT_TENANT_ID, normalizeTenantId, makeScopedKey } from "../core/tenancy.js";

export const TX_LOG_VERSION = 1;

function normalizeMarketplaceDirectionForReplay({ fromType, toType }) {
  return normalizeInteractionDirection({
    fromType,
    toType,
    defaultFromType: "agent",
    defaultToType: "agent",
    onInvalid: "fallback"
  });
}

export function createFileTxLog({ dir, filename = "proxy-tx.log" }) {
  if (typeof dir !== "string" || dir.trim() === "") throw new TypeError("dir must be a non-empty string");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, filename);
  const fd = fs.openSync(logPath, "a");

  function append(record) {
    const line = `${JSON.stringify(record)}\n`;
    fs.writeSync(fd, line, undefined, "utf8");
    fs.fsyncSync(fd);
  }

  function load() {
    if (!fs.existsSync(logPath)) return [];
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text.split("\n");
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        records.push(parsed);
      } catch {
        // Ignore trailing partial/corrupt line.
        break;
      }
    }
    return records;
  }

  function close() {
    fs.closeSync(fd);
  }

  return { dir, logPath, append, load, close };
}

export function applyTxRecord(store, record) {
  if (!store || typeof store !== "object") throw new TypeError("store is required");
  if (!record || typeof record !== "object") throw new TypeError("record is required");
  if (record.v !== TX_LOG_VERSION) throw new TypeError("unsupported tx record version");

  const ops = record.ops;
  if (!Array.isArray(ops)) throw new TypeError("record.ops must be an array");

  for (const op of ops) {
    if (!op || typeof op !== "object") throw new TypeError("op must be an object");
    const kind = op.kind;
    if (typeof kind !== "string" || kind.trim() === "") throw new TypeError("op.kind must be a non-empty string");

    if (kind === "UPSERT_ROBOT") {
      const robot = op.robot;
      if (!robot?.id) throw new TypeError("UPSERT_ROBOT requires robot.id");
      const tenantId = normalizeTenantId(op.tenantId ?? robot.tenantId ?? DEFAULT_TENANT_ID);
      const key = makeScopedKey({ tenantId, id: robot.id });
      store.robots.set(key, { ...robot, tenantId });
      continue;
    }

    if (kind === "UPSERT_OPERATOR") {
      const operator = op.operator;
      if (!operator?.id) throw new TypeError("UPSERT_OPERATOR requires operator.id");
      const tenantId = normalizeTenantId(op.tenantId ?? operator.tenantId ?? DEFAULT_TENANT_ID);
      const key = makeScopedKey({ tenantId, id: operator.id });
      store.operators.set(key, { ...operator, tenantId });
      continue;
    }

    if (kind === "AGENT_IDENTITY_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const agentIdentity = op.agentIdentity ?? null;
      if (!agentIdentity || typeof agentIdentity !== "object" || Array.isArray(agentIdentity)) {
        throw new TypeError("AGENT_IDENTITY_UPSERT requires agentIdentity");
      }
      const agentId = agentIdentity.agentId ?? agentIdentity.id ?? null;
      if (!agentId) throw new TypeError("AGENT_IDENTITY_UPSERT requires agentIdentity.agentId");
      if (!(store.agentIdentities instanceof Map)) store.agentIdentities = new Map();
      const key = makeScopedKey({ tenantId, id: String(agentId) });
      store.agentIdentities.set(key, { ...agentIdentity, tenantId, agentId: String(agentId) });
      continue;
    }

    if (kind === "AGENT_WALLET_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const wallet = op.wallet ?? null;
      if (!wallet || typeof wallet !== "object" || Array.isArray(wallet)) throw new TypeError("AGENT_WALLET_UPSERT requires wallet");
      const agentId = wallet.agentId ?? null;
      if (!agentId) throw new TypeError("AGENT_WALLET_UPSERT requires wallet.agentId");
      if (!(store.agentWallets instanceof Map)) store.agentWallets = new Map();
      const key = makeScopedKey({ tenantId, id: String(agentId) });
      store.agentWallets.set(key, { ...wallet, tenantId, agentId: String(agentId) });
      continue;
    }

    if (kind === "PUBLIC_KEY_PUT") {
      const { keyId, publicKeyPem } = op;
      if (!keyId) throw new TypeError("PUBLIC_KEY_PUT requires keyId");
      if (!publicKeyPem) throw new TypeError("PUBLIC_KEY_PUT requires publicKeyPem");
      store.publicKeyByKeyId.set(keyId, publicKeyPem);
      continue;
    }

    if (kind === "SIGNER_KEY_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const signerKey = op.signerKey ?? null;
      if (!signerKey || typeof signerKey !== "object") throw new TypeError("SIGNER_KEY_UPSERT requires signerKey");
      const keyId = signerKey.keyId ?? signerKey.id ?? null;
      const publicKeyPem = signerKey.publicKeyPem ?? null;
      if (!keyId) throw new TypeError("SIGNER_KEY_UPSERT requires signerKey.keyId");
      if (!publicKeyPem) throw new TypeError("SIGNER_KEY_UPSERT requires signerKey.publicKeyPem");
      if (!(store.signerKeys instanceof Map)) store.signerKeys = new Map();
      const key = makeScopedKey({ tenantId, id: String(keyId) });
      store.signerKeys.set(key, { ...signerKey, tenantId, keyId: String(keyId), publicKeyPem: String(publicKeyPem) });
      if (store.publicKeyByKeyId instanceof Map) {
        store.publicKeyByKeyId.set(String(keyId), String(publicKeyPem));
      }
      continue;
    }

    if (kind === "SIGNER_KEY_STATUS_SET") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const keyId = op.keyId ?? null;
      const status = op.status ?? null;
      if (!keyId) throw new TypeError("SIGNER_KEY_STATUS_SET requires keyId");
      if (!status) throw new TypeError("SIGNER_KEY_STATUS_SET requires status");
      if (!(store.signerKeys instanceof Map)) store.signerKeys = new Map();
      const key = makeScopedKey({ tenantId, id: String(keyId) });
      const existing = store.signerKeys.get(key) ?? null;
      const updatedAt = record.at ?? new Date().toISOString();
      const next = { ...(existing ?? { tenantId, keyId: String(keyId) }), status: String(status), updatedAt };
      if (op.rotatedAt !== undefined) next.rotatedAt = op.rotatedAt;
      if (op.revokedAt !== undefined) next.revokedAt = op.revokedAt;
      store.signerKeys.set(key, next);
      continue;
    }

    if (kind === "AUTH_KEY_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const authKey = op.authKey ?? null;
      if (!authKey || typeof authKey !== "object") throw new TypeError("AUTH_KEY_UPSERT requires authKey");
      const keyId = authKey.keyId ?? authKey.id ?? null;
      if (!keyId) throw new TypeError("AUTH_KEY_UPSERT requires authKey.keyId");
      if (!(store.authKeys instanceof Map)) store.authKeys = new Map();
      const key = makeScopedKey({ tenantId, id: String(keyId) });
      store.authKeys.set(key, { ...authKey, tenantId, keyId: String(keyId) });
      continue;
    }

    if (kind === "AUTH_KEY_STATUS_SET") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const keyId = op.keyId ?? null;
      const status = op.status ?? null;
      if (!keyId) throw new TypeError("AUTH_KEY_STATUS_SET requires keyId");
      if (!status) throw new TypeError("AUTH_KEY_STATUS_SET requires status");
      if (!(store.authKeys instanceof Map)) store.authKeys = new Map();
      const key = makeScopedKey({ tenantId, id: String(keyId) });
      const existing = store.authKeys.get(key) ?? null;
      const updatedAt = record.at ?? new Date().toISOString();
      const next = { ...(existing ?? { tenantId, keyId: String(keyId) }), status: String(status), updatedAt };
      if (op.rotatedAt !== undefined) next.rotatedAt = op.rotatedAt;
      if (op.revokedAt !== undefined) next.revokedAt = op.revokedAt;
      store.authKeys.set(key, next);
      continue;
    }

    if (kind === "OPS_AUDIT_APPEND") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const audit = op.audit ?? null;
      if (!audit || typeof audit !== "object") throw new TypeError("OPS_AUDIT_APPEND requires audit");
      const auditId = audit.id ?? op.id ?? null;
      if (auditId === null || auditId === undefined || String(auditId).trim() === "") throw new TypeError("OPS_AUDIT_APPEND requires audit.id");
      if (!(store.opsAudit instanceof Map)) store.opsAudit = new Map();
      const key = makeScopedKey({ tenantId, id: String(auditId) });
      store.opsAudit.set(key, { ...audit, tenantId, id: auditId });
      continue;
    }

    if (kind === "CONTRACT_UPSERT") {
      const contract = op.contract;
      if (!contract?.contractId) throw new TypeError("CONTRACT_UPSERT requires contract.contractId");
      const tenantId = normalizeTenantId(op.tenantId ?? contract.tenantId ?? DEFAULT_TENANT_ID);
      if (typeof store.ensureTenant === "function") store.ensureTenant(tenantId);
      if (!(store.contracts instanceof Map)) store.contracts = new Map();
      const key = makeScopedKey({ tenantId, id: String(contract.contractId) });
      store.contracts.set(key, { ...contract, tenantId, contractId: String(contract.contractId) });
      continue;
    }

    if (kind === "JOB_EVENTS_APPENDED") {
      const { jobId, events } = op;
      if (!jobId) throw new TypeError("JOB_EVENTS_APPENDED requires jobId");
      if (!Array.isArray(events) || events.length === 0) throw new TypeError("JOB_EVENTS_APPENDED requires non-empty events[]");

      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const key = makeScopedKey({ tenantId, id: jobId });
      const existing = store.jobEvents.get(key) ?? [];

      // Atomicity / TOCTOU protection (in-memory mode):
      // Reject appends whose first prevChainHash does not match the current stream head.
      // Without this, concurrent appends can silently break the chain.
      const last = existing.length ? existing[existing.length - 1] : null;
      const expectedPrevChainHash = last?.chainHash ?? null;
      const gotPrevChainHash = events[0]?.prevChainHash ?? null;
      if ((expectedPrevChainHash ?? null) !== (gotPrevChainHash ?? null)) {
        const err = new Error("event append conflict");
        err.code = "PREV_CHAIN_HASH_MISMATCH";
        err.statusCode = 409;
        err.expectedPrevChainHash = expectedPrevChainHash;
        err.gotPrevChainHash = gotPrevChainHash;
        throw err;
      }

      for (let i = 1; i < events.length; i += 1) {
        const prev = events[i - 1];
        const nextEv = events[i];
        if ((nextEv?.prevChainHash ?? null) !== (prev?.chainHash ?? null)) {
          const err = new Error("event append conflict");
          err.code = "PREV_CHAIN_HASH_MISMATCH";
          err.statusCode = 409;
          err.expectedPrevChainHash = prev?.chainHash ?? null;
          err.gotPrevChainHash = nextEv?.prevChainHash ?? null;
          throw err;
        }
      }

      const next = [...existing, ...events];
      store.jobEvents.set(key, next);
      const job = reduceJob(next);
      if (job) store.jobs.set(key, { ...job, tenantId: job.tenantId ?? tenantId });
      continue;
    }

    if (kind === "ROBOT_EVENTS_APPENDED") {
      const { robotId, events } = op;
      if (!robotId) throw new TypeError("ROBOT_EVENTS_APPENDED requires robotId");
      if (!Array.isArray(events) || events.length === 0) throw new TypeError("ROBOT_EVENTS_APPENDED requires non-empty events[]");

      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const key = makeScopedKey({ tenantId, id: robotId });
      const existing = store.robotEvents.get(key) ?? [];

      const last = existing.length ? existing[existing.length - 1] : null;
      const expectedPrevChainHash = last?.chainHash ?? null;
      const gotPrevChainHash = events[0]?.prevChainHash ?? null;
      if ((expectedPrevChainHash ?? null) !== (gotPrevChainHash ?? null)) {
        const err = new Error("event append conflict");
        err.code = "PREV_CHAIN_HASH_MISMATCH";
        err.statusCode = 409;
        err.expectedPrevChainHash = expectedPrevChainHash;
        err.gotPrevChainHash = gotPrevChainHash;
        throw err;
      }

      for (let i = 1; i < events.length; i += 1) {
        const prev = events[i - 1];
        const nextEv = events[i];
        if ((nextEv?.prevChainHash ?? null) !== (prev?.chainHash ?? null)) {
          const err = new Error("event append conflict");
          err.code = "PREV_CHAIN_HASH_MISMATCH";
          err.statusCode = 409;
          err.expectedPrevChainHash = prev?.chainHash ?? null;
          err.gotPrevChainHash = nextEv?.prevChainHash ?? null;
          throw err;
        }
      }

      const next = [...existing, ...events];
      store.robotEvents.set(key, next);
      const robot = reduceRobot(next);
      if (robot) store.robots.set(key, { ...robot, tenantId: robot.tenantId ?? tenantId });
      continue;
    }

    if (kind === "OPERATOR_EVENTS_APPENDED") {
      const { operatorId, events } = op;
      if (!operatorId) throw new TypeError("OPERATOR_EVENTS_APPENDED requires operatorId");
      if (!Array.isArray(events) || events.length === 0) throw new TypeError("OPERATOR_EVENTS_APPENDED requires non-empty events[]");

      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const key = makeScopedKey({ tenantId, id: operatorId });
      const existing = store.operatorEvents.get(key) ?? [];

      const last = existing.length ? existing[existing.length - 1] : null;
      const expectedPrevChainHash = last?.chainHash ?? null;
      const gotPrevChainHash = events[0]?.prevChainHash ?? null;
      if ((expectedPrevChainHash ?? null) !== (gotPrevChainHash ?? null)) {
        const err = new Error("event append conflict");
        err.code = "PREV_CHAIN_HASH_MISMATCH";
        err.statusCode = 409;
        err.expectedPrevChainHash = expectedPrevChainHash;
        err.gotPrevChainHash = gotPrevChainHash;
        throw err;
      }

      for (let i = 1; i < events.length; i += 1) {
        const prev = events[i - 1];
        const nextEv = events[i];
        if ((nextEv?.prevChainHash ?? null) !== (prev?.chainHash ?? null)) {
          const err = new Error("event append conflict");
          err.code = "PREV_CHAIN_HASH_MISMATCH";
          err.statusCode = 409;
          err.expectedPrevChainHash = prev?.chainHash ?? null;
          err.gotPrevChainHash = nextEv?.prevChainHash ?? null;
          throw err;
        }
      }

      const next = [...existing, ...events];
      store.operatorEvents.set(key, next);
      const operator = reduceOperator(next);
      if (operator) store.operators.set(key, { ...operator, tenantId: operator.tenantId ?? tenantId });
      continue;
    }

    if (kind === "AGENT_RUN_EVENTS_APPENDED") {
      const { runId, events } = op;
      if (!runId) throw new TypeError("AGENT_RUN_EVENTS_APPENDED requires runId");
      if (!Array.isArray(events) || events.length === 0) throw new TypeError("AGENT_RUN_EVENTS_APPENDED requires non-empty events[]");

      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const key = makeScopedKey({ tenantId, id: runId });
      const existing = store.agentRunEvents.get(key) ?? [];

      const last = existing.length ? existing[existing.length - 1] : null;
      const expectedPrevChainHash = last?.chainHash ?? null;
      const gotPrevChainHash = events[0]?.prevChainHash ?? null;
      if ((expectedPrevChainHash ?? null) !== (gotPrevChainHash ?? null)) {
        const err = new Error("event append conflict");
        err.code = "PREV_CHAIN_HASH_MISMATCH";
        err.statusCode = 409;
        err.expectedPrevChainHash = expectedPrevChainHash;
        err.gotPrevChainHash = gotPrevChainHash;
        throw err;
      }

      for (let i = 1; i < events.length; i += 1) {
        const prev = events[i - 1];
        const nextEv = events[i];
        if ((nextEv?.prevChainHash ?? null) !== (prev?.chainHash ?? null)) {
          const err = new Error("event append conflict");
          err.code = "PREV_CHAIN_HASH_MISMATCH";
          err.statusCode = 409;
          err.expectedPrevChainHash = prev?.chainHash ?? null;
          err.gotPrevChainHash = nextEv?.prevChainHash ?? null;
          throw err;
        }
      }

      const normalizeRunEvent = (event) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) return event;
        if (event.schemaVersion === AGENT_RUN_EVENT_SCHEMA_VERSION) return event;
        return { ...event, schemaVersion: AGENT_RUN_EVENT_SCHEMA_VERSION };
      };

      const next = [...existing.map(normalizeRunEvent), ...events.map(normalizeRunEvent)];
      store.agentRunEvents.set(key, next);
      const run = reduceAgentRun(next);
      if (run) store.agentRuns.set(key, { ...run, tenantId: run.tenantId ?? tenantId });
      continue;
    }

    if (kind === "AGENT_RUN_SETTLEMENT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const settlement = op.settlement ?? null;
      if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) {
        throw new TypeError("AGENT_RUN_SETTLEMENT_UPSERT requires settlement");
      }
      const runId = settlement.runId ?? op.runId ?? null;
      if (!runId) throw new TypeError("AGENT_RUN_SETTLEMENT_UPSERT requires settlement.runId");
      if (!(store.agentRunSettlements instanceof Map)) store.agentRunSettlements = new Map();
      const key = makeScopedKey({ tenantId, id: String(runId) });
      store.agentRunSettlements.set(key, { ...settlement, tenantId, runId: String(runId) });
      continue;
    }

    if (kind === "ARBITRATION_CASE_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const arbitrationCase = op.arbitrationCase ?? null;
      if (!arbitrationCase || typeof arbitrationCase !== "object" || Array.isArray(arbitrationCase)) {
        throw new TypeError("ARBITRATION_CASE_UPSERT requires arbitrationCase");
      }
      const caseId = arbitrationCase.caseId ?? op.caseId ?? null;
      if (!caseId) throw new TypeError("ARBITRATION_CASE_UPSERT requires arbitrationCase.caseId");
      if (!(store.arbitrationCases instanceof Map)) store.arbitrationCases = new Map();
      const key = makeScopedKey({ tenantId, id: String(caseId) });
      store.arbitrationCases.set(key, { ...arbitrationCase, tenantId, caseId: String(caseId) });
      continue;
    }

    if (kind === "AGREEMENT_DELEGATION_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const delegation = op.delegation ?? null;
      if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) {
        throw new TypeError("AGREEMENT_DELEGATION_UPSERT requires delegation");
      }
      const delegationId = delegation.delegationId ?? op.delegationId ?? null;
      if (!delegationId) throw new TypeError("AGREEMENT_DELEGATION_UPSERT requires delegation.delegationId");
      if (!(store.agreementDelegations instanceof Map)) store.agreementDelegations = new Map();
      const key = makeScopedKey({ tenantId, id: String(delegationId) });
      store.agreementDelegations.set(key, { ...delegation, tenantId, delegationId: String(delegationId) });
      continue;
    }

    if (kind === "X402_GATE_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const gate = op.gate ?? null;
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
        throw new TypeError("X402_GATE_UPSERT requires gate");
      }
      const gateId = gate.gateId ?? gate.id ?? op.gateId ?? null;
      if (!gateId) throw new TypeError("X402_GATE_UPSERT requires gate.gateId");
      if (!(store.x402Gates instanceof Map)) store.x402Gates = new Map();
      const key = makeScopedKey({ tenantId, id: String(gateId) });
      store.x402Gates.set(key, { ...gate, tenantId, gateId: String(gateId) });
      continue;
    }

    if (kind === "TOOL_CALL_HOLD_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const hold = op.hold ?? null;
      if (!hold || typeof hold !== "object" || Array.isArray(hold)) throw new TypeError("TOOL_CALL_HOLD_UPSERT requires hold");
      const holdHash = hold.holdHash ?? op.holdHash ?? null;
      if (!holdHash) throw new TypeError("TOOL_CALL_HOLD_UPSERT requires hold.holdHash");
      if (!(store.toolCallHolds instanceof Map)) store.toolCallHolds = new Map();
      const key = makeScopedKey({ tenantId, id: String(holdHash) });
      store.toolCallHolds.set(key, { ...hold, tenantId, holdHash: String(holdHash) });
      continue;
    }

    if (kind === "SETTLEMENT_ADJUSTMENT_PUT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const adjustment = op.adjustment ?? null;
      if (!adjustment || typeof adjustment !== "object" || Array.isArray(adjustment)) {
        throw new TypeError("SETTLEMENT_ADJUSTMENT_PUT requires adjustment");
      }
      const adjustmentId = adjustment.adjustmentId ?? op.adjustmentId ?? null;
      if (!adjustmentId) throw new TypeError("SETTLEMENT_ADJUSTMENT_PUT requires adjustment.adjustmentId");
      if (!(store.settlementAdjustments instanceof Map)) store.settlementAdjustments = new Map();
      const key = makeScopedKey({ tenantId, id: String(adjustmentId) });
      if (store.settlementAdjustments.has(key)) {
        const err = new Error("settlement adjustment already exists");
        err.code = "ADJUSTMENT_ALREADY_EXISTS";
        throw err;
      }
      store.settlementAdjustments.set(key, { ...adjustment, tenantId, adjustmentId: String(adjustmentId) });
      continue;
    }

    if (kind === "MARKETPLACE_RFQ_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const rfq = op.rfq ?? null;
      if (!rfq || typeof rfq !== "object" || Array.isArray(rfq)) throw new TypeError("MARKETPLACE_RFQ_UPSERT requires rfq");
      const rfqId = rfq.rfqId ?? null;
      if (!rfqId) throw new TypeError("MARKETPLACE_RFQ_UPSERT requires rfq.rfqId");
      const direction = normalizeMarketplaceDirectionForReplay({
        fromType: rfq.fromType,
        toType: rfq.toType
      });
      if (!(store.marketplaceRfqs instanceof Map)) store.marketplaceRfqs = new Map();
      const key = makeScopedKey({ tenantId, id: String(rfqId) });
      store.marketplaceRfqs.set(
        key,
        {
          ...rfq,
          tenantId,
          rfqId: String(rfqId),
          fromType: direction.fromType,
          toType: direction.toType
        }
      );
      continue;
    }

    if (kind === "MARKETPLACE_RFQ_BIDS_SET") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const rfqId = op.rfqId ?? null;
      const bids = op.bids ?? null;
      if (!rfqId) throw new TypeError("MARKETPLACE_RFQ_BIDS_SET requires rfqId");
      if (!Array.isArray(bids)) throw new TypeError("MARKETPLACE_RFQ_BIDS_SET requires bids[]");
      if (!(store.marketplaceRfqBids instanceof Map)) store.marketplaceRfqBids = new Map();
      const key = makeScopedKey({ tenantId, id: String(rfqId) });
      store.marketplaceRfqBids.set(
        key,
        bids.map((bid) => {
          if (!bid || typeof bid !== "object" || Array.isArray(bid)) return bid;
          const direction = normalizeMarketplaceDirectionForReplay({
            fromType: bid.fromType,
            toType: bid.toType
          });
          return {
            ...bid,
            tenantId,
            rfqId: String(rfqId),
            fromType: direction.fromType,
            toType: direction.toType
          };
        })
      );
      continue;
    }

    if (kind === "TENANT_SETTLEMENT_POLICY_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const policy = op.policy ?? null;
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        throw new TypeError("TENANT_SETTLEMENT_POLICY_UPSERT requires policy");
      }
      const policyId = typeof policy.policyId === "string" && policy.policyId.trim() !== "" ? policy.policyId.trim() : null;
      const policyVersion = Number(policy.policyVersion);
      if (!policyId) throw new TypeError("TENANT_SETTLEMENT_POLICY_UPSERT requires policy.policyId");
      if (!Number.isSafeInteger(policyVersion) || policyVersion <= 0) {
        throw new TypeError("TENANT_SETTLEMENT_POLICY_UPSERT requires policy.policyVersion >= 1");
      }
      if (!(store.tenantSettlementPolicies instanceof Map)) store.tenantSettlementPolicies = new Map();
      const key = makeScopedKey({ tenantId, id: `${policyId}::${policyVersion}` });
      store.tenantSettlementPolicies.set(key, {
        ...policy,
        tenantId,
        policyId,
        policyVersion
      });
      continue;
    }

    if (kind === "TENANT_SETTLEMENT_POLICY_ROLLOUT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const rollout = op.rollout ?? null;
      if (!rollout || typeof rollout !== "object" || Array.isArray(rollout)) {
        throw new TypeError("TENANT_SETTLEMENT_POLICY_ROLLOUT_UPSERT requires rollout");
      }
      if (!(store.tenantSettlementPolicyRollouts instanceof Map)) {
        store.tenantSettlementPolicyRollouts = new Map();
      }
      const key = makeScopedKey({ tenantId, id: "rollout" });
      store.tenantSettlementPolicyRollouts.set(key, {
        ...rollout,
        tenantId
      });
      continue;
    }

    if (kind === "MONTH_EVENTS_APPENDED") {
      const { monthId, events } = op;
      if (!monthId) throw new TypeError("MONTH_EVENTS_APPENDED requires monthId");
      if (!Array.isArray(events) || events.length === 0) throw new TypeError("MONTH_EVENTS_APPENDED requires non-empty events[]");

      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const key = makeScopedKey({ tenantId, id: monthId });
      const existing = store.monthEvents.get(key) ?? [];

      const last = existing.length ? existing[existing.length - 1] : null;
      const expectedPrevChainHash = last?.chainHash ?? null;
      const gotPrevChainHash = events[0]?.prevChainHash ?? null;
      if ((expectedPrevChainHash ?? null) !== (gotPrevChainHash ?? null)) {
        const err = new Error("event append conflict");
        err.code = "PREV_CHAIN_HASH_MISMATCH";
        err.statusCode = 409;
        err.expectedPrevChainHash = expectedPrevChainHash;
        err.gotPrevChainHash = gotPrevChainHash;
        throw err;
      }

      for (let i = 1; i < events.length; i += 1) {
        const prev = events[i - 1];
        const nextEv = events[i];
        if ((nextEv?.prevChainHash ?? null) !== (prev?.chainHash ?? null)) {
          const err = new Error("event append conflict");
          err.code = "PREV_CHAIN_HASH_MISMATCH";
          err.statusCode = 409;
          err.expectedPrevChainHash = prev?.chainHash ?? null;
          err.gotPrevChainHash = nextEv?.prevChainHash ?? null;
          throw err;
        }
      }

      const next = [...existing, ...events];
      store.monthEvents.set(key, next);
      const month = reduceMonthClose(next);
      if (month) store.months.set(key, { ...month, tenantId: month.tenantId ?? tenantId });
      continue;
    }

    if (kind === "LEDGER_ENTRY_APPLIED") {
      const entry = op.entry;
      if (!entry?.id) throw new TypeError("LEDGER_ENTRY_APPLIED requires entry.id");
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const ledger = typeof store.getLedger === "function" ? store.getLedger(tenantId) : store.ledger;
      applyJournalEntry(ledger, entry);
      continue;
    }

    if (kind === "IDEMPOTENCY_PUT") {
      const { key, value } = op;
      if (!key) throw new TypeError("IDEMPOTENCY_PUT requires key");
      if (!value) throw new TypeError("IDEMPOTENCY_PUT requires value");
      store.idempotency.set(key, value);
      continue;
    }

    if (kind === "OUTBOX_ENQUEUE") {
      const { messages } = op;
      if (!Array.isArray(messages)) throw new TypeError("OUTBOX_ENQUEUE requires messages[]");
      store.outbox.push(...messages);
      continue;
    }

    if (kind === "INGEST_RECORDS_PUT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const records = op.records;
      if (!Array.isArray(records)) throw new TypeError("INGEST_RECORDS_PUT requires records[]");
      if (typeof store.putIngestRecords === "function") {
        // Async function with no awaits; safe to call synchronously here.
        void store.putIngestRecords({ tenantId, records });
        continue;
      }
      if (!(store.ingestRecords instanceof Map)) store.ingestRecords = new Map();
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
      continue;
    }

    throw new TypeError(`unknown op kind: ${kind}`);
  }
}
