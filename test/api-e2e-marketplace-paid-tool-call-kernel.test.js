import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { canonicalJsonStringify, normalizeForCanonicalJson } from "../src/core/canonical-json.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem, sha256Hex, signHashHexEd25519 } from "../src/core/crypto.js";
import { buildToolManifestV1 } from "../src/core/tool-manifest.js";
import { buildAuthorityGrantV1 } from "../src/core/authority-grants.js";
import { buildToolCallAgreementV1, buildToolCallDisputeOpenV1, buildToolCallEvidenceV1 } from "../src/core/settlement-kernel.js";
import { request } from "./api-test-harness.js";

async function createAuthHeaders(api, { scopes }) {
  const keyId = authKeyId();
  const secret = authKeySecret();
  const secretHash = hashAuthKeySecret(secret);
  const nowAt = typeof api?.store?.nowIso === "function" ? api.store.nowIso() : new Date().toISOString();
  await api.store.putAuthKey({
    tenantId: "tenant_default",
    authKey: {
      keyId,
      secretHash,
      scopes,
      status: "active",
      createdAt: nowAt
    }
  });
  return { authorization: `Bearer ${keyId}.${secret}` };
}

async function registerAgent(api, agentId, { publicKeyPem }) {
  const created = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `register_${agentId}` },
    body: {
      agentId,
      displayName: agentId,
      owner: { ownerType: "service", ownerId: "svc_paid_tools" },
      publicKeyPem,
      capabilities: ["mcp.tool.call"]
    }
  });
  assert.equal(created.statusCode, 201);
  return { keyId: created.json?.keyId ?? keyIdFromPublicKeyPem(publicKeyPem) };
}

