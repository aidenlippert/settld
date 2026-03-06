import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import * as federation from '../../src/agentverse/federation/index.js';

test('agentverse federation module implemented', async () => {
  await assertModuleImplemented('federation', ['index.js', 'policy.js']);
});

test('federation exports key APIs', () => {
  assert.equal(typeof federation.buildFederationEnvelopeV1, 'function');
  assert.equal(typeof federation.validateFederationEnvelopeV1, 'function');
  assert.equal(typeof federation.resolveFederationRouteV1, 'function');
});
