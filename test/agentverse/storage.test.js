import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import {
  createDeterministicMemoryStore,
  validateMemoryStoreSnapshotV1
} from '../../src/agentverse/storage/index.js';

test('agentverse storage module implemented', async () => {
  await assertModuleImplemented('storage', ['index.js', 'memory-store.js']);
});

test('memory store put/get/snapshot works', () => {
  const store = createDeterministicMemoryStore({ now: () => '2026-03-02T00:00:00.000Z' });
  store.put({ namespace: 'n', key: 'k', value: { ok: true }, at: '2026-03-02T00:00:00.000Z' });
  const row = store.get({ namespace: 'n', key: 'k' });
  assert.equal(row.value.ok, true);

  const snap = store.snapshot({ at: '2026-03-02T00:00:01.000Z' });
  assert.equal(validateMemoryStoreSnapshotV1(snap), true);
});
