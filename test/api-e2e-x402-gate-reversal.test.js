import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { signX402ProviderRefundDecisionV1 } from "../src/core/x402-provider-refund-decision.js";
import { signX402ReversalCommandV1 } from "../src/core/x402-reversal-command.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { agentId }) {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
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
  return { agentId, publicKeyPem, privateKeyPem };
}

async function creditWallet(api, { agentId, amountCents, idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/wallet/credit`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: { amountCents, currency: "USD" }
  });
  assert.equal(response.statusCode, 201, response.body);
}

function autoPolicy100() {
  return {
    mode: "automatic",
    rules: {
      autoReleaseOnGreen: true,
      greenReleaseRatePct: 100,
      autoReleaseOnAmber: false,
      amberReleaseRatePct: 0,
      autoReleaseOnRed: true,
      redReleaseRatePct: 0
    }
  };
}

async function loadReversalBindings(api, { gateId, payerAgentId }) {
  const gateRes = await request(api, {
    method: "GET",
    path: `/x402/gate/${encodeURIComponent(gateId)}`
  });
  assert.equal(gateRes.statusCode, 200, gateRes.body);
  const gate = gateRes.json?.gate ?? null;
  const settlement = gateRes.json?.settlement ?? null;
  const receiptId =
    typeof settlement?.decisionTrace?.settlementReceipt?.receiptId === "string" &&
    settlement.decisionTrace.settlementReceipt.receiptId.trim() !== ""
      ? settlement.decisionTrace.settlementReceipt.receiptId.trim()
      : typeof gate?.authorization?.authorizationRef === "string" && gate.authorization.authorizationRef.trim() !== ""
        ? gate.authorization.authorizationRef.trim()
        : `auth_${gateId}`;
  const quoteId =
    typeof settlement?.decisionTrace?.bindings?.quote?.quoteId === "string" &&
    settlement.decisionTrace.bindings.quote.quoteId.trim() !== ""
      ? settlement.decisionTrace.bindings.quote.quoteId.trim()
      : typeof gate?.quote?.quoteId === "string" && gate.quote.quoteId.trim() !== ""
        ? gate.quote.quoteId.trim()
        : null;
  const requestSha256 =
    typeof settlement?.decisionTrace?.bindings?.request?.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(settlement.decisionTrace.bindings.request.sha256.trim())
      ? settlement.decisionTrace.bindings.request.sha256.trim().toLowerCase()
      : null;
  const sponsorRef =
    typeof settlement?.decisionTrace?.bindings?.spendAuthorization?.sponsorRef === "string" &&
    settlement.decisionTrace.bindings.spendAuthorization.sponsorRef.trim() !== ""
      ? settlement.decisionTrace.bindings.spendAuthorization.sponsorRef.trim()
      : typeof gate?.agentPassport?.sponsorRef === "string" && gate.agentPassport.sponsorRef.trim() !== ""
        ? gate.agentPassport.sponsorRef.trim()
        : payerAgentId;
  assert.ok(receiptId, "receiptId is required for reversal");
  return { receiptId, quoteId, requestSha256, sponsorRef };
}

function signReversalCommand({
  payer,
  gateId,
  receiptId,
  quoteId,
  requestSha256 = null,
  sponsorRef,
  action,
  commandId,
  idempotencyKey,
  nonce
}) {
  return signX402ReversalCommandV1({
    command: {
      commandId,
      sponsorRef,
      agentKeyId: payer.agentId,
      target: {
        gateId,
        receiptId,
        ...(quoteId ? { quoteId } : {}),
        ...(requestSha256 ? { requestSha256 } : {})
      },
      action,
      nonce,
      idempotencyKey,
      exp: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    },
    signedAt: new Date().toISOString(),
    publicKeyPem: payer.publicKeyPem,
    privateKeyPem: payer.privateKeyPem
  });
}

function signProviderRefundDecision({
  payee,
  gateId,
  receiptId,
  quoteId,
  requestSha256 = null,
  decision,
  reason = null
}) {
  return signX402ProviderRefundDecisionV1({
    decision: {
      decisionId: `dec_${gateId}_${decision}`,
      receiptId,
      gateId,
      ...(quoteId ? { quoteId } : {}),
      ...(requestSha256 ? { requestSha256 } : {}),
      decision,
      reason,
      decidedAt: new Date().toISOString()
    },
    signedAt: new Date().toISOString(),
    publicKeyPem: payee.publicKeyPem,
    privateKeyPem: payee.privateKeyPem
  });
}

test("API e2e: x402 reversal void_authorization refunds locked gate before execution", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const payer = await registerAgent(api, { agentId: "agt_x402_void_payer_1" });
  const payee = await registerAgent(api, { agentId: "agt_x402_void_payee_1" });
  await creditWallet(api, { agentId: payer.agentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_void_1" });

  const gateId = "x402gate_void_1";
  const amountCents = 500;
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_void_1" },
    body: {
      gateId,
      payerAgentId: payer.agentId,
      payeeAgentId: payee.agentId,
      amountCents,
      currency: "USD",
      toolId: "mock_search"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authorize_void_1" },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const bindings = await loadReversalBindings(api, { gateId, payerAgentId: payer.agentId });
  const voidCommand = signReversalCommand({
    payer,
    gateId,
    receiptId: bindings.receiptId,
    quoteId: bindings.quoteId,
    requestSha256: bindings.requestSha256,
    sponsorRef: bindings.sponsorRef,
    action: "void_authorization",
    commandId: "cmd_void_auth_1",
    idempotencyKey: "idem_void_auth_1",
    nonce: "nonce_void_auth_1"
  });

  const voided = await request(api, {
    method: "POST",
    path: "/x402/gate/reversal",
    headers: { "x-idempotency-key": "x402_gate_reversal_void_1" },
    body: {
      gateId,
      action: "void_authorization",
      reason: "operator_cancelled",
      evidenceRefs: ["ops:ticket:cancel_123"],
      command: voidCommand
    }
  });
  assert.equal(voided.statusCode, 200, voided.body);
  assert.equal(voided.json?.settlement?.status, "refunded");
  assert.equal(voided.json?.gate?.authorization?.status, "voided");
  assert.equal(voided.json?.reversal?.status, "voided");
  assert.equal(voided.json?.settlementReceipt?.status, "refunded");
  assert.equal(voided.json?.reversalEvent?.commandVerification?.verified, true);
  assert.ok(Array.isArray(voided.json?.reversal?.timeline));
  assert.ok(voided.json.reversal.timeline.some((row) => row?.eventType === "authorization_voided"));

  const payerWallet = await request(api, {
    method: "GET",
    path: `/agents/${encodeURIComponent(payer.agentId)}/wallet`
  });
  assert.equal(payerWallet.statusCode, 200, payerWallet.body);
  assert.equal(payerWallet.json?.wallet?.availableCents, 5000);
  assert.equal(payerWallet.json?.wallet?.escrowLockedCents, 0);

  const events = await request(api, {
    method: "GET",
    path: `/x402/reversal-events?gateId=${encodeURIComponent(gateId)}`
  });
  assert.equal(events.statusCode, 200, events.body);
  assert.equal(Array.isArray(events.json?.events), true);
  assert.equal(events.json.events.length, 1);
  assert.equal(events.json.events[0]?.eventType, "authorization_voided");
  assert.equal(typeof events.json.events[0]?.eventHash, "string");
});

test("API e2e: x402 reversal request_refund + resolve_refund accepted moves funds back and updates receipt state", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const payer = await registerAgent(api, { agentId: "agt_x402_refund_payer_1" });
  const payee = await registerAgent(api, { agentId: "agt_x402_refund_payee_1" });
  await creditWallet(api, { agentId: payer.agentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_refund_1" });

  const gateId = "x402gate_refund_1";
  const amountCents = 700;
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_refund_1" },
    body: {
      gateId,
      payerAgentId: payer.agentId,
      payeeAgentId: payee.agentId,
      amountCents,
      currency: "USD",
      toolId: "mock_search"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authorize_refund_1" },
    body: { gateId }
  });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const verify = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_refund_1" },
    body: {
      gateId,
      verificationStatus: "green",
      runStatus: "completed",
      policy: autoPolicy100(),
      verificationMethod: { mode: "deterministic", source: "http_status_v1" },
      evidenceRefs: [`http:request_sha256:${"a".repeat(64)}`, `http:response_sha256:${"b".repeat(64)}`]
    }
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json?.settlement?.status, "released");

  const bindings = await loadReversalBindings(api, { gateId, payerAgentId: payer.agentId });
  const refundRequestCommand = signReversalCommand({
    payer,
    gateId,
    receiptId: bindings.receiptId,
    quoteId: bindings.quoteId,
    requestSha256: bindings.requestSha256,
    sponsorRef: bindings.sponsorRef,
    action: "request_refund",
    commandId: "cmd_refund_request_1",
    idempotencyKey: "idem_refund_request_1",
    nonce: "nonce_refund_request_1"
  });

  const requested = await request(api, {
    method: "POST",
    path: "/x402/gate/reversal",
    headers: { "x-idempotency-key": "x402_gate_reversal_request_refund_1" },
    body: {
      gateId,
      action: "request_refund",
      reason: "result_not_usable",
      evidenceRefs: ["provider:incident:001"],
      command: refundRequestCommand
    }
  });
  assert.equal(requested.statusCode, 202, requested.body);
  assert.equal(requested.json?.reversal?.status, "refund_pending");
  const requestReplay = await request(api, {
    method: "POST",
    path: "/x402/gate/reversal",
    headers: { "x-idempotency-key": "x402_gate_reversal_request_refund_1_replay" },
    body: {
      gateId,
      action: "request_refund",
      reason: "result_not_usable",
      command: refundRequestCommand
    }
  });
  assert.equal(requestReplay.statusCode, 409, requestReplay.body);
  assert.equal(requestReplay.json?.code, "X402_REVERSAL_COMMAND_REPLAY");

  const resolveCommandMissingArtifact = signReversalCommand({
    payer,
    gateId,
    receiptId: bindings.receiptId,
    quoteId: bindings.quoteId,
    requestSha256: bindings.requestSha256,
    sponsorRef: bindings.sponsorRef,
    action: "resolve_refund",
    commandId: "cmd_refund_resolve_missing_artifact_1",
    idempotencyKey: "idem_refund_resolve_missing_artifact_1",
    nonce: "nonce_refund_resolve_missing_artifact_1"
  });
  const missingArtifact = await request(api, {
    method: "POST",
    path: "/x402/gate/reversal",
    headers: { "x-idempotency-key": "x402_gate_reversal_resolve_refund_missing_artifact_1" },
    body: {
      gateId,
      action: "resolve_refund",
      providerDecision: "accepted",
      command: resolveCommandMissingArtifact
    }
  });
  assert.equal(missingArtifact.statusCode, 400, missingArtifact.body);
  assert.equal(missingArtifact.json?.code, "SCHEMA_INVALID");

  const resolveCommand = signReversalCommand({
    payer,
    gateId,
    receiptId: bindings.receiptId,
    quoteId: bindings.quoteId,
    requestSha256: bindings.requestSha256,
    sponsorRef: bindings.sponsorRef,
    action: "resolve_refund",
    commandId: "cmd_refund_resolve_1",
    idempotencyKey: "idem_refund_resolve_1",
    nonce: "nonce_refund_resolve_1"
  });
  const providerDecisionArtifact = signProviderRefundDecision({
    payee,
    gateId,
    receiptId: bindings.receiptId,
    quoteId: bindings.quoteId,
    requestSha256: bindings.requestSha256,
    decision: "accepted",
    reason: "provider_acknowledged"
  });
  const resolved = await request(api, {
    method: "POST",
    path: "/x402/gate/reversal",
    headers: { "x-idempotency-key": "x402_gate_reversal_resolve_refund_1" },
    body: {
      gateId,
      action: "resolve_refund",
      providerDecision: "accepted",
      reason: "provider_acknowledged",
      command: resolveCommand,
      providerDecisionArtifact
    }
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json?.reversal?.status, "refunded");
  assert.equal(resolved.json?.settlement?.status, "refunded");
  assert.equal(resolved.json?.settlement?.releasedAmountCents, 0);
  assert.equal(resolved.json?.settlement?.refundedAmountCents, amountCents);
  assert.equal(resolved.json?.settlementReceipt?.status, "refunded");
  assert.equal(resolved.json?.reversalEvent?.providerDecisionVerification?.verified, true);
  assert.ok(resolved.json?.reversal?.timeline?.some((row) => row?.eventType === "refund_requested"));
  assert.ok(resolved.json?.reversal?.timeline?.some((row) => row?.eventType === "refund_resolved"));

  const payerWallet = await request(api, {
    method: "GET",
    path: `/agents/${encodeURIComponent(payer.agentId)}/wallet`
  });
  assert.equal(payerWallet.statusCode, 200, payerWallet.body);
  assert.equal(payerWallet.json?.wallet?.availableCents, 5000);

  const payeeWallet = await request(api, {
    method: "GET",
    path: `/agents/${encodeURIComponent(payee.agentId)}/wallet`
  });
  assert.equal(payeeWallet.statusCode, 200, payeeWallet.body);
  assert.equal(payeeWallet.json?.wallet?.availableCents, 0);

  const events = await request(api, {
    method: "GET",
    path: `/x402/reversal-events?gateId=${encodeURIComponent(gateId)}`
  });
  assert.equal(events.statusCode, 200, events.body);
  assert.equal(Array.isArray(events.json?.events), true);
  assert.equal(events.json.events.length, 2);
  const latest = events.json.events[0];
  const prior = events.json.events[1];
  assert.equal(latest.eventType, "refund_resolved");
  assert.equal(prior.eventType, "refund_requested");
  assert.equal(latest.prevEventHash, prior.eventHash);
});
