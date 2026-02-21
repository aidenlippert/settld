import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { canonicalJsonStringify } from "../src/core/canonical-json.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";
import { createCircleReserveAdapter } from "../src/core/circle-reserve-adapter.js";
import { hmacSignArtifact } from "../src/core/artifacts.js";
import { computeSettldPayTokenSha256, parseSettldPayTokenV1, verifySettldPayTokenV1 } from "../src/core/settld-pay-token.js";
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
  const response = await request(api, {
    method: "POST",
    path: "/ops/x402/wallet-policies",
    headers: {
      "x-idempotency-key": idempotencyKey,
      "x-settld-protocol": "1.0"
    },
    body: { policy }
  });
  return response;
}

async function putX402ZkVerificationKey(api, { verificationKey, idempotencyKey }) {
  return await request(api, {
    method: "POST",
    path: "/x402/zk/verification-keys",
    headers: {
      "x-idempotency-key": idempotencyKey,
      "x-settld-protocol": "1.0"
    },
    body: { verificationKey }
  });
}

async function issueWalletAuthorizationDecision(
  api,
  { sponsorWalletRef, gateId, quoteId = null, requestBindingMode = null, requestBindingSha256 = null, idempotencyKey }
) {
  const response = await request(api, {
    method: "POST",
    path: `/x402/wallets/${encodeURIComponent(sponsorWalletRef)}/authorize`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: {
      gateId,
      ...(quoteId ? { quoteId } : {}),
      ...(requestBindingMode ? { requestBindingMode } : {}),
      ...(requestBindingSha256 ? { requestBindingSha256 } : {})
    }
  });
  return response;
}

async function resolveX402Escalation(api, { escalationId, action, reason = null, idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: `/x402/gate/escalations/${encodeURIComponent(escalationId)}/resolve`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: {
      action,
      ...(reason ? { reason } : {})
    }
  });
  return response;
}

async function windDownX402Agent(api, { agentId, reasonCode = "X402_AGENT_WIND_DOWN_MANUAL", idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: `/x402/gate/agents/${encodeURIComponent(agentId)}/wind-down`,
    headers: {
      "x-idempotency-key": idempotencyKey,
      "x-settld-protocol": "1.0"
    },
    body: { reasonCode }
  });
  return response;
}

function parseWebhookSignatures(headerValue) {
  const raw = typeof headerValue === "string" ? headerValue.trim() : "";
  if (!raw) return [];
  if (!raw.includes("=")) return [raw];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf("=");
      if (idx <= 0) return null;
      const key = part.slice(0, idx).trim().toLowerCase();
      const value = part.slice(idx + 1).trim();
      if (key !== "v1" || !value) return null;
      return value;
    })
    .filter(Boolean);
}

async function createAgreementDelegation(
  api,
  {
    parentAgreementHash,
    delegationId,
    childAgreementHash,
    delegatorAgentId,
    delegateeAgentId,
    budgetCapCents,
    delegationDepth,
    maxDelegationDepth,
    idempotencyKey
  }
) {
  const response = await request(api, {
    method: "POST",
    path: `/agreements/${encodeURIComponent(parentAgreementHash)}/delegations`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: {
      delegationId,
      childAgreementHash,
      delegatorAgentId,
      delegateeAgentId,
      budgetCapCents,
      currency: "USD",
      delegationDepth,
      maxDelegationDepth
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json?.delegation ?? null;
}

function buildProtocolAgentPassport({ passportId, agentId, sponsorRef, nowAt, rootGrantHash = null }) {
  const resolvedRootGrantHash = typeof rootGrantHash === "string" && rootGrantHash.trim() !== ""
    ? rootGrantHash.trim().toLowerCase()
    : sha256Hex(`dlg_root_hash_${passportId}`);
  return {
    schemaVersion: "AgentPassport.v1",
    passportId,
    agentId,
    tenantId: "tenant_default",
    principalRef: {
      principalType: "service",
      principalId: sponsorRef
    },
    identityAnchors: {
      jwksUri: "https://example.com/.well-known/jwks.json",
      activeKeyId: `agent_key_${passportId}`,
      keysetHash: sha256Hex(`keyset_${passportId}`)
    },
    delegationRoot: {
      rootGrantId: `dlg_root_${passportId}`,
      rootGrantHash: resolvedRootGrantHash,
      issuedAt: nowAt,
      expiresAt: null,
      revokedAt: null
    },
    policyEnvelope: {
      maxPerCallCents: 2000,
      maxDailyCents: 20000,
      allowedRiskClasses: ["read", "compute", "action", "financial"],
      requireApprovalAboveCents: null
    },
    status: "active",
    createdAt: nowAt,
    updatedAt: nowAt
  };
}

function buildExecutionIntent({
  intentId,
  agentId,
  requestSha256,
  maxAmountCents,
  currency = "USD",
  idempotencyKey
}) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const executionIntentSeed = {
    schemaVersion: "ExecutionIntent.v1",
    intentId,
    tenantId: "tenant_default",
    agentId,
    requestFingerprint: {
      canonicalization: "rfc8785-jcs",
      method: "POST",
      path: "/x402/gate/authorize-payment",
      querySha256: sha256Hex(`query_${intentId}`),
      bodySha256: sha256Hex(`body_${intentId}`),
      requestSha256
    },
    riskProfile: {
      riskClass: "financial",
      sideEffecting: true,
      expectedDeterminism: "bounded_nondeterministic",
      maxLossCents: maxAmountCents,
      requiresHumanApproval: false
    },
    spendBounds: {
      currency,
      maxAmountCents
    },
    policyBinding: {
      policyId: `policy_${intentId}`,
      policyVersion: 1,
      policyHash: sha256Hex(`policy_${intentId}`),
      verificationMethodHash: sha256Hex(`verification_method_${intentId}`)
    },
    idempotencyKey,
    nonce: `nonce_${intentId}_0001`,
    expiresAt,
    createdAt
  };
  const intentHash = sha256Hex(canonicalJsonStringify(executionIntentSeed));
  return { ...executionIntentSeed, intentHash };
}

test("API e2e: x402 gate create fails closed when agent passport is required and missing", async () => {
  const api = createApi({ opsToken: "tok_ops", x402RequireAgentPassport: true });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_passport_required_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_passport_required_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_passport_required_1" });

  const createRes = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_passport_required_1" },
    body: {
      gateId: "gate_passport_required_1",
      payerAgentId,
      payeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(createRes.statusCode, 400, createRes.body);
  assert.equal(createRes.json?.code, "X402_AGENT_PASSPORT_REQUIRED");
});

test("API e2e: x402 authorize-payment and verify fail closed on missing or revoked passport when required", async () => {
  const store = createStore();
  const bootstrapApi = createApi({ store, opsToken: "tok_ops", x402RequireAgentPassport: false });

  const payerAgentId = await registerAgent(bootstrapApi, { agentId: "agt_x402_passport_enforce_payer_1" });
  const payeeAgentId = await registerAgent(bootstrapApi, { agentId: "agt_x402_passport_enforce_payee_1" });
  await creditWallet(bootstrapApi, {
    agentId: payerAgentId,
    amountCents: 9000,
    idempotencyKey: "wallet_credit_x402_passport_enforce_1"
  });

  const missingGateId = "gate_passport_missing_on_auth_1";
  const missingCreate = await request(bootstrapApi, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_passport_missing_auth_1" },
    body: {
      gateId: missingGateId,
      payerAgentId,
      payeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(missingCreate.statusCode, 201, missingCreate.body);

  const api = createApi({ store, opsToken: "tok_ops", x402RequireAgentPassport: true });
  const missingAuthorize = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_passport_missing_1" },
    body: { gateId: missingGateId }
  });
  assert.equal(missingAuthorize.statusCode, 409, missingAuthorize.body);
  assert.equal(missingAuthorize.json?.code, "X402_AGENT_PASSPORT_REQUIRED");

  const nowAt = new Date().toISOString();
  const rootGrantId = "dlg_root_passport_passport_verify_1";
  const rootAgreementHash = sha256Hex("agreement_passport_verify_root_1");
  const childAgreementHash = sha256Hex("agreement_passport_verify_child_1");
  const rootDelegation = await createAgreementDelegation(api, {
    parentAgreementHash: rootAgreementHash,
    delegationId: rootGrantId,
    childAgreementHash,
    delegatorAgentId: payeeAgentId,
    delegateeAgentId: payerAgentId,
    budgetCapCents: 5000,
    delegationDepth: 0,
    maxDelegationDepth: 1,
    idempotencyKey: "agreement_delegation_passport_verify_root_1"
  });
  assert.ok(rootDelegation?.delegationHash);
  const revokedGateId = "gate_passport_revoked_on_verify_1";
  const revokedCreate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_passport_revoked_verify_1" },
    body: {
      gateId: revokedGateId,
      payerAgentId,
      payeeAgentId,
      toolId: "tool_passport_verify_1",
      amountCents: 400,
      currency: "USD",
      agentPassport: buildProtocolAgentPassport({
        passportId: "passport_passport_verify_1",
        agentId: payerAgentId,
        sponsorRef: "sponsor_passport_verify_1",
        nowAt,
        rootGrantHash: rootDelegation.delegationHash
      })
    }
  });
  assert.equal(revokedCreate.statusCode, 201, revokedCreate.body);

  const revokedAuthorize = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_passport_revoked_verify_1" },
    body: { gateId: revokedGateId }
  });
  assert.equal(revokedAuthorize.statusCode, 200, revokedAuthorize.body);

  const storedGate = await store.getX402Gate({ tenantId: "tenant_default", gateId: revokedGateId });
  assert.ok(storedGate);
  const revokedAt = new Date().toISOString();
  const revokedGate = {
    ...storedGate,
    agentPassport: {
      ...(storedGate.agentPassport ?? {}),
      status: "revoked",
      updatedAt: revokedAt
    },
    updatedAt: revokedAt
  };
  await store.commitTx({
    at: revokedAt,
    ops: [{ kind: "X402_GATE_UPSERT", tenantId: "tenant_default", gateId: revokedGateId, gate: revokedGate }]
  });

  const revokedVerify = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_passport_revoked_1" },
    body: { gateId: revokedGateId }
  });
  assert.equal(revokedVerify.statusCode, 409, revokedVerify.body);
  assert.equal(revokedVerify.json?.code, "X402_AGENT_PASSPORT_STATUS_INVALID");
});

