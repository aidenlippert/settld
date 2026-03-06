import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import * as delegation from '../../src/agentverse/delegation/index.js';

test('agentverse delegation module implemented', async () => {
  await assertModuleImplemented('delegation', ['index.js', 'lineage.js']);
});

test('delegation exports key APIs', () => {
  assert.equal(typeof delegation.buildDelegationGrantV1, 'function');
  assert.equal(typeof delegation.validateDelegationGrantV1, 'function');
  assert.equal(typeof delegation.buildAgreementDelegationV1, 'function');
  assert.equal(typeof delegation.buildDelegationLineageSnapshotV1, 'function');
});