async function creditWallet(api, { agentId, amountCents, idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/wallet/credit`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: { amountCents, currency: "USD" }
  });
  assert.equal(response.statusCode, 201);
  return response.json?.wallet;
}

test("API e2e: paid tool call kernel settles once (idempotent) and emits artifacts", async () => {
  const api = createApi();
  const tenantId = "tenant_default";

  const payerKeys = createEd25519Keypair();
  const providerKeys = createEd25519Keypair();
  const payerKeyId = keyIdFromPublicKeyPem(payerKeys.publicKeyPem);
  const providerKeyId = keyIdFromPublicKeyPem(providerKeys.publicKeyPem);

  await registerAgent(api, "agt_paid_payer", { publicKeyPem: payerKeys.publicKeyPem });
  await registerAgent(api, "agt_paid_provider", { publicKeyPem: providerKeys.publicKeyPem });

  await creditWallet(api, { agentId: "agt_paid_payer", amountCents: 10_000, idempotencyKey: "wallet_credit_paid_1" });

  const toolManifest = buildToolManifestV1({
    tenantId,
    toolId: "tool_paid_translate_v1",
    name: "Translate (Paid)",
    description: "Paid MCP tool for kernel e2e",
    tool: {
      name: "translate",
      description: "Translate input text to a target language.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text", "to"],
        properties: {
          text: { type: "string" },
          to: { type: "string" }
        }
      }
    },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    metadata: { payeeAgentId: "agt_paid_provider" },
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const authorityGrant = buildAuthorityGrantV1({
    tenantId,
    grantId: "auth_paid_0001",
    grantedBy: { actorType: "human", actorId: "user_paid_0001" },
    grantedTo: { actorType: "agent", actorId: "agt_paid_payer" },
    limits: {
      currency: "USD",
      maxPerTransactionCents: 5000,
      toolIds: [toolManifest.toolId],
      pinnedManifests: { [toolManifest.toolId]: toolManifest.manifestHash },
      expiresAt: "2026-03-01T00:00:00.000Z"
    },
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const toolCallAgreement = buildToolCallAgreementV1({
    tenantId,
    artifactId: "tca_paid_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    authorityGrantId: authorityGrant.grantId,
    authorityGrantHash: authorityGrant.grantHash,
    payerAgentId: "agt_paid_payer",
    payeeAgentId: "agt_paid_provider",
    amountCents: 2500,
    currency: "USD",
    callId: "call_paid_0001",
    input: { text: "hello", to: "es" },
    acceptanceCriteria: { maxLatencyMs: 5_000, requireOutput: true, maxOutputBytes: 10_000 },
    createdAt: "2026-02-01T00:00:01.000Z",
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem }
  });

  const toolCallEvidence = buildToolCallEvidenceV1({
    tenantId,
    artifactId: "tce_paid_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    agreementId: toolCallAgreement.artifactId,
    agreementHash: toolCallAgreement.agreementHash,
    callId: toolCallAgreement.callId,
    input: { text: "hello", to: "es" },
    inputHash: toolCallAgreement.inputHash,
    output: { text: "hola", lang: "es" },
    startedAt: "2026-02-01T00:00:02.000Z",
    completedAt: "2026-02-01T00:00:03.000Z",
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem }
  });

  const hold = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/hold`,
    headers: { "x-idempotency-key": "paid_tool_hold_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, expiresAt: "2026-03-01T00:00:00.000Z" }
  });
  assert.equal(hold.statusCode, 201);
  assert.equal(hold.json?.fundingHold?.artifactId, `hold_agmt_${toolCallAgreement.agreementHash}`);
  assert.equal(hold.json?.wallets?.payerWallet?.availableCents, 7500);
  assert.equal(hold.json?.wallets?.payerWallet?.escrowLockedCents, 2500);

  // Hold idempotency: even with a new idempotency key, the same agreement cannot be held twice.
  const holdAgain = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/hold`,
    headers: { "x-idempotency-key": "paid_tool_hold_2" },
    body: { toolManifest, authorityGrant, toolCallAgreement, expiresAt: "2026-03-01T00:00:00.000Z" }
  });
  assert.equal(holdAgain.statusCode, 200);
  assert.equal(holdAgain.json?.fundingHold?.artifactId, hold.json?.fundingHold?.artifactId);
  assert.equal(holdAgain.json?.wallets?.payerWallet?.availableCents, 7500);
  assert.equal(holdAgain.json?.wallets?.payerWallet?.escrowLockedCents, 2500);

  const settle = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/settle`,
    headers: { "x-idempotency-key": "paid_tool_settle_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, toolCallEvidence }
  });
  assert.equal(settle.statusCode, 201);
  assert.equal(settle.json?.toolId, toolManifest.toolId);
  assert.equal(settle.json?.receipt?.transfer?.amountCents, 2500);
  assert.equal(settle.json?.receipt?.transfer?.currency, "USD");
  assert.equal(settle.json?.wallets?.payerWallet?.availableCents, 7500);
  assert.equal(settle.json?.wallets?.payerWallet?.escrowLockedCents, 0);
  assert.equal(settle.json?.wallets?.payerWallet?.totalDebitedCents, 2500);
  assert.equal(settle.json?.wallets?.payeeWallet?.availableCents, 2500);

  const replay = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/settle`,
    headers: { "x-idempotency-key": "paid_tool_settle_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, toolCallEvidence }
  });
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.json, settle.json);

  const opsHeaders = await createAuthHeaders(api, { scopes: ["ops_read", "audit_read", "finance_read"] });
  const agreementStatus = await request(api, {
    method: "GET",
    path: `/artifacts/${encodeURIComponent(toolCallAgreement.artifactId)}/status`,
    headers: opsHeaders
  });
  assert.equal(agreementStatus.statusCode, 200);
  assert.equal(agreementStatus.json?.artifactId, toolCallAgreement.artifactId);

  const receiptStatus = await request(api, {
    method: "GET",
    path: `/artifacts/${encodeURIComponent(settle.json?.receipt?.artifactId)}/status`,
    headers: opsHeaders
  });
  assert.equal(receiptStatus.statusCode, 200);
  assert.equal(receiptStatus.json?.artifactType, "SettlementReceipt.v2");

  // Settlement uniqueness: even with a new idempotency key, the same agreement cannot settle twice.
  const settleAgain = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/settle`,
    headers: { "x-idempotency-key": "paid_tool_settle_2" },
    body: { toolManifest, authorityGrant, toolCallAgreement, toolCallEvidence }
  });
  assert.equal(settleAgain.statusCode, 200);
  assert.equal(settleAgain.json?.receipt?.artifactId, `rcp_agmt_${toolCallAgreement.agreementHash}`);
  assert.deepEqual(settleAgain.json?.receipt, settle.json?.receipt);
});