test("API e2e: x402 authorize-payment requires valid execution intent when enabled", async () => {
  const api = createApi({ opsToken: "tok_ops", x402RequireExecutionIntent: true });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_exec_intent_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_exec_intent_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 6000, idempotencyKey: "wallet_credit_x402_exec_intent_1" });

  const gateId = "gate_exec_intent_required_1";
  const amountCents = 700;
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_exec_intent_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const missingIntent = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_exec_intent_missing_1" },
    body: { gateId }
  });
  assert.equal(missingIntent.statusCode, 409, missingIntent.body);
  assert.equal(missingIntent.json?.code, "X402_EXECUTION_INTENT_REQUIRED");

  const requestBindingSha256 = sha256Hex("x402_execution_intent_request_binding_1");
  const mismatchIntent = buildExecutionIntent({
    intentId: "intent_exec_mismatch_1",
    agentId: payerAgentId,
    requestSha256: requestBindingSha256,
    maxAmountCents: amountCents + 100,
    idempotencyKey: "x402_exec_intent_wrong_idempotency_key_1"
  });
  const mismatchResponse = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_exec_intent_mismatch_1" },
    body: {
      gateId,
      requestBindingMode: "strict",
      requestBindingSha256,
      executionIntent: mismatchIntent
    }
  });
  assert.equal(mismatchResponse.statusCode, 409, mismatchResponse.body);
  assert.equal(mismatchResponse.json?.code, "X402_EXECUTION_INTENT_IDEMPOTENCY_MISMATCH");

  const authorizeIdempotencyKey = "x402_gate_authz_exec_intent_valid_1";
  const validIntent = buildExecutionIntent({
    intentId: "intent_exec_valid_1",
    agentId: payerAgentId,
    requestSha256: requestBindingSha256,
    maxAmountCents: amountCents + 100,
    idempotencyKey: authorizeIdempotencyKey
  });
  const auth = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": authorizeIdempotencyKey },
    body: {
      gateId,
      requestBindingMode: "strict",
      requestBindingSha256,
      executionIntent: validIntent
    }
  });
  assert.equal(auth.statusCode, 200, auth.body);

  const responseSha256 = sha256Hex("{\"ok\":true,\"scenario\":\"execution_intent\"}");
  const verifyRes = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_exec_intent_1" },
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
      verificationMethod: { mode: "deterministic", source: "http_status_v1" },
      evidenceRefs: [`http:request_sha256:${requestBindingSha256}`, `http:response_sha256:${responseSha256}`]
    }
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.executionIntent?.intentHash, validIntent.intentHash);
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.executionIntent?.requestSha256, requestBindingSha256);

  const storedGate = await api.store.getX402Gate({ tenantId: "tenant_default", gateId });
  assert.equal(storedGate?.authorization?.executionIntent?.intentHash, validIntent.intentHash);
});

test("API e2e: x402 authorize-payment is idempotent and token verifies via keyset", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_1" });

  const gateId = "gate_auth_1";
  const amountCents = 500;

  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const auth1 = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_1" },
    body: { gateId }
  });
  assert.equal(auth1.statusCode, 200, auth1.body);
  assert.equal(auth1.json?.gateId, gateId);
  assert.equal(auth1.json?.reserve?.status, "reserved");
  assert.ok(typeof auth1.json?.token === "string" && auth1.json.token.length > 0);

  const auth2 = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_2" },
    body: { gateId }
  });
  assert.equal(auth2.statusCode, 200, auth2.body);
  assert.equal(auth2.json?.token, auth1.json?.token);
  assert.equal(auth2.json?.reserve?.reserveId, auth1.json?.reserve?.reserveId);

  const keysetRes = await request(api, {
    method: "GET",
    path: "/.well-known/settld-keys.json",
    auth: "none"
  });
  assert.equal(keysetRes.statusCode, 200, keysetRes.body);
  const verified = verifySettldPayTokenV1({
    token: auth1.json?.token,
    keyset: keysetRes.json,
    expectedAudience: payeeAgentId,
    expectedPayeeProviderId: payeeAgentId
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.gateId, gateId);

  const requestSha256 = sha256Hex("GET\nexample.com\n/tools/search?q=dentist\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const responseSha256 = sha256Hex("{\"ok\":true}");
  const verifyRes = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_auth_1" },
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
      verificationMethod: { mode: "deterministic", source: "http_status_v1" },
      evidenceRefs: [`http:request_sha256:${requestSha256}`, `http:response_sha256:${responseSha256}`],
      proof: {
        protocol: "groth16",
        publicSignals: ["signal:demo"],
        proofData: { a: "0x01", b: "0x02" },
        verificationKeyRef: "vk_demo_auth_1",
        statementHashSha256: sha256Hex("demo_statement_v1"),
        inputDigestSha256: sha256Hex("demo_input_v1"),
        outputDigestSha256: sha256Hex("demo_output_v1")
      }
    }
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  assert.equal(verifyRes.json?.settlement?.status, "released");
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.authorizationRef, auth1.json?.authorizationRef);
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.request?.sha256, requestSha256);
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.response?.sha256, responseSha256);
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.reserve?.status, "reserved");
  assert.equal(verifyRes.json?.decisionRecord?.bindings?.policyDecisionFingerprint?.fingerprintVersion, "PolicyDecisionFingerprint.v1");
  assert.match(String(verifyRes.json?.decisionRecord?.bindings?.policyDecisionFingerprint?.policyHash ?? ""), /^[0-9a-f]{64}$/);
  assert.match(String(verifyRes.json?.decisionRecord?.bindings?.policyDecisionFingerprint?.evaluationHash ?? ""), /^[0-9a-f]{64}$/);
  assert.equal(
    verifyRes.json?.decisionRecord?.bindings?.policyDecisionFingerprint?.evaluationHash,
    verifyRes.json?.settlementReceipt?.bindings?.policyDecisionFingerprint?.evaluationHash
  );
  assert.ok(
    typeof verifyRes.json?.decisionRecord?.bindings?.spendAuthorization?.delegationRef === "string" &&
      verifyRes.json.decisionRecord.bindings.spendAuthorization.delegationRef.length > 0
  );
  assert.equal(verifyRes.json?.zkProofVerification?.present, true);
  assert.equal(verifyRes.json?.zkProofVerification?.protocol, "groth16");
  assert.equal(verifyRes.json?.zkProofVerification?.status, "verification_key_missing");
  assert.equal(verifyRes.json?.zkProofVerification?.verified, false);
});

test("API e2e: x402 gate verify rejects invalid zk proof protocol", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_proof_bad_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_proof_bad_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_proof_bad_1" });

  const gateId = "gate_auth_proof_bad_1";
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_proof_bad_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const auth = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_proof_bad_1" },
    body: { gateId }
  });
  assert.equal(auth.statusCode, 200, auth.body);

  const verifyRes = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_proof_bad_1" },
    body: {
      gateId,
      proof: {
        protocol: "invalid",
        publicSignals: [],
        proofData: { a: "0x01" },
        verificationKeyRef: "vk_bad_1"
      }
    }
  });
  assert.equal(verifyRes.statusCode, 400, verifyRes.body);
  assert.equal(verifyRes.json?.code, "SCHEMA_INVALID");
});

