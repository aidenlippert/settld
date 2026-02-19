import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";
import { createCircleReserveAdapter } from "../src/core/circle-reserve-adapter.js";
import { parseSettldPayTokenV1, verifySettldPayTokenV1 } from "../src/core/settld-pay-token.js";
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

async function upsertX402WalletPolicy(api, { policy, idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: "/ops/x402/wallet-policies",
    headers: {
      "x-idempotency-key": idempotencyKey,
      "x-settld-protocol": "1.0"
    },
    body: { policy }
  });
  return response;
}

async function issueWalletAuthorizationDecision(
  api,
  { sponsorWalletRef, gateId, quoteId = null, requestBindingMode = null, requestBindingSha256 = null, idempotencyKey }
) {
  const response = await request(api, {
    method: "POST",
    path: `/x402/wallets/${encodeURIComponent(sponsorWalletRef)}/authorize`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: {
      gateId,
      ...(quoteId ? { quoteId } : {}),
      ...(requestBindingMode ? { requestBindingMode } : {}),
      ...(requestBindingSha256 ? { requestBindingSha256 } : {})
    }
  });
  return response;
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
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.policyDecisionFingerprint?.fingerprintVersion, "PolicyDecisionFingerprint.v1");
  assert.match(String(verifyRes.json?.decisionRecord?.bindings?.policyDecisionFingerprint?.policyHash ?? ""), /^[0-9a-f]{64}$/);
  assert.match(String(verifyRes.json?.decisionRecord?.bindings?.policyDecisionFingerprint?.evaluationHash ?? ""), /^[0-9a-f]{64}$/);
  assert.equal(
    verifyRes.json?.decisionRecord?.bindings?.policyDecisionFingerprint?.evaluationHash,
    verifyRes.json?.settlementReceipt?.bindings?.policyDecisionFingerprint?.evaluationHash
  );
  assert.ok(
    typeof verifyRes.json?.decisionRecord?.bindings?.spendAuthorization?.delegationRef === "string" &&
      verifyRes.json.decisionRecord.bindings.spendAuthorization.delegationRef.length > 0
  );
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

test("API e2e: strict request binding mints request-bound token and reuses reserve", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_2b" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_2b" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_2b" });

  const gateId = "gate_auth_2b";
  const amountCents = 700;
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_2b" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const requestBindingShaA = "a".repeat(64);
  const authA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_2b_a" },
    body: { gateId, requestBindingMode: "strict", requestBindingSha256: requestBindingShaA }
  });
  assert.equal(authA.statusCode, 200, authA.body);
  const payloadA = parseSettldPayTokenV1(authA.json?.token).payload;
  assert.equal(payloadA.requestBindingMode, "strict");
  assert.equal(payloadA.requestBindingSha256, requestBindingShaA);

  const authAReplay = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_2b_a_replay" },
    body: { gateId, requestBindingMode: "strict", requestBindingSha256: requestBindingShaA }
  });
  assert.equal(authAReplay.statusCode, 200, authAReplay.body);
  assert.equal(authAReplay.json?.token, authA.json?.token);
  assert.equal(authAReplay.json?.reserve?.reserveId, authA.json?.reserve?.reserveId);

  const requestBindingShaB = "b".repeat(64);
  const authB = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_2b_b" },
    body: { gateId, requestBindingMode: "strict", requestBindingSha256: requestBindingShaB }
  });
  assert.equal(authB.statusCode, 200, authB.body);
  assert.notEqual(authB.json?.token, authA.json?.token);
  assert.equal(authB.json?.reserve?.reserveId, authA.json?.reserve?.reserveId);
  const payloadB = parseSettldPayTokenV1(authB.json?.token).payload;
  assert.equal(payloadB.requestBindingMode, "strict");
  assert.equal(payloadB.requestBindingSha256, requestBindingShaB);
});

