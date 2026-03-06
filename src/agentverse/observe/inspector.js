import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString,
  normalizeSafeInt
} from '../protocol/utils.js';

export const AGENTVERSE_OBSERVATION_SNAPSHOT_SCHEMA_VERSION = 'AgentverseObservationSnapshot.v1';

function normalizeObservationEvents(events) {
  if (events === null || events === undefined) return [];
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const out = [];

  for (let i = 0; i < events.length; i += 1) {
    const row = events[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;

    const event = canonicalize(
      {
        event: normalizeNonEmptyString(row.event ?? 'message', `events[${i}].event`, { max: 128 }),
        id: normalizeOptionalString(row.id, `events[${i}].id`, { max: 200 }),
        at: normalizeIsoDateTime(row.at ?? new Date(0).toISOString(), `events[${i}].at`),
        data: row.data === undefined ? null : canonicalize(row.data, { path: `$.events[${i}].data` })
      },
      { path: `$.events[${i}]` }
    );

    out.push(event);
  }

  out.sort((left, right) => {
    if (left.at !== right.at) return String(left.at).localeCompare(String(right.at));
    if (left.event !== right.event) return String(left.event).localeCompare(String(right.event));
    return String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
  return out;
}

function summarizeEvents(events) {
  const byType = {};
  for (const event of events) {
    const key = String(event.event);
    byType[key] = (byType[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(byType).sort((left, right) => left[0].localeCompare(right[0])));
}

export function computeObservationSnapshotHashV1(snapshotCore) {
  assertPlainObject(snapshotCore, 'snapshotCore');
  const copy = { ...snapshotCore };
  delete copy.snapshotHash;
  return canonicalHash(copy, { path: '$.observationSnapshot' });
}

export function buildObservationSnapshotV1({
  observerId,
  subjectId,
  capturedAt,
  events = [],
  metadata = null
} = {}) {
  if (!capturedAt) throw new TypeError('capturedAt is required to keep observation snapshots deterministic');

  const normalizedEvents = normalizeObservationEvents(events);

  const snapshotCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_OBSERVATION_SNAPSHOT_SCHEMA_VERSION,
      observerId: normalizeId(observerId, 'observerId', { min: 1, max: 200 }),
      subjectId: normalizeId(subjectId, 'subjectId', { min: 1, max: 200 }),
      capturedAt: normalizeIsoDateTime(capturedAt, 'capturedAt'),
      eventCount: normalizedEvents.length,
      eventsByType: summarizeEvents(normalizedEvents),
      events: normalizedEvents,
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? canonicalize(metadata, { path: '$.metadata' })
        : null
    },
    { path: '$.observationSnapshot' }
  );

  const snapshotHash = computeObservationSnapshotHashV1(snapshotCore);
  return canonicalize({ ...snapshotCore, snapshotHash }, { path: '$.observationSnapshot' });
}

export function validateObservationSnapshotV1(snapshot) {
  assertPlainObject(snapshot, 'snapshot');
  if (snapshot.schemaVersion !== AGENTVERSE_OBSERVATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError(`snapshot.schemaVersion must be ${AGENTVERSE_OBSERVATION_SNAPSHOT_SCHEMA_VERSION}`);
  }
  normalizeId(snapshot.observerId, 'snapshot.observerId', { min: 1, max: 200 });
  normalizeId(snapshot.subjectId, 'snapshot.subjectId', { min: 1, max: 200 });
  normalizeIsoDateTime(snapshot.capturedAt, 'snapshot.capturedAt');
  normalizeSafeInt(snapshot.eventCount, 'snapshot.eventCount', { min: 0, max: Number.MAX_SAFE_INTEGER });
  normalizeObservationEvents(snapshot.events);
  const expectedHash = computeObservationSnapshotHashV1(snapshot);
  if (snapshot.snapshotHash !== expectedHash) throw new TypeError('snapshotHash mismatch');
  return true;
}

export class ObservationBuffer {
  constructor({ capacity = 200 } = {}) {
    this.capacity = normalizeSafeInt(capacity, 'capacity', { min: 1, max: 100000 });
    this._events = [];
  }

  append(event) {
    const normalized = normalizeObservationEvents([event]);
    if (!normalized.length) return null;
    this._events.push(normalized[0]);
    if (this._events.length > this.capacity) {
      this._events = this._events.slice(this._events.length - this.capacity);
    }
    return normalized[0];
  }

  events() {
    return [...this._events];
  }

  snapshot({ observerId, subjectId, capturedAt, metadata = null } = {}) {
    return buildObservationSnapshotV1({
      observerId,
      subjectId,
      capturedAt,
      events: this._events,
      metadata
    });
  }
}
