import { buildIdentityProfileV1, validateIdentityProfileV1 } from '../identity/index.js';
import {
  buildProtocolAckV1
} from '../protocol/index.js';
import {
  appendAgentSessionEventV1,
  buildAgentSessionV1,
  buildSessionTranscriptSnapshotV1,
  deriveAgentSessionRiskSignalsV1,
  verifyAgentSessionEventChainV1
} from '../session/index.js';
import {
  buildEvidenceManifestV1,
  buildToolCallEvidenceV1,
  validateToolCallEvidenceV1
} from '../evidence/index.js';
import { AgentNetwork } from './network.js';
import { createDeterministicMemoryStore } from '../storage/index.js';
import {
  canonicalHash,
  canonicalize,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString,
  normalizeSafeInt
} from '../protocol/utils.js';

export const AGENTVERSE_RUNTIME_STATE_SCHEMA_VERSION = 'AgentverseRuntimeState.v1';

function requireStoreRow(store, { namespace, key, missingMessage }) {
  const row = store.get({ namespace, key });
  if (!row) {
    const err = new Error(missingMessage);
    err.code = 'AGENTVERSE_RUNTIME_NOT_FOUND';
    throw err;
  }
  return row;
}

export class AgentRuntime {
  constructor({
    agentId,
    tenantId = 'tenant_default',
    protocol = '1.0',
    network = null,
    store = null,
    now = () => new Date().toISOString()
  } = {}) {
    this.agentId = normalizeId(agentId, 'agentId', { min: 3, max: 200 });
    this.tenantId = normalizeId(tenantId, 'tenantId', { min: 1, max: 128 });
    this.now = typeof now === 'function' ? now : (() => new Date().toISOString());
    this.store = store && typeof store === 'object' ? store : createDeterministicMemoryStore({ now: this.now });
    this.network = network instanceof AgentNetwork
      ? network
      : new AgentNetwork({
        agentId: this.agentId,
        protocol,
        now: this.now
      });
  }

  _sessionKey(sessionId) {
    return `session:${normalizeId(sessionId, 'sessionId', { min: 1, max: 200 })}`;
  }

  _sessionEventsKey(sessionId) {
    return `sessionEvents:${normalizeId(sessionId, 'sessionId', { min: 1, max: 200 })}`;
  }

  _sessionEvidenceKey(sessionId) {
    return `sessionEvidence:${normalizeId(sessionId, 'sessionId', { min: 1, max: 200 })}`;
  }

  registerIdentity({ profile = null, createdAt = this.now(), ...fields } = {}) {
    const normalizedCreatedAt = normalizeIsoDateTime(createdAt, 'createdAt');
    const resolvedProfile = profile
      ? canonicalize(profile, { path: '$.profile' })
      : buildIdentityProfileV1({
        agentId: this.agentId,
        createdAt: normalizedCreatedAt,
        ...fields
      });

    validateIdentityProfileV1(resolvedProfile);
    this.store.put({
      namespace: 'identity',
      key: this.agentId,
      value: resolvedProfile,
      at: normalizedCreatedAt
    });
    return resolvedProfile;
  }

  getIdentity() {
    const row = this.store.get({ namespace: 'identity', key: this.agentId });
    return row?.value ?? null;
  }

  openSession({
    sessionId,
    participants = [],
    visibility,
    policyRef = null,
    metadata = null,
    createdAt = this.now()
  } = {}) {
    const normalizedCreatedAt = normalizeIsoDateTime(createdAt, 'createdAt');
    const resolvedParticipants = Array.from(new Set([this.agentId, ...(Array.isArray(participants) ? participants : [])])).sort((a, b) => String(a).localeCompare(String(b)));

    const session = buildAgentSessionV1({
      sessionId,
      tenantId: this.tenantId,
      visibility,
      participants: resolvedParticipants,
      policyRef,
      metadata,
      createdAt: normalizedCreatedAt
    });

    this.store.put({
      namespace: 'sessions',
      key: this._sessionKey(sessionId),
      value: session,
      at: normalizedCreatedAt
    });
    this.store.put({
      namespace: 'sessions',
      key: this._sessionEventsKey(sessionId),
      value: [],
      at: normalizedCreatedAt
    });
    this.store.put({
      namespace: 'sessions',
      key: this._sessionEvidenceKey(sessionId),
      value: [],
      at: normalizedCreatedAt
    });

    return session;
  }

  getSession(sessionId) {
    return requireStoreRow(this.store, {
      namespace: 'sessions',
      key: this._sessionKey(sessionId),
      missingMessage: `session not found: ${sessionId}`
    }).value;
  }

  listSessionEvents(sessionId) {
    return requireStoreRow(this.store, {
      namespace: 'sessions',
      key: this._sessionEventsKey(sessionId),
      missingMessage: `session events not found: ${sessionId}`
    }).value;
  }

  appendSessionEvent({
    sessionId,
    eventId = null,
    eventType,
    payload = null,
    provenance = null,
    traceId = null,
    actor = null,
    at = this.now()
  } = {}) {
    this.getSession(sessionId);
    const events = this.listSessionEvents(sessionId);
    const normalizedAt = normalizeIsoDateTime(at, 'at');

    const appended = appendAgentSessionEventV1({
      sessionId,
      events,
      eventId,
      eventType,
      payload,
      provenance,
      traceId,
      actor,
      at: normalizedAt
    });

    this.store.put({
      namespace: 'sessions',
      key: this._sessionEventsKey(sessionId),
      value: appended.events,
      at: normalizedAt
    });

    return appended.event;
  }