test("API e2e: holdback retention is released after challenge window via ops maintenance tick", async () => {
  let nowMs = Date.parse("2026-02-01T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });
  const tenantId = "tenant_default";

  const payerKeys = createEd25519Keypair();
  const providerKeys = createEd25519Keypair();
  const payerKeyId = keyIdFromPublicKeyPem(payerKeys.publicKeyPem);
  const providerKeyId = keyIdFromPublicKeyPem(providerKeys.publicKeyPem);

  await registerAgent(api, "agt_paid_payer_holdback", { publicKeyPem: payerKeys.publicKeyPem });
  await registerAgent(api, "agt_paid_provider_holdback", { publicKeyPem: providerKeys.publicKeyPem });
  await creditWallet(api, { agentId: "agt_paid_payer_holdback", amountCents: 10_000, idempotencyKey: "wallet_credit_paid_holdback_1" });

  const toolManifest = buildToolManifestV1({
    tenantId,
    toolId: "tool_paid_holdback_v1",
    name: "Holdback (Paid)",
    description: "Paid MCP tool for holdback retention e2e",
    tool: { name: "holdback", description: "Returns output", inputSchema: { type: "object" } },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    metadata: { payeeAgentId: "agt_paid_provider_holdback" },
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const authorityGrant = buildAuthorityGrantV1({
    tenantId,
    grantId: "auth_paid_holdback_0001",
    grantedBy: { actorType: "human", actorId: "user_paid_holdback_0001" },
    grantedTo: { actorType: "agent", actorId: "agt_paid_payer_holdback" },
    limits: {
      currency: "USD",
      maxPerTransactionCents: 5000,
      toolIds: [toolManifest.toolId],
      pinnedManifests: { [toolManifest.toolId]: toolManifest.manifestHash },
      expiresAt: "2026-03-01T00:00:00.000Z"
    },
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const amountCents = 2500;
  const holdbackBps = 1000; // 10%
  const challengeWindowMs = 60_000;
  const expectedHoldbackCents = Math.floor((amountCents * holdbackBps) / 10_000);
  const expectedPayoutCents = amountCents - expectedHoldbackCents;

  const toolCallAgreement = buildToolCallAgreementV1({
    tenantId,
    artifactId: "tca_paid_holdback_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    authorityGrantId: authorityGrant.grantId,
    authorityGrantHash: authorityGrant.grantHash,
    payerAgentId: "agt_paid_payer_holdback",
    payeeAgentId: "agt_paid_provider_holdback",
    amountCents,
    currency: "USD",
    callId: "call_paid_holdback_0001",
    input: { ok: true },
    acceptanceCriteria: { requireOutput: true },
    settlementTerms: { holdbackBps, challengeWindowMs },
    createdAt: "2026-02-01T00:00:01.000Z",
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem }
  });

  const toolCallEvidence = buildToolCallEvidenceV1({
    tenantId,
    artifactId: "tce_paid_holdback_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    agreementId: toolCallAgreement.artifactId,
    agreementHash: toolCallAgreement.agreementHash,
    callId: toolCallAgreement.callId,
    input: { ok: true },
    inputHash: toolCallAgreement.inputHash,
    output: { ok: true },
    startedAt: "2026-02-01T00:00:02.000Z",
    completedAt: "2026-02-01T00:00:03.000Z",
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem }
  });

  const hold = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/hold`,
    headers: { "x-idempotency-key": "paid_tool_holdback_hold_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, expiresAt: "2026-03-01T00:00:00.000Z" }
  });
  assert.equal(hold.statusCode, 201);
  assert.equal(hold.json?.wallets?.payerWallet?.availableCents, 7500);
  assert.equal(hold.json?.wallets?.payerWallet?.escrowLockedCents, 2500);

  const settle = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/settle`,
    headers: { "x-idempotency-key": "paid_tool_holdback_settle_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, toolCallEvidence }
  });
  assert.equal(settle.statusCode, 201);
  assert.equal(settle.json?.decision?.decision, "approved");
  assert.equal(settle.json?.receipt?.artifactType, "SettlementReceipt.v2");
  assert.equal(settle.json?.receipt?.outcome, "paid");
  assert.equal(settle.json?.receipt?.transfer?.amountCents, expectedPayoutCents);
  assert.equal(settle.json?.receipt?.agreementAmountCents, amountCents);
  assert.equal(settle.json?.receipt?.retention?.heldAmountCents, expectedHoldbackCents);
  assert.equal(settle.json?.wallets?.payerWallet?.escrowLockedCents, expectedHoldbackCents);
  assert.equal(settle.json?.wallets?.payeeWallet?.availableCents, expectedPayoutCents);

  // Move time forward past challenge window and run maintenance tick to release holdback.
  nowMs += challengeWindowMs + 1000;

  const opsHeaders = await createAuthHeaders(api, { scopes: ["ops_write", "audit_read", "finance_read", "finance_write"] });
  const run = await request(api, {
    method: "POST",
    path: "/ops/maintenance/marketplace/tool-holdbacks/run",
    headers: { ...opsHeaders, "x-idempotency-key": "ops_tool_holdbacks_run_1" },
    body: { batchSize: 200 }
  });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json?.ok, true);
  assert.equal(run.json?.releasedCount, 1);

  const payerAfter = await request(api, { method: "GET", path: "/agents/agt_paid_payer_holdback/wallet", headers: opsHeaders });
  assert.equal(payerAfter.statusCode, 200);
  assert.equal(payerAfter.json?.wallet?.escrowLockedCents, 0);
  assert.equal(payerAfter.json?.wallet?.availableCents, 7500);

  const payeeAfter = await request(api, { method: "GET", path: "/agents/agt_paid_provider_holdback/wallet", headers: opsHeaders });
  assert.equal(payeeAfter.statusCode, 200);
  assert.equal(payeeAfter.json?.wallet?.availableCents, amountCents);
});

test("API e2e: dispute opened within challenge window freezes auto-release; arbiter verdict applies holdback split", async () => {
  let nowMs = Date.parse("2026-02-01T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });
  const tenantId = "tenant_default";

  const payerKeys = createEd25519Keypair();
  const providerKeys = createEd25519Keypair();
  const arbiterKeys = createEd25519Keypair();
  const payerKeyId = keyIdFromPublicKeyPem(payerKeys.publicKeyPem);
  const providerKeyId = keyIdFromPublicKeyPem(providerKeys.publicKeyPem);
  const arbiterKeyId = keyIdFromPublicKeyPem(arbiterKeys.publicKeyPem);

  await registerAgent(api, "agt_paid_payer_dispute", { publicKeyPem: payerKeys.publicKeyPem });
  await registerAgent(api, "agt_paid_provider_dispute", { publicKeyPem: providerKeys.publicKeyPem });
  await registerAgent(api, "agt_paid_arbiter_dispute", { publicKeyPem: arbiterKeys.publicKeyPem });
  await creditWallet(api, { agentId: "agt_paid_payer_dispute", amountCents: 10_000, idempotencyKey: "wallet_credit_paid_dispute_1" });

  const toolManifest = buildToolManifestV1({
    tenantId,
    toolId: "tool_paid_dispute_v1",
    name: "Dispute (Paid)",
    description: "Paid tool for dispute+holdback e2e",
    tool: { name: "dispute", description: "Returns output", inputSchema: { type: "object" } },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    metadata: { payeeAgentId: "agt_paid_provider_dispute" },
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const authorityGrant = buildAuthorityGrantV1({
    tenantId,
    grantId: "auth_paid_dispute_0001",
    grantedBy: { actorType: "human", actorId: "user_paid_dispute_0001" },
    grantedTo: { actorType: "agent", actorId: "agt_paid_payer_dispute" },
    limits: {
      currency: "USD",
      maxPerTransactionCents: 5000,
      toolIds: [toolManifest.toolId],
      pinnedManifests: { [toolManifest.toolId]: toolManifest.manifestHash },
      expiresAt: "2026-03-01T00:00:00.000Z"
    },
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const amountCents = 2500;
  const holdbackBps = 1000; // 10%
  const challengeWindowMs = 60_000;
  const expectedHoldbackCents = Math.floor((amountCents * holdbackBps) / 10_000);
  const expectedPayoutCents = amountCents - expectedHoldbackCents;

  const toolCallAgreement = buildToolCallAgreementV1({
    tenantId,
    artifactId: "tca_paid_dispute_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    authorityGrantId: authorityGrant.grantId,
    authorityGrantHash: authorityGrant.grantHash,
    payerAgentId: "agt_paid_payer_dispute",
    payeeAgentId: "agt_paid_provider_dispute",
    amountCents,
    currency: "USD",
    callId: "call_paid_dispute_0001",
    input: { ok: true },
    acceptanceCriteria: { requireOutput: true },
    settlementTerms: { holdbackBps, challengeWindowMs },
    createdAt: "2026-02-01T00:00:01.000Z",
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem }
  });

  const toolCallEvidence = buildToolCallEvidenceV1({
    tenantId,
    artifactId: "tce_paid_dispute_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    agreementId: toolCallAgreement.artifactId,
    agreementHash: toolCallAgreement.agreementHash,
    callId: toolCallAgreement.callId,
    input: { ok: true },
    inputHash: toolCallAgreement.inputHash,
    output: { ok: true },
    startedAt: "2026-02-01T00:00:02.000Z",
    completedAt: "2026-02-01T00:00:03.000Z",
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem }
  });

  const hold = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/hold`,
    headers: { "x-idempotency-key": "paid_tool_dispute_hold_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, expiresAt: "2026-03-01T00:00:00.000Z" }
  });
  assert.equal(hold.statusCode, 201);

  const settle = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/settle`,
    headers: { "x-idempotency-key": "paid_tool_dispute_settle_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, toolCallEvidence }
  });
  assert.equal(settle.statusCode, 201);
  assert.equal(settle.json?.receipt?.outcome, "paid");
  assert.equal(settle.json?.receipt?.retention?.heldAmountCents, expectedHoldbackCents);
  const challengeUntil = String(settle.json?.receipt?.retention?.challengeUntil ?? "");
  assert.ok(challengeUntil);

  const disputeOpen = buildToolCallDisputeOpenV1({
    tenantId,
    artifactId: `tcd_agmt_${toolCallAgreement.agreementHash}`,
    toolId: toolManifest.toolId,
    agreementId: toolCallAgreement.artifactId,
    agreementHash: toolCallAgreement.agreementHash,
    receiptId: `rcp_agmt_${toolCallAgreement.agreementHash}`,
    receiptHash: String(settle.json?.receipt?.receiptHash ?? ""),
    openedByAgentId: "agt_paid_payer_dispute",
    reasonCode: "quality",
    reason: "disputing tool output",
    evidenceRefs: [`artifact:${toolCallEvidence.artifactId}`],
    openedAt: new Date(nowMs + 10_000).toISOString(),
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem }
  });

  const opened = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/disputes/open`,
    headers: { "x-idempotency-key": "paid_tool_dispute_open_1" },
    body: { toolCallAgreement, disputeOpen }
  });
  assert.equal(opened.statusCode, 201);
  assert.equal(opened.json?.arbitrationCase?.metadata?.caseType, "tool_call");

  // Move time forward past challenge window; maintenance must NOT auto-release due to open dispute.
  nowMs = Date.parse(challengeUntil) + 1000;
  const opsHeaders = await createAuthHeaders(api, { scopes: ["ops_write", "audit_read", "finance_read", "finance_write"] });

  const tick1 = await request(api, {
    method: "POST",
    path: "/ops/maintenance/marketplace/tool-holdbacks/run",
    headers: { ...opsHeaders, "x-idempotency-key": "ops_tool_holdbacks_run_dispute_1" },
    body: { batchSize: 200 }
  });
  assert.equal(tick1.statusCode, 200);
  assert.equal(tick1.json?.releasedCount, 0);

  const payerBeforeVerdict = await request(api, { method: "GET", path: "/agents/agt_paid_payer_dispute/wallet", headers: opsHeaders });
  assert.equal(payerBeforeVerdict.statusCode, 200);
  assert.equal(payerBeforeVerdict.json?.wallet?.escrowLockedCents, expectedHoldbackCents);
  const payeeBeforeVerdict = await request(api, { method: "GET", path: "/agents/agt_paid_provider_dispute/wallet", headers: opsHeaders });
  assert.equal(payeeBeforeVerdict.statusCode, 200);
  assert.equal(payeeBeforeVerdict.json?.wallet?.availableCents, expectedPayoutCents);

  // Ops assigns arbiter (arbiter signs the verdict).
  const assign = await request(api, {
    method: "POST",
    path: `/ops/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/disputes/${toolCallAgreement.agreementHash}/assign`,
    headers: opsHeaders,
    body: { arbiterAgentId: "agt_paid_arbiter_dispute" }
  });
  assert.equal(assign.statusCode, 200);

  // Arbiter issues a partial verdict: split held amount 50/50 between payee and payer.
  const disputeId = `dsp_agmt_${toolCallAgreement.agreementHash}`;
  const caseId = `arb_case_${disputeId}`;
  const runId = `run_tool_${toolCallAgreement.agreementHash}`;
  const settlementId = `rcp_agmt_${toolCallAgreement.agreementHash}`;
  const issuedAt = new Date(nowMs + 2000).toISOString();
  const evidenceRefs = [`artifact:${toolCallEvidence.artifactId}`];

  const verdictCore = normalizeForCanonicalJson(
    {
      schemaVersion: "ArbitrationVerdict.v1",
      verdictId: "avd_paid_dispute_0001",
      caseId,
      tenantId,
      runId,
      settlementId,
      disputeId,
      arbiterAgentId: "agt_paid_arbiter_dispute",
      outcome: "partial",
      releaseRatePct: 50,
      rationale: "partial release",
      evidenceRefs,
      issuedAt,
      appealRef: null
    },
    { path: "$" }
  );
  const verdictHash = sha256Hex(canonicalJsonStringify(verdictCore));
  const signature = signHashHexEd25519(verdictHash, arbiterKeys.privateKeyPem);
  const arbitrationVerdict = {
    ...verdictCore,
    signerKeyId: arbiterKeyId,
    signature,
    verdictHash
  };

  const verdictRes = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/disputes/${toolCallAgreement.agreementHash}/verdict`,
    headers: { "x-idempotency-key": "paid_tool_dispute_verdict_1" },
    body: { arbitrationVerdict }
  });
  assert.equal(verdictRes.statusCode, 200);
  assert.equal(verdictRes.json?.adjustment?.artifactType, "SettlementAdjustment.v1");
  assert.equal(verdictRes.json?.adjustment?.kind, "holdback_split");
  assert.equal(verdictRes.json?.wallets?.payerWallet?.escrowLockedCents, 0);
  assert.equal(verdictRes.json?.wallets?.payeeWallet?.availableCents, expectedPayoutCents + Math.floor(expectedHoldbackCents / 2));

  // Subsequent maintenance ticks must not move money again.
  const tick2 = await request(api, {
    method: "POST",
    path: "/ops/maintenance/marketplace/tool-holdbacks/run",
    headers: { ...opsHeaders, "x-idempotency-key": "ops_tool_holdbacks_run_dispute_2" },
    body: { batchSize: 200 }
  });
  assert.equal(tick2.statusCode, 200);
  assert.equal(tick2.json?.releasedCount, 0);
});