test("API e2e: x402 zk verification key registry create/get/list and immutability", async () => {
  const api = createApi({ opsToken: "tok_ops" });
  const verificationKeyId = "vkey_registry_1";
  const verificationKey = {
    schemaVersion: "X402ZkVerificationKey.v1",
    verificationKeyId,
    protocol: "groth16",
    verificationKey: {
      curve: "bn128",
      vk_alpha_1: ["1", "2"],
      vk_beta_2: [["3", "4"], ["5", "6"]]
    },
    providerRef: "provider_registry_1",
    metadata: { name: "Demo Groth16 Key" }
  };

  const created = await putX402ZkVerificationKey(api, {
    verificationKey,
    idempotencyKey: "x402_zk_verification_key_put_1"
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json?.verificationKey?.verificationKeyId, verificationKeyId);

  const fetched = await request(api, {
    method: "GET",
    path: `/x402/zk/verification-keys/${encodeURIComponent(verificationKeyId)}`
  });
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(fetched.json?.verificationKey?.protocol, "groth16");

  const listed = await request(api, {
    method: "GET",
    path: "/x402/zk/verification-keys?protocol=groth16"
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(Array.isArray(listed.json?.verificationKeys), true);
  assert.equal(
    listed.json?.verificationKeys?.some((row) => String(row?.verificationKeyId ?? "") === verificationKeyId),
    true
  );

  const same = await putX402ZkVerificationKey(api, {
    verificationKey,
    idempotencyKey: "x402_zk_verification_key_put_2"
  });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json?.created, false);

  const mutated = await putX402ZkVerificationKey(api, {
    verificationKey: {
      ...verificationKey,
      verificationKey: {
        ...verificationKey.verificationKey,
        vk_alpha_1: ["7", "8"]
      }
    },
    idempotencyKey: "x402_zk_verification_key_put_3"
  });
  assert.equal(mutated.statusCode, 409, mutated.body);
  assert.equal(mutated.json?.code, "X402_ZK_VERIFICATION_KEY_IMMUTABLE");
});

test("API e2e: wallet policy upsert rejects unknown zk verification key ref", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const response = await upsertX402WalletPolicy(api, {
    policy: {
      schemaVersion: "X402WalletPolicy.v1",
      sponsorRef: "sponsor_zk_ref_missing_1",
      sponsorWalletRef: "wallet_zk_ref_missing_1",
      policyRef: "policy_zk_ref_missing_1",
      policyVersion: 1,
      status: "active",
      maxAmountCents: 1000,
      maxDailyAuthorizationCents: 5000,
      allowedProviderIds: [],
      allowedToolIds: [],
      allowedAgentKeyIds: [],
      allowedCurrencies: ["USD"],
      allowedReversalActions: ["void_authorization", "request_refund", "resolve_refund"],
      requiresZkProof: true,
      zkProofProtocol: "groth16",
      zkVerificationKeyRef: "vkey_does_not_exist_1",
      requireQuote: false,
      requireStrictRequestBinding: false,
      requireAgentKeyMatch: false
    },
    idempotencyKey: "x402_wallet_policy_ref_missing_1"
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json?.code, "X402_INVALID_VERIFICATION_KEY_REF");
});

test("API e2e: x402 gate verify fails closed when wallet policy requires zk proof", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_zk_required_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_zk_required_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_zk_required_1" });
  const verificationKeyId = "vk_required_1";
  const keyCreate = await putX402ZkVerificationKey(api, {
    verificationKey: {
      schemaVersion: "X402ZkVerificationKey.v1",
      verificationKeyId,
      protocol: "groth16",
      verificationKey: { curve: "bn128", vk_alpha_1: ["1", "2"] },
      providerRef: payeeAgentId
    },
    idempotencyKey: "x402_zk_verification_key_required_1"
  });
  assert.equal(keyCreate.statusCode, 201, keyCreate.body);

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_zk_required_1",
    sponsorWalletRef: "wallet_zk_required_1",
    policyRef: "policy_zk_required_1",
    policyVersion: 1,
    status: "active",
    maxAmountCents: 1000,
    maxDailyAuthorizationCents: 5000,
    allowedProviderIds: [payeeAgentId],
    allowedToolIds: ["tool_zk_required"],
    allowedAgentKeyIds: [],
    allowedCurrencies: ["USD"],
    allowedReversalActions: ["void_authorization", "request_refund", "resolve_refund"],
    requiresZkProof: true,
    zkProofProtocol: "groth16",
    zkVerificationKeyRef: verificationKeyId,
    requireQuote: false,
    requireStrictRequestBinding: false,
    requireAgentKeyMatch: false
  };
  const policyUpsert = await upsertX402WalletPolicy(api, {
    policy: walletPolicy,
    idempotencyKey: "x402_wallet_policy_upsert_zk_required_1"
  });
  assert.equal(policyUpsert.statusCode, 201, policyUpsert.body);

  const gateId = "gate_auth_zk_required_1";
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_zk_required_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      toolId: "tool_zk_required",
      amountCents: 500,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_zk_required_1",
        delegationRef: "delegation_zk_required_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const issuerDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId,
    idempotencyKey: "x402_wallet_issuer_zk_required_1"
  });
  assert.equal(issuerDecision.statusCode, 200, issuerDecision.body);

  const auth = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_zk_required_1" },
    body: {
      gateId,
      walletAuthorizationDecisionToken: issuerDecision.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(auth.statusCode, 200, auth.body);

  const verifyRes = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_zk_required_1" },
    body: {
      gateId,
      verificationStatus: "green",
      runStatus: "completed",
      evidenceRefs: [`http:request_sha256:${"1".repeat(64)}`, `http:response_sha256:${"2".repeat(64)}`]
    }
  });
  assert.equal(verifyRes.statusCode, 400, verifyRes.body);
  assert.equal(verifyRes.json?.code, "X402_MISSING_REQUIRED_PROOF");
  assert.equal(
    api.store.outbox.some(
      (message) =>
        message &&
        typeof message === "object" &&
        String(message.type ?? "") === "X402_AGENT_WINDDOWN_REVERSAL_REQUESTED" &&
        String(message.gateId ?? "") === gateId &&
        String(message.reasonCode ?? "") === "X402_MISSING_REQUIRED_PROOF"
    ),
    true
  );
});

test("API e2e: x402 gate verify fails when wallet policy references missing verification key", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_zk_missing_ref_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_zk_missing_ref_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_zk_missing_ref_1" });

  const verificationKeyId = "vk_missing_ref_valid_seed_1";
  const keyCreate = await putX402ZkVerificationKey(api, {
    verificationKey: {
      schemaVersion: "X402ZkVerificationKey.v1",
      verificationKeyId,
      protocol: "groth16",
      verificationKey: { curve: "bn128", vk_alpha_1: ["1", "2"] },
      providerRef: payeeAgentId
    },
    idempotencyKey: "x402_zk_verification_key_missing_ref_seed_1"
  });
  assert.equal(keyCreate.statusCode, 201, keyCreate.body);

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_zk_missing_ref_1",
    sponsorWalletRef: "wallet_zk_missing_ref_1",
    policyRef: "policy_zk_missing_ref_1",
    policyVersion: 1,
    status: "active",
    maxAmountCents: 1000,
    maxDailyAuthorizationCents: 5000,
    allowedProviderIds: [payeeAgentId],
    allowedToolIds: ["tool_zk_missing_ref"],
    allowedAgentKeyIds: [],
    allowedCurrencies: ["USD"],
    allowedReversalActions: ["void_authorization", "request_refund", "resolve_refund"],
    requiresZkProof: true,
    zkProofProtocol: "groth16",
    zkVerificationKeyRef: verificationKeyId,
    requireQuote: false,
    requireStrictRequestBinding: false,
    requireAgentKeyMatch: false
  };
  const policyUpsert = await upsertX402WalletPolicy(api, {
    policy: walletPolicy,
    idempotencyKey: "x402_wallet_policy_upsert_zk_missing_ref_1"
  });
  assert.equal(policyUpsert.statusCode, 201, policyUpsert.body);

  const gateId = "gate_auth_zk_missing_ref_1";
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_zk_missing_ref_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      toolId: "tool_zk_missing_ref",
      amountCents: 500,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_zk_missing_ref_1",
        delegationRef: "delegation_zk_missing_ref_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const issuerDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId,
    idempotencyKey: "x402_wallet_issuer_zk_missing_ref_1"
  });
  assert.equal(issuerDecision.statusCode, 200, issuerDecision.body);

  const auth = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_zk_missing_ref_1" },
    body: {
      gateId,
      walletAuthorizationDecisionToken: issuerDecision.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(auth.statusCode, 200, auth.body);

  for (const [policyStoreKey, record] of api.store.x402WalletPolicies.entries()) {
    if (
      record &&
      record.sponsorWalletRef === walletPolicy.sponsorWalletRef &&
      record.policyRef === walletPolicy.policyRef &&
      Number(record.policyVersion) === 1
    ) {
      api.store.x402WalletPolicies.set(policyStoreKey, {
        ...record,
        zkVerificationKeyRef: "vk_missing_ref_runtime_1"
      });
      break;
    }
  }

  const verifyRes = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_zk_missing_ref_1" },
    body: {
      gateId
    }
  });
  assert.equal(verifyRes.statusCode, 400, verifyRes.body);
  assert.equal(verifyRes.json?.code, "X402_INVALID_VERIFICATION_KEY_REF");
  assert.equal(
    api.store.outbox.some(
      (message) =>
        message &&
        typeof message === "object" &&
        String(message.type ?? "") === "X402_AGENT_WINDDOWN_REVERSAL_REQUESTED" &&
        String(message.gateId ?? "") === gateId &&
        String(message.reasonCode ?? "") === "X402_INVALID_VERIFICATION_KEY_REF"
    ),
    true
  );
});

test("API e2e: reserve failure during authorize-payment rolls back wallet escrow lock", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402ReserveAdapter: createCircleReserveAdapter({ mode: "fail" })
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_2" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_2" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_2" });

  const gateId = "gate_auth_2";
  const amountCents = 700;

  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_2" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const walletAfterCreate = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(walletAfterCreate.statusCode, 200, walletAfterCreate.body);
  assert.equal(walletAfterCreate.json?.wallet?.escrowLockedCents, amountCents);

  const authz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_fail_2" },
    body: { gateId }
  });
  assert.equal(authz.statusCode, 503, authz.body);
  assert.equal(authz.json?.code, "X402_RESERVE_FAILED");

  const walletAfterFail = await request(api, { method: "GET", path: `/agents/${encodeURIComponent(payerAgentId)}/wallet` });
  assert.equal(walletAfterFail.statusCode, 200, walletAfterFail.body);
  assert.equal(walletAfterFail.json?.wallet?.escrowLockedCents, 0);

  const gateRead = await request(api, { method: "GET", path: `/x402/gate/${encodeURIComponent(gateId)}` });
  assert.equal(gateRead.statusCode, 200, gateRead.body);
  assert.equal(gateRead.json?.gate?.authorization?.status, "failed");
});

test("API e2e: x402 gate create is blocked when payer agent is manually frozen", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_frozen_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_frozen_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_frozen_1" });

  const windDown = await windDownX402Agent(api, {
    agentId: payerAgentId,
    idempotencyKey: "x402_wind_down_frozen_1"
  });
  assert.equal(windDown.statusCode, 200, windDown.body);
  assert.equal(windDown.json?.lifecycle?.status, "frozen");
  assert.equal(windDown.json?.lifecycle?.agentId, payerAgentId);

  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_frozen_1" },
    body: {
      gateId: "gate_auth_frozen_1",
      payerAgentId,
      payeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 410, created.body);
  assert.equal(created.json?.code, "X402_AGENT_FROZEN");
});

test("API e2e: x402 authorize-payment is blocked when gate payer is manually frozen", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_frozen_payer_2" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_frozen_payee_2" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_frozen_2" });

  const gateId = "gate_auth_frozen_2";
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_frozen_2" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const windDown = await windDownX402Agent(api, {
    agentId: payerAgentId,
    idempotencyKey: "x402_wind_down_frozen_2"
  });
  assert.equal(windDown.statusCode, 200, windDown.body);

  const authz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_frozen_2" },
    body: { gateId }
  });
  assert.equal(authz.statusCode, 410, authz.body);
  assert.equal(authz.json?.code, "X402_AGENT_FROZEN");
});