  recordToolCallEvidence({
    sessionId,
    createdAt = this.now(),
    ...evidenceInput
  } = {}) {
    const normalizedAt = normalizeIsoDateTime(createdAt, 'createdAt');
    this.getSession(sessionId);

    const evidence = buildToolCallEvidenceV1({
      ...evidenceInput,
      createdAt: normalizedAt,
      startedAt: evidenceInput.startedAt ?? normalizedAt,
      completedAt: evidenceInput.completedAt ?? normalizedAt
    });
    validateToolCallEvidenceV1(evidence);

    const row = requireStoreRow(this.store, {
      namespace: 'sessions',
      key: this._sessionEvidenceKey(sessionId),
      missingMessage: `session evidence not found: ${sessionId}`
    });

    const existing = Array.isArray(row.value) ? row.value : [];
    const next = [...existing, evidence].sort((left, right) => String(left.evidenceHash).localeCompare(String(right.evidenceHash)));

    this.store.put({
      namespace: 'sessions',
      key: this._sessionEvidenceKey(sessionId),
      value: next,
      at: normalizedAt
    });

    return evidence;
  }

  buildSessionEvidenceManifest({
    sessionId,
    generatedAt = this.now(),
    evidenceRefs = [],
    metadata = null
  } = {}) {
    this.getSession(sessionId);
    const evidenceRows = requireStoreRow(this.store, {
      namespace: 'sessions',
      key: this._sessionEvidenceKey(sessionId),
      missingMessage: `session evidence not found: ${sessionId}`
    }).value;

    return buildEvidenceManifestV1({
      tenantId: this.tenantId,
      sessionId,
      generatedAt: normalizeIsoDateTime(generatedAt, 'generatedAt'),
      evidenceRefs,
      toolCallEvidence: evidenceRows,
      metadata
    });
  }

  buildSessionTranscript({
    sessionId,
    verification = null,
    signer = null
  } = {}) {
    const session = this.getSession(sessionId);
    const events = this.listSessionEvents(sessionId);
    return buildSessionTranscriptSnapshotV1({
      tenantId: this.tenantId,
      session,
      events,
      verification,
      signer
    });
  }

  sessionRiskSignals({ sessionId, forcedMode = null } = {}) {
    const events = this.listSessionEvents(sessionId);
    return deriveAgentSessionRiskSignalsV1({
      sessionId,
      events,
      forcedMode
    });
  }

  verifySessionEventChain(sessionId) {
    const events = this.listSessionEvents(sessionId);
    return verifyAgentSessionEventChainV1(events);
  }

  async sendSessionEventEnvelope({
    sessionId,
    eventId,
    toAgentId = null,
    capabilityId = null,
    type = 'session.event',
    metadata = null,
    createdAt = this.now(),
    minTrustScore = 0
  } = {}) {
    const events = this.listSessionEvents(sessionId);
    const normalizedEventId = normalizeId(eventId, 'eventId', { min: 3, max: 200 });
    const event = events.find((row) => row.eventId === normalizedEventId);
    if (!event) {
      const err = new Error(`session event not found: ${normalizedEventId}`);
      err.code = 'AGENTVERSE_RUNTIME_EVENT_NOT_FOUND';
      throw err;
    }

    return this.network.sendEnvelope({
      toAgentId,
      capabilityId,
      type: normalizeNonEmptyString(type, 'type', { max: 128 }),
      payload: {
        tenantId: this.tenantId,
        sessionId,
        event
      },
      metadata,
      sessionId,
      createdAt: normalizeIsoDateTime(createdAt, 'createdAt'),
      minTrustScore: normalizeSafeInt(minTrustScore, 'minTrustScore', { min: 0, max: 100 })
    });
  }

  acknowledgeEnvelope({
    messageId,
    envelopeHash,
    toAgentId,
    status = 'accepted',
    reasonCode = null,
    metadata = null,
    acknowledgedAt = this.now()
  } = {}) {
    return buildProtocolAckV1({
      messageId,
      envelopeHash,
      fromAgentId: this.agentId,
      toAgentId,
      status,
      reasonCode: normalizeOptionalString(reasonCode, 'reasonCode', { max: 128 }),
      metadata,
      acknowledgedAt: normalizeIsoDateTime(acknowledgedAt, 'acknowledgedAt')
    });
  }

  snapshotState({ at = this.now() } = {}) {
    const generatedAt = normalizeIsoDateTime(at, 'at');
    const identity = this.getIdentity();
    const sessions = this.store.list({ namespace: 'sessions', prefix: 'session:' }).map((row) => row.value);
    const sessionIds = sessions.map((row) => row.sessionId).sort((left, right) => String(left).localeCompare(String(right)));

    const sessionEventCounts = Object.fromEntries(
      sessionIds.map((sessionId) => {
        const count = this.listSessionEvents(sessionId).length;
        return [sessionId, count];
      })
    );

    const runtimeCore = canonicalize(
      {
        schemaVersion: AGENTVERSE_RUNTIME_STATE_SCHEMA_VERSION,
        generatedAt,
        tenantId: this.tenantId,
        agentId: this.agentId,
        identityProfileHash: identity?.profileHash ?? null,
        sessionCount: sessionIds.length,
        sessionIds,
        sessionEventCounts,
        storeRevision: this.store.revision
      },
      { path: '$.runtimeState' }
    );

    const stateHash = canonicalHash(runtimeCore, { path: '$.runtimeState' });
    return canonicalize({ ...runtimeCore, stateHash }, { path: '$.runtimeState' });
  }
}
