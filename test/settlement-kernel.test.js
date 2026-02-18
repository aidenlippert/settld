import test from "node:test";
import assert from "node:assert/strict";

import {
  SETTLEMENT_KERNEL_VERIFICATION_CODE,
  SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION,
  SETTLEMENT_RECEIPT_SCHEMA_VERSION,
  buildSettlementDecisionRecord,
  buildSettlementReceipt,
  extractSettlementKernelArtifacts,
  verifySettlementKernelArtifacts
} from "../src/core/settlement-kernel.js";

test("Settlement kernel builds bound decision + receipt artifacts", () => {
  const decision = buildSettlementDecisionRecord({
    decisionId: "dec_run_1_auto",
    tenantId: "tenant_default",
    runId: "run_1",
    settlementId: "setl_run_1",
    agreementId: "agr_1",
    decisionStatus: "auto_resolved",
    decisionMode: "automatic",
    decisionReason: null,
    verificationStatus: "green",
    policyHashUsed: "3".repeat(64),
    verificationMethodHashUsed: "4".repeat(64),
    policyRef: {
      policyHash: "3".repeat(64),
      verificationMethodHash: "4".repeat(64)
    },
    verifierRef: {
      verifierId: "settld.policy-engine",
      verifierVersion: "v1",
      verifierHash: "5".repeat(64),
      modality: "deterministic"
    },
    runStatus: "completed",
    runLastEventId: "ev_run_1_2",
    runLastChainHash: "ch_run_1_2",
    resolutionEventId: "ev_run_1_2",
    decidedAt: "2026-02-08T00:00:00.000Z"
  });
  assert.equal(decision.schemaVersion, SETTLEMENT_DECISION_RECORD_SCHEMA_VERSION);
  assert.match(decision.decisionHash, /^[0-9a-f]{64}$/);

  const receipt = buildSettlementReceipt({
    receiptId: "rcpt_run_1_auto",
    tenantId: "tenant_default",
    runId: "run_1",
    settlementId: "setl_run_1",
    decisionRecord: decision,
    status: "released",
    amountCents: 1250,
    releasedAmountCents: 1250,
    refundedAmountCents: 0,
    releaseRatePct: 100,
    currency: "USD",
    runStatus: "completed",
    resolutionEventId: "ev_run_1_2",
    settledAt: "2026-02-08T00:00:01.000Z",
    createdAt: "2026-02-08T00:00:01.000Z"
  });
  assert.equal(receipt.schemaVersion, SETTLEMENT_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.decisionRef.decisionHash, decision.decisionHash);
  assert.match(receipt.receiptHash, /^[0-9a-f]{64}$/);

  const extracted = extractSettlementKernelArtifacts({
    decisionTrace: {
      phase: "run.terminal.auto_resolved",
      decisionRecord: decision,
      settlementReceipt: receipt
    }
  });
  assert.deepEqual(extracted.decisionRecord, decision);
  assert.deepEqual(extracted.settlementReceipt, receipt);

  const verification = verifySettlementKernelArtifacts({
    settlement: {
      runId: "run_1",
      settlementId: "setl_run_1",
      decisionTrace: {
        decisionRecord: decision,
        settlementReceipt: receipt
      }
    },
    runId: "run_1"
  });
  assert.equal(verification.valid, true);
  assert.deepEqual(verification.errors, []);
});

