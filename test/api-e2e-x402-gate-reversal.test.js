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
      owner: { ownerType: "service", ownerId: "svc_test" },
      publicKeyPem
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  return agentId;
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

function autoPolicy100() {
  return {
    mode: "automatic",
    rules: {
      autoReleaseOnGreen: true,
      greenReleaseRatePct: 100,
      autoReleaseOnAmber: false,
      amberReleaseRatePct: 0,
      autoReleaseOnRed: true,
      redReleaseRatePct: 0
    }
  };
}

test("API e2e: x402 reversal void_authorization refunds locked gate before execution", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_void_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_void_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_void_1" });

  const gateId = "x402gate_void_1";
  const amountCents = 500;
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_void_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD",
      toolId: "mock_search"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authorize_void_1" },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const voided = await request(api, {
    method: "POST",
    path: "/x402/gate/reversal",
    headers: { "x-idempotency-key": "x402_gate_reversal_void_1" },
    body: {
      gateId,
      action: "void_authorization",
      reason: "operator_cancelled",
      evidenceRefs: ["ops:ticket:cancel_123"]
    }
  });
  assert.equal(voided.statusCode, 200, voided.body);
  assert.equal(voided.json?.settlement?.status, "refunded");
  assert.equal(voided.json?.gate?.authorization?.status, "voided");
  assert.equal(voided.json?.reversal?.status, "voided");
  assert.equal(voided.json?.settlementReceipt?.status, "refunded");
  assert.ok(Array.isArray(voided.json?.reversal?.timeline));
  assert.ok(voided.json.reversal.timeline.some((row) => row?.eventType === "authorization_voided"));

  const payerWallet = await request(api, {
    method: "GET",
    path: `/agents/${encodeURIComponent(payerAgentId)}/wallet`
  });
  assert.equal(payerWallet.statusCode, 200, payerWallet.body);
  assert.equal(payerWallet.json?.wallet?.availableCents, 5000);
  assert.equal(payerWallet.json?.wallet?.escrowLockedCents, 0);
});

test("API e2e: x402 reversal request_refund + resolve_refund accepted moves funds back and updates receipt state", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_refund_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_refund_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_refund_1" });

  const gateId = "x402gate_refund_1";
  const amountCents = 700;
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_refund_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD",
      toolId: "mock_search"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authorize_refund_1" },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const verify = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_refund_1" },
    body: {
      gateId,
      verificationStatus: "green",
      runStatus: "completed",
      policy: autoPolicy100(),
      verificationMethod: { mode: "deterministic", source: "http_status_v1" },
      evidenceRefs: [`http:request_sha256:${"a".repeat(64)}`, `http:response_sha256:${"b".repeat(64)}`]
    }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json?.settlement?.status, "released");

  const requested = await request(api, {
    method: "POST",
    path: "/x402/gate/reversal",
    headers: { "x-idempotency-key": "x402_gate_reversal_request_refund_1" },
    body: {
      gateId,
      action: "request_refund",
      reason: "result_not_usable",
      evidenceRefs: ["provider:incident:001"]
    }
  });
  assert.equal(requested.statusCode, 202, requested.body);
  assert.equal(requested.json?.reversal?.status, "refund_pending");

  const resolved = await request(api, {
    method: "POST",
    path: "/x402/gate/reversal",
    headers: { "x-idempotency-key": "x402_gate_reversal_resolve_refund_1" },
    body: {
      gateId,
      action: "resolve_refund",
      providerDecision: "accepted",
      reason: "provider_acknowledged"
    }
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json?.reversal?.status, "refunded");
  assert.equal(resolved.json?.settlement?.status, "refunded");
  assert.equal(resolved.json?.settlement?.releasedAmountCents, 0);
  assert.equal(resolved.json?.settlement?.refundedAmountCents, amountCents);
  assert.equal(resolved.json?.settlementReceipt?.status, "refunded");
  assert.ok(resolved.json?.reversal?.timeline?.some((row) => row?.eventType === "refund_requested"));
  assert.ok(resolved.json?.reversal?.timeline?.some((row) => row?.eventType === "refund_resolved"));

  const payerWallet = await request(api, {
    method: "GET",
    path: `/agents/${encodeURIComponent(payerAgentId)}/wallet`
  });
  assert.equal(payerWallet.statusCode, 200, payerWallet.body);
  assert.equal(payerWallet.json?.wallet?.availableCents, 5000);

  const payeeWallet = await request(api, {
    method: "GET",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/wallet`
  });
  assert.equal(payeeWallet.statusCode, 200, payeeWallet.body);
  assert.equal(payeeWallet.json?.wallet?.availableCents, 0);
});
