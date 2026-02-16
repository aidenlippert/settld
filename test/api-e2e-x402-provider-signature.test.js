import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";
import { signToolProviderSignatureV1 } from "../src/core/tool-provider-signature.js";
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

test("API e2e: x402 provider signature invalid => verification forced red and settlement refunded", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_sig_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_sig_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_sig_1" });

  const gateId = "gate_sig_1";
  const amountCents = 500;

  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_sig_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_sig_1" },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const responseHash = sha256Hex("demo response bytes");
  const nonce = "a".repeat(16);
  const signedAt = "2026-02-15T00:00:00.000Z";

  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const signature = signToolProviderSignatureV1({
    responseHash,
    nonce,
    signedAt,
    publicKeyPem,
    privateKeyPem
  });

  // Corrupt signature while keeping it valid base64 so verifier doesn't throw.
  const corruptedSignatureBase64 = (() => {
    const sigBytes = Buffer.from(String(signature.signatureBase64), "base64");
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0x01;
    return sigBytes.toString("base64");
  })();

  const verify = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_sig_1" },
    body: {
      gateId,
      verificationStatus: "green",
      runStatus: "completed",
      // Deterministic conditional release economics: release 100% on PASS; refund 100% on FAIL.
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
      verificationMethod: { mode: "attested", source: "provider_signature_v1" },
      evidenceRefs: [`http:response_sha256:${responseHash}`],
      providerSignature: {
        ...signature,
        signatureBase64: corruptedSignatureBase64,
        publicKeyPem
      }
    }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json?.settlement?.status, "refunded");
  assert.equal(verify.json?.settlement?.releasedAmountCents, 0);
  assert.equal(verify.json?.settlement?.refundedAmountCents, amountCents);
  assert.ok(Array.isArray(verify.json?.gate?.decision?.reasonCodes));
  assert.ok(verify.json.gate.decision.reasonCodes.includes("X402_PROVIDER_SIGNATURE_INVALID"));

  const payerAfter = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(payerAfter.statusCode, 200, payerAfter.body);
  assert.equal(payerAfter.json?.wallet?.escrowLockedCents, 0);

  const payeeAfter = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payeeAgentId)}/wallet` });
  assert.equal(payeeAfter.statusCode, 200, payeeAfter.body);
  assert.equal(payeeAfter.json?.wallet?.availableCents, 0);
});

test("API e2e: pinned providerPublicKeyPem prevents key swap attacks (signature verified against gate)", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_sig_payer_2" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_sig_payee_2" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_sig_2" });

  const gateId = "gate_sig_2";
  const amountCents = 500;

  const pinnedProvider = createEd25519Keypair();
  const attackerProvider = createEd25519Keypair();

  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_sig_2" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD",
      providerPublicKeyPem: pinnedProvider.publicKeyPem
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_sig_2" },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const responseHash = sha256Hex("demo response bytes 2");
  const nonce = "b".repeat(16);
  const signedAt = "2026-02-15T00:00:00.000Z";

  // Attacker signs with their own key and even supplies their own public key in the verify request.
  // Settld must ignore that and verify against the provider key pinned on the gate record.
  const signature = signToolProviderSignatureV1({
    responseHash,
    nonce,
    signedAt,
    publicKeyPem: attackerProvider.publicKeyPem,
    privateKeyPem: attackerProvider.privateKeyPem
  });

  const verify = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_sig_2" },
    body: {
      gateId,
      verificationStatus: "green",
      runStatus: "completed",
      // Deterministic conditional release economics: release 100% on PASS; refund 100% on FAIL.
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
      verificationMethod: { mode: "attested", source: "provider_signature_v1" },
      evidenceRefs: [`http:response_sha256:${responseHash}`],
      providerSignature: {
        ...signature,
        publicKeyPem: attackerProvider.publicKeyPem
      }
    }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json?.settlement?.status, "refunded");
  assert.equal(verify.json?.settlement?.releasedAmountCents, 0);
  assert.equal(verify.json?.settlement?.refundedAmountCents, amountCents);
  assert.ok(Array.isArray(verify.json?.gate?.decision?.reasonCodes));
  assert.ok(verify.json.gate.decision.reasonCodes.includes("X402_PROVIDER_SIGNATURE_INVALID"));
});
