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
import { canonicalJsonStringify } from "../core/canonical-json.js";

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

function normalizeEmergencyScopeTypeForReplay(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMERGENCY_SCOPE_TYPES.has(value)) throw new TypeError("invalid emergency scope type");
  return value;
}

function normalizeEmergencyScopeIdForReplay(scopeType, raw) {
  if (scopeType === EMERGENCY_SCOPE_TYPE.TENANT) return null;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new TypeError("emergency scope id is required for non-tenant scope");
  return value;
}

function normalizeEmergencyControlTypeForReplay(raw, { allowNull = false } = {}) {
  if (allowNull && (raw === null || raw === undefined || String(raw).trim() === "")) return null;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMERGENCY_CONTROL_TYPES_SET.has(value)) throw new TypeError("invalid emergency control type");
  return value;
}

function normalizeEmergencyActionForReplay(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMERGENCY_ACTIONS.has(value)) throw new TypeError("invalid emergency action");
  return value;
}

function normalizeEmergencyResumeControlTypesForReplay(raw) {
  const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? EMERGENCY_CONTROL_TYPES : [raw];
  const dedupe = new Set();
  for (const item of values) {
    const controlType = normalizeEmergencyControlTypeForReplay(item, { allowNull: false });
    dedupe.add(controlType);
  }
  const out = Array.from(dedupe.values());
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

function emergencyControlStateStoreKey({ tenantId, scopeType, scopeId, controlType }) {
  const scopeToken = scopeType === EMERGENCY_SCOPE_TYPE.TENANT ? "*" : String(scopeId);
  return makeScopedKey({ tenantId, id: `${scopeType}::${scopeToken}::${controlType}` });
}

function normalizeAutonomousRoutineStatusForReplay(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!AUTONOMOUS_ROUTINE_STATUSES.has(value)) throw new TypeError("invalid autonomous routine status");
  return value;
}

function normalizeAutonomousRoutineControlActionForReplay(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!AUTONOMOUS_ROUTINE_CONTROL_ACTIONS.has(value)) throw new TypeError("invalid autonomous routine control action");
  return value;
}

function autonomousRoutinePolicyStoreKey({ tenantId, routineId }) {
  const normalizedRoutineId = typeof routineId === "string" ? routineId.trim() : "";
  if (!normalizedRoutineId) throw new TypeError("routineId is required");
  return makeScopedKey({ tenantId, id: normalizedRoutineId });
}

