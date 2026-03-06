import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { agentId, tenantId = null, capabilities = [] }) {
  const { publicKeyPem } = createEd25519Keypair();
  const response = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: {
      "x-idempotency-key": `agent_register_${tenantId ?? "default"}_${agentId}`,
      ...(tenantId ? { "x-proxy-tenant-id": tenantId } : {})
    },
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

async function upsertAgentCard(api, { agentId, tenantId = null, visibility = "public", capabilities = [] }) {
  const response = await request(api, {
    method: "POST",
    path: "/agent-cards",
    headers: {
      "x-idempotency-key": `agent_card_${tenantId ?? "default"}_${agentId}_${visibility}`,
      ...(tenantId ? { "x-proxy-tenant-id": tenantId } : {})
    },
    body: {
      agentId,
      displayName: `Worker ${agentId}`,
      description: "Public worker detail page fixture.",
      capabilities,
      visibility,
      host: {
        runtime: "nooterra",
        endpoint: `https://example.test/agents/${agentId}`,
        protocols: ["http"]
      },
      priceHint: {
        amountCents: 450,
        currency: "USD",
        unit: "task"
      },
      tags: ["fixture", visibility]
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  return response;
}

test("API e2e: /public/agent-cards/:agentId returns a public card with optional reputation", async () => {
  const api = createApi();

  await registerAgent(api, {
    agentId: "agt_public_card_detail",
    capabilities: ["travel.booking"]
  });
  await upsertAgentCard(api, {
    agentId: "agt_public_card_detail",
    visibility: "public",
    capabilities: ["travel.booking"]
  });

  const response = await request(api, {
    method: "GET",
    path: "/public/agent-cards/agt_public_card_detail?includeReputation=true&reputationVersion=v2&reputationWindow=30d",
    auth: "none"
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json?.ok, true);
  assert.equal(response.json?.agentCard?.schemaVersion, "AgentCard.v1");
  assert.equal(response.json?.agentCard?.agentId, "agt_public_card_detail");
  assert.equal(response.json?.agentCard?.visibility, "public");
  assert.equal(response.json?.reputation?.schemaVersion, "AgentReputation.v2");
  assert.equal(response.json?.reputation?.agentId, "agt_public_card_detail");

  const responseWithoutReputation = await request(api, {
    method: "GET",
    path: "/public/agent-cards/agt_public_card_detail?includeReputation=false",
    auth: "none"
  });
  assert.equal(responseWithoutReputation.statusCode, 200, responseWithoutReputation.body);
  assert.equal(responseWithoutReputation.json?.ok, true);
  assert.equal(responseWithoutReputation.json?.agentCard?.agentId, "agt_public_card_detail");
  assert.equal(Object.prototype.hasOwnProperty.call(responseWithoutReputation.json ?? {}, "reputation"), false);
});

test("API e2e: /public/agent-cards/:agentId hides non-public cards", async () => {
  const api = createApi();

  await registerAgent(api, {
    agentId: "agt_private_card_detail",
    capabilities: ["code.generation"]
  });
  await upsertAgentCard(api, {
    agentId: "agt_private_card_detail",
    visibility: "private",
    capabilities: ["code.generation"]
  });

  const response = await request(api, {
    method: "GET",
    path: "/public/agent-cards/agt_private_card_detail",
    auth: "none"
  });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(response.json?.code, "NOT_FOUND");
});

test("API e2e: /public/agent-cards/:agentId fails closed on ambiguous public agent ids", async () => {
  const api = createApi();
  const sharedAgentId = "agt_public_card_duplicate";

  await registerAgent(api, {
    agentId: sharedAgentId,
    capabilities: ["analysis.generic"]
  });
  await upsertAgentCard(api, {
    agentId: sharedAgentId,
    visibility: "public",
    capabilities: ["analysis.generic"]
  });

  await registerAgent(api, {
    tenantId: "tenant_alt",
    agentId: sharedAgentId,
    capabilities: ["analysis.generic"]
  });
  await upsertAgentCard(api, {
    tenantId: "tenant_alt",
    agentId: sharedAgentId,
    visibility: "public",
    capabilities: ["analysis.generic"]
  });

  const response = await request(api, {
    method: "GET",
    path: `/public/agent-cards/${sharedAgentId}`,
    auth: "none"
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json?.code, "PUBLIC_AGENT_AMBIGUOUS");
  assert.deepEqual(response.json?.details?.matches, [
    { tenantId: "tenant_alt", agentId: sharedAgentId },
    { tenantId: "tenant_default", agentId: sharedAgentId }
  ]);
});
