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
      owner: { ownerType: "service", ownerId: "svc_router_dispatch_test" },
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

test("API e2e: /router/dispatch accepts ready tasks, blocks dependencies, and can be replayed after closure", async () => {
  const api = createApi({ store: createStore() });

  await registerAgent(api, {
    agentId: "agt_router_dispatch_poster",
    capabilities: ["capability://workflow.orchestrator"]
  });
  await registerAgent(api, {
    agentId: "agt_router_dispatch_worker_1",
    capabilities: ["capability://code.generation", "capability://code.test.run"]
  });
  await registerAgent(api, {
    agentId: "agt_router_dispatch_worker_2",
    capabilities: ["capability://code.generation"]
  });
  await registerAgent(api, {
    agentId: "agt_router_dispatch_operator",
    capabilities: ["capability://workflow.orchestrator"]
  });

  await upsertAgentCard(api, {
    agentId: "agt_router_dispatch_worker_1",
    capabilities: ["capability://code.generation", "capability://code.test.run"]
  });
  await upsertAgentCard(api, {
    agentId: "agt_router_dispatch_worker_2",
    capabilities: ["capability://code.generation"]
  });

  await creditWallet(api, {
    agentId: "agt_router_dispatch_poster",
    amountCents: 20_000,
    idempotencyKey: "wallet_credit_router_dispatch_poster"
  });

  const launch = await request(api, {
    method: "POST",
    path: "/router/launch",
    headers: { "x-idempotency-key": "router_dispatch_launch_1" },
    body: {
      text: "Implement the feature and make tests pass. Open a PR on GitHub.",
      posterAgentId: "agt_router_dispatch_poster",
      scope: "public",
      budgetCents: 5000,
      currency: "USD",
      taskOverrides: {
        t_implement: { rfqId: "rfq_router_dispatch_implement" },
        t_test: { rfqId: "rfq_router_dispatch_test" }
      }
    }
  });
  assert.equal(launch.statusCode, 201, launch.body);
  assert.match(String(launch.json?.launch?.launchHash ?? ""), /^[0-9a-f]{64}$/);

  await submitBid(api, {
    rfqId: "rfq_router_dispatch_implement",
    bidId: "bid_router_dispatch_impl_a",
    bidderAgentId: "agt_router_dispatch_worker_1",
    amountCents: 1800,
    etaSeconds: 900
  });
  await submitBid(api, {
    rfqId: "rfq_router_dispatch_implement",
    bidId: "bid_router_dispatch_impl_b",
    bidderAgentId: "agt_router_dispatch_worker_2",
    amountCents: 2200,
    etaSeconds: 600
  });
  await submitBid(api, {
    rfqId: "rfq_router_dispatch_test",
    bidId: "bid_router_dispatch_test_a",
    bidderAgentId: "agt_router_dispatch_worker_1",
    amountCents: 900,
    etaSeconds: 600
  });

  const firstDispatchBody = {
    launchId: launch.json?.launch?.launchId,
    acceptedByAgentId: "agt_router_dispatch_operator"
  };
  const firstDispatch = await request(api, {
    method: "POST",
    path: "/router/dispatch",
    headers: { "x-idempotency-key": "router_dispatch_round_1" },
    body: firstDispatchBody
  });
  assert.equal(firstDispatch.statusCode, 200, firstDispatch.body);
  assert.equal(firstDispatch.json?.ok, true);
  assert.equal(firstDispatch.json?.dispatch?.acceptedCount, 1);
  assert.equal(firstDispatch.json?.dispatch?.blockedCount, 1);
  assert.equal(firstDispatch.json?.dispatch?.launchRef?.launchHash, launch.json?.launch?.launchHash);

  const firstResultsByTaskId = new Map(firstDispatch.json?.results?.map((row) => [row.taskId, row]) ?? []);
  const implementDispatch = firstResultsByTaskId.get("t_implement");
  const testDispatch = firstResultsByTaskId.get("t_test");
  assert.equal(implementDispatch?.state, "accepted");
  assert.equal(implementDispatch?.acceptedBidId, "bid_router_dispatch_impl_a");
  assert.ok(typeof implementDispatch?.runId === "string" && implementDispatch.runId.length > 0);
  assert.equal(testDispatch?.state, "blocked_dependencies_pending");
  assert.deepEqual(testDispatch?.blockingTaskIds, ["t_implement"]);

  const replay = await request(api, {
    method: "POST",
    path: "/router/dispatch",
    headers: { "x-idempotency-key": "router_dispatch_round_1" },
    body: firstDispatchBody
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json, firstDispatch.json);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/agt_router_dispatch_worker_1/runs/${encodeURIComponent(implementDispatch.runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": implementDispatch?.run?.lastChainHash,
      "x-idempotency-key": "router_dispatch_complete_implement_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${implementDispatch.runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(complete.statusCode, 201, complete.body);
  assert.equal(complete.json?.settlement?.status, "released");

  const secondDispatch = await request(api, {
    method: "POST",
    path: "/router/dispatch",
    headers: { "x-idempotency-key": "router_dispatch_round_2" },
    body: {
      launchId: launch.json?.launch?.launchId,
      acceptedByAgentId: "agt_router_dispatch_operator"
    }
  });
  assert.equal(secondDispatch.statusCode, 200, secondDispatch.body);
  assert.equal(secondDispatch.json?.dispatch?.acceptedCount, 1);
  assert.equal(secondDispatch.json?.dispatch?.noopCount, 1);

  const secondResultsByTaskId = new Map(secondDispatch.json?.results?.map((row) => [row.taskId, row]) ?? []);
  assert.equal(secondResultsByTaskId.get("t_implement")?.state, "already_closed");
  assert.equal(secondResultsByTaskId.get("t_test")?.state, "accepted");
  assert.equal(secondResultsByTaskId.get("t_test")?.acceptedBidId, "bid_router_dispatch_test_a");
});

test("API e2e: /router/dispatch fails closed on ambiguous best bids", async () => {
  const api = createApi({ store: createStore() });

  await registerAgent(api, {
    agentId: "agt_router_dispatch_amb_poster",
    capabilities: ["capability://workflow.orchestrator"]
  });
  await registerAgent(api, {
    agentId: "agt_router_dispatch_amb_worker_a",
    capabilities: ["capability://code.generation"]
  });
  await registerAgent(api, {
    agentId: "agt_router_dispatch_amb_worker_b",
    capabilities: ["capability://code.generation"]
  });

  await upsertAgentCard(api, {
    agentId: "agt_router_dispatch_amb_worker_a",
    capabilities: ["capability://code.generation"]
  });
  await upsertAgentCard(api, {
    agentId: "agt_router_dispatch_amb_worker_b",
    capabilities: ["capability://code.generation"]
  });

  await creditWallet(api, {
    agentId: "agt_router_dispatch_amb_poster",
    amountCents: 20_000,
    idempotencyKey: "wallet_credit_router_dispatch_amb_poster"
  });

  const launch = await request(api, {
    method: "POST",
    path: "/router/launch",
    headers: { "x-idempotency-key": "router_dispatch_amb_launch_1" },
    body: {
      text: "Implement the feature and make tests pass. Open a PR on GitHub.",
      posterAgentId: "agt_router_dispatch_amb_poster",
      scope: "public",
      budgetCents: 5000,
      currency: "USD",
      taskOverrides: {
        t_implement: { rfqId: "rfq_router_dispatch_amb_implement" }
      }
    }
  });
  assert.equal(launch.statusCode, 201, launch.body);

  await submitBid(api, {
    rfqId: "rfq_router_dispatch_amb_implement",
    bidId: "bid_router_dispatch_amb_a",
    bidderAgentId: "agt_router_dispatch_amb_worker_a",
    amountCents: 1700,
    etaSeconds: 600
  });
  await submitBid(api, {
    rfqId: "rfq_router_dispatch_amb_implement",
    bidId: "bid_router_dispatch_amb_b",
    bidderAgentId: "agt_router_dispatch_amb_worker_b",
    amountCents: 1700,
    etaSeconds: 600
  });

  const dispatch = await request(api, {
    method: "POST",
    path: "/router/dispatch",
    body: {
      launchId: launch.json?.launch?.launchId,
      taskIds: ["t_implement"]
    }
  });
  assert.equal(dispatch.statusCode, 200, dispatch.body);
  assert.equal(dispatch.json?.dispatch?.acceptedCount, 0);
  assert.equal(dispatch.json?.dispatch?.blockedCount, 1);
  assert.equal(dispatch.json?.results?.[0]?.state, "blocked_ambiguous");
  assert.equal(dispatch.json?.results?.[0]?.reasonCode, "MARKETPLACE_AUTO_AWARD_AMBIGUOUS");
  assert.deepEqual(dispatch.json?.results?.[0]?.decision?.tiedBidIds, [
    "bid_router_dispatch_amb_a",
    "bid_router_dispatch_amb_b"
  ]);
  assert.equal(dispatch.json?.results?.[0]?.acceptedBidId, null);
  assert.equal(dispatch.json?.results?.[0]?.runId, null);
});
