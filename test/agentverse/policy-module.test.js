import test from 'node:test';
import assert from 'node:assert/strict';

import * as agentverse from '../../src/agentverse/index.js';
import { assertModuleImplemented } from './module-scaffold-helpers.js';

test('agentverse policy module includes implementation file', async () => {
  await assertModuleImplemented('policy', ['engine.js']);
});

test('agentverse index exports policy APIs', () => {
  assert.equal(typeof agentverse.PolicyEngine, 'function');
  assert.equal(typeof agentverse.createDefaultPolicy, 'function');
});
