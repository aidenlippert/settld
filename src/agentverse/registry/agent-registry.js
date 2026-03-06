import {
  AGENTVERSE_DISCOVERY_STATUS,
  buildDiscoveryRecordV1
} from '../discovery/index.js';
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
  normalizeSha256Hex,
  normalizeStringList
} from '../protocol/utils.js';

export const AGENTVERSE_REGISTRY_AGENT_SCHEMA_VERSION = 'AgentverseRegistryAgent.v1';

export const AGENTVERSE_REGISTRY_STATUS = Object.freeze({
  PROVISIONED: 'provisioned',
  ACTIVE: 'active',
  PAUSED: 'paused',
  THROTTLED: 'throttled',
  OFFLINE: 'offline',
  DECOMMISSIONED: 'decommissioned'
});

const ACTIVE_LIKE_STATUSES = new Set([
  AGENTVERSE_REGISTRY_STATUS.PROVISIONED,
  AGENTVERSE_REGISTRY_STATUS.ACTIVE,
  AGENTVERSE_REGISTRY_STATUS.PAUSED,
  AGENTVERSE_REGISTRY_STATUS.THROTTLED,
  AGENTVERSE_REGISTRY_STATUS.OFFLINE
]);

function normalizeEndpoint(value, name) {
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

function normalizeVersion(value, name = 'version') {
  const out = normalizeNonEmptyString(value ?? '1.0.0', name, { max: 64 });
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(out)) {
    throw new TypeError(`${name} is invalid`);
  }
  return out;
}

function toDiscoveryStatus(status) {
  if (status === AGENTVERSE_REGISTRY_STATUS.ACTIVE || status === AGENTVERSE_REGISTRY_STATUS.PROVISIONED) {
    return AGENTVERSE_DISCOVERY_STATUS.ACTIVE;
  }
  if (status === AGENTVERSE_REGISTRY_STATUS.OFFLINE || status === AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED) {
    return AGENTVERSE_DISCOVERY_STATUS.OFFLINE;
  }
  return AGENTVERSE_DISCOVERY_STATUS.PAUSED;
}

function computeFreshnessScore({ asOf, lastHeartbeatAt, heartbeatTtlSec }) {
  const asOfMs = Date.parse(asOf);
  const lastHeartbeatMs = Date.parse(lastHeartbeatAt);
  const ttlSec = Number(heartbeatTtlSec);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(lastHeartbeatMs) || !Number.isFinite(ttlSec) || ttlSec <= 0) {
    return 0;
  }
  const ageSec = Math.max(0, Math.floor((asOfMs - lastHeartbeatMs) / 1000));
  if (ageSec >= ttlSec) return 0;
  const remaining = ttlSec - ageSec;
  return Math.max(0, Math.min(100, Math.round((remaining / ttlSec) * 100)));
}

export function computeRegistryAgentHashV1(agentCore) {
  assertPlainObject(agentCore, 'agentCore');
  const copy = { ...agentCore };
  delete copy.agentHash;
  return canonicalHash(copy, { path: '$.registryAgent' });
}

export function buildRegistryAgentV1({
  tenantId = 'tenant_default',
  agentId,
  displayName,
  endpoint,
  protocol = '1.0',
  version = '1.0.0',
  capabilities = [],
  tags = [],
  status = AGENTVERSE_REGISTRY_STATUS.PROVISIONED,
  trustScore = 50,
  heartbeatTtlSec = 120,
  registeredAt,
  lastHeartbeatAt = null,
  updatedAt = null,
  metadata = null
} = {}) {
  if (!registeredAt) throw new TypeError('registeredAt is required to keep registry records deterministic');
  const normalizedRegisteredAt = normalizeIsoDateTime(registeredAt, 'registeredAt');
  const normalizedLastHeartbeatAt = normalizeIsoDateTime(lastHeartbeatAt ?? normalizedRegisteredAt, 'lastHeartbeatAt');
  const normalizedUpdatedAt = normalizeIsoDateTime(updatedAt ?? normalizedLastHeartbeatAt, 'updatedAt');

  const core = canonicalize(
    {
      schemaVersion: AGENTVERSE_REGISTRY_AGENT_SCHEMA_VERSION,
      tenantId: normalizeId(tenantId, 'tenantId', { min: 1, max: 128 }),
      agentId: normalizeId(agentId, 'agentId', { min: 3, max: 200 }),
      displayName: normalizeNonEmptyString(displayName, 'displayName', { max: 200 }),
      endpoint: normalizeEndpoint(endpoint, 'endpoint'),
      protocol: normalizeNonEmptyString(protocol, 'protocol', { max: 32 }),
      version: normalizeVersion(version, 'version'),
      capabilities: normalizeStringList(capabilities, 'capabilities', {
        maxItems: 1024,
        itemMax: 200,
        pattern: /^[A-Za-z0-9:_-]+$/
      }),
      tags: normalizeStringList(tags, 'tags', {
        maxItems: 256,
        itemMax: 64,
        pattern: /^[A-Za-z0-9:_-]+$/
      }),
      status: normalizeEnum(status, 'status', Object.values(AGENTVERSE_REGISTRY_STATUS), {
        defaultValue: AGENTVERSE_REGISTRY_STATUS.PROVISIONED
      }),
      trustScore: normalizeSafeInt(trustScore, 'trustScore', { min: 0, max: 100 }),
      heartbeatTtlSec: normalizeSafeInt(heartbeatTtlSec, 'heartbeatTtlSec', { min: 5, max: 86400 }),
      registeredAt: normalizedRegisteredAt,
      lastHeartbeatAt: normalizedLastHeartbeatAt,
      updatedAt: normalizedUpdatedAt,
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? canonicalize(metadata, { path: '$.metadata' })
        : null
    },
    { path: '$.registryAgent' }
  );

  const agentHash = computeRegistryAgentHashV1(core);
  return canonicalize({ ...core, agentHash }, { path: '$.registryAgent' });
}

