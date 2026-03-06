import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeApis } from '../../src/agentverse/bridge/index.js';

test('marketplace bridge routes RFQ and bid requests through the shared client', async () => {
  const calls = [];
  const apis = createBridgeApis({
    baseUrl: 'http://127.0.0.1:3000',
    protocol: '1.0',
    tenantId: 'tenant_default',
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url: String(url),
        method: options.method ?? 'GET',
        headers: { ...(options.headers ?? {}) },
        body: options.body ? JSON.parse(options.body) : null
      });
      return {
        ok: true,
        status: 200,
        async text() {
          return '{}';
        }
      };
    }
  });

  await apis.marketplace.listRfqs({ status: 'open', capability: 'code_review' });
  await apis.marketplace.listBids('rfq_demo_1', { bidderAgentId: 'agt_demo' });
  await apis.marketplace.submitBid(
    'rfq_demo_1',
    {
      bidderAgentId: 'agt_demo',
      amountCents: 125,
      currency: 'USD'
    },
    { idempotencyKey: 'idem_bid_demo_1' }
  );
  await apis.marketplace.acceptBid(
    'rfq_demo_1',
    {
      bidId: 'bid_demo_1',
      payerAgentId: 'agt_requester'
    },
    { idempotencyKey: 'idem_accept_demo_1' }
  );
  await apis.marketplace.autoAcceptBid(
    'rfq_demo_2',
    {
      acceptedByAgentId: 'agt_operator',
      selectionStrategy: 'lowest_amount_then_eta'
    },
    { idempotencyKey: 'idem_auto_accept_demo_1' }
  );

  assert.equal(calls.length, 5);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/marketplace\/rfqs\?/);
  assert.match(calls[0].url, /capability=code_review/);

  assert.equal(calls[1].method, 'GET');
  assert.match(calls[1].url, /\/marketplace\/rfqs\/rfq_demo_1\/bids\?/);
  assert.match(calls[1].url, /bidderAgentId=agt_demo/);

  assert.equal(calls[2].method, 'POST');
  assert.equal(calls[2].headers['x-idempotency-key'], 'idem_bid_demo_1');
  assert.deepEqual(calls[2].body, {
    bidderAgentId: 'agt_demo',
    amountCents: 125,
    currency: 'USD'
  });

  assert.equal(calls[3].method, 'POST');
  assert.equal(calls[3].headers['x-idempotency-key'], 'idem_accept_demo_1');
  assert.deepEqual(calls[3].body, {
    bidId: 'bid_demo_1',
    payerAgentId: 'agt_requester'
  });

  assert.equal(calls[4].method, 'POST');
  assert.match(calls[4].url, /\/marketplace\/rfqs\/rfq_demo_2\/auto-accept$/);
  assert.equal(calls[4].headers['x-idempotency-key'], 'idem_auto_accept_demo_1');
  assert.deepEqual(calls[4].body, {
    acceptedByAgentId: 'agt_operator',
    selectionStrategy: 'lowest_amount_then_eta'
  });
});
