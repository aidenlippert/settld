import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { agentId, capabilities = [] }) {
  const { publicKeyPem } = createEd25519Keypair();
  const response = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `agent_register_${agentId}` },
    body: {
      agentId,
      displayName: `Agent ${agentId}`,
      owner: { ownerType: "service", ownerId: "svc_task_negotiation_test" },
      publicKeyPem,
      capabilities
    }
  });
  assert.equal(response.statusCode, 201, response.body);
}

async function setX402AgentLifecycle(
  api,
  { agentId, status, idempotencyKey, reasonCode = null, reasonMessage = null }
) {
  return await request(api, {
    method: "POST",
    path: `/x402/gate/agents/${encodeURIComponent(agentId)}/lifecycle`,
    headers: {
      "x-idempotency-key": idempotencyKey,
      "x-nooterra-protocol": "1.0"
    },
    body: {
      status,
      ...(reasonCode ? { reasonCode } : {}),
      ...(reasonMessage ? { reasonMessage } : {})
    }
  });
}

async function proposeAndAcceptIntentContract(
  api,
  {
    intentId = "intent_task_1",
    buyerAgentId,
    sellerAgentId,
    requiredCapability,
    amountCents = 500
  } = {}
) {
  const proposed = await request(api, {
    method: "POST",
    path: "/intents/propose",
    headers: { "x-idempotency-key": `intent_propose_${intentId}`, "x-nooterra-protocol": "1.0" },
    body: {
      intentId,
      proposerAgentId: buyerAgentId,
      counterpartyAgentId: sellerAgentId,
      objective: {
        type: "delegated_task",
        capabilityId: requiredCapability,
        summary: `Perform ${requiredCapability}`
      },
      constraints: {
        region: "us",
        approval: "standard"
      },
      budgetEnvelope: {
        currency: "USD",
        maxAmountCents: amountCents,
        hardCap: true
      },
      successCriteria: {
        deterministic: true
      },
      terminationPolicy: {
        mode: "manual"
      },
      proposedAt: "2026-02-24T00:00:00.000Z",
      metadata: {
        source: "api-e2e-task-negotiation"
      }
    }
  });
  assert.equal(proposed.statusCode, 201, proposed.body);

  const accepted = await request(api, {
    method: "POST",
    path: `/intents/${encodeURIComponent(intentId)}/accept`,
    headers: { "x-idempotency-key": `intent_accept_${intentId}`, "x-nooterra-protocol": "1.0" },
    body: {
      acceptedByAgentId: sellerAgentId,
      acceptedAt: "2026-02-24T00:00:30.000Z"
    }
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  return accepted.json?.intentContract;
}

test("API e2e: task negotiation quote->offer->acceptance lifecycle", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const buyerAgentId = "agt_task_neg_buyer_1";
  const sellerAgentId = "agt_task_neg_seller_1";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: ["analysis.generic"] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: ["analysis.generic"] });

  const quote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_1" },
    body: {
      quoteId: "tquote_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      pricing: { amountCents: 500, currency: "USD" }
    }
  });
  assert.equal(quote.statusCode, 201, quote.body);
  assert.equal(quote.json?.taskQuote?.schemaVersion, "TaskQuote.v1");
  assert.equal(quote.json?.taskQuote?.status, "open");

  const quoteGet = await request(api, { method: "GET", path: "/task-quotes/tquote_1" });
  assert.equal(quoteGet.statusCode, 200, quoteGet.body);
  assert.equal(quoteGet.json?.taskQuote?.quoteId, "tquote_1");

  const quoteList = await request(api, {
    method: "GET",
    path: `/task-quotes?buyerAgentId=${encodeURIComponent(buyerAgentId)}&status=open`
  });
  assert.equal(quoteList.statusCode, 200, quoteList.body);
  assert.equal(quoteList.json?.taskQuotes?.length, 1);

  const offer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_1" },
    body: {
      offerId: "toffer_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: {
        quoteId: "tquote_1",
        quoteHash: quote.json.taskQuote.quoteHash
      },
      pricing: { amountCents: 500, currency: "USD" }
    }
  });
  assert.equal(offer.statusCode, 201, offer.body);
  assert.equal(offer.json?.taskOffer?.schemaVersion, "TaskOffer.v1");
  assert.equal(offer.json?.taskOffer?.status, "open");

  const offerGet = await request(api, { method: "GET", path: "/task-offers/toffer_1" });
  assert.equal(offerGet.statusCode, 200, offerGet.body);
  assert.equal(offerGet.json?.taskOffer?.offerId, "toffer_1");

  const acceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_1" },
    body: {
      acceptanceId: "taccept_1",
      quoteId: "tquote_1",
      offerId: "toffer_1",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(acceptance.statusCode, 201, acceptance.body);
  assert.equal(acceptance.json?.taskAcceptance?.schemaVersion, "TaskAcceptance.v1");
  assert.equal(acceptance.json?.taskAcceptance?.status, "accepted");
  assert.equal(acceptance.json?.taskAcceptance?.quoteRef?.quoteId, "tquote_1");
  assert.equal(acceptance.json?.taskAcceptance?.offerRef?.offerId, "toffer_1");

  const acceptanceGet = await request(api, { method: "GET", path: "/task-acceptances/taccept_1" });
  assert.equal(acceptanceGet.statusCode, 200, acceptanceGet.body);
  assert.equal(acceptanceGet.json?.taskAcceptance?.acceptanceId, "taccept_1");

  const acceptanceList = await request(api, {
    method: "GET",
    path: `/task-acceptances?quoteId=${encodeURIComponent("tquote_1")}&status=accepted`
  });
  assert.equal(acceptanceList.statusCode, 200, acceptanceList.body);
  assert.equal(acceptanceList.json?.taskAcceptances?.length, 1);
});

