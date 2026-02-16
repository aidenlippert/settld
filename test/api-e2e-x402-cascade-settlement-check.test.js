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
  return response.json.wallet;
}

test("API e2e: x402 gate verify blocks on cascadeSettlementCheck failure (stable code)", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_cascade_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_cascade_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_cascade_1" });

  const A = "a".repeat(64);
  const B = "b".repeat(64);

  const delegatedAB = await request(api, {
    method: "POST",
    path: `/agreements/${A}/delegations`,
    headers: { "x-idempotency-key": "delegation_ab_1" },
    body: {
      childAgreementHash: B,
      delegatorAgentId: payerAgentId,
      delegateeAgentId: payeeAgentId,
      budgetCapCents: 1000,
      currency: "USD"
    }
  });
  assert.equal(delegatedAB.statusCode, 201, delegatedAB.body);

  const delegatedBA = await request(api, {
    method: "POST",
    path: `/agreements/${B}/delegations`,
    headers: { "x-idempotency-key": "delegation_ba_1" },
    body: {
      childAgreementHash: A,
      delegatorAgentId: payerAgentId,
      delegateeAgentId: payeeAgentId,
      budgetCapCents: 1000,
      currency: "USD"
    }
  });
  assert.equal(delegatedBA.statusCode, 201, delegatedBA.body);

  const gateId = "gate_cascade_1";
  const amountCents = 1200;

  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_cascade_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD",
      agreementHash: A
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json?.gate?.agreementHash, A);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_cascade_1" },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const payerAfterLock = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(payerAfterLock.statusCode, 200, payerAfterLock.body);
  assert.equal(payerAfterLock.json?.wallet?.escrowLockedCents, amountCents);

  const verify = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_cascade_1" },
    body: { gateId, verificationStatus: "green", runStatus: "completed" }
  });
  assert.equal(verify.statusCode, 409, verify.body);
  assert.equal(verify.json?.error, "cascade settlement check failed");
  assert.equal(verify.json?.code, "AGREEMENT_DELEGATION_CYCLE");

  const state = await request(api, { method: "GET", path: `/x402/gate/${encodeURIComponent(gateId)}` });
  assert.equal(state.statusCode, 200, state.body);
  assert.equal(state.json?.gate?.status, "held");
  assert.equal(state.json?.settlement?.status, "locked");

  const payerAfter = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(payerAfter.statusCode, 200, payerAfter.body);
  assert.equal(payerAfter.json?.wallet?.escrowLockedCents, amountCents);

  const payeeAfter = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payeeAgentId)}/wallet` });
  assert.equal(payeeAfter.statusCode, 200, payeeAfter.body);
  assert.equal(payeeAfter.json?.wallet?.availableCents, 0);
});
