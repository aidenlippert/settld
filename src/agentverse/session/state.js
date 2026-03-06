import {
  buildSessionEventPayloadV1,
  buildSessionV1,
  computeSessionEventProvenance,
  deriveSessionPromptRiskSignals,
  SESSION_EVENT_TYPE,
  SESSION_SCHEMA_VERSION,
  SESSION_VISIBILITY,
  validateSessionEventPayloadV1,
  validateSessionV1,
  verifySessionEventProvenanceChain
} from '../../core/session-collab.js';
import {
  buildSessionTranscriptV1,
  SESSION_TRANSCRIPT_SCHEMA_VERSION,
  signSessionTranscriptV1,
  verifySessionTranscriptReplayConsistencyV1,
  verifySessionTranscriptV1
} from '../../core/session-transcript.js';
import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  deriveDeterministicId,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString,
  normalizeSha256Hex
} from '../protocol/utils.js';

export const AGENTVERSE_SESSION_EVENT_SCHEMA_VERSION = 'AgentverseSessionEvent.v1';

function normalizeActor(actor, name = 'actor') {
  if (actor === null || actor === undefined) return null;
  assertPlainObject(actor, name);
  const type = normalizeOptionalString(actor.type, `${name}.type`, { max: 64 });
  const id = normalizeOptionalString(actor.id, `${name}.id`, { max: 200 });
  if (!type && !id) return null;
  return canonicalize({ type, id }, { path: '$.actor' });
}

function normalizeEventCollection(events) {
  if (events === null || events === undefined) return [];
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  return events;
}

function normalizeSessionPayload(payload, sessionId) {
  const normalized = buildSessionEventPayloadV1({
    sessionId,
    eventType: payload.eventType,
    payload: payload.payload,
    provenance: payload.provenance,
    traceId: payload.traceId,
    at: payload.at
  });
  validateSessionEventPayloadV1(normalized);
  return normalized;
}

function eventCoreHash(core) {
  const copy = { ...core };
  delete copy.eventHash;
  return canonicalHash(copy, { path: '$.sessionEvent' });
}

export function buildAgentSessionV1({
  sessionId,
  tenantId,
  visibility = SESSION_VISIBILITY.TENANT,
  participants = [],
  policyRef = null,
  metadata = null,
  createdAt
} = {}) {
  if (!createdAt) throw new TypeError('createdAt is required to keep session creation deterministic');
  return buildSessionV1({
    sessionId,
    tenantId,
    visibility,
    participants,
    policyRef,
    metadata,
    createdAt: normalizeIsoDateTime(createdAt, 'createdAt')
  });
}

export function appendAgentSessionEventV1({
  sessionId,
  events = [],
  eventId = null,
  eventType,
  payload = null,
  provenance = null,
  traceId = null,
  actor = null,
  at
} = {}) {
  if (!at) throw new TypeError('at is required to keep event appends deterministic');
  const normalizedEvents = normalizeEventCollection(events);
  const normalizedSessionId = normalizeId(sessionId, 'sessionId', { min: 1, max: 200 });

  const normalizedPayload = normalizeSessionPayload(
    {
      eventType,
      payload,
      provenance,
      traceId,
      at: normalizeIsoDateTime(at, 'at')
    },
    normalizedSessionId
  );

  const provenanceSeedEvents = normalizedEvents.map((row) => ({
    id: row.eventId,
    payload: {
      provenance: row.provenance
    }
  }));

  const effectiveProvenance = computeSessionEventProvenance({
    events: provenanceSeedEvents,
    eventType: normalizedPayload.eventType,
    provenance: normalizedPayload.provenance
  });

  const index = normalizedEvents.length;
  const prevEventHash = index > 0 ? normalizeSha256Hex(normalizedEvents[index - 1].eventHash, `events[${index - 1}].eventHash`) : null;
  const resolvedEventId = eventId
    ? normalizeId(eventId, 'eventId', { min: 3, max: 200 })
    : deriveDeterministicId(
      'sess_evt',
      {
        sessionId: normalizedSessionId,
        index,
        eventType: normalizedPayload.eventType,
        at: normalizedPayload.at,
        traceId: normalizedPayload.traceId,
        payload: normalizedPayload.payload,
        provenance: effectiveProvenance
      },
      { path: '$.sessionEventSeed' }
    );

  const payloadHash = canonicalHash(normalizedPayload.payload ?? null, { path: '$.eventPayload' });

  const eventCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_SESSION_EVENT_SCHEMA_VERSION,
      eventId: resolvedEventId,
      sessionId: normalizedSessionId,
      eventType: normalizedPayload.eventType,
      at: normalizedPayload.at,
      traceId: normalizedPayload.traceId,
      actor: normalizeActor(actor),
      payload: normalizedPayload.payload,
      provenance: effectiveProvenance,
      payloadHash,
      prevEventHash
    },
    { path: '$.sessionEvent' }
  );

  const eventHash = eventCoreHash(eventCore);
  const event = canonicalize(
    {
      ...eventCore,
      eventHash
    },
    { path: '$.sessionEvent' }
  );

  return {
    event,
    events: [...normalizedEvents, event]
  };
}