test("API e2e: work-order settlement enforces acceptance hash binding", async () => {
  const api = createApi({ opsToken: "tok_ops", workOrderRequireAcceptanceBinding: true });
  const buyerAgentId = "agt_task_bind_buyer_1";
  const sellerAgentId = "agt_task_bind_seller_1";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: ["analysis.generic"] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: ["analysis.generic"] });

  const quote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_bind_1" },
    body: {
      quoteId: "tquote_bind_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      pricing: { amountCents: 400, currency: "USD" }
    }
  });
  assert.equal(quote.statusCode, 201, quote.body);

  const offer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_bind_1" },
    body: {
      offerId: "toffer_bind_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: {
        quoteId: "tquote_bind_1",
        quoteHash: quote.json.taskQuote.quoteHash
      },
      pricing: { amountCents: 400, currency: "USD" }
    }
  });
  assert.equal(offer.statusCode, 201, offer.body);

  const acceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_bind_1" },
    body: {
      acceptanceId: "taccept_bind_1",
      quoteId: "tquote_bind_1",
      offerId: "toffer_bind_1",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(acceptance.statusCode, 201, acceptance.body);

  const workOrder = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "work_order_create_bind_1" },
    body: {
      workOrderId: "workord_bind_1",
      principalAgentId: buyerAgentId,
      subAgentId: sellerAgentId,
      requiredCapability: "analysis.generic",
      specification: { taskType: "analysis" },
      pricing: {
        amountCents: 400,
        currency: "USD",
        quoteId: "tquote_bind_1"
      },
      acceptanceRef: {
        acceptanceId: "taccept_bind_1",
        acceptanceHash: acceptance.json.taskAcceptance.acceptanceHash
      }
    }
  });
  assert.equal(workOrder.statusCode, 201, workOrder.body);
  assert.equal(workOrder.json?.workOrder?.acceptanceBinding?.acceptanceId, "taccept_bind_1");

  const accepted = await request(api, {
    method: "POST",
    path: "/work-orders/workord_bind_1/accept",
    headers: { "x-idempotency-key": "work_order_accept_bind_1" },
    body: { acceptedByAgentId: sellerAgentId }
  });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const completed = await request(api, {
    method: "POST",
    path: "/work-orders/workord_bind_1/complete",
    headers: { "x-idempotency-key": "work_order_complete_bind_1" },
    body: {
      receiptId: "worec_bind_1",
      status: "success",
      outputs: { artifactRef: "artifact://analysis/1" },
      evidenceRefs: ["artifact://analysis/1"],
      amountCents: 400,
      currency: "USD",
      deliveredAt: "2026-02-24T00:30:00.000Z",
      completedAt: "2026-02-24T00:31:00.000Z"
    }
  });
  assert.equal(completed.statusCode, 200, completed.body);

  const settleMismatch = await request(api, {
    method: "POST",
    path: "/work-orders/workord_bind_1/settle",
    headers: { "x-idempotency-key": "work_order_settle_bind_mismatch_1" },
    body: {
      completionReceiptId: "worec_bind_1",
      x402GateId: "x402gate_bind_1",
      x402RunId: "run_bind_1",
      acceptanceHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  });
  assert.equal(settleMismatch.statusCode, 409, settleMismatch.body);
  assert.equal(settleMismatch.json?.code, "WORK_ORDER_SETTLEMENT_CONFLICT");
  assert.match(String(settleMismatch.json?.details?.message ?? ""), /acceptancehash/i);

  const settle = await request(api, {
    method: "POST",
    path: "/work-orders/workord_bind_1/settle",
    headers: { "x-idempotency-key": "work_order_settle_bind_ok_1" },
    body: {
      completionReceiptId: "worec_bind_1",
      x402GateId: "x402gate_bind_1",
      x402RunId: "run_bind_1",
      acceptanceHash: acceptance.json.taskAcceptance.acceptanceHash
    }
  });
  assert.equal(settle.statusCode, 200, settle.body);
  assert.equal(settle.json?.workOrder?.status, "settled");
});