test("API e2e: quote-bound authorization carries spend claims into settlement bindings", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_quote_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_quote_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 8000, idempotencyKey: "wallet_credit_x402_auth_quote_1" });
  const policyUpsert = await upsertX402WalletPolicy(api, {
    policy: {
      schemaVersion: "X402WalletPolicy.v1",
      sponsorRef: "sponsor_acme",
      sponsorWalletRef: "wallet_sponsor_1",
      policyRef: "policy_alpha",
      policyVersion: 3,
      status: "active",
      requireQuote: true,
      requireStrictRequestBinding: true,
      requireAgentKeyMatch: false
    },
    idempotencyKey: "x402_wallet_policy_upsert_auth_quote_1"
  });
  assert.equal(policyUpsert.statusCode, 201, policyUpsert.body);

  const gateId = "gate_auth_quote_1";
  const createGate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_quote_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      toolId: "mock_search",
      amountCents: 900,
      currency: "USD",
      agentPassport: {
        sponsorRef: "sponsor_acme",
        sponsorWalletRef: "wallet_sponsor_1",
        agentKeyId: "agent_key_1",
        delegationRef: "delegation_1",
        policyRef: "policy_alpha",
        policyVersion: 3
      }
    }
  });
  assert.equal(createGate.statusCode, 201, createGate.body);

  const requestBindingSha256 = "c".repeat(64);
  const quoted = await request(api, {
    method: "POST",
    path: "/x402/gate/quote",
    headers: { "x-idempotency-key": "x402_gate_quote_auth_quote_1" },
    body: {
      gateId,
      requestBindingMode: "strict",
      requestBindingSha256
    }
  });
  assert.equal(quoted.statusCode, 200, quoted.body);
  const quoteId = quoted.json?.quote?.quoteId;
  const quoteSha256 = quoted.json?.quote?.quoteSha256;
  assert.ok(typeof quoteId === "string" && quoteId.length > 0);
  assert.match(String(quoteSha256 ?? ""), /^[0-9a-f]{64}$/);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_auth_quote_1" },
    body: {
      gateId,
      quoteId,
      requestBindingMode: "strict",
      requestBindingSha256
    }
  });
  assert.equal(authorized.statusCode, 409, authorized.body);
  assert.equal(authorized.json?.code, "X402_WALLET_ISSUER_DECISION_REQUIRED");

  const issuerDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: "wallet_sponsor_1",
    gateId,
    quoteId,
    requestBindingMode: "strict",
    requestBindingSha256,
    idempotencyKey: "x402_wallet_issuer_auth_quote_1"
  });
  assert.equal(issuerDecision.statusCode, 200, issuerDecision.body);

  const authorizedWithDecision = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_auth_quote_1b" },
    body: {
      gateId,
      quoteId,
      requestBindingMode: "strict",
      requestBindingSha256,
      walletAuthorizationDecisionToken: issuerDecision.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(authorizedWithDecision.statusCode, 200, authorizedWithDecision.body);
  const payload = parseSettldPayTokenV1(authorizedWithDecision.json?.token).payload;
  assert.equal(payload.requestBindingMode, "strict");
  assert.equal(payload.requestBindingSha256, requestBindingSha256);
  assert.equal(payload.quoteId, quoteId);
  assert.equal(payload.quoteSha256, quoteSha256);
  assert.ok(typeof payload.idempotencyKey === "string" && payload.idempotencyKey.length > 0);
  assert.ok(typeof payload.nonce === "string" && payload.nonce.length > 0);
  assert.equal(payload.sponsorRef, "sponsor_acme");
  assert.equal(payload.agentKeyId, "agent_key_1");
  assert.equal(payload.policyVersion, 3);
  assert.match(String(payload.policyFingerprint ?? ""), /^[0-9a-f]{64}$/);
  assert.equal(payload.spendAuthorizationVersion, "SpendAuthorization.v1");

  const verified = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_auth_quote_1" },
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
      evidenceRefs: [`http:request_sha256:${requestBindingSha256}`, `http:response_sha256:${"d".repeat(64)}`]
    }
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json?.decisionRecord?.bindings?.quote?.quoteId, quoteId);
  assert.equal(verified.json?.decisionRecord?.bindings?.quote?.quoteSha256, quoteSha256);
  assert.equal(verified.json?.decisionRecord?.bindings?.spendAuthorization?.sponsorRef, "sponsor_acme");
  assert.equal(verified.json?.decisionRecord?.bindings?.spendAuthorization?.agentKeyId, "agent_key_1");
  assert.equal(verified.json?.decisionRecord?.bindings?.spendAuthorization?.policyVersion, 3);
  assert.equal(verified.json?.decisionRecord?.bindings?.spendAuthorization?.policyFingerprint, payload.policyFingerprint);
});

