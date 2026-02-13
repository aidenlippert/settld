import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { agentId }) {
  const { publicKeyPem } = createEd25519Keypair();
  const created = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `agent_register_${agentId}` },
    body: {
      agentId,
      displayName: `Agent ${agentId}`,
      owner: { ownerType: "service", ownerId: "svc_settlement" },
      publicKeyPem
    }
  });
  assert.equal(created.statusCode, 201);
  return agentId;
}

async function creditWallet(api, { agentId, amountCents, idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/wallet/credit`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: { amountCents, currency: "USD" }
  });
  assert.equal(response.statusCode, 201);
  return response.json.wallet;
}

async function getReputationFacts(api, { agentId, tenantId = "tenant_default", toolId = null, window = "allTime" } = {}) {
  const qs = new URLSearchParams({ agentId, window });
  if (toolId) qs.set("toolId", toolId);
  const response = await request(api, {
    method: "GET",
    path: `/ops/reputation/facts?${qs.toString()}`,
    headers: { "x-proxy-tenant-id": tenantId, "x-proxy-ops-token": "tok_ops" }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json;
}

test("API e2e: run completion releases escrow to payee wallet", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const payerAgentId = await registerAgent(api, { agentId: "agt_wallet_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_wallet_payee_1" });

  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_1" });

  const createdRun = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: { "x-idempotency-key": "run_wallet_release_1" },
    body: {
      runId: "run_wallet_release_1",
      taskType: "classification",
      settlement: {
        payerAgentId,
        amountCents: 1250,
        currency: "USD"
      }
    }
  });
  assert.equal(createdRun.statusCode, 201);
  assert.equal(createdRun.json?.settlement?.status, "locked");
  assert.equal(createdRun.json?.settlement?.amountCents, 1250);

  const payerAfterLock = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(payerAfterLock.statusCode, 200);
  assert.equal(payerAfterLock.json?.wallet?.availableCents, 3750);
  assert.equal(payerAfterLock.json?.wallet?.escrowLockedCents, 1250);

  const append = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs/run_wallet_release_1/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": createdRun.json?.run?.lastChainHash,
      "x-idempotency-key": "run_wallet_release_complete_1"
    },
    body: { type: "RUN_COMPLETED", payload: { outputRef: "evidence://run_wallet_release_1/output.json" } }
  });
  assert.equal(append.statusCode, 201);
  assert.equal(append.json?.run?.status, "completed");
  assert.equal(append.json?.settlement?.status, "released");
  assert.equal(append.json?.settlement?.runStatus, "completed");

  const payerAfterRelease = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(payerAfterRelease.statusCode, 200);
  assert.equal(payerAfterRelease.json?.wallet?.availableCents, 3750);
  assert.equal(payerAfterRelease.json?.wallet?.escrowLockedCents, 0);
  assert.equal(payerAfterRelease.json?.wallet?.totalDebitedCents, 1250);

  const payeeAfterRelease = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payeeAgentId)}/wallet` });
  assert.equal(payeeAfterRelease.statusCode, 200);
  assert.equal(payeeAfterRelease.json?.wallet?.availableCents, 1250);
  assert.equal(payeeAfterRelease.json?.wallet?.escrowLockedCents, 0);

  const settlement = await request(api, { method: "GET", path: "/runs/run_wallet_release_1/settlement" });
  assert.equal(settlement.statusCode, 200);
  assert.equal(settlement.json?.settlement?.status, "released");

  const reputation = await getReputationFacts(api, { agentId: payeeAgentId });
  assert.equal(reputation?.facts?.totals?.decisions?.approved, 1);
  assert.equal(reputation?.facts?.totals?.decisions?.rejected, 0);
});