test("Settlement kernel verification reports decision/receipt binding mismatches", () => {
  const decision = buildSettlementDecisionRecord({
    decisionId: "dec_run_2_auto",
    tenantId: "tenant_default",
    runId: "run_2",
    settlementId: "setl_run_2",
    agreementId: "agr_2",
    decisionStatus: "auto_resolved",
    decisionMode: "automatic",
    verificationStatus: "green",
    policyHashUsed: "3".repeat(64),
    verificationMethodHashUsed: "4".repeat(64),
    policyRef: {
      policyHash: "3".repeat(64),
      verificationMethodHash: "4".repeat(64)
    },
    verifierRef: {
      verifierId: "settld.policy-engine",
      verifierVersion: "v1",
      verifierHash: "5".repeat(64),
      modality: "deterministic"
    },
    runStatus: "completed",
    runLastEventId: "ev_run_2_2",
    runLastChainHash: "ch_run_2_2",
    resolutionEventId: "ev_run_2_2",
    decidedAt: "2026-02-08T00:00:00.000Z"
  });
  const receipt = buildSettlementReceipt({
    receiptId: "rcpt_run_2_auto",
    tenantId: "tenant_default",
    runId: "run_2",
    settlementId: "setl_run_2",
    decisionRecord: decision,
    status: "released",
    amountCents: 2400,
    releasedAmountCents: 2400,
    refundedAmountCents: 0,
    releaseRatePct: 100,
    currency: "USD",
    runStatus: "completed",
    resolutionEventId: "ev_run_2_2",
    settledAt: "2026-02-08T00:00:01.000Z",
    createdAt: "2026-02-08T00:00:01.000Z"
  });
  const tamperedReceipt = {
    ...receipt,
    decisionRef: {
      ...receipt.decisionRef,
      decisionHash: "f".repeat(64)
    }
  };

  const verification = verifySettlementKernelArtifacts({
    settlement: {
      runId: "run_2",
      settlementId: "setl_run_2",
      decisionTrace: {
        decisionRecord: decision,
        settlementReceipt: tamperedReceipt
      }
    },
    runId: "run_2"
  });
  assert.equal(verification.valid, false);
  assert.ok(verification.errors.includes(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_HASH_MISMATCH));
  assert.ok(verification.errors.includes(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_DECISION_HASH_MISMATCH));
});

test("Settlement kernel verification reports temporal ordering violations", () => {
  const decision = buildSettlementDecisionRecord({
    decisionId: "dec_run_3_auto",
    tenantId: "tenant_default",
    runId: "run_3",
    settlementId: "setl_run_3",
    agreementId: "agr_3",
    decisionStatus: "auto_resolved",
    decisionMode: "automatic",
    verificationStatus: "green",
    policyHashUsed: "3".repeat(64),
    verificationMethodHashUsed: "4".repeat(64),
    policyRef: {
      policyHash: "3".repeat(64),
      verificationMethodHash: "4".repeat(64)
    },
    verifierRef: {
      verifierId: "settld.policy-engine",
      verifierVersion: "v1",
      verifierHash: "5".repeat(64),
      modality: "deterministic"
    },
    runStatus: "completed",
    runLastEventId: "ev_run_3_2",
    runLastChainHash: "ch_run_3_2",
    resolutionEventId: "ev_run_3_2",
    decidedAt: "2026-02-08T00:00:10.000Z"
  });

  const receipt = buildSettlementReceipt({
    receiptId: "rcpt_run_3_auto",
    tenantId: "tenant_default",
    runId: "run_3",
    settlementId: "setl_run_3",
    decisionRecord: decision,
    status: "released",
    amountCents: 2000,
    releasedAmountCents: 2000,
    refundedAmountCents: 0,
    releaseRatePct: 100,
    currency: "USD",
    runStatus: "completed",
    resolutionEventId: "ev_run_3_2",
    settledAt: "2026-02-08T00:00:05.000Z",
    createdAt: "2026-02-08T00:00:07.000Z"
  });

  const verification = verifySettlementKernelArtifacts({
    settlement: {
      runId: "run_3",
      settlementId: "setl_run_3",
      decisionTrace: {
        decisionRecord: decision,
        settlementReceipt: receipt
      }
    },
    runId: "run_3"
  });

  assert.equal(verification.valid, false);
  assert.ok(verification.errors.includes(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_BEFORE_DECISION));
  assert.ok(verification.errors.includes(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_SETTLED_BEFORE_DECISION));
  assert.ok(verification.errors.includes(SETTLEMENT_KERNEL_VERIFICATION_CODE.SETTLEMENT_RECEIPT_SETTLED_BEFORE_CREATED));
});

