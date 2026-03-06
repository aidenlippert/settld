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
      owner: { ownerType: "service", ownerId: "svc_test" },
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
  assert.equal(response.json?.agentCard?.agentId, agentId);
}

test("API e2e: /router/plan returns RouterPlan.v1 with ranked candidates", async () => {
  const api = createApi({ store: createStore() });

  await registerAgent(api, {
    agentId: "agt_router_worker_1",
    capabilities: ["capability://code.generation", "capability://code.test.run", "capability://code.review"]
  });
  await registerAgent(api, {
    agentId: "agt_router_worker_2",
    capabilities: ["capability://code.generation"]
  });

  await upsertAgentCard(api, {
    agentId: "agt_router_worker_1",
    capabilities: ["capability://code.generation", "capability://code.test.run", "capability://code.review"],
    visibility: "public"
  });
  await upsertAgentCard(api, {
    agentId: "agt_router_worker_2",
    capabilities: ["capability://code.generation"],
    visibility: "public"
  });

  const planned = await request(api, {
    method: "POST",
    path: "/router/plan",
    body: {
      text: "Implement the feature, make tests pass, and do a security review as needed. Open a PR on GitHub.",
      scope: "tenant",
      maxCandidates: 10,
      includeReputation: true,
      includeRoutingFactors: true,
      scoreStrategy: "balanced"
    }
  });

  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json?.ok, true);
  assert.equal(planned.json?.plan?.schemaVersion, "RouterPlan.v1");
  assert.match(planned.json?.plan?.planHash ?? "", /^[0-9a-f]{64}$/);

  const tasks = planned.json?.plan?.tasks;
  assert.equal(Array.isArray(tasks), true);
  assert.equal(tasks.length, 3);

  const implement = tasks.find((t) => t.requiredCapability === "capability://code.generation");
  assert.ok(implement, "expected implement task");
  assert.equal(Array.isArray(implement.candidates), true);
  assert.equal(implement.candidates.length, 2);

  const testTask = tasks.find((t) => t.requiredCapability === "capability://code.test.run");
  assert.ok(testTask, "expected test task");
  assert.equal(Array.isArray(testTask.candidates), true);
  assert.equal(testTask.candidates.length, 1);

  const reviewTask = tasks.find((t) => t.requiredCapability === "capability://code.review");
  assert.ok(reviewTask, "expected review task");
  assert.equal(Array.isArray(reviewTask.candidates), true);
  assert.equal(reviewTask.candidates.length, 1);
});

test("API e2e: /router/plan fails closed when intent cannot be derived", async () => {
  const api = createApi({ store: createStore() });

  const planned = await request(api, {
    method: "POST",
    path: "/router/plan",
    body: { text: "unicorn diplomacy for the interstellar council" }
  });

  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json?.ok, true);
  assert.equal(planned.json?.plan?.schemaVersion, "RouterPlan.v1");
  assert.equal(planned.json?.plan?.taskCount, 0);

  const issues = planned.json?.plan?.issues;
  assert.equal(Array.isArray(issues), true);
  assert.ok(issues.some((issue) => issue?.code === "ROUTER_INTENT_NO_MATCH"));
});

