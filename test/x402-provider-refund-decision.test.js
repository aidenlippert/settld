import test from "node:test";
import assert from "node:assert/strict";

import { createEd25519Keypair } from "../src/core/crypto.js";
import {
  signX402ProviderRefundDecisionV1,
  verifyX402ProviderRefundDecisionV1
} from "../src/core/x402-provider-refund-decision.js";

test("x402 provider refund decision: sign + verify succeeds", () => {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const decision = signX402ProviderRefundDecisionV1({
    decision: {
      decisionId: "dec_test_1",
      receiptId: "srec_test_1",
      gateId: "x402gate_test_1",
      quoteId: "x402quote_test_1",
      requestSha256: "a".repeat(64),
      decision: "accepted",
      reason: "provider_acknowledged",
      decidedAt: "2026-02-18T00:00:00.000Z"
    },
    signedAt: "2026-02-18T00:00:00.000Z",
    publicKeyPem,
    privateKeyPem
  });
  const verified = verifyX402ProviderRefundDecisionV1({
    decision,
    publicKeyPem,
    expectedReceiptId: "srec_test_1",
    expectedGateId: "x402gate_test_1",
    expectedQuoteId: "x402quote_test_1",
    expectedRequestSha256: "a".repeat(64),
    expectedDecision: "accepted"
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.code, null);
  assert.equal(verified.payload?.decision, "accepted");
});

test("x402 provider refund decision: tampered payload hash is rejected", () => {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const decision = signX402ProviderRefundDecisionV1({
    decision: {
      decisionId: "dec_test_2",
      receiptId: "srec_test_2",
      gateId: "x402gate_test_2",
      quoteId: "x402quote_test_2",
      decision: "denied",
      decidedAt: "2026-02-18T00:00:00.000Z"
    },
    signedAt: "2026-02-18T00:00:00.000Z",
    publicKeyPem,
    privateKeyPem
  });
  decision.decision = "accepted";
  const verified = verifyX402ProviderRefundDecisionV1({
    decision,
    publicKeyPem
  });
  assert.equal(verified.ok, false);
  assert.equal(verified.code, "X402_PROVIDER_REFUND_DECISION_PAYLOAD_HASH_MISMATCH");
});

test("x402 provider refund decision: expected decision mismatch is rejected", () => {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const decision = signX402ProviderRefundDecisionV1({
    decision: {
      decisionId: "dec_test_3",
      receiptId: "srec_test_3",
      gateId: "x402gate_test_3",
      quoteId: "x402quote_test_3",
      decision: "denied",
      decidedAt: "2026-02-18T00:00:00.000Z"
    },
    signedAt: "2026-02-18T00:00:00.000Z",
    publicKeyPem,
    privateKeyPem
  });
  const verified = verifyX402ProviderRefundDecisionV1({
    decision,
    publicKeyPem,
    expectedDecision: "accepted"
  });
  assert.equal(verified.ok, false);
  assert.equal(verified.code, "X402_PROVIDER_REFUND_DECISION_VALUE_MISMATCH");
});
