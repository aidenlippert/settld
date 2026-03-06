import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import {
  buildIdentityProfileV1,
  validateIdentityProfileV1,
  updateIdentityProfileStatusV1
} from '../../src/agentverse/identity/index.js';

test('agentverse identity module implemented', async () => {
  await assertModuleImplemented('identity', ['index.js', 'profile.js']);
});

test('identity profile build/validate/update works', () => {
  const profile = buildIdentityProfileV1({
    agentId: 'agt_identity_1',
    displayName: 'Identity Agent',
    createdAt: '2026-03-02T00:00:00.000Z'
  });

  assert.equal(validateIdentityProfileV1(profile), true);
  const next = updateIdentityProfileStatusV1({
    profile,
    status: 'active',
    updatedAt: '2026-03-02T00:01:00.000Z'
  });
  assert.equal(next.status, 'active');
});