test("API e2e: work-order settlement fails closed when acceptance binding is required and missing", async () => {
  const api = createApi({ opsToken: "tok_ops", workOrderRequireAcceptanceBinding: true });
  const buyerAgentId = "agt_task_bind_required_buyer_1";
  const sellerAgentId = "agt_task_bind_required_seller_1";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: ["analysis.generic"] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: ["analysis.generic"] });

  const workOrder = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "work_order_create_bind_required_1" },
    body: {
      workOrderId: "workord_bind_required_1",
      principalAgentId: buyerAgentId,
      subAgentId: sellerAgentId,
      requiredCapability: "analysis.generic",
      specification: { taskType: "analysis" },
      pricing: {
        amountCents: 275,
        currency: "USD"
      }
    }
  });
  assert.equal(workOrder.statusCode, 201, workOrder.body);

  const accepted = await request(api, {
    method: "POST",
    path: "/work-orders/workord_bind_required_1/accept",
    headers: { "x-idempotency-key": "work_order_accept_bind_required_1" },
    body: { acceptedByAgentId: sellerAgentId }
  });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const completed = await request(api, {
    method: "POST",
    path: "/work-orders/workord_bind_required_1/complete",
    headers: { "x-idempotency-key": "work_order_complete_bind_required_1" },
    body: {
      receiptId: "worec_bind_required_1",
      status: "success",
      outputs: { artifactRef: "artifact://analysis/acceptance-required/1" },
      evidenceRefs: ["artifact://analysis/acceptance-required/1"],
      amountCents: 275,
      currency: "USD",
      deliveredAt: "2026-02-28T02:00:00.000Z",
      completedAt: "2026-02-28T02:01:00.000Z"
    }
  });
  assert.equal(completed.statusCode, 200, completed.body);

  const blocked = await request(api, {
    method: "POST",
    path: "/work-orders/workord_bind_required_1/settle",
    headers: { "x-idempotency-key": "work_order_settle_bind_required_1" },
    body: {
      completionReceiptId: "worec_bind_required_1",
      completionReceiptHash: completed.json?.completionReceipt?.receiptHash,
      x402GateId: "x402gate_bind_required_1",
      x402RunId: "run_bind_required_1"
    }
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json?.code, "WORK_ORDER_SETTLEMENT_BLOCKED");
  assert.equal(blocked.json?.details?.reasonCode, "WORK_ORDER_ACCEPTANCE_BINDING_REQUIRED");
  assert.match(String(blocked.json?.details?.message ?? blocked.json?.message ?? ""), /acceptance binding is required/i);
});

test("API e2e: accepted intent binding propagates into work-order and receipt", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const buyerAgentId = "agt_task_intent_buyer_1";
  const sellerAgentId = "agt_task_intent_seller_1";
  const requiredCapability = "analysis.generic";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: [requiredCapability] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: [requiredCapability] });

  const intentContract = await proposeAndAcceptIntentContract(api, {
    intentId: "intent_task_bind_1",
    buyerAgentId,
    sellerAgentId,
    requiredCapability
  });
  assert.equal(intentContract?.status, "accepted");

  const quote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_intent_bind_1" },
    body: {
      quoteId: "tquote_intent_bind_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability,
      pricing: { amountCents: 500, currency: "USD" }
    }
  });
  assert.equal(quote.statusCode, 201, quote.body);

  const offer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_intent_bind_1" },
    body: {
      offerId: "toffer_intent_bind_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: {
        quoteId: "tquote_intent_bind_1",
        quoteHash: quote.json?.taskQuote?.quoteHash
      },
      pricing: { amountCents: 500, currency: "USD" }
    }
  });
  assert.equal(offer.statusCode, 201, offer.body);

  const acceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_intent_bind_1" },
    body: {
      acceptanceId: "taccept_intent_bind_1",
      quoteId: "tquote_intent_bind_1",
      offerId: "toffer_intent_bind_1",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(acceptance.statusCode, 201, acceptance.body);

  const workOrder = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "work_order_create_intent_bind_1" },
    body: {
      workOrderId: "workord_intent_bind_1",
      principalAgentId: buyerAgentId,
      subAgentId: sellerAgentId,
      requiredCapability,
      specification: { taskType: "analysis" },
      pricing: { amountCents: 500, currency: "USD", quoteId: "tquote_intent_bind_1" },
      acceptanceRef: {
        acceptanceId: "taccept_intent_bind_1",
        acceptanceHash: acceptance.json?.taskAcceptance?.acceptanceHash
      },
      intentBinding: {
        intentId: intentContract.intentId,
        intentHash: intentContract.intentHash
      }
    }
  });
  assert.equal(workOrder.statusCode, 201, workOrder.body);
  assert.equal(workOrder.json?.workOrder?.intentBinding?.intentHash, intentContract.intentHash);

  const accepted = await request(api, {
    method: "POST",
    path: "/work-orders/workord_intent_bind_1/accept",
    headers: { "x-idempotency-key": "work_order_accept_intent_bind_1" },
    body: { acceptedByAgentId: sellerAgentId }
  });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const completed = await request(api, {
    method: "POST",
    path: "/work-orders/workord_intent_bind_1/complete",
    headers: { "x-idempotency-key": "work_order_complete_intent_bind_1" },
    body: {
      receiptId: "worec_intent_bind_1",
      status: "success",
      outputs: { artifactRef: "artifact://analysis/intent/1" },
      evidenceRefs: ["artifact://analysis/intent/1"],
      amountCents: 500,
      currency: "USD",
      intentHash: intentContract.intentHash,
      deliveredAt: "2026-02-24T00:04:00.000Z",
      completedAt: "2026-02-24T00:05:00.000Z"
    }
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json?.completionReceipt?.intentHash, intentContract.intentHash);

  const settleMismatch = await request(api, {
    method: "POST",
    path: "/work-orders/workord_intent_bind_1/settle",
    headers: { "x-idempotency-key": "work_order_settle_intent_bind_mismatch_1" },
    body: {
      completionReceiptId: "worec_intent_bind_1",
      x402GateId: "x402gate_intent_bind_1",
      x402RunId: "run_intent_bind_1",
      intentHash: "f".repeat(64)
    }
  });
  assert.equal(settleMismatch.statusCode, 409, settleMismatch.body);
  assert.equal(settleMismatch.json?.code, "INTENT_CONTRACT_HASH_MISMATCH");
  assert.match(String(settleMismatch.json?.details?.message ?? ""), /intenthash/i);

  const settle = await request(api, {
    method: "POST",
    path: "/work-orders/workord_intent_bind_1/settle",
    headers: { "x-idempotency-key": "work_order_settle_intent_bind_ok_1" },
    body: {
      completionReceiptId: "worec_intent_bind_1",
      x402GateId: "x402gate_intent_bind_1",
      x402RunId: "run_intent_bind_1",
      intentHash: intentContract.intentHash
    }
  });
  assert.equal(settle.statusCode, 200, settle.body);
});

