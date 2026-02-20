import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { hmacSignArtifact } from "../src/core/artifacts.js";
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

async function upsertX402WalletPolicy(api, { policy, idempotencyKey }) {
  return request(api, {
    method: "POST",
    path: "/ops/x402/wallet-policies",
    headers: {
      "x-idempotency-key": idempotencyKey,
      "x-settld-protocol": "1.0"
    },
    body: { policy }
  });
}

async function issueWalletAuthorizationDecision(api, { sponsorWalletRef, gateId, quoteId = null, idempotencyKey }) {
  return request(api, {
    method: "POST",
    path: `/x402/wallets/${encodeURIComponent(sponsorWalletRef)}/authorize`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: {
      gateId,
      ...(quoteId ? { quoteId } : {})
    }
  });
}

test("API e2e: insolvency sweep auto-freezes exhausted payer and emits lifecycle webhook", async () => {
  const webhookCalls = [];
  const fetchFn = async (url, init) => {
    webhookCalls.push({ url, init });
    return new Response("ok", { status: 200 });
  };
  const api = createApi({
    opsToken: "tok_ops",
    fetchFn,
    x402InsolvencySweepIntervalSeconds: 0
  });

  const webhookCreate = await request(api, {
    method: "POST",
    path: "/x402/webhooks/endpoints",
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_webhook_create_insolvency_1"
    },
    body: {
      url: "https://example.invalid/x402/agent-lifecycle",
      events: ["x402.agent.frozen"]
    }
  });
  assert.equal(webhookCreate.statusCode, 201, webhookCreate.body);
  const webhookSecret = webhookCreate.json?.secret;
  assert.ok(typeof webhookSecret === "string" && webhookSecret.length > 0);

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_insolvency_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_insolvency_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 100, idempotencyKey: "wallet_credit_x402_insolvency_1" });

  const gateCreate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_gate_create_insolvency_1"
    },
    body: {
      gateId: "x402_gate_insolvency_1",
      payerAgentId,
      payeeAgentId,
      amountCents: 100,
      currency: "USD"
    }
  });
  assert.equal(gateCreate.statusCode, 201, gateCreate.body);

  const sweep = await api.tickX402InsolvencySweep({
    force: true,
    maxMessages: 10,
    maxTenants: 10,
    batchSize: 10
  });
  assert.equal(sweep.ok, true);
  assert.ok(Array.isArray(sweep.outcomes));
  const frozenOutcome = sweep.outcomes.find(
    (row) => row?.agentId === payerAgentId && row?.action === "frozen" && row?.reasonCode === "FUNDS_EXHAUSTED"
  );
  assert.ok(frozenOutcome);

  const blockedCreate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_gate_create_insolvency_1_blocked"
    },
    body: {
      gateId: "x402_gate_insolvency_1_blocked",
      payerAgentId,
      payeeAgentId,
      amountCents: 10,
      currency: "USD"
    }
  });
  assert.equal(blockedCreate.statusCode, 410, blockedCreate.body);
  assert.equal(blockedCreate.json?.code, "X402_AGENT_FROZEN");

  const deliveryTick = await api.tickDeliveries({ maxMessages: 10 });
  assert.ok(Array.isArray(deliveryTick?.processed));
  assert.equal(webhookCalls.length, 1);
  const webhook = webhookCalls[0];
  assert.equal(webhook?.url, "https://example.invalid/x402/agent-lifecycle");
  const headers = webhook?.init?.headers ?? {};
  const timestamp = headers["x-proxy-timestamp"] ?? headers["X-Proxy-Timestamp"];
  const signature = headers["x-proxy-signature"] ?? headers["X-Proxy-Signature"];
  assert.ok(timestamp);
  assert.ok(signature);
  const body = JSON.parse(String(webhook?.init?.body ?? "{}"));
  assert.equal(body?.artifactType, "X402AgentLifecycle.v1");
  assert.equal(body?.eventType, "frozen");
  assert.equal(body?.agentId, payerAgentId);
  assert.equal(body?.payload?.lifecycle?.reasonCode, "FUNDS_EXHAUSTED");
  const expectedSig = hmacSignArtifact({
    secret: webhookSecret,
    timestamp,
    bodyJson: body
  });
  assert.equal(signature, expectedSig);
});