test("API e2e: strict request binding mints request-bound token and reuses reserve", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_2b" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_2b" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_2b" });

  const gateId = "gate_auth_2b";
  const amountCents = 700;
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_2b" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const requestBindingShaA = "a".repeat(64);
  const authA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_2b_a" },
    body: { gateId, requestBindingMode: "strict", requestBindingSha256: requestBindingShaA }
  });
  assert.equal(authA.statusCode, 200, authA.body);
  const payloadA = parseSettldPayTokenV1(authA.json?.token).payload;
  assert.equal(payloadA.requestBindingMode, "strict");
  assert.equal(payloadA.requestBindingSha256, requestBindingShaA);

  const authAReplay = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_2b_a_replay" },
    body: { gateId, requestBindingMode: "strict", requestBindingSha256: requestBindingShaA }
  });
  assert.equal(authAReplay.statusCode, 200, authAReplay.body);
  assert.equal(authAReplay.json?.token, authA.json?.token);
  assert.equal(authAReplay.json?.reserve?.reserveId, authA.json?.reserve?.reserveId);

  const requestBindingShaB = "b".repeat(64);
  const authB = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_2b_b" },
    body: { gateId, requestBindingMode: "strict", requestBindingSha256: requestBindingShaB }
  });
  assert.equal(authB.statusCode, 200, authB.body);
  assert.notEqual(authB.json?.token, authA.json?.token);
  assert.equal(authB.json?.reserve?.reserveId, authA.json?.reserve?.reserveId);
  const payloadB = parseSettldPayTokenV1(authB.json?.token).payload;
  assert.equal(payloadB.requestBindingMode, "strict");
  assert.equal(payloadB.requestBindingSha256, requestBindingShaB);
});

test("API e2e: quote-bound authorization carries spend claims into settlement bindings", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_quote_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_quote_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 8000, idempotencyKey: "wallet_credit_x402_auth_quote_1" });
  const policyUpsert = await upsertX402WalletPolicy(api, {
    policy: {
      schemaVersion: "X402WalletPolicy.v1",
      sponsorRef: "sponsor_acme",
      sponsorWalletRef: "wallet_sponsor_1",
      policyRef: "policy_alpha",
      policyVersion: 3,
      status: "active",
      requireQuote: true,
      requireStrictRequestBinding: true,
      requireAgentKeyMatch: false
    },
    idempotencyKey: "x402_wallet_policy_upsert_auth_quote_1"
  });
  assert.equal(policyUpsert.statusCode, 201, policyUpsert.body);

  const gateId = "gate_auth_quote_1";
  const createGate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_quote_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      toolId: "mock_search",
      amountCents: 900,
      currency: "USD",
      agentPassport: {
        sponsorRef: "sponsor_acme",
        sponsorWalletRef: "wallet_sponsor_1",
        agentKeyId: "agent_key_1",
        delegationRef: "delegation_1",
        policyRef: "policy_alpha",
        policyVersion: 3
      }
    }
  });
  assert.equal(createGate.statusCode, 201, createGate.body);

  const requestBindingSha256 = "c".repeat(64);
  const quoted = await request(api, {
    method: "POST",
    path: "/x402/gate/quote",
    headers: { "x-idempotency-key": "x402_gate_quote_auth_quote_1" },
    body: {
      gateId,
      requestBindingMode: "strict",
      requestBindingSha256
    }
  });
  assert.equal(quoted.statusCode, 200, quoted.body);
  const quoteId = quoted.json?.quote?.quoteId;
  const quoteSha256 = quoted.json?.quote?.quoteSha256;
  assert.ok(typeof quoteId === "string" && quoteId.length > 0);
  assert.match(String(quoteSha256 ?? ""), /^[0-9a-f]{64}$/);

  const authorized = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_auth_quote_1" },
    body: {
      gateId,
      quoteId,
      requestBindingMode: "strict",
      requestBindingSha256
    }
  });
  assert.equal(authorized.statusCode, 409, authorized.body);
  assert.equal(authorized.json?.code, "X402_WALLET_ISSUER_DECISION_REQUIRED");

  const issuerDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: "wallet_sponsor_1",
    gateId,
    quoteId,
    requestBindingMode: "strict",
    requestBindingSha256,
    idempotencyKey: "x402_wallet_issuer_auth_quote_1"
  });
  assert.equal(issuerDecision.statusCode, 200, issuerDecision.body);

  const authorizedWithDecision = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_auth_quote_1b" },
    body: {
      gateId,
      quoteId,
      requestBindingMode: "strict",
      requestBindingSha256,
      walletAuthorizationDecisionToken: issuerDecision.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(authorizedWithDecision.statusCode, 200, authorizedWithDecision.body);
  const payload = parseSettldPayTokenV1(authorizedWithDecision.json?.token).payload;
  assert.equal(payload.requestBindingMode, "strict");
  assert.equal(payload.requestBindingSha256, requestBindingSha256);
  assert.equal(payload.quoteId, quoteId);
  assert.equal(payload.quoteSha256, quoteSha256);
  assert.ok(typeof payload.idempotencyKey === "string" && payload.idempotencyKey.length > 0);
  assert.ok(typeof payload.nonce === "string" && payload.nonce.length > 0);
  assert.equal(payload.sponsorRef, "sponsor_acme");
  assert.equal(payload.agentKeyId, "agent_key_1");
  assert.equal(payload.policyVersion, 3);
  assert.match(String(payload.policyFingerprint ?? ""), /^[0-9a-f]{64}$/);
  assert.equal(payload.spendAuthorizationVersion, "SpendAuthorization.v1");

  const verified = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_auth_quote_1" },
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
      verificationMethod: { mode: "deterministic", source: "http_status_v1" },
      evidenceRefs: [`http:request_sha256:${requestBindingSha256}`, `http:response_sha256:${"d".repeat(64)}`]
    }
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json?.decisionRecord?.bindings?.quote?.quoteId, quoteId);
  assert.equal(verified.json?.decisionRecord?.bindings?.quote?.quoteSha256, quoteSha256);
  assert.equal(verified.json?.decisionRecord?.bindings?.spendAuthorization?.sponsorRef, "sponsor_acme");
  assert.equal(verified.json?.decisionRecord?.bindings?.spendAuthorization?.agentKeyId, "agent_key_1");
  assert.equal(verified.json?.decisionRecord?.bindings?.spendAuthorization?.policyVersion, 3);
  assert.equal(verified.json?.decisionRecord?.bindings?.spendAuthorization?.policyFingerprint, payload.policyFingerprint);
});

test("API e2e: ops x402 wallet policy CRUD and authorize-payment policy enforcement", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_policy_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_policy_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 9000, idempotencyKey: "wallet_credit_x402_auth_policy_1" });

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_policy_ops_1",
    sponsorWalletRef: "wallet_policy_ops_1",
    policyRef: "policy_ops_1",
    policyVersion: 7,
    status: "active",
    maxAmountCents: 1000,
    maxDailyAuthorizationCents: 700,
    allowedProviderIds: [payeeAgentId],
    allowedToolIds: ["weather_read"],
    allowedAgentKeyIds: [],
    allowedCurrencies: ["USD"],
    allowedReversalActions: ["request_refund", "resolve_refund", "void_authorization"],
    requireQuote: true,
    requireStrictRequestBinding: true,
    requireAgentKeyMatch: false
  };
  const createdPolicy = await upsertX402WalletPolicy(api, {
    policy: walletPolicy,
    idempotencyKey: "x402_wallet_policy_upsert_1"
  });
  assert.equal(createdPolicy.statusCode, 201, createdPolicy.body);
  assert.equal(createdPolicy.json?.policy?.policyRef, walletPolicy.policyRef);
  assert.equal(createdPolicy.json?.policy?.policyVersion, walletPolicy.policyVersion);
  assert.equal(createdPolicy.json?.policy?.status, "active");
  assert.match(String(createdPolicy.json?.policy?.policyFingerprint ?? ""), /^[0-9a-f]{64}$/);

  const listed = await request(api, {
    method: "GET",
    path: `/ops/x402/wallet-policies?sponsorWalletRef=${encodeURIComponent(walletPolicy.sponsorWalletRef)}`
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(Array.isArray(listed.json?.policies), true);
  assert.equal(listed.json.policies.length, 1);
  assert.equal(listed.json.policies[0]?.policyRef, walletPolicy.policyRef);

  const fetched = await request(api, {
    method: "GET",
    path: `/ops/x402/wallet-policies/${encodeURIComponent(walletPolicy.sponsorWalletRef)}/${encodeURIComponent(walletPolicy.policyRef)}/${walletPolicy.policyVersion}`
  });
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(fetched.json?.policy?.policyRef, walletPolicy.policyRef);
  assert.equal(fetched.json?.policy?.policyVersion, walletPolicy.policyVersion);

  const gateA = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_policy_1a" },
    body: {
      gateId: "gate_auth_policy_1a",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 500,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_policy_1",
        delegationRef: "delegation_policy_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(gateA.statusCode, 201, gateA.body);

  const authWithoutQuote = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_policy_1a_noquote" },
    body: { gateId: "gate_auth_policy_1a" }
  });
  assert.equal(authWithoutQuote.statusCode, 409, authWithoutQuote.body);
  assert.equal(authWithoutQuote.json?.code, "X402_WALLET_ISSUER_DECISION_REQUIRED");

  const decisionWithoutQuote = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_policy_1a",
    idempotencyKey: "x402_wallet_issuer_policy_1a_noquote"
  });
  assert.equal(decisionWithoutQuote.statusCode, 409, decisionWithoutQuote.body);
  assert.equal(decisionWithoutQuote.json?.code, "X402_WALLET_POLICY_QUOTE_REQUIRED");

  const requestBindingShaA = "e".repeat(64);
  const quoteA = await request(api, {
    method: "POST",
    path: "/x402/gate/quote",
    headers: { "x-idempotency-key": "x402_gate_quote_auth_policy_1a" },
    body: {
      gateId: "gate_auth_policy_1a",
      requestBindingMode: "strict",
      requestBindingSha256: requestBindingShaA
    }
  });
  assert.equal(quoteA.statusCode, 200, quoteA.body);

  const authA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_policy_1a" },
    body: {
      gateId: "gate_auth_policy_1a",
      quoteId: quoteA.json?.quote?.quoteId,
      requestBindingMode: "strict",
      requestBindingSha256: requestBindingShaA
    }
  });
  assert.equal(authA.statusCode, 409, authA.body);
  assert.equal(authA.json?.code, "X402_WALLET_ISSUER_DECISION_REQUIRED");

  const issuerDecisionA = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_policy_1a",
    quoteId: quoteA.json?.quote?.quoteId,
    requestBindingMode: "strict",
    requestBindingSha256: requestBindingShaA,
    idempotencyKey: "x402_wallet_issuer_policy_1a"
  });
  assert.equal(issuerDecisionA.statusCode, 200, issuerDecisionA.body);

  const authAWithDecision = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_policy_1a_with_decision" },
    body: {
      gateId: "gate_auth_policy_1a",
      quoteId: quoteA.json?.quote?.quoteId,
      requestBindingMode: "strict",
      requestBindingSha256: requestBindingShaA,
      walletAuthorizationDecisionToken: issuerDecisionA.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(authAWithDecision.statusCode, 200, authAWithDecision.body);
  const tokenPayloadA = parseSettldPayTokenV1(authAWithDecision.json?.token).payload;
  assert.equal(tokenPayloadA.policyVersion, walletPolicy.policyVersion);
  assert.equal(tokenPayloadA.policyFingerprint, createdPolicy.json?.policy?.policyFingerprint);

  const gateB = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_policy_1b" },
    body: {
      gateId: "gate_auth_policy_1b",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 300,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_policy_1",
        delegationRef: "delegation_policy_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(gateB.statusCode, 201, gateB.body);

  const requestBindingShaB = "f".repeat(64);
  const quoteB = await request(api, {
    method: "POST",
    path: "/x402/gate/quote",
    headers: { "x-idempotency-key": "x402_gate_quote_auth_policy_1b" },
    body: {
      gateId: "gate_auth_policy_1b",
      requestBindingMode: "strict",
      requestBindingSha256: requestBindingShaB
    }
  });
  assert.equal(quoteB.statusCode, 200, quoteB.body);

  const issuerDecisionB = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_policy_1b",
    quoteId: quoteB.json?.quote?.quoteId,
    requestBindingMode: "strict",
    requestBindingSha256: requestBindingShaB,
    idempotencyKey: "x402_wallet_issuer_policy_1b"
  });
  assert.equal(issuerDecisionB.statusCode, 409, issuerDecisionB.body);
  assert.equal(issuerDecisionB.json?.code, "X402_WALLET_POLICY_DAILY_LIMIT_EXCEEDED");
});