test("API e2e: work-order creation fails closed when intent binding is required and missing", async () => {
  const api = createApi({ opsToken: "tok_ops", workOrderRequireIntentBinding: true });
  const buyerAgentId = "agt_task_intent_required_buyer_1";
  const sellerAgentId = "agt_task_intent_required_seller_1";
  const requiredCapability = "analysis.generic";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: [requiredCapability] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: [requiredCapability] });

  const quote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_intent_required_1" },
    body: {
      quoteId: "tquote_intent_required_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability,
      pricing: { amountCents: 250, currency: "USD" }
    }
  });
  assert.equal(quote.statusCode, 201, quote.body);

  const offer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_intent_required_1" },
    body: {
      offerId: "toffer_intent_required_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: {
        quoteId: "tquote_intent_required_1",
        quoteHash: quote.json?.taskQuote?.quoteHash
      },
      pricing: { amountCents: 250, currency: "USD" }
    }
  });
  assert.equal(offer.statusCode, 201, offer.body);

  const acceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_intent_required_1" },
    body: {
      acceptanceId: "taccept_intent_required_1",
      quoteId: "tquote_intent_required_1",
      offerId: "toffer_intent_required_1",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(acceptance.statusCode, 201, acceptance.body);

  const blocked = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "work_order_create_intent_required_1" },
    body: {
      workOrderId: "workord_intent_required_1",
      principalAgentId: buyerAgentId,
      subAgentId: sellerAgentId,
      requiredCapability,
      specification: { taskType: "analysis" },
      pricing: { amountCents: 250, currency: "USD" },
      acceptanceRef: {
        acceptanceId: "taccept_intent_required_1",
        acceptanceHash: acceptance.json?.taskAcceptance?.acceptanceHash
      },
      requireAcceptedIntentHash: true
    }
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json?.code, "WORK_ORDER_INTENT_BINDING_REQUIRED");
  assert.equal(blocked.json?.details?.reasonCode, "WORK_ORDER_INTENT_BINDING_REQUIRED");
});

