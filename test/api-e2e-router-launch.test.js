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
      owner: { ownerType: "service", ownerId: "svc_router_launch_test" },
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

test("API e2e: /router/launch creates marketplace RFQs from routed tasks", async () => {
  const api = createApi({ store: createStore() });

  await registerAgent(api, {
    agentId: "agt_router_launch_poster",
    capabilities: ["capability://workflow.orchestrator"]
  });
  await registerAgent(api, {
    agentId: "agt_router_launch_worker_1",
    capabilities: ["capability://code.generation", "capability://code.test.run"]
  });
  await registerAgent(api, {
    agentId: "agt_router_launch_worker_2",
    capabilities: ["capability://code.generation"]
  });

  await upsertAgentCard(api, {
    agentId: "agt_router_launch_worker_1",
    capabilities: ["capability://code.generation", "capability://code.test.run"],
    visibility: "public"
  });
  await upsertAgentCard(api, {
    agentId: "agt_router_launch_worker_2",
    capabilities: ["capability://code.generation"],
    visibility: "public"
  });

  const launchBody = {
    text: "Implement the feature and make tests pass. Open a PR on GitHub.",
    posterAgentId: "agt_router_launch_poster",
    scope: "public",
    budgetCents: 5000,
    currency: "usd",
    deadlineAt: "2030-01-01T00:00:00.000Z",
    metadata: { source: "ask-network" },
    taskOverrides: {
      t_test: {
        rfqId: "rfq_router_launch_test_task",
        budgetCents: 1200,
        currency: "eur"
      }
    }
  };

  const launched = await request(api, {
    method: "POST",
    path: "/router/launch",
    headers: { "x-idempotency-key": "router_launch_e2e_1" },
    body: launchBody
  });

  assert.equal(launched.statusCode, 201, launched.body);
  assert.equal(launched.json?.ok, true);
  assert.equal(launched.json?.launch?.schemaVersion, "RouterMarketplaceLaunch.v1");
  assert.equal(launched.json?.plan?.schemaVersion, "RouterPlan.v1");
  assert.equal(Array.isArray(launched.json?.rfqs), true);
  assert.equal(launched.json?.rfqs?.length, 2);
  assert.match(String(launched.json?.launch?.launchHash ?? ""), /^[0-9a-f]{64}$/);

  const rfqsByCapability = new Map(
    launched.json.rfqs.map((rfq) => [String(rfq.capability ?? ""), rfq])
  );
  const implementRfq = rfqsByCapability.get("capability://code.generation");
  const testRfq = rfqsByCapability.get("capability://code.test.run");
  assert.ok(implementRfq, "expected code generation rfq");
  assert.ok(testRfq, "expected code test rfq");

  assert.equal(implementRfq.posterAgentId, "agt_router_launch_poster");
  assert.equal(implementRfq.budgetCents, 5000);
  assert.equal(implementRfq.currency, "USD");
  assert.equal(testRfq.rfqId, "rfq_router_launch_test_task");
  assert.equal(testRfq.budgetCents, 1200);
  assert.equal(testRfq.currency, "EUR");
  assert.equal(testRfq.metadata?.routerLaunch?.launchId, launched.json?.launch?.launchId);
  assert.equal(testRfq.metadata?.routerLaunch?.taskId, "t_test");
  assert.deepEqual(testRfq.metadata?.routerLaunch?.candidateAgentIds, ["agt_router_launch_worker_1"]);

  const listed = await request(api, {
    method: "GET",
    path: "/marketplace/rfqs?posterAgentId=agt_router_launch_poster&limit=10&offset=0"
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json?.total, 2);

  const replay = await request(api, {
    method: "POST",
    path: "/router/launch",
    headers: { "x-idempotency-key": "router_launch_e2e_1" },
    body: launchBody
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json, launched.json);
});

test("API e2e: /router/launch fails closed when no tasks can be derived", async () => {
  const api = createApi({ store: createStore() });

  await registerAgent(api, {
    agentId: "agt_router_launch_poster_fail",
    capabilities: ["capability://workflow.orchestrator"]
  });

  const launched = await request(api, {
    method: "POST",
    path: "/router/launch",
    body: {
      text: "unicorn diplomacy for the interstellar council",
      posterAgentId: "agt_router_launch_poster_fail"
    }
  });

  assert.equal(launched.statusCode, 409, launched.body);
  assert.equal(launched.json?.code, "ROUTER_LAUNCH_NO_TASKS");

  const listed = await request(api, {
    method: "GET",
    path: "/marketplace/rfqs?posterAgentId=agt_router_launch_poster_fail&limit=10&offset=0"
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json?.total, 0);
});