export function validateRegistryAgentV1(agent) {
  assertPlainObject(agent, 'agent');
  if (agent.schemaVersion !== AGENTVERSE_REGISTRY_AGENT_SCHEMA_VERSION) {
    throw new TypeError(`agent.schemaVersion must be ${AGENTVERSE_REGISTRY_AGENT_SCHEMA_VERSION}`);
  }
  normalizeId(agent.tenantId, 'agent.tenantId', { min: 1, max: 128 });
  normalizeId(agent.agentId, 'agent.agentId', { min: 3, max: 200 });
  normalizeNonEmptyString(agent.displayName, 'agent.displayName', { max: 200 });
  normalizeEndpoint(agent.endpoint, 'agent.endpoint');
  normalizeNonEmptyString(agent.protocol, 'agent.protocol', { max: 32 });
  normalizeVersion(agent.version, 'agent.version');
  normalizeStringList(agent.capabilities, 'agent.capabilities', {
    maxItems: 1024,
    itemMax: 200,
    pattern: /^[A-Za-z0-9:_-]+$/
  });
  normalizeStringList(agent.tags, 'agent.tags', {
    maxItems: 256,
    itemMax: 64,
    pattern: /^[A-Za-z0-9:_-]+$/
  });
  normalizeEnum(agent.status, 'agent.status', Object.values(AGENTVERSE_REGISTRY_STATUS));
  normalizeSafeInt(agent.trustScore, 'agent.trustScore', { min: 0, max: 100 });
  normalizeSafeInt(agent.heartbeatTtlSec, 'agent.heartbeatTtlSec', { min: 5, max: 86400 });
  normalizeIsoDateTime(agent.registeredAt, 'agent.registeredAt');
  normalizeIsoDateTime(agent.lastHeartbeatAt, 'agent.lastHeartbeatAt');
  normalizeIsoDateTime(agent.updatedAt, 'agent.updatedAt');
  normalizeSha256Hex(agent.agentHash, 'agent.agentHash');
  const expectedHash = computeRegistryAgentHashV1(agent);
  if (expectedHash !== agent.agentHash) throw new TypeError('agentHash mismatch');
  return true;
}