test("API e2e: task negotiation routes fail closed when participant lifecycle is non-active", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const buyerAgentId = "agt_task_neg_lifecycle_buyer_1";
  const sellerAgentId = "agt_task_neg_lifecycle_seller_1";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: ["analysis.generic"] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: ["analysis.generic"] });

  const suspendBuyer = await setX402AgentLifecycle(api, {
    agentId: buyerAgentId,
    status: "suspended",
    reasonCode: "X402_AGENT_SUSPENDED_MANUAL",
    idempotencyKey: "task_neg_lifecycle_suspend_buyer_1"
  });
  assert.equal(suspendBuyer.statusCode, 200, suspendBuyer.body);
  assert.equal(suspendBuyer.json?.lifecycle?.status, "suspended");

  const blockedQuote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_lifecycle_block_1" },
    body: {
      quoteId: "tquote_lifecycle_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      pricing: { amountCents: 500, currency: "USD" }
    }
  });
  assert.equal(blockedQuote.statusCode, 410, blockedQuote.body);
  assert.equal(blockedQuote.json?.code, "X402_AGENT_SUSPENDED");
  assert.equal(blockedQuote.json?.details?.role, "buyer");
  assert.equal(blockedQuote.json?.details?.operation, "task_quote.issue");

  const reactivateBuyer = await setX402AgentLifecycle(api, {
    agentId: buyerAgentId,
    status: "active",
    reasonCode: "X402_AGENT_ACTIVE_MANUAL",
    idempotencyKey: "task_neg_lifecycle_reactivate_buyer_1"
  });
  assert.equal(reactivateBuyer.statusCode, 200, reactivateBuyer.body);
  assert.equal(reactivateBuyer.json?.lifecycle?.status, "active");

  const quote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_lifecycle_ok_1" },
    body: {
      quoteId: "tquote_lifecycle_2",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      pricing: { amountCents: 500, currency: "USD" }
    }
  });
  assert.equal(quote.statusCode, 201, quote.body);

  const throttleSeller = await setX402AgentLifecycle(api, {
    agentId: sellerAgentId,
    status: "throttled",
    reasonCode: "X402_AGENT_THROTTLED_MANUAL",
    idempotencyKey: "task_neg_lifecycle_throttle_seller_1"
  });
  assert.equal(throttleSeller.statusCode, 200, throttleSeller.body);
  assert.equal(throttleSeller.json?.lifecycle?.status, "throttled");

  const blockedOffer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_lifecycle_block_1" },
    body: {
      offerId: "toffer_lifecycle_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: {
        quoteId: "tquote_lifecycle_2",
        quoteHash: quote.json?.taskQuote?.quoteHash
      },
      pricing: { amountCents: 500, currency: "USD" }
    }
  });
  assert.equal(blockedOffer.statusCode, 429, blockedOffer.body);
  assert.equal(blockedOffer.json?.code, "X402_AGENT_THROTTLED");
  assert.equal(blockedOffer.json?.details?.role, "seller");
  assert.equal(blockedOffer.json?.details?.operation, "task_offer.issue");

  const reactivateSeller = await setX402AgentLifecycle(api, {
    agentId: sellerAgentId,
    status: "active",
    reasonCode: "X402_AGENT_ACTIVE_MANUAL",
    idempotencyKey: "task_neg_lifecycle_reactivate_seller_1"
  });
  assert.equal(reactivateSeller.statusCode, 200, reactivateSeller.body);
  assert.equal(reactivateSeller.json?.lifecycle?.status, "active");

  const offer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_lifecycle_ok_1" },
    body: {
      offerId: "toffer_lifecycle_2",
      buyerAgentId,
      sellerAgentId,
      quoteRef: {
        quoteId: "tquote_lifecycle_2",
        quoteHash: quote.json?.taskQuote?.quoteHash
      },
      pricing: { amountCents: 500, currency: "USD" }
    }
  });
  assert.equal(offer.statusCode, 201, offer.body);

  const suspendSeller = await setX402AgentLifecycle(api, {
    agentId: sellerAgentId,
    status: "suspended",
    reasonCode: "X402_AGENT_SUSPENDED_MANUAL",
    idempotencyKey: "task_neg_lifecycle_suspend_seller_1"
  });
  assert.equal(suspendSeller.statusCode, 200, suspendSeller.body);
  assert.equal(suspendSeller.json?.lifecycle?.status, "suspended");

  const blockedAcceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_lifecycle_block_1" },
    body: {
      acceptanceId: "taccept_lifecycle_1",
      quoteId: "tquote_lifecycle_2",
      offerId: "toffer_lifecycle_2",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(blockedAcceptance.statusCode, 410, blockedAcceptance.body);
  assert.equal(blockedAcceptance.json?.code, "X402_AGENT_SUSPENDED");
  assert.equal(blockedAcceptance.json?.details?.role, "seller");
  assert.equal(blockedAcceptance.json?.details?.operation, "task_acceptance.issue");
});