test("API e2e: acceptance criteria rejects on latency and does not transfer", async () => {
  const api = createApi();
  const tenantId = "tenant_default";

  const payerKeys = createEd25519Keypair();
  const providerKeys = createEd25519Keypair();
  const payerKeyId = keyIdFromPublicKeyPem(payerKeys.publicKeyPem);
  const providerKeyId = keyIdFromPublicKeyPem(providerKeys.publicKeyPem);

  await registerAgent(api, "agt_paid_payer2", { publicKeyPem: payerKeys.publicKeyPem });
  await registerAgent(api, "agt_paid_provider2", { publicKeyPem: providerKeys.publicKeyPem });
  await creditWallet(api, { agentId: "agt_paid_payer2", amountCents: 10_000, idempotencyKey: "wallet_credit_paid_2" });

  const toolManifest = buildToolManifestV1({
    tenantId,
    toolId: "tool_paid_latency_v1",
    name: "Latency (Paid)",
    description: "Paid MCP tool for latency rejection",
    tool: { name: "latency", description: "Returns output", inputSchema: { type: "object" } },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    metadata: { payeeAgentId: "agt_paid_provider2" },
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const authorityGrant = buildAuthorityGrantV1({
    tenantId,
    grantId: "auth_paid_latency_0001",
    grantedBy: { actorType: "human", actorId: "user_paid_0002" },
    grantedTo: { actorType: "agent", actorId: "agt_paid_payer2" },
    limits: {
      currency: "USD",
      maxPerTransactionCents: 5000,
      toolIds: [toolManifest.toolId],
      pinnedManifests: { [toolManifest.toolId]: toolManifest.manifestHash },
      expiresAt: "2026-03-01T00:00:00.000Z"
    },
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const toolCallAgreement = buildToolCallAgreementV1({
    tenantId,
    artifactId: "tca_paid_lat_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    authorityGrantId: authorityGrant.grantId,
    authorityGrantHash: authorityGrant.grantHash,
    payerAgentId: "agt_paid_payer2",
    payeeAgentId: "agt_paid_provider2",
    amountCents: 2500,
    currency: "USD",
    callId: "call_paid_lat_0001",
    input: { text: "hello" },
    acceptanceCriteria: { maxLatencyMs: 1, requireOutput: true },
    createdAt: "2026-02-01T00:00:01.000Z",
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem }
  });

  const toolCallEvidence = buildToolCallEvidenceV1({
    tenantId,
    artifactId: "tce_paid_lat_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    agreementId: toolCallAgreement.artifactId,
    agreementHash: toolCallAgreement.agreementHash,
    callId: toolCallAgreement.callId,
    input: { text: "hello" },
    inputHash: toolCallAgreement.inputHash,
    output: { ok: true },
    startedAt: "2026-02-01T00:00:02.000Z",
    completedAt: "2026-02-01T00:00:10.000Z",
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem }
  });

  const hold = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/hold`,
    headers: { "x-idempotency-key": "paid_tool_hold_lat_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, expiresAt: "2026-03-01T00:00:00.000Z" }
  });
  assert.equal(hold.statusCode, 201);
  assert.equal(hold.json?.wallets?.payerWallet?.availableCents, 7500);
  assert.equal(hold.json?.wallets?.payerWallet?.escrowLockedCents, 2500);

  const settle = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/settle`,
    headers: { "x-idempotency-key": "paid_tool_settle_lat_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, toolCallEvidence }
  });
  assert.equal(settle.statusCode, 201);
  assert.equal(settle.json?.decision?.decision, "rejected");
  assert.equal(settle.json?.receipt?.transfer?.amountCents, 0);
  assert.equal(settle.json?.wallets?.payerWallet?.availableCents, 10_000);
  assert.equal(settle.json?.wallets?.payeeWallet?.availableCents ?? 0, 0);
});

test("API e2e: settle requires a funding hold (preauth) for paid tool calls", async () => {
  const api = createApi();
  const tenantId = "tenant_default";

  const payerKeys = createEd25519Keypair();
  const providerKeys = createEd25519Keypair();
  const payerKeyId = keyIdFromPublicKeyPem(payerKeys.publicKeyPem);
  const providerKeyId = keyIdFromPublicKeyPem(providerKeys.publicKeyPem);

  await registerAgent(api, "agt_paid_payer3", { publicKeyPem: payerKeys.publicKeyPem });
  await registerAgent(api, "agt_paid_provider3", { publicKeyPem: providerKeys.publicKeyPem });
  await creditWallet(api, { agentId: "agt_paid_payer3", amountCents: 10_000, idempotencyKey: "wallet_credit_paid_3" });

  const toolManifest = buildToolManifestV1({
    tenantId,
    toolId: "tool_paid_requires_hold_v1",
    name: "Requires Hold",
    description: "Paid MCP tool for hold requirement",
    tool: { name: "requires_hold", description: "Returns output", inputSchema: { type: "object" } },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    metadata: { payeeAgentId: "agt_paid_provider3" },
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const authorityGrant = buildAuthorityGrantV1({
    tenantId,
    grantId: "auth_paid_requires_hold_0001",
    grantedBy: { actorType: "human", actorId: "user_paid_0003" },
    grantedTo: { actorType: "agent", actorId: "agt_paid_payer3" },
    limits: {
      currency: "USD",
      maxPerTransactionCents: 5000,
      toolIds: [toolManifest.toolId],
      pinnedManifests: { [toolManifest.toolId]: toolManifest.manifestHash },
      expiresAt: "2026-03-01T00:00:00.000Z"
    },
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const toolCallAgreement = buildToolCallAgreementV1({
    tenantId,
    artifactId: "tca_paid_hold_required_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    authorityGrantId: authorityGrant.grantId,
    authorityGrantHash: authorityGrant.grantHash,
    payerAgentId: "agt_paid_payer3",
    payeeAgentId: "agt_paid_provider3",
    amountCents: 2500,
    currency: "USD",
    callId: "call_paid_hold_required_0001",
    input: { ok: true },
    acceptanceCriteria: { requireOutput: true },
    createdAt: "2026-02-01T00:00:01.000Z",
    signer: { keyId: payerKeyId, privateKeyPem: payerKeys.privateKeyPem }
  });

  const toolCallEvidence = buildToolCallEvidenceV1({
    tenantId,
    artifactId: "tce_paid_hold_required_0001",
    toolId: toolManifest.toolId,
    toolManifestHash: toolManifest.manifestHash,
    agreementId: toolCallAgreement.artifactId,
    agreementHash: toolCallAgreement.agreementHash,
    callId: toolCallAgreement.callId,
    input: { ok: true },
    inputHash: toolCallAgreement.inputHash,
    output: { ok: true },
    startedAt: "2026-02-01T00:00:02.000Z",
    completedAt: "2026-02-01T00:00:03.000Z",
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem }
  });

  const settle = await request(api, {
    method: "POST",
    path: `/marketplace/tools/${encodeURIComponent(toolManifest.toolId)}/settle`,
    headers: { "x-idempotency-key": "paid_tool_settle_requires_hold_1" },
    body: { toolManifest, authorityGrant, toolCallAgreement, toolCallEvidence }
  });
  assert.equal(settle.statusCode, 409);
});
