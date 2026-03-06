import { parseProtocolVersion } from '../../core/protocol.js';
import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeEnum,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString,
  normalizeSafeInt,
  normalizeSha256Hex
} from '../protocol/utils.js';

export const AGENTVERSE_DISCOVERY_RECORD_SCHEMA_VERSION = 'AgentverseDiscoveryRecord.v1';

export const AGENTVERSE_DISCOVERY_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  OFFLINE: 'offline'
});

export const AGENTVERSE_DISCOVERY_REASON_CODE = Object.freeze({
  NO_MATCH: 'AGENTVERSE_DISCOVERY_NO_MATCH',
  AMBIGUOUS: 'AGENTVERSE_DISCOVERY_AMBIGUOUS',
  STALE: 'AGENTVERSE_DISCOVERY_STALE',
  FILTERED: 'AGENTVERSE_DISCOVERY_FILTERED',
  RESOLVED: 'AGENTVERSE_DISCOVERY_RESOLVED'
});

function normalizeEndpointUrl(value, name) {
  const raw = normalizeNonEmptyString(value, name, { max: 1024 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${name} must use http or https`);
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeDiscoveryScore(value, name) {
  return normalizeSafeInt(value ?? 50, name, { min: 0, max: 100 });
}

function normalizeCapabilityId(value, name) {
  return normalizeId(value, name, { min: 1, max: 200 });
}

export function computeDiscoveryRecordHashV1(recordCore) {
  assertPlainObject(recordCore, 'recordCore');
  const copy = { ...recordCore };
  delete copy.recordHash;
  return canonicalHash(copy, { path: '$.discoveryRecord' });
}

export function buildDiscoveryRecordV1({
  tenantId,
  agentId,
  capabilityId,
  endpoint,
  protocol = '1.0',
  trustScore = 50,
  freshnessScore = 50,
  status = AGENTVERSE_DISCOVERY_STATUS.ACTIVE,
  lastSeenAt,
  expiresAt = null,
  metadata = null
} = {}) {
  if (!lastSeenAt) throw new TypeError('lastSeenAt is required to keep discovery records deterministic');

  const normalizedProtocol = parseProtocolVersion(protocol).raw;
  const normalizedLastSeenAt = normalizeIsoDateTime(lastSeenAt, 'lastSeenAt');
  const normalizedExpiresAt = normalizeIsoDateTime(expiresAt, 'expiresAt', { allowNull: true });

  const core = canonicalize(
    {
      schemaVersion: AGENTVERSE_DISCOVERY_RECORD_SCHEMA_VERSION,
      tenantId: normalizeId(tenantId ?? 'tenant_default', 'tenantId', { min: 1, max: 128 }),
      agentId: normalizeId(agentId, 'agentId', { min: 3, max: 200 }),
      capabilityId: normalizeCapabilityId(capabilityId, 'capabilityId'),
      endpoint: normalizeEndpointUrl(endpoint, 'endpoint'),
      protocol: normalizedProtocol,
      trustScore: normalizeDiscoveryScore(trustScore, 'trustScore'),
      freshnessScore: normalizeDiscoveryScore(freshnessScore, 'freshnessScore'),
      status: normalizeEnum(status, 'status', Object.values(AGENTVERSE_DISCOVERY_STATUS), {
        defaultValue: AGENTVERSE_DISCOVERY_STATUS.ACTIVE
      }),
      lastSeenAt: normalizedLastSeenAt,
      expiresAt: normalizedExpiresAt,
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? canonicalize(metadata, { path: '$.metadata' })
        : null
    },
    { path: '$.discoveryRecord' }
  );

  const recordHash = computeDiscoveryRecordHashV1(core);
  return canonicalize({ ...core, recordHash }, { path: '$.discoveryRecord' });
}

function evaluateCandidateScore(record, { asOf, capabilityId, minTrustScore }) {
  const asOfMs = Date.parse(asOf);
  const lastSeenMs = Date.parse(record.lastSeenAt);
  const expiresMs = record.expiresAt ? Date.parse(record.expiresAt) : null;

  if (!Number.isFinite(lastSeenMs)) {
    return { include: false, reasonCode: AGENTVERSE_DISCOVERY_REASON_CODE.STALE, score: -1 };
  }
  if (Number.isFinite(asOfMs) && Number.isFinite(expiresMs) && asOfMs > expiresMs) {
    return { include: false, reasonCode: AGENTVERSE_DISCOVERY_REASON_CODE.STALE, score: -1 };
  }
  if (record.status !== AGENTVERSE_DISCOVERY_STATUS.ACTIVE) {
    return { include: false, reasonCode: AGENTVERSE_DISCOVERY_REASON_CODE.FILTERED, score: -1 };
  }
  if (record.trustScore < minTrustScore) {
    return { include: false, reasonCode: AGENTVERSE_DISCOVERY_REASON_CODE.FILTERED, score: -1 };
  }
  if (capabilityId && record.capabilityId !== capabilityId) {
    return { include: false, reasonCode: AGENTVERSE_DISCOVERY_REASON_CODE.FILTERED, score: -1 };
  }

  const ageHours = Number.isFinite(asOfMs) ? Math.max(0, Math.floor((asOfMs - lastSeenMs) / (60 * 60 * 1000))) : 0;
  const freshnessPenalty = Math.min(40, ageHours);
  const score = record.trustScore * 10 + record.freshnessScore * 5 - freshnessPenalty;
  return { include: true, reasonCode: AGENTVERSE_DISCOVERY_REASON_CODE.RESOLVED, score };
}

export function rankDiscoveryRecordsV1({
  records = [],
  capabilityId = null,
  minTrustScore = 0,
  asOf = new Date(0).toISOString()
} = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const normalizedAsOf = normalizeIsoDateTime(asOf, 'asOf');
  const normalizedCapabilityId = capabilityId === null || capabilityId === undefined
    ? null
    : normalizeCapabilityId(capabilityId, 'capabilityId');
  const normalizedMinTrust = normalizeDiscoveryScore(minTrustScore, 'minTrustScore');

  const ranked = [];
  for (let i = 0; i < records.length; i += 1) {
    const row = records[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    let normalized;
    try {
      normalized = buildDiscoveryRecordV1({
        ...row,
        lastSeenAt: row.lastSeenAt
      });
    } catch {
      continue;
    }
    const verdict = evaluateCandidateScore(normalized, {
      asOf: normalizedAsOf,
      capabilityId: normalizedCapabilityId,
      minTrustScore: normalizedMinTrust
    });
    if (!verdict.include) continue;
    ranked.push(
      canonicalize(
        {
          ...normalized,
          score: verdict.score
        },
        { path: `$.ranked[${i}]` }
      )
    );
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.lastSeenAt !== right.lastSeenAt) return String(right.lastSeenAt).localeCompare(String(left.lastSeenAt));
    if (left.agentId !== right.agentId) return String(left.agentId).localeCompare(String(right.agentId));
    return String(left.recordHash).localeCompare(String(right.recordHash));
  });

  return ranked;
}

export function selectDiscoveryRecordV1({
  records = [],
  capabilityId = null,
  minTrustScore = 0,
  asOf = new Date(0).toISOString()
} = {}) {
  const ranked = rankDiscoveryRecordsV1({ records, capabilityId, minTrustScore, asOf });
  if (!ranked.length) {
    return {
      ok: false,
      reasonCode: AGENTVERSE_DISCOVERY_REASON_CODE.NO_MATCH,
      selected: null,
      candidates: []
    };
  }

  const topScore = ranked[0].score;
  const topCandidates = ranked.filter((row) => row.score === topScore);

  if (topCandidates.length > 1) {
    const uniqueAgents = new Set(topCandidates.map((row) => row.agentId));
    if (uniqueAgents.size > 1) {
      return {
        ok: false,
        reasonCode: AGENTVERSE_DISCOVERY_REASON_CODE.AMBIGUOUS,
        selected: null,
        candidates: topCandidates
      };
    }
  }

  return {
    ok: true,
    reasonCode: AGENTVERSE_DISCOVERY_REASON_CODE.RESOLVED,
    selected: ranked[0],
    candidates: ranked
  };
}

export function validateDiscoveryRecordV1(record) {
  assertPlainObject(record, 'record');
  if (record.schemaVersion !== AGENTVERSE_DISCOVERY_RECORD_SCHEMA_VERSION) {
    throw new TypeError(`record.schemaVersion must be ${AGENTVERSE_DISCOVERY_RECORD_SCHEMA_VERSION}`);
  }
  normalizeId(record.tenantId, 'record.tenantId', { min: 1, max: 128 });
  normalizeId(record.agentId, 'record.agentId', { min: 3, max: 200 });
  normalizeCapabilityId(record.capabilityId, 'record.capabilityId');
  normalizeEndpointUrl(record.endpoint, 'record.endpoint');
  parseProtocolVersion(record.protocol);
  normalizeDiscoveryScore(record.trustScore, 'record.trustScore');
  normalizeDiscoveryScore(record.freshnessScore, 'record.freshnessScore');
  normalizeEnum(record.status, 'record.status', Object.values(AGENTVERSE_DISCOVERY_STATUS));
  normalizeIsoDateTime(record.lastSeenAt, 'record.lastSeenAt');
  normalizeIsoDateTime(record.expiresAt, 'record.expiresAt', { allowNull: true });
  if (record.metadata !== null && record.metadata !== undefined) {
    assertPlainObject(record.metadata, 'record.metadata');
  }

  const recordHash = normalizeSha256Hex(record.recordHash, 'record.recordHash');
  const expectedHash = computeDiscoveryRecordHashV1(record);
  if (recordHash !== expectedHash) throw new TypeError('recordHash mismatch');
  return true;
}
