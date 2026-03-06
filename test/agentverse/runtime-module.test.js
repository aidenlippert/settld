import test from 'node:test';
import assert from 'node:assert/strict';

import * as agentverse from '../../src/agentverse/index.js';
import { assertModuleImplemented } from './module-scaffold-helpers.js';

test('agentverse runtime module includes implementation file', async () => {
  await assertModuleImplemented('runtime', ['agent-daemon.js']);
});

test('agentverse index exports runtime APIs', () => {
  assert.equal(typeof agentverse.AgentDaemon, 'function');
});
