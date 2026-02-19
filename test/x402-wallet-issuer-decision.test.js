import test from "node:test";
import assert from "node:assert/strict";

import { createEd25519Keypair } from "../src/core/crypto.js";
import {
  buildX402WalletIssuerDecisionPayloadV1,
  mintX402WalletIssuerDecisionTokenV1,
  verifyX402WalletIssuerDecisionTokenV1
} from "../src/core/x402-wallet-issuer-decision.js";

test("x402 wallet issuer decision token: mint/verify happy path", () => {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const now = Math.floor(Date.now() / 1000);
  const payload = buildX402WalletIssuerDecisionPayloadV1({
    decisionId: "x402dec_1",
    gateId: "x402gate_1",
    sponsorRef: "sponsor_1",
    sponsorWalletRef: "wallet_1",
    policyRef: "default",
    policyVersion: 1,
    policyFingerprint: "a".repeat(64),
    amountCents: 500,
    currency: "USD",
    payeeProviderId: "provider_1",
    quoteId: "quote_1",
    quoteSha256: "b".repeat(64),
    requestBindingMode: "strict",
    requestBindingSha256: "c".repeat(64),
    idempotencyKey: "idem_1",
    nonce: "nonce_1",
    iat: now,
    exp: now + 300
  });
  const minted = mintX402WalletIssuerDecisionTokenV1({
    payload,
    publicKeyPem,
    privateKeyPem
  });
  const verified = verifyX402WalletIssuerDecisionTokenV1({
    token: minted.token,
    publicKeyPem,
    expected: {
      gateId: "x402gate_1",
      sponsorRef: "sponsor_1",
      sponsorWalletRef: "wallet_1",
      policyRef: "default",
      policyVersion: 1,
      policyFingerprint: "a".repeat(64),
      amountCents: 500,
      currency: "USD",
      payeeProviderId: "provider_1",
      quoteId: "quote_1",
      quoteSha256: "b".repeat(64),
      requestBindingMode: "strict",
      requestBindingSha256: "c".repeat(64)
    }
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.gateId, "x402gate_1");
  assert.equal(verified.payload.policyVersion, 1);
  assert.equal(verified.payload.currency, "USD");
});

test("x402 wallet issuer decision token: tamper and expiry failures", () => {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    decisionId: "x402dec_2",
    gateId: "x402gate_2",
    sponsorRef: "sponsor_2",
    sponsorWalletRef: "wallet_2",
    policyRef: "default",
    policyVersion: 2,
    policyFingerprint: "d".repeat(64),
    amountCents: 250,
    currency: "USD",
    payeeProviderId: "provider_2",
    idempotencyKey: "idem_2",
    nonce: "nonce_2",
    iat: now,
    exp: now + 120
  };
  const minted = mintX402WalletIssuerDecisionTokenV1({ payload, publicKeyPem, privateKeyPem });

  const envelope = JSON.parse(Buffer.from(minted.token, "base64url").toString("utf8"));
  envelope.payload.amountCents = 999;
  const tamperedToken = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  const tampered = verifyX402WalletIssuerDecisionTokenV1({ token: tamperedToken, publicKeyPem });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.code, "X402_WALLET_ISSUER_DECISION_SIGNATURE_INVALID");

  const expired = verifyX402WalletIssuerDecisionTokenV1({
    token: minted.token,
    publicKeyPem,
    nowUnixSeconds: now + 1000
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, "X402_WALLET_ISSUER_DECISION_EXPIRED");

  const mismatched = verifyX402WalletIssuerDecisionTokenV1({
    token: minted.token,
    publicKeyPem,
    expected: {
      sponsorWalletRef: "wallet_wrong"
    }
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, "X402_WALLET_ISSUER_DECISION_MISMATCH");
  assert.equal(mismatched.field, "sponsorWalletRef");
});
