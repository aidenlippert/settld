import crypto from "node:crypto";
import fs from "node:fs/promises";

import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex } from "../../src/core/crypto.js";
import {
  buildToolProviderQuotePayloadV1,
  computeToolProviderQuotePayloadHashV1,
  signToolProviderQuoteSignatureV1
} from "../../src/core/provider-quote-signature.js";
import {
  buildSettlementDecisionRecordV2,
  buildSettlementReceiptV1
} from "../../src/core/settlement-kernel.js";
import { signToolProviderSignatureV1 } from "../../src/core/tool-provider-signature.js";

const fixtureKeys = JSON.parse(await fs.readFile(new URL("../fixtures/keys/fixture_keypairs.json", import.meta.url), "utf8"));

function keyEvidenceFromPublicKeyPem(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const exported = key.export({ format: "jwk" });
  const jwk = normalizeForCanonicalJson(
    {
      kty: "OKP",
      crv: "Ed25519",
      x: String(exported.x ?? "")
    },
    { path: "$" }
  );
  return {
    schemaVersion: "VerificationKeyEvidence.v1",
    keyId: keyIdFromPublicKeyPem(publicKeyPem),
    publicKeyPem,
    jwk,
    jwkThumbprintSha256: sha256Hex(canonicalJsonStringify(jwk))
  };
}