test("API e2e: traceId propagates quote->offer->acceptance->work-order->receipt->settlement", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const buyerAgentId = "agt_task_trace_buyer_1";
  const sellerAgentId = "agt_task_trace_seller_1";
  const traceId = "trace_task_flow_1";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: ["analysis.generic"] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: ["analysis.generic"] });

  const quote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_trace_1" },
    body: {
      quoteId: "tquote_trace_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      traceId,
      pricing: { amountCents: 350, currency: "USD" }
    }
  });
  assert.equal(quote.statusCode, 201, quote.body);
  assert.equal(quote.json?.taskQuote?.traceId, traceId);

  const offer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_trace_1" },
    body: {
      offerId: "toffer_trace_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: { quoteId: "tquote_trace_1", quoteHash: quote.json?.taskQuote?.quoteHash },
      pricing: { amountCents: 350, currency: "USD" }
    }
  });
  assert.equal(offer.statusCode, 201, offer.body);
  assert.equal(offer.json?.taskOffer?.traceId, traceId);

  const acceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_trace_1" },
    body: {
      acceptanceId: "taccept_trace_1",
      quoteId: "tquote_trace_1",
      offerId: "toffer_trace_1",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(acceptance.statusCode, 201, acceptance.body);
  assert.equal(acceptance.json?.taskAcceptance?.traceId, traceId);

  const workOrder = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "work_order_create_trace_1" },
    body: {
      workOrderId: "workord_trace_1",
      principalAgentId: buyerAgentId,
      subAgentId: sellerAgentId,
      requiredCapability: "analysis.generic",
      specification: { taskType: "analysis" },
      pricing: { amountCents: 350, currency: "USD", quoteId: "tquote_trace_1" },
      acceptanceRef: {
        acceptanceId: "taccept_trace_1",
        acceptanceHash: acceptance.json?.taskAcceptance?.acceptanceHash
      }
    }
  });
  assert.equal(workOrder.statusCode, 201, workOrder.body);
  assert.equal(workOrder.json?.workOrder?.traceId, traceId);

  const accepted = await request(api, {
    method: "POST",
    path: "/work-orders/workord_trace_1/accept",
    headers: { "x-idempotency-key": "work_order_accept_trace_1" },
    body: { acceptedByAgentId: sellerAgentId }
  });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const completed = await request(api, {
    method: "POST",
    path: "/work-orders/workord_trace_1/complete",
    headers: { "x-idempotency-key": "work_order_complete_trace_1" },
    body: {
      receiptId: "worec_trace_1",
      status: "success",
      outputs: { artifactRef: "artifact://analysis/trace/1" },
      evidenceRefs: ["artifact://analysis/trace/1"],
      amountCents: 350,
      currency: "USD",
      deliveredAt: "2026-02-24T01:30:00.000Z",
      completedAt: "2026-02-24T01:31:00.000Z"
    }
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json?.completionReceipt?.traceId, traceId);

  const settled = await request(api, {
    method: "POST",
    path: "/work-orders/workord_trace_1/settle",
    headers: { "x-idempotency-key": "work_order_settle_trace_1" },
    body: {
      completionReceiptId: "worec_trace_1",
      completionReceiptHash: completed.json?.completionReceipt?.receiptHash,
      x402GateId: "x402gate_trace_1",
      x402RunId: "run_trace_1",
      settledAt: "2026-02-24T01:40:00.000Z"
    }
  });
  assert.equal(settled.statusCode, 200, settled.body);
  assert.equal(settled.json?.workOrder?.settlement?.traceId, traceId);
});

test("API e2e: traceId mismatches fail closed across negotiation and work-order creation", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const buyerAgentId = "agt_task_trace_mismatch_buyer_1";
  const sellerAgentId = "agt_task_trace_mismatch_seller_1";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: ["analysis.generic"] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: ["analysis.generic"] });

  const quote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_trace_mismatch_1" },
    body: {
      quoteId: "tquote_trace_mismatch_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      traceId: "trace_alpha",
      pricing: { amountCents: 275, currency: "USD" }
    }
  });
  assert.equal(quote.statusCode, 201, quote.body);

  const blockedOffer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_trace_mismatch_block_1" },
    body: {
      offerId: "toffer_trace_mismatch_block_1",
      buyerAgentId,
      sellerAgentId,
      traceId: "trace_beta",
      quoteRef: { quoteId: "tquote_trace_mismatch_1", quoteHash: quote.json?.taskQuote?.quoteHash },
      pricing: { amountCents: 275, currency: "USD" }
    }
  });
  assert.equal(blockedOffer.statusCode, 409, blockedOffer.body);
  assert.equal(blockedOffer.json?.code, "TASK_TRACE_ID_MISMATCH");

  const standaloneOffer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_trace_mismatch_standalone_1" },
    body: {
      offerId: "toffer_trace_mismatch_standalone_1",
      buyerAgentId,
      sellerAgentId,
      traceId: "trace_beta",
      pricing: { amountCents: 275, currency: "USD" }
    }
  });
  assert.equal(standaloneOffer.statusCode, 201, standaloneOffer.body);

  const blockedAcceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_trace_mismatch_block_1" },
    body: {
      acceptanceId: "taccept_trace_mismatch_block_1",
      quoteId: "tquote_trace_mismatch_1",
      offerId: "toffer_trace_mismatch_standalone_1",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(blockedAcceptance.statusCode, 409, blockedAcceptance.body);
  assert.equal(blockedAcceptance.json?.code, "TASK_NEGOTIATION_TRACE_MISMATCH");

  const alignedOffer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_trace_mismatch_aligned_1" },
    body: {
      offerId: "toffer_trace_mismatch_aligned_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: { quoteId: "tquote_trace_mismatch_1", quoteHash: quote.json?.taskQuote?.quoteHash },
      pricing: { amountCents: 275, currency: "USD" }
    }
  });
  assert.equal(alignedOffer.statusCode, 201, alignedOffer.body);

  const acceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_trace_mismatch_ok_1" },
    body: {
      acceptanceId: "taccept_trace_mismatch_ok_1",
      quoteId: "tquote_trace_mismatch_1",
      offerId: "toffer_trace_mismatch_aligned_1",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(acceptance.statusCode, 201, acceptance.body);

  const blockedWorkOrder = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "work_order_create_trace_mismatch_block_1" },
    body: {
      workOrderId: "workord_trace_mismatch_1",
      principalAgentId: buyerAgentId,
      subAgentId: sellerAgentId,
      requiredCapability: "analysis.generic",
      traceId: "trace_other",
      specification: { taskType: "analysis" },
      pricing: { amountCents: 275, currency: "USD", quoteId: "tquote_trace_mismatch_1" },
      acceptanceRef: {
        acceptanceId: "taccept_trace_mismatch_ok_1",
        acceptanceHash: acceptance.json?.taskAcceptance?.acceptanceHash
      }
    }
  });
  assert.equal(blockedWorkOrder.statusCode, 409, blockedWorkOrder.body);
  assert.equal(blockedWorkOrder.json?.code, "WORK_ORDER_TRACE_ID_MISMATCH");
});

