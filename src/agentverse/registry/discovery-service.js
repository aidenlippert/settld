import {
  rankDiscoveryRecordsV1,
  selectDiscoveryRecordV1
} from '../discovery/index.js';
import {
  canonicalize,
  normalizeIsoDateTime,
  normalizeSafeInt,
  normalizeStringList
} from '../protocol/utils.js';
import { AgentRegistry } from './agent-registry.js';
import { CapabilityCatalog, AGENTVERSE_CAPABILITY_STATUS } from './capability-catalog.js';
import { AgentHealthMonitor } from './health-monitor.js';

export const AGENTVERSE_DISCOVERY_QUERY_SCHEMA_VERSION = 'AgentverseDiscoveryQuery.v1';
export const AGENTVERSE_DISCOVERY_RESPONSE_SCHEMA_VERSION = 'AgentverseDiscoveryResponse.v1';

function buildDiscoveryQueryV1({
  capabilityId = null,
  toAgentId = null,
  minTrustScore = 0,
  maxResults = 25,
  asOf
} = {}) {
  if (!asOf) throw new TypeError('asOf is required to keep discovery queries deterministic');
  return canonicalize(
    {
      schemaVersion: AGENTVERSE_DISCOVERY_QUERY_SCHEMA_VERSION,
      capabilityId: capabilityId ?? null,
      toAgentId: toAgentId ?? null,
      minTrustScore: normalizeSafeInt(minTrustScore, 'minTrustScore', { min: 0, max: 100 }),
      maxResults: normalizeSafeInt(maxResults, 'maxResults', { min: 1, max: 1000 }),
      asOf: normalizeIsoDateTime(asOf, 'asOf')
    },
    { path: '$.discoveryQuery' }
  );
}

export class DiscoveryService {
  constructor({
    registry,
    capabilityCatalog = null,
    healthMonitor = null,
    now = () => new Date().toISOString()
  } = {}) {
    if (!(registry instanceof AgentRegistry)) throw new TypeError('registry must be an AgentRegistry');
    if (capabilityCatalog !== null && !(capabilityCatalog instanceof CapabilityCatalog)) {
      throw new TypeError('capabilityCatalog must be a CapabilityCatalog');
    }
    if (healthMonitor !== null && !(healthMonitor instanceof AgentHealthMonitor)) {
      throw new TypeError('healthMonitor must be an AgentHealthMonitor');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.registry = registry;
    this.capabilityCatalog = capabilityCatalog;
    this.healthMonitor = healthMonitor;
    this.now = now;
  }

  advertiseAgentCapabilities({
    agentId,
    category = 'general',
    updatedAt = this.now(),
    tags = []
  } = {}) {
    if (!this.capabilityCatalog) {
      const err = new Error('capabilityCatalog is required to advertise capabilities');
      err.code = 'AGENTVERSE_CAPABILITY_CATALOG_UNAVAILABLE';
      throw err;
    }
    const agent = this.registry.getAgent(agentId);
    if (!agent) {
      const err = new Error(`agent not found: ${agentId}`);
      err.code = 'AGENTVERSE_REGISTRY_AGENT_NOT_FOUND';
      throw err;
    }
    const normalizedTags = normalizeStringList(tags, 'tags', {
      maxItems: 128,
      itemMax: 64,
      pattern: /^[A-Za-z0-9:_-]+$/
    });
    const entries = [];
    for (const capabilityId of agent.capabilities) {
      entries.push(this.capabilityCatalog.upsertEntry({
        capabilityId,
        providerAgentId: agent.agentId,
        version: agent.version,
        category,
        tags: normalizedTags,
        status: AGENTVERSE_CAPABILITY_STATUS.AVAILABLE,
        updatedAt
      }));
    }
    return entries;
  }

  heartbeat(agentId, options = {}) {
    return this.registry.heartbeat(agentId, options);
  }

  discover({
    capabilityId = null,
    toAgentId = null,
    minTrustScore = 0,
    maxResults = 25,
    asOf = this.now()
  } = {}) {
    const query = buildDiscoveryQueryV1({
      capabilityId,
      toAgentId,
      minTrustScore,
      maxResults,
      asOf
    });

    if (this.healthMonitor) {
      // Fail-closed freshness enforcement before resolution.
      this.healthMonitor.enforceOfflineForStale({ asOf: query.asOf });
    }

    let records = this.registry.toDiscoveryRecords({ asOf: query.asOf });
    if (query.toAgentId) {
      records = records.filter((row) => row.agentId === query.toAgentId);
    }

    if (this.capabilityCatalog && query.capabilityId) {
      const allowedProviders = new Set(
        this.capabilityCatalog
          .listEntries({ capabilityId: query.capabilityId })
          .filter((entry) => entry.status === AGENTVERSE_CAPABILITY_STATUS.AVAILABLE)
          .map((entry) => entry.providerAgentId)
      );
      records = records.filter((row) => allowedProviders.has(row.agentId));
    }

    const ranked = rankDiscoveryRecordsV1({
      records,
      capabilityId: query.capabilityId,
      minTrustScore: query.minTrustScore,
      asOf: query.asOf
    }).slice(0, query.maxResults);

    const response = canonicalize(
      {
        schemaVersion: AGENTVERSE_DISCOVERY_RESPONSE_SCHEMA_VERSION,
        query,
        totalCandidates: ranked.length,
        candidates: ranked
      },
      { path: '$.discoveryResponse' }
    );
    return response;
  }

  resolveOne({
    capabilityId = null,
    toAgentId = null,
    minTrustScore = 0,
    asOf = this.now()
  } = {}) {
    const response = this.discover({
      capabilityId,
      toAgentId,
      minTrustScore,
      maxResults: 1000,
      asOf
    });
    const selected = selectDiscoveryRecordV1({
      records: response.candidates,
      capabilityId,
      minTrustScore,
      asOf: response.query.asOf
    });
    return canonicalize(
      {
        ...response,
        selected
      },
      { path: '$.discoveryResolveOneResponse' }
    );
  }
}