export function buildX402ReceiptVerifierVector() {
  const providerKeys = fixtureKeys.serverA;
  const providerPublicKeyPem = String(providerKeys.publicKeyPem ?? "").trim();
  const providerPrivateKeyPem = String(providerKeys.privateKeyPem ?? "").trim();
  const requestSha256 = "a".repeat(64);
  const responseBody = normalizeForCanonicalJson({ ok: true, rows: [{ id: "r1", score: 0.99 }] }, { path: "$" });
  const responseSha256 = sha256Hex(canonicalJsonStringify(responseBody));

  const quotePayload = buildToolProviderQuotePayloadV1({
    providerId: "agt_payee_vector_1",
    toolId: "mock_search",
    amountCents: 500,
    currency: "USD",
    address: "mock:payee",
    network: "mocknet",
    requestBindingMode: "strict",
    requestBindingSha256: requestSha256,
    quoteRequired: true,
    quoteId: "x402quote_vector_1",
    spendAuthorizationMode: "required",
    quotedAt: "2026-02-18T00:00:00.000Z",
    expiresAt: "2026-02-18T00:05:00.000Z"
  });
  const quoteSignature = signToolProviderQuoteSignatureV1({
    quote: quotePayload,
    nonce: "abcd1234abcd1234",
    signedAt: "2026-02-18T00:00:01.000Z",
    publicKeyPem: providerPublicKeyPem,
    privateKeyPem: providerPrivateKeyPem
  });
  const providerQuoteSig = {
    ...quoteSignature,
    quoteId: quotePayload.quoteId,
    quoteSha256: computeToolProviderQuotePayloadHashV1({ quote: quotePayload }),
    publicKeyPem: providerPublicKeyPem
  };

  const providerSignature = signToolProviderSignatureV1({
    responseHash: responseSha256,
    nonce: "1234abcd1234abcd",
    signedAt: "2026-02-18T00:00:02.000Z",
    publicKeyPem: providerPublicKeyPem,
    privateKeyPem: providerPrivateKeyPem
  });

  const providerKeyEvidence = keyEvidenceFromPublicKeyPem(providerPublicKeyPem);
  const bindings = {
    authorizationRef: "auth_x402gate_vector_1",
    token: {
      kid: "key_settld_vector_1",
      sha256: "b".repeat(64),
      expiresAt: "2026-02-18T00:05:00.000Z"
    },
    request: { sha256: requestSha256 },
    response: { status: 200, sha256: responseSha256 },
    providerSig: {
      required: true,
      present: true,
      verified: true,
      providerKeyId: providerSignature.keyId,
      keyJwkThumbprintSha256: providerKeyEvidence.jwkThumbprintSha256,
      error: null
    },
    providerQuoteSig: {
      required: true,
      present: true,
      verified: true,
      providerKeyId: providerQuoteSig.keyId,
      quoteId: quotePayload.quoteId,
      quoteSha256: providerQuoteSig.quoteSha256,
      keyJwkThumbprintSha256: providerKeyEvidence.jwkThumbprintSha256,
      error: null
    },
    quote: {
      quoteId: quotePayload.quoteId,
      quoteSha256: providerQuoteSig.quoteSha256,
      expiresAt: quotePayload.expiresAt,
      requestBindingMode: quotePayload.requestBindingMode,
      requestBindingSha256: quotePayload.requestBindingSha256
    },
    reserve: {
      adapter: "circle",
      mode: "transfer",
      reserveId: "circle_transfer_vector_1",
      status: "settled"
    },
    spendAuthorization: {
      spendAuthorizationVersion: "SpendAuthorization.v1",
      idempotencyKey: "idem_x402_vector_1",
      nonce: "nonce_vector_1",
      sponsorRef: "sponsor_acme",
      sponsorWalletRef: "wallet_acme_1",
      agentKeyId: "agent_key_1",
      delegationRef: "delegation_1",
      policyVersion: 3,
      policyFingerprint: "c".repeat(64)
    },
    policyDecisionFingerprint: {
      fingerprintVersion: "PolicyDecisionFingerprint.v1",
      policyId: "policy_default",
      policyVersion: 3,
      policyHash: "d".repeat(64),
      verificationMethodHash: "e".repeat(64),
      evaluationHash: "f".repeat(64)
    }
  };

  const decisionRecord = buildSettlementDecisionRecordV2({
    decisionId: "dec_x402_vector_1",
    tenantId: "tenant_default",
    runId: "run_x402_vector_1",
    settlementId: "astl_x402_vector_1",
    agreementId: null,
    decisionStatus: "auto_resolved",
    decisionMode: "automatic",
    decisionReason: "x402_provider_signature_green",
    verificationStatus: "green",
    policyHashUsed: "d".repeat(64),
    profileHashUsed: bindings.spendAuthorization.policyFingerprint,
    verificationMethodHashUsed: "e".repeat(64),
    policyRef: {
      policyHash: "d".repeat(64),
      verificationMethodHash: "e".repeat(64)
    },
    verifierRef: {
      verifierId: "settld.x402",
      verifierVersion: "v1",
      verifierHash: null,
      modality: "attested"
    },
    runStatus: "completed",
    runLastEventId: null,
    runLastChainHash: null,
    resolutionEventId: "x402res_vector_1",
    decidedAt: "2026-02-18T00:00:03.000Z",
    bindings
  });

  const settlementReceipt = buildSettlementReceiptV1({
    receiptId: "srec_x402_vector_1",
    tenantId: "tenant_default",
    runId: "run_x402_vector_1",
    settlementId: "astl_x402_vector_1",
    decisionRecord,
    status: "released",
    amountCents: 500,
    releasedAmountCents: 500,
    refundedAmountCents: 0,
    releaseRatePct: 100,
    currency: "USD",
    runStatus: "completed",
    resolutionEventId: "x402res_vector_1",
    settledAt: "2026-02-18T00:00:04.000Z",
    createdAt: "2026-02-18T00:00:04.000Z",
    bindings
  });

  return normalizeForCanonicalJson(
    {
      schemaVersion: "X402ReceiptRecord.v1",
      tenantId: "tenant_default",
      receiptId: settlementReceipt.receiptId,
      gateId: "x402gate_vector_1",
      runId: "run_x402_vector_1",
      payerAgentId: "agt_payer_vector_1",
      providerId: "agt_payee_vector_1",
      toolId: "mock_search",
      sponsorRef: "sponsor_acme",
      sponsorWalletRef: "wallet_acme_1",
      agentKeyId: "agent_key_1",
      settlementState: "released",
      verificationStatus: "green",
      settledAt: "2026-02-18T00:00:04.000Z",
      createdAt: "2026-02-18T00:00:04.000Z",
      updatedAt: "2026-02-18T00:00:05.000Z",
      evidenceRefs: [
        `http:request_sha256:${requestSha256}`,
        `http:response_sha256:${responseSha256}`,
        `provider:key_id:${providerSignature.keyId}`,
        `provider:signed_at:${providerSignature.signedAt}`,
        `provider:nonce:${providerSignature.nonce}`,
        `provider:payload_sha256:${providerSignature.payloadHash}`,
        `provider:sig_b64:${providerSignature.signatureBase64}`,
        `provider_quote:quote_id:${quotePayload.quoteId}`,
        `provider_quote:payload_sha256:${providerQuoteSig.quoteSha256}`,
        `provider:key_jwk_thumbprint_sha256:${providerKeyEvidence.jwkThumbprintSha256}`,
        `provider_quote:key_jwk_thumbprint_sha256:${providerKeyEvidence.jwkThumbprintSha256}`
      ],
      verificationContext: {
        schemaVersion: "X402GateVerificationContext.v1",
        providerSigningKey: providerKeyEvidence,
        providerQuoteSigningKey: providerKeyEvidence
      },
      bindings,
      providerSignature,
      providerQuoteSignature: providerQuoteSig,
      providerQuotePayload: quotePayload,
      decisionRecord,
      settlementReceipt
    },
    { path: "$" }
  );
}