test("API e2e: insolvency sweep freezes agent when delegation authority is expired", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402InsolvencySweepIntervalSeconds: 0
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_insolvency_payer_2" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_insolvency_payee_2" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 200, idempotencyKey: "wallet_credit_x402_insolvency_2" });

  const gateCreate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_gate_create_insolvency_2"
    },
    body: {
      gateId: "x402_gate_insolvency_2",
      payerAgentId,
      payeeAgentId,
      amountCents: 50,
      currency: "USD"
    }
  });
  assert.equal(gateCreate.statusCode, 201, gateCreate.body);

  const existingGate = await api.store.getX402Gate({ tenantId: "tenant_default", gateId: "x402_gate_insolvency_2" });
  assert.ok(existingGate);
  await api.store.putX402Gate({
    tenantId: "tenant_default",
    gate: {
      ...existingGate,
      agentPassport: {
        schemaVersion: "AgentPassport.v1",
        sponsorRef: "sponsor_insolvency_2",
        agentKeyId: "agent_key_insolvency_2",
        delegationRef: "delegation_insolvency_2",
        lineageRequired: true,
        expiresAt: "2020-01-01T00:00:00.000Z"
      },
      updatedAt: "2026-02-19T00:00:00.000Z"
    }
  });

  const sweep = await api.tickX402InsolvencySweep({
    force: true,
    maxMessages: 10,
    maxTenants: 10,
    batchSize: 10
  });
  assert.equal(sweep.ok, true);
  const frozenOutcome = sweep.outcomes.find(
    (row) => row?.agentId === payerAgentId && row?.action === "frozen" && row?.reasonCode === "DELEGATION_EXPIRED"
  );
  assert.ok(frozenOutcome);

  const blockedAuthorize = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authorize_insolvency_2" },
    body: { gateId: "x402_gate_insolvency_2" }
  });
  assert.equal(blockedAuthorize.statusCode, 410, blockedAuthorize.body);
  assert.equal(blockedAuthorize.json?.code, "X402_AGENT_FROZEN");
});