test("API e2e: verify rejects spend authorization policy fingerprint mismatch", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_verify_policy_mismatch_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_verify_policy_mismatch_payee_1" });
  await creditWallet(api, {
    agentId: payerAgentId,
    amountCents: 5_000,
    idempotencyKey: "wallet_credit_x402_verify_policy_mismatch_1"
  });

  const policy = {
    sponsorRef: "sponsor_verify_policy_mismatch_1",
    sponsorWalletRef: "wallet_verify_policy_mismatch_1",
    policyRef: "default",
    policyVersion: 1,
    status: "active",
    maxAmountCents: 2_000,
    maxDailyAuthorizationCents: 20_000,
    allowedProviderIds: [],
    allowedToolIds: [],
    allowedAgentKeyIds: [],
    allowedCurrencies: ["USD"],
    requireQuote: false,
    requireStrictRequestBinding: false,
    requireAgentKeyMatch: false
  };
  const policyUpsert = await upsertX402WalletPolicy(api, {
    policy,
    idempotencyKey: "x402_wallet_policy_upsert_verify_policy_mismatch_1"
  });
  assert.equal(policyUpsert.statusCode, 201, policyUpsert.body);

  const gateId = "gate_verify_policy_mismatch_1";
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_verify_policy_mismatch_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      toolId: "tool_verify_policy_mismatch_1",
      amountCents: 500,
      currency: "USD",
      agentPassport: {
        sponsorRef: policy.sponsorRef,
        sponsorWalletRef: policy.sponsorWalletRef,
        agentKeyId: "agent_key_verify_policy_mismatch_1",
        delegationRef: "delegation_verify_policy_mismatch_1",
        policyRef: policy.policyRef,
        policyVersion: policy.policyVersion
      }
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const issuerDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: policy.sponsorWalletRef,
    gateId,
    idempotencyKey: "x402_wallet_issuer_verify_policy_mismatch_1"
  });
  assert.equal(issuerDecision.statusCode, 200, issuerDecision.body);

  const auth = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_verify_policy_mismatch_1" },
    body: {
      gateId,
      walletAuthorizationDecisionToken: issuerDecision.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(auth.statusCode, 200, auth.body);

  const storedGate = await api.store.getX402Gate({ tenantId: "tenant_default", gateId });
  assert.ok(storedGate?.authorization?.token?.value);
  const parsedToken = parseSettldPayTokenV1(storedGate.authorization.token.value);
  const tamperedEnvelope = {
    ...parsedToken.envelope,
    payload: {
      ...parsedToken.payload,
      policyFingerprint: "f".repeat(64)
    }
  };
  const tamperedToken = Buffer.from(canonicalJsonStringify(tamperedEnvelope), "utf8").toString("base64url");
  const tamperedGate = {
    ...storedGate,
    authorization: {
      ...storedGate.authorization,
      token: {
        ...storedGate.authorization.token,
        value: tamperedToken,
        sha256: computeSettldPayTokenSha256(tamperedToken)
      }
    }
  };
  await api.store.putX402Gate({ tenantId: "tenant_default", gateId, gate: tamperedGate });

  const verifyRes = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_policy_mismatch_1" },
    body: {
      gateId
    }
  });
  assert.equal(verifyRes.statusCode, 409, verifyRes.body);
  assert.equal(verifyRes.json?.code, "X402_SPEND_AUTH_POLICY_FINGERPRINT_MISMATCH");
  assert.equal(verifyRes.json?.details?.spendAuthorizationPolicyFingerprint, "f".repeat(64));
  assert.equal(verifyRes.json?.details?.expectedWalletPolicyFingerprint, policyUpsert.json?.policy?.policyFingerprint);
});

test("API e2e: authorize-payment emits escalation and resumes with approved override", async () => {
  const webhookCalls = [];
  const fetchFn = async (url, init) => {
    webhookCalls.push({ url, init });
    return new Response("ok", { status: 200 });
  };
  const api = createApi({
    opsToken: "tok_ops",
    fetchFn
  });

  const webhookCreate = await request(api, {
    method: "POST",
    path: "/x402/webhooks/endpoints",
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_webhook_create_1"
    },
    body: {
      url: "https://example.invalid/x402/escalations",
      events: ["x402.escalation.created"],
      description: "primary escalation listener",
      status: "active"
    }
  });
  assert.equal(webhookCreate.statusCode, 201, webhookCreate.body);
  const webhookEndpointId = webhookCreate.json?.endpoint?.endpointId;
  const webhookSecret = webhookCreate.json?.secret;
  assert.ok(typeof webhookEndpointId === "string" && webhookEndpointId.length > 0);
  assert.ok(typeof webhookSecret === "string" && webhookSecret.startsWith("whsec_"));

  const webhookGet = await request(api, {
    method: "GET",
    path: `/x402/webhooks/endpoints/${encodeURIComponent(webhookEndpointId)}`
  });
  assert.equal(webhookGet.statusCode, 200, webhookGet.body);
  assert.equal(webhookGet.json?.endpoint?.endpointId, webhookEndpointId);
  assert.equal(webhookGet.json?.endpoint?.description, "primary escalation listener");
  assert.equal(webhookGet.json?.endpoint?.secret, undefined);

  const webhookList = await request(api, {
    method: "GET",
    path: "/x402/webhooks/endpoints?status=active&event=x402.escalation.created"
  });
  assert.equal(webhookList.statusCode, 200, webhookList.body);
  assert.equal(webhookList.json?.endpoints?.length, 1);
  assert.equal(webhookList.json?.endpoints?.[0]?.endpointId, webhookEndpointId);

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_escalation_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_escalation_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 12_000, idempotencyKey: "wallet_credit_x402_auth_escalation_1" });

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_escalation_ops_1",
    sponsorWalletRef: "wallet_escalation_ops_1",
    policyRef: "policy_escalation_1",
    policyVersion: 1,
    status: "active",
    maxAmountCents: 1000,
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
    idempotencyKey: "x402_wallet_policy_upsert_escalation_1"
  });
  assert.equal(createdPolicy.statusCode, 201, createdPolicy.body);

  const createGateA = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_escalation_1a" },
    body: {
      gateId: "gate_auth_escalation_1a",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 300,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_escalation_1",
        delegationRef: "delegation_escalation_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGateA.statusCode, 201, createGateA.body);

  const createGateB = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_escalation_1b" },
    body: {
      gateId: "gate_auth_escalation_1b",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 200,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_escalation_1",
        delegationRef: "delegation_escalation_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGateB.statusCode, 201, createGateB.body);

  const issuerDecisionA = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_escalation_1a",
    idempotencyKey: "x402_wallet_issuer_escalation_1a"
  });
  assert.equal(issuerDecisionA.statusCode, 200, issuerDecisionA.body);

  const issuerDecisionB = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_escalation_1b",
    idempotencyKey: "x402_wallet_issuer_escalation_1b"
  });
  assert.equal(issuerDecisionB.statusCode, 200, issuerDecisionB.body);

  const authB = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_escalation_1b" },
    body: {
      gateId: "gate_auth_escalation_1b",
      walletAuthorizationDecisionToken: issuerDecisionB.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(authB.statusCode, 200, authB.body);

  const blockedA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_escalation_1a_blocked" },
    body: {
      gateId: "gate_auth_escalation_1a",
      walletAuthorizationDecisionToken: issuerDecisionA.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(blockedA.statusCode, 409, blockedA.body);
  assert.equal(blockedA.json?.code, "X402_AUTHORIZATION_ESCALATION_REQUIRED");
  const escalationId = blockedA.json?.details?.escalation?.escalationId;
  assert.ok(typeof escalationId === "string" && escalationId.length > 0);
  assert.equal(blockedA.json?.details?.escalation?.requesterAgentId, payerAgentId);

  const escalationListByAgent = await request(api, {
    method: "GET",
    path: `/x402/gate/escalations?status=pending&agentId=${encodeURIComponent(payerAgentId)}`
  });
  assert.equal(escalationListByAgent.statusCode, 200, escalationListByAgent.body);
  assert.equal(escalationListByAgent.json?.escalations?.length, 1);
  assert.equal(escalationListByAgent.json?.escalations?.[0]?.escalationId, escalationId);

  const escalationListByAgentSnake = await request(api, {
    method: "GET",
    path: `/x402/gate/escalations?status=pending&agent_id=${encodeURIComponent(payerAgentId)}`
  });
  assert.equal(escalationListByAgentSnake.statusCode, 200, escalationListByAgentSnake.body);
  assert.equal(escalationListByAgentSnake.json?.escalations?.length, 1);

  const escalationListMiss = await request(api, {
    method: "GET",
    path: "/x402/gate/escalations?status=pending&agentId=agt_missing"
  });
  assert.equal(escalationListMiss.statusCode, 200, escalationListMiss.body);
  assert.equal(escalationListMiss.json?.escalations?.length, 0);

  const escalationRead = await request(api, {
    method: "GET",
    path: `/x402/gate/escalations/${encodeURIComponent(escalationId)}`
  });
  assert.equal(escalationRead.statusCode, 200, escalationRead.body);
  assert.equal(escalationRead.json?.escalation?.status, "pending");
  assert.equal(escalationRead.json?.escalation?.reasonCode, "X402_WALLET_POLICY_DAILY_LIMIT_EXCEEDED");
  assert.equal(escalationRead.json?.escalation?.requesterAgentId, payerAgentId);

  const pendingDeliveryTick = await api.tickDeliveries({ maxMessages: 10 });
  assert.ok(Array.isArray(pendingDeliveryTick?.processed));
  assert.equal(webhookCalls.length, 1);
  const firstWebhook = webhookCalls[0];
  assert.equal(firstWebhook?.url, "https://example.invalid/x402/escalations");
  const firstHeaders = firstWebhook?.init?.headers ?? {};
  const firstProxyTs = firstHeaders["x-proxy-timestamp"] ?? firstHeaders["X-Proxy-Timestamp"];
  const firstProxySig = firstHeaders["x-proxy-signature"] ?? firstHeaders["X-Proxy-Signature"];
  const firstSettldTs = firstHeaders["x-settld-timestamp"] ?? firstHeaders["X-Settld-Timestamp"];
  const firstSettldSig = firstHeaders["x-settld-signature"] ?? firstHeaders["X-Settld-Signature"];
  assert.ok(firstProxyTs);
  assert.ok(firstProxySig);
  assert.equal(firstSettldTs, firstProxyTs);
  assert.equal(firstSettldSig, firstProxySig);
  const firstBody = JSON.parse(String(firstWebhook?.init?.body ?? "{}"));
  assert.equal(firstBody?.artifactType, "X402EscalationLifecycle.v1");
  assert.equal(firstBody?.eventType, "created");
  assert.equal(firstBody?.payload?.escalation?.escalationId, escalationId);
  assert.equal(firstBody?.payload?.proposedExecution?.payerAgentId, payerAgentId);
  assert.equal(firstBody?.payload?.proposedExecution?.providerId, payeeAgentId);
  const firstExpectedSig = hmacSignArtifact({
    secret: webhookSecret,
    timestamp: firstProxyTs,
    bodyJson: firstBody
  });
  assert.equal(firstProxySig, firstExpectedSig);

  const escalationApprove = await resolveX402Escalation(api, {
    escalationId,
    action: "approve",
    reason: "one-time emergency override",
    idempotencyKey: "x402_escalation_resolve_1a"
  });
  assert.equal(escalationApprove.statusCode, 200, escalationApprove.body);
  assert.equal(escalationApprove.json?.escalation?.status, "approved");
  assert.ok(typeof escalationApprove.json?.walletAuthorizationDecisionToken === "string");
  assert.ok(typeof escalationApprove.json?.escalationOverrideToken === "string");
  const approvedDeliveryTick = await api.tickDeliveries({ maxMessages: 10 });
  assert.ok(Array.isArray(approvedDeliveryTick?.processed));
  assert.equal(webhookCalls.length, 1);

  const resumedA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_escalation_1a_resume" },
    body: {
      gateId: "gate_auth_escalation_1a",
      walletAuthorizationDecisionToken: escalationApprove.json?.walletAuthorizationDecisionToken,
      escalationOverrideToken: escalationApprove.json?.escalationOverrideToken
    }
  });
  assert.equal(resumedA.statusCode, 200, resumedA.body);
  assert.equal(resumedA.json?.gateId, "gate_auth_escalation_1a");
  assert.equal(resumedA.json?.reserve?.status, "reserved");
});