function autonomousRoutineExecutionStoreKey({ tenantId, routineId, executionId }) {
  const normalizedRoutineId = typeof routineId === "string" ? routineId.trim() : "";
  const normalizedExecutionId = typeof executionId === "string" ? executionId.trim() : "";
  if (!normalizedRoutineId) throw new TypeError("routineId is required");
  if (!normalizedExecutionId) throw new TypeError("executionId is required");
  return makeScopedKey({ tenantId, id: `${normalizedRoutineId}::${normalizedExecutionId}` });
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

    if (kind === "AGENT_CARD_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const agentCard = op.agentCard ?? null;
      if (!agentCard || typeof agentCard !== "object" || Array.isArray(agentCard)) {
        throw new TypeError("AGENT_CARD_UPSERT requires agentCard");
      }
      const agentId = agentCard.agentId ?? op.agentId ?? null;
      if (!agentId) throw new TypeError("AGENT_CARD_UPSERT requires agentCard.agentId");
      if (!(store.agentCards instanceof Map)) store.agentCards = new Map();
      const key = makeScopedKey({ tenantId, id: String(agentId) });
      store.agentCards.set(key, { ...agentCard, tenantId, agentId: String(agentId) });
      continue;
    }

    if (kind === "AGENT_CARD_ABUSE_REPORT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const report = op.report ?? null;
      if (!report || typeof report !== "object" || Array.isArray(report)) {
        throw new TypeError("AGENT_CARD_ABUSE_REPORT_UPSERT requires report");
      }
      const reportId = report.reportId ?? op.reportId ?? null;
      if (!reportId) throw new TypeError("AGENT_CARD_ABUSE_REPORT_UPSERT requires report.reportId");
      if (!(store.agentCardAbuseReports instanceof Map)) store.agentCardAbuseReports = new Map();
      const key = makeScopedKey({ tenantId, id: String(reportId) });
      store.agentCardAbuseReports.set(key, { ...report, tenantId, reportId: String(reportId) });
      continue;
    }

    if (kind === "SESSION_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const session = op.session ?? null;
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        throw new TypeError("SESSION_UPSERT requires session");
      }
      const sessionId = session.sessionId ?? op.sessionId ?? null;
      if (!sessionId) throw new TypeError("SESSION_UPSERT requires session.sessionId");
      if (!(store.sessions instanceof Map)) store.sessions = new Map();
      const key = makeScopedKey({ tenantId, id: String(sessionId) });
      store.sessions.set(key, { ...session, tenantId, sessionId: String(sessionId) });
      continue;
    }

    if (kind === "AGENT_PASSPORT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const agentPassport = op.agentPassport ?? null;
      if (!agentPassport || typeof agentPassport !== "object" || Array.isArray(agentPassport)) {
        throw new TypeError("AGENT_PASSPORT_UPSERT requires agentPassport");
      }
      const agentId = agentPassport.agentId ?? op.agentId ?? null;
      if (!agentId) throw new TypeError("AGENT_PASSPORT_UPSERT requires agentPassport.agentId");
      const status = typeof agentPassport.status === "string" ? agentPassport.status.trim().toLowerCase() : "";
      if (status !== "active" && status !== "suspended" && status !== "revoked") {
        throw new TypeError("AGENT_PASSPORT_UPSERT requires status active|suspended|revoked");
      }
      if (!(store.agentPassports instanceof Map)) store.agentPassports = new Map();
      const key = makeScopedKey({ tenantId, id: String(agentId) });
      store.agentPassports.set(key, { ...agentPassport, tenantId, agentId: String(agentId), status });
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

    if (kind === "SIMULATION_HARNESS_RUN_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const artifact = op.artifact ?? null;
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        throw new TypeError("SIMULATION_HARNESS_RUN_UPSERT requires artifact");
      }
      const runSha256 = op.runSha256 ?? artifact.runSha256 ?? null;
      if (!runSha256) throw new TypeError("SIMULATION_HARNESS_RUN_UPSERT requires runSha256");
      if (!(store.simulationHarnessRuns instanceof Map)) store.simulationHarnessRuns = new Map();
      const key = makeScopedKey({ tenantId, id: String(runSha256) });
      store.simulationHarnessRuns.set(key, { ...artifact, tenantId, runSha256: String(runSha256) });
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

    if (kind === "EMERGENCY_CONTROL_EVENT_APPEND") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const event = op.event ?? null;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new TypeError("EMERGENCY_CONTROL_EVENT_APPEND requires event");
      }
      const eventIdRaw = event.eventId ?? event.id ?? op.eventId ?? null;
      if (eventIdRaw === null || eventIdRaw === undefined || String(eventIdRaw).trim() === "") {
        throw new TypeError("EMERGENCY_CONTROL_EVENT_APPEND requires event.eventId");
      }
      const eventId = String(eventIdRaw).trim();
      const action = normalizeEmergencyActionForReplay(event.action ?? op.action ?? null);

      const scopeRaw = event.scope && typeof event.scope === "object" && !Array.isArray(event.scope) ? event.scope : {};
      const scopeType = normalizeEmergencyScopeTypeForReplay(scopeRaw.type ?? event.scopeType ?? EMERGENCY_SCOPE_TYPE.TENANT);
      const scopeId = normalizeEmergencyScopeIdForReplay(scopeType, scopeRaw.id ?? event.scopeId ?? null);

      const controlType =
        action === EMERGENCY_ACTION.RESUME
          ? normalizeEmergencyControlTypeForReplay(event.controlType ?? op.controlType ?? null, { allowNull: true })
          : normalizeEmergencyControlTypeForReplay(event.controlType ?? action, { allowNull: false });
      const resumeControlTypes =
        action === EMERGENCY_ACTION.RESUME
          ? normalizeEmergencyResumeControlTypesForReplay(event.resumeControlTypes ?? op.resumeControlTypes ?? (controlType ? [controlType] : null))
          : [];

      const effectiveAt =
        typeof event.effectiveAt === "string" && event.effectiveAt.trim() !== "" ? event.effectiveAt.trim() : record.at ?? new Date().toISOString();
      const createdAt =
        typeof event.createdAt === "string" && event.createdAt.trim() !== "" ? event.createdAt.trim() : effectiveAt;

      if (!(store.emergencyControlEvents instanceof Map)) store.emergencyControlEvents = new Map();
      if (!(store.emergencyControlState instanceof Map)) store.emergencyControlState = new Map();

      const eventKey = makeScopedKey({ tenantId, id: eventId });
      const normalizedEvent = {
        ...event,
        schemaVersion:
          typeof event.schemaVersion === "string" && event.schemaVersion.trim() !== ""
            ? event.schemaVersion.trim()
            : "OpsEmergencyControlEvent.v1",
        tenantId,
        eventId,
        action,
        controlType,
        resumeControlTypes,
        scope: { type: scopeType, id: scopeId },
        effectiveAt,
        createdAt
      };
      const existingEvent = store.emergencyControlEvents.get(eventKey) ?? null;
      if (existingEvent) {
        if (canonicalJsonStringify(existingEvent) !== canonicalJsonStringify(normalizedEvent)) {
          const err = new Error("emergency control event conflict");
          err.code = "EMERGENCY_CONTROL_EVENT_CONFLICT";
          err.statusCode = 409;
          throw err;
        }
        continue;
      }
      store.emergencyControlEvents.set(eventKey, normalizedEvent);

      function putState(nextControlType, nextActive) {
        const stateKey = emergencyControlStateStoreKey({ tenantId, scopeType, scopeId, controlType: nextControlType });
        const existingState = store.emergencyControlState.get(stateKey) ?? null;
        const revision = Number.isSafeInteger(Number(existingState?.revision)) ? Number(existingState.revision) + 1 : 1;
        const next = {
          schemaVersion: "OpsEmergencyControlState.v1",
          tenantId,
          scopeType,
          scopeId,
          controlType: nextControlType,
          active: nextActive === true,
          activatedAt: nextActive === true ? effectiveAt : existingState?.activatedAt ?? null,
          resumedAt: nextActive === true ? null : effectiveAt,
          updatedAt: effectiveAt,
          lastEventId: eventId,
          lastAction: action,
          reasonCode:
            event.reasonCode === null || event.reasonCode === undefined || String(event.reasonCode).trim() === ""
              ? null
              : String(event.reasonCode).trim(),
          reason: event.reason === null || event.reason === undefined || String(event.reason).trim() === "" ? null : String(event.reason).trim(),
          operatorAction:
            event.operatorAction && typeof event.operatorAction === "object" && !Array.isArray(event.operatorAction) ? event.operatorAction : null,
          revision
        };
        store.emergencyControlState.set(stateKey, next);
      }

      if (action === EMERGENCY_ACTION.RESUME) {
        for (const resumeControlType of resumeControlTypes) {
          putState(resumeControlType, false);
        }
      } else {
        putState(controlType, true);
      }
      continue;
    }

    if (kind === "AUTONOMOUS_ROUTINE_POLICY_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const routine = op.routine ?? null;
      if (!routine || typeof routine !== "object" || Array.isArray(routine)) {
        throw new TypeError("AUTONOMOUS_ROUTINE_POLICY_UPSERT requires routine");
      }
      const routineIdRaw = routine.routineId ?? routine.id ?? null;
      if (routineIdRaw === null || routineIdRaw === undefined || String(routineIdRaw).trim() === "") {
        throw new TypeError("AUTONOMOUS_ROUTINE_POLICY_UPSERT requires routine.routineId");
      }
      const routineId = String(routineIdRaw).trim();
      const status = normalizeAutonomousRoutineStatusForReplay(routine.status ?? AUTONOMOUS_ROUTINE_STATUS.ACTIVE);
      const spendingLimits =
        routine.spendingLimits && typeof routine.spendingLimits === "object" && !Array.isArray(routine.spendingLimits) ? routine.spendingLimits : null;
      if (!spendingLimits) throw new TypeError("AUTONOMOUS_ROUTINE_POLICY_UPSERT requires routine.spendingLimits");
      const currency = typeof spendingLimits.currency === "string" ? spendingLimits.currency.trim().toUpperCase() : "";
      if (!currency) throw new TypeError("AUTONOMOUS_ROUTINE_POLICY_UPSERT requires routine.spendingLimits.currency");
      const maxPerExecutionMicros = Number(spendingLimits.maxPerExecutionMicros);
      const maxPerDayMicros = Number(spendingLimits.maxPerDayMicros);
      if (!Number.isSafeInteger(maxPerExecutionMicros) || maxPerExecutionMicros < 0) {
        throw new TypeError("AUTONOMOUS_ROUTINE_POLICY_UPSERT requires non-negative routine.spendingLimits.maxPerExecutionMicros");
      }
      if (!Number.isSafeInteger(maxPerDayMicros) || maxPerDayMicros < 0) {
        throw new TypeError("AUTONOMOUS_ROUTINE_POLICY_UPSERT requires non-negative routine.spendingLimits.maxPerDayMicros");
      }
      if (maxPerDayMicros < maxPerExecutionMicros) {
        throw new TypeError("AUTONOMOUS_ROUTINE_POLICY_UPSERT requires maxPerDayMicros >= maxPerExecutionMicros");
      }
      const killSwitch =
        routine.killSwitch && typeof routine.killSwitch === "object" && !Array.isArray(routine.killSwitch) ? routine.killSwitch : {};
      if (killSwitch.active !== undefined && typeof killSwitch.active !== "boolean") {
        throw new TypeError("AUTONOMOUS_ROUTINE_POLICY_UPSERT requires boolean routine.killSwitch.active when provided");
      }
      const killSwitchRevision =
        killSwitch.revision === undefined || killSwitch.revision === null ? 0 : Number(killSwitch.revision);
      if (!Number.isSafeInteger(killSwitchRevision) || killSwitchRevision < 0) {
        throw new TypeError("AUTONOMOUS_ROUTINE_POLICY_UPSERT requires non-negative routine.killSwitch.revision");
      }

      if (!(store.autonomousRoutinePolicies instanceof Map)) store.autonomousRoutinePolicies = new Map();
      const key = autonomousRoutinePolicyStoreKey({ tenantId, routineId });
      const existing = store.autonomousRoutinePolicies.get(key) ?? null;
      const updatedAt =
        typeof routine.updatedAt === "string" && routine.updatedAt.trim() !== "" ? routine.updatedAt.trim() : record.at ?? new Date().toISOString();
      const createdAt =
        typeof routine.createdAt === "string" && routine.createdAt.trim() !== ""
          ? routine.createdAt.trim()
          : existing?.createdAt ?? updatedAt;
      const normalizedRoutine = {
        ...routine,
        schemaVersion:
          typeof routine.schemaVersion === "string" && routine.schemaVersion.trim() !== ""
            ? routine.schemaVersion.trim()
            : "AutonomousRoutinePolicy.v1",
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
          revision: killSwitchRevision,
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
        },
        createdAt,
        updatedAt
      };
      store.autonomousRoutinePolicies.set(key, normalizedRoutine);
      continue;
    }

    if (kind === "AUTONOMOUS_ROUTINE_CONTROL_EVENT_APPEND") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const event = op.event ?? null;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new TypeError("AUTONOMOUS_ROUTINE_CONTROL_EVENT_APPEND requires event");
      }
      const incidentIdRaw = event.incidentId ?? event.eventId ?? event.id ?? op.incidentId ?? null;
      if (incidentIdRaw === null || incidentIdRaw === undefined || String(incidentIdRaw).trim() === "") {
        throw new TypeError("AUTONOMOUS_ROUTINE_CONTROL_EVENT_APPEND requires event.incidentId");
      }
      const routineIdRaw = event.routineId ?? op.routineId ?? null;
      if (routineIdRaw === null || routineIdRaw === undefined || String(routineIdRaw).trim() === "") {
        throw new TypeError("AUTONOMOUS_ROUTINE_CONTROL_EVENT_APPEND requires event.routineId");
      }
      const incidentId = String(incidentIdRaw).trim();
      const routineId = String(routineIdRaw).trim();
      const action = normalizeAutonomousRoutineControlActionForReplay(event.action ?? op.action ?? null);
      const effectiveAt =
        typeof event.effectiveAt === "string" && event.effectiveAt.trim() !== "" ? event.effectiveAt.trim() : record.at ?? new Date().toISOString();
      const createdAt =
        typeof event.createdAt === "string" && event.createdAt.trim() !== "" ? event.createdAt.trim() : effectiveAt;

      if (!(store.autonomousRoutinePolicies instanceof Map)) store.autonomousRoutinePolicies = new Map();
      if (!(store.autonomousRoutineControlEvents instanceof Map)) store.autonomousRoutineControlEvents = new Map();
      const routineKey = autonomousRoutinePolicyStoreKey({ tenantId, routineId });
      const existingRoutine = store.autonomousRoutinePolicies.get(routineKey) ?? null;
      if (!existingRoutine) throw new TypeError("AUTONOMOUS_ROUTINE_CONTROL_EVENT_APPEND routine was not found");

      const eventKey = makeScopedKey({ tenantId, id: incidentId });
      const normalizedEvent = {
        ...event,
        schemaVersion:
          typeof event.schemaVersion === "string" && event.schemaVersion.trim() !== ""
            ? event.schemaVersion.trim()
            : "AutonomousRoutineControlEvent.v1",
        tenantId,
        incidentId,
        routineId,
        action,
        effectiveAt,
        createdAt
      };
      const existingEvent = store.autonomousRoutineControlEvents.get(eventKey) ?? null;
      if (existingEvent) {
        if (canonicalJsonStringify(existingEvent) !== canonicalJsonStringify(normalizedEvent)) {
          const err = new Error("autonomous routine control event conflict");
          err.code = "AUTONOMOUS_ROUTINE_CONTROL_EVENT_CONFLICT";
          err.statusCode = 409;
          throw err;
        }
        continue;
      }
      store.autonomousRoutineControlEvents.set(eventKey, normalizedEvent);

      const previousKillSwitch =
        existingRoutine.killSwitch && typeof existingRoutine.killSwitch === "object" && !Array.isArray(existingRoutine.killSwitch)
          ? existingRoutine.killSwitch
          : {};
      const previousRevision = Number(previousKillSwitch.revision);
      const nextRevision = Number.isSafeInteger(previousRevision) && previousRevision >= 0 ? previousRevision + 1 : 1;
      const nextKillSwitchActive = action === AUTONOMOUS_ROUTINE_CONTROL_ACTION.KILL_SWITCH;
      const nextRoutine = {
        ...existingRoutine,
        killSwitch: {
          active: nextKillSwitchActive,
          revision: nextRevision,
          updatedAt: effectiveAt,
          reasonCode:
            nextKillSwitchActive &&
            !(event.reasonCode === null || event.reasonCode === undefined || String(event.reasonCode).trim() === "")
              ? String(event.reasonCode).trim()
              : null,
          reason:
            nextKillSwitchActive && !(event.reason === null || event.reason === undefined || String(event.reason).trim() === "")
              ? String(event.reason).trim()
              : null,
          lastIncidentId: incidentId
        },
        updatedAt: effectiveAt
      };
      store.autonomousRoutinePolicies.set(routineKey, nextRoutine);
      continue;
    }

    if (kind === "AUTONOMOUS_ROUTINE_EXECUTION_APPEND") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const execution = op.execution ?? null;
      if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
        throw new TypeError("AUTONOMOUS_ROUTINE_EXECUTION_APPEND requires execution");
      }
      const routineIdRaw = execution.routineId ?? op.routineId ?? null;
      const executionIdRaw = execution.executionId ?? execution.id ?? op.executionId ?? null;
      if (routineIdRaw === null || routineIdRaw === undefined || String(routineIdRaw).trim() === "") {
        throw new TypeError("AUTONOMOUS_ROUTINE_EXECUTION_APPEND requires execution.routineId");
      }
      if (executionIdRaw === null || executionIdRaw === undefined || String(executionIdRaw).trim() === "") {
        throw new TypeError("AUTONOMOUS_ROUTINE_EXECUTION_APPEND requires execution.executionId");
      }
      const routineId = String(routineIdRaw).trim();
      const executionId = String(executionIdRaw).trim();
      if (!(store.autonomousRoutinePolicies instanceof Map)) store.autonomousRoutinePolicies = new Map();
      if (!(store.autonomousRoutineExecutions instanceof Map)) store.autonomousRoutineExecutions = new Map();

      const routine = store.autonomousRoutinePolicies.get(autonomousRoutinePolicyStoreKey({ tenantId, routineId })) ?? null;
      if (!routine) throw new TypeError("AUTONOMOUS_ROUTINE_EXECUTION_APPEND routine was not found");
      const decision =
        execution.decision && typeof execution.decision === "object" && !Array.isArray(execution.decision) ? execution.decision : null;
      if (!decision || typeof decision.allowed !== "boolean") {
        throw new TypeError("AUTONOMOUS_ROUTINE_EXECUTION_APPEND requires execution.decision.allowed");
      }
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
      const key = autonomousRoutineExecutionStoreKey({ tenantId, routineId, executionId });
      const existing = store.autonomousRoutineExecutions.get(key) ?? null;
      if (existing) {
        if (canonicalJsonStringify(existing) !== canonicalJsonStringify(normalizedExecution)) {
          const err = new Error("autonomous routine execution conflict");
          err.code = "AUTONOMOUS_ROUTINE_EXECUTION_CONFLICT";
          err.statusCode = 409;
          throw err;
        }
        continue;
      }
      store.autonomousRoutineExecutions.set(key, normalizedExecution);
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

    if (kind === "SESSION_EVENTS_APPENDED") {
      const { sessionId, events } = op;
      if (!sessionId) throw new TypeError("SESSION_EVENTS_APPENDED requires sessionId");
      if (!Array.isArray(events) || events.length === 0) throw new TypeError("SESSION_EVENTS_APPENDED requires non-empty events[]");

      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      if (!(store.sessionEvents instanceof Map)) store.sessionEvents = new Map();
      const key = makeScopedKey({ tenantId, id: String(sessionId) });
      const existing = store.sessionEvents.get(key) ?? [];

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

      store.sessionEvents.set(key, [...existing, ...events]);
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

    if (kind === "DELEGATION_GRANT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const delegationGrant = op.delegationGrant ?? null;
      if (!delegationGrant || typeof delegationGrant !== "object" || Array.isArray(delegationGrant)) {
        throw new TypeError("DELEGATION_GRANT_UPSERT requires delegationGrant");
      }
      const grantId = delegationGrant.grantId ?? op.grantId ?? null;
      if (!grantId) throw new TypeError("DELEGATION_GRANT_UPSERT requires delegationGrant.grantId");
      if (!(store.delegationGrants instanceof Map)) store.delegationGrants = new Map();
      const key = makeScopedKey({ tenantId, id: String(grantId) });
      store.delegationGrants.set(key, { ...delegationGrant, tenantId, grantId: String(grantId) });
      continue;
    }

    if (kind === "AUTHORITY_GRANT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const authorityGrant = op.authorityGrant ?? null;
      if (!authorityGrant || typeof authorityGrant !== "object" || Array.isArray(authorityGrant)) {
        throw new TypeError("AUTHORITY_GRANT_UPSERT requires authorityGrant");
      }
      const grantId = authorityGrant.grantId ?? op.grantId ?? null;
      if (!grantId) throw new TypeError("AUTHORITY_GRANT_UPSERT requires authorityGrant.grantId");
      if (!(store.authorityGrants instanceof Map)) store.authorityGrants = new Map();
      const key = makeScopedKey({ tenantId, id: String(grantId) });
      store.authorityGrants.set(key, { ...authorityGrant, tenantId, grantId: String(grantId) });
      continue;
    }

    if (kind === "TASK_QUOTE_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const taskQuote = op.taskQuote ?? null;
      if (!taskQuote || typeof taskQuote !== "object" || Array.isArray(taskQuote)) {
        throw new TypeError("TASK_QUOTE_UPSERT requires taskQuote");
      }
      const quoteId = taskQuote.quoteId ?? op.quoteId ?? null;
      if (!quoteId) throw new TypeError("TASK_QUOTE_UPSERT requires taskQuote.quoteId");
      if (!(store.taskQuotes instanceof Map)) store.taskQuotes = new Map();
      const key = makeScopedKey({ tenantId, id: String(quoteId) });
      store.taskQuotes.set(key, { ...taskQuote, tenantId, quoteId: String(quoteId) });
      continue;
    }

    if (kind === "TASK_OFFER_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const taskOffer = op.taskOffer ?? null;
      if (!taskOffer || typeof taskOffer !== "object" || Array.isArray(taskOffer)) {
        throw new TypeError("TASK_OFFER_UPSERT requires taskOffer");
      }
      const offerId = taskOffer.offerId ?? op.offerId ?? null;
      if (!offerId) throw new TypeError("TASK_OFFER_UPSERT requires taskOffer.offerId");
      if (!(store.taskOffers instanceof Map)) store.taskOffers = new Map();
      const key = makeScopedKey({ tenantId, id: String(offerId) });
      store.taskOffers.set(key, { ...taskOffer, tenantId, offerId: String(offerId) });
      continue;
    }

    if (kind === "TASK_ACCEPTANCE_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const taskAcceptance = op.taskAcceptance ?? null;
      if (!taskAcceptance || typeof taskAcceptance !== "object" || Array.isArray(taskAcceptance)) {
        throw new TypeError("TASK_ACCEPTANCE_UPSERT requires taskAcceptance");
      }
      const acceptanceId = taskAcceptance.acceptanceId ?? op.acceptanceId ?? null;
      if (!acceptanceId) throw new TypeError("TASK_ACCEPTANCE_UPSERT requires taskAcceptance.acceptanceId");
      if (!(store.taskAcceptances instanceof Map)) store.taskAcceptances = new Map();
      const key = makeScopedKey({ tenantId, id: String(acceptanceId) });
      store.taskAcceptances.set(key, { ...taskAcceptance, tenantId, acceptanceId: String(acceptanceId) });
      continue;
    }

    if (kind === "INTENT_CONTRACT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const intentContract = op.intentContract ?? null;
      if (!intentContract || typeof intentContract !== "object" || Array.isArray(intentContract)) {
        throw new TypeError("INTENT_CONTRACT_UPSERT requires intentContract");
      }
      const intentId = intentContract.intentId ?? op.intentId ?? null;
      if (!intentId) throw new TypeError("INTENT_CONTRACT_UPSERT requires intentContract.intentId");
      if (!(store.intentContracts instanceof Map)) store.intentContracts = new Map();
      const key = makeScopedKey({ tenantId, id: String(intentId) });
      store.intentContracts.set(key, { ...intentContract, tenantId, intentId: String(intentId) });
      continue;
    }

    if (kind === "CAPABILITY_ATTESTATION_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const capabilityAttestation = op.capabilityAttestation ?? null;
      if (!capabilityAttestation || typeof capabilityAttestation !== "object" || Array.isArray(capabilityAttestation)) {
        throw new TypeError("CAPABILITY_ATTESTATION_UPSERT requires capabilityAttestation");
      }
      const attestationId = capabilityAttestation.attestationId ?? op.attestationId ?? null;
      if (!attestationId) throw new TypeError("CAPABILITY_ATTESTATION_UPSERT requires capabilityAttestation.attestationId");
      if (!(store.capabilityAttestations instanceof Map)) store.capabilityAttestations = new Map();
      const key = makeScopedKey({ tenantId, id: String(attestationId) });
      store.capabilityAttestations.set(key, { ...capabilityAttestation, tenantId, attestationId: String(attestationId) });
      continue;
    }

    if (kind === "SUB_AGENT_WORK_ORDER_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const workOrder = op.workOrder ?? null;
      if (!workOrder || typeof workOrder !== "object" || Array.isArray(workOrder)) {
        throw new TypeError("SUB_AGENT_WORK_ORDER_UPSERT requires workOrder");
      }
      const workOrderId = workOrder.workOrderId ?? op.workOrderId ?? null;
      if (!workOrderId) throw new TypeError("SUB_AGENT_WORK_ORDER_UPSERT requires workOrder.workOrderId");
      if (!(store.subAgentWorkOrders instanceof Map)) store.subAgentWorkOrders = new Map();
      const key = makeScopedKey({ tenantId, id: String(workOrderId) });
      store.subAgentWorkOrders.set(key, { ...workOrder, tenantId, workOrderId: String(workOrderId) });
      continue;
    }

    if (kind === "SUB_AGENT_COMPLETION_RECEIPT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const completionReceipt = op.completionReceipt ?? null;
      if (!completionReceipt || typeof completionReceipt !== "object" || Array.isArray(completionReceipt)) {
        throw new TypeError("SUB_AGENT_COMPLETION_RECEIPT_UPSERT requires completionReceipt");
      }
      const receiptId = completionReceipt.receiptId ?? op.receiptId ?? null;
      if (!receiptId) throw new TypeError("SUB_AGENT_COMPLETION_RECEIPT_UPSERT requires completionReceipt.receiptId");
      if (!(store.subAgentCompletionReceipts instanceof Map)) store.subAgentCompletionReceipts = new Map();
      const key = makeScopedKey({ tenantId, id: String(receiptId) });
      store.subAgentCompletionReceipts.set(key, { ...completionReceipt, tenantId, receiptId: String(receiptId) });
      continue;
    }

    if (kind === "STATE_CHECKPOINT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const stateCheckpoint = op.stateCheckpoint ?? null;
      if (!stateCheckpoint || typeof stateCheckpoint !== "object" || Array.isArray(stateCheckpoint)) {
        throw new TypeError("STATE_CHECKPOINT_UPSERT requires stateCheckpoint");
      }
      const checkpointId = stateCheckpoint.checkpointId ?? op.checkpointId ?? null;
      if (!checkpointId) throw new TypeError("STATE_CHECKPOINT_UPSERT requires stateCheckpoint.checkpointId");
      if (!(store.stateCheckpoints instanceof Map)) store.stateCheckpoints = new Map();
      const key = makeScopedKey({ tenantId, id: String(checkpointId) });
      if (store.stateCheckpoints.has(key)) {
        const err = new Error("state checkpoint already exists");
        err.code = "STATE_CHECKPOINT_ALREADY_EXISTS";
        err.checkpointId = String(checkpointId);
        throw err;
      }
      store.stateCheckpoints.set(key, { ...stateCheckpoint, tenantId, checkpointId: String(checkpointId) });
      continue;
    }

    if (kind === "SESSION_RELAY_STATE_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const relayState = op.relayState ?? null;
      if (!relayState || typeof relayState !== "object" || Array.isArray(relayState)) {
        throw new TypeError("SESSION_RELAY_STATE_UPSERT requires relayState");
      }
      const checkpointId = relayState.checkpointId ?? op.checkpointId ?? null;
      if (!checkpointId) throw new TypeError("SESSION_RELAY_STATE_UPSERT requires relayState.checkpointId");
      if (!(store.sessionRelayStates instanceof Map)) store.sessionRelayStates = new Map();
      const key = makeScopedKey({ tenantId, id: String(checkpointId) });
      store.sessionRelayStates.set(key, { ...relayState, tenantId, checkpointId: String(checkpointId) });
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

    if (kind === "X402_AGENT_LIFECYCLE_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const agentLifecycle = op.agentLifecycle ?? null;
      if (!agentLifecycle || typeof agentLifecycle !== "object" || Array.isArray(agentLifecycle)) {
        throw new TypeError("X402_AGENT_LIFECYCLE_UPSERT requires agentLifecycle");
      }
      const agentId = agentLifecycle.agentId ?? op.agentId ?? null;
      if (!agentId) throw new TypeError("X402_AGENT_LIFECYCLE_UPSERT requires agentLifecycle.agentId");
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
          "X402_AGENT_LIFECYCLE_UPSERT requires status provisioned|active|throttled|suspended|quarantined|decommissioned|frozen|archived"
        );
      }
      if (!(store.x402AgentLifecycles instanceof Map)) store.x402AgentLifecycles = new Map();
      const key = makeScopedKey({ tenantId, id: String(agentId) });
      store.x402AgentLifecycles.set(key, { ...agentLifecycle, tenantId, agentId: String(agentId), status });
      continue;
    }

    if (kind === "X402_RECEIPT_PUT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const receipt = op.receipt ?? null;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
        throw new TypeError("X402_RECEIPT_PUT requires receipt");
      }
      const receiptId = receipt.receiptId ?? op.receiptId ?? null;
      if (!receiptId) throw new TypeError("X402_RECEIPT_PUT requires receipt.receiptId");
      if (!(store.x402Receipts instanceof Map)) store.x402Receipts = new Map();
      const key = makeScopedKey({ tenantId, id: String(receiptId) });
      const normalized = {
        ...receipt,
        tenantId,
        receiptId: String(receiptId),
        reversal: null,
        reversalEvents: []
      };
      const existing = store.x402Receipts.get(key) ?? null;
      if (existing) {
        const existingCanonical = canonicalJsonStringify(existing);
        const incomingCanonical = canonicalJsonStringify(normalized);
        if (existingCanonical !== incomingCanonical) {
          const err = new Error("x402 receipt is immutable and cannot be changed");
          err.code = "X402_RECEIPT_IMMUTABLE";
          err.receiptId = String(receiptId);
          throw err;
        }
        continue;
      }
      store.x402Receipts.set(key, normalized);
      continue;
    }

    if (kind === "X402_WALLET_POLICY_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const policy = op.policy ?? null;
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        throw new TypeError("X402_WALLET_POLICY_UPSERT requires policy");
      }
      const sponsorWalletRef = typeof policy.sponsorWalletRef === "string" ? policy.sponsorWalletRef.trim() : "";
      const policyRef = typeof policy.policyRef === "string" ? policy.policyRef.trim() : "";
      const policyVersion = Number(policy.policyVersion);
      if (!sponsorWalletRef) throw new TypeError("X402_WALLET_POLICY_UPSERT requires policy.sponsorWalletRef");
      if (!policyRef) throw new TypeError("X402_WALLET_POLICY_UPSERT requires policy.policyRef");
      if (!Number.isSafeInteger(policyVersion) || policyVersion <= 0) {
        throw new TypeError("X402_WALLET_POLICY_UPSERT requires policy.policyVersion >= 1");
      }
      if (!(store.x402WalletPolicies instanceof Map)) store.x402WalletPolicies = new Map();
      const key = makeScopedKey({ tenantId, id: `${sponsorWalletRef}::${policyRef}::${policyVersion}` });
      store.x402WalletPolicies.set(key, {
        ...policy,
        tenantId,
        sponsorWalletRef,
        policyRef,
        policyVersion
      });
      continue;
    }

    if (kind === "X402_ZK_VERIFICATION_KEY_PUT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const verificationKey = op.verificationKey ?? null;
      if (!verificationKey || typeof verificationKey !== "object" || Array.isArray(verificationKey)) {
        throw new TypeError("X402_ZK_VERIFICATION_KEY_PUT requires verificationKey");
      }
      const verificationKeyId = verificationKey.verificationKeyId ?? op.verificationKeyId ?? null;
      if (!verificationKeyId) throw new TypeError("X402_ZK_VERIFICATION_KEY_PUT requires verificationKey.verificationKeyId");
      if (!(store.x402ZkVerificationKeys instanceof Map)) store.x402ZkVerificationKeys = new Map();
      const key = makeScopedKey({ tenantId, id: String(verificationKeyId) });
      const normalized = {
        ...verificationKey,
        tenantId,
        verificationKeyId: String(verificationKeyId)
      };
      const existing = store.x402ZkVerificationKeys.get(key) ?? null;
      if (existing) {
        const existingCanonical = canonicalJsonStringify(existing);
        const incomingCanonical = canonicalJsonStringify(normalized);
        if (existingCanonical !== incomingCanonical) {
          const err = new Error("x402 zk verification key is immutable and cannot be changed");
          err.code = "X402_ZK_VERIFICATION_KEY_IMMUTABLE";
          err.verificationKeyId = String(verificationKeyId);
          throw err;
        }
        continue;
      }
      store.x402ZkVerificationKeys.set(key, normalized);
      continue;
    }

    if (kind === "X402_REVERSAL_EVENT_APPEND") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const event = op.event ?? null;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new TypeError("X402_REVERSAL_EVENT_APPEND requires event");
      }
      const eventId = op.eventId ?? event.eventId ?? event.id ?? null;
      const gateId = op.gateId ?? event.gateId ?? null;
      if (!eventId) throw new TypeError("X402_REVERSAL_EVENT_APPEND requires event.eventId");
      if (!gateId) throw new TypeError("X402_REVERSAL_EVENT_APPEND requires event.gateId");
      if (!(store.x402ReversalEvents instanceof Map)) store.x402ReversalEvents = new Map();
      const key = makeScopedKey({ tenantId, id: String(eventId) });
      store.x402ReversalEvents.set(key, {
        ...event,
        tenantId,
        eventId: String(eventId),
        gateId: String(gateId)
      });
      continue;
    }

    if (kind === "X402_REVERSAL_NONCE_PUT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const usage = op.usage ?? null;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
        throw new TypeError("X402_REVERSAL_NONCE_PUT requires usage");
      }
      const sponsorRef = op.sponsorRef ?? usage.sponsorRef ?? null;
      const nonce = op.nonce ?? usage.nonce ?? null;
      if (!sponsorRef) throw new TypeError("X402_REVERSAL_NONCE_PUT requires sponsorRef");
      if (!nonce) throw new TypeError("X402_REVERSAL_NONCE_PUT requires nonce");
      if (!(store.x402ReversalNonceUsage instanceof Map)) store.x402ReversalNonceUsage = new Map();
      const key = `${tenantId}\n${String(sponsorRef)}\n${String(nonce)}`;
      store.x402ReversalNonceUsage.set(key, {
        ...usage,
        tenantId,
        sponsorRef: String(sponsorRef),
        nonce: String(nonce)
      });
      continue;
    }

    if (kind === "X402_REVERSAL_COMMAND_PUT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const usage = op.usage ?? null;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
        throw new TypeError("X402_REVERSAL_COMMAND_PUT requires usage");
      }
      const commandId = op.commandId ?? usage.commandId ?? null;
      if (!commandId) throw new TypeError("X402_REVERSAL_COMMAND_PUT requires commandId");
      if (!(store.x402ReversalCommandUsage instanceof Map)) store.x402ReversalCommandUsage = new Map();
      const key = makeScopedKey({ tenantId, id: String(commandId) });
      store.x402ReversalCommandUsage.set(key, {
        ...usage,
        tenantId,
        commandId: String(commandId)
      });
      continue;
    }

    if (kind === "X402_ESCALATION_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const escalation = op.escalation ?? null;
      if (!escalation || typeof escalation !== "object" || Array.isArray(escalation)) {
        throw new TypeError("X402_ESCALATION_UPSERT requires escalation");
      }
      const escalationId = escalation.escalationId ?? op.escalationId ?? null;
      if (!escalationId) throw new TypeError("X402_ESCALATION_UPSERT requires escalation.escalationId");
      if (!(store.x402Escalations instanceof Map)) store.x402Escalations = new Map();
      const key = makeScopedKey({ tenantId, id: String(escalationId) });
      store.x402Escalations.set(key, {
        ...escalation,
        tenantId,
        escalationId: String(escalationId)
      });
      continue;
    }

    if (kind === "X402_ESCALATION_EVENT_APPEND") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const event = op.event ?? null;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new TypeError("X402_ESCALATION_EVENT_APPEND requires event");
      }
      const eventId = op.eventId ?? event.eventId ?? event.id ?? null;
      const escalationId = op.escalationId ?? event.escalationId ?? null;
      if (!eventId) throw new TypeError("X402_ESCALATION_EVENT_APPEND requires event.eventId");
      if (!escalationId) throw new TypeError("X402_ESCALATION_EVENT_APPEND requires event.escalationId");
      if (!(store.x402EscalationEvents instanceof Map)) store.x402EscalationEvents = new Map();
      const key = makeScopedKey({ tenantId, id: String(eventId) });
      store.x402EscalationEvents.set(key, {
        ...event,
        tenantId,
        eventId: String(eventId),
        escalationId: String(escalationId)
      });
      continue;
    }

    if (kind === "X402_ESCALATION_OVERRIDE_USAGE_PUT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const usage = op.usage ?? null;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
        throw new TypeError("X402_ESCALATION_OVERRIDE_USAGE_PUT requires usage");
      }
      const overrideId = op.overrideId ?? usage.overrideId ?? null;
      if (!overrideId) throw new TypeError("X402_ESCALATION_OVERRIDE_USAGE_PUT requires overrideId");
      if (!(store.x402EscalationOverrideUsage instanceof Map)) store.x402EscalationOverrideUsage = new Map();
      const key = makeScopedKey({ tenantId, id: String(overrideId) });
      store.x402EscalationOverrideUsage.set(key, {
        ...usage,
        tenantId,
        overrideId: String(overrideId)
      });
      continue;
    }

    if (kind === "X402_WEBHOOK_ENDPOINT_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const endpoint = op.endpoint ?? null;
      if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
        throw new TypeError("X402_WEBHOOK_ENDPOINT_UPSERT requires endpoint");
      }
      const endpointId = endpoint.endpointId ?? op.endpointId ?? null;
      if (!endpointId) throw new TypeError("X402_WEBHOOK_ENDPOINT_UPSERT requires endpoint.endpointId");
      if (!(store.x402WebhookEndpoints instanceof Map)) store.x402WebhookEndpoints = new Map();
      const key = makeScopedKey({ tenantId, id: String(endpointId) });
      store.x402WebhookEndpoints.set(key, {
        ...endpoint,
        tenantId,
        endpointId: String(endpointId)
      });
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

    if (kind === "GOVERNANCE_TEMPLATE_UPSERT") {
      const tenantId = normalizeTenantId(op.tenantId ?? DEFAULT_TENANT_ID);
      const template = op.template ?? null;
      if (!template || typeof template !== "object" || Array.isArray(template)) {
        throw new TypeError("GOVERNANCE_TEMPLATE_UPSERT requires template");
      }
      const templateId = typeof template.templateId === "string" && template.templateId.trim() !== "" ? template.templateId.trim() : null;
      const templateVersion = Number(template.templateVersion);
      if (!templateId) throw new TypeError("GOVERNANCE_TEMPLATE_UPSERT requires template.templateId");
      if (!Number.isSafeInteger(templateVersion) || templateVersion <= 0) {
        throw new TypeError("GOVERNANCE_TEMPLATE_UPSERT requires template.templateVersion >= 1");
      }
      const status = typeof template.status === "string" ? template.status.trim().toLowerCase() : "active";
      if (status !== "active" && status !== "revoked") {
        throw new TypeError("GOVERNANCE_TEMPLATE_UPSERT requires template.status active|revoked");
      }
      const revokedAtRaw =
        template.revokedAt === null || template.revokedAt === undefined || String(template.revokedAt).trim() === "" ? null : String(template.revokedAt);
      const revokedByRaw =
        template.revokedBy === null || template.revokedBy === undefined || String(template.revokedBy).trim() === ""
          ? null
          : String(template.revokedBy).trim();
      const revokeReasonCodeRaw =
        template.revokeReasonCode === null || template.revokeReasonCode === undefined || String(template.revokeReasonCode).trim() === ""
          ? null
          : String(template.revokeReasonCode).trim().toUpperCase();
      if (status === "revoked") {
        if (!revokedAtRaw || !Number.isFinite(Date.parse(revokedAtRaw))) {
          throw new TypeError("GOVERNANCE_TEMPLATE_UPSERT requires template.revokedAt when template.status=revoked");
        }
        if (!revokedByRaw) {
          throw new TypeError("GOVERNANCE_TEMPLATE_UPSERT requires template.revokedBy when template.status=revoked");
        }
        if (!revokeReasonCodeRaw || !/^[A-Z][A-Z0-9_]{2,63}$/.test(revokeReasonCodeRaw)) {
          throw new TypeError("GOVERNANCE_TEMPLATE_UPSERT requires template.revokeReasonCode when template.status=revoked");
        }
      }
      if (!(store.governanceTemplates instanceof Map)) store.governanceTemplates = new Map();
      const key = makeScopedKey({ tenantId, id: `${templateId}::${templateVersion}` });
      store.governanceTemplates.set(key, {
        ...template,
        tenantId,
        templateId,
        templateVersion,
        status,
        revokedAt: status === "revoked" ? new Date(revokedAtRaw).toISOString() : null,
        revokedBy: status === "revoked" ? revokedByRaw : null,
        revokeReasonCode: status === "revoked" ? revokeReasonCodeRaw : null,
        revokeReason:
          status === "revoked" && template.revokeReason !== null && template.revokeReason !== undefined && String(template.revokeReason).trim() !== ""
            ? String(template.revokeReason).trim()
            : null
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