export class AgentRegistry {
  constructor({
    now = () => new Date().toISOString(),
    defaultHeartbeatTtlSec = 120,
    tenantId = 'tenant_default'
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.now = now;
    this.tenantId = normalizeId(tenantId, 'tenantId', { min: 1, max: 128 });
    this.defaultHeartbeatTtlSec = normalizeSafeInt(defaultHeartbeatTtlSec, 'defaultHeartbeatTtlSec', {
      min: 5,
      max: 86400
    });
    this._agents = new Map();
  }

  _requireAgent(agentId) {
    const normalizedAgentId = normalizeId(agentId, 'agentId', { min: 3, max: 200 });
    const current = this._agents.get(normalizedAgentId);
    if (!current) {
      const err = new Error(`agent not found: ${normalizedAgentId}`);
      err.code = 'AGENTVERSE_REGISTRY_AGENT_NOT_FOUND';
      throw err;
    }
    return current;
  }

  registerAgent({
    registeredAt = this.now(),
    tenantId = this.tenantId,
    heartbeatTtlSec = this.defaultHeartbeatTtlSec,
    ...rest
  } = {}) {
    const normalizedRegisteredAt = normalizeIsoDateTime(registeredAt, 'registeredAt');
    const normalizedAgentId = normalizeId(rest.agentId, 'agentId', { min: 3, max: 200 });
    const existing = this._agents.get(normalizedAgentId);
    const next = buildRegistryAgentV1({
      ...existing,
      ...rest,
      tenantId,
      agentId: normalizedAgentId,
      registeredAt: existing?.registeredAt ?? normalizedRegisteredAt,
      lastHeartbeatAt: rest.lastHeartbeatAt ?? existing?.lastHeartbeatAt ?? normalizedRegisteredAt,
      updatedAt: normalizedRegisteredAt,
      heartbeatTtlSec: rest.heartbeatTtlSec ?? existing?.heartbeatTtlSec ?? heartbeatTtlSec
    });
    this._agents.set(next.agentId, next);
    return next;
  }

  getAgent(agentId) {
    const normalizedAgentId = normalizeId(agentId, 'agentId', { min: 3, max: 200 });
    const row = this._agents.get(normalizedAgentId);
    return row ? canonicalize(row, { path: '$.registryAgent' }) : null;
  }

  listAgents({ statuses = null } = {}) {
    const allowedStatuses = statuses === null || statuses === undefined
      ? null
      : new Set(
        normalizeStringList(statuses, 'statuses', {
          maxItems: 64,
          itemMax: 64,
          pattern: /^[a-z_]+$/
        }).map((value) => normalizeEnum(value, 'status', Object.values(AGENTVERSE_REGISTRY_STATUS)))
      );

    const out = [];
    for (const row of this._agents.values()) {
      if (allowedStatuses && !allowedStatuses.has(row.status)) continue;
      out.push(canonicalize(row, { path: '$.registryAgent' }));
    }
    out.sort((left, right) => String(left.agentId).localeCompare(String(right.agentId)));
    return out;
  }

  setStatus(agentId, { status, at = this.now(), reasonCode = null } = {}) {
    const current = this._requireAgent(agentId);
    const normalizedAt = normalizeIsoDateTime(at, 'at');
    const normalizedStatus = normalizeEnum(status, 'status', Object.values(AGENTVERSE_REGISTRY_STATUS));
    const next = buildRegistryAgentV1({
      ...current,
      status: normalizedStatus,
      updatedAt: normalizedAt,
      metadata: {
        ...(current.metadata ?? {}),
        statusReasonCode: normalizeOptionalString(reasonCode, 'reasonCode', { max: 128 })
      }
    });
    this._agents.set(next.agentId, next);
    return next;
  }

  updateVersion(agentId, { version, at = this.now() } = {}) {
    const current = this._requireAgent(agentId);
    const normalizedAt = normalizeIsoDateTime(at, 'at');
    const next = buildRegistryAgentV1({
      ...current,
      version: normalizeVersion(version, 'version'),
      updatedAt: normalizedAt
    });
    this._agents.set(next.agentId, next);
    return next;
  }

  heartbeat(agentId, { at = this.now(), trustScore = null } = {}) {
    const current = this._requireAgent(agentId);
    if (!ACTIVE_LIKE_STATUSES.has(current.status)) {
      const err = new Error(`agent cannot heartbeat while status=${current.status}`);
      err.code = 'AGENTVERSE_REGISTRY_HEARTBEAT_STATUS_INVALID';
      throw err;
    }
    const normalizedAt = normalizeIsoDateTime(at, 'at');
    const nextStatus = current.status === AGENTVERSE_REGISTRY_STATUS.PROVISIONED
      ? AGENTVERSE_REGISTRY_STATUS.ACTIVE
      : current.status === AGENTVERSE_REGISTRY_STATUS.OFFLINE
        ? AGENTVERSE_REGISTRY_STATUS.ACTIVE
        : current.status;

    const next = buildRegistryAgentV1({
      ...current,
      status: nextStatus,
      trustScore: trustScore === null || trustScore === undefined ? current.trustScore : trustScore,
      lastHeartbeatAt: normalizedAt,
      updatedAt: normalizedAt
    });
    this._agents.set(next.agentId, next);
    return next;
  }

  deregisterAgent(agentId, { at = this.now(), reasonCode = 'AGENTVERSE_REGISTRY_DEREGISTERED' } = {}) {
    return this.setStatus(agentId, {
      status: AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED,
      at,
      reasonCode
    });
  }

  toDiscoveryRecords({ asOf = this.now() } = {}) {
    const normalizedAsOf = normalizeIsoDateTime(asOf, 'asOf');
    const records = [];
    for (const agent of this._agents.values()) {
      if (agent.status === AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED) continue;
      for (const capabilityId of agent.capabilities) {
        records.push(
          buildDiscoveryRecordV1({
            tenantId: agent.tenantId,
            agentId: agent.agentId,
            capabilityId,
            endpoint: agent.endpoint,
            protocol: agent.protocol,
            trustScore: agent.trustScore,
            freshnessScore: computeFreshnessScore({
              asOf: normalizedAsOf,
              lastHeartbeatAt: agent.lastHeartbeatAt,
              heartbeatTtlSec: agent.heartbeatTtlSec
            }),
            status: toDiscoveryStatus(agent.status),
            lastSeenAt: agent.lastHeartbeatAt,
            expiresAt: new Date(Date.parse(agent.lastHeartbeatAt) + (agent.heartbeatTtlSec * 1000)).toISOString(),
            metadata: {
              registryStatus: agent.status,
              agentVersion: agent.version
            }
          })
        );
      }
    }
    records.sort((left, right) => String(left.recordHash).localeCompare(String(right.recordHash)));
    return records;
  }
}
