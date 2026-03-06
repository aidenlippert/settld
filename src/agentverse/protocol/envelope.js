import {
  compareProtocolVersions,
  listSupportedProtocols,
  NOOTERRA_PROTOCOL_CURRENT,
  parseProtocolVersion,
  resolveProtocolPolicy
} from '../../core/protocol.js';
import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  deriveDeterministicId,
  normalizeEnum,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString,
  normalizeSafeInt,
  normalizeSha256Hex
} from './utils.js';

export const AGENTVERSE_PROTOCOL_ENVELOPE_SCHEMA_VERSION = 'AgentverseProtocolEnvelope.v1';
export const AGENTVERSE_PROTOCOL_ACK_SCHEMA_VERSION = 'AgentverseProtocolAck.v1';

export const AGENTVERSE_PROTOCOL_DIRECTION = Object.freeze({
  OUTBOUND: 'outbound',
  INBOUND: 'inbound'
});

export const AGENTVERSE_PROTOCOL_ACK_STATUS = Object.freeze({
  ACCEPTED: 'accepted',
  REJECTED: 'rejected'
});

export function computeProtocolEnvelopeHashV1(envelopeCore) {
  assertPlainObject(envelopeCore, 'envelopeCore');
  const copy = { ...envelopeCore };
  delete copy.envelopeHash;
  return canonicalHash(copy, { path: '$.protocolEnvelope' });
}

export function buildProtocolEnvelopeV1({
  protocol = NOOTERRA_PROTOCOL_CURRENT,
  messageId = null,
  sessionId = null,
  sequence = 0,
  direction = AGENTVERSE_PROTOCOL_DIRECTION.OUTBOUND,
  fromAgentId,
  toAgentId,
  type,
  payload = {},
  metadata = null,
  createdAt
} = {}) {
  if (createdAt === null || createdAt === undefined) {
    throw new TypeError('createdAt is required to keep envelope construction deterministic');
  }

  const normalizedProtocol = parseProtocolVersion(protocol).raw;
  const normalizedDirection = normalizeEnum(direction, 'direction', Object.values(AGENTVERSE_PROTOCOL_DIRECTION), {
    defaultValue: AGENTVERSE_PROTOCOL_DIRECTION.OUTBOUND
  });
  const normalizedSequence = normalizeSafeInt(sequence, 'sequence', { min: 0, max: Number.MAX_SAFE_INTEGER });
  const normalizedCreatedAt = normalizeIsoDateTime(createdAt, 'createdAt');
  const normalizedType = normalizeNonEmptyString(type, 'type', { max: 128 });
  const normalizedSessionId = normalizeOptionalString(sessionId, 'sessionId', { max: 200 });
  const normalizedPayload = canonicalize(payload ?? {}, { path: '$.payload' });
  const normalizedMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? canonicalize(metadata, { path: '$.metadata' })
    : null;

  const resolvedMessageId = messageId
    ? normalizeId(messageId, 'messageId', { min: 3, max: 240 })
    : deriveDeterministicId(
      'msg',
      {
        schemaVersion: AGENTVERSE_PROTOCOL_ENVELOPE_SCHEMA_VERSION,
        protocol: normalizedProtocol,
        sessionId: normalizedSessionId,
        sequence: normalizedSequence,
        direction: normalizedDirection,
        fromAgentId,
        toAgentId,
        type: normalizedType,
        createdAt: normalizedCreatedAt,
        payload: normalizedPayload
      },
      { path: '$.messageSeed' }
    );

  const envelopeCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_PROTOCOL_ENVELOPE_SCHEMA_VERSION,
      protocol: normalizedProtocol,
      messageId: resolvedMessageId,
      sessionId: normalizedSessionId,
      sequence: normalizedSequence,
      direction: normalizedDirection,
      fromAgentId: normalizeId(fromAgentId, 'fromAgentId', { min: 3, max: 200 }),
      toAgentId: normalizeId(toAgentId, 'toAgentId', { min: 3, max: 200 }),
      type: normalizedType,
      payload: normalizedPayload,
      metadata: normalizedMetadata,
      createdAt: normalizedCreatedAt
    },
    { path: '$.protocolEnvelope' }
  );

  const envelopeHash = computeProtocolEnvelopeHashV1(envelopeCore);
  return canonicalize({ ...envelopeCore, envelopeHash }, { path: '$.protocolEnvelope' });
}

export function validateProtocolEnvelopeV1(envelope) {
  assertPlainObject(envelope, 'envelope');
  if (envelope.schemaVersion !== AGENTVERSE_PROTOCOL_ENVELOPE_SCHEMA_VERSION) {
    throw new TypeError(`envelope.schemaVersion must be ${AGENTVERSE_PROTOCOL_ENVELOPE_SCHEMA_VERSION}`);
  }
  parseProtocolVersion(envelope.protocol);
  normalizeId(envelope.messageId, 'envelope.messageId', { min: 3, max: 240 });
  normalizeOptionalString(envelope.sessionId, 'envelope.sessionId', { max: 200 });
  normalizeSafeInt(envelope.sequence, 'envelope.sequence', { min: 0, max: Number.MAX_SAFE_INTEGER });
  normalizeEnum(envelope.direction, 'envelope.direction', Object.values(AGENTVERSE_PROTOCOL_DIRECTION));
  normalizeId(envelope.fromAgentId, 'envelope.fromAgentId', { min: 3, max: 200 });
  normalizeId(envelope.toAgentId, 'envelope.toAgentId', { min: 3, max: 200 });
  normalizeNonEmptyString(envelope.type, 'envelope.type', { max: 128 });
  canonicalize(envelope.payload ?? {}, { path: '$.payload' });
  if (envelope.metadata !== null && envelope.metadata !== undefined) {
    assertPlainObject(envelope.metadata, 'envelope.metadata');
  }
  normalizeIsoDateTime(envelope.createdAt, 'envelope.createdAt');

  const normalizedHash = normalizeSha256Hex(envelope.envelopeHash, 'envelope.envelopeHash');
  const expectedHash = computeProtocolEnvelopeHashV1(envelope);
  if (expectedHash !== normalizedHash) throw new TypeError('envelopeHash mismatch');
  return true;
}

