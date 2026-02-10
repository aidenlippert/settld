import test from "node:test";
import assert from "node:assert/strict";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import {
  buildToolCallAgreementV1,
  verifyToolCallAgreementV1,
  buildToolCallEvidenceV1,
  verifyToolCallEvidenceV1,
  buildToolCallDisputeOpenV1,
  verifyToolCallDisputeOpenV1,
  buildSettlementDecisionRecordV1,
  verifySettlementDecisionRecordV1,
  buildSettlementReceiptV2,
  verifySettlementReceiptV2
} from "../src/core/settlement-kernel.js";

test("settlement kernel: signed objects verify and fail on tamper", () => {
  const payer = createEd25519Keypair();
  const provider = createEd25519Keypair();
  const verifier = createEd25519Keypair();

  const payerSigner = { keyId: keyIdFromPublicKeyPem(payer.publicKeyPem), privateKeyPem: payer.privateKeyPem };
  const providerSigner = { keyId: keyIdFromPublicKeyPem(provider.publicKeyPem), privateKeyPem: provider.privateKeyPem };
  const verifierSigner = { keyId: keyIdFromPublicKeyPem(verifier.publicKeyPem), privateKeyPem: verifier.privateKeyPem };

  const tenantId = "tenant_test";
  const toolId = "tool_test_translate";
  const toolManifestHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const authorityGrantId = "auth_test_0001";
  const authorityGrantHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  const agreement = buildToolCallAgreementV1({
    tenantId,
    artifactId: "tca_test_0001",
    toolId,
    toolManifestHash,
    authorityGrantId,
    authorityGrantHash,
    payerAgentId: "agt_payer_0001",
    payeeAgentId: "agt_payee_0001",
    amountCents: 250,
    currency: "USD",
    callId: "call_test_0001",
    input: { text: "hello", to: "es" },
    createdAt: "2026-02-01T00:00:00.000Z",
    signer: payerSigner
  });
  verifyToolCallAgreementV1({ agreement, publicKeyPem: payer.publicKeyPem });

  const evidence = buildToolCallEvidenceV1({
    tenantId,
    artifactId: "tce_test_0001",
    toolId,
    toolManifestHash,
    agreementId: agreement.artifactId,
    agreementHash: agreement.agreementHash,
    callId: agreement.callId,
    input: { text: "hello", to: "es" },
    inputHash: agreement.inputHash,
    output: { text: "hola", lang: "es" },
    startedAt: "2026-02-01T00:00:01.000Z",
    completedAt: "2026-02-01T00:00:02.000Z",
    signer: providerSigner
  });
  verifyToolCallEvidenceV1({ evidence, publicKeyPem: provider.publicKeyPem });

  const decision = buildSettlementDecisionRecordV1({
    tenantId,
    artifactId: "sdr_test_0001",
    agreementId: agreement.artifactId,
    agreementHash: agreement.agreementHash,
    evidenceId: evidence.artifactId,
    evidenceHash: evidence.evidenceHash,
    decision: "approved",
    modality: "cryptographic",
    verifierRef: { verifierId: "settld-test", version: "0.0.0" },
    policyRef: null,
    reasonCodes: ["cryptographic_binding_ok"],
    evaluationSummary: { signatures: true, bindings: true, authority: true, inputCommitment: true },
    decidedAt: "2026-02-01T00:00:03.000Z",
    signer: verifierSigner
  });
  verifySettlementDecisionRecordV1({ record: decision, publicKeyPem: verifier.publicKeyPem });

  const receipt = buildSettlementReceiptV2({
    tenantId,
    artifactId: "sr_test_0001",
    agreementId: agreement.artifactId,
    agreementHash: agreement.agreementHash,
    decisionId: decision.artifactId,
    decisionHash: decision.recordHash,
    payerAgentId: agreement.payerAgentId,
    payeeAgentId: agreement.payeeAgentId,
    amountCents: agreement.amountCents,
    currency: agreement.currency,
    agreementAmountCents: agreement.amountCents,
    outcome: "paid",
    retention: null,
    settledAt: "2026-02-01T00:00:04.000Z",
    ledger: { kind: "test" },
    signer: verifierSigner
  });
  verifySettlementReceiptV2({ receipt, publicKeyPem: verifier.publicKeyPem });

  const disputeOpen = buildToolCallDisputeOpenV1({
    tenantId,
    artifactId: "tcd_test_0001",
    toolId,
    agreementId: agreement.artifactId,
    agreementHash: agreement.agreementHash,
    receiptId: receipt.artifactId,
    receiptHash: receipt.receiptHash,
    openedByAgentId: agreement.payerAgentId,
    reasonCode: "quality",
    reason: "bad output",
    evidenceRefs: ["artifact:tce_test_0001"],
    openedAt: "2026-02-01T00:00:04.500Z",
    signer: payerSigner
  });
  verifyToolCallDisputeOpenV1({ disputeOpen, publicKeyPem: payer.publicKeyPem });

  assert.throws(() => {
    verifyToolCallAgreementV1({
      agreement: { ...agreement, amountCents: agreement.amountCents + 1 },
      publicKeyPem: payer.publicKeyPem
    });
  });
});
