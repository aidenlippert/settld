import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";
import { createCircleReserveAdapter } from "../src/core/circle-reserve-adapter.js";
import { verifySettldPayTokenV1 } from "../src/core/settld-pay-token.js";
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

test("API e2e: x402 authorize-payment is idempotent and token verifies via keyset", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_1" });

  const gateId = "gate_auth_1";
  const amountCents = 500;

  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const auth1 = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_1" },
    body: { gateId }
  });
  assert.equal(auth1.statusCode, 200, auth1.body);
  assert.equal(auth1.json?.gateId, gateId);
  assert.equal(auth1.json?.reserve?.status, "reserved");
  assert.ok(typeof auth1.json?.token === "string" && auth1.json.token.length > 0);

  const auth2 = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_2" },
    body: { gateId }
  });
  assert.equal(auth2.statusCode, 200, auth2.body);
  assert.equal(auth2.json?.token, auth1.json?.token);
  assert.equal(auth2.json?.reserve?.reserveId, auth1.json?.reserve?.reserveId);

  const keysetRes = await request(api, {
    method: "GET",
    path: "/.well-known/settld-keys.json",
    auth: "none"
  });
  assert.equal(keysetRes.statusCode, 200, keysetRes.body);
  const verified = verifySettldPayTokenV1({
    token: auth1.json?.token,
    keyset: keysetRes.json,
    expectedAudience: payeeAgentId,
    expectedPayeeProviderId: payeeAgentId
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.gateId, gateId);

  const requestSha256 = sha256Hex("GET\nexample.com\n/tools/search?q=dentist\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const responseSha256 = sha256Hex("{\"ok\":true}");
  const verifyRes = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_auth_1" },
    body: {
      gateId,
      verificationStatus: "green",
      runStatus: "completed",
      policy: {
        mode: "automatic",
        rules: {
          autoReleaseOnGreen: true,
          greenReleaseRatePct: 100,
          autoReleaseOnAmber: false,
          amberReleaseRatePct: 0,
          autoReleaseOnRed: true,
          redReleaseRatePct: 0
        }
      },
      verificationMethod: { mode: "deterministic", source: "http_status_v1" },
      evidenceRefs: [`http:request_sha256:${requestSha256}`, `http:response_sha256:${responseSha256}`]
    }
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  assert.equal(verifyRes.json?.settlement?.status, "released");
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.authorizationRef, auth1.json?.authorizationRef);
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.request?.sha256, requestSha256);
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.response?.sha256, responseSha256);
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.reserve?.status, "reserved");
});

test("API e2e: reserve failure during authorize-payment rolls back wallet escrow lock", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402ReserveAdapter: createCircleReserveAdapter({ mode: "fail" })
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_2" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_2" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_2" });

  const gateId = "gate_auth_2";
  const amountCents = 700;

  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_2" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const walletAfterCreate = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(walletAfterCreate.statusCode, 200, walletAfterCreate.body);
  assert.equal(walletAfterCreate.json?.wallet?.escrowLockedCents, amountCents);

  const authz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_fail_2" },
    body: { gateId }
  });
  assert.equal(authz.statusCode, 503, authz.body);
  assert.equal(authz.json?.code, "X402_RESERVE_FAILED");

  const walletAfterFail = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(walletAfterFail.statusCode, 200, walletAfterFail.body);
  assert.equal(walletAfterFail.json?.wallet?.escrowLockedCents, 0);

  const gateRead = await request(api, { method: "GET", path: `/x402/gate/${encodeURIComponent(gateId)}` });
  assert.equal(gateRead.statusCode, 200, gateRead.body);
  assert.equal(gateRead.json?.gate?.authorization?.status, "failed");
});
