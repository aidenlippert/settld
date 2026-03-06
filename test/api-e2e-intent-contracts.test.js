import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { agentId, capabilities = [] }) {
  const { publicKeyPem } = createEd25519Keypair();
  const response = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `intent_agent_register_${agentId}` },
    body: {
      agentId,
      displayName: `Agent ${agentId}`,
      owner: { ownerType: "service", ownerId: "svc_intent_tests" },
      publicKeyPem,
      capabilities
    }
  });
  assert.equal(response.statusCode, 201, response.body);
}

test("API e2e: intent lifecycle binds delegated work orders fail-closed", async () => {
  const api = createApi({ workOrderRequireIntentBinding: true });

  const principalAgentId = "agt_intent_principal_1";
  const subAgentId = "agt_intent_worker_1";
  await registerAgent(api, { agentId: principalAgentId, capabilities: ["orchestration"] });
  await registerAgent(api, { agentId: subAgentId, capabilities: ["code.generation"] });

  const proposed = await request(api, {
    method: "POST",
    path: "/intents/propose",
    headers: { "x-idempotency-key": "intent_propose_1" },
    body: {
      intentId: "intent_acs_bind_1",
      proposerAgentId: principalAgentId,
      counterpartyAgentId: subAgentId,
      objective: { type: "delegated_task", summary: "Implement deterministic parser" },
      budgetEnvelope: { currency: "USD", maxAmountCents: 1000, hardCap: true },
      successCriteria: { unitTestsPassing: true },
      terminationPolicy: { mode: "manual" }
    }
  });
  assert.equal(proposed.statusCode, 201, proposed.body);
  assert.equal(proposed.json?.intentContract?.status, "proposed");
  assert.equal(typeof proposed.json?.intentContract?.intentHash, "string");
  assert.equal(proposed.json.intentContract.intentHash.length, 64);

  const missingBindingBlocked = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "intent_work_order_missing_binding_1" },
    body: {
      workOrderId: "workord_intent_missing_binding_1",
      principalAgentId,
      subAgentId,
      requiredCapability: "code.generation",
      pricing: { amountCents: 500, currency: "USD" }
    }
  });
  assert.equal(missingBindingBlocked.statusCode, 409, missingBindingBlocked.body);
  assert.equal(missingBindingBlocked.json?.code, "WORK_ORDER_INTENT_BINDING_REQUIRED");

  const notAcceptedBlocked = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "intent_work_order_not_accepted_1" },
    body: {
      workOrderId: "workord_intent_not_accepted_1",
      principalAgentId,
      subAgentId,
      requiredCapability: "code.generation",
      pricing: { amountCents: 500, currency: "USD" },
      intentBinding: { intentId: "intent_acs_bind_1" }
    }
  });
  assert.equal(notAcceptedBlocked.statusCode, 409, notAcceptedBlocked.body);
  assert.equal(notAcceptedBlocked.json?.code, "INTENT_CONTRACT_NOT_ACCEPTED");

  const accepted = await request(api, {
    method: "POST",
    path: "/intents/intent_acs_bind_1/accept",
    headers: { "x-idempotency-key": "intent_accept_1" },
    body: {
      acceptedByAgentId: subAgentId
    }
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json?.intentContract?.status, "accepted");

  const wrongHashBlocked = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "intent_work_order_hash_mismatch_1" },
    body: {
      workOrderId: "workord_intent_hash_mismatch_1",
      principalAgentId,
      subAgentId,
      requiredCapability: "code.generation",
      pricing: { amountCents: 500, currency: "USD" },
      intentBinding: {
        intentId: "intent_acs_bind_1",
        intentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  });
  assert.equal(wrongHashBlocked.statusCode, 409, wrongHashBlocked.body);
  assert.equal(wrongHashBlocked.json?.code, "INTENT_CONTRACT_HASH_MISMATCH");

  const created = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "intent_work_order_create_1" },
    body: {
      workOrderId: "workord_intent_bound_1",
      principalAgentId,
      subAgentId,
      requiredCapability: "code.generation",
      pricing: { amountCents: 500, currency: "USD" },
      intentBinding: { intentId: "intent_acs_bind_1" }
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json?.workOrder?.intentBinding?.intentId, "intent_acs_bind_1");
  assert.equal(created.json?.workOrder?.intentBinding?.intentHash, accepted.json?.intentContract?.intentHash);

  const completeHashMismatch = await request(api, {
    method: "POST",
    path: "/work-orders/workord_intent_bound_1/complete",
    headers: { "x-idempotency-key": "intent_work_order_complete_mismatch_1" },
    body: {
      receiptId: "worec_intent_bound_1_a",
      status: "success",
      outputs: { artifactRef: "artifact://intent/one" },
      evidenceRefs: ["artifact://intent/one"],
      amountCents: 500,
      currency: "USD",
      intentHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  });
  assert.equal(completeHashMismatch.statusCode, 409, completeHashMismatch.body);
  assert.equal(completeHashMismatch.json?.code, "INTENT_CONTRACT_HASH_MISMATCH");

  const completed = await request(api, {
    method: "POST",
    path: "/work-orders/workord_intent_bound_1/complete",
    headers: { "x-idempotency-key": "intent_work_order_complete_1" },
    body: {
      receiptId: "worec_intent_bound_1",
      status: "success",
      outputs: { artifactRef: "artifact://intent/two" },
      evidenceRefs: ["artifact://intent/two", "report://verification/intent/two"],
      amountCents: 500,
      currency: "USD",
      intentHash: accepted.json?.intentContract?.intentHash
    }
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json?.completionReceipt?.intentHash, accepted.json?.intentContract?.intentHash);

  const settleMismatch = await request(api, {
    method: "POST",
    path: "/work-orders/workord_intent_bound_1/settle",
    headers: { "x-idempotency-key": "intent_work_order_settle_mismatch_1" },
    body: {
      completionReceiptId: "worec_intent_bound_1",
      completionReceiptHash: completed.json?.completionReceipt?.receiptHash,
      intentHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      status: "released",
      x402GateId: "x402gate_intent_1",
      x402RunId: "run_intent_1"
    }
  });
  assert.equal(settleMismatch.statusCode, 409, settleMismatch.body);
  assert.equal(settleMismatch.json?.code, "INTENT_CONTRACT_HASH_MISMATCH");

  const settled = await request(api, {
    method: "POST",
    path: "/work-orders/workord_intent_bound_1/settle",
    headers: { "x-idempotency-key": "intent_work_order_settle_1" },
    body: {
      completionReceiptId: "worec_intent_bound_1",
      completionReceiptHash: completed.json?.completionReceipt?.receiptHash,
      intentHash: accepted.json?.intentContract?.intentHash,
      status: "released",
      x402GateId: "x402gate_intent_1",
      x402RunId: "run_intent_1"
    }
  });
  assert.equal(settled.statusCode, 200, settled.body);
  assert.equal(settled.json?.workOrder?.status, "settled");
});
