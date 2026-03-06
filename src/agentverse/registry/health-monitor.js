import {
  canonicalHash,
  canonicalize,
  normalizeEnum,
  normalizeId,
  normalizeIsoDateTime,
  normalizeSafeInt,
  normalizeSha256Hex
} from '../protocol/utils.js';
import { AgentRegistry, AGENTVERSE_REGISTRY_STATUS } from './agent-registry.js';

export const AGENTVERSE_AGENT_HEALTH_STATUS_SCHEMA_VERSION = 'AgentverseAgentHealthStatus.v1';

export const AGENTVERSE_AGENT_HEALTH_VERDICT = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  STALE: 'stale',
  DECOMMISSIONED: 'decommissioned'
});

function computeHeartbeatAgeSec({ asOf, lastHeartbeatAt }) {
  const asOfMs = Date.parse(asOf);
  const lastMs = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(lastMs)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((asOfMs - lastMs) / 1000));
}

function deriveHealthVerdict({ status, heartbeatAgeSec, heartbeatTtlSec }) {
  if (status === AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED) {
    return AGENTVERSE_AGENT_HEALTH_VERDICT.DECOMMISSIONED;
  }
  if (heartbeatAgeSec > heartbeatTtlSec) {
    return AGENTVERSE_AGENT_HEALTH_VERDICT.STALE;
  }
  if (heartbeatAgeSec > Math.floor(heartbeatTtlSec * 0.5)) {
    return AGENTVERSE_AGENT_HEALTH_VERDICT.DEGRADED;
  }
  return AGENTVERSE_AGENT_HEALTH_VERDICT.HEALTHY;
}

export function computeAgentHealthStatusHashV1(statusCore) {
  const copy = { ...statusCore };
  delete copy.healthHash;
  return canonicalHash(copy, { path: '$.agentHealthStatus' });
}

export function buildAgentHealthStatusV1({
  agent,
  asOf
} = {}) {
  if (!asOf) throw new TypeError('asOf is required to keep health checks deterministic');
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
    throw new TypeError('agent is required');
  }
  const normalizedAsOf = normalizeIsoDateTime(asOf, 'asOf');
  const heartbeatAgeSec = computeHeartbeatAgeSec({
    asOf: normalizedAsOf,
    lastHeartbeatAt: agent.lastHeartbeatAt
  });
  const heartbeatTtlSec = normalizeSafeInt(agent.heartbeatTtlSec, 'agent.heartbeatTtlSec', { min: 5, max: 86400 });
  const health = deriveHealthVerdict({
    status: agent.status,
    heartbeatAgeSec,
    heartbeatTtlSec
  });

  const core = canonicalize(
    {
      schemaVersion: AGENTVERSE_AGENT_HEALTH_STATUS_SCHEMA_VERSION,
      tenantId: normalizeId(agent.tenantId, 'agent.tenantId', { min: 1, max: 128 }),
      agentId: normalizeId(agent.agentId, 'agent.agentId', { min: 3, max: 200 }),
      registryStatus: normalizeEnum(agent.status, 'agent.status', Object.values(AGENTVERSE_REGISTRY_STATUS)),
      health,
      heartbeatAgeSec: normalizeSafeInt(heartbeatAgeSec, 'heartbeatAgeSec', { min: 0, max: Number.MAX_SAFE_INTEGER }),
      heartbeatTtlSec,
      stale: health === AGENTVERSE_AGENT_HEALTH_VERDICT.STALE,
      asOf: normalizedAsOf
    },
    { path: '$.agentHealthStatus' }
  );
  const healthHash = computeAgentHealthStatusHashV1(core);
  return canonicalize({ ...core, healthHash }, { path: '$.agentHealthStatus' });
}

export function validateAgentHealthStatusV1(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new TypeError('status must be an object');
  }
  if (status.schemaVersion !== AGENTVERSE_AGENT_HEALTH_STATUS_SCHEMA_VERSION) {
    throw new TypeError(`status.schemaVersion must be ${AGENTVERSE_AGENT_HEALTH_STATUS_SCHEMA_VERSION}`);
  }
  normalizeId(status.tenantId, 'status.tenantId', { min: 1, max: 128 });
  normalizeId(status.agentId, 'status.agentId', { min: 3, max: 200 });
  normalizeEnum(status.registryStatus, 'status.registryStatus', Object.values(AGENTVERSE_REGISTRY_STATUS));
  normalizeEnum(status.health, 'status.health', Object.values(AGENTVERSE_AGENT_HEALTH_VERDICT));
  normalizeSafeInt(status.heartbeatAgeSec, 'status.heartbeatAgeSec', { min: 0, max: Number.MAX_SAFE_INTEGER });
  normalizeSafeInt(status.heartbeatTtlSec, 'status.heartbeatTtlSec', { min: 5, max: 86400 });
  if (typeof status.stale !== 'boolean') throw new TypeError('status.stale must be boolean');
  normalizeIsoDateTime(status.asOf, 'status.asOf');
  normalizeSha256Hex(status.healthHash, 'status.healthHash');
  const expectedHash = computeAgentHealthStatusHashV1(status);
  if (expectedHash !== status.healthHash) throw new TypeError('healthHash mismatch');
  return true;
}

export class AgentHealthMonitor {
  constructor({
    registry,
    now = () => new Date().toISOString()
  } = {}) {
    if (!(registry instanceof AgentRegistry)) throw new TypeError('registry must be an AgentRegistry');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.registry = registry;
    this.now = now;
  }

  evaluateAgent(agentId, { asOf = this.now() } = {}) {
    const agent = this.registry.getAgent(agentId);
    if (!agent) {
      const err = new Error(`agent not found: ${agentId}`);
      err.code = 'AGENTVERSE_REGISTRY_AGENT_NOT_FOUND';
      throw err;
    }
    return buildAgentHealthStatusV1({
      agent,
      asOf
    });
  }

  evaluateAll({
    asOf = this.now(),
    includeDecommissioned = false
  } = {}) {
    const agents = this.registry.listAgents();
    const statuses = [];
    for (const agent of agents) {
      if (!includeDecommissioned && agent.status === AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED) continue;
      statuses.push(buildAgentHealthStatusV1({ agent, asOf }));
    }
    statuses.sort((left, right) => String(left.agentId).localeCompare(String(right.agentId)));
    return statuses;
  }

  listStale({ asOf = this.now() } = {}) {
    return this.evaluateAll({ asOf })
      .filter((status) => status.health === AGENTVERSE_AGENT_HEALTH_VERDICT.STALE);
  }

  enforceOfflineForStale({ asOf = this.now() } = {}) {
    const stale = this.listStale({ asOf });
    const updatedAgentIds = [];
    for (const row of stale) {
      if (row.registryStatus === AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED) continue;
      const current = this.registry.getAgent(row.agentId);
      if (!current || current.status === AGENTVERSE_REGISTRY_STATUS.OFFLINE) continue;
      this.registry.setStatus(row.agentId, {
        status: AGENTVERSE_REGISTRY_STATUS.OFFLINE,
        at: asOf,
        reasonCode: 'AGENTVERSE_REGISTRY_HEARTBEAT_STALE'
      });
      updatedAgentIds.push(row.agentId);
    }
    updatedAgentIds.sort((left, right) => String(left).localeCompare(String(right)));
    return canonicalize(
      {
        asOf: normalizeIsoDateTime(asOf, 'asOf'),
        staleCount: stale.length,
        updatedAgentIds
      },
      { path: '$.agentHealthEnforcement' }
    );
  }
}
