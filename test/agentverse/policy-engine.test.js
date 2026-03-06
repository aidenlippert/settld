import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PolicyEngine } from '../../src/agentverse/policy/engine.js';

test('PolicyEngine evaluate allow/deny with operators', () => {
  const engine = new PolicyEngine({
    defaults: { action: 'deny' },
    rules: [
      { name: 'allow_small', when: { amountUsdCents: { lte: 500 } }, then: 'allow' },
      { name: 'block_big', when: { amountUsdCents: { gt: 500 } }, then: 'deny', reason: 'too high' }
    ]
  });

  const a = engine.evaluate({ amountUsdCents: 100 });
  assert.equal(a.allowed, true);
  assert.equal(a.action, 'allow');

  const b = engine.evaluate({ amountUsdCents: 999 });
  assert.equal(b.allowed, false);
  assert.equal(b.action, 'deny');
});

test('PolicyEngine parses simple YAML policy file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nooterra-policy-'));
  const file = path.join(dir, 'policy.yaml');
  await writeFile(
    file,
    `version: "1"\ndefaults:\n  action: deny\nrules:\n  - name: allow-code\n    when:\n      requiredCapability: code_review\n    then: allow\n`,
    'utf8'
  );

  const engine = await PolicyEngine.fromFile(file);
  const d = engine.evaluate({ requiredCapability: 'code_review' });
  assert.equal(d.allowed, true);
  assert.equal(d.action, 'allow');
});

test('PolicyEngine compatibility detects conflicts', () => {
  const a = new PolicyEngine({
    defaults: { action: 'deny' },
    rules: [{ name: 'a1', when: { requiredCapability: 'x' }, then: 'allow' }]
  });
  const b = new PolicyEngine({
    defaults: { action: 'deny' },
    rules: [{ name: 'b1', when: { requiredCapability: 'x' }, then: 'deny' }]
  });

  const comp = PolicyEngine.checkCompatibility(a, b);
  assert.equal(comp.compatible, false);
  assert.ok(comp.conflicts.length > 0);
});
