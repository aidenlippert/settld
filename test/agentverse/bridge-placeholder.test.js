import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import { createBridgeApis } from '../../src/agentverse/bridge/index.js';

test('agentverse bridge module implemented', async () => {
  await assertModuleImplemented('bridge', [
    'index.js',
    'api-client.js',
    'api-registry.js',
    'api-marketplace.js',
    'api-router.js',
    'api-evidence.js',
    'api-reputation.js',
    'api-sessions.js',
    'api-wallet.js',
    'api-policy.js'
  ]);
});

test('bridge APIs expose expected methods', () => {
  const apis = createBridgeApis({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{}'; } })
  });

  assert.equal(typeof apis.registry.discoverAgentCards, 'function');
  assert.equal(typeof apis.marketplace.listRfqs, 'function');
  assert.equal(typeof apis.marketplace.submitBid, 'function');
  assert.equal(typeof apis.marketplace.acceptBid, 'function');
  assert.equal(typeof apis.router.plan, 'function');
  assert.equal(typeof apis.router.launch, 'function');
  assert.equal(typeof apis.router.dispatch, 'function');
  assert.equal(typeof apis.evidence.listStateCheckpoints, 'function');
  assert.equal(typeof apis.reputation.getPublicSummary, 'function');
  assert.equal(typeof apis.sessions.streamEvents, 'function');
  assert.equal(typeof apis.wallet.getAgentWallet, 'function');
  assert.equal(typeof apis.policy.listMarketplaceSettlementPolicies, 'function');
});