test("API e2e: run failure refunds escrow to payer wallet", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const payerAgentId = await registerAgent(api, { agentId: "agt_wallet_payer_2" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_wallet_payee_2" });

  await creditWallet(api, { agentId: payerAgentId, amountCents: 3000, idempotencyKey: "wallet_credit_2" });

  const createdRun = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: { "x-idempotency-key": "run_wallet_refund_1" },
    body: {
      runId: "run_wallet_refund_1",
      taskType: "extraction",
      settlement: {
        payerAgentId,
        amountCents: 900,
        currency: "USD"
      }
    }
  });
  assert.equal(createdRun.statusCode, 201);
  assert.equal(createdRun.json?.settlement?.status, "locked");

  const append = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs/run_wallet_refund_1/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": createdRun.json?.run?.lastChainHash,
      "x-idempotency-key": "run_wallet_refund_fail_1"
    },
    body: { type: "RUN_FAILED", payload: { code: "MODEL_TIMEOUT", message: "timeout" } }
  });
  assert.equal(append.statusCode, 201);
  assert.equal(append.json?.run?.status, "failed");
  assert.equal(append.json?.settlement?.status, "refunded");
  assert.equal(append.json?.settlement?.runStatus, "failed");

  const payerWallet = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(payerWallet.statusCode, 200);
  assert.equal(payerWallet.json?.wallet?.availableCents, 3000);
  assert.equal(payerWallet.json?.wallet?.escrowLockedCents, 0);
  assert.equal(payerWallet.json?.wallet?.totalDebitedCents, 0);

  const payeeWallet = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payeeAgentId)}/wallet` });
  assert.equal(payeeWallet.statusCode, 200);
  assert.equal(payeeWallet.json?.wallet?.availableCents, 0);

  const reputation = await getReputationFacts(api, { agentId: payeeAgentId });
  assert.equal(reputation?.facts?.totals?.decisions?.approved, 0);
  assert.equal(reputation?.facts?.totals?.decisions?.rejected, 1);
});

test("API e2e: partial completion releases a portion and refunds the rest", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const payerAgentId = await registerAgent(api, { agentId: "agt_wallet_payer_partial_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_wallet_payee_partial_1" });

  await creditWallet(api, { agentId: payerAgentId, amountCents: 4000, idempotencyKey: "wallet_credit_partial_1" });

  const createdRun = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: { "x-idempotency-key": "run_wallet_partial_1" },
    body: {
      runId: "run_wallet_partial_1",
      taskType: "translation",
      settlement: {
        payerAgentId,
        amountCents: 1000,
        currency: "USD"
      }
    }
  });
  assert.equal(createdRun.statusCode, 201);
  assert.equal(createdRun.json?.settlement?.status, "locked");

  const completed = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs/run_wallet_partial_1/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": createdRun.json?.run?.lastChainHash,
      "x-idempotency-key": "run_wallet_partial_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: "evidence://run_wallet_partial_1/output.json",
        metrics: { settlementReleaseRatePct: 60 }
      }
    }
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json?.settlement?.status, "released");
  assert.equal(completed.json?.settlement?.releasedAmountCents, 600);
  assert.equal(completed.json?.settlement?.refundedAmountCents, 400);
  assert.equal(completed.json?.settlement?.releaseRatePct, 60);

  const payerWallet = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(payerWallet.statusCode, 200);
  assert.equal(payerWallet.json?.wallet?.availableCents, 3400);
  assert.equal(payerWallet.json?.wallet?.escrowLockedCents, 0);
  assert.equal(payerWallet.json?.wallet?.totalDebitedCents, 600);

  const payeeWallet = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payeeAgentId)}/wallet` });
  assert.equal(payeeWallet.statusCode, 200);
  assert.equal(payeeWallet.json?.wallet?.availableCents, 600);

  const verification = await request(api, { method: "GET", path: "/runs/run_wallet_partial_1/verification" });
  assert.equal(verification.statusCode, 200);
  assert.equal(verification.json?.verification?.verificationStatus, "amber");
  assert.equal(verification.json?.verification?.settlementReleaseRatePct, 60);

  const reputation = await getReputationFacts(api, { agentId: payeeAgentId });
  assert.equal(reputation?.facts?.totals?.decisions?.approved, 1);
  assert.equal(reputation?.facts?.totals?.economics?.settledCents, 600);
  assert.equal(reputation?.facts?.totals?.economics?.refundedCents, 400);
});
