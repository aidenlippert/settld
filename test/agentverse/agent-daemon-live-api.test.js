import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { createApi } from '../../src/api/app.js';
import { createEd25519Keypair } from '../../src/core/crypto.js';
import { AgentDaemon } from '../../src/agentverse/runtime/agent-daemon.js';

function buildHeaders({ opsToken, idempotencyKey = null } = {}) {
  const headers = {
    accept: 'application/json',
    'x-nooterra-protocol': '1.0',
    'x-proxy-ops-token': opsToken
  };
  if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;
  return headers;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve(address);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(baseUrl, requestPath, { method = 'GET', body = null, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return {
    statusCode: response.status,
    text,
    json
  };
}

async function registerAgent(baseUrl, { agentId, capabilities, opsToken }) {
  const { publicKeyPem } = createEd25519Keypair();
  const res = await requestJson(baseUrl, '/agents/register', {
    method: 'POST',
    headers: buildHeaders({ opsToken, idempotencyKey: `agent_register_${agentId}` }),
    body: {
      agentId,
      displayName: `Agent ${agentId}`,
      owner: { ownerType: 'service', ownerId: 'svc_agentverse_test' },
      publicKeyPem,
      capabilities
    }
  });
  assert.equal(res.statusCode, 201, res.text);
}

test('AgentDaemon live API e2e: created work-order is accepted and completed', async (t) => {
  const opsToken = 'tok_ops_agentverse_live';
  const api = createApi({ opsToken });
  const server = http.createServer(api.handle);
  const addr = await listen(server);
  t.after(() => {
    server.close();
  });

  const baseUrl = `http://${addr.address}:${addr.port}`;
  const runSuffix = String(Date.now());
  const principalAgentId = `agt_live_principal_${runSuffix}`;
  const subAgentId = `agt_live_sub_${runSuffix}`;
  const workOrderId = `workord_live_${runSuffix}`;

  await registerAgent(baseUrl, {
    agentId: principalAgentId,
    capabilities: ['orchestration'],
    opsToken
  });
  await registerAgent(baseUrl, {
    agentId: subAgentId,
    capabilities: ['code.generation'],
    opsToken
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'nooterra-agent-daemon-live-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const handlerPath = path.join(tmp, 'agent.js');
  const policyPath = path.join(tmp, 'policy.yaml');

  await writeFile(
    handlerPath,
    [
      'export default {',
      '  async handle(workOrder) {',
      '    return {',
      '      output: { ok: true, workOrderId: workOrder.workOrderId },',
      '      metrics: { runtimeMs: 2 },',
      '      evidenceRefs: []',
      '    };',
      '  }',
      '};',
      ''
    ].join('\n'),
    'utf8'
  );

  await writeFile(
    policyPath,
    [
      'version: "1"',
      'defaults:',
      '  action: deny',
      'rules:',
      '  - name: allow-live-sub-agent',
      `    when:\n      subAgentId: ${subAgentId}`,
      '    then: allow',
      ''
    ].join('\n'),
    'utf8'
  );

  const daemon = new AgentDaemon({
    agentId: subAgentId,
    baseUrl,
    protocol: '1.0',
    opsToken,
    pollMs: 999_999,
    log: {
      info() {},
      warn() {},
      error() {}
    }
  });

  await daemon.loadHandlerModule(handlerPath);
  await daemon.loadPolicyFile(policyPath);

  const created = await requestJson(baseUrl, '/work-orders', {
    method: 'POST',
    headers: buildHeaders({ opsToken, idempotencyKey: `work_order_create_${workOrderId}` }),
    body: {
      workOrderId,
      principalAgentId,
      subAgentId,
      requiredCapability: 'code.generation',
      specification: {
        taskType: 'codegen',
        language: 'javascript',
        prompt: 'Implement deterministic parser'
      },
      pricing: {
        amountCents: 450,
        currency: 'USD',
        quoteId: `quote_${workOrderId}`
      },
      constraints: {
        maxDurationSeconds: 300,
        maxCostCents: 450,
        retryLimit: 1
      },
      metadata: {
        priority: 'normal'
      }
    }
  });

  assert.equal(created.statusCode, 201, created.text);
  assert.equal(created.json?.workOrder?.status, 'created');

  await daemon.tick();

  let fetched = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(25);
    fetched = await requestJson(baseUrl, `/work-orders/${encodeURIComponent(workOrderId)}`, {
      headers: buildHeaders({ opsToken })
    });
    if (fetched.statusCode === 200 && fetched.json?.workOrder?.status === 'completed') break;
  }

  assert.ok(fetched, 'expected work order fetch response');
  assert.equal(fetched.statusCode, 200, fetched?.text ?? 'missing response');
  assert.equal(fetched.json?.workOrder?.status, 'completed', fetched.text);
  assert.equal(typeof fetched.json?.workOrder?.completionReceiptId, 'string');
  assert.equal(fetched.json?.workOrder?.completionReceiptId.length > 0, true);

  await daemon.stop();
});

test('AgentDaemon live API e2e: open RFQ receives a single daemon bid', async (t) => {
  const opsToken = 'tok_ops_agentverse_live_bid';
  const api = createApi({ opsToken });
  const server = http.createServer(api.handle);
  const addr = await listen(server);
  t.after(() => {
    server.close();
  });

  const baseUrl = `http://${addr.address}:${addr.port}`;
  const runSuffix = String(Date.now());
  const posterAgentId = `agt_live_poster_${runSuffix}`;
  const bidderAgentId = `agt_live_bidder_${runSuffix}`;
  const rfqId = `rfq_live_${runSuffix}`;

  await registerAgent(baseUrl, {
    agentId: posterAgentId,
    capabilities: ['orchestration'],
    opsToken
  });
  await registerAgent(baseUrl, {
    agentId: bidderAgentId,
    capabilities: ['code_review'],
    opsToken
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'nooterra-agent-daemon-live-bid-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const handlerPath = path.join(tmp, 'agent.js');
  const policyPath = path.join(tmp, 'policy.yaml');

  await writeFile(
    handlerPath,
    [
      'export default {',
      "  capabilities: [{ name: 'code_review' }],",
      '  async handle() {',
      '    return { output: { ok: true }, metrics: {}, evidenceRefs: [] };',
      '  },',
      '  async bid(rfq) {',
      '    return {',
      "      amountCents: 240,",
      "      etaSeconds: 120,",
      "      note: 'live bidder ready'",
      '    };',
      '  }',
      '};',
      ''
    ].join('\n'),
    'utf8'
  );

  await writeFile(
    policyPath,
    [
      'version: "1"',
      'defaults:',
      '  action: deny',
      'rules:',
      '  - name: allow-live-marketplace-bid',
      '    when:',
      '      mode: marketplace_bid',
      '      requiredCapability: code_review',
      '    then: allow',
      ''
    ].join('\n'),
    'utf8'
  );

  const daemon = new AgentDaemon({
    agentId: bidderAgentId,
    baseUrl,
    protocol: '1.0',
    opsToken,
    pollMs: 999_999,
    log: {
      info() {},
      warn() {},
      error() {}
    }
  });

  await daemon.loadHandlerModule(handlerPath);
  await daemon.loadPolicyFile(policyPath);

  const created = await requestJson(baseUrl, '/marketplace/rfqs', {
    method: 'POST',
    headers: buildHeaders({ opsToken, idempotencyKey: `rfq_create_${rfqId}` }),
    body: {
      rfqId,
      title: 'Review settlement policy changes',
      capability: 'code_review',
      posterAgentId,
      budgetCents: 300,
      currency: 'USD',
      metadata: {
        routerLaunch: {
          candidateAgentIds: [bidderAgentId]
        }
      }
    }
  });

  assert.equal(created.statusCode, 201, created.text);
  assert.equal(created.json?.rfq?.status, 'open');

  await daemon.tick();
  await sleep(25);
  await daemon.tick();

  let bidsResponse = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(25);
    bidsResponse = await requestJson(baseUrl, `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids?status=all&bidderAgentId=${encodeURIComponent(bidderAgentId)}&limit=50&offset=0`, {
      headers: buildHeaders({ opsToken })
    });
    if (Array.isArray(bidsResponse.json?.bids) && bidsResponse.json.bids.length > 0) break;
  }

  assert.ok(bidsResponse, 'expected bids fetch response');
  assert.equal(bidsResponse.statusCode, 200, bidsResponse?.text ?? 'missing response');
  assert.equal(Array.isArray(bidsResponse.json?.bids), true, bidsResponse.text);
  assert.equal(bidsResponse.json.bids.length, 1, bidsResponse.text);
  assert.equal(bidsResponse.json.bids[0]?.bidderAgentId, bidderAgentId);
  assert.equal(bidsResponse.json.bids[0]?.amountCents, 240);
  assert.equal(bidsResponse.json.bids[0]?.status, 'pending');

  await daemon.stop();
});
