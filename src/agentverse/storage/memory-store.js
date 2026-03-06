import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString
} from '../protocol/utils.js';

export const AGENTVERSE_MEMORY_STORE_SNAPSHOT_SCHEMA_VERSION = 'AgentverseMemoryStoreSnapshot.v1';

function storeKey(namespace, key) {
  return `${namespace}\n${key}`;
}

function normalizeNamespace(namespace) {
  return normalizeId(namespace ?? 'default', 'namespace', { min: 1, max: 128 });
}

function normalizeKey(key) {
  return normalizeNonEmptyString(key, 'key', { max: 512 });
}

function normalizeTimestamp(at, clock) {
  const value = at ?? clock();
  return normalizeIsoDateTime(value, 'at');
}

function cloneValue(value) {
  return value === undefined ? null : canonicalize(value, { path: '$.value' });
}

export class DeterministicMemoryStore {
  constructor({ now = () => new Date().toISOString() } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.now = now;
    this._rows = new Map();
    this._revision = 0;
  }

  get revision() {
    return this._revision;
  }

  has({ namespace = 'default', key } = {}) {
    const ns = normalizeNamespace(namespace);
    const normalizedKey = normalizeKey(key);
    return this._rows.has(storeKey(ns, normalizedKey));
  }

  get({ namespace = 'default', key } = {}) {
    const ns = normalizeNamespace(namespace);
    const normalizedKey = normalizeKey(key);
    const row = this._rows.get(storeKey(ns, normalizedKey));
    if (!row) return null;
    return {
      namespace: row.namespace,
      key: row.key,
      value: cloneValue(row.value),
      revision: row.revision,
      updatedAt: row.updatedAt
    };
  }

  put({ namespace = 'default', key, value, at = null } = {}) {
    const ns = normalizeNamespace(namespace);
    const normalizedKey = normalizeKey(key);
    const normalizedAt = normalizeTimestamp(at, this.now);
    const normalizedValue = cloneValue(value);

    const existing = this._rows.get(storeKey(ns, normalizedKey));
    const nextRevision = existing ? existing.revision + 1 : 0;
    const row = {
      namespace: ns,
      key: normalizedKey,
      value: normalizedValue,
      revision: nextRevision,
      updatedAt: normalizedAt
    };
    this._rows.set(storeKey(ns, normalizedKey), row);
    this._revision += 1;
    return { ...row, value: cloneValue(row.value) };
  }

  delete({ namespace = 'default', key } = {}) {
    const ns = normalizeNamespace(namespace);
    const normalizedKey = normalizeKey(key);
    const removed = this._rows.delete(storeKey(ns, normalizedKey));
    if (removed) this._revision += 1;
    return removed;
  }

  compareAndSet({ namespace = 'default', key, expectedRevision, value, at = null } = {}) {
    const ns = normalizeNamespace(namespace);
    const normalizedKey = normalizeKey(key);
    const row = this._rows.get(storeKey(ns, normalizedKey));
    const currentRevision = row ? row.revision : null;
    if (currentRevision !== expectedRevision) {
      return {
        ok: false,
        currentRevision
      };
    }
    const updated = this.put({ namespace: ns, key: normalizedKey, value, at });
    return {
      ok: true,
      row: updated
    };
  }

  list({ namespace = null, prefix = null } = {}) {
    const normalizedNamespace = namespace === null || namespace === undefined ? null : normalizeNamespace(namespace);
    const normalizedPrefix = normalizeOptionalString(prefix, 'prefix', { max: 512 });

    const out = [];
    for (const row of this._rows.values()) {
      if (normalizedNamespace && row.namespace !== normalizedNamespace) continue;
      if (normalizedPrefix && !row.key.startsWith(normalizedPrefix)) continue;
      out.push({
        namespace: row.namespace,
        key: row.key,
        value: cloneValue(row.value),
        revision: row.revision,
        updatedAt: row.updatedAt
      });
    }

    out.sort((left, right) => {
      if (left.namespace !== right.namespace) return left.namespace.localeCompare(right.namespace);
      return left.key.localeCompare(right.key);
    });

    return out;
  }

  snapshot({ at = null } = {}) {
    const generatedAt = normalizeTimestamp(at, this.now);
    const rows = this.list({});
    const snapshotCore = canonicalize(
      {
        schemaVersion: AGENTVERSE_MEMORY_STORE_SNAPSHOT_SCHEMA_VERSION,
        generatedAt,
        storeRevision: this._revision,
        rowCount: rows.length,
        rows
      },
      { path: '$.memoryStoreSnapshot' }
    );

    const snapshotHash = canonicalHash(snapshotCore, { path: '$.memoryStoreSnapshot' });
    return canonicalize({ ...snapshotCore, snapshotHash }, { path: '$.memoryStoreSnapshot' });
  }
}

export function createDeterministicMemoryStore(options = {}) {
  return new DeterministicMemoryStore(options);
}

export function validateMemoryStoreSnapshotV1(snapshot) {
  assertPlainObject(snapshot, 'snapshot');
  if (snapshot.schemaVersion !== AGENTVERSE_MEMORY_STORE_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError(`snapshot.schemaVersion must be ${AGENTVERSE_MEMORY_STORE_SNAPSHOT_SCHEMA_VERSION}`);
  }
  normalizeIsoDateTime(snapshot.generatedAt, 'snapshot.generatedAt');
  if (!Number.isSafeInteger(snapshot.storeRevision) || snapshot.storeRevision < 0) {
    throw new TypeError('snapshot.storeRevision must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(snapshot.rowCount) || snapshot.rowCount < 0) {
    throw new TypeError('snapshot.rowCount must be a non-negative safe integer');
  }
  if (!Array.isArray(snapshot.rows)) throw new TypeError('snapshot.rows must be an array');
  for (let i = 0; i < snapshot.rows.length; i += 1) {
    const row = snapshot.rows[i];
    assertPlainObject(row, `snapshot.rows[${i}]`);
    normalizeNamespace(row.namespace);
    normalizeKey(row.key);
    if (!Number.isSafeInteger(row.revision) || row.revision < 0) {
      throw new TypeError(`snapshot.rows[${i}].revision must be a non-negative safe integer`);
    }
    normalizeIsoDateTime(row.updatedAt, `snapshot.rows[${i}].updatedAt`);
  }
  const expectedHash = canonicalHash(
    {
      ...snapshot,
      snapshotHash: undefined
    },
    { path: '$.memoryStoreSnapshot' }
  );
  if (snapshot.snapshotHash !== expectedHash) throw new TypeError('snapshotHash mismatch');
  return true;
}