export function validateAgentSessionEventV1(event) {
  assertPlainObject(event, 'event');
  if (event.schemaVersion !== AGENTVERSE_SESSION_EVENT_SCHEMA_VERSION) {
    throw new TypeError(`event.schemaVersion must be ${AGENTVERSE_SESSION_EVENT_SCHEMA_VERSION}`);
  }
  normalizeId(event.eventId, 'event.eventId', { min: 3, max: 200 });
  normalizeId(event.sessionId, 'event.sessionId', { min: 1, max: 200 });
  normalizeNonEmptyString(event.eventType, 'event.eventType', { max: 64 });
  normalizeIsoDateTime(event.at, 'event.at');
  normalizeOptionalString(event.traceId, 'event.traceId', { max: 200 });
  normalizeActor(event.actor, 'event.actor');
  canonicalize(event.payload ?? null, { path: '$.event.payload' });
  canonicalize(event.provenance ?? null, { path: '$.event.provenance' });
  normalizeSha256Hex(event.payloadHash, 'event.payloadHash');
  normalizeSha256Hex(event.prevEventHash, 'event.prevEventHash', { allowNull: true });
  const expectedPayloadHash = canonicalHash(event.payload ?? null, { path: '$.event.payload' });
  if (expectedPayloadHash !== event.payloadHash) throw new TypeError('payloadHash mismatch');
  const expectedEventHash = eventCoreHash(event);
  const actualEventHash = normalizeSha256Hex(event.eventHash, 'event.eventHash');
  if (expectedEventHash !== actualEventHash) throw new TypeError('eventHash mismatch');
  return true;
}

export function verifyAgentSessionEventChainV1(events = []) {
  const normalized = normalizeEventCollection(events);
  const byIndex = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const row = normalized[i];
    try {
      validateAgentSessionEventV1(row);
    } catch (err) {
      return {
        ok: false,
        error: err?.message ?? 'invalid event',
        index: i
      };
    }

    const expectedPrev = i === 0 ? null : byIndex[i - 1].eventHash;
    if (row.prevEventHash !== expectedPrev) {
      return {
        ok: false,
        error: 'prevEventHash mismatch',
        index: i
      };
    }
    byIndex.push(row);
  }

  const provenanceCheck = verifySessionEventProvenanceChain(
    normalized.map((row) => ({
      id: row.eventId,
      type: row.eventType,
      payload: {
        provenance: row.provenance
      }
    }))
  );

  if (!provenanceCheck.ok) {
    return {
      ok: false,
      error: provenanceCheck.error ?? 'provenance chain invalid'
    };
  }

  return {
    ok: true,
    headEventHash: normalized.length ? normalized[normalized.length - 1].eventHash : null,
    eventCount: normalized.length
  };
}

export function buildSessionTranscriptSnapshotV1({
  tenantId,
  session,
  events = [],
  verification = null,
  signer = null
} = {}) {
  validateSessionV1(session);
  const chainCheck = verifyAgentSessionEventChainV1(events);
  if (!chainCheck.ok) {
    throw new TypeError(`session event chain invalid: ${chainCheck.error}`);
  }

  const transcriptEvents = normalizeEventCollection(events).map((event) => ({
    id: event.eventId,
    type: event.eventType,
    at: event.at,
    chainHash: event.eventHash,
    prevChainHash: event.prevEventHash,
    payloadHash: event.payloadHash,
    actor: event.actor,
    payload: {
      traceId: event.traceId,
      provenance: event.provenance
    }
  }));

  const transcript = buildSessionTranscriptV1({
    tenantId,
    session,
    events: transcriptEvents,
    verification
  });

  if (!signer) return transcript;
  return signSessionTranscriptV1({
    transcript,
    signerKeyId: signer.signerKeyId,
    signerPrivateKeyPem: signer.signerPrivateKeyPem,
    signedAt: signer.signedAt
  });
}

export function verifySessionTranscriptSnapshotV1({
  transcript,
  replayPack = null,
  publicKeyPemByKeyId = new Map()
} = {}) {
  const signatureCheck = verifySessionTranscriptV1({
    transcript,
    publicKeyByKeyId: publicKeyPemByKeyId
  });

  if (!signatureCheck.ok) return signatureCheck;
  if (!replayPack) return signatureCheck;

  return verifySessionTranscriptReplayConsistencyV1({ transcript, replayPack });
}

export function deriveAgentSessionRiskSignalsV1({ sessionId, events = [], forcedMode = null } = {}) {
  const normalizedEvents = normalizeEventCollection(events).map((row) => ({
    id: row.eventId,
    type: row.eventType,
    chainHash: row.eventHash,
    payload: {
      provenance: row.provenance
    }
  }));
  return deriveSessionPromptRiskSignals({ sessionId, events: normalizedEvents, forcedMode });
}

export {
  SESSION_SCHEMA_VERSION,
  SESSION_EVENT_TYPE,
  SESSION_VISIBILITY,
  SESSION_TRANSCRIPT_SCHEMA_VERSION
};
