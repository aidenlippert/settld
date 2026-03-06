import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { createApi } from "../../src/api/app.js";
import { createEd25519Keypair } from "../../src/core/crypto.js";
import { scaffoldAgentProject } from "../../src/agentverse/scaffold/init.js";
import { AgentDaemon } from "../../src/agentverse/runtime/agent-daemon.js";

const OPS_TOKEN = "tok_ops_agentverse_build_pipeline";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("unexpected server address"));
        return;
      }
      resolve(address);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders({ idempotencyKey = null, principalId = null } = {}) {
  const headers = {
    accept: "application/json",
    "x-nooterra-protocol": "1.0",
    "x-proxy-ops-token": OPS_TOKEN
  };
  if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
  if (principalId) headers["x-proxy-principal-id"] = principalId;
  return headers;
}

async function requestJson(baseUrl, requestPath, { method = "GET", body = null, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
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

async function registerAgent(baseUrl, { agentId, capabilities }) {
  const { publicKeyPem } = createEd25519Keypair();
  const response = await requestJson(baseUrl, "/agents/register", {
    method: "POST",
    headers: buildHeaders({ idempotencyKey: `agent_build_pipeline_register_${agentId}` }),
    body: {
      agentId,
      displayName: `Agent ${agentId}`,
      owner: { ownerType: "service", ownerId: "svc_agentverse_build_pipeline" },
      publicKeyPem,
      capabilities
    }
  });
  assert.equal(response.statusCode, 201, response.text);
}

test("agent build pipeline smoke: scaffold -> intent/work-order -> settle -> replay pack", async (t) => {
  const api = createApi({ opsToken: OPS_TOKEN, workOrderRequireIntentBinding: true });
  const server = http.createServer(api.handle);
  const addr = await listen(server);
  t.after(() => {
    server.close();
  });

  const baseUrl = `http://${addr.address}:${addr.port}`;
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const principalAgentId = `agt_pipeline_principal_${suffix}`;
  const subAgentId = `agt_pipeline_worker_${suffix}`;
  const intentId = `intent_pipeline_${suffix}`;
  const workOrderId = `workord_pipeline_${suffix}`;
  const sessionId = `sess_pipeline_${suffix}`;

  await registerAgent(baseUrl, {
    agentId: principalAgentId,
    capabilities: ["orchestration"]
  });
  await registerAgent(baseUrl, {
    agentId: subAgentId,
    capabilities: ["code.generation"]
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "nooterra-agent-build-pipeline-"));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const projectDir = path.join(tmp, "scaffold");
  const scaffold = await scaffoldAgentProject({
    name: `pipeline-${suffix}`,
    capability: "code.generation",
    description: "agent build pipeline smoke",
    dir: projectDir
  });

  const configPath = path.join(scaffold.dir, "nooterra.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.schemaVersion, "NooterraAgentProject.v1");
  assert.equal(typeof config.entrypoint, "string");
  assert.equal(typeof config.policyPath, "string");

  const handlerPath = path.join(scaffold.dir, "agent.js");
  await writeFile(
    handlerPath,
    [
      "export default {",
      "  async handle(workOrder) {",
      "    return {",
      "      output: { ok: true, workOrderId: workOrder?.workOrderId ?? null },",
      "      metrics: { runtimeMs: 3 },",
      '      evidenceRefs: ["artifact://agent-build-pipeline/output.json", "report://agent-build-pipeline/verification.json"]',
      "    };",
      "  }",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );

  const daemon = new AgentDaemon({
    agentId: subAgentId,
    baseUrl,
    protocol: "1.0",
    opsToken: OPS_TOKEN,
    pollMs: 999_999,
    log: {
      info() {},
      warn() {},
      error() {}
    }
  });

  await daemon.loadHandlerModule(handlerPath);
  await daemon.loadPolicyFile(path.join(scaffold.dir, "policy.yaml"));

  const sessionCreated = await requestJson(baseUrl, "/sessions", {
    method: "POST",
    headers: buildHeaders({
      idempotencyKey: `agent_build_pipeline_session_create_${suffix}`,
      principalId: principalAgentId
    }),
    body: {
      sessionId,
      visibility: "tenant",
      participants: [principalAgentId, subAgentId],
      policyRef: "policy://session/agent-build-pipeline"
    }
  });
  assert.equal(sessionCreated.statusCode, 201, sessionCreated.text);

  const sessionTaskRequested = await requestJson(baseUrl, `/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    headers: {
      ...buildHeaders({
        idempotencyKey: `agent_build_pipeline_session_requested_${suffix}`,
        principalId: principalAgentId
      }),
      "x-proxy-expected-prev-chain-hash": "null"
    },
    body: {
      eventType: "TASK_REQUESTED",
      traceId: `trace_pipeline_${suffix}`,
      payload: {
        workOrderId,
        requiredCapability: "code.generation"
      }
    }
  });
  assert.equal(sessionTaskRequested.statusCode, 201, sessionTaskRequested.text);

  const proposed = await requestJson(baseUrl, "/intents/propose", {
    method: "POST",
    headers: buildHeaders({ idempotencyKey: `agent_build_pipeline_intent_propose_${suffix}` }),
    body: {
      intentId,
      proposerAgentId: principalAgentId,
      counterpartyAgentId: subAgentId,
      objective: {
        type: "delegated_task",
        summary: "Build and verify deterministic parser implementation"
      },
      budgetEnvelope: { currency: "USD", maxAmountCents: 950, hardCap: true },
      successCriteria: { unitTestsPassing: true },
      terminationPolicy: { mode: "manual" }
    }
  });
  assert.equal(proposed.statusCode, 201, proposed.text);

  const accepted = await requestJson(baseUrl, `/intents/${encodeURIComponent(intentId)}/accept`, {
    method: "POST",
    headers: buildHeaders({ idempotencyKey: `agent_build_pipeline_intent_accept_${suffix}` }),
    body: { acceptedByAgentId: subAgentId }
  });
  assert.equal(accepted.statusCode, 200, accepted.text);
  const intentHash = accepted.json?.intentContract?.intentHash;
  assert.equal(typeof intentHash, "string");
  assert.equal(intentHash.length, 64);

  const workOrderCreated = await requestJson(baseUrl, "/work-orders", {
    method: "POST",
    headers: buildHeaders({ idempotencyKey: `agent_build_pipeline_work_order_create_${suffix}` }),
    body: {
      workOrderId,
      principalAgentId,
      subAgentId,
      requiredCapability: "code.generation",
      specification: {
        sessionId,
        taskType: "codegen",
        prompt: "Implement deterministic parser"
      },
      pricing: {
        amountCents: 950,
        currency: "USD",
        quoteId: `quote_${workOrderId}`
      },
      constraints: {
        maxDurationSeconds: 300,
        maxCostCents: 950,
        retryLimit: 1
      },
      intentBinding: { intentId }
    }
  });
  assert.equal(workOrderCreated.statusCode, 201, workOrderCreated.text);
  assert.equal(workOrderCreated.json?.workOrder?.status, "created");
  assert.equal(workOrderCreated.json?.workOrder?.intentBinding?.intentHash, intentHash);

  await daemon.tick();

  let completedWorkOrder = null;
  for (let index = 0; index < 80; index += 1) {
    await sleep(30);
    const fetched = await requestJson(baseUrl, `/work-orders/${encodeURIComponent(workOrderId)}`, {
      headers: buildHeaders()
    });
    if (fetched.statusCode === 200 && fetched.json?.workOrder?.status === "completed") {
      completedWorkOrder = fetched;
      break;
    }
  }
  assert.ok(completedWorkOrder, "expected completed work order after daemon tick");

  const completionReceiptId = completedWorkOrder?.json?.workOrder?.completionReceiptId;
  assert.equal(typeof completionReceiptId, "string");
  assert.equal(completionReceiptId.length > 0, true);

  const completionReceipt = await requestJson(baseUrl, `/work-orders/receipts/${encodeURIComponent(completionReceiptId)}`, {
    headers: buildHeaders()
  });
  assert.equal(completionReceipt.statusCode, 200, completionReceipt.text);
  assert.deepEqual(completionReceipt.json?.completionReceipt?.evidenceRefs, [
    "artifact://agent-build-pipeline/output.json",
    "report://agent-build-pipeline/verification.json"
  ]);
  assert.equal(completionReceipt.json?.completionReceipt?.intentHash, intentHash);

  const settled = await requestJson(baseUrl, `/work-orders/${encodeURIComponent(workOrderId)}/settle`, {
    method: "POST",
    headers: buildHeaders({ idempotencyKey: `agent_build_pipeline_settle_${suffix}` }),
    body: {
      completionReceiptId,
      completionReceiptHash: completionReceipt.json?.completionReceipt?.receiptHash,
      intentHash,
      status: "released",
      x402GateId: `x402gate_${suffix}`,
      x402RunId: `run_${suffix}`,
      x402SettlementStatus: "released",
      x402ReceiptId: `x402rcpt_${suffix}`
    }
  });
  assert.equal(settled.statusCode, 200, settled.text);
  assert.equal(settled.json?.workOrder?.status, "settled");

  const settledFetch = await requestJson(baseUrl, `/work-orders/${encodeURIComponent(workOrderId)}`, {
    headers: buildHeaders()
  });
  assert.equal(settledFetch.statusCode, 200, settledFetch.text);
  assert.equal(settledFetch.json?.workOrder?.settlement?.x402RunId, `run_${suffix}`);

  const sessionEvents = await requestJson(baseUrl, `/sessions/${encodeURIComponent(sessionId)}/events`, {
    headers: buildHeaders({ principalId: principalAgentId })
  });
  assert.equal(sessionEvents.statusCode, 200, sessionEvents.text);
  const expectedPrevChainHash = sessionEvents.json?.currentPrevChainHash;
  assert.equal(typeof expectedPrevChainHash, "string");
  assert.equal(expectedPrevChainHash.length > 0, true);

  const sessionTaskCompleted = await requestJson(baseUrl, `/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    headers: {
      ...buildHeaders({
        idempotencyKey: `agent_build_pipeline_session_completed_${suffix}`,
        principalId: principalAgentId
      }),
      "x-proxy-expected-prev-chain-hash": expectedPrevChainHash
    },
    body: {
      eventType: "TASK_COMPLETED",
      traceId: `trace_pipeline_${suffix}`,
      payload: {
        workOrderId,
        completionReceiptId,
        settlementStatus: settled.json?.workOrder?.settlement?.status ?? null
      }
    }
  });
  assert.equal(sessionTaskCompleted.statusCode, 201, sessionTaskCompleted.text);

  const replayPack = await requestJson(baseUrl, `/sessions/${encodeURIComponent(sessionId)}/replay-pack`, {
    headers: buildHeaders({ principalId: principalAgentId })
  });
  assert.equal(replayPack.statusCode, 200, replayPack.text);
  assert.equal(replayPack.json?.replayPack?.sessionId, sessionId);
  assert.equal(typeof replayPack.json?.replayPack?.packHash, "string");
  assert.equal(replayPack.json?.replayPack?.packHash?.length, 64);
  assert.equal(Number(replayPack.json?.replayPack?.eventCount) >= 2, true);

  await daemon.stop();
});
