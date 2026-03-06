import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { scaffoldAgentProject } from '../../src/agentverse/scaffold/init.js';

test('scaffoldAgentProject creates expected files', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'nooterra-scaffold-'));
  const target = path.join(base, 'demo-agent');

  const out = await scaffoldAgentProject({
    name: 'Demo Agent',
    capability: 'code_review',
    description: 'demo',
    dir: target
  });

  assert.equal(out.dir, target);

  await access(path.join(target, 'agent.js'));
  await access(path.join(target, 'policy.yaml'));
  await access(path.join(target, 'nooterra.json'));
  await access(path.join(target, 'test', 'agent.test.js'));

  const cfgRaw = await readFile(path.join(target, 'nooterra.json'), 'utf8');
  const cfg = JSON.parse(cfgRaw);
  assert.equal(cfg.schemaVersion, 'NooterraAgentProject.v1');
  assert.ok(cfg.agentId);
});
