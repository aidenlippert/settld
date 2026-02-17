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

test("API e2e: production-like defaults fail closed when external reserve is unavailable", async (t) => {
  const prevSettldEnv = process.env.SETTLD_ENV;
  const prevRequireReserve = process.env.X402_REQUIRE_EXTERNAL_RESERVE;
  const prevReserveMode = process.env.X402_CIRCLE_RESERVE_MODE;

  process.env.SETTLD_ENV = "production";
  delete process.env.X402_REQUIRE_EXTERNAL_RESERVE;
  delete process.env.X402_CIRCLE_RESERVE_MODE;
  t.after(() => {
    if (prevSettldEnv === undefined) delete process.env.SETTLD_ENV;
    else process.env.SETTLD_ENV = prevSettldEnv;
    if (prevRequireReserve === undefined) delete process.env.X402_REQUIRE_EXTERNAL_RESERVE;
    else process.env.X402_REQUIRE_EXTERNAL_RESERVE = prevRequireReserve;
    if (prevReserveMode === undefined) delete process.env.X402_CIRCLE_RESERVE_MODE;
    else process.env.X402_CIRCLE_RESERVE_MODE = prevReserveMode;
  });

  const api = createApi({
    opsToken: "tok_ops",
    x402ReserveAdapter: createCircleReserveAdapter({ mode: "stub" })
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_3" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_3" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_3" });

  const gateId = "gate_auth_3";
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_3" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents: 700,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_3" },
    body: { gateId }
  });
  assert.equal(authz.statusCode, 503, authz.body);
  assert.equal(authz.json?.code, "X402_RESERVE_UNAVAILABLE");
});

test("API e2e: x402 authorize-payment kill switch blocks authorization", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402PilotKillSwitch: true
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_4" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_4" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_4" });

  const gateId = "gate_auth_4";
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_4" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_4" },
    body: { gateId }
  });
  assert.equal(authz.statusCode, 409, authz.body);
  assert.equal(authz.json?.code, "X402_PILOT_KILL_SWITCH_ACTIVE");
});

test("API e2e: x402 authorize-payment enforces provider allowlist and per-call cap", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402PilotAllowedProviderIds: ["agt_x402_auth_payee_allowed"],
    x402PilotMaxAmountCents: 300
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_5" });
  const allowedPayeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_allowed" });
  const disallowedPayeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_5_disallowed" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_5" });

  const disallowedGateId = "gate_auth_5_disallowed";
  const disallowedCreate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_5_disallowed" },
    body: {
      gateId: disallowedGateId,
      payerAgentId,
      payeeAgentId: disallowedPayeeAgentId,
      amountCents: 200,
      currency: "USD"
    }
  });
  assert.equal(disallowedCreate.statusCode, 201, disallowedCreate.body);
  const disallowedAuthz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_5_disallowed" },
    body: { gateId: disallowedGateId }
  });
  assert.equal(disallowedAuthz.statusCode, 409, disallowedAuthz.body);
  assert.equal(disallowedAuthz.json?.code, "X402_PILOT_PROVIDER_NOT_ALLOWED");

  const highAmountGateId = "gate_auth_5_high_amount";
  const highAmountCreate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_5_high_amount" },
    body: {
      gateId: highAmountGateId,
      payerAgentId,
      payeeAgentId: allowedPayeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(highAmountCreate.statusCode, 201, highAmountCreate.body);
  const highAmountAuthz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_5_high_amount" },
    body: { gateId: highAmountGateId }
  });
  assert.equal(highAmountAuthz.statusCode, 409, highAmountAuthz.body);
  assert.equal(highAmountAuthz.json?.code, "X402_PILOT_AMOUNT_LIMIT_EXCEEDED");
});

test("API e2e: x402 authorize-payment enforces daily tenant cap", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402PilotDailyLimitCents: 800
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_6" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_6" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 8000, idempotencyKey: "wallet_credit_x402_auth_6" });

  const gateA = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_6_a" },
    body: {
      gateId: "gate_auth_6_a",
      payerAgentId,
      payeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(gateA.statusCode, 201, gateA.body);
  const authA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_6_a" },
    body: { gateId: "gate_auth_6_a" }
  });
  assert.equal(authA.statusCode, 200, authA.body);

  const gateB = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_6_b" },
    body: {
      gateId: "gate_auth_6_b",
      payerAgentId,
      payeeAgentId,
      amountCents: 400,
      currency: "USD"
    }
  });
  assert.equal(gateB.statusCode, 201, gateB.body);
  const authB = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_6_b" },
    body: { gateId: "gate_auth_6_b" }
  });
  assert.equal(authB.statusCode, 409, authB.body);
  assert.equal(authB.json?.code, "X402_PILOT_DAILY_LIMIT_EXCEEDED");
  assert.equal(authB.json?.details?.currentExposureCents, 500);
  assert.equal(authB.json?.details?.projectedExposureCents, 900);
});
