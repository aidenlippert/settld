import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeEnum,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString,
  normalizeSha256Hex,
  normalizeStringList
} from '../protocol/utils.js';

export const AGENTVERSE_CAPABILITY_CATALOG_ENTRY_SCHEMA_VERSION = 'AgentverseCapabilityCatalogEntry.v1';

export const AGENTVERSE_CAPABILITY_STATUS = Object.freeze({
  AVAILABLE: 'available',
  DEPRECATED: 'deprecated',
  RETIRED: 'retired'
});

function normalizeVersion(value, name = 'version') {
  const out = normalizeNonEmptyString(value ?? '1.0.0', name, { max: 64 });
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(out)) {
    throw new TypeError(`${name} is invalid`);
  }
  return out;
}

function makeEntryKey({ capabilityId, providerAgentId, version }) {
  return `${capabilityId}\n${providerAgentId}\n${version}`;
}

export function computeCapabilityCatalogEntryHashV1(entryCore) {
  assertPlainObject(entryCore, 'entryCore');
  const copy = { ...entryCore };
  delete copy.entryHash;
  return canonicalHash(copy, { path: '$.capabilityCatalogEntry' });
}

export function buildCapabilityCatalogEntryV1({
  capabilityId,
  providerAgentId,
  version = '1.0.0',
  category = 'general',
  description = null,
  tags = [],
  status = AGENTVERSE_CAPABILITY_STATUS.AVAILABLE,
  updatedAt,
  metadata = null
} = {}) {
  if (!updatedAt) throw new TypeError('updatedAt is required to keep capability catalog entries deterministic');
  const core = canonicalize(
    {
      schemaVersion: AGENTVERSE_CAPABILITY_CATALOG_ENTRY_SCHEMA_VERSION,
      capabilityId: normalizeId(capabilityId, 'capabilityId', { min: 1, max: 200 }),
      providerAgentId: normalizeId(providerAgentId, 'providerAgentId', { min: 3, max: 200 }),
      version: normalizeVersion(version, 'version'),
      category: normalizeNonEmptyString(category, 'category', { max: 64 }),
      description: normalizeOptionalString(description, 'description', { max: 1024 }),
      tags: normalizeStringList(tags, 'tags', {
        maxItems: 128,
        itemMax: 64,
        pattern: /^[A-Za-z0-9:_-]+$/
      }),
      status: normalizeEnum(status, 'status', Object.values(AGENTVERSE_CAPABILITY_STATUS), {
        defaultValue: AGENTVERSE_CAPABILITY_STATUS.AVAILABLE
      }),
      updatedAt: normalizeIsoDateTime(updatedAt, 'updatedAt'),
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? canonicalize(metadata, { path: '$.metadata' })
        : null
    },
    { path: '$.capabilityCatalogEntry' }
  );
  const entryHash = computeCapabilityCatalogEntryHashV1(core);
  return canonicalize({ ...core, entryHash }, { path: '$.capabilityCatalogEntry' });
}

export function validateCapabilityCatalogEntryV1(entry) {
  assertPlainObject(entry, 'entry');
  if (entry.schemaVersion !== AGENTVERSE_CAPABILITY_CATALOG_ENTRY_SCHEMA_VERSION) {
    throw new TypeError(`entry.schemaVersion must be ${AGENTVERSE_CAPABILITY_CATALOG_ENTRY_SCHEMA_VERSION}`);
  }
  normalizeId(entry.capabilityId, 'entry.capabilityId', { min: 1, max: 200 });
  normalizeId(entry.providerAgentId, 'entry.providerAgentId', { min: 3, max: 200 });
  normalizeVersion(entry.version, 'entry.version');
  normalizeNonEmptyString(entry.category, 'entry.category', { max: 64 });
  normalizeOptionalString(entry.description, 'entry.description', { max: 1024 });
  normalizeStringList(entry.tags, 'entry.tags', {
    maxItems: 128,
    itemMax: 64,
    pattern: /^[A-Za-z0-9:_-]+$/
  });
  normalizeEnum(entry.status, 'entry.status', Object.values(AGENTVERSE_CAPABILITY_STATUS));
  normalizeIsoDateTime(entry.updatedAt, 'entry.updatedAt');
  normalizeSha256Hex(entry.entryHash, 'entry.entryHash');
  const expectedHash = computeCapabilityCatalogEntryHashV1(entry);
  if (entry.entryHash !== expectedHash) throw new TypeError('entryHash mismatch');
  return true;
}

