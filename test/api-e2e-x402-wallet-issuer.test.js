import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";
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
  return {
    agentId,
    keyId: String(created.json?.keyId ?? "")
  };
}

async function creditWallet(api, { agentId, amountCents, idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/wallet/credit`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: { amountCents, currency: "USD" }
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json?.wallet ?? null;
}

test("API e2e: x402 wallet issuer exposes policy, ledger, and budget snapshots", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payer = await registerAgent(api, { agentId: "agt_x402_wallet_issuer_payer_1" });
  const payee = await registerAgent(api, { agentId: "agt_x402_wallet_issuer_payee_1" });
  await creditWallet(api, {
    agentId: payer.agentId,
    amountCents: 5000,
    idempotencyKey: "wallet_credit_x402_wallet_issuer_1"
  });

  const sponsorRef = "sponsor_wallet_issuer_1";
  const sponsorWalletRef = "x402wallet_issuer_1";

  const createdWallet = await request(api, {
    method: "POST",
    path: "/x402/wallets",
    headers: { "x-idempotency-key": "x402_wallet_issuer_create_1" },
    body: {
      sponsorRef,
      sponsorWalletRef,
      policy: {
        policyRef: "default",
        policyVersion: 1,
        maxAmountCents: 1000,
        maxDailyAuthorizationCents: 2000,
        allowedProviderIds: [payee.agentId],
        allowedToolIds: ["mock_weather"],
        allowedAgentKeyIds: [payer.keyId],
        allowedCurrencies: ["USD"],
        requireQuote: false,
        requireStrictRequestBinding: false,
        requireAgentKeyMatch: true
      }
    }
  });
  assert.equal(createdWallet.statusCode, 201, createdWallet.body);
  assert.equal(createdWallet.json?.wallet?.sponsorWalletRef, sponsorWalletRef);
  assert.equal(createdWallet.json?.wallet?.sponsorRef, sponsorRef);
  assert.equal(createdWallet.json?.policy?.policyRef, "default");
  assert.equal(createdWallet.json?.policy?.policyVersion, 1);

  const updatedPolicy = await request(api, {
    method: "PUT",
    path: `/x402/wallets/${encodeURIComponent(sponsorWalletRef)}/policy`,
    headers: { "x-idempotency-key": "x402_wallet_issuer_policy_put_2" },
    body: {
      sponsorRef,
      policy: {
        policyRef: "default",
        policyVersion: 2,
        maxAmountCents: 1500,
        maxDailyAuthorizationCents: 2500,
        allowedProviderIds: [payee.agentId],
        allowedToolIds: ["mock_weather"],
        allowedAgentKeyIds: [payer.keyId],
        allowedCurrencies: ["USD"],
        requireQuote: false,
        requireStrictRequestBinding: false,
        requireAgentKeyMatch: true
      }
    }
  });
  assert.equal(updatedPolicy.statusCode, 201, updatedPolicy.body);
  assert.equal(updatedPolicy.json?.policy?.policyVersion, 2);
  assert.equal(updatedPolicy.json?.wallet?.activePolicyVersion, 2);

  const listedPolicies = await request(api, {
    method: "GET",
    path: `/x402/wallets/${encodeURIComponent(sponsorWalletRef)}/policy?limit=10`
  });
  assert.equal(listedPolicies.statusCode, 200, listedPolicies.body);
  assert.equal(Array.isArray(listedPolicies.json?.policies), true);
  assert.equal(listedPolicies.json.policies.length >= 2, true);

  const gateId = "gate_x402_wallet_issuer_1";
  const amountCents = 400;
  const createdGate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_wallet_issuer_create_1" },
    body: {
      gateId,
      payerAgentId: payer.agentId,
      payeeAgentId: payee.agentId,
      amountCents,
      currency: "USD",
      toolId: "mock_weather",
      agentPassport: {
        sponsorRef,
        sponsorWalletRef,
        agentKeyId: payer.keyId,
        policyRef: "default",
        policyVersion: 2
      }
    }
  });
  assert.equal(createdGate.statusCode, 201, createdGate.body);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_wallet_issuer_authz_1" },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 409, authorized.body);
  assert.equal(authorized.json?.code, "X402_WALLET_ISSUER_DECISION_REQUIRED");

  const issuedDecision = await request(api, {
    method: "POST",
    path: `/x402/wallets/${encodeURIComponent(sponsorWalletRef)}/authorize`,
    headers: { "x-idempotency-key": "x402_wallet_issuer_authorize_1" },
    body: { gateId }
  });
  assert.equal(issuedDecision.statusCode, 200, issuedDecision.body);
  assert.ok(typeof issuedDecision.json?.walletAuthorizationDecisionToken === "string" && issuedDecision.json.walletAuthorizationDecisionToken.length > 0);

  const authorizedWithDecision = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_wallet_issuer_authz_1b" },
    body: {
      gateId,
      walletAuthorizationDecisionToken: issuedDecision.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(authorizedWithDecision.statusCode, 200, authorizedWithDecision.body);
  assert.equal(authorizedWithDecision.json?.reserve?.status, "reserved");

  const requestSha256 = sha256Hex("GET\nexample.com\n/tools/weather?city=seattle\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const responseSha256 = sha256Hex("{\"ok\":true,\"city\":\"Seattle\"}");
  const verified = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_wallet_issuer_verify_1" },
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
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json?.settlement?.status, "released");

  const ledger = await request(api, {
    method: "GET",
    path: `/x402/wallets/${encodeURIComponent(sponsorWalletRef)}/ledger?limit=10`
  });
  assert.equal(ledger.statusCode, 200, ledger.body);
  assert.equal(ledger.json?.ok, true);
  assert.equal(Array.isArray(ledger.json?.entries), true);
  assert.equal(ledger.json.entries.length, 1);
  assert.equal(ledger.json.entries[0]?.sponsorWalletRef, sponsorWalletRef);
  assert.equal(ledger.json.entries[0]?.amountCents, amountCents);
  assert.equal(ledger.json.entries[0]?.netAmountCents, amountCents);
  assert.equal(ledger.json.summary?.grossAuthorizedCents, amountCents);
  assert.equal(ledger.json.summary?.netSettledCents, amountCents);

  const budgets = await request(api, {
    method: "GET",
    path: `/x402/wallets/${encodeURIComponent(sponsorWalletRef)}/budgets`
  });
  assert.equal(budgets.statusCode, 200, budgets.body);
  assert.equal(budgets.json?.ok, true);
  assert.equal(budgets.json?.policy?.policyVersion, 2);
  assert.equal(budgets.json?.budgets?.maxAmountCents, 1500);
  assert.equal(budgets.json?.budgets?.maxDailyAuthorizationCents, 2500);
  assert.equal(budgets.json?.budgets?.dailyAuthorizedExposureCents, amountCents);
  assert.equal(budgets.json?.budgets?.remainingDailyAuthorizationCents, 2500 - amountCents);
  assert.equal(budgets.json?.budgets?.authorizationSummary?.settledCount, 1);
  assert.equal(budgets.json?.budgets?.authorizationSummary?.settledAmountCents, amountCents);
});
