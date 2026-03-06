import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

function slugify(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';
}

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function scaffoldAgentProject({
  name,
  capability = 'code_review',
  description = 'Nooterra agent',
  dir = null,
  force = false
}) {
  if (!name || !String(name).trim()) {
    throw new Error('name is required');
  }

  const slug = slugify(name);
  const targetDir = path.resolve(dir ? dir : slug);

  if (await exists(targetDir)) {
    const hasConfig = await exists(path.join(targetDir, 'nooterra.json'));
    if (hasConfig && !force) {
      throw new Error(`target already looks like an agent project: ${targetDir}`);
    }
  }

  await mkdir(targetDir, { recursive: true });
  await mkdir(path.join(targetDir, 'test'), { recursive: true });

  const agentJs = `export default {
  name: ${JSON.stringify(slug)},
  capabilities: [
    { name: ${JSON.stringify(capability)}, description: ${JSON.stringify(`${capability} capability`)} }
  ],
  constraints: {
    maxSpendPerRequest: 1000,
    dataClassificationMax: 'internal'
  },
  async handle(workOrder, context) {
    const input = workOrder?.specification ?? workOrder?.input ?? {};
    context.log('processing work order');
    return {
      output: {
        ok: true,
        agent: ${JSON.stringify(slug)},
        capability: ${JSON.stringify(capability)},
        input
      },
      costUsdCents: 50,
      evidenceRefs: []
    };
  },
  async bid(rfq, context) {
    if (rfq?.capability !== ${JSON.stringify(capability)}) return null;
    context.log('preparing marketplace bid');
    return {
      amountCents: 50,
      currency: rfq?.currency ?? 'USD',
      etaSeconds: 3600,
      note: ${JSON.stringify(`${slug} can take this task`)},
      metadata: {
        source: 'agentverse-scaffold',
        capability: ${JSON.stringify(capability)}
      }
    };
  }
};
`;

  const policyYaml = `version: "1"
defaults:
  action: deny
rules:
  - name: allow-${capability}
    when:
      requiredCapability: ${capability}
    then: allow
  - name: allow-marketplace-bids-${capability}
    when:
      mode: marketplace_bid
      requiredCapability: ${capability}
    then: allow
  - name: require-approval-high-spend
    when:
      amountUsdCents:
        gt: 50000
    then: require_approval
`;

  const configJson = {
    schemaVersion: 'NooterraAgentProject.v1',
    name: slug,
    description,
    agentId: `agt_${slug.replace(/-/g, '_')}`,
    entrypoint: './agent.js',
    policyPath: './policy.yaml',
    defaults: {
      baseUrl: 'http://127.0.0.1:3000',
      protocol: '1.0',
      tenantId: 'tenant_default'
    }
  };

  const smokeTest = `import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../agent.js');

test('agent module exports handler and capabilities', () => {
  assert.ok(mod.default);
  assert.equal(typeof mod.default.handle, 'function');
  assert.ok(Array.isArray(mod.default.capabilities));
  assert.ok(mod.default.capabilities.length > 0);
});
`;

  await writeFile(path.join(targetDir, 'agent.js'), agentJs, 'utf8');
  await writeFile(path.join(targetDir, 'policy.yaml'), policyYaml, 'utf8');
  await writeFile(path.join(targetDir, 'nooterra.json'), `${JSON.stringify(configJson, null, 2)}\n`, 'utf8');
  await writeFile(path.join(targetDir, 'test', 'agent.test.js'), smokeTest, 'utf8');

  return {
    dir: targetDir,
    files: [
      'agent.js',
      'policy.yaml',
      'nooterra.json',
      'test/agent.test.js'
    ]
  };
}