test("API e2e: ops x402 wallet policy CRUD and authorize-payment policy enforcement", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_policy_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_policy_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 9000, idempotencyKey: "wallet_credit_x402_auth_policy_1" });

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_policy_ops_1",
    sponsorWalletRef: "wallet_policy_ops_1",
    policyRef: "policy_ops_1",
    policyVersion: 7,
    status: "active",
    maxAmountCents: 1000,
    maxDailyAuthorizationCents: 700,
    allowedProviderIds: [payeeAgentId],
    allowedToolIds: ["weather_read"],
    allowedAgentKeyIds: [],
    allowedCurrencies: ["USD"],
    allowedReversalActions: ["request_refund", "resolve_refund", "void_authorization"],
    requireQuote: true,
    requireStrictRequestBinding: true,
    requireAgentKeyMatch: false
  };
  const createdPolicy = await upsertX402WalletPolicy(api, {
    policy: walletPolicy,
    idempotencyKey: "x402_wallet_policy_upsert_1"
  });
  assert.equal(createdPolicy.statusCode, 201, createdPolicy.body);
  assert.equal(createdPolicy.json?.policy?.policyRef, walletPolicy.policyRef);
  assert.equal(createdPolicy.json?.policy?.policyVersion, walletPolicy.policyVersion);
  assert.equal(createdPolicy.json?.policy?.status, "active");
  assert.match(String(createdPolicy.json?.policy?.policyFingerprint ?? ""), /^[0-9a-f]{64}$/);

  const listed = await request(api, {
    method: "GET",
    path: `/ops/x402/wallet-policies?sponsorWalletRef=${encodeURIComponent(walletPolicy.sponsorWalletRef)}`
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(Array.isArray(listed.json?.policies), true);
  assert.equal(listed.json.policies.length, 1);
  assert.equal(listed.json.policies[0]?.policyRef, walletPolicy.policyRef);

  const fetched = await request(api, {
    method: "GET",
    path: `/ops/x402/wallet-policies/${encodeURIComponent(walletPolicy.sponsorWalletRef)}/${encodeURIComponent(walletPolicy.policyRef)}/${walletPolicy.policyVersion}`
  });
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(fetched.json?.policy?.policyRef, walletPolicy.policyRef);
  assert.equal(fetched.json?.policy?.policyVersion, walletPolicy.policyVersion);

  const gateA = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_policy_1a" },
    body: {
      gateId: "gate_auth_policy_1a",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 500,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_policy_1",
        delegationRef: "delegation_policy_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(gateA.statusCode, 201, gateA.body);

  const authWithoutQuote = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_policy_1a_noquote" },
    body: { gateId: "gate_auth_policy_1a" }
  });
  assert.equal(authWithoutQuote.statusCode, 409, authWithoutQuote.body);
  assert.equal(authWithoutQuote.json?.code, "X402_WALLET_ISSUER_DECISION_REQUIRED");

  const decisionWithoutQuote = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_policy_1a",
    idempotencyKey: "x402_wallet_issuer_policy_1a_noquote"
  });
  assert.equal(decisionWithoutQuote.statusCode, 409, decisionWithoutQuote.body);
  assert.equal(decisionWithoutQuote.json?.code, "X402_WALLET_POLICY_QUOTE_REQUIRED");

  const requestBindingShaA = "e".repeat(64);
  const quoteA = await request(api, {
    method: "POST",
    path: "/x402/gate/quote",
    headers: { "x-idempotency-key": "x402_gate_quote_auth_policy_1a" },
    body: {
      gateId: "gate_auth_policy_1a",
      requestBindingMode: "strict",
      requestBindingSha256: requestBindingShaA
    }
  });
  assert.equal(quoteA.statusCode, 200, quoteA.body);

  const authA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_policy_1a" },
    body: {
      gateId: "gate_auth_policy_1a",
      quoteId: quoteA.json?.quote?.quoteId,
      requestBindingMode: "strict",
      requestBindingSha256: requestBindingShaA
    }
  });
  assert.equal(authA.statusCode, 409, authA.body);
  assert.equal(authA.json?.code, "X402_WALLET_ISSUER_DECISION_REQUIRED");

  const issuerDecisionA = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_policy_1a",
    quoteId: quoteA.json?.quote?.quoteId,
    requestBindingMode: "strict",
    requestBindingSha256: requestBindingShaA,
    idempotencyKey: "x402_wallet_issuer_policy_1a"
  });
  assert.equal(issuerDecisionA.statusCode, 200, issuerDecisionA.body);

  const authAWithDecision = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_policy_1a_with_decision" },
    body: {
      gateId: "gate_auth_policy_1a",
      quoteId: quoteA.json?.quote?.quoteId,
      requestBindingMode: "strict",
      requestBindingSha256: requestBindingShaA,
      walletAuthorizationDecisionToken: issuerDecisionA.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(authAWithDecision.statusCode, 200, authAWithDecision.body);
  const tokenPayloadA = parseSettldPayTokenV1(authAWithDecision.json?.token).payload;
  assert.equal(tokenPayloadA.policyVersion, walletPolicy.policyVersion);
  assert.equal(tokenPayloadA.policyFingerprint, createdPolicy.json?.policy?.policyFingerprint);

  const gateB = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_policy_1b" },
    body: {
      gateId: "gate_auth_policy_1b",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 300,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_policy_1",
        delegationRef: "delegation_policy_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(gateB.statusCode, 201, gateB.body);

  const requestBindingShaB = "f".repeat(64);
  const quoteB = await request(api, {
    method: "POST",
    path: "/x402/gate/quote",
    headers: { "x-idempotency-key": "x402_gate_quote_auth_policy_1b" },
    body: {
      gateId: "gate_auth_policy_1b",
      requestBindingMode: "strict",
      requestBindingSha256: requestBindingShaB
    }
  });
  assert.equal(quoteB.statusCode, 200, quoteB.body);

  const issuerDecisionB = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_policy_1b",
    quoteId: quoteB.json?.quote?.quoteId,
    requestBindingMode: "strict",
    requestBindingSha256: requestBindingShaB,
    idempotencyKey: "x402_wallet_issuer_policy_1b"
  });
  assert.equal(issuerDecisionB.statusCode, 409, issuerDecisionB.body);
  assert.equal(issuerDecisionB.json?.code, "X402_WALLET_POLICY_DAILY_LIMIT_EXCEEDED");
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

