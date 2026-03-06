import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentDaemon } from '../../src/agentverse/runtime/agent-daemon.js';

test('AgentDaemon tick processes pending work-order end-to-end', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nooterra-daemon-'));
  const handlerFile = path.join(dir, 'agent.js');
  const policyFile = path.join(dir, 'policy.yaml');

  await writeFile(
    handlerFile,
    `export default {\n  async handle(workOrder) {\n    return { output: { ok: true, workOrderId: workOrder.workOrderId }, metrics: { runtimeMs: 1 }, evidenceRefs: [] };\n  }\n};\n`,
    'utf8'
  );

  await writeFile(
    policyFile,
    `version: "1"\ndefaults:\n  action: deny\nrules:\n  - name: allow-all\n    when:\n      subAgentId: agt_demo\n    then: allow\n`,
    'utf8'
  );

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });

    if (u.includes('/work-orders?')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            workOrders: [
              {
                workOrderId: 'wo_1',
                subAgentId: 'agt_demo',
                requiredCapability: 'code_review',
                pricing: { amountCents: 100 }
              }
            ]
          });
        }
      };
    }

    if (u.endsWith('/work-orders/wo_1/accept')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ workOrder: { workOrderId: 'wo_1', status: 'accepted' } });
        }
      };
    }

    if (u.endsWith('/work-orders/wo_1/complete')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ workOrder: { workOrderId: 'wo_1', status: 'completed' } });
        }
      };
    }

    return {
      ok: false,
      status: 404,
      async text() {
        return JSON.stringify({ error: 'not found' });
      }
    };
  };

  try {
    const daemon = new AgentDaemon({
      agentId: 'agt_demo',
      baseUrl: 'http://127.0.0.1:3000',
      pollMs: 999999
    });

    await daemon.loadHandlerModule(handlerFile);
    await daemon.loadPolicyFile(policyFile);

    await daemon.tick();
    await new Promise((r) => setTimeout(r, 25));

    const accept = calls.find((c) => c.url.endsWith('/work-orders/wo_1/accept'));
    const complete = calls.find((c) => c.url.endsWith('/work-orders/wo_1/complete'));

    assert.ok(accept, 'expected accept call');
    assert.ok(complete, 'expected complete call');
    assert.equal(complete.body.status, 'success');
    assert.ok(typeof complete.body.receiptId === 'string' && complete.body.receiptId.startsWith('rcpt_'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AgentDaemon tick discovers open RFQs and submits one deterministic bid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nooterra-daemon-bid-'));
  const handlerFile = path.join(dir, 'agent.js');
  const policyFile = path.join(dir, 'policy.yaml');

  await writeFile(
    handlerFile,
    `export default {\n  capabilities: [{ name: 'code_review' }],\n  async handle() {\n    return { output: { ok: true }, metrics: {}, evidenceRefs: [] };\n  },\n  async bid(rfq) {\n    return { amountCents: 125, etaSeconds: 90, note: 'ready' };\n  }\n};\n`,
    'utf8'
  );

  await writeFile(
    policyFile,
    `version: "1"\ndefaults:\n  action: deny\nrules:\n  - name: allow-marketplace-bid\n    when:\n      mode: marketplace_bid\n      requiredCapability: code_review\n    then: allow\n`,
    'utf8'
  );

  const calls = [];
  let storedBid = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: u, method, body });

    if (u.includes('/work-orders?')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ workOrders: [] });
        }
      };
    }

    if (u.includes('/marketplace/rfqs?') && u.includes('capability=code_review')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            rfqs: [
              {
                rfqId: 'rfq_1',
                capability: 'code_review',
                currency: 'USD',
                budgetCents: 300,
                posterAgentId: 'agt_requester',
                status: 'open',
                metadata: {
                  routerLaunch: {
                    candidateAgentIds: ['agt_demo']
                  }
                }
              }
            ]
          });
        }
      };
    }

    if (u.includes('/marketplace/rfqs/rfq_1/bids?') && u.includes('bidderAgentId=agt_demo')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ bids: storedBid ? [storedBid] : [] });
        }
      };
    }

    if (u.endsWith('/marketplace/rfqs/rfq_1/bids') && method === 'POST') {
      storedBid = {
        ...body,
        rfqId: 'rfq_1',
        status: 'pending'
      };
      return {
        ok: true,
        status: 201,
        async text() {
          return JSON.stringify({ bid: storedBid });
        }
      };
    }

    return {
      ok: false,
      status: 404,
      async text() {
        return JSON.stringify({ error: 'not found' });
      }
    };
  };

  try {
    const daemon = new AgentDaemon({
      agentId: 'agt_demo',
      baseUrl: 'http://127.0.0.1:3000',
      pollMs: 999999,
      log: {
        info() {},
        warn() {},
        error() {}
      }
    });

    await daemon.loadHandlerModule(handlerFile);
    await daemon.loadPolicyFile(policyFile);

    await daemon.tick();
    await new Promise((r) => setTimeout(r, 25));
    await daemon.tick();
    await new Promise((r) => setTimeout(r, 25));

    const bidPosts = calls.filter((call) => call.url.endsWith('/marketplace/rfqs/rfq_1/bids') && call.method === 'POST');
    assert.equal(bidPosts.length, 1);
    assert.deepEqual(bidPosts[0].body, {
      bidId: 'bid_rfq_1_agt_demo',
      bidderAgentId: 'agt_demo',
      amountCents: 125,
      currency: 'USD',
      etaSeconds: 90,
      note: 'ready',
      metadata: null
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
