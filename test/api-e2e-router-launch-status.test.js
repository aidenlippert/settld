import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { agentId, capabilities }) {
  const { publicKeyPem } = createEd25519Keypair();
  const response = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `agent_register_${agentId}` },
    body: {
      agentId,
      displayName: `Agent ${agentId}`,
      owner: { ownerType: "service", ownerId: "svc_router_status_test" },
      publicKeyPem,
      capabilities
    }
  });
  assert.equal(response.statusCode, 201, response.body);
}

async function upsertAgentCard(api, { agentId, capabilities, visibility = "public" }) {
  const response = await request(api, {
    method: "POST",
    path: "/agent-cards",
    headers: { "x-idempotency-key": `agent_card_upsert_${agentId}` },
    body: {
      agentId,
      displayName: `Card ${agentId}`,
      capabilities,
      visibility,
      host: { runtime: "nooterra" },
      priceHint: { amountCents: 500, currency: "USD", unit: "task" }
    }
  });
  assert.equal(response.statusCode, 201, response.body);
}

async function creditWallet(api, { agentId, amountCents, idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/wallet/credit`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: { amountCents, currency: "USD" }
  });
  assert.equal(response.statusCode, 201, response.body);
}

async function submitBid(api, { rfqId, bidId, bidderAgentId, amountCents, etaSeconds }) {
  const response = await request(api, {
    method: "POST",
    path: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`,
    headers: { "x-idempotency-key": `bid_${bidId}` },
    body: {
      bidId,
      bidderAgentId,
      amountCents,
      currency: "USD",
      etaSeconds
    }
  });
  assert.equal(response.statusCode, 201, response.body);
}

test("API e2e: /router/launches/:launchId/status reconstructs task, bid, and settlement state", async () => {
  const api = createApi({ store: createStore() });

  await registerAgent(api, {
    agentId: "agt_router_status_poster",
    capabilities: ["capability://workflow.orchestrator"]
  });
  await registerAgent(api, {
    agentId: "agt_router_status_worker",
    capabilities: ["capability://code.generation", "capability://code.test.run"]
  });
  await registerAgent(api, {
    agentId: "agt_router_status_operator",
    capabilities: ["capability://workflow.orchestrator"]
  });

  await upsertAgentCard(api, {
    agentId: "agt_router_status_worker",
    capabilities: ["capability://code.generation", "capability://code.test.run"]
  });

  await creditWallet(api, {
    agentId: "agt_router_status_poster",
    amountCents: 20_000,
    idempotencyKey: "wallet_credit_router_status_poster"
  });

  const launch = await request(api, {
    method: "POST",
    path: "/router/launch",
    headers: { "x-idempotency-key": "router_status_launch_1" },
    body: {
      text: "Implement the feature and make tests pass. Open a PR on GitHub.",
      posterAgentId: "agt_router_status_poster",
      scope: "public",
      budgetCents: 5000,
      currency: "USD",
      taskOverrides: {
        t_implement: { rfqId: "rfq_router_status_implement" },
        t_test: { rfqId: "rfq_router_status_test" }
      }
    }
  });
  assert.equal(launch.statusCode, 201, launch.body);
  const launchId = launch.json?.launch?.launchId;

  await submitBid(api, {
    rfqId: "rfq_router_status_implement",
    bidId: "bid_router_status_impl",
    bidderAgentId: "agt_router_status_worker",
    amountCents: 1800,
    etaSeconds: 900
  });
  await submitBid(api, {
    rfqId: "rfq_router_status_test",
    bidId: "bid_router_status_test",
    bidderAgentId: "agt_router_status_worker",
    amountCents: 900,
    etaSeconds: 600
  });

  const initialStatus = await request(api, {
    method: "GET",
    path: `/router/launches/${encodeURIComponent(launchId)}/status`
  });
  assert.equal(initialStatus.statusCode, 200, initialStatus.body);
  assert.equal(initialStatus.json?.ok, true);
  assert.equal(initialStatus.json?.status?.schemaVersion, "RouterLaunchStatus.v1");
  assert.equal(initialStatus.json?.status?.summary?.readyCount, 1);
  assert.equal(initialStatus.json?.status?.summary?.blockedCount, 1);

  const initialTasks = new Map((initialStatus.json?.status?.tasks ?? []).map((task) => [task.taskId, task]));
  assert.equal(initialTasks.get("t_implement")?.state, "open_ready");
  assert.equal(initialTasks.get("t_implement")?.bidCount, 1);
  assert.equal(initialTasks.get("t_test")?.state, "blocked_dependencies_pending");
  assert.deepEqual(initialTasks.get("t_test")?.blockedByTaskIds, ["t_implement"]);
  assert.equal(initialTasks.get("t_test")?.bidCount, 1);

  const dispatch = await request(api, {
    method: "POST",
    path: "/router/dispatch",
    headers: { "x-idempotency-key": "router_status_dispatch_1" },
    body: {
      launchId,
      acceptedByAgentId: "agt_router_status_operator"
    }
  });
  assert.equal(dispatch.statusCode, 200, dispatch.body);

  const afterDispatch = await request(api, {
    method: "GET",
    path: `/router/launches/${encodeURIComponent(launchId)}/status`
  });
  assert.equal(afterDispatch.statusCode, 200, afterDispatch.body);
  assert.equal(afterDispatch.json?.status?.summary?.assignedCount, 1);
  assert.equal(afterDispatch.json?.status?.summary?.settlementLockedCount, 1);

  const assignedTasks = new Map((afterDispatch.json?.status?.tasks ?? []).map((task) => [task.taskId, task]));
  assert.equal(assignedTasks.get("t_implement")?.state, "assigned");
  assert.equal(assignedTasks.get("t_implement")?.settlementStatus, "locked");
  assert.equal(assignedTasks.get("t_test")?.state, "blocked_dependencies_pending");

  const implementRunId = assignedTasks.get("t_implement")?.runId;
  const implementRunChainHash = assignedTasks.get("t_implement")?.run?.lastChainHash;
  assert.ok(typeof implementRunId === "string" && implementRunId.length > 0);
  assert.ok(typeof implementRunChainHash === "string" && implementRunChainHash.length > 0);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/agt_router_status_worker/runs/${encodeURIComponent(implementRunId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": implementRunChainHash,
      "x-idempotency-key": "router_status_complete_impl_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${implementRunId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(complete.statusCode, 201, complete.body);
  assert.equal(complete.json?.settlement?.status, "released");

  const finalStatus = await request(api, {
    method: "GET",
    path: `/router/launches/${encodeURIComponent(launchId)}/status`
  });
  assert.equal(finalStatus.statusCode, 200, finalStatus.body);
  assert.equal(finalStatus.json?.status?.summary?.closedCount, 1);
  assert.equal(finalStatus.json?.status?.summary?.readyCount, 1);
  assert.equal(finalStatus.json?.status?.summary?.settlementReleasedCount, 1);

  const finalTasks = new Map((finalStatus.json?.status?.tasks ?? []).map((task) => [task.taskId, task]));
  assert.equal(finalTasks.get("t_implement")?.state, "closed");
  assert.equal(finalTasks.get("t_implement")?.settlementStatus, "released");
  assert.equal(finalTasks.get("t_test")?.state, "open_ready");
  assert.equal(finalTasks.get("t_test")?.bidCount, 1);
});
