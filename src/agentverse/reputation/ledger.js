import {
  AGENT_REPUTATION_RISK_TIER,
  AGENT_REPUTATION_SCHEMA_VERSION,
  AGENT_REPUTATION_V2_SCHEMA_VERSION,
  AGENT_REPUTATION_WINDOW,
  computeAgentReputation,
  computeAgentReputationV2
} from '../../core/agent-reputation.js';
import {
  buildReputationEventV1,
  computeReputationEventHashV1,
  REPUTATION_EVENT_KIND,
  REPUTATION_EVENT_SCHEMA_VERSION,
  validateReputationEventV1
} from '../../core/reputation-event.js';
import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeId,
  normalizeIsoDateTime,
  normalizeSha256Hex
} from '../protocol/utils.js';

export const AGENTVERSE_REPUTATION_LEDGER_SCHEMA_VERSION = 'AgentverseReputationLedger.v1';

function normalizeReputationEventList(events) {
  if (events === null || events === undefined) return [];
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const out = [];
  for (let i = 0; i < events.length; i += 1) {
    const row = events[i];
    validateReputationEventV1(row);
    out.push(canonicalize(row, { path: `$.events[${i}]` }));
  }
  out.sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) return String(left.occurredAt).localeCompare(String(right.occurredAt));
    return String(left.eventId).localeCompare(String(right.eventId));
  });
  return out;
}

export function computeReputationLedgerHashV1(ledgerCore) {
  assertPlainObject(ledgerCore, 'ledgerCore');
  const copy = { ...ledgerCore };
  delete copy.ledgerHash;
  return canonicalHash(copy, { path: '$.reputationLedger' });
}

export function buildReputationLedgerSnapshotV1({
  tenantId,
  agentId,
  at,
  events = [],
  runs = [],
  settlements = []
} = {}) {
  if (!at) throw new TypeError('at is required to keep reputation snapshots deterministic');
  const normalizedAt = normalizeIsoDateTime(at, 'at');
  const normalizedTenantId = normalizeId(tenantId, 'tenantId', { min: 1, max: 128 });
  const normalizedAgentId = normalizeId(agentId, 'agentId', { min: 3, max: 128 });

  const normalizedEvents = normalizeReputationEventList(events);
  const eventHashes = normalizedEvents.map((row) => row.eventHash).sort((left, right) => String(left).localeCompare(String(right)));

  const reputationV1 = computeAgentReputation({
    tenantId: normalizedTenantId,
    agentId: normalizedAgentId,
    runs,
    settlements,
    at: normalizedAt
  });

  const reputationV2 = computeAgentReputationV2({
    tenantId: normalizedTenantId,
    agentId: normalizedAgentId,
    runs,
    settlements,
    at: normalizedAt,
    primaryWindow: AGENT_REPUTATION_WINDOW.THIRTY_DAYS
  });

  const ledgerCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_REPUTATION_LEDGER_SCHEMA_VERSION,
      tenantId: normalizedTenantId,
      agentId: normalizedAgentId,
      computedAt: normalizedAt,
      eventCount: normalizedEvents.length,
      eventHashes,
      reputation: {
        v1: reputationV1,
        v2: reputationV2
      }
    },
    { path: '$.reputationLedger' }
  );

  const ledgerHash = computeReputationLedgerHashV1(ledgerCore);
  return canonicalize({ ...ledgerCore, ledgerHash }, { path: '$.reputationLedger' });
}

export function validateReputationLedgerSnapshotV1(snapshot) {
  assertPlainObject(snapshot, 'snapshot');
  if (snapshot.schemaVersion !== AGENTVERSE_REPUTATION_LEDGER_SCHEMA_VERSION) {
    throw new TypeError(`snapshot.schemaVersion must be ${AGENTVERSE_REPUTATION_LEDGER_SCHEMA_VERSION}`);
  }
  normalizeId(snapshot.tenantId, 'snapshot.tenantId', { min: 1, max: 128 });
  normalizeId(snapshot.agentId, 'snapshot.agentId', { min: 3, max: 128 });
  normalizeIsoDateTime(snapshot.computedAt, 'snapshot.computedAt');

  const v1Schema = snapshot?.reputation?.v1?.schemaVersion;
  const v2Schema = snapshot?.reputation?.v2?.schemaVersion;
  if (v1Schema !== AGENT_REPUTATION_SCHEMA_VERSION) {
    throw new TypeError(`snapshot.reputation.v1.schemaVersion must be ${AGENT_REPUTATION_SCHEMA_VERSION}`);
  }
  if (v2Schema !== AGENT_REPUTATION_V2_SCHEMA_VERSION) {
    throw new TypeError(`snapshot.reputation.v2.schemaVersion must be ${AGENT_REPUTATION_V2_SCHEMA_VERSION}`);
  }

  const expectedHash = computeReputationLedgerHashV1(snapshot);
  const actualHash = normalizeSha256Hex(snapshot.ledgerHash, 'snapshot.ledgerHash');
  if (expectedHash !== actualHash) throw new TypeError('ledgerHash mismatch');
  return true;
}

export function rankAgentsByReputationV1({ ledgers = [] } = {}) {
  if (!Array.isArray(ledgers)) throw new TypeError('ledgers must be an array');
  const rows = [];
  for (let i = 0; i < ledgers.length; i += 1) {
    const row = ledgers[i];
    validateReputationLedgerSnapshotV1(row);
    rows.push(row);
  }

  rows.sort((left, right) => {
    const leftScore = Number(left?.reputation?.v2?.trustScore ?? 0);
    const rightScore = Number(right?.reputation?.v2?.trustScore ?? 0);
    if (rightScore !== leftScore) return rightScore - leftScore;

    const leftTier = String(left?.reputation?.v2?.riskTier ?? AGENT_REPUTATION_RISK_TIER.HIGH);
    const rightTier = String(right?.reputation?.v2?.riskTier ?? AGENT_REPUTATION_RISK_TIER.HIGH);
    if (leftTier !== rightTier) return leftTier.localeCompare(rightTier);

    return String(left.agentId).localeCompare(String(right.agentId));
  });

  return rows;
}

export {
  AGENT_REPUTATION_SCHEMA_VERSION,
  AGENT_REPUTATION_V2_SCHEMA_VERSION,
  AGENT_REPUTATION_WINDOW,
  AGENT_REPUTATION_RISK_TIER,
  REPUTATION_EVENT_SCHEMA_VERSION,
  REPUTATION_EVENT_KIND,
  buildReputationEventV1,
  validateReputationEventV1,
  computeReputationEventHashV1,
  computeAgentReputation,
  computeAgentReputationV2
};
