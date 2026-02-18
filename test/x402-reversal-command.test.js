import test from "node:test";
import assert from "node:assert/strict";

import { createEd25519Keypair } from "../src/core/crypto.js";
import { signX402ReversalCommandV1, verifyX402ReversalCommandV1 } from "../src/core/x402-reversal-command.js";

test("x402 reversal command: sign + verify succeeds for matching bindings", () => {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const command = signX402ReversalCommandV1({
    command: {
      commandId: "cmd_test_1",
      sponsorRef: "sponsor_1",
      agentKeyId: "agt_1",
      target: {
        gateId: "x402gate_test_1",
        receiptId: "srec_test_1",
        quoteId: "x402quote_test_1",
        requestSha256: "a".repeat(64)
      },
      action: "request_refund",
      nonce: "nonce_test_1",
      idempotencyKey: "idem_test_1",
      exp: "2099-01-01T00:00:00.000Z"
    },
    signedAt: "2026-02-18T00:00:00.000Z",
    publicKeyPem,
    privateKeyPem
  });
  const verified = verifyX402ReversalCommandV1({
    command,
    publicKeyPem,
    nowAt: "2026-02-18T00:00:01.000Z",
    expectedAction: "request_refund",
    expectedSponsorRef: "sponsor_1",
    expectedGateId: "x402gate_test_1",
    expectedReceiptId: "srec_test_1",
    expectedQuoteId: "x402quote_test_1",
    expectedRequestSha256: "a".repeat(64)
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.code, null);
  assert.equal(verified.payload?.commandId, "cmd_test_1");
});

test("x402 reversal command: tampered payload fails verification", () => {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const command = signX402ReversalCommandV1({
    command: {
      commandId: "cmd_test_2",
      sponsorRef: "sponsor_2",
      target: {
        gateId: "x402gate_test_2",
        receiptId: "srec_test_2",
        quoteId: "x402quote_test_2"
      },
      action: "void_authorization",
      nonce: "nonce_test_2",
      idempotencyKey: "idem_test_2",
      exp: "2099-01-01T00:00:00.000Z"
    },
    signedAt: "2026-02-18T00:00:00.000Z",
    publicKeyPem,
    privateKeyPem
  });
  command.target.quoteId = "x402quote_test_tampered";
  const verified = verifyX402ReversalCommandV1({
    command,
    publicKeyPem,
    nowAt: "2026-02-18T00:00:01.000Z"
  });
  assert.equal(verified.ok, false);
  assert.equal(verified.code, "X402_REVERSAL_COMMAND_PAYLOAD_HASH_MISMATCH");
});

test("x402 reversal command: expired command is rejected", () => {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const command = signX402ReversalCommandV1({
    command: {
      commandId: "cmd_test_3",
      sponsorRef: "sponsor_3",
      target: {
        gateId: "x402gate_test_3",
        receiptId: "srec_test_3",
        quoteId: "x402quote_test_3"
      },
      action: "resolve_refund",
      nonce: "nonce_test_3",
      idempotencyKey: "idem_test_3",
      exp: "2026-02-18T00:00:00.000Z"
    },
    signedAt: "2026-02-18T00:00:00.000Z",
    publicKeyPem,
    privateKeyPem
  });
  const verified = verifyX402ReversalCommandV1({
    command,
    publicKeyPem,
    nowAt: "2026-02-18T00:00:01.000Z"
  });
  assert.equal(verified.ok, false);
  assert.equal(verified.code, "X402_REVERSAL_COMMAND_EXPIRED");
});
