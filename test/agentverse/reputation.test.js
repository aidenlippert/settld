import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import * as reputation from '../../src/agentverse/reputation/index.js';

test('agentverse reputation module implemented', async () => {
  await assertModuleImplemented('reputation', ['index.js', 'ledger.js']);
});

test('reputation exports key APIs', () => {
  assert.equal(typeof reputation.buildReputationEventV1, 'function');
  assert.equal(typeof reputation.validateReputationEventV1, 'function');
  assert.equal(typeof reputation.buildReputationLedgerSnapshotV1, 'function');
  assert.equal(typeof reputation.rankAgentsByReputationV1, 'function');
});
