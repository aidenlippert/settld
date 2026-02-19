import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { canonicalJsonStringify } from "../src/core/canonical-json.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";
import {
  buildToolProviderQuotePayloadV1,
  computeToolProviderQuotePayloadHashV1,
  signToolProviderQuoteSignatureV1
} from "../src/core/provider-quote-signature.js";
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

async function createVerifiedReceipt({
  api,
  gateId,
  amountCents,
  payerAgentId,
  payeeAgentId,
  providerSigner,
  quoteId,
  requestHashSeed,
  responseProviderTag,
  verificationStatus = "green",
  idSuffix
}) {
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": `x402_gate_create_finance_${idSuffix}` },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD",
      toolId: "mock_search"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": `x402_gate_authz_finance_${idSuffix}` },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const responseBodyCanonical = canonicalJsonStringify({ ok: true, provider: responseProviderTag });
  const responseHash = sha256Hex(responseBodyCanonical);
  const responseNonceHex = Number(idSuffix).toString(16).padStart(16, "0");
  const responseSig = signToolProviderSignatureV1({
    responseHash,
    nonce: responseNonceHex,
    signedAt: `2026-02-18T02:${String(idSuffix).padStart(2, "0")}:00.000Z`,
    publicKeyPem: providerSigner.publicKeyPem,
    privateKeyPem: providerSigner.privateKeyPem
  });

  const quotePayload = buildToolProviderQuotePayloadV1({
    providerId: payeeAgentId,
    toolId: "mock_search",
    amountCents,
    currency: "USD",
    address: "mock:payee",
    network: "mocknet",
    requestBindingMode: "strict",
    requestBindingSha256: requestHashSeed,
    quoteRequired: true,
    quoteId,
    spendAuthorizationMode: "required",
    quotedAt: "2026-02-18T00:59:00.000Z",
    expiresAt: "2026-02-18T01:59:00.000Z"
  });
  const quoteSig = signToolProviderQuoteSignatureV1({
    quote: quotePayload,
    nonce: Number(idSuffix + 100).toString(16).padStart(16, "0"),
    signedAt: "2026-02-18T00:59:05.000Z",
    publicKeyPem: providerSigner.publicKeyPem,
    privateKeyPem: providerSigner.privateKeyPem
  });

  const verify = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": `x402_gate_verify_finance_${idSuffix}` },
    body: {
      gateId,
      verificationStatus,
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
      verificationMethod: { mode: "attested", source: "provider_signature_v1" },
      evidenceRefs: [`http:request_sha256:${requestHashSeed}`, `http:response_sha256:${responseHash}`],
      providerSignature: {
        ...responseSig,
        publicKeyPem: providerSigner.publicKeyPem
      },
      providerQuoteSignature: {
        ...quoteSig,
        quoteId: quotePayload.quoteId,
        quoteSha256: computeToolProviderQuotePayloadHashV1({ quote: quotePayload }),
        publicKeyPem: providerSigner.publicKeyPem
      },
      providerQuotePayload: quotePayload
    }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const receiptId = verify.json?.settlementReceipt?.receiptId;
  assert.equal(typeof receiptId, "string");
  assert.ok(receiptId);
  return { receiptId };
}

test("API e2e: x402 finance receipts CSV + pilot invoicing summary + webhook notification", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_finance_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_finance_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_finance_1" });

  const providerSigner = createEd25519Keypair();
  const first = await createVerifiedReceipt({
    api,
    gateId: "gate_finance_receipt_1",
    amountCents: 500,
    payerAgentId,
    payeeAgentId,
    providerSigner,
    quoteId: "x402quote_finance_1",
    requestHashSeed: "d".repeat(64),
    responseProviderTag: "finance_1",
    verificationStatus: "green",
    idSuffix: 1
  });
  const second = await createVerifiedReceipt({
    api,
    gateId: "gate_finance_receipt_2",
    amountCents: 700,
    payerAgentId,
    payeeAgentId,
    providerSigner,
    quoteId: "x402quote_finance_2",
    requestHashSeed: "e".repeat(64),
    responseProviderTag: "finance_2",
    verificationStatus: "red",
    idSuffix: 2
  });

  const startAt = encodeURIComponent("2000-01-01T00:00:00.000Z");
  const endAt = encodeURIComponent("2100-01-01T00:00:00.000Z");
  const csvPath = `/ops/finance/receipts.csv?startAt=${startAt}&endAt=${endAt}&toolId=mock_search&limit=100`;

  const csvOne = await request(api, { method: "GET", path: csvPath });
  assert.equal(csvOne.statusCode, 200, csvOne.body);
  const csvTwo = await request(api, { method: "GET", path: csvPath });
  assert.equal(csvTwo.statusCode, 200, csvTwo.body);
  assert.equal(String(csvOne.body), String(csvTwo.body), "CSV export must be deterministic for same window");
  assert.match(
    String(csvOne.body),
    /^receiptId,gateId,runId,payer,payee,amountCents,currency,settlementState,disputeStatus,policyHash,decisionHash,policyDecisionHash,settledAt/m
  );
  assert.match(String(csvOne.body), new RegExp(`${first.receiptId}|${second.receiptId}`));

  const summary = await request(api, {
    method: "GET",
    path: `/ops/finance/pilot-invoicing?startAt=${startAt}&endAt=${endAt}&toolId=mock_search`
  });
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json?.schemaVersion, "X402PilotInvoicingSummary.v1");
  assert.equal(summary.json?.periodStart, "2000-01-01T00:00:00.000Z");
  assert.equal(summary.json?.periodEnd, "2100-01-01T00:00:00.000Z");
  assert.equal(summary.json?.settlementCount, 2);
  assert.equal(summary.json?.disputeCount, 1);
  assert.equal(summary.json?.totalAmountCents, 1200);

  const summaryCsv = await request(api, {
    method: "GET",
    path: `/ops/finance/pilot-invoicing?startAt=${startAt}&endAt=${endAt}&toolId=mock_search&format=csv`
  });
  assert.equal(summaryCsv.statusCode, 200, summaryCsv.body);
  assert.match(String(summaryCsv.body), /^periodStart,periodEnd,settlementCount,disputeCount,totalAmountCents/m);
  assert.match(String(summaryCsv.body), /,2,1,1200/);

  const notifications = await request(api, {
    method: "GET",
    path: "/ops/notifications?topic=NOTIFY_FINANCE_X402_RECEIPT_RECORDED&limit=10",
    headers: { "x-proxy-ops-token": "tok_ops" },
    auth: "none"
  });
  assert.equal(notifications.statusCode, 200, notifications.body);
  assert.ok(Array.isArray(notifications.json?.notifications));
  assert.ok(notifications.json.notifications.length >= 1);
  const firstPayload = notifications.json.notifications[0]?.payload ?? {};
  assert.equal(firstPayload.type, "NOTIFY_FINANCE_X402_RECEIPT_RECORDED");
  assert.match(String(firstPayload.receiptId ?? ""), /^rcpt_/);
});
