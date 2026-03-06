import {
  canonicalHash,
  canonicalize,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString
} from '../protocol/utils.js';

export const AGENTVERSE_PROJECT_TEMPLATE_SCHEMA_VERSION = 'AgentverseProjectTemplate.v1';

function slugify(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';
}

export function buildPolicyTemplateYamlV1({ capabilityId, highSpendCents = 50000 } = {}) {
  const capability = normalizeId(capabilityId, 'capabilityId', { min: 1, max: 200 });
  const spend = Number(highSpendCents);
  if (!Number.isSafeInteger(spend) || spend < 0) throw new TypeError('highSpendCents must be a non-negative safe integer');

  return [
    'version: "1"',
    'defaults:',
    '  action: deny',
    'rules:',
    `  - name: allow-${capability}`,
    '    when:',
    `      requiredCapability: ${capability}`,
    '    then: allow',
    `  - name: allow-marketplace-bids-${capability}`,
    '    when:',
    '      mode: marketplace_bid',
    `      requiredCapability: ${capability}`,
    '    then: allow',
    '  - name: require-approval-high-spend',
    '    when:',
    '      amountUsdCents:',
    `        gt: ${spend}`,
    '    then: require_approval'
  ].join('\n') + '\n';
}

export function buildAgentModuleTemplateV1({
  agentName,
  capabilityId,
  maxSpendPerRequest = 1000,
  createdAt
} = {}) {
  const slug = slugify(agentName);
  const capability = normalizeId(capabilityId, 'capabilityId', { min: 1, max: 200 });
  const spend = Number(maxSpendPerRequest);
  if (!Number.isSafeInteger(spend) || spend < 0) throw new TypeError('maxSpendPerRequest must be a non-negative safe integer');
  const at = normalizeIsoDateTime(createdAt, 'createdAt');

  return `export default {
  name: ${JSON.stringify(slug)},
  createdAt: ${JSON.stringify(at)},
  capabilities: [
    {
      capabilityId: ${JSON.stringify(capability)},
      description: ${JSON.stringify(`${capability} capability`)}
    }
  ],
  constraints: {
    maxSpendPerRequest: ${spend},
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
        source: 'agentverse-template',
        capability: ${JSON.stringify(capability)}
      }
    };
  }
};
`;
}

export function buildProjectTemplateV1({
  name,
  description = 'Nooterra agent',
  capabilityId,
  createdAt
} = {}) {
  const normalizedName = normalizeNonEmptyString(name, 'name', { max: 200 });
  const slug = slugify(normalizedName);
  const capability = normalizeId(capabilityId, 'capabilityId', { min: 1, max: 200 });
  const at = normalizeIsoDateTime(createdAt, 'createdAt');

  const config = canonicalize(
    {
      schemaVersion: 'NooterraAgentProject.v1',
      name: slug,
      description: normalizeOptionalString(description, 'description', { max: 2000 }) ?? 'Nooterra agent',
      agentId: `agt_${slug.replace(/-/g, '_')}`,
      entrypoint: './agent.js',
      policyPath: './policy.yaml',
      defaults: {
        baseUrl: 'http://127.0.0.1:3000',
        protocol: '1.0',
        tenantId: 'tenant_default'
      }
    },
    { path: '$.projectConfig' }
  );

  const files = {
    'agent.js': buildAgentModuleTemplateV1({
      agentName: slug,
      capabilityId: capability,
      createdAt: at
    }),
    'policy.yaml': buildPolicyTemplateYamlV1({ capabilityId: capability }),
    'nooterra.json': `${JSON.stringify(config, null, 2)}\n`,
    'test/agent.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "const mod = await import('../agent.js');",
      '',
      "test('agent module exports handler and capabilities', () => {",
      '  assert.ok(mod.default);',
      "  assert.equal(typeof mod.default.handle, 'function');",
      '  assert.ok(Array.isArray(mod.default.capabilities));',
      '  assert.ok(mod.default.capabilities.length > 0);',
      '});',
      ''
    ].join('\n')
  };

  const templateCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_PROJECT_TEMPLATE_SCHEMA_VERSION,
      createdAt: at,
      templateId: `tpl_${slug}`,
      files,
      config
    },
    { path: '$.projectTemplate' }
  );

  const templateHash = canonicalHash(templateCore, { path: '$.projectTemplate' });
  return canonicalize(
    {
      ...templateCore,
      templateHash
    },
    { path: '$.projectTemplate' }
  );
}