export class CapabilityCatalog {
  constructor({ now = () => new Date().toISOString() } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.now = now;
    this._entries = new Map();
  }

  upsertEntry({
    updatedAt = this.now(),
    ...entry
  } = {}) {
    const normalized = buildCapabilityCatalogEntryV1({
      ...entry,
      updatedAt
    });
    const key = makeEntryKey(normalized);
    this._entries.set(key, normalized);
    return normalized;
  }

  retireEntry({
    capabilityId,
    providerAgentId,
    version = '1.0.0',
    updatedAt = this.now()
  } = {}) {
    const key = makeEntryKey({
      capabilityId: normalizeId(capabilityId, 'capabilityId', { min: 1, max: 200 }),
      providerAgentId: normalizeId(providerAgentId, 'providerAgentId', { min: 3, max: 200 }),
      version: normalizeVersion(version, 'version')
    });
    const current = this._entries.get(key);
    if (!current) {
      const err = new Error(`capability entry not found: ${capabilityId} ${providerAgentId} ${version}`);
      err.code = 'AGENTVERSE_CAPABILITY_ENTRY_NOT_FOUND';
      throw err;
    }
    const next = buildCapabilityCatalogEntryV1({
      ...current,
      status: AGENTVERSE_CAPABILITY_STATUS.RETIRED,
      updatedAt
    });
    this._entries.set(key, next);
    return next;
  }

  listEntries({
    capabilityId = null,
    providerAgentId = null,
    includeRetired = false
  } = {}) {
    const normalizedCapabilityId = capabilityId === null || capabilityId === undefined
      ? null
      : normalizeId(capabilityId, 'capabilityId', { min: 1, max: 200 });
    const normalizedProviderAgentId = providerAgentId === null || providerAgentId === undefined
      ? null
      : normalizeId(providerAgentId, 'providerAgentId', { min: 3, max: 200 });

    const out = [];
    for (const row of this._entries.values()) {
      if (normalizedCapabilityId && row.capabilityId !== normalizedCapabilityId) continue;
      if (normalizedProviderAgentId && row.providerAgentId !== normalizedProviderAgentId) continue;
      if (!includeRetired && row.status === AGENTVERSE_CAPABILITY_STATUS.RETIRED) continue;
      out.push(canonicalize(row, { path: '$.capabilityCatalogEntry' }));
    }
    out.sort((left, right) => {
      const capabilityOrder = String(left.capabilityId).localeCompare(String(right.capabilityId));
      if (capabilityOrder !== 0) return capabilityOrder;
      const providerOrder = String(left.providerAgentId).localeCompare(String(right.providerAgentId));
      if (providerOrder !== 0) return providerOrder;
      return String(left.version).localeCompare(String(right.version));
    });
    return out;
  }

  matchRequiredCapabilities({
    capabilityIds = [],
    includeDeprecated = false
  } = {}) {
    const normalizedIds = normalizeStringList(capabilityIds, 'capabilityIds', {
      maxItems: 512,
      itemMax: 200,
      pattern: /^[A-Za-z0-9:_-]+$/
    });
    const matches = {};
    const missing = [];

    for (const capabilityId of normalizedIds) {
      const entries = this.listEntries({ capabilityId })
        .filter((entry) => includeDeprecated || entry.status === AGENTVERSE_CAPABILITY_STATUS.AVAILABLE);
      if (!entries.length) {
        missing.push(capabilityId);
      } else {
        matches[capabilityId] = entries;
      }
    }

    return canonicalize(
      {
        capabilityIds: normalizedIds,
        matches,
        missing
      },
      { path: '$.capabilityCatalogMatch' }
    );
  }
}