test("API e2e: x402 wallet policy enforces max delegation depth fail-closed", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_depth_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_depth_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_depth_1" });

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_depth_ops_1",
    sponsorWalletRef: "wallet_depth_ops_1",
    policyRef: "policy_depth_1",
    policyVersion: 1,
    status: "active",
    maxDelegationDepth: 1,
    allowedProviderIds: [payeeAgentId],
    allowedToolIds: ["weather_read"],
    requireQuote: false,
    requireStrictRequestBinding: false,
    requireAgentKeyMatch: false
  };
  const createdPolicy = await upsertX402WalletPolicy(api, {
    policy: walletPolicy,
    idempotencyKey: "x402_wallet_policy_upsert_depth_1"
  });
  assert.equal(createdPolicy.statusCode, 201, createdPolicy.body);

  const gateId = "gate_auth_depth_1";
  const createGate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_depth_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 350,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_depth_1",
        delegationRef: "delegation_depth_1",
        delegationDepth: 2,
        maxDelegationDepth: 3,
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGate.statusCode, 201, createGate.body);

  const issuerDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId,
    idempotencyKey: "x402_wallet_issuer_depth_1"
  });
  assert.equal(issuerDecision.statusCode, 409, issuerDecision.body);
  assert.equal(issuerDecision.json?.code, "X402_WALLET_POLICY_DELEGATION_DEPTH_EXCEEDED");
  assert.equal(issuerDecision.json?.details?.details?.delegationDepth, 2);
  assert.equal(issuerDecision.json?.details?.details?.maxDelegationDepth, 1);

  const gateRead = await request(api, {
    method: "GET",
    path: `/x402/gate/${encodeURIComponent(gateId)}`
  });
  assert.equal(gateRead.statusCode, 200, gateRead.body);
  assert.equal(gateRead.json?.gate?.authorization?.status, "pending");

  const settlementRead = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(`x402_${gateId}`)}/settlement`
  });
  assert.equal(settlementRead.statusCode, 200, settlementRead.body);
  assert.equal(settlementRead.json?.settlement?.status, "locked");
});