test("API e2e: x402 webhook endpoint auto-disables after repeated failures", async () => {
  const fetchFn = async () => new Response("nope", { status: 500 });
  const api = createApi({
    opsToken: "tok_ops",
    fetchFn,
    deliveryMaxAttempts: 1,
    x402WebhookAutoDisableFailures: 1
  });

  const webhookCreate = await request(api, {
    method: "POST",
    path: "/x402/webhooks/endpoints",
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_webhook_create_fail_1"
    },
    body: {
      url: "https://example.invalid/x402/escalations-fail",
      events: ["x402.escalation.created"]
    }
  });
  assert.equal(webhookCreate.statusCode, 201, webhookCreate.body);
  const endpointId = webhookCreate.json?.endpoint?.endpointId;
  assert.ok(typeof endpointId === "string" && endpointId.length > 0);

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_webhook_fail_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_webhook_fail_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 10_000, idempotencyKey: "wallet_credit_x402_webhook_fail_1" });

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_webhook_fail_1",
    sponsorWalletRef: "wallet_webhook_fail_1",
    policyRef: "policy_webhook_fail_1",
    policyVersion: 1,
    status: "active",
    maxAmountCents: 1000,
    maxDailyAuthorizationCents: 200,
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
    idempotencyKey: "x402_wallet_policy_upsert_webhook_fail_1"
  });
  assert.equal(createdPolicy.statusCode, 201, createdPolicy.body);

  const createGateA = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_webhook_fail_1a" },
    body: {
      gateId: "gate_auth_webhook_fail_1a",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 200,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_webhook_fail_1",
        delegationRef: "delegation_webhook_fail_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGateA.statusCode, 201, createGateA.body);

  const createGateB = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_webhook_fail_1b" },
    body: {
      gateId: "gate_auth_webhook_fail_1b",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 200,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_webhook_fail_1",
        delegationRef: "delegation_webhook_fail_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGateB.statusCode, 201, createGateB.body);

  const issuerDecisionA = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_webhook_fail_1a",
    idempotencyKey: "x402_wallet_issuer_webhook_fail_1a"
  });
  assert.equal(issuerDecisionA.statusCode, 200, issuerDecisionA.body);

  const issuerDecisionB = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_webhook_fail_1b",
    idempotencyKey: "x402_wallet_issuer_webhook_fail_1b"
  });
  assert.equal(issuerDecisionB.statusCode, 200, issuerDecisionB.body);

  const authB = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_webhook_fail_1b" },
    body: {
      gateId: "gate_auth_webhook_fail_1b",
      walletAuthorizationDecisionToken: issuerDecisionB.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(authB.statusCode, 200, authB.body);

  const blockedA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_webhook_fail_1a_blocked" },
    body: {
      gateId: "gate_auth_webhook_fail_1a",
      walletAuthorizationDecisionToken: issuerDecisionA.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(blockedA.statusCode, 409, blockedA.body);
  assert.equal(blockedA.json?.code, "X402_AUTHORIZATION_ESCALATION_REQUIRED");

  const deliveryTick = await api.tickDeliveries({ maxMessages: 10 });
  assert.ok(Array.isArray(deliveryTick?.processed));

  const webhookRead = await request(api, {
    method: "GET",
    path: `/x402/webhooks/endpoints/${encodeURIComponent(endpointId)}`
  });
  assert.equal(webhookRead.statusCode, 200, webhookRead.body);
  assert.equal(webhookRead.json?.endpoint?.status, "disabled");
  assert.equal(webhookRead.json?.endpoint?.consecutiveFailures, 1);
  assert.ok(typeof webhookRead.json?.endpoint?.lastFailureReason === "string");
});

test("API e2e: x402 webhook endpoint secret rotation supports dual-signature grace window", async () => {
  const webhookCalls = [];
  const fetchFn = async (url, init) => {
    webhookCalls.push({ url, init });
    return new Response("ok", { status: 200 });
  };
  const api = createApi({
    opsToken: "tok_ops",
    fetchFn
  });

  const webhookCreate = await request(api, {
    method: "POST",
    path: "/x402/webhooks/endpoints",
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_webhook_rotate_create_1"
    },
    body: {
      url: "https://example.invalid/x402/escalations-rotate",
      events: ["x402.escalation.created"],
      status: "active"
    }
  });
  assert.equal(webhookCreate.statusCode, 201, webhookCreate.body);
  const endpointId = webhookCreate.json?.endpoint?.endpointId;
  const initialSecret = webhookCreate.json?.secret;
  assert.ok(typeof endpointId === "string" && endpointId.length > 0);
  assert.ok(typeof initialSecret === "string" && initialSecret.startsWith("whsec_"));

  const rotate = await request(api, {
    method: "POST",
    path: `/x402/webhooks/endpoints/${encodeURIComponent(endpointId)}/rotate-secret`,
    headers: {
      "x-settld-protocol": "1.0",
      "x-idempotency-key": "x402_webhook_rotate_secret_1"
    },
    body: {
      gracePeriodSeconds: 3600
    }
  });
  assert.equal(rotate.statusCode, 200, rotate.body);
  const rotatedSecret = rotate.json?.secret;
  assert.ok(typeof rotatedSecret === "string" && rotatedSecret.startsWith("whsec_"));
  assert.notEqual(rotatedSecret, initialSecret);

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_webhook_rotate_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_webhook_rotate_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 10_000, idempotencyKey: "wallet_credit_x402_webhook_rotate_1" });

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_webhook_rotate_1",
    sponsorWalletRef: "wallet_webhook_rotate_1",
    policyRef: "policy_webhook_rotate_1",
    policyVersion: 1,
    status: "active",
    maxAmountCents: 1000,
    maxDailyAuthorizationCents: 200,
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
    idempotencyKey: "x402_wallet_policy_upsert_webhook_rotate_1"
  });
  assert.equal(createdPolicy.statusCode, 201, createdPolicy.body);

  const createGateA = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_webhook_rotate_1a" },
    body: {
      gateId: "gate_auth_webhook_rotate_1a",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 200,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_webhook_rotate_1",
        delegationRef: "delegation_webhook_rotate_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGateA.statusCode, 201, createGateA.body);

  const createGateB = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_webhook_rotate_1b" },
    body: {
      gateId: "gate_auth_webhook_rotate_1b",
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 200,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_webhook_rotate_1",
        delegationRef: "delegation_webhook_rotate_1",
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGateB.statusCode, 201, createGateB.body);

  const issuerDecisionA = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_webhook_rotate_1a",
    idempotencyKey: "x402_wallet_issuer_webhook_rotate_1a"
  });
  assert.equal(issuerDecisionA.statusCode, 200, issuerDecisionA.body);

  const issuerDecisionB = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId: "gate_auth_webhook_rotate_1b",
    idempotencyKey: "x402_wallet_issuer_webhook_rotate_1b"
  });
  assert.equal(issuerDecisionB.statusCode, 200, issuerDecisionB.body);

  const authB = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_webhook_rotate_1b" },
    body: {
      gateId: "gate_auth_webhook_rotate_1b",
      walletAuthorizationDecisionToken: issuerDecisionB.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(authB.statusCode, 200, authB.body);

  const blockedA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_webhook_rotate_1a_blocked" },
    body: {
      gateId: "gate_auth_webhook_rotate_1a",
      walletAuthorizationDecisionToken: issuerDecisionA.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(blockedA.statusCode, 409, blockedA.body);
  assert.equal(blockedA.json?.code, "X402_AUTHORIZATION_ESCALATION_REQUIRED");

  const tick = await api.tickDeliveries({ maxMessages: 10 });
  assert.ok(Array.isArray(tick?.processed));
  assert.equal(webhookCalls.length, 1);
  const sent = webhookCalls[0];
  const headers = sent?.init?.headers ?? {};
  const timestamp = headers["x-proxy-timestamp"] ?? headers["X-Proxy-Timestamp"];
  const signatureHeader = headers["x-proxy-signature"] ?? headers["X-Proxy-Signature"];
  assert.ok(typeof timestamp === "string" && timestamp.length > 0);
  assert.ok(typeof signatureHeader === "string" && signatureHeader.length > 0);
  const body = JSON.parse(String(sent?.init?.body ?? "{}"));
  const signatures = parseWebhookSignatures(signatureHeader);
  assert.equal(signatures.length, 2);

  const expectedNew = hmacSignArtifact({
    secret: rotatedSecret,
    timestamp,
    bodyJson: body
  });
  const expectedOld = hmacSignArtifact({
    secret: initialSecret,
    timestamp,
    bodyJson: body
  });
  assert.ok(signatures.includes(expectedNew));
  assert.ok(signatures.includes(expectedOld));
});