test("API e2e: freeze unwind auto-denies pending escalation and cancels active quote", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402InsolvencySweepIntervalSeconds: 0
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_unwind_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_unwind_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 10_000, idempotencyKey: "wallet_credit_x402_unwind_1" });

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_unwind_1",
    sponsorWalletRef: "wallet_unwind_1",
    policyRef: "policy_unwind_1",
    policyVersion: 1,
    status: "active",
    maxAmountCents: 2_000,
    maxDailyAuthorizationCents: 300,
    allowedProviderIds: [payeeAgentId],
    allowedToolIds: ["weather_read"],
    allowedCurrencies: ["USD"],
    allowedReversalActions: ["request_refund", "resolve_refund", "void_authorization"],
    requireQuote: false,
    requireStrictRequestBinding: false,
    requireAgentKeyMatch: false
  };
  const createdPolicy = await upsertX402WalletPolicy(api, {
    policy: walletPolicy,
    idempotencyKey: "x402_wallet_policy_unwind_1"
  });
  assert.equal(createdPolicy.statusCode, 201, createdPolicy.body);

  const createGateA = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_gate_create_unwind_1a"
    },
    body: {
      gateId: "x402_gate_unwind_1a",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 300,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_unwind_1",
        delegationRef: "delegation_unwind_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGateA.statusCode, 201, createGateA.body);

  const createGateB = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_gate_create_unwind_1b"
    },
    body: {
      gateId: "x402_gate_unwind_1b",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 200,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_unwind_1",
        delegationRef: "delegation_unwind_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGateB.statusCode, 201, createGateB.body);

  const quote = await request(api, {
    method: "POST",
    path: "/x402/gate/quote",
    headers: { "x-idempotency-key": "x402_gate_quote_unwind_1" },
    body: {
      gateId: "x402_gate_unwind_1a"
    }
  });
  assert.equal(quote.statusCode, 200, quote.body);
  const quoteId = quote.json?.quote?.quoteId;
  assert.ok(typeof quoteId === "string" && quoteId.length > 0);

  const issuerDecisionA = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "x402_gate_unwind_1a",
    quoteId,
    idempotencyKey: "x402_wallet_authorize_unwind_1a"
  });
  assert.equal(issuerDecisionA.statusCode, 200, issuerDecisionA.body);

  const issuerDecisionB = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "x402_gate_unwind_1b",
    idempotencyKey: "x402_wallet_authorize_unwind_1b"
  });
  assert.equal(issuerDecisionB.statusCode, 200, issuerDecisionB.body);

  const authorizeB = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authorize_unwind_1b" },
    body: {
      gateId: "x402_gate_unwind_1b",
      walletAuthorizationDecisionToken: issuerDecisionB.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(authorizeB.statusCode, 200, authorizeB.body);

  const blocked = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authorize_unwind_1a" },
    body: {
      gateId: "x402_gate_unwind_1a",
      quoteId,
      walletAuthorizationDecisionToken: issuerDecisionA.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json?.code, "X402_AUTHORIZATION_ESCALATION_REQUIRED");
  const escalationId = blocked.json?.details?.escalation?.escalationId;
  assert.ok(typeof escalationId === "string" && escalationId.length > 0);

  const pendingEscalation = await request(api, {
    method: "GET",
    path: `/x402/gate/escalations/${encodeURIComponent(escalationId)}`
  });
  assert.equal(pendingEscalation.statusCode, 200, pendingEscalation.body);
  assert.equal(pendingEscalation.json?.escalation?.status, "pending");

  const windDown = await request(api, {
    method: "POST",
    path: `/x402/gate/agents/${encodeURIComponent(payerAgentId)}/wind-down`,
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_agent_wind_down_unwind_1"
    },
    body: {
      reasonCode: "X402_AGENT_WIND_DOWN_MANUAL"
    }
  });
  assert.equal(windDown.statusCode, 200, windDown.body);
  assert.equal(windDown.json?.lifecycle?.status, "frozen");
  assert.equal(windDown.json?.unwind?.escalationsDenied, 1);
  assert.equal(windDown.json?.unwind?.quotesCanceled, 1);
  assert.ok(Number(windDown.json?.unwind?.reversalDispatchQueued ?? 0) >= 1);
  const queuedDispatch = api.store.outbox.find(
    (message) =>
      message &&
      typeof message === "object" &&
      String(message.type ?? "") === "X402_AGENT_WINDDOWN_REVERSAL_REQUESTED" &&
      String(message.gateId ?? "") === "x402_gate_unwind_1b"
  );
  assert.ok(queuedDispatch && typeof queuedDispatch === "object");
  assert.ok(typeof queuedDispatch.dispatchId === "string" && queuedDispatch.dispatchId.length === 64);

  const deniedEscalation = await request(api, {
    method: "GET",
    path: `/x402/gate/escalations/${encodeURIComponent(escalationId)}`
  });
  assert.equal(deniedEscalation.statusCode, 200, deniedEscalation.body);
  assert.equal(deniedEscalation.json?.escalation?.status, "denied");
  const deniedEvents = Array.isArray(deniedEscalation.json?.escalation?.events) ? deniedEscalation.json.escalation.events : [];
  const deniedEvent = deniedEvents.find((event) => event?.eventType === "denied");
  assert.equal(deniedEvent?.reasonCode, "AGENT_INSOLVENT_AUTO_DENY");

  const gateAfter = await api.store.getX402Gate({ tenantId: "tenant_default", gateId: "x402_gate_unwind_1a" });
  assert.ok(gateAfter && typeof gateAfter === "object");
  assert.equal(gateAfter.quoteCancelReasonCode, "X402_AGENT_FROZEN");
  assert.ok(typeof gateAfter.quoteCanceledAt === "string" && gateAfter.quoteCanceledAt.length > 0);
  assert.ok(typeof gateAfter.quote?.expiresAt === "string");
  assert.ok(Date.parse(String(gateAfter.quote.expiresAt)) <= Date.parse(String(windDown.json?.lifecycle?.updatedAt)));

  const reversalTick = await api.tickX402WinddownReversals({ maxMessages: 10 });
  assert.ok(Array.isArray(reversalTick?.processed));
  const voided = reversalTick.processed.filter((row) => row?.status === "voided");
  assert.ok(voided.length >= 1);

  const gateB = await api.store.getX402Gate({ tenantId: "tenant_default", gateId: "x402_gate_unwind_1b" });
  assert.ok(gateB && typeof gateB === "object");
  assert.equal(gateB.authorization?.status, "voided");
  assert.equal(gateB.reversal?.status, "voided");
  assert.equal(gateB.reversalDispatch?.status, "completed");
  assert.equal(String(gateB.reversalDispatch?.dispatchId ?? ""), String(queuedDispatch?.dispatchId ?? ""));
  const settlementB = await api.store.getAgentRunSettlement({ tenantId: "tenant_default", runId: gateB.runId });
  assert.ok(settlementB && typeof settlementB === "object");
  assert.equal(String(settlementB.status ?? "").toLowerCase(), "refunded");

  const reversalEventsBefore = await api.store.listX402ReversalEvents({
    tenantId: "tenant_default",
    gateId: "x402_gate_unwind_1b",
    limit: 1000,
    offset: 0
  });
  assert.ok(Array.isArray(reversalEventsBefore));

  api.store.outbox.push({
    ...queuedDispatch,
    at: new Date(Date.parse(String(queuedDispatch?.at ?? windDown.json?.lifecycle?.updatedAt ?? new Date().toISOString())) + 1).toISOString()
  });
  const replayTick = await api.tickX402WinddownReversals({ maxMessages: 10 });
  assert.ok(Array.isArray(replayTick?.processed));
  const replayRow = replayTick.processed.find((row) => row?.gateId === "x402_gate_unwind_1b");
  assert.equal(replayRow?.status, "skipped");
  assert.equal(replayRow?.reason, "dispatch_already_completed");

  const reversalEventsAfter = await api.store.listX402ReversalEvents({
    tenantId: "tenant_default",
    gateId: "x402_gate_unwind_1b",
    limit: 1000,
    offset: 0
  });
  assert.ok(Array.isArray(reversalEventsAfter));
  assert.equal(reversalEventsAfter.length, reversalEventsBefore.length);
});
