import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { buildToolManifestV1 } from "../src/core/tool-manifest.js";
import { buildAuthorityGrantV1 } from "../src/core/authority-grants.js";
import { buildToolCallAgreementV1, buildToolCallEvidenceV1 } from "../src/core/settlement-kernel.js";
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
    input: { text: "hello", to: "es" },
    output: { text: "hola", lang: "es" },
    startedAt: "2026-02-01T00:00:02.000Z",
    completedAt: "2026-02-01T00:00:03.000Z",
    signer: { keyId: providerKeyId, privateKeyPem: providerKeys.privateKeyPem }
  });

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
  assert.equal(receiptStatus.json?.artifactType, "SettlementReceipt.v1");
});