test("API e2e: production-like defaults fail closed when external reserve is unavailable", async (t) => {
  const prevSettldEnv = process.env.SETTLD_ENV;
  const prevRequireReserve = process.env.X402_REQUIRE_EXTERNAL_RESERVE;
  const prevReserveMode = process.env.X402_CIRCLE_RESERVE_MODE;

  process.env.SETTLD_ENV = "production";
  delete process.env.X402_REQUIRE_EXTERNAL_RESERVE;
  delete process.env.X402_CIRCLE_RESERVE_MODE;
  t.after(() => {
    if (prevSettldEnv === undefined) delete process.env.SETTLD_ENV;
    else process.env.SETTLD_ENV = prevSettldEnv;
    if (prevRequireReserve === undefined) delete process.env.X402_REQUIRE_EXTERNAL_RESERVE;
    else process.env.X402_REQUIRE_EXTERNAL_RESERVE = prevRequireReserve;
    if (prevReserveMode === undefined) delete process.env.X402_CIRCLE_RESERVE_MODE;
    else process.env.X402_CIRCLE_RESERVE_MODE = prevReserveMode;
  });

  const api = createApi({
    opsToken: "tok_ops",
    x402ReserveAdapter: createCircleReserveAdapter({ mode: "stub" })
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_3" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_3" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_3" });

  const gateId = "gate_auth_3";
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_3" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents: 700,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_3" },
    body: { gateId }
  });
  assert.equal(authz.statusCode, 503, authz.body);
  assert.equal(authz.json?.code, "X402_RESERVE_UNAVAILABLE");
});

test("API e2e: x402 authorize-payment kill switch blocks authorization", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402PilotKillSwitch: true
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_4" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_4" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_4" });

  const gateId = "gate_auth_4";
  const created = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_4" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(created.statusCode, 201, created.body);

  const authz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_4" },
    body: { gateId }
  });
  assert.equal(authz.statusCode, 409, authz.body);
  assert.equal(authz.json?.code, "X402_PILOT_KILL_SWITCH_ACTIVE");
});

test("API e2e: x402 authorize-payment enforces provider allowlist and per-call cap", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402PilotAllowedProviderIds: ["agt_x402_auth_payee_allowed"],
    x402PilotMaxAmountCents: 300
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_5" });
  const allowedPayeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_allowed" });
  const disallowedPayeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_5_disallowed" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_5" });

  const disallowedGateId = "gate_auth_5_disallowed";
  const disallowedCreate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_5_disallowed" },
    body: {
      gateId: disallowedGateId,
      payerAgentId,
      payeeAgentId: disallowedPayeeAgentId,
      amountCents: 200,
      currency: "USD"
    }
  });
  assert.equal(disallowedCreate.statusCode, 201, disallowedCreate.body);
  const disallowedAuthz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_5_disallowed" },
    body: { gateId: disallowedGateId }
  });
  assert.equal(disallowedAuthz.statusCode, 409, disallowedAuthz.body);
  assert.equal(disallowedAuthz.json?.code, "X402_PILOT_PROVIDER_NOT_ALLOWED");

  const highAmountGateId = "gate_auth_5_high_amount";
  const highAmountCreate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_5_high_amount" },
    body: {
      gateId: highAmountGateId,
      payerAgentId,
      payeeAgentId: allowedPayeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(highAmountCreate.statusCode, 201, highAmountCreate.body);
  const highAmountAuthz = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_5_high_amount" },
    body: { gateId: highAmountGateId }
  });
  assert.equal(highAmountAuthz.statusCode, 409, highAmountAuthz.body);
  assert.equal(highAmountAuthz.json?.code, "X402_PILOT_AMOUNT_LIMIT_EXCEEDED");
});

test("API e2e: x402 authorize-payment enforces daily tenant cap", async () => {
  const api = createApi({
    opsToken: "tok_ops",
    x402PilotDailyLimitCents: 800
  });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payer_6" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_payee_6" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 8000, idempotencyKey: "wallet_credit_x402_auth_6" });

  const gateA = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_6_a" },
    body: {
      gateId: "gate_auth_6_a",
      payerAgentId,
      payeeAgentId,
      amountCents: 500,
      currency: "USD"
    }
  });
  assert.equal(gateA.statusCode, 201, gateA.body);
  const authA = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_6_a" },
    body: { gateId: "gate_auth_6_a" }
  });
  assert.equal(authA.statusCode, 200, authA.body);

  const gateB = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_6_b" },
    body: {
      gateId: "gate_auth_6_b",
      payerAgentId,
      payeeAgentId,
      amountCents: 400,
      currency: "USD"
    }
  });
  assert.equal(gateB.statusCode, 201, gateB.body);
  const authB = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_6_b" },
    body: { gateId: "gate_auth_6_b" }
  });
  assert.equal(authB.statusCode, 409, authB.body);
  assert.equal(authB.json?.code, "X402_PILOT_DAILY_LIMIT_EXCEEDED");
  assert.equal(authB.json?.details?.currentExposureCents, 500);
  assert.equal(authB.json?.details?.projectedExposureCents, 900);
});

