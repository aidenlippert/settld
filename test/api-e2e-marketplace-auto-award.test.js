import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, agentId) {
  const publicKeyPem = createEd25519Keypair().publicKeyPem;
  const response = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `register_${agentId}` },
    body: {
      agentId,
      displayName: agentId,
      owner: { ownerType: "service", ownerId: "svc_market_auto_award" },
      publicKeyPem,
      capabilities: ["translate", "summarize"]
    }
  });
  assert.equal(response.statusCode, 201);
}

async function creditWallet(api, { agentId, amountCents, idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/wallet/credit`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: { amountCents, currency: "USD" }
  });
  assert.equal(response.statusCode, 201);
}

async function createRfq(api, { rfqId, posterAgentId, budgetCents }) {
  const response = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": `create_${rfqId}` },
    body: {
      rfqId,
      title: `Task ${rfqId}`,
      capability: "translate",
      posterAgentId,
      budgetCents,
      currency: "USD"
    }
  });
  assert.equal(response.statusCode, 201);
}

async function submitBid(api, { rfqId, bidId, bidderAgentId, amountCents, etaSeconds }) {
  const response = await request(api, {
    method: "POST",
    path: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`,
    headers: { "x-idempotency-key": `create_${bidId}` },
    body: {
      bidId,
      bidderAgentId,
      amountCents,
      currency: "USD",
      etaSeconds
    }
  });
  assert.equal(response.statusCode, 201);
}

test("API e2e: marketplace auto-accept selects the cheapest unique bid and is idempotent", async () => {
  const api = createApi();
  await registerAgent(api, "agt_auto_poster");
  await registerAgent(api, "agt_auto_bidder_a");
  await registerAgent(api, "agt_auto_bidder_b");
  await registerAgent(api, "agt_auto_operator");
  await creditWallet(api, {
    agentId: "agt_auto_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_auto_poster"
  });

  await createRfq(api, {
    rfqId: "rfq_auto_accept_1",
    posterAgentId: "agt_auto_poster",
    budgetCents: 2500
  });
  await submitBid(api, {
    rfqId: "rfq_auto_accept_1",
    bidId: "bid_auto_accept_a",
    bidderAgentId: "agt_auto_bidder_a",
    amountCents: 2200,
    etaSeconds: 1500
  });
  await submitBid(api, {
    rfqId: "rfq_auto_accept_1",
    bidId: "bid_auto_accept_b",
    bidderAgentId: "agt_auto_bidder_b",
    amountCents: 1900,
    etaSeconds: 1800
  });

  const autoAccept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_auto_accept_1/auto-accept",
    headers: { "x-idempotency-key": "market_auto_accept_1" },
    body: {
      acceptedByAgentId: "agt_auto_operator"
    }
  });
  assert.equal(autoAccept.statusCode, 200);
  assert.equal(autoAccept.json?.decision?.outcome, "selected");
  assert.equal(autoAccept.json?.decision?.selectedBidId, "bid_auto_accept_b");
  assert.equal(autoAccept.json?.rfq?.acceptedBidId, "bid_auto_accept_b");
  assert.equal(autoAccept.json?.acceptedBid?.bidId, "bid_auto_accept_b");
  assert.equal(autoAccept.json?.acceptedBid?.status, "accepted");
  assert.equal(autoAccept.json?.run?.agentId, "agt_auto_bidder_b");
  assert.equal(autoAccept.json?.settlement?.amountCents, 1900);

  const replay = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_auto_accept_1/auto-accept",
    headers: { "x-idempotency-key": "market_auto_accept_1" },
    body: {
      acceptedByAgentId: "agt_auto_operator"
    }
  });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json, autoAccept.json);
});

test("API e2e: marketplace auto-accept fails closed when the best bids are ambiguous", async () => {
  const api = createApi();
  await registerAgent(api, "agt_auto_amb_poster");
  await registerAgent(api, "agt_auto_amb_bidder_a");
  await registerAgent(api, "agt_auto_amb_bidder_b");
  await creditWallet(api, {
    agentId: "agt_auto_amb_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_auto_amb_poster"
  });

  await createRfq(api, {
    rfqId: "rfq_auto_ambiguous_1",
    posterAgentId: "agt_auto_amb_poster",
    budgetCents: 2500
  });
  await submitBid(api, {
    rfqId: "rfq_auto_ambiguous_1",
    bidId: "bid_auto_ambiguous_a",
    bidderAgentId: "agt_auto_amb_bidder_a",
    amountCents: 1900,
    etaSeconds: 900
  });
  await submitBid(api, {
    rfqId: "rfq_auto_ambiguous_1",
    bidId: "bid_auto_ambiguous_b",
    bidderAgentId: "agt_auto_amb_bidder_b",
    amountCents: 1900,
    etaSeconds: 900
  });

  const blocked = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_auto_ambiguous_1/auto-accept",
    body: {}
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json?.code, "MARKETPLACE_AUTO_AWARD_AMBIGUOUS");
  assert.equal(blocked.json?.error, "marketplace auto-award blocked");
  assert.equal(blocked.json?.details?.decision?.outcome, "blocked");
  assert.deepEqual(blocked.json?.details?.decision?.tiedBidIds, [
    "bid_auto_ambiguous_a",
    "bid_auto_ambiguous_b"
  ]);
});

test("API e2e: marketplace auto-accept blocks over-budget selection unless explicitly allowed", async () => {
  const api = createApi();
  await registerAgent(api, "agt_auto_budget_poster");
  await registerAgent(api, "agt_auto_budget_bidder");
  await creditWallet(api, {
    agentId: "agt_auto_budget_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_auto_budget_poster"
  });

  await createRfq(api, {
    rfqId: "rfq_auto_budget_1",
    posterAgentId: "agt_auto_budget_poster",
    budgetCents: 1500
  });
  await submitBid(api, {
    rfqId: "rfq_auto_budget_1",
    bidId: "bid_auto_budget_1",
    bidderAgentId: "agt_auto_budget_bidder",
    amountCents: 1900,
    etaSeconds: 600
  });

  const blocked = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_auto_budget_1/auto-accept",
    body: {}
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json?.code, "MARKETPLACE_AUTO_AWARD_OVER_BUDGET");
  assert.equal(blocked.json?.details?.decision?.selectedBidId, "bid_auto_budget_1");

  const allowed = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_auto_budget_1/auto-accept",
    headers: { "x-idempotency-key": "market_auto_budget_allow_1" },
    body: {
      allowOverBudget: true
    }
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json?.decision?.outcome, "selected");
  assert.equal(allowed.json?.decision?.allowOverBudget, true);
  assert.equal(allowed.json?.acceptedBid?.bidId, "bid_auto_budget_1");
});
