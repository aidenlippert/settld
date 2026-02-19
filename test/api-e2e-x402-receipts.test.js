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
  idSuffix
}) {
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": `x402_gate_create_receipt_${idSuffix}` },
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
    headers: { "x-idempotency-key": `x402_gate_authz_receipt_${idSuffix}` },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const responseBodyCanonical = canonicalJsonStringify({ ok: true, provider: responseProviderTag });
  const responseHash = sha256Hex(responseBodyCanonical);
  const responseNonceHex = Number(idSuffix).toString(16).padStart(16, "0");
  const responseSig = signToolProviderSignatureV1({
    responseHash,
    nonce: responseNonceHex,
    signedAt: `2026-02-18T01:${String(idSuffix).padStart(2, "0")}:00.000Z`,
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
    headers: { "x-idempotency-key": `x402_gate_verify_receipt_${idSuffix}` },
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
  return { receiptId, quotePayload };
}

test("API e2e: x402 receipt list/get/export returns durable receipt with verification key evidence", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_receipt_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_receipt_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_receipt_1" });

  const providerSigner = createEd25519Keypair();
  const first = await createVerifiedReceipt({
    api,
    gateId: "gate_receipt_1",
    amountCents: 500,
    payerAgentId,
    payeeAgentId,
    providerSigner,
    quoteId: "x402quote_receipt_1",
    requestHashSeed: "b".repeat(64),
    responseProviderTag: "mock_receipts_1",
    idSuffix: 1
  });
  const second = await createVerifiedReceipt({
    api,
    gateId: "gate_receipt_2",
    amountCents: 700,
    payerAgentId,
    payeeAgentId,
    providerSigner,
    quoteId: "x402quote_receipt_2",
    requestHashSeed: "c".repeat(64),
    responseProviderTag: "mock_receipts_2",
    idSuffix: 2
  });
  const receiptId = first.receiptId;
  const quotePayload = first.quotePayload;

  const listed = await request(api, {
    method: "GET",
    path: `/x402/receipts?toolId=${encodeURIComponent("mock_search")}&limit=10`
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.ok(Array.isArray(listed.json?.receipts));
  const found = listed.json.receipts.find((row) => row?.receiptId === receiptId);
  assert.ok(found);
  assert.match(String(found?.verificationContext?.providerSigningKey?.jwkThumbprintSha256 ?? ""), /^[0-9a-f]{64}$/);
  assert.match(String(found?.verificationContext?.providerQuoteSigningKey?.jwkThumbprintSha256 ?? ""), /^[0-9a-f]{64}$/);
  assert.equal(String(found?.bindings?.providerSig?.verified ?? ""), "true");
  assert.equal(String(found?.bindings?.providerQuoteSig?.verified ?? ""), "true");
  assert.match(String(found?.bindings?.providerSig?.keyJwkThumbprintSha256 ?? ""), /^[0-9a-f]{64}$/);
  assert.match(String(found?.bindings?.providerQuoteSig?.keyJwkThumbprintSha256 ?? ""), /^[0-9a-f]{64}$/);
  assert.equal(String(found?.providerSignature?.keyId ?? ""), String(found?.bindings?.providerSig?.providerKeyId ?? ""));
  assert.equal(String(found?.providerQuotePayload?.quoteId ?? ""), quotePayload.quoteId);

  const pagedFirst = await request(api, {
    method: "GET",
    path: "/x402/receipts?toolId=mock_search&limit=1"
  });
  assert.equal(pagedFirst.statusCode, 200, pagedFirst.body);
  assert.equal(Array.isArray(pagedFirst.json?.receipts), true);
  assert.equal(pagedFirst.json.receipts.length, 1);
  const nextCursor = typeof pagedFirst.json?.nextCursor === "string" ? pagedFirst.json.nextCursor : "";
  assert.ok(nextCursor.length > 0);

  const pagedSecond = await request(api, {
    method: "GET",
    path: `/x402/receipts?toolId=mock_search&limit=1&cursor=${encodeURIComponent(nextCursor)}`
  });
  assert.equal(pagedSecond.statusCode, 200, pagedSecond.body);
  assert.equal(Array.isArray(pagedSecond.json?.receipts), true);
  assert.equal(pagedSecond.json.receipts.length, 1);
  assert.notEqual(String(pagedFirst.json.receipts[0]?.receiptId ?? ""), String(pagedSecond.json.receipts[0]?.receiptId ?? ""));
  assert.ok([first.receiptId, second.receiptId].includes(String(pagedSecond.json.receipts[0]?.receiptId ?? "")));

  const byId = await request(api, {
    method: "GET",
    path: `/x402/receipts/${encodeURIComponent(receiptId)}`
  });
  assert.equal(byId.statusCode, 200, byId.body);
  assert.equal(byId.json?.receipt?.receiptId, receiptId);

  const exported = await request(api, {
    method: "GET",
    path: "/x402/receipts/export?limit=10"
  });
  assert.equal(exported.statusCode, 200, exported.body);
  const exportText = exported.body;
  const exportLines = String(exportText)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(exportLines.length >= 1);
  const parsedFirst = JSON.parse(exportLines[0]);
  assert.equal(parsedFirst.schemaVersion, "X402ReceiptRecord.v1");
  assert.ok(
    exported.headers &&
      (typeof exported.headers["x-next-cursor"] === "undefined" || typeof exported.headers["x-next-cursor"] === "string")
  );
});