export function computeProtocolAckHashV1(ackCore) {
  assertPlainObject(ackCore, 'ackCore');
  const copy = { ...ackCore };
  delete copy.ackHash;
  return canonicalHash(copy, { path: '$.protocolAck' });
}

export function buildProtocolAckV1({
  messageId,
  envelopeHash,
  fromAgentId,
  toAgentId,
  status = AGENTVERSE_PROTOCOL_ACK_STATUS.ACCEPTED,
  reasonCode = null,
  metadata = null,
  acknowledgedAt
} = {}) {
  if (acknowledgedAt === null || acknowledgedAt === undefined) {
    throw new TypeError('acknowledgedAt is required to keep ack construction deterministic');
  }

  const normalizedStatus = normalizeEnum(status, 'status', Object.values(AGENTVERSE_PROTOCOL_ACK_STATUS), {
    defaultValue: AGENTVERSE_PROTOCOL_ACK_STATUS.ACCEPTED
  });

  const ackCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_PROTOCOL_ACK_SCHEMA_VERSION,
      ackId: deriveDeterministicId(
        'ack',
        {
          messageId,
          envelopeHash,
          fromAgentId,
          toAgentId,
          status: normalizedStatus,
          acknowledgedAt
        },
        { path: '$.ackSeed' }
      ),
      messageId: normalizeId(messageId, 'messageId', { min: 3, max: 240 }),
      envelopeHash: normalizeSha256Hex(envelopeHash, 'envelopeHash'),
      fromAgentId: normalizeId(fromAgentId, 'fromAgentId', { min: 3, max: 200 }),
      toAgentId: normalizeId(toAgentId, 'toAgentId', { min: 3, max: 200 }),
      status: normalizedStatus,
      reasonCode: normalizeOptionalString(reasonCode, 'reasonCode', { max: 128 }),
      metadata:
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? canonicalize(metadata, { path: '$.metadata' })
          : null,
      acknowledgedAt: normalizeIsoDateTime(acknowledgedAt, 'acknowledgedAt')
    },
    { path: '$.protocolAck' }
  );

  const ackHash = computeProtocolAckHashV1(ackCore);
  return canonicalize({ ...ackCore, ackHash }, { path: '$.protocolAck' });
}

export function validateProtocolAckV1(ack) {
  assertPlainObject(ack, 'ack');
  if (ack.schemaVersion !== AGENTVERSE_PROTOCOL_ACK_SCHEMA_VERSION) {
    throw new TypeError(`ack.schemaVersion must be ${AGENTVERSE_PROTOCOL_ACK_SCHEMA_VERSION}`);
  }
  normalizeId(ack.ackId, 'ack.ackId', { min: 3, max: 240 });
  normalizeId(ack.messageId, 'ack.messageId', { min: 3, max: 240 });
  normalizeSha256Hex(ack.envelopeHash, 'ack.envelopeHash');
  normalizeId(ack.fromAgentId, 'ack.fromAgentId', { min: 3, max: 200 });
  normalizeId(ack.toAgentId, 'ack.toAgentId', { min: 3, max: 200 });
  normalizeEnum(ack.status, 'ack.status', Object.values(AGENTVERSE_PROTOCOL_ACK_STATUS));
  normalizeOptionalString(ack.reasonCode, 'ack.reasonCode', { max: 128 });
  if (ack.metadata !== null && ack.metadata !== undefined) assertPlainObject(ack.metadata, 'ack.metadata');
  normalizeIsoDateTime(ack.acknowledgedAt, 'ack.acknowledgedAt');

  const expectedHash = computeProtocolAckHashV1(ack);
  const actualHash = normalizeSha256Hex(ack.ackHash, 'ack.ackHash');
  if (expectedHash !== actualHash) throw new TypeError('ackHash mismatch');
  return true;
}

export function isProtocolVersionSupported({
  requested,
  min = NOOTERRA_PROTOCOL_CURRENT,
  max = NOOTERRA_PROTOCOL_CURRENT
} = {}) {
  const normalizedRequested = parseProtocolVersion(requested).raw;
  const supported = listSupportedProtocols({ min, max });
  return supported.includes(normalizedRequested);
}

export function resolveNegotiatedProtocol({
  requested,
  policy = resolveProtocolPolicy({ current: NOOTERRA_PROTOCOL_CURRENT })
} = {}) {
  const normalizedRequested = parseProtocolVersion(requested).raw;
  const supported = Array.isArray(policy?.supported) ? policy.supported : [];
  if (!supported.length) {
    throw new TypeError('protocol policy has no supported versions');
  }
  if (supported.includes(normalizedRequested)) return normalizedRequested;

  const lowerOrEqual = supported
    .filter((version) => compareProtocolVersions(version, normalizedRequested) <= 0)
    .sort((left, right) => compareProtocolVersions(left, right));

  if (!lowerOrEqual.length) {
    throw new TypeError(`unsupported protocol version: ${normalizedRequested}`);
  }
  return lowerOrEqual[lowerOrEqual.length - 1];
}