test("API e2e: x402 wallet policy enforces max delegation depth fail-closed", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_depth_payer_1" });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_x402_auth_depth_payee_1" });
  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_credit_x402_auth_depth_1" });

  const walletPolicy = {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: "sponsor_depth_ops_1",
    sponsorWalletRef: "wallet_depth_ops_1",
    policyRef: "policy_depth_1",
    policyVersion: 1,
    status: "active",
    maxDelegationDepth: 1,
    allowedProviderIds: [payeeAgentId],
    allowedToolIds: ["weather_read"],
    requireQuote: false,
    requireStrictRequestBinding: false,
    requireAgentKeyMatch: false
  };
  const createdPolicy = await upsertX402WalletPolicy(api, {
    policy: walletPolicy,
    idempotencyKey: "x402_wallet_policy_upsert_depth_1"
  });
  assert.equal(createdPolicy.statusCode, 201, createdPolicy.body);

  const gateId = "gate_auth_depth_1";
  const createGate = await request(api, {
    method: "POST",
    path: "/x402/gate/create",
    headers: { "x-idempotency-key": "x402_gate_create_auth_depth_1" },
    body: {
      gateId,
      payerAgentId,
      payeeAgentId,
      toolId: "weather_read",
      amountCents: 350,
      currency: "USD",
      agentPassport: {
        sponsorRef: walletPolicy.sponsorRef,
        sponsorWalletRef: walletPolicy.sponsorWalletRef,
        agentKeyId: "agent_key_depth_1",
        delegationRef: "delegation_depth_1",
        delegationDepth: 2,
        maxDelegationDepth: 3,
        policyRef: walletPolicy.policyRef,
        policyVersion: walletPolicy.policyVersion
      }
    }
  });
  assert.equal(createGate.statusCode, 201, createGate.body);

  const issuerDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef: walletPolicy.sponsorWalletRef,
    gateId,
    idempotencyKey: "x402_wallet_issuer_depth_1"
  });
  assert.equal(issuerDecision.statusCode, 409, issuerDecision.body);
  assert.equal(issuerDecision.json?.code, "X402_WALLET_POLICY_DELEGATION_DEPTH_EXCEEDED");
  assert.equal(issuerDecision.json?.details?.details?.delegationDepth, 2);
  assert.equal(issuerDecision.json?.details?.details?.maxDelegationDepth, 1);

  const gateRead = await request(api, {
    method: "GET",
    path: `/x402/gate/${encodeURIComponent(gateId)}`
  });
  assert.equal(gateRead.statusCode, 200, gateRead.body);
  assert.equal(gateRead.json?.gate?.authorization?.status, "pending");

  const settlementRead = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(`x402_${gateId}`)}/settlement`
  });
  assert.equal(settlementRead.statusCode, 200, settlementRead.body);
  assert.equal(settlementRead.json?.settlement?.status, "locked");
});

test("API e2e: AgentPassport.v1 lineage resolver enforces revoked/expired/depth with stable codes", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const principalAgentId = await registerAgent(api, { agentId: "agt_x402_auth_lineage_principal_1" });
  const managerAgentId = await registerAgent(api, { agentId: "agt_x402_auth_lineage_manager_1" });
  const payer = await registerAgent(api, { agentId: "agt_x402_auth_lineage_payer_1" });
  const payee = await registerAgent(api, { agentId: "agt_x402_auth_lineage_payee_1" });
  await creditWallet(api, { agentId: payer, amountCents: 9000, idempotencyKey: "wallet_credit_x402_auth_lineage_1" });

  const sponsorRef = "sponsor_lineage_1";
  const sponsorWalletRef = "wallet_lineage_1";
  const policyRef = "policy_lineage_1";
  const policyVersion = 1;
  const policyUpsert = await upsertX402WalletPolicy(api, {
    policy: {
      schemaVersion: "X402WalletPolicy.v1",
      sponsorRef,
      sponsorWalletRef,
      policyRef,
      policyVersion,
      status: "active",
      allowedProviderIds: [payee],
      allowedToolIds: ["weather_read"],
      requireQuote: false,
      requireStrictRequestBinding: false,
      requireAgentKeyMatch: false
    },
    idempotencyKey: "x402_wallet_policy_upsert_lineage_1"
  });
  assert.equal(policyUpsert.statusCode, 201, policyUpsert.body);

  const rootAgreementHash = sha256Hex("agreement_lineage_root_1");
  const middleAgreementHash = sha256Hex("agreement_lineage_middle_1");
  const leafAgreementHash = sha256Hex("agreement_lineage_leaf_1");

  const rootDelegation = await createAgreementDelegation(api, {
    parentAgreementHash: rootAgreementHash,
    delegationId: "dlg_lineage_root_1",
    childAgreementHash: middleAgreementHash,
    delegatorAgentId: principalAgentId,
    delegateeAgentId: managerAgentId,
    budgetCapCents: 5000,
    delegationDepth: 0,
    maxDelegationDepth: 2,
    idempotencyKey: "agreement_delegation_lineage_root_1"
  });
  const leafDelegation = await createAgreementDelegation(api, {
    parentAgreementHash: middleAgreementHash,
    delegationId: "dlg_lineage_leaf_1",
    childAgreementHash: leafAgreementHash,
    delegatorAgentId: managerAgentId,
    delegateeAgentId: payer,
    budgetCapCents: 3000,
    delegationDepth: 1,
    maxDelegationDepth: 2,
    idempotencyKey: "agreement_delegation_lineage_leaf_1"
  });
  assert.ok(rootDelegation?.delegationHash);
  assert.ok(leafDelegation?.delegationHash);

  const nowIso = new Date().toISOString();
  const passportBase = {
    schemaVersion: "AgentPassport.v1",
    passportId: "passport_lineage_1",
    agentId: payer,
    tenantId: "tenant_default",
    principalRef: {
      principalType: "service",
      principalId: sponsorRef
    },
    identityAnchors: {
      jwksUri: "https://example.com/.well-known/jwks.json",
      activeKeyId: "agent_key_lineage_1",
      keysetHash: sha256Hex("lineage_keyset_1")
    },
    delegationRoot: {
      rootGrantId: "dlg_lineage_root_1",
      rootGrantHash: rootDelegation.delegationHash,
      issuedAt: nowIso,
      expiresAt: null,
      revokedAt: null
    },
    policyEnvelope: {
      maxPerCallCents: 2000,
      maxDailyCents: 10000,
      allowedRiskClasses: ["read"],
      requireApprovalAboveCents: null,
      allowlistRefs: [policyRef]
    },
    status: "active",
    metadata: {
      x402: {
        sponsorWalletRef,
        policyRef,
        policyVersion,
        delegationRef: "dlg_lineage_leaf_1",
        delegationDepth: 1,
        maxDelegationDepth: 2
      }
    },
    createdAt: nowIso,
    updatedAt: nowIso
  };

  const createGate = async (gateId, agentPassport, idempotencyKey) =>
    await request(api, {
      method: "POST",
      path: "/x402/gate/create",
      headers: { "x-idempotency-key": idempotencyKey },
      body: {
        gateId,
        payerAgentId: payer,
        payeeAgentId: payee,
        toolId: "weather_read",
        amountCents: 450,
        currency: "USD",
        agentPassport
      }
    });

  const validGateId = "gate_auth_lineage_valid_1";
  const createValid = await createGate(validGateId, passportBase, "x402_gate_create_auth_lineage_valid_1");
  assert.equal(createValid.statusCode, 201, createValid.body);
  const validIssuerDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef,
    gateId: validGateId,
    idempotencyKey: "x402_wallet_issuer_lineage_valid_1"
  });
  assert.equal(validIssuerDecision.statusCode, 200, validIssuerDecision.body);
  const validAuthorize = await request(api, {
    method: "POST",
    path: "/x402/gate/authorize-payment",
    headers: { "x-idempotency-key": "x402_gate_authz_lineage_valid_1" },
    body: {
      gateId: validGateId,
      walletAuthorizationDecisionToken: validIssuerDecision.json?.walletAuthorizationDecisionToken
    }
  });
  assert.equal(validAuthorize.statusCode, 200, validAuthorize.body);
  const validTokenPayload = parseSettldPayTokenV1(validAuthorize.json?.token ?? "").payload;
  assert.equal(validTokenPayload.delegationRef, "dlg_lineage_leaf_1");
  assert.equal(validTokenPayload.rootDelegationRef, "dlg_lineage_root_1");
  assert.equal(validTokenPayload.rootDelegationHash, rootDelegation.delegationHash);
  assert.equal(validTokenPayload.effectiveDelegationRef, "dlg_lineage_leaf_1");
  assert.equal(validTokenPayload.effectiveDelegationHash, leafDelegation.delegationHash);

  const validRequestSha256 = sha256Hex("GET\nexample.com\n/tools/weather?city=seattle\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const validResponseSha256 = sha256Hex("{\"tempC\":12,\"ok\":true}");
  const validVerify = await request(api, {
    method: "POST",
    path: "/x402/gate/verify",
    headers: { "x-idempotency-key": "x402_gate_verify_lineage_valid_1" },
    body: {
      gateId: validGateId,
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
      verificationMethod: { mode: "deterministic", source: "http_status_v1" },
      evidenceRefs: [`http:request_sha256:${validRequestSha256}`, `http:response_sha256:${validResponseSha256}`]
    }
  });
  assert.equal(validVerify.statusCode, 200, validVerify.body);
  assert.equal(validVerify.json?.settlement?.status, "released");
  assert.equal(validVerify.json?.decisionRecord?.bindings?.spendAuthorization?.delegationRef, "dlg_lineage_leaf_1");
  assert.equal(validVerify.json?.decisionRecord?.bindings?.spendAuthorization?.rootDelegationRef, "dlg_lineage_root_1");
  assert.equal(validVerify.json?.decisionRecord?.bindings?.spendAuthorization?.rootDelegationHash, rootDelegation.delegationHash);
  assert.equal(validVerify.json?.decisionRecord?.bindings?.spendAuthorization?.effectiveDelegationRef, "dlg_lineage_leaf_1");
  assert.equal(validVerify.json?.decisionRecord?.bindings?.spendAuthorization?.effectiveDelegationHash, leafDelegation.delegationHash);
  assert.equal(validVerify.json?.settlementReceipt?.bindings?.spendAuthorization?.rootDelegationRef, "dlg_lineage_root_1");
  assert.equal(validVerify.json?.settlementReceipt?.bindings?.spendAuthorization?.effectiveDelegationRef, "dlg_lineage_leaf_1");

  const expiredGateId = "gate_auth_lineage_expired_1";
  const expiredPassport = {
    ...passportBase,
    delegationRoot: {
      ...passportBase.delegationRoot,
      expiresAt: "2000-01-01T00:00:00.000Z"
    },
    updatedAt: new Date().toISOString()
  };
  const createExpired = await createGate(expiredGateId, expiredPassport, "x402_gate_create_auth_lineage_expired_1");
  assert.equal(createExpired.statusCode, 201, createExpired.body);
  const expiredDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef,
    gateId: expiredGateId,
    idempotencyKey: "x402_wallet_issuer_lineage_expired_1"
  });
  assert.equal(expiredDecision.statusCode, 409, expiredDecision.body);
  assert.equal(expiredDecision.json?.code, "X402_DELEGATION_EXPIRED");

  const revokedGateId = "gate_auth_lineage_revoked_1";
  const revokedPassport = {
    ...passportBase,
    delegationRoot: {
      ...passportBase.delegationRoot,
      revokedAt: "2000-01-01T00:00:00.000Z"
    },
    updatedAt: new Date().toISOString()
  };
  const createRevoked = await createGate(revokedGateId, revokedPassport, "x402_gate_create_auth_lineage_revoked_1");
  assert.equal(createRevoked.statusCode, 201, createRevoked.body);
  const revokedDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef,
    gateId: revokedGateId,
    idempotencyKey: "x402_wallet_issuer_lineage_revoked_1"
  });
  assert.equal(revokedDecision.statusCode, 409, revokedDecision.body);
  assert.equal(revokedDecision.json?.code, "X402_DELEGATION_REVOKED");

  const depthGateId = "gate_auth_lineage_depth_1";
  const depthPassport = {
    ...passportBase,
    metadata: {
      x402: {
        ...passportBase.metadata.x402,
        delegationDepth: 2,
        maxDelegationDepth: 2
      }
    },
    updatedAt: new Date().toISOString()
  };
  const createDepth = await createGate(depthGateId, depthPassport, "x402_gate_create_auth_lineage_depth_1");
  assert.equal(createDepth.statusCode, 201, createDepth.body);
  const depthDecision = await issueWalletAuthorizationDecision(api, {
    sponsorWalletRef,
    gateId: depthGateId,
    idempotencyKey: "x402_wallet_issuer_lineage_depth_1"
  });
  assert.equal(depthDecision.statusCode, 409, depthDecision.body);
  assert.equal(depthDecision.json?.code, "X402_DELEGATION_DEPTH_EXCEEDED");
});
