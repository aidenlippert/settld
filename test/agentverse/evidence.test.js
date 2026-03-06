import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import * as evidence from '../../src/agentverse/evidence/index.js';

test('agentverse evidence module implemented', async () => {
  await assertModuleImplemented('evidence', ['index.js', 'records.js']);
});

test('evidence exports key APIs', () => {
  assert.equal(typeof evidence.buildToolCallEvidenceV1, 'function');
  assert.equal(typeof evidence.validateToolCallEvidenceV1, 'function');
  assert.equal(typeof evidence.buildEvidenceManifestV1, 'function');
  assert.equal(typeof evidence.validateEvidenceManifestV1, 'function');
});
