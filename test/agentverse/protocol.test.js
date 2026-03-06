import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import {
  AGENTVERSE_PROTOCOL_ENVELOPE_SCHEMA_VERSION,
  AGENTVERSE_PROTOCOL_ACK_SCHEMA_VERSION,
  buildProtocolEnvelopeV1,
  validateProtocolEnvelopeV1,
  buildProtocolAckV1,
  validateProtocolAckV1
} from '../../src/agentverse/protocol/index.js';

test('agentverse protocol module implemented', async () => {
  await assertModuleImplemented('protocol', ['index.js', 'envelope.js', 'utils.js']);
});

test('protocol envelope + ack are deterministic and valid', () => {
  const envelope = buildProtocolEnvelopeV1({
    protocol: '1.0',
    messageId: 'msg_test_1',
    sessionId: 'sess_test_1',
    sequence: 1,
    direction: 'outbound',
    fromAgentId: 'agt_alpha',
    toAgentId: 'agt_beta',
    type: 'session.event',
    payload: { hello: 'world' },
    createdAt: '2026-03-02T00:00:00.000Z'
  });

  assert.equal(envelope.schemaVersion, AGENTVERSE_PROTOCOL_ENVELOPE_SCHEMA_VERSION);
  assert.equal(validateProtocolEnvelopeV1(envelope), true);

  const ack = buildProtocolAckV1({
    messageId: envelope.messageId,
    envelopeHash: envelope.envelopeHash,
    fromAgentId: 'agt_beta',
    toAgentId: 'agt_alpha',
    status: 'accepted',
    acknowledgedAt: '2026-03-02T00:00:01.000Z'
  });

  assert.equal(ack.schemaVersion, AGENTVERSE_PROTOCOL_ACK_SCHEMA_VERSION);
  assert.equal(validateProtocolAckV1(ack), true);
});
