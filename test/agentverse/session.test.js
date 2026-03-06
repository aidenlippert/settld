import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import * as session from '../../src/agentverse/session/index.js';

test('agentverse session module implemented', async () => {
  await assertModuleImplemented('session', ['index.js', 'state.js']);
});

test('session exports key APIs', () => {
  assert.equal(typeof session.buildAgentSessionV1, 'function');
  assert.equal(typeof session.appendAgentSessionEventV1, 'function');
  assert.equal(typeof session.verifyAgentSessionEventChainV1, 'function');
  assert.equal(typeof session.buildSessionTranscriptSnapshotV1, 'function');
});