test("API e2e: task acceptance fails closed when offer quote binding mismatches requested quote", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const buyerAgentId = "agt_task_quote_offer_mismatch_buyer_1";
  const sellerAgentId = "agt_task_quote_offer_mismatch_seller_1";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: ["analysis.generic"] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: ["analysis.generic"] });

  const quoteA = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_offer_mismatch_a_1" },
    body: {
      quoteId: "tquote_offer_mismatch_a_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      pricing: { amountCents: 325, currency: "USD" }
    }
  });
  assert.equal(quoteA.statusCode, 201, quoteA.body);

  const quoteB = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_offer_mismatch_b_1" },
    body: {
      quoteId: "tquote_offer_mismatch_b_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      pricing: { amountCents: 325, currency: "USD" }
    }
  });
  assert.equal(quoteB.statusCode, 201, quoteB.body);

  const offer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_offer_mismatch_1" },
    body: {
      offerId: "toffer_offer_mismatch_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: {
        quoteId: "tquote_offer_mismatch_a_1",
        quoteHash: quoteA.json?.taskQuote?.quoteHash
      },
      pricing: { amountCents: 325, currency: "USD" }
    }
  });
  assert.equal(offer.statusCode, 201, offer.body);

  const blockedAcceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_offer_mismatch_block_1" },
    body: {
      acceptanceId: "taccept_offer_mismatch_1",
      quoteId: "tquote_offer_mismatch_b_1",
      offerId: "toffer_offer_mismatch_1",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(blockedAcceptance.statusCode, 409, blockedAcceptance.body);
  assert.equal(blockedAcceptance.json?.code, "TASK_QUOTE_OFFER_MISMATCH");
  assert.equal(blockedAcceptance.json?.details?.offerQuoteId, "tquote_offer_mismatch_a_1");
  assert.equal(blockedAcceptance.json?.details?.quoteId, "tquote_offer_mismatch_b_1");
});

test("API e2e: task acceptance create is idempotent and conflict-safe", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const buyerAgentId = "agt_task_acceptance_idem_buyer_1";
  const sellerAgentId = "agt_task_acceptance_idem_seller_1";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: ["analysis.generic"] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: ["analysis.generic"] });

  const quote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_acceptance_idem_1" },
    body: {
      quoteId: "tquote_acceptance_idem_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      pricing: { amountCents: 410, currency: "USD" }
    }
  });
  assert.equal(quote.statusCode, 201, quote.body);

  const offer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_acceptance_idem_1" },
    body: {
      offerId: "toffer_acceptance_idem_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: {
        quoteId: "tquote_acceptance_idem_1",
        quoteHash: quote.json?.taskQuote?.quoteHash
      },
      pricing: { amountCents: 410, currency: "USD" }
    }
  });
  assert.equal(offer.statusCode, 201, offer.body);

  const createBody = {
    acceptanceId: "taccept_acceptance_idem_1",
    quoteId: "tquote_acceptance_idem_1",
    offerId: "toffer_acceptance_idem_1",
    acceptedByAgentId: buyerAgentId
  };

  const created = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_idem_replay_1" },
    body: createBody
  });
  assert.equal(created.statusCode, 201, created.body);

  const replay = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_idem_replay_1" },
    body: createBody
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json?.taskAcceptance?.acceptanceId, "taccept_acceptance_idem_1");
  assert.equal(replay.json?.taskAcceptance?.acceptanceHash, created.json?.taskAcceptance?.acceptanceHash);

  const conflicted = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_idem_replay_1" },
    body: {
      ...createBody,
      acceptanceId: "taccept_acceptance_idem_conflict_1"
    }
  });
  assert.equal(conflicted.statusCode, 409, conflicted.body);
  assert.match(
    String(conflicted.json?.message ?? conflicted.json?.error ?? conflicted.body ?? ""),
    /idempotency key conflict/i
  );
});