test("Settlement kernel preserves x402 authorization/request/response bindings", () => {
  const decision = buildSettlementDecisionRecord({
    decisionId: "dec_run_4_auto",
    tenantId: "tenant_default",
    runId: "run_4",
    settlementId: "setl_run_4",
    agreementId: "agr_4",
    decisionStatus: "auto_resolved",
    decisionMode: "automatic",
    verificationStatus: "green",
    policyHashUsed: "3".repeat(64),
    verificationMethodHashUsed: "4".repeat(64),
    policyRef: {
      policyHash: "3".repeat(64),
      verificationMethodHash: "4".repeat(64)
    },
    verifierRef: {
      verifierId: "settld.policy-engine",
      verifierVersion: "v1",
      verifierHash: "5".repeat(64),
      modality: "deterministic"
    },
    runStatus: "completed",
    runLastEventId: "ev_run_4_2",
    runLastChainHash: "ch_run_4_2",
    resolutionEventId: "ev_run_4_2",
    bindings: {
      authorizationRef: "auth_gate_4",
      token: {
        kid: "k_2026_02_16_01",
        sha256: "a".repeat(64),
        expiresAt: "2026-02-08T00:05:00.000Z"
      },
      request: {
        sha256: "b".repeat(64)
      },
      response: {
        status: 200,
        sha256: "c".repeat(64)
      },
      providerSig: {
        required: true,
        present: true,
        verified: true,
        providerKeyId: "provkey_1",
        keyJwkThumbprintSha256: "6".repeat(64),
        error: null
      },
      providerQuoteSig: {
        required: true,
        present: true,
        verified: true,
        providerKeyId: "provkey_1",
        quoteId: "x402quote_1",
        quoteSha256: "7".repeat(64),
        keyJwkThumbprintSha256: "8".repeat(64),
        error: null
      },
      reserve: {
        adapter: "circle",
        mode: "transfer",
        reserveId: "circle_transfer_123",
        status: "reserved"
      },
      quote: {
        quoteId: "x402quote_1",
        quoteSha256: "1".repeat(64),
        expiresAt: "2026-02-08T00:10:00.000Z",
        requestBindingMode: "strict",
        requestBindingSha256: "2".repeat(64)
      },
      spendAuthorization: {
        spendAuthorizationVersion: "SpendAuthorization.v1",
        idempotencyKey: "x402:gate_4:x402quote_1",
        nonce: "x402nonce_1",
        sponsorRef: "sponsor_acme",
        sponsorWalletRef: "wallet_sponsor_1",
        agentKeyId: "agent_key_1",
        delegationRef: "deleg_1",
        policyVersion: 3,
        policyFingerprint: "3".repeat(64)
      },
      policyDecisionFingerprint: {
        fingerprintVersion: "PolicyDecisionFingerprint.v1",
        policyId: "policy_default_auto",
        policyVersion: 7,
        policyHash: "d".repeat(64),
        verificationMethodHash: "e".repeat(64),
        evaluationHash: "f".repeat(64)
      }
    },
    decidedAt: "2026-02-08T00:00:00.000Z"
  });
  assert.equal(decision.bindings.authorizationRef, "auth_gate_4");
  assert.equal(decision.bindings.request.sha256, "b".repeat(64));
  assert.equal(decision.bindings.quote.quoteId, "x402quote_1");
  assert.equal(decision.bindings.providerQuoteSig.quoteId, "x402quote_1");
  assert.equal(decision.bindings.spendAuthorization.policyVersion, 3);
  assert.equal(decision.bindings.policyDecisionFingerprint.policyId, "policy_default_auto");
  assert.equal(decision.bindings.policyDecisionFingerprint.evaluationHash, "f".repeat(64));

  const receipt = buildSettlementReceipt({
    receiptId: "rcpt_run_4_auto",
    tenantId: "tenant_default",
    runId: "run_4",
    settlementId: "setl_run_4",
    decisionRecord: decision,
    status: "released",
    amountCents: 2000,
    releasedAmountCents: 2000,
    refundedAmountCents: 0,
    releaseRatePct: 100,
    currency: "USD",
    runStatus: "completed",
    resolutionEventId: "ev_run_4_2",
    settledAt: "2026-02-08T00:00:05.000Z",
    createdAt: "2026-02-08T00:00:06.000Z",
    bindings: decision.bindings
  });
  assert.equal(receipt.bindings.response.status, 200);
  assert.equal(receipt.bindings.providerSig.verified, true);
  assert.equal(receipt.bindings.providerSig.keyJwkThumbprintSha256, "6".repeat(64));
  assert.equal(receipt.bindings.providerQuoteSig.verified, true);
  assert.equal(receipt.bindings.providerQuoteSig.keyJwkThumbprintSha256, "8".repeat(64));
  assert.equal(receipt.bindings.quote.requestBindingMode, "strict");
  assert.equal(receipt.bindings.spendAuthorization.sponsorRef, "sponsor_acme");
  assert.equal(receipt.bindings.policyDecisionFingerprint.policyVersion, 7);
});