test("API e2e: work-order settlement fails closed when bound acceptance record is missing", async () => {
  const store = createStore();
  const api = createApi({ store, opsToken: "tok_ops" });
  const buyerAgentId = "agt_task_acceptance_missing_buyer_1";
  const sellerAgentId = "agt_task_acceptance_missing_seller_1";
  await registerAgent(api, { agentId: buyerAgentId, capabilities: ["analysis.generic"] });
  await registerAgent(api, { agentId: sellerAgentId, capabilities: ["analysis.generic"] });

  const quote = await request(api, {
    method: "POST",
    path: "/task-quotes",
    headers: { "x-idempotency-key": "task_quote_issue_acceptance_missing_1" },
    body: {
      quoteId: "tquote_acceptance_missing_1",
      buyerAgentId,
      sellerAgentId,
      requiredCapability: "analysis.generic",
      pricing: { amountCents: 290, currency: "USD" }
    }
  });
  assert.equal(quote.statusCode, 201, quote.body);

  const offer = await request(api, {
    method: "POST",
    path: "/task-offers",
    headers: { "x-idempotency-key": "task_offer_issue_acceptance_missing_1" },
    body: {
      offerId: "toffer_acceptance_missing_1",
      buyerAgentId,
      sellerAgentId,
      quoteRef: {
        quoteId: "tquote_acceptance_missing_1",
        quoteHash: quote.json?.taskQuote?.quoteHash
      },
      pricing: { amountCents: 290, currency: "USD" }
    }
  });
  assert.equal(offer.statusCode, 201, offer.body);

  const acceptance = await request(api, {
    method: "POST",
    path: "/task-acceptances",
    headers: { "x-idempotency-key": "task_acceptance_issue_acceptance_missing_1" },
    body: {
      acceptanceId: "taccept_acceptance_missing_1",
      quoteId: "tquote_acceptance_missing_1",
      offerId: "toffer_acceptance_missing_1",
      acceptedByAgentId: buyerAgentId
    }
  });
  assert.equal(acceptance.statusCode, 201, acceptance.body);

  const workOrder = await request(api, {
    method: "POST",
    path: "/work-orders",
    headers: { "x-idempotency-key": "work_order_create_acceptance_missing_1" },
    body: {
      workOrderId: "workord_acceptance_missing_1",
      principalAgentId: buyerAgentId,
      subAgentId: sellerAgentId,
      requiredCapability: "analysis.generic",
      specification: { taskType: "analysis" },
      pricing: { amountCents: 290, currency: "USD", quoteId: "tquote_acceptance_missing_1" },
      acceptanceRef: {
        acceptanceId: "taccept_acceptance_missing_1",
        acceptanceHash: acceptance.json?.taskAcceptance?.acceptanceHash
      }
    }
  });
  assert.equal(workOrder.statusCode, 201, workOrder.body);

  const accepted = await request(api, {
    method: "POST",
    path: "/work-orders/workord_acceptance_missing_1/accept",
    headers: { "x-idempotency-key": "work_order_accept_acceptance_missing_1" },
    body: {
      acceptedByAgentId: sellerAgentId
    }
  });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const completed = await request(api, {
    method: "POST",
    path: "/work-orders/workord_acceptance_missing_1/complete",
    headers: { "x-idempotency-key": "work_order_complete_acceptance_missing_1" },
    body: {
      receiptId: "worec_acceptance_missing_1",
      status: "success",
      outputs: { artifactRef: "artifact://analysis/acceptance-missing/1" },
      evidenceRefs: ["artifact://analysis/acceptance-missing/1"],
      amountCents: 290,
      currency: "USD",
      deliveredAt: "2026-02-28T01:20:00.000Z",
      completedAt: "2026-02-28T01:21:00.000Z"
    }
  });
  assert.equal(completed.statusCode, 200, completed.body);

  for (const [key, row] of store.taskAcceptances.entries()) {
    if (String(row?.acceptanceId ?? "") === "taccept_acceptance_missing_1") {
      store.taskAcceptances.delete(key);
    }
  }

  const blocked = await request(api, {
    method: "POST",
    path: "/work-orders/workord_acceptance_missing_1/settle",
    headers: { "x-idempotency-key": "work_order_settle_acceptance_missing_1" },
    body: {
      completionReceiptId: "worec_acceptance_missing_1",
      completionReceiptHash: completed.json?.completionReceipt?.receiptHash,
      x402GateId: "x402gate_acceptance_missing_1",
      x402RunId: "run_acceptance_missing_1"
    }
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json?.code, "WORK_ORDER_SETTLEMENT_BLOCKED");
  assert.match(
    String(blocked.json?.details?.message ?? blocked.json?.message ?? blocked.body ?? ""),
    /bound task acceptance not found/i
  );
});
