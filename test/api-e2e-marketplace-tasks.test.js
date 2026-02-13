import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem, sha256Hex, signHashHexEd25519 } from "../src/core/crypto.js";
import { canonicalJsonStringify, normalizeForCanonicalJson } from "../src/core/canonical-json.js";
import {
  computeSettlementPolicyHash,
  computeVerificationMethodHash,
  normalizeSettlementPolicy,
  normalizeVerificationMethod
} from "../src/core/settlement-policy.js";
import { SETTLEMENT_VERIFIER_SOURCE } from "../src/core/settlement-verifier.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, agentId, { publicKeyPem: providedPublicKeyPem = null } = {}) {
  const publicKeyPem = providedPublicKeyPem ?? createEd25519Keypair().publicKeyPem;
  const created = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `register_${agentId}` },
    body: {
      agentId,
      displayName: agentId,
      owner: { ownerType: "service", ownerId: "svc_market" },
      publicKeyPem,
      capabilities: ["translate", "summarize"]
    }
  });
  assert.equal(created.statusCode, 201);
  return {
    keyId: created.json?.keyId ?? keyIdFromPublicKeyPem(publicKeyPem),
    publicKeyPem
  };
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

function buildDelegationLink({
  tenantId,
  delegationId,
  principalAgentId,
  delegateAgentId,
  scope = null,
  issuedAt,
  expiresAt = null,
  signerKeyId,
  signerPrivateKeyPem
}) {
  const core = normalizeForCanonicalJson(
    {
      schemaVersion: "AgentDelegationLink.v1",
      delegationId,
      tenantId,
      principalAgentId,
      delegateAgentId,
      scope,
      issuedAt,
      expiresAt
    },
    { path: "$" }
  );
  const delegationHash = sha256Hex(canonicalJsonStringify(core));
  const signature = signHashHexEd25519(delegationHash, signerPrivateKeyPem);
  return normalizeForCanonicalJson(
    {
      ...core,
      signerKeyId,
      delegationHash,
      signature
    },
    { path: "$" }
  );
}

function buildActingOnBehalfOf({ principalAgentId, delegateAgentId, delegationChain }) {
  const normalizedChain = normalizeForCanonicalJson(delegationChain, { path: "$" });
  return normalizeForCanonicalJson(
    {
      schemaVersion: "AgentActingOnBehalfOf.v1",
      principalAgentId,
      delegateAgentId,
      delegationChain: normalizedChain,
      chainHash: sha256Hex(canonicalJsonStringify(normalizedChain))
    },
    { path: "$" }
  );
}

test("API e2e: marketplace rfq -> bids -> accept flow", async () => {
  const api = createApi();

  await registerAgent(api, "agt_market_poster");
  await registerAgent(api, "agt_market_bidder_a");
  await registerAgent(api, "agt_market_bidder_b");
  await registerAgent(api, "agt_market_operator");
  await creditWallet(api, {
    agentId: "agt_market_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_market_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_rfq_create_1" },
    body: {
      rfqId: "rfq_translate_1",
      title: "Translate release notes",
      capability: "translate",
      posterAgentId: "agt_market_poster",
      budgetCents: 2500,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);
  assert.equal(createTask.json?.rfq?.rfqId, "rfq_translate_1");
  assert.equal(createTask.json?.rfq?.status, "open");
  assert.equal(createTask.json?.rfq?.fromType, "agent");
  assert.equal(createTask.json?.rfq?.toType, "agent");

  const replayTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_rfq_create_1" },
    body: {
      rfqId: "rfq_translate_1",
      title: "Translate release notes",
      capability: "translate",
      posterAgentId: "agt_market_poster",
      budgetCents: 2500,
      currency: "USD"
    }
  });
  assert.equal(replayTask.statusCode, 201);
  assert.equal(replayTask.json?.rfq?.rfqId, "rfq_translate_1");

  const bidA = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_translate_1/bids",
    headers: { "x-idempotency-key": "market_bid_create_a" },
    body: {
      bidId: "bid_translate_a",
      bidderAgentId: "agt_market_bidder_a",
      amountCents: 2200,
      currency: "USD",
      etaSeconds: 1800
    }
  });
  assert.equal(bidA.statusCode, 201);
  assert.equal(bidA.json?.bid?.status, "pending");
  assert.equal(bidA.json?.bid?.fromType, "agent");
  assert.equal(bidA.json?.bid?.toType, "agent");

  const bidB = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_translate_1/bids",
    headers: { "x-idempotency-key": "market_bid_create_b" },
    body: {
      bidId: "bid_translate_b",
      bidderAgentId: "agt_market_bidder_b",
      amountCents: 1900,
      currency: "USD",
      etaSeconds: 2400
    }
  });
  assert.equal(bidB.statusCode, 201);
  assert.equal(bidB.json?.bid?.status, "pending");
  assert.equal(bidB.json?.bid?.fromType, "agent");
  assert.equal(bidB.json?.bid?.toType, "agent");

  const listTasks = await request(api, {
    method: "GET",
    path: "/marketplace/rfqs?status=open&capability=translate&posterAgentId=agt_market_poster&limit=10&offset=0"
  });
  assert.equal(listTasks.statusCode, 200);
  assert.equal(listTasks.json?.total, 1);
  assert.equal(listTasks.json?.rfqs?.[0]?.rfqId, "rfq_translate_1");

  const listBids = await request(api, {
    method: "GET",
    path: "/marketplace/rfqs/rfq_translate_1/bids?status=all&limit=10&offset=0"
  });
  assert.equal(listBids.statusCode, 200);
  assert.equal(listBids.json?.total, 2);
  assert.equal(listBids.json?.bids?.[0]?.bidId, "bid_translate_b");

  const acceptBid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_translate_1/accept",
    headers: { "x-idempotency-key": "market_accept_1" },
    body: {
      bidId: "bid_translate_b",
      acceptedByAgentId: "agt_market_operator"
    }
  });
  assert.equal(acceptBid.statusCode, 200);
  assert.equal(acceptBid.json?.rfq?.status, "assigned");
  assert.equal(acceptBid.json?.rfq?.acceptedBidId, "bid_translate_b");
  assert.equal(acceptBid.json?.acceptedBid?.status, "accepted");
  assert.equal(acceptBid.json?.run?.status, "created");
  assert.equal(acceptBid.json?.run?.agentId, "agt_market_bidder_b");
  assert.equal(acceptBid.json?.settlement?.status, "locked");
  assert.equal(acceptBid.json?.settlement?.amountCents, 1900);
  assert.equal(acceptBid.json?.agreement?.bidId, "bid_translate_b");
  assert.equal(acceptBid.json?.agreement?.payerAgentId, "agt_market_poster");
  assert.equal(acceptBid.json?.agreement?.fromType, "agent");
  assert.equal(acceptBid.json?.agreement?.toType, "agent");
  assert.equal(acceptBid.json?.rfq?.runId, acceptBid.json?.run?.runId);

  const settlement = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(acceptBid.json?.run?.runId ?? "")}/settlement`
  });
  assert.equal(settlement.statusCode, 200);
  assert.equal(settlement.json?.settlement?.status, "locked");

  const payerWalletAfterAccept = await request(api, {
    method: "GET",
    path: "/agents/agt_market_poster/wallet"
  });
  assert.equal(payerWalletAfterAccept.statusCode, 200);
  assert.equal(payerWalletAfterAccept.json?.wallet?.availableCents, 3100);
  assert.equal(payerWalletAfterAccept.json?.wallet?.escrowLockedCents, 1900);

  const listAccepted = await request(api, {
    method: "GET",
    path: "/marketplace/rfqs/rfq_translate_1/bids?status=accepted"
  });
  assert.equal(listAccepted.statusCode, 200);
  assert.equal(listAccepted.json?.total, 1);
  assert.equal(listAccepted.json?.bids?.[0]?.bidId, "bid_translate_b");

  const listRejected = await request(api, {
    method: "GET",
    path: "/marketplace/rfqs/rfq_translate_1/bids?status=rejected"
  });
  assert.equal(listRejected.statusCode, 200);
  assert.equal(listRejected.json?.total, 1);
  assert.equal(listRejected.json?.bids?.[0]?.bidId, "bid_translate_a");

  const bidAfterAccept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_translate_1/bids",
    body: {
      bidderAgentId: "agt_market_bidder_a",
      amountCents: 1700,
      currency: "USD"
    }
  });
  assert.equal(bidAfterAccept.statusCode, 409);
});

test("API e2e: marketplace rfq create rejects legacy taskId field", async () => {
  const api = createApi();
  const response = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_rfq_reject_legacy_task_id" },
    body: {
      taskId: "task_legacy_1",
      title: "Legacy payload",
      capability: "translate"
    }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json?.error, "unsupported identifier field; use rfqId");
});

test("API e2e: marketplace rfq/bid validation rejects unknown agents", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_known");

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    body: {
      title: "Needs poster",
      capability: "translate",
      posterAgentId: "agt_missing"
    }
  });
  assert.equal(createTask.statusCode, 404);

  const createTaskKnown = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    body: {
      rfqId: "rfq_known_1",
      title: "Known poster",
      capability: "translate",
      posterAgentId: "agt_market_known"
    }
  });
  assert.equal(createTaskKnown.statusCode, 201);

  const bidUnknown = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_known_1/bids",
    body: {
      bidderAgentId: "agt_missing_bidder",
      amountCents: 1000
    }
  });
  assert.equal(bidUnknown.statusCode, 404);

  const invalidDirection = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    body: {
      title: "Invalid direction task",
      capability: "translate",
      posterAgentId: "agt_market_known",
      fromType: "vendor",
      toType: "agent"
    }
  });
  assert.equal(invalidDirection.statusCode, 400);

  const mismatchDirectionBid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_known_1/bids",
    body: {
      bidderAgentId: "agt_market_known",
      amountCents: 1000,
      fromType: "robot",
      toType: "human"
    }
  });
  assert.equal(mismatchDirectionBid.statusCode, 409);

  const validBid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_known_1/bids",
    body: {
      bidId: "bid_known_1",
      bidderAgentId: "agt_market_known",
      amountCents: 900
    }
  });
  assert.equal(validBid.statusCode, 201);

  const mismatchDirectionAccept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_known_1/accept",
    body: {
      bidId: "bid_known_1",
      fromType: "robot",
      toType: "machine"
    }
  });
  assert.equal(mismatchDirectionAccept.statusCode, 409);
});

test("API e2e: marketplace settlement supports dispute open/close within window", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_dispute_poster");
  await registerAgent(api, "agt_market_dispute_bidder");
  const arbiterKeypair = createEd25519Keypair();
  const arbiterRegistration = await registerAgent(api, "agt_market_dispute_operator", { publicKeyPem: arbiterKeypair.publicKeyPem });
  await creditWallet(api, {
    agentId: "agt_market_dispute_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_market_dispute_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_dispute_rfq_create_1" },
    body: {
      rfqId: "rfq_dispute_1",
      title: "Dispute-capable task",
      capability: "translate",
      posterAgentId: "agt_market_dispute_poster",
      budgetCents: 2000,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_dispute_1/bids",
    headers: { "x-idempotency-key": "market_dispute_bid_create_1" },
    body: {
      bidId: "bid_dispute_1",
      bidderAgentId: "agt_market_dispute_bidder",
      amountCents: 1800,
      currency: "USD",
      etaSeconds: 900
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_dispute_1/accept",
    headers: { "x-idempotency-key": "market_dispute_accept_1" },
    body: {
      bidId: "bid_dispute_1",
      acceptedByAgentId: "agt_market_dispute_operator",
      disputeWindowDays: 2
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/agt_market_dispute_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_dispute_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(complete.statusCode, 201);
  assert.equal(complete.json?.settlement?.status, "released");
  assert.equal(complete.json?.settlement?.disputeWindowDays, 2);

  const openDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: { "x-idempotency-key": "market_dispute_open_1" },
    body: {
      disputeId: "dsp_market_1",
      disputeType: "quality",
      disputePriority: "high",
      disputeChannel: "counterparty",
      escalationLevel: "l1_counterparty",
      openedByAgentId: "agt_market_dispute_operator",
      reason: "buyer flagged quality mismatch",
      evidenceRefs: [`evidence://${runId}/output.json`]
    }
  });
  assert.equal(openDispute.statusCode, 200);
  assert.equal(openDispute.json?.settlement?.disputeStatus, "open");
  assert.equal(openDispute.json?.settlement?.disputeId, "dsp_market_1");
  assert.equal(openDispute.json?.settlement?.disputeContext?.type, "quality");
  assert.equal(openDispute.json?.settlement?.disputeContext?.priority, "high");
  assert.equal(openDispute.json?.settlement?.disputeContext?.openedByAgentId, "agt_market_dispute_operator");
  assert.equal(openDispute.json?.settlement?.disputeContext?.reason, "buyer flagged quality mismatch");
  assert.equal(openDispute.json?.settlement?.disputeContext?.evidenceRefs?.[0], `evidence://${runId}/output.json`);

  const verdictIssuedAt = "2026-02-06T00:00:00.000Z";
  const verdictCore = normalizeForCanonicalJson(
    {
      schemaVersion: "DisputeVerdict.v1",
      verdictId: "vrd_market_1",
      tenantId: "tenant_default",
      runId,
      settlementId: complete.json?.settlement?.settlementId,
      disputeId: "dsp_market_1",
      arbiterAgentId: "agt_market_dispute_operator",
      outcome: "accepted",
      releaseRatePct: 100,
      rationale: "manual review complete",
      issuedAt: verdictIssuedAt
    },
    { path: "$" }
  );
  const verdictHash = sha256Hex(canonicalJsonStringify(verdictCore));
  const verdictSignature = signHashHexEd25519(verdictHash, arbiterKeypair.privateKeyPem);
  const arbitrationVerdictCore = normalizeForCanonicalJson(
    {
      schemaVersion: "ArbitrationVerdict.v1",
      verdictId: "arb_vrd_market_1",
      caseId: "arb_case_market_1",
      tenantId: "tenant_default",
      runId,
      settlementId: complete.json?.settlement?.settlementId,
      disputeId: "dsp_market_1",
      arbiterAgentId: "agt_market_dispute_operator",
      outcome: "accepted",
      releaseRatePct: 100,
      rationale: "manual review complete",
      evidenceRefs: [`evidence://${runId}/output.json`],
      issuedAt: verdictIssuedAt,
      appealRef: null
    },
    { path: "$" }
  );
  const arbitrationVerdictHash = sha256Hex(canonicalJsonStringify(arbitrationVerdictCore));
  const arbitrationVerdictSignature = signHashHexEd25519(arbitrationVerdictHash, arbiterKeypair.privateKeyPem);

  const closeDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/close`,
    headers: { "x-idempotency-key": "market_dispute_close_1" },
    body: {
      disputeId: "dsp_market_1",
      resolution: {
        outcome: "accepted",
        escalationLevel: "l2_arbiter",
        closedByAgentId: "agt_market_dispute_operator",
        summary: "manual review complete",
        evidenceRefs: [`evidence://${runId}/output.json`]
      },
      verdict: {
        verdictId: "vrd_market_1",
        arbiterAgentId: "agt_market_dispute_operator",
        outcome: "accepted",
        releaseRatePct: 100,
        rationale: "manual review complete",
        issuedAt: verdictIssuedAt,
        signerKeyId: arbiterRegistration.keyId,
        signature: verdictSignature
      },
      arbitrationVerdict: {
        caseId: "arb_case_market_1",
        verdictId: "arb_vrd_market_1",
        arbiterAgentId: "agt_market_dispute_operator",
        outcome: "accepted",
        releaseRatePct: 100,
        rationale: "manual review complete",
        evidenceRefs: [`evidence://${runId}/output.json`],
        issuedAt: verdictIssuedAt,
        signerKeyId: arbiterRegistration.keyId,
        signature: arbitrationVerdictSignature
      }
    }
  });
  assert.equal(closeDispute.statusCode, 200);
  assert.equal(closeDispute.json?.settlement?.disputeStatus, "closed");
  assert.ok(closeDispute.json?.settlement?.disputeClosedAt);
  assert.equal(closeDispute.json?.settlement?.disputeResolution?.outcome, "accepted");
  assert.equal(closeDispute.json?.settlement?.disputeResolution?.escalationLevel, "l2_arbiter");
  assert.equal(closeDispute.json?.settlement?.disputeResolution?.closedByAgentId, "agt_market_dispute_operator");
  assert.equal(closeDispute.json?.settlement?.disputeResolution?.summary, "manual review complete");
  assert.equal(closeDispute.json?.settlement?.disputeVerdictId, "vrd_market_1");
  assert.equal(closeDispute.json?.settlement?.disputeVerdictHash, verdictHash);
  assert.equal(closeDispute.json?.verdict?.verdictHash, verdictHash);
  assert.equal(closeDispute.json?.verdictArtifact?.artifactId, "dispute_verdict_vrd_market_1");
  assert.equal(closeDispute.json?.arbitrationVerdict?.caseId, "arb_case_market_1");
  assert.equal(closeDispute.json?.arbitrationVerdict?.verdictId, "arb_vrd_market_1");
  assert.equal(closeDispute.json?.arbitrationVerdict?.verdictHash, arbitrationVerdictHash);
  assert.equal(closeDispute.json?.arbitrationCaseArtifact?.artifactId, "arbitration_case_arb_case_market_1");
  assert.equal(closeDispute.json?.arbitrationVerdictArtifact?.artifactId, "arbitration_verdict_arb_vrd_market_1");
});

test("API e2e: dispute evidence submissions and escalation transitions are persisted", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_dispute_ctx_poster");
  await registerAgent(api, "agt_market_dispute_ctx_bidder");
  await registerAgent(api, "agt_market_dispute_ctx_operator");
  await creditWallet(api, {
    agentId: "agt_market_dispute_ctx_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_market_dispute_ctx_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_dispute_ctx_rfq_create_1" },
    body: {
      rfqId: "rfq_dispute_ctx_1",
      title: "Dispute context task",
      capability: "translate",
      posterAgentId: "agt_market_dispute_ctx_poster",
      budgetCents: 2000,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_dispute_ctx_1/bids",
    headers: { "x-idempotency-key": "market_dispute_ctx_bid_create_1" },
    body: {
      bidId: "bid_dispute_ctx_1",
      bidderAgentId: "agt_market_dispute_ctx_bidder",
      amountCents: 1750,
      currency: "USD",
      etaSeconds: 600
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_dispute_ctx_1/accept",
    headers: { "x-idempotency-key": "market_dispute_ctx_accept_1" },
    body: {
      bidId: "bid_dispute_ctx_1",
      acceptedByAgentId: "agt_market_dispute_ctx_operator",
      disputeWindowDays: 2
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/agt_market_dispute_ctx_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_dispute_ctx_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(complete.statusCode, 201);
  assert.equal(complete.json?.settlement?.status, "released");

  const openDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: { "x-idempotency-key": "market_dispute_ctx_open_1" },
    body: {
      disputeId: "dsp_market_ctx_1",
      disputeType: "quality",
      disputePriority: "normal",
      disputeChannel: "counterparty",
      escalationLevel: "l1_counterparty",
      openedByAgentId: "agt_market_dispute_ctx_operator",
      reason: "initial quality concern"
    }
  });
  assert.equal(openDispute.statusCode, 200);
  assert.equal(openDispute.json?.settlement?.disputeStatus, "open");
  assert.equal(openDispute.json?.settlement?.disputeContext?.escalationLevel, "l1_counterparty");

  const submitEvidence = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/evidence`,
    headers: { "x-idempotency-key": "market_dispute_ctx_evidence_1" },
    body: {
      disputeId: "dsp_market_ctx_1",
      evidenceRef: `evidence://${runId}/counterparty-note.json`,
      submittedByAgentId: "agt_market_dispute_ctx_operator",
      reason: "counterparty attached supporting evidence"
    }
  });
  assert.equal(submitEvidence.statusCode, 200);
  assert.equal(submitEvidence.json?.disputeEvidence?.evidenceRef, `evidence://${runId}/counterparty-note.json`);
  assert.equal(submitEvidence.json?.settlement?.disputeContext?.evidenceRefs?.includes(`evidence://${runId}/counterparty-note.json`), true);

  const escalate = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/escalate`,
    headers: { "x-idempotency-key": "market_dispute_ctx_escalate_1" },
    body: {
      disputeId: "dsp_market_ctx_1",
      escalationLevel: "l2_arbiter",
      escalatedByAgentId: "agt_market_dispute_ctx_operator",
      reason: "counterparty review incomplete"
    }
  });
  assert.equal(escalate.statusCode, 200);
  assert.equal(escalate.json?.disputeEscalation?.previousEscalationLevel, "l1_counterparty");
  assert.equal(escalate.json?.disputeEscalation?.escalationLevel, "l2_arbiter");
  assert.equal(escalate.json?.settlement?.disputeContext?.escalationLevel, "l2_arbiter");

  const downgradeEscalation = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/escalate`,
    headers: { "x-idempotency-key": "market_dispute_ctx_escalate_2" },
    body: {
      disputeId: "dsp_market_ctx_1",
      escalationLevel: "l1_counterparty"
    }
  });
  assert.equal(downgradeEscalation.statusCode, 409);

  const closeDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/close`,
    headers: { "x-idempotency-key": "market_dispute_ctx_close_1" },
    body: {
      disputeId: "dsp_market_ctx_1",
      resolutionOutcome: "partial",
      resolutionEscalationLevel: "l2_arbiter",
      resolutionSummary: "partial adjustment accepted",
      closedByAgentId: "agt_market_dispute_ctx_operator",
      resolutionEvidenceRefs: [`evidence://${runId}/counterparty-note.json`]
    }
  });
  assert.equal(closeDispute.statusCode, 200);
  assert.equal(closeDispute.json?.settlement?.disputeStatus, "closed");
  assert.equal(closeDispute.json?.settlement?.disputeResolution?.outcome, "partial");
  assert.equal(closeDispute.json?.settlement?.disputeResolution?.escalationLevel, "l2_arbiter");
  assert.equal(closeDispute.json?.settlement?.disputeResolution?.closedByAgentId, "agt_market_dispute_ctx_operator");
});

test("API e2e: dispute close rejects arbitration verdict evidence outside dispute context", async () => {
  const api = createApi();
  const arbiterKeypair = createEd25519Keypair();
  const arbiterRegistration = await registerAgent(api, "agt_market_arb_bind_operator", {
    publicKeyPem: arbiterKeypair.publicKeyPem
  });
  await registerAgent(api, "agt_market_arb_bind_poster");
  await registerAgent(api, "agt_market_arb_bind_bidder");
  await creditWallet(api, {
    agentId: "agt_market_arb_bind_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_market_arb_bind_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_arb_bind_rfq_create_1" },
    body: {
      rfqId: "rfq_arb_bind_1",
      title: "Arbitration evidence binding task",
      capability: "translate",
      posterAgentId: "agt_market_arb_bind_poster",
      budgetCents: 2100,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_arb_bind_1/bids",
    headers: { "x-idempotency-key": "market_arb_bind_bid_create_1" },
    body: {
      bidId: "bid_arb_bind_1",
      bidderAgentId: "agt_market_arb_bind_bidder",
      amountCents: 1750,
      currency: "USD",
      etaSeconds: 600
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_arb_bind_1/accept",
    headers: { "x-idempotency-key": "market_arb_bind_accept_1" },
    body: {
      bidId: "bid_arb_bind_1",
      acceptedByAgentId: "agt_market_arb_bind_operator",
      disputeWindowDays: 2
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/agt_market_arb_bind_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_arb_bind_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(complete.statusCode, 201);

  const openDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: { "x-idempotency-key": "market_arb_bind_open_1" },
    body: {
      disputeId: "dsp_arb_bind_1",
      disputeType: "quality",
      disputePriority: "high",
      disputeChannel: "counterparty",
      escalationLevel: "l1_counterparty",
      openedByAgentId: "agt_market_arb_bind_operator",
      reason: "quality mismatch",
      evidenceRefs: [`evidence://${runId}/output.json`]
    }
  });
  assert.equal(openDispute.statusCode, 200);

  const verdictIssuedAt = "2026-02-06T00:00:00.000Z";
  const arbitrationVerdictCore = normalizeForCanonicalJson(
    {
      schemaVersion: "ArbitrationVerdict.v1",
      verdictId: "arb_vrd_bind_1",
      caseId: "arb_case_bind_1",
      tenantId: "tenant_default",
      runId,
      settlementId: complete.json?.settlement?.settlementId,
      disputeId: "dsp_arb_bind_1",
      arbiterAgentId: "agt_market_arb_bind_operator",
      outcome: "accepted",
      releaseRatePct: 100,
      rationale: "bound evidence check",
      evidenceRefs: [`evidence://${runId}/not-in-context.json`],
      issuedAt: verdictIssuedAt,
      appealRef: null
    },
    { path: "$" }
  );
  const arbitrationVerdictHash = sha256Hex(canonicalJsonStringify(arbitrationVerdictCore));
  const arbitrationVerdictSignature = signHashHexEd25519(arbitrationVerdictHash, arbiterKeypair.privateKeyPem);

  const closeDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/close`,
    headers: { "x-idempotency-key": "market_arb_bind_close_1" },
    body: {
      disputeId: "dsp_arb_bind_1",
      resolutionOutcome: "accepted",
      resolutionEscalationLevel: "l2_arbiter",
      resolutionSummary: "should be rejected by evidence binding",
      closedByAgentId: "agt_market_arb_bind_operator",
      arbitrationVerdict: {
        caseId: "arb_case_bind_1",
        verdictId: "arb_vrd_bind_1",
        arbiterAgentId: "agt_market_arb_bind_operator",
        outcome: "accepted",
        releaseRatePct: 100,
        rationale: "bound evidence check",
        evidenceRefs: [`evidence://${runId}/not-in-context.json`],
        issuedAt: verdictIssuedAt,
        signerKeyId: arbiterRegistration.keyId,
        signature: arbitrationVerdictSignature
      }
    }
  });
  assert.equal(closeDispute.statusCode, 400);
  assert.equal(closeDispute.json?.error, "invalid arbitration verdict");
  assert.match(String(closeDispute.json?.details?.message ?? ""), /subset of settlement\.disputeContext\.evidenceRefs/i);
});

test("API e2e: dispute close rejects verdicts with invalid arbiter signature", async () => {
  const api = createApi();
  const arbiterKeypair = createEd25519Keypair();
  const invalidSigner = createEd25519Keypair();

  await registerAgent(api, "agt_market_dispute_sig_poster");
  await registerAgent(api, "agt_market_dispute_sig_bidder");
  const arbiterRegistration = await registerAgent(api, "agt_market_dispute_sig_operator", {
    publicKeyPem: arbiterKeypair.publicKeyPem
  });
  await creditWallet(api, {
    agentId: "agt_market_dispute_sig_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_market_dispute_sig_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_dispute_sig_rfq_create_1" },
    body: {
      rfqId: "rfq_dispute_sig_1",
      title: "Dispute signature task",
      capability: "translate",
      posterAgentId: "agt_market_dispute_sig_poster",
      budgetCents: 2200,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_dispute_sig_1/bids",
    headers: { "x-idempotency-key": "market_dispute_sig_bid_create_1" },
    body: {
      bidId: "bid_dispute_sig_1",
      bidderAgentId: "agt_market_dispute_sig_bidder",
      amountCents: 1800,
      currency: "USD",
      etaSeconds: 900
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_dispute_sig_1/accept",
    headers: { "x-idempotency-key": "market_dispute_sig_accept_1" },
    body: {
      bidId: "bid_dispute_sig_1",
      acceptedByAgentId: "agt_market_dispute_sig_operator",
      disputeWindowDays: 2
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/agt_market_dispute_sig_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_dispute_sig_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(complete.statusCode, 201);

  const openDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: { "x-idempotency-key": "market_dispute_sig_open_1" },
    body: {
      disputeId: "dsp_market_sig_1",
      disputeType: "quality",
      disputePriority: "high",
      disputeChannel: "counterparty",
      escalationLevel: "l1_counterparty",
      openedByAgentId: "agt_market_dispute_sig_operator",
      reason: "quality mismatch",
      evidenceRefs: [`evidence://${runId}/output.json`]
    }
  });
  assert.equal(openDispute.statusCode, 200);

  const verdictIssuedAt = "2026-02-06T00:00:00.000Z";
  const verdictCore = normalizeForCanonicalJson(
    {
      schemaVersion: "DisputeVerdict.v1",
      verdictId: "vrd_market_sig_1",
      tenantId: "tenant_default",
      runId,
      settlementId: complete.json?.settlement?.settlementId,
      disputeId: "dsp_market_sig_1",
      arbiterAgentId: "agt_market_dispute_sig_operator",
      outcome: "accepted",
      releaseRatePct: 100,
      rationale: "manual review complete",
      issuedAt: verdictIssuedAt
    },
    { path: "$" }
  );
  const verdictHash = sha256Hex(canonicalJsonStringify(verdictCore));

  const closeDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/close`,
    headers: { "x-idempotency-key": "market_dispute_sig_close_1" },
    body: {
      disputeId: "dsp_market_sig_1",
      resolution: {
        outcome: "accepted",
        escalationLevel: "l2_arbiter",
        closedByAgentId: "agt_market_dispute_sig_operator",
        summary: "manual review complete",
        evidenceRefs: [`evidence://${runId}/output.json`]
      },
      verdict: {
        verdictId: "vrd_market_sig_1",
        arbiterAgentId: "agt_market_dispute_sig_operator",
        outcome: "accepted",
        releaseRatePct: 100,
        rationale: "manual review complete",
        issuedAt: verdictIssuedAt,
        signerKeyId: arbiterRegistration.keyId,
        signature: signHashHexEd25519(verdictHash, invalidSigner.privateKeyPem)
      }
    }
  });
  assert.equal(closeDispute.statusCode, 400);
  assert.equal(closeDispute.json?.error, "invalid dispute verdict");
  assert.match(String(closeDispute.json?.details?.message ?? ""), /invalid verdict signature/i);
});

test("API e2e: appeal window enforcement rejects late signed verdicts but allows administrative close", async () => {
  let nowMs = Date.parse("2026-02-01T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });
  const arbiterKeypair = createEd25519Keypair();
  const arbiterRegistration = await registerAgent(api, "agt_market_dispute_window_operator", {
    publicKeyPem: arbiterKeypair.publicKeyPem
  });

  await registerAgent(api, "agt_market_dispute_window_poster");
  await registerAgent(api, "agt_market_dispute_window_bidder");
  await creditWallet(api, {
    agentId: "agt_market_dispute_window_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_market_dispute_window_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_dispute_window_rfq_create_1" },
    body: {
      rfqId: "rfq_dispute_window_1",
      title: "Appeal window task",
      capability: "translate",
      posterAgentId: "agt_market_dispute_window_poster",
      budgetCents: 2100,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_dispute_window_1/bids",
    headers: { "x-idempotency-key": "market_dispute_window_bid_create_1" },
    body: {
      bidId: "bid_dispute_window_1",
      bidderAgentId: "agt_market_dispute_window_bidder",
      amountCents: 1700,
      currency: "USD",
      etaSeconds: 900
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_dispute_window_1/accept",
    headers: { "x-idempotency-key": "market_dispute_window_accept_1" },
    body: {
      bidId: "bid_dispute_window_1",
      acceptedByAgentId: "agt_market_dispute_window_operator",
      disputeWindowDays: 1
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/agt_market_dispute_window_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_dispute_window_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(complete.statusCode, 201);

  const openDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: { "x-idempotency-key": "market_dispute_window_open_1" },
    body: {
      disputeId: "dsp_market_window_1",
      disputeType: "quality",
      disputePriority: "normal",
      disputeChannel: "counterparty",
      escalationLevel: "l1_counterparty",
      openedByAgentId: "agt_market_dispute_window_operator",
      reason: "needs appeal review"
    }
  });
  assert.equal(openDispute.statusCode, 200);
  assert.equal(openDispute.json?.settlement?.disputeStatus, "open");

  nowMs += 2 * 24 * 60 * 60_000;
  const verdictIssuedAt = new Date(nowMs).toISOString();
  const verdictCore = normalizeForCanonicalJson(
    {
      schemaVersion: "DisputeVerdict.v1",
      verdictId: "vrd_market_window_1",
      tenantId: "tenant_default",
      runId,
      settlementId: complete.json?.settlement?.settlementId,
      disputeId: "dsp_market_window_1",
      arbiterAgentId: "agt_market_dispute_window_operator",
      outcome: "accepted",
      releaseRatePct: 100,
      rationale: "appeal reviewed",
      issuedAt: verdictIssuedAt
    },
    { path: "$" }
  );
  const verdictHash = sha256Hex(canonicalJsonStringify(verdictCore));
  const verdictSignature = signHashHexEd25519(verdictHash, arbiterKeypair.privateKeyPem);

  const lateCloseWithVerdict = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/close`,
    headers: { "x-idempotency-key": "market_dispute_window_close_1" },
    body: {
      disputeId: "dsp_market_window_1",
      resolutionOutcome: "accepted",
      resolutionEscalationLevel: "l2_arbiter",
      resolutionSummary: "late verdict should be rejected",
      closedByAgentId: "agt_market_dispute_window_operator",
      verdict: {
        verdictId: "vrd_market_window_1",
        arbiterAgentId: "agt_market_dispute_window_operator",
        outcome: "accepted",
        releaseRatePct: 100,
        rationale: "appeal reviewed",
        issuedAt: verdictIssuedAt,
        signerKeyId: arbiterRegistration.keyId,
        signature: verdictSignature
      }
    }
  });
  assert.equal(lateCloseWithVerdict.statusCode, 409);
  assert.match(String(lateCloseWithVerdict.json?.error ?? ""), /appeal window has closed/i);

  const lateAdministrativeClose = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/close`,
    headers: { "x-idempotency-key": "market_dispute_window_close_2" },
    body: {
      disputeId: "dsp_market_window_1",
      resolutionOutcome: "accepted",
      resolutionEscalationLevel: "l2_arbiter",
      resolutionSummary: "administrative close after window",
      closedByAgentId: "agt_market_dispute_window_operator"
    }
  });
  assert.equal(lateAdministrativeClose.statusCode, 200);
  assert.equal(lateAdministrativeClose.json?.settlement?.disputeStatus, "closed");
  assert.equal(lateAdministrativeClose.json?.settlement?.disputeVerdictId, null);
});

test("API e2e: arbitration case lifecycle supports deterministic assignment, signed verdict, close, and appeal window enforcement", async () => {
  let nowMs = Date.parse("2026-02-01T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });
  const arbiterAKeypair = createEd25519Keypair();
  const arbiterBKeypair = createEd25519Keypair();

  await registerAgent(api, "agt_market_arb_lifecycle_poster");
  await registerAgent(api, "agt_market_arb_lifecycle_bidder");
  await registerAgent(api, "agt_market_arb_lifecycle_operator");
  const arbiterARegistration = await registerAgent(api, "agt_market_arbiter_a", { publicKeyPem: arbiterAKeypair.publicKeyPem });
  const arbiterBRegistration = await registerAgent(api, "agt_market_arbiter_b", { publicKeyPem: arbiterBKeypair.publicKeyPem });

  await creditWallet(api, {
    agentId: "agt_market_arb_lifecycle_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_market_arb_lifecycle_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_arb_lifecycle_rfq_create_1" },
    body: {
      rfqId: "rfq_arb_lifecycle_1",
      title: "Arbitration lifecycle task",
      capability: "translate",
      posterAgentId: "agt_market_arb_lifecycle_poster",
      budgetCents: 2200,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_arb_lifecycle_1/bids",
    headers: { "x-idempotency-key": "market_arb_lifecycle_bid_create_1" },
    body: {
      bidId: "bid_arb_lifecycle_1",
      bidderAgentId: "agt_market_arb_lifecycle_bidder",
      amountCents: 1800,
      currency: "USD",
      etaSeconds: 900
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_arb_lifecycle_1/accept",
    headers: { "x-idempotency-key": "market_arb_lifecycle_accept_1" },
    body: {
      bidId: "bid_arb_lifecycle_1",
      acceptedByAgentId: "agt_market_arb_lifecycle_operator",
      disputeWindowDays: 2
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/agt_market_arb_lifecycle_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_arb_lifecycle_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(complete.statusCode, 201);

  const openDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: { "x-idempotency-key": "market_arb_lifecycle_dispute_open_1" },
    body: {
      disputeId: "dsp_arb_lifecycle_1",
      disputeType: "quality",
      disputePriority: "high",
      disputeChannel: "arbiter",
      escalationLevel: "l2_arbiter",
      openedByAgentId: "agt_market_arb_lifecycle_operator",
      reason: "requires formal arbitration",
      evidenceRefs: [`evidence://${runId}/output.json`]
    }
  });
  assert.equal(openDispute.statusCode, 200);
  assert.equal(openDispute.json?.settlement?.disputeStatus, "open");

  const panelCandidates = ["agt_market_arbiter_b", "agt_market_arbiter_a"];
  const sortedPanelCandidates = [...panelCandidates].sort();
  const assignmentSeed = normalizeForCanonicalJson(
    {
      tenantId: "tenant_default",
      runId,
      disputeId: "dsp_arb_lifecycle_1",
      panelCandidateAgentIds: sortedPanelCandidates
    },
    { path: "$" }
  );
  const assignmentHash = sha256Hex(canonicalJsonStringify(assignmentSeed));
  const expectedArbiter = sortedPanelCandidates[Number.parseInt(assignmentHash.slice(0, 8), 16) % sortedPanelCandidates.length];

  const openArbitration = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/open`,
    headers: { "x-idempotency-key": "market_arb_lifecycle_open_1" },
    body: {
      caseId: "arb_case_lifecycle_1",
      disputeId: "dsp_arb_lifecycle_1",
      panelCandidateAgentIds: panelCandidates,
      evidenceRefs: [`evidence://${runId}/output.json`]
    }
  });
  assert.equal(openArbitration.statusCode, 201);
  assert.equal(openArbitration.json?.arbitrationCase?.status, "under_review");
  assert.equal(openArbitration.json?.arbitrationCase?.arbiterAgentId, expectedArbiter);
  assert.equal(openArbitration.json?.arbitrationCase?.metadata?.assignmentHash, assignmentHash);

  const selectedArbiterKeypair = expectedArbiter === "agt_market_arbiter_a" ? arbiterAKeypair : arbiterBKeypair;
  const selectedArbiterRegistration = expectedArbiter === "agt_market_arbiter_a" ? arbiterARegistration : arbiterBRegistration;
  const verdictIssuedAt = new Date(nowMs).toISOString();
  const arbitrationVerdictCore = normalizeForCanonicalJson(
    {
      schemaVersion: "ArbitrationVerdict.v1",
      verdictId: "arb_vrd_lifecycle_1",
      caseId: "arb_case_lifecycle_1",
      tenantId: "tenant_default",
      runId,
      settlementId: complete.json?.settlement?.settlementId,
      disputeId: "dsp_arb_lifecycle_1",
      arbiterAgentId: expectedArbiter,
      outcome: "accepted",
      releaseRatePct: 100,
      rationale: "verified arbitration outcome",
      evidenceRefs: [`evidence://${runId}/output.json`],
      issuedAt: verdictIssuedAt,
      appealRef: null
    },
    { path: "$" }
  );
  const arbitrationVerdictHash = sha256Hex(canonicalJsonStringify(arbitrationVerdictCore));
  const arbitrationVerdictSignature = signHashHexEd25519(arbitrationVerdictHash, selectedArbiterKeypair.privateKeyPem);

  const issueVerdict = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/verdict`,
    headers: { "x-idempotency-key": "market_arb_lifecycle_verdict_1" },
    body: {
      caseId: "arb_case_lifecycle_1",
      arbitrationVerdict: {
        caseId: "arb_case_lifecycle_1",
        verdictId: "arb_vrd_lifecycle_1",
        arbiterAgentId: expectedArbiter,
        outcome: "accepted",
        releaseRatePct: 100,
        rationale: "verified arbitration outcome",
        evidenceRefs: [`evidence://${runId}/output.json`],
        issuedAt: verdictIssuedAt,
        signerKeyId: selectedArbiterRegistration.keyId,
        signature: arbitrationVerdictSignature
      }
    }
  });
  assert.equal(issueVerdict.statusCode, 200);
  assert.equal(issueVerdict.json?.arbitrationCase?.status, "verdict_issued");
  assert.equal(issueVerdict.json?.arbitrationVerdict?.verdictHash, arbitrationVerdictHash);
  assert.equal(issueVerdict.json?.arbitrationVerdictArtifact?.artifactId, "arbitration_verdict_arb_vrd_lifecycle_1");

  const closeArbitration = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/close`,
    headers: { "x-idempotency-key": "market_arb_lifecycle_close_1" },
    body: {
      caseId: "arb_case_lifecycle_1",
      summary: "arbitration finalized"
    }
  });
  assert.equal(closeArbitration.statusCode, 200);
  assert.equal(closeArbitration.json?.arbitrationCase?.status, "closed");
  assert.equal(closeArbitration.json?.settlement?.disputeStatus, "closed");
  assert.equal(closeArbitration.json?.settlement?.disputeVerdictArtifactId, "arbitration_verdict_arb_vrd_lifecycle_1");

  const openAppeal = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/appeal`,
    headers: { "x-idempotency-key": "market_arb_lifecycle_appeal_open_1" },
    body: {
      caseId: "arb_case_lifecycle_appeal_1",
      parentCaseId: "arb_case_lifecycle_1",
      reason: "new admissible evidence",
      panelCandidateAgentIds: ["agt_market_arbiter_a", "agt_market_arbiter_b"],
      evidenceRefs: [`evidence://${runId}/output.json`]
    }
  });
  assert.equal(openAppeal.statusCode, 201);
  assert.equal(openAppeal.json?.arbitrationCase?.appealRef?.parentCaseId, "arb_case_lifecycle_1");
  assert.equal(openAppeal.json?.arbitrationCase?.status, "under_review");

  const listCases = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/cases`
  });
  assert.equal(listCases.statusCode, 200);
  assert.equal(Array.isArray(listCases.json?.cases), true);
  assert.equal((listCases.json?.cases ?? []).length >= 2, true);

  const getAppealCase = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/cases/arb_case_lifecycle_appeal_1`
  });
  assert.equal(getAppealCase.statusCode, 200);
  assert.equal(getAppealCase.json?.arbitrationCase?.caseId, "arb_case_lifecycle_appeal_1");

  nowMs += 3 * 24 * 60 * 60_000;
  const lateAppeal = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/appeal`,
    headers: { "x-idempotency-key": "market_arb_lifecycle_appeal_open_2" },
    body: {
      caseId: "arb_case_lifecycle_appeal_2",
      parentCaseId: "arb_case_lifecycle_1",
      reason: "should miss appeal window",
      evidenceRefs: [`evidence://${runId}/output.json`]
    }
  });
  assert.equal(lateAppeal.statusCode, 409);
  assert.match(String(lateAppeal.json?.error ?? ""), /appeal window has closed/i);
});

test("API e2e: marketplace supports all interaction directions", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_dir_poster");
  await registerAgent(api, "agt_market_dir_bidder");
  await registerAgent(api, "agt_market_dir_operator");
  await creditWallet(api, {
    agentId: "agt_market_dir_poster",
    amountCents: 50000,
    idempotencyKey: "wallet_credit_market_dir_poster_1"
  });

  const entityTypes = ["agent", "human", "robot", "machine"];
  const directionPairs = [];
  for (const fromType of entityTypes) {
    for (const toType of entityTypes) {
      directionPairs.push({ fromType, toType });
    }
  }

  for (let index = 0; index < directionPairs.length; index += 1) {
    const pair = directionPairs[index];
    const rfqId = `rfq_dir_${pair.fromType}_${pair.toType}_${index}`;
    const bidId = `bid_dir_${pair.fromType}_${pair.toType}_${index}`;
    const idBase = `market_dir_${pair.fromType}_${pair.toType}_${index}`;

    const createTask = await request(api, {
      method: "POST",
      path: "/marketplace/rfqs",
      headers: { "x-idempotency-key": `${idBase}_task` },
      body: {
        rfqId,
        title: `${pair.fromType} to ${pair.toType}`,
        capability: "translate",
        posterAgentId: "agt_market_dir_poster",
        fromType: pair.fromType,
        toType: pair.toType,
        budgetCents: 2000 + index,
        currency: "USD"
      }
    });
    assert.equal(createTask.statusCode, 201);
    assert.equal(createTask.json?.rfq?.fromType, pair.fromType);
    assert.equal(createTask.json?.rfq?.toType, pair.toType);

    const bid = await request(api, {
      method: "POST",
      path: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`,
      headers: { "x-idempotency-key": `${idBase}_bid` },
      body: {
        bidId,
        bidderAgentId: "agt_market_dir_bidder",
        amountCents: 1500 + index,
        currency: "USD",
        fromType: pair.fromType,
        toType: pair.toType
      }
    });
    assert.equal(bid.statusCode, 201);
    assert.equal(bid.json?.bid?.fromType, pair.fromType);
    assert.equal(bid.json?.bid?.toType, pair.toType);

    const accept = await request(api, {
      method: "POST",
      path: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/accept`,
      headers: { "x-idempotency-key": `${idBase}_accept` },
      body: {
        bidId,
        acceptedByAgentId: "agt_market_dir_operator",
        fromType: pair.fromType,
        toType: pair.toType
      }
    });
    assert.equal(accept.statusCode, 200);
    assert.equal(accept.json?.agreement?.fromType, pair.fromType);
    assert.equal(accept.json?.agreement?.toType, pair.toType);
  }
});

test("API e2e: policy can require manual settlement review and resolve", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_policy_poster");
  await registerAgent(api, "agt_market_policy_bidder");
  await registerAgent(api, "agt_market_policy_operator");
  await creditWallet(api, {
    agentId: "agt_market_policy_poster",
    amountCents: 10000,
    idempotencyKey: "wallet_credit_market_policy_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_policy_rfq_create_1" },
    body: {
      rfqId: "rfq_policy_1",
      title: "Policy-gated settlement task",
      capability: "translate",
      posterAgentId: "agt_market_policy_poster",
      budgetCents: 3000,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_1/bids",
    headers: { "x-idempotency-key": "market_policy_bid_create_1" },
    body: {
      bidId: "bid_policy_1",
      bidderAgentId: "agt_market_policy_bidder",
      amountCents: 2200,
      currency: "USD",
      verificationMethod: { mode: "attested", attestor: "oracle://qa-bot" },
      policy: {
        mode: "automatic",
        rules: {
          requireDeterministicVerification: true,
          autoReleaseOnGreen: true,
          autoReleaseOnAmber: false,
          autoReleaseOnRed: false
        }
      }
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_1/accept",
    headers: { "x-idempotency-key": "market_policy_accept_1" },
    body: {
      bidId: "bid_policy_1",
      acceptedByAgentId: "agt_market_policy_operator"
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);
  assert.equal(accept.json?.agreement?.verificationMethod?.mode, "attested");
  assert.equal(accept.json?.agreement?.policy?.rules?.requireDeterministicVerification, true);

  const completed = await request(api, {
    method: "POST",
    path: `/agents/agt_market_policy_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_policy_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json?.settlement?.status, "locked");
  assert.equal(completed.json?.settlement?.decisionStatus, "manual_review_required");

  const replayBeforeManualResolve = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/policy-replay`
  });
  assert.equal(replayBeforeManualResolve.statusCode, 200);
  assert.equal(replayBeforeManualResolve.json?.matchesStoredDecision, true);
  assert.equal(replayBeforeManualResolve.json?.policyVersion, 1);
  assert.equal(replayBeforeManualResolve.json?.replay?.decision?.shouldAutoResolve, false);

  const replayEvaluateBeforeManualResolve = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/replay-evaluate`
  });
  assert.equal(replayEvaluateBeforeManualResolve.statusCode, 200);
  assert.equal(replayEvaluateBeforeManualResolve.json?.comparisons?.matchesStoredDecision, true);
  assert.equal(replayEvaluateBeforeManualResolve.json?.comparisons?.policyDecisionMatchesStored, true);
  assert.equal(replayEvaluateBeforeManualResolve.json?.comparisons?.kernelBindingsValid, true);
  assert.equal(replayEvaluateBeforeManualResolve.json?.policyVersion, 1);

  const payerAfterComplete = await request(api, {
    method: "GET",
    path: "/agents/agt_market_policy_poster/wallet"
  });
  assert.equal(payerAfterComplete.statusCode, 200);
  assert.equal(payerAfterComplete.json?.wallet?.availableCents, 7800);
  assert.equal(payerAfterComplete.json?.wallet?.escrowLockedCents, 2200);

  const manualResolve = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/settlement/resolve`,
    headers: { "x-idempotency-key": "market_policy_manual_resolve_1" },
    body: {
      status: "released",
      releaseRatePct: 100,
      resolvedByAgentId: "agt_market_policy_operator",
      reason: "manual policy override"
    }
  });
  assert.equal(manualResolve.statusCode, 200);
  assert.equal(manualResolve.json?.settlement?.status, "released");
  assert.equal(manualResolve.json?.settlement?.decisionStatus, "manual_resolved");
  assert.equal(manualResolve.json?.settlement?.releasedAmountCents, 2200);
  assert.equal(manualResolve.json?.settlement?.refundedAmountCents, 0);

  const replayAfterManualResolve = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/policy-replay`
  });
  assert.equal(replayAfterManualResolve.statusCode, 200);
  assert.equal(replayAfterManualResolve.json?.matchesStoredDecision, false);
  assert.equal(replayAfterManualResolve.json?.replay?.decision?.shouldAutoResolve, false);

  const replayEvaluateAfterManualResolve = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/replay-evaluate`
  });
  assert.equal(replayEvaluateAfterManualResolve.statusCode, 200);
  assert.equal(replayEvaluateAfterManualResolve.json?.comparisons?.matchesStoredDecision, false);
  // Policy decision itself should still match stored trace; the mismatch is the manual override.
  assert.equal(replayEvaluateAfterManualResolve.json?.comparisons?.policyDecisionMatchesStored, true);

  const payerAfterResolve = await request(api, {
    method: "GET",
    path: "/agents/agt_market_policy_poster/wallet"
  });
  assert.equal(payerAfterResolve.statusCode, 200);
  assert.equal(payerAfterResolve.json?.wallet?.availableCents, 7800);
  assert.equal(payerAfterResolve.json?.wallet?.escrowLockedCents, 0);

  const payeeAfterResolve = await request(api, {
    method: "GET",
    path: "/agents/agt_market_policy_bidder/wallet"
  });
  assert.equal(payeeAfterResolve.statusCode, 200);
  assert.equal(payeeAfterResolve.json?.wallet?.availableCents, 2200);
  assert.equal(payeeAfterResolve.json?.wallet?.escrowLockedCents, 0);

  const taskListClosed = await request(api, {
    method: "GET",
    path: "/marketplace/rfqs?status=closed"
  });
  assert.equal(taskListClosed.statusCode, 200);
  const closedTask = (taskListClosed.json?.rfqs ?? []).find((task) => task?.rfqId === "rfq_policy_1") ?? null;
  assert.ok(closedTask);
  assert.equal(closedTask?.settlementDecisionStatus, "manual_resolved");
  assert.equal(closedTask?.settlementDecisionReason, "manual policy override");
});

test("API e2e: deterministic verifier plugin sets settlement decision verifierRef and replay matches", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_det_plugin_poster");
  await registerAgent(api, "agt_market_det_plugin_bidder");
  await registerAgent(api, "agt_market_det_plugin_operator");
  await creditWallet(api, {
    agentId: "agt_market_det_plugin_poster",
    amountCents: 9000,
    idempotencyKey: "wallet_credit_market_det_plugin_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_det_plugin_rfq_create_1" },
    body: {
      rfqId: "rfq_det_plugin_1",
      title: "Deterministic verifier plugin flow",
      capability: "translate",
      posterAgentId: "agt_market_det_plugin_poster",
      budgetCents: 2600,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_det_plugin_1/bids",
    headers: { "x-idempotency-key": "market_det_plugin_bid_create_1" },
    body: {
      bidId: "bid_det_plugin_1",
      bidderAgentId: "agt_market_det_plugin_bidder",
      amountCents: 2100,
      currency: "USD",
      verificationMethod: {
        mode: "deterministic",
        source: SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_LATENCY_THRESHOLD_V1
      },
      policy: {
        mode: "automatic",
        rules: {
          requireDeterministicVerification: true,
          autoReleaseOnGreen: true,
          autoReleaseOnAmber: false,
          autoReleaseOnRed: false
        }
      }
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_det_plugin_1/accept",
    headers: { "x-idempotency-key": "market_det_plugin_accept_1" },
    body: {
      bidId: "bid_det_plugin_1",
      acceptedByAgentId: "agt_market_det_plugin_operator"
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const completed = await request(api, {
    method: "POST",
    path: `/agents/agt_market_det_plugin_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_det_plugin_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { latencyMs: 250 }
      }
    }
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json?.settlement?.status, "released");
  assert.equal(completed.json?.settlement?.decisionStatus, "auto_resolved");

  const settlementRead = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement`
  });
  assert.equal(settlementRead.statusCode, 200);
  const decisionRecord = settlementRead.json?.decisionRecord ?? settlementRead.json?.settlement?.decisionTrace?.decisionRecord ?? null;
  assert.ok(decisionRecord);
  assert.equal(decisionRecord?.schemaVersion, "SettlementDecisionRecord.v2");
  assert.equal(decisionRecord?.verifierRef?.modality, "deterministic");
  assert.equal(decisionRecord?.verifierRef?.verifierId, "settld.deterministic.latency-threshold");
  assert.match(String(decisionRecord?.verifierRef?.verifierHash ?? ""), /^[0-9a-f]{64}$/);

  const replayEvaluate = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/replay-evaluate`
  });
  assert.equal(replayEvaluate.statusCode, 200);
  assert.equal(replayEvaluate.json?.comparisons?.matchesStoredDecision, true);
  assert.equal(replayEvaluate.json?.comparisons?.policyDecisionMatchesStored, true);
  assert.equal(replayEvaluate.json?.comparisons?.decisionRecordReplayCriticalMatchesStored, true);
  assert.equal(replayEvaluate.json?.comparisons?.verifierRefMatchesStored, true);
  assert.equal(replayEvaluate.json?.verifierRef?.modality, "deterministic");
  assert.equal(replayEvaluate.json?.verifierRef?.verifierId, "settld.deterministic.latency-threshold");
  assert.match(String(replayEvaluate.json?.verifierRef?.verifierHash ?? ""), /^[0-9a-f]{64}$/);
  assert.equal(replayEvaluate.json?.verifierExecution?.pluginMatched, true);
});

test("API e2e: deterministic schema-check verifier plugin can force refunded auto-resolution and replay match", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_det_schema_poster");
  await registerAgent(api, "agt_market_det_schema_bidder");
  await registerAgent(api, "agt_market_det_schema_operator");
  await creditWallet(api, {
    agentId: "agt_market_det_schema_poster",
    amountCents: 9000,
    idempotencyKey: "wallet_credit_market_det_schema_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_det_schema_rfq_create_1" },
    body: {
      rfqId: "rfq_det_schema_1",
      title: "Deterministic schema-check verifier flow",
      capability: "translate",
      posterAgentId: "agt_market_det_schema_poster",
      budgetCents: 2600,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_det_schema_1/bids",
    headers: { "x-idempotency-key": "market_det_schema_bid_create_1" },
    body: {
      bidId: "bid_det_schema_1",
      bidderAgentId: "agt_market_det_schema_bidder",
      amountCents: 2100,
      currency: "USD",
      verificationMethod: {
        mode: "deterministic",
        source: `${SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_SCHEMA_CHECK_V1}?latencyMaxMs=300&requireSettlementReleaseRatePct=1`
      },
      policy: {
        mode: "automatic",
        rules: {
          requireDeterministicVerification: true,
          autoReleaseOnGreen: true,
          autoReleaseOnAmber: false,
          autoReleaseOnRed: true,
          redReleaseRatePct: 0
        }
      }
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_det_schema_1/accept",
    headers: { "x-idempotency-key": "market_det_schema_accept_1" },
    body: {
      bidId: "bid_det_schema_1",
      acceptedByAgentId: "agt_market_det_schema_operator"
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const completed = await request(api, {
    method: "POST",
    path: `/agents/agt_market_det_schema_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_det_schema_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { latencyMs: 1200, settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json?.settlement?.status, "refunded");
  assert.equal(completed.json?.settlement?.decisionStatus, "auto_resolved");
  assert.equal(completed.json?.settlement?.releasedAmountCents, 0);
  assert.equal(completed.json?.settlement?.refundedAmountCents, 2100);

  const decisionRecord = completed.json?.decisionRecord ?? completed.json?.settlement?.decisionTrace?.decisionRecord ?? null;
  assert.ok(decisionRecord);
  assert.equal(decisionRecord?.schemaVersion, "SettlementDecisionRecord.v2");
  assert.equal(decisionRecord?.verifierRef?.modality, "deterministic");
  assert.equal(decisionRecord?.verifierRef?.verifierId, "settld.deterministic.schema-check");
  assert.match(String(decisionRecord?.verifierRef?.verifierHash ?? ""), /^[0-9a-f]{64}$/);

  const replayEvaluate = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/replay-evaluate`
  });
  assert.equal(replayEvaluate.statusCode, 200);
  assert.equal(replayEvaluate.json?.comparisons?.matchesStoredDecision, true);
  assert.equal(replayEvaluate.json?.comparisons?.policyDecisionMatchesStored, true);
  assert.equal(replayEvaluate.json?.comparisons?.decisionRecordReplayCriticalMatchesStored, true);
  assert.equal(replayEvaluate.json?.comparisons?.verifierRefMatchesStored, true);
  assert.equal(replayEvaluate.json?.verifierRef?.modality, "deterministic");
  assert.equal(replayEvaluate.json?.verifierRef?.verifierId, "settld.deterministic.schema-check");
  assert.match(String(replayEvaluate.json?.verifierRef?.verifierHash ?? ""), /^[0-9a-f]{64}$/);
  assert.equal(replayEvaluate.json?.verifierExecution?.pluginMatched, true);
  assert.deepEqual(replayEvaluate.json?.verifierExecution?.reasonCodes ?? [], ["verifier_plugin_schema_check_failed"]);
});

test("API e2e: manual-review settlement preserves dispute window for post-resolve disputes", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_policy_window_poster");
  await registerAgent(api, "agt_market_policy_window_bidder");
  await registerAgent(api, "agt_market_policy_window_operator");
  await creditWallet(api, {
    agentId: "agt_market_policy_window_poster",
    amountCents: 8000,
    idempotencyKey: "wallet_credit_market_policy_window_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_policy_window_rfq_create_1" },
    body: {
      rfqId: "rfq_policy_window_1",
      title: "Manual review dispute-window regression",
      capability: "translate",
      posterAgentId: "agt_market_policy_window_poster",
      budgetCents: 2400,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_window_1/bids",
    headers: { "x-idempotency-key": "market_policy_window_bid_create_1" },
    body: {
      bidId: "bid_policy_window_1",
      bidderAgentId: "agt_market_policy_window_bidder",
      amountCents: 2100,
      currency: "USD",
      verificationMethod: { mode: "attested", attestor: "oracle://qa-bot" },
      policy: {
        mode: "automatic",
        rules: {
          requireDeterministicVerification: true,
          autoReleaseOnGreen: true,
          autoReleaseOnAmber: false,
          autoReleaseOnRed: false
        }
      }
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_window_1/accept",
    headers: { "x-idempotency-key": "market_policy_window_accept_1" },
    body: {
      bidId: "bid_policy_window_1",
      acceptedByAgentId: "agt_market_policy_window_operator",
      disputeWindowDays: 2
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const completed = await request(api, {
    method: "POST",
    path: `/agents/agt_market_policy_window_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_policy_window_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json?.settlement?.decisionStatus, "manual_review_required");
  assert.equal(completed.json?.settlement?.status, "locked");

  const manualResolve = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/settlement/resolve`,
    headers: { "x-idempotency-key": "market_policy_window_manual_resolve_1" },
    body: {
      status: "released",
      releaseRatePct: 100,
      resolvedByAgentId: "agt_market_policy_window_operator",
      reason: "manual policy override"
    }
  });
  assert.equal(manualResolve.statusCode, 200);
  assert.equal(manualResolve.json?.settlement?.status, "released");
  assert.equal(manualResolve.json?.settlement?.decisionStatus, "manual_resolved");
  assert.equal(manualResolve.json?.settlement?.disputeWindowDays, 2);
  assert.ok(typeof manualResolve.json?.settlement?.disputeWindowEndsAt === "string");
  assert.ok(
    Date.parse(String(manualResolve.json?.settlement?.disputeWindowEndsAt)) >
      Date.parse(String(manualResolve.json?.settlement?.resolvedAt))
  );

  const openDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: { "x-idempotency-key": "market_policy_window_dispute_open_1" },
    body: {
      disputeId: "dsp_policy_window_1",
      disputeType: "quality",
      disputePriority: "normal",
      disputeChannel: "counterparty",
      escalationLevel: "l1_counterparty",
      openedByAgentId: "agt_market_policy_window_operator",
      reason: "post-manual-resolve review"
    }
  });
  assert.equal(openDispute.statusCode, 200);
  assert.equal(openDispute.json?.settlement?.disputeStatus, "open");
  assert.equal(openDispute.json?.settlement?.disputeId, "dsp_policy_window_1");
});

test("API e2e: manual-review settlement rejects dispute open when dispute window is disabled", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_policy_nowindow_poster");
  await registerAgent(api, "agt_market_policy_nowindow_bidder");
  await registerAgent(api, "agt_market_policy_nowindow_operator");
  await creditWallet(api, {
    agentId: "agt_market_policy_nowindow_poster",
    amountCents: 8000,
    idempotencyKey: "wallet_credit_market_policy_nowindow_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_policy_nowindow_rfq_create_1" },
    body: {
      rfqId: "rfq_policy_nowindow_1",
      title: "Manual review dispute-window disabled",
      capability: "translate",
      posterAgentId: "agt_market_policy_nowindow_poster",
      budgetCents: 2400,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_nowindow_1/bids",
    headers: { "x-idempotency-key": "market_policy_nowindow_bid_create_1" },
    body: {
      bidId: "bid_policy_nowindow_1",
      bidderAgentId: "agt_market_policy_nowindow_bidder",
      amountCents: 2100,
      currency: "USD",
      verificationMethod: { mode: "attested", attestor: "oracle://qa-bot" },
      policy: {
        mode: "automatic",
        rules: {
          requireDeterministicVerification: true,
          autoReleaseOnGreen: true,
          autoReleaseOnAmber: false,
          autoReleaseOnRed: false
        }
      }
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_nowindow_1/accept",
    headers: { "x-idempotency-key": "market_policy_nowindow_accept_1" },
    body: {
      bidId: "bid_policy_nowindow_1",
      acceptedByAgentId: "agt_market_policy_nowindow_operator",
      disputeWindowDays: 0
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const completed = await request(api, {
    method: "POST",
    path: `/agents/agt_market_policy_nowindow_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_policy_nowindow_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json?.settlement?.decisionStatus, "manual_review_required");
  assert.equal(completed.json?.settlement?.status, "locked");

  const manualResolve = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/settlement/resolve`,
    headers: { "x-idempotency-key": "market_policy_nowindow_manual_resolve_1" },
    body: {
      status: "released",
      releaseRatePct: 100,
      resolvedByAgentId: "agt_market_policy_nowindow_operator",
      reason: "manual policy override"
    }
  });
  assert.equal(manualResolve.statusCode, 200);
  assert.equal(manualResolve.json?.settlement?.status, "released");
  assert.equal(manualResolve.json?.settlement?.decisionStatus, "manual_resolved");
  assert.equal(manualResolve.json?.settlement?.disputeWindowDays, 0);

  const openDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: { "x-idempotency-key": "market_policy_nowindow_dispute_open_1" },
    body: {
      disputeId: "dsp_policy_nowindow_1",
      disputeType: "quality",
      disputePriority: "normal",
      disputeChannel: "counterparty",
      escalationLevel: "l1_counterparty",
      openedByAgentId: "agt_market_policy_nowindow_operator",
      reason: "post-manual-resolve review"
    }
  });
  assert.equal(openDispute.statusCode, 409);
  assert.match(String(openDispute.json?.error ?? ""), /dispute window has closed/i);
});

test("API e2e: marketplace bid rejects mismatched policy and verification method hashes", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_hash_poster");
  await registerAgent(api, "agt_market_hash_bidder");
  await creditWallet(api, {
    agentId: "agt_market_hash_poster",
    amountCents: 4000,
    idempotencyKey: "wallet_credit_market_hash_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_hash_rfq_create_1" },
    body: {
      rfqId: "rfq_hash_1",
      title: "Hash pinned bid task",
      capability: "translate",
      posterAgentId: "agt_market_hash_poster",
      budgetCents: 2000,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const verificationMethod = normalizeVerificationMethod({
    mode: "attested",
    attestor: "oracle://qa-bot"
  });
  const verificationMethodHash = computeVerificationMethodHash(verificationMethod);
  const settlementPolicy = normalizeSettlementPolicy({
    mode: "automatic",
    rules: {
      requireDeterministicVerification: true,
      autoReleaseOnGreen: true,
      autoReleaseOnAmber: false,
      autoReleaseOnRed: false
    }
  });
  const policyHash = computeSettlementPolicyHash(settlementPolicy);

  const badMethodHashBid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_hash_1/bids",
    headers: { "x-idempotency-key": "market_hash_bid_bad_method_1" },
    body: {
      bidId: "bid_hash_bad_method_1",
      bidderAgentId: "agt_market_hash_bidder",
      amountCents: 1500,
      currency: "USD",
      verificationMethod: {
        mode: "attested",
        attestor: "oracle://qa-bot",
        verificationMethodHash: "deadbeef"
      },
      policy: {
        ...settlementPolicy,
        policyHash
      }
    }
  });
  assert.equal(badMethodHashBid.statusCode, 400);
  assert.equal(badMethodHashBid.json?.error, "invalid verificationMethod");

  const badPolicyHashBid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_hash_1/bids",
    headers: { "x-idempotency-key": "market_hash_bid_bad_policy_1" },
    body: {
      bidId: "bid_hash_bad_policy_1",
      bidderAgentId: "agt_market_hash_bidder",
      amountCents: 1500,
      currency: "USD",
      verificationMethod: {
        mode: "attested",
        attestor: "oracle://qa-bot",
        verificationMethodHash
      },
      policy: {
        ...settlementPolicy,
        policyHash: "deadbeef"
      }
    }
  });
  assert.equal(badPolicyHashBid.statusCode, 400);
  assert.equal(badPolicyHashBid.json?.error, "invalid policy");

  const goodBid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_hash_1/bids",
    headers: { "x-idempotency-key": "market_hash_bid_ok_1" },
    body: {
      bidId: "bid_hash_ok_1",
      bidderAgentId: "agt_market_hash_bidder",
      amountCents: 1500,
      currency: "USD",
      verificationMethod: {
        mode: "attested",
        attestor: "oracle://qa-bot",
        verificationMethodHash
      },
      policy: {
        ...settlementPolicy,
        policyHash
      }
    }
  });
  assert.equal(goodBid.statusCode, 201);
  assert.equal(goodBid.json?.bid?.policy?.policyHash, policyHash);
});

test("API e2e: tenant settlement policy registry powers bid/accept policyRef flow", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_ref_poster");
  await registerAgent(api, "agt_market_ref_bidder");
  await registerAgent(api, "agt_market_ref_operator");
  await creditWallet(api, {
    agentId: "agt_market_ref_poster",
    amountCents: 6000,
    idempotencyKey: "wallet_credit_market_ref_poster_1"
  });

  const upsertPolicy = await request(api, {
    method: "POST",
    path: "/marketplace/settlement-policies",
    headers: { "x-idempotency-key": "market_ref_policy_upsert_1" },
    body: {
      policyId: "market.default.auto-v1",
      policyVersion: 3,
      verificationMethod: {
        mode: "deterministic",
        source: "verifier://settld-verify"
      },
      policy: {
        mode: "automatic",
        rules: {
          requireDeterministicVerification: true,
          autoReleaseOnGreen: true,
          autoReleaseOnAmber: false,
          autoReleaseOnRed: false,
          greenReleaseRatePct: 100,
          amberReleaseRatePct: 25,
          redReleaseRatePct: 0
        }
      },
      description: "default deterministic policy for marketplace pilots"
    }
  });
  assert.equal(upsertPolicy.statusCode, 201);
  assert.equal(upsertPolicy.json?.policy?.policyId, "market.default.auto-v1");
  assert.equal(upsertPolicy.json?.policy?.policyVersion, 3);
  assert.equal(upsertPolicy.json?.policy?.policy?.rules?.autoReleaseOnAmber, false);

  const listPolicies = await request(api, {
    method: "GET",
    path: "/marketplace/settlement-policies?policyId=market.default.auto-v1"
  });
  assert.equal(listPolicies.statusCode, 200);
  assert.equal(listPolicies.json?.total, 1);
  assert.equal(listPolicies.json?.policies?.[0]?.policyVersion, 3);

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_ref_rfq_create_1" },
    body: {
      rfqId: "rfq_ref_1",
      title: "Policy ref task",
      capability: "translate",
      posterAgentId: "agt_market_ref_poster",
      budgetCents: 2500,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_ref_1/bids",
    headers: { "x-idempotency-key": "market_ref_bid_1" },
    body: {
      bidId: "bid_ref_1",
      bidderAgentId: "agt_market_ref_bidder",
      amountCents: 1700,
      currency: "USD",
      policyRef: {
        policyId: "market.default.auto-v1",
        policyVersion: 3
      }
    }
  });
  assert.equal(bid.statusCode, 201);
  assert.equal(bid.json?.bid?.policyRef?.source, "tenant_registry");
  assert.equal(bid.json?.bid?.policyRef?.policyId, "market.default.auto-v1");
  assert.equal(bid.json?.bid?.policyRef?.policyVersion, 3);
  assert.ok(typeof bid.json?.bid?.negotiation?.proposals?.[0]?.proposalHash === "string");
  assert.ok(typeof bid.json?.bid?.negotiation?.proposals?.[0]?.policyRefHash === "string");

  const badRefMismatch = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_ref_1/bids",
    headers: { "x-idempotency-key": "market_ref_bid_bad_ref_1" },
    body: {
      bidId: "bid_ref_bad_1",
      bidderAgentId: "agt_market_ref_bidder",
      amountCents: 1650,
      currency: "USD",
      verificationMethod: {
        mode: "attested",
        attestor: "oracle://mismatch"
      },
      policyRef: {
        policyId: "market.default.auto-v1",
        policyVersion: 3
      }
    }
  });
  assert.equal(badRefMismatch.statusCode, 409);

  const missingRef = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_ref_1/bids",
    headers: { "x-idempotency-key": "market_ref_bid_missing_ref_1" },
    body: {
      bidId: "bid_ref_missing_1",
      bidderAgentId: "agt_market_ref_bidder",
      amountCents: 1650,
      currency: "USD",
      policyRef: {
        policyId: "market.default.auto-v9",
        policyVersion: 1
      }
    }
  });
  assert.equal(missingRef.statusCode, 404);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_ref_1/accept",
    headers: { "x-idempotency-key": "market_ref_accept_1" },
    body: {
      bidId: "bid_ref_1",
      acceptedByAgentId: "agt_market_ref_operator"
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);
  assert.equal(accept.json?.agreement?.policyRef?.source, "tenant_registry");
  assert.equal(accept.json?.agreement?.policyRef?.policyId, "market.default.auto-v1");
  assert.equal(accept.json?.agreement?.policyRef?.policyVersion, 3);

  const replay = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/policy-replay`
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json?.policyRef?.policyId, "market.default.auto-v1");
  assert.equal(replay.json?.policyRef?.policyVersion, 3);
  assert.equal(replay.json?.policyBindingVerification?.valid, true);
  assert.ok(typeof replay.json?.policyBinding?.bindingHash === "string");

  const agreementRead = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/agreement`
  });
  assert.equal(agreementRead.statusCode, 200);
  assert.equal(agreementRead.json?.agreement?.agreementId, accept.json?.agreement?.agreementId);
  assert.equal(agreementRead.json?.policyBindingVerification?.valid, true);
  assert.equal(agreementRead.json?.settlement?.runId, runId);
  assert.equal(agreementRead.json?.kernelVerification?.valid, true);
  assert.equal(agreementRead.json?.decisionRecord?.runId, runId);
  assert.equal(agreementRead.json?.settlementReceipt?.runId, runId);
});

test("API e2e: agreement milestones + change order drive partial deterministic settlement", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_terms_poster");
  await registerAgent(api, "agt_market_terms_bidder");
  await registerAgent(api, "agt_market_terms_operator");
  await creditWallet(api, {
    agentId: "agt_market_terms_poster",
    amountCents: 10000,
    idempotencyKey: "wallet_credit_market_terms_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_terms_rfq_create_1" },
    body: {
      rfqId: "rfq_terms_1",
      title: "Milestone terms task",
      capability: "translate",
      posterAgentId: "agt_market_terms_poster",
      budgetCents: 2500,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_terms_1/bids",
    headers: { "x-idempotency-key": "market_terms_bid_create_1" },
    body: {
      bidId: "bid_terms_1",
      bidderAgentId: "agt_market_terms_bidder",
      amountCents: 2000,
      currency: "USD",
      etaSeconds: 1200
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_terms_1/accept",
    headers: { "x-idempotency-key": "market_terms_accept_1" },
    body: {
      bidId: "bid_terms_1",
      acceptedByAgentId: "agt_market_terms_operator",
      agreementTerms: {
        milestones: [
          { milestoneId: "draft", label: "Draft", releaseRatePct: 40, statusGate: "green" },
          { milestoneId: "final", label: "Final", releaseRatePct: 60, statusGate: "green" }
        ],
        changeOrderPolicy: { enabled: true, maxChangeOrders: 2, requireCounterpartyAcceptance: true },
        cancellation: { allowCancellationBeforeStart: true, killFeeRatePct: 10, requireEvidenceOnCancellation: false }
      }
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);
  assert.equal(accept.json?.agreement?.terms?.milestones?.length, 2);
  assert.equal(accept.json?.agreement?.terms?.changeOrderPolicy?.enabled, true);

  const applyChangeOrderWithoutAcceptance = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/change-order`,
    headers: { "x-idempotency-key": "market_terms_change_order_missing_acceptance_1" },
    body: {
      changeOrderId: "chg_terms_0",
      requestedByAgentId: "agt_market_terms_poster",
      reason: "scope update",
      milestones: [
        { milestoneId: "draft", label: "Draft", releaseRatePct: 50, statusGate: "green" },
        { milestoneId: "final", label: "Final", releaseRatePct: 50, statusGate: "green" }
      ]
    }
  });
  assert.equal(applyChangeOrderWithoutAcceptance.statusCode, 400);
  assert.equal(applyChangeOrderWithoutAcceptance.json?.error, "acceptedByAgentId is required by agreement change order policy");

  const applyChangeOrder = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/change-order`,
    headers: { "x-idempotency-key": "market_terms_change_order_1" },
    body: {
      changeOrderId: "chg_terms_1",
      requestedByAgentId: "agt_market_terms_poster",
      acceptedByAgentId: "agt_market_terms_bidder",
      reason: "scope update",
      milestones: [
        { milestoneId: "draft", label: "Draft", releaseRatePct: 50, statusGate: "green" },
        { milestoneId: "final", label: "Final", releaseRatePct: 50, statusGate: "green" }
      ]
    }
  });
  assert.equal(applyChangeOrder.statusCode, 200);
  assert.equal(applyChangeOrder.json?.agreement?.agreementRevision, 2);
  assert.equal(applyChangeOrder.json?.agreement?.terms?.changeOrders?.length, 1);
  assert.equal(applyChangeOrder.json?.agreement?.terms?.milestones?.[0]?.releaseRatePct, 50);
  assert.ok(typeof applyChangeOrder.json?.agreement?.policyBinding?.bindingHash === "string");

  const agreementAfterChangeOrder = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/agreement`
  });
  assert.equal(agreementAfterChangeOrder.statusCode, 200);
  assert.equal(agreementAfterChangeOrder.json?.policyBindingVerification?.valid, true);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/agt_market_terms_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_terms_complete_1"
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: {
          settlementReleaseRatePct: 100,
          completedMilestoneIds: ["draft"]
        }
      }
    }
  });
  assert.equal(complete.statusCode, 201);
  assert.equal(complete.json?.settlement?.status, "released");
  assert.equal(complete.json?.settlement?.releaseRatePct, 50);
  assert.equal(complete.json?.settlement?.releasedAmountCents, 1000);
  assert.equal(complete.json?.settlement?.refundedAmountCents, 1000);

  const replay = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/policy-replay`
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json?.matchesStoredDecision, true);
  assert.equal(replay.json?.replay?.decision?.milestoneEvaluation?.effectiveRatePct, 50);

  const payerWallet = await request(api, {
    method: "GET",
    path: "/agents/agt_market_terms_poster/wallet"
  });
  assert.equal(payerWallet.statusCode, 200);
  assert.equal(payerWallet.json?.wallet?.availableCents, 9000);
  assert.equal(payerWallet.json?.wallet?.escrowLockedCents, 0);

  const payeeWallet = await request(api, {
    method: "GET",
    path: "/agents/agt_market_terms_bidder/wallet"
  });
  assert.equal(payeeWallet.statusCode, 200);
  assert.equal(payeeWallet.json?.wallet?.availableCents, 1000);
  assert.equal(payeeWallet.json?.wallet?.escrowLockedCents, 0);
});

test("API e2e: agreement change order accepts optional counterparty signature", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_chg_sig_poster");
  const bidderKeypair = createEd25519Keypair();
  const bidderRegistration = await registerAgent(api, "agt_market_chg_sig_bidder", {
    publicKeyPem: bidderKeypair.publicKeyPem
  });
  await registerAgent(api, "agt_market_chg_sig_operator");
  await creditWallet(api, {
    agentId: "agt_market_chg_sig_poster",
    amountCents: 9000,
    idempotencyKey: "wallet_credit_market_chg_sig_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_chg_sig_rfq_create_1" },
    body: {
      rfqId: "rfq_chg_sig_1",
      title: "Signed change-order task",
      capability: "translate",
      posterAgentId: "agt_market_chg_sig_poster",
      budgetCents: 2500,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_chg_sig_1/bids",
    headers: { "x-idempotency-key": "market_chg_sig_bid_create_1" },
    body: {
      bidId: "bid_chg_sig_1",
      bidderAgentId: "agt_market_chg_sig_bidder",
      amountCents: 1800,
      currency: "USD"
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_chg_sig_1/accept",
    headers: { "x-idempotency-key": "market_chg_sig_accept_1" },
    body: {
      bidId: "bid_chg_sig_1",
      acceptedByAgentId: "agt_market_chg_sig_operator",
      agreementTerms: {
        milestones: [
          { milestoneId: "chg_sig_m1", releaseRatePct: 50, statusGate: "green" },
          { milestoneId: "chg_sig_m2", releaseRatePct: 50, statusGate: "green" }
        ],
        changeOrderPolicy: {
          enabled: true,
          maxChangeOrders: 2,
          requireCounterpartyAcceptance: true
        },
        cancellation: {
          allowCancellationBeforeStart: true,
          killFeeRatePct: 0,
          requireEvidenceOnCancellation: false,
          requireCounterpartyAcceptance: false
        }
      }
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;

  const changeOrderMilestones = [
    { milestoneId: "chg_sig_m1", releaseRatePct: 60, statusGate: "green" },
    { milestoneId: "chg_sig_m2", releaseRatePct: 40, statusGate: "green" }
  ];
  const changeOrderMilestonesNormalized = [
    { milestoneId: "chg_sig_m1", label: null, releaseRatePct: 60, statusGate: "green", requiredEvidenceCount: null },
    { milestoneId: "chg_sig_m2", label: null, releaseRatePct: 40, statusGate: "green", requiredEvidenceCount: null }
  ];
  const changeOrderCancellation = {
    allowCancellationBeforeStart: true,
    killFeeRatePct: 0,
    requireEvidenceOnCancellation: false
  };
  const changeOrderCancellationNormalized = {
    ...changeOrderCancellation,
    requireCounterpartyAcceptance: false
  };
  const changeOrderCore = normalizeForCanonicalJson(
    {
      schemaVersion: "MarketplaceAgreementChangeOrderAcceptanceSignature.v2",
      tenantId: accept.json?.agreement?.tenantId,
      runId,
      agreementId: accept.json?.agreement?.agreementId,
      rfqId: accept.json?.agreement?.rfqId,
      bidId: accept.json?.agreement?.bidId,
      changeOrderId: "change_sig_1",
      requestedByAgentId: "agt_market_chg_sig_poster",
      acceptedByAgentId: "agt_market_chg_sig_bidder",
      reason: "adjust release split",
      note: "counterparty approved",
      previousTermsHash: accept.json?.agreement?.termsHash,
      milestonesHash: sha256Hex(
        canonicalJsonStringify(normalizeForCanonicalJson(changeOrderMilestonesNormalized, { path: "$" }))
      ),
      cancellationHash: sha256Hex(
        canonicalJsonStringify(normalizeForCanonicalJson(changeOrderCancellationNormalized, { path: "$" }))
      ),
      actingOnBehalfOfPrincipalAgentId: null,
      actingOnBehalfOfDelegateAgentId: null,
      actingOnBehalfOfChainHash: null
    },
    { path: "$" }
  );
  const changeOrderHash = sha256Hex(canonicalJsonStringify(changeOrderCore));
  const changeOrderSignature = signHashHexEd25519(changeOrderHash, bidderKeypair.privateKeyPem);
  const invalidChangeOrderSignature = `${changeOrderSignature.slice(0, -2)}ab`;

  const changeOrderInvalid = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/change-order`,
    headers: { "x-idempotency-key": "market_chg_sig_change_invalid_1" },
    body: {
      changeOrderId: "change_sig_1",
      requestedByAgentId: "agt_market_chg_sig_poster",
      acceptedByAgentId: "agt_market_chg_sig_bidder",
      reason: "adjust release split",
      note: "counterparty approved",
      milestones: changeOrderMilestones,
      cancellation: changeOrderCancellation,
      acceptanceSignature: {
        signerAgentId: "agt_market_chg_sig_bidder",
        signerKeyId: bidderRegistration.keyId,
        signedAt: "2026-03-04T10:00:00.000Z",
        signature: invalidChangeOrderSignature
      }
    }
  });
  assert.equal(changeOrderInvalid.statusCode, 400);
  assert.equal(changeOrderInvalid.json?.error, "invalid acceptance signature");

  const changeOrder = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/change-order`,
    headers: { "x-idempotency-key": "market_chg_sig_change_valid_1" },
    body: {
      changeOrderId: "change_sig_1",
      requestedByAgentId: "agt_market_chg_sig_poster",
      acceptedByAgentId: "agt_market_chg_sig_bidder",
      reason: "adjust release split",
      note: "counterparty approved",
      milestones: changeOrderMilestones,
      cancellation: changeOrderCancellation,
      acceptanceSignature: {
        signerAgentId: "agt_market_chg_sig_bidder",
        signerKeyId: bidderRegistration.keyId,
        signedAt: "2026-03-04T10:00:00.000Z",
        signature: changeOrderSignature
      }
    }
  });
  assert.equal(changeOrder.statusCode, 200);
  assert.equal(changeOrder.json?.acceptanceSignatureVerification?.present, true);
  assert.equal(changeOrder.json?.acceptanceSignatureVerification?.valid, true);
  assert.equal(
    changeOrder.json?.changeOrder?.acceptanceSignature?.schemaVersion,
    "MarketplaceAgreementChangeOrderAcceptanceSignature.v2"
  );
  assert.equal(changeOrder.json?.changeOrder?.acceptanceSignature?.acceptanceHash, changeOrderHash);
  assert.equal(changeOrder.json?.changeOrder?.acceptanceSignature?.signerAgentId, "agt_market_chg_sig_bidder");
});

test("API e2e: marketplace bid counter-offer chain is accepted into agreement", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_offer_poster");
  await registerAgent(api, "agt_market_offer_bidder");
  await registerAgent(api, "agt_market_offer_operator");
  await creditWallet(api, {
    agentId: "agt_market_offer_poster",
    amountCents: 8000,
    idempotencyKey: "wallet_credit_market_offer_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_offer_rfq_create_1" },
    body: {
      rfqId: "rfq_offer_1",
      title: "Counter-offer task",
      capability: "translate",
      posterAgentId: "agt_market_offer_poster",
      budgetCents: 2000,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_offer_1/bids",
    headers: { "x-idempotency-key": "market_offer_bid_create_1" },
    body: {
      bidId: "bid_offer_1",
      bidderAgentId: "agt_market_offer_bidder",
      amountCents: 1300,
      currency: "USD",
      etaSeconds: 900
    }
  });
  assert.equal(bid.statusCode, 201);
  assert.equal(bid.json?.bid?.negotiation?.latestRevision, 1);

  const counterOne = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_offer_1/bids/bid_offer_1/counter-offer",
    headers: { "x-idempotency-key": "market_offer_counter_1" },
    body: {
      proposerAgentId: "agt_market_offer_poster",
      amountCents: 1000,
      note: "can you match this?"
    }
  });
  assert.equal(counterOne.statusCode, 200);
  assert.equal(counterOne.json?.bid?.amountCents, 1000);
  assert.equal(counterOne.json?.negotiation?.latestRevision, 2);
  assert.equal(counterOne.json?.proposal?.proposerAgentId, "agt_market_offer_poster");
  assert.ok(typeof counterOne.json?.proposal?.proposalHash === "string");
  assert.ok(typeof counterOne.json?.proposal?.prevProposalHash === "string");

  const counterTwo = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_offer_1/bids/bid_offer_1/counter-offer",
    headers: { "x-idempotency-key": "market_offer_counter_2" },
    body: {
      proposerAgentId: "agt_market_offer_bidder",
      amountCents: 1050,
      etaSeconds: 600,
      note: "best and final"
    }
  });
  assert.equal(counterTwo.statusCode, 200);
  assert.equal(counterTwo.json?.bid?.amountCents, 1050);
  assert.equal(counterTwo.json?.bid?.etaSeconds, 600);
  assert.equal(counterTwo.json?.negotiation?.latestRevision, 3);
  assert.equal(counterTwo.json?.negotiation?.proposals?.length, 3);
  assert.ok(typeof counterTwo.json?.proposal?.proposalHash === "string");
  assert.ok(typeof counterTwo.json?.proposal?.prevProposalHash === "string");

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_offer_1/accept",
    headers: { "x-idempotency-key": "market_offer_accept_1" },
    body: {
      bidId: "bid_offer_1",
      acceptedByAgentId: "agt_market_offer_operator"
    }
  });
  assert.equal(accept.statusCode, 200);
  assert.equal(accept.json?.acceptedBid?.amountCents, 1050);
  assert.equal(accept.json?.acceptedBid?.negotiation?.state, "accepted");
  assert.equal(accept.json?.acceptedBid?.negotiation?.acceptedRevision, 3);
  assert.equal(accept.json?.agreement?.amountCents, 1050);
  assert.equal(accept.json?.agreement?.acceptedRevision, 3);
  assert.ok(typeof accept.json?.agreement?.acceptedProposalId === "string" && accept.json?.agreement?.acceptedProposalId.length > 0);
  assert.ok(typeof accept.json?.agreement?.offerChainHash === "string" && accept.json?.agreement?.offerChainHash.length > 0);
  assert.ok(typeof accept.json?.agreement?.acceptedProposalHash === "string" && accept.json?.agreement?.acceptedProposalHash.length > 0);
  assert.equal(accept.json?.agreement?.acceptance?.acceptedByAgentId, "agt_market_offer_operator");
  assert.ok(typeof accept.json?.agreement?.policyBinding?.bindingHash === "string");
  assert.ok(typeof accept.json?.agreement?.policyBinding?.signerKeyId === "string" && accept.json?.agreement?.policyBinding?.signerKeyId.length > 0);
  assert.equal(accept.json?.agreement?.negotiation?.proposalCount, 3);
  assert.equal(accept.json?.settlement?.amountCents, 1050);

  const lifecycleArtifacts = await api.store.listArtifacts({
    tenantId: "tenant_default",
    artifactType: "MarketplaceLifecycle.v1"
  });
  const submitted = lifecycleArtifacts.filter(
    (row) => row?.rfqId === "rfq_offer_1" && row?.eventType === "proposal.submitted"
  );
  const accepted = lifecycleArtifacts.filter(
    (row) => row?.rfqId === "rfq_offer_1" && row?.eventType === "proposal.accepted"
  );
  assert.equal(submitted.length, 3);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]?.sourceEventId, accept.json?.agreement?.acceptedProposalId);
});

test("API e2e: signed marketplace agreement acceptance is verified on read + replay", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_sig_poster");
  await registerAgent(api, "agt_market_sig_bidder");
  const operatorKeypair = createEd25519Keypair();
  const operatorRegistration = await registerAgent(api, "agt_market_sig_operator", {
    publicKeyPem: operatorKeypair.publicKeyPem
  });
  await creditWallet(api, {
    agentId: "agt_market_sig_poster",
    amountCents: 9000,
    idempotencyKey: "wallet_credit_market_sig_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_sig_rfq_create_1" },
    body: {
      rfqId: "rfq_sig_1",
      title: "Signed acceptance task",
      capability: "translate",
      posterAgentId: "agt_market_sig_poster",
      budgetCents: 3000,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_sig_1/bids",
    headers: { "x-idempotency-key": "market_sig_bid_create_1" },
    body: {
      bidId: "bid_sig_1",
      bidderAgentId: "agt_market_sig_bidder",
      amountCents: 1500,
      currency: "USD",
      etaSeconds: 600
    }
  });
  assert.equal(bid.statusCode, 201);

  const proposals = normalizeForCanonicalJson(bid.json?.bid?.negotiation?.proposals ?? [], { path: "$" });
  const latestProposal = proposals[proposals.length - 1];
  assert.ok(latestProposal && typeof latestProposal === "object");
  const runId = "run_market_sig_1";
  const acceptanceCore = normalizeForCanonicalJson(
    {
      schemaVersion: "MarketplaceAgreementAcceptanceSignature.v2",
      agreementId: "agr_rfq_sig_1_bid_sig_1",
      tenantId: createTask.json?.rfq?.tenantId,
      rfqId: "rfq_sig_1",
      runId,
      bidId: "bid_sig_1",
      acceptedByAgentId: "agt_market_sig_operator",
      acceptedProposalId: latestProposal?.proposalId ?? null,
      acceptedRevision: Number.isSafeInteger(Number(latestProposal?.revision)) ? Number(latestProposal.revision) : null,
      acceptedProposalHash: latestProposal?.proposalHash ?? null,
      offerChainHash: sha256Hex(canonicalJsonStringify(proposals)),
      proposalCount: proposals.length,
      actingOnBehalfOfPrincipalAgentId: null,
      actingOnBehalfOfDelegateAgentId: null,
      actingOnBehalfOfChainHash: null
    },
    { path: "$" }
  );
  const acceptanceHash = sha256Hex(canonicalJsonStringify(acceptanceCore));
  const signature = signHashHexEd25519(acceptanceHash, operatorKeypair.privateKeyPem);
  const invalidSignature = `${signature.slice(0, -2)}ab`;

  const invalidAccept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_sig_1/accept",
    headers: { "x-idempotency-key": "market_sig_accept_invalid_1" },
    body: {
      bidId: "bid_sig_1",
      runId,
      acceptedByAgentId: "agt_market_sig_operator",
      acceptanceSignature: {
        signerAgentId: "agt_market_sig_operator",
        signerKeyId: operatorRegistration.keyId,
        signedAt: "2026-03-02T12:00:00.000Z",
        signature: invalidSignature
      }
    }
  });
  assert.equal(invalidAccept.statusCode, 400);
  assert.equal(invalidAccept.json?.error, "invalid acceptance signature");

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_sig_1/accept",
    headers: { "x-idempotency-key": "market_sig_accept_valid_1" },
    body: {
      bidId: "bid_sig_1",
      runId,
      acceptedByAgentId: "agt_market_sig_operator",
      acceptanceSignature: {
        signerAgentId: "agt_market_sig_operator",
        signerKeyId: operatorRegistration.keyId,
        signedAt: "2026-03-02T12:00:00.000Z",
        signature
      }
    }
  });
  assert.equal(accept.statusCode, 200);
  assert.equal(accept.json?.agreement?.acceptanceSignature?.schemaVersion, "MarketplaceAgreementAcceptanceSignature.v2");
  assert.equal(accept.json?.agreement?.acceptanceSignature?.acceptanceHash, acceptanceHash);
  assert.equal(accept.json?.agreement?.acceptanceSignature?.signerAgentId, "agt_market_sig_operator");
  assert.equal(accept.json?.agreement?.acceptanceSignature?.signerKeyId, operatorRegistration.keyId);

  const agreementRead = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/agreement`
  });
  assert.equal(agreementRead.statusCode, 200);
  assert.equal(agreementRead.json?.acceptanceSignatureVerification?.present, true);
  assert.equal(agreementRead.json?.acceptanceSignatureVerification?.valid, true);

  const policyReplay = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/policy-replay`
  });
  assert.equal(policyReplay.statusCode, 200);
  assert.equal(policyReplay.json?.acceptanceSignatureVerification?.present, true);
  assert.equal(policyReplay.json?.acceptanceSignatureVerification?.valid, true);
});

test("API e2e: signed marketplace agreement acceptance supports delegation chain", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_sig_del_poster");
  await registerAgent(api, "agt_market_sig_del_bidder");
  const operatorKeypair = createEd25519Keypair();
  const delegateKeypair = createEd25519Keypair();
  const operatorRegistration = await registerAgent(api, "agt_market_sig_del_operator", {
    publicKeyPem: operatorKeypair.publicKeyPem
  });
  const delegateRegistration = await registerAgent(api, "agt_market_sig_del_delegate", {
    publicKeyPem: delegateKeypair.publicKeyPem
  });
  await creditWallet(api, {
    agentId: "agt_market_sig_del_poster",
    amountCents: 6000,
    idempotencyKey: "wallet_credit_market_sig_del_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_sig_del_rfq_create_1" },
    body: {
      rfqId: "rfq_sig_del_1",
      title: "Delegated signed acceptance task",
      capability: "translate",
      posterAgentId: "agt_market_sig_del_poster",
      budgetCents: 2200,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_sig_del_1/bids",
    headers: { "x-idempotency-key": "market_sig_del_bid_create_1" },
    body: {
      bidId: "bid_sig_del_1",
      bidderAgentId: "agt_market_sig_del_bidder",
      amountCents: 1400,
      currency: "USD",
      etaSeconds: 600
    }
  });
  assert.equal(bid.statusCode, 201);

  const proposals = normalizeForCanonicalJson(bid.json?.bid?.negotiation?.proposals ?? [], { path: "$" });
  const latestProposal = proposals[proposals.length - 1];
  const runId = "run_market_sig_del_1";
  const signedAt = "2026-03-02T12:00:00.000Z";
  const delegationLink = buildDelegationLink({
    tenantId: createTask.json?.rfq?.tenantId,
    delegationId: "dlg_sig_del_1",
    principalAgentId: "agt_market_sig_del_operator",
    delegateAgentId: "agt_market_sig_del_delegate",
    scope: "marketplace.agreement.accept",
    issuedAt: "2026-03-01T00:00:00.000Z",
    expiresAt: "2026-03-10T00:00:00.000Z",
    signerKeyId: operatorRegistration.keyId,
    signerPrivateKeyPem: operatorKeypair.privateKeyPem
  });
  const actingOnBehalfOf = buildActingOnBehalfOf({
    principalAgentId: "agt_market_sig_del_operator",
    delegateAgentId: "agt_market_sig_del_delegate",
    delegationChain: [delegationLink]
  });

  const acceptanceCore = normalizeForCanonicalJson(
    {
      schemaVersion: "MarketplaceAgreementAcceptanceSignature.v2",
      agreementId: "agr_rfq_sig_del_1_bid_sig_del_1",
      tenantId: createTask.json?.rfq?.tenantId,
      rfqId: "rfq_sig_del_1",
      runId,
      bidId: "bid_sig_del_1",
      acceptedByAgentId: "agt_market_sig_del_operator",
      acceptedProposalId: latestProposal?.proposalId ?? null,
      acceptedRevision: Number.isSafeInteger(Number(latestProposal?.revision)) ? Number(latestProposal.revision) : null,
      acceptedProposalHash: latestProposal?.proposalHash ?? null,
      offerChainHash: sha256Hex(canonicalJsonStringify(proposals)),
      proposalCount: proposals.length,
      actingOnBehalfOfPrincipalAgentId: "agt_market_sig_del_operator",
      actingOnBehalfOfDelegateAgentId: "agt_market_sig_del_delegate",
      actingOnBehalfOfChainHash: actingOnBehalfOf.chainHash
    },
    { path: "$" }
  );
  const acceptanceHash = sha256Hex(canonicalJsonStringify(acceptanceCore));
  const signature = signHashHexEd25519(acceptanceHash, delegateKeypair.privateKeyPem);

  const rejectWithoutDelegation = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_sig_del_1/accept",
    headers: { "x-idempotency-key": "market_sig_del_accept_invalid_1" },
    body: {
      bidId: "bid_sig_del_1",
      runId,
      acceptedByAgentId: "agt_market_sig_del_operator",
      acceptanceSignature: {
        signerAgentId: "agt_market_sig_del_delegate",
        signerKeyId: delegateRegistration.keyId,
        signedAt,
        signature
      }
    }
  });
  assert.equal(rejectWithoutDelegation.statusCode, 400);
  assert.equal(rejectWithoutDelegation.json?.error, "invalid acceptance signature");

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_sig_del_1/accept",
    headers: { "x-idempotency-key": "market_sig_del_accept_valid_1" },
    body: {
      bidId: "bid_sig_del_1",
      runId,
      acceptedByAgentId: "agt_market_sig_del_operator",
      acceptanceSignature: {
        signerAgentId: "agt_market_sig_del_delegate",
        signerKeyId: delegateRegistration.keyId,
        signedAt,
        actingOnBehalfOf,
        signature
      }
    }
  });
  assert.equal(accept.statusCode, 200);
  assert.equal(accept.json?.agreement?.acceptanceSignature?.signerAgentId, "agt_market_sig_del_delegate");
  assert.equal(
    accept.json?.agreement?.acceptanceSignature?.actingOnBehalfOf?.principalAgentId,
    "agt_market_sig_del_operator"
  );
  assert.equal(
    accept.json?.agreement?.acceptanceSignature?.actingOnBehalfOf?.delegateAgentId,
    "agt_market_sig_del_delegate"
  );
  assert.equal(
    accept.json?.agreement?.acceptanceSignature?.actingOnBehalfOf?.chainHash,
    actingOnBehalfOf.chainHash
  );

  const agreementRead = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/agreement`
  });
  assert.equal(agreementRead.statusCode, 200);
  assert.equal(agreementRead.json?.acceptanceSignatureVerification?.present, true);
  assert.equal(agreementRead.json?.acceptanceSignatureVerification?.valid, true);
  assert.equal(
    agreementRead.json?.acceptanceSignatureVerification?.actingOnBehalfOf?.principalAgentId,
    "agt_market_sig_del_operator"
  );
});

test("API e2e: ops delegation traces and emergency revoke disable delegated acceptance", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_ops_del_poster");
  await registerAgent(api, "agt_market_ops_del_bidder");
  const operatorKeypair = createEd25519Keypair();
  const delegateKeypair = createEd25519Keypair();
  const operatorRegistration = await registerAgent(api, "agt_market_ops_del_operator", {
    publicKeyPem: operatorKeypair.publicKeyPem
  });
  const delegateRegistration = await registerAgent(api, "agt_market_ops_del_delegate", {
    publicKeyPem: delegateKeypair.publicKeyPem
  });
  await creditWallet(api, {
    agentId: "agt_market_ops_del_poster",
    amountCents: 6000,
    idempotencyKey: "wallet_credit_market_ops_del_poster_1"
  });

  const opsHeaders = await createAuthHeaders(api, {
    scopes: ["ops_read", "ops_write", "finance_write", "audit_read"]
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_ops_del_rfq_create_1" },
    body: {
      rfqId: "rfq_ops_del_1",
      title: "Delegation trace task",
      capability: "translate",
      posterAgentId: "agt_market_ops_del_poster",
      budgetCents: 2200,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_ops_del_1/bids",
    headers: { "x-idempotency-key": "market_ops_del_bid_create_1" },
    body: {
      bidId: "bid_ops_del_1",
      bidderAgentId: "agt_market_ops_del_bidder",
      amountCents: 1400,
      currency: "USD",
      etaSeconds: 600
    }
  });
  assert.equal(bid.statusCode, 201);

  const proposals = normalizeForCanonicalJson(bid.json?.bid?.negotiation?.proposals ?? [], { path: "$" });
  const latestProposal = proposals[proposals.length - 1];
  const runId = "run_market_ops_del_1";
  const signedAt = "2026-03-03T12:00:00.000Z";
  const delegationLink = buildDelegationLink({
    tenantId: createTask.json?.rfq?.tenantId,
    delegationId: "dlg_ops_del_1",
    principalAgentId: "agt_market_ops_del_operator",
    delegateAgentId: "agt_market_ops_del_delegate",
    scope: "marketplace.agreement.accept",
    issuedAt: "2026-03-01T00:00:00.000Z",
    expiresAt: "2026-03-10T00:00:00.000Z",
    signerKeyId: operatorRegistration.keyId,
    signerPrivateKeyPem: operatorKeypair.privateKeyPem
  });
  const actingOnBehalfOf = buildActingOnBehalfOf({
    principalAgentId: "agt_market_ops_del_operator",
    delegateAgentId: "agt_market_ops_del_delegate",
    delegationChain: [delegationLink]
  });
  const acceptanceCore = normalizeForCanonicalJson(
    {
      schemaVersion: "MarketplaceAgreementAcceptanceSignature.v2",
      agreementId: "agr_rfq_ops_del_1_bid_ops_del_1",
      tenantId: createTask.json?.rfq?.tenantId,
      rfqId: "rfq_ops_del_1",
      runId,
      bidId: "bid_ops_del_1",
      acceptedByAgentId: "agt_market_ops_del_operator",
      acceptedProposalId: latestProposal?.proposalId ?? null,
      acceptedRevision: Number.isSafeInteger(Number(latestProposal?.revision)) ? Number(latestProposal.revision) : null,
      acceptedProposalHash: latestProposal?.proposalHash ?? null,
      offerChainHash: sha256Hex(canonicalJsonStringify(proposals)),
      proposalCount: proposals.length,
      actingOnBehalfOfPrincipalAgentId: "agt_market_ops_del_operator",
      actingOnBehalfOfDelegateAgentId: "agt_market_ops_del_delegate",
      actingOnBehalfOfChainHash: actingOnBehalfOf.chainHash
    },
    { path: "$" }
  );
  const acceptanceHash = sha256Hex(canonicalJsonStringify(acceptanceCore));
  const signature = signHashHexEd25519(acceptanceHash, delegateKeypair.privateKeyPem);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_ops_del_1/accept",
    headers: { "x-idempotency-key": "market_ops_del_accept_valid_1" },
    body: {
      bidId: "bid_ops_del_1",
      runId,
      acceptedByAgentId: "agt_market_ops_del_operator",
      acceptanceSignature: {
        signerAgentId: "agt_market_ops_del_delegate",
        signerKeyId: delegateRegistration.keyId,
        signedAt,
        actingOnBehalfOf,
        signature
      }
    }
  });
  assert.equal(accept.statusCode, 200);

  const tracesByRun = await request(api, {
    method: "GET",
    path: `/ops/delegation/chains?runId=${encodeURIComponent(runId)}`,
    headers: opsHeaders
  });
  assert.equal(tracesByRun.statusCode, 200);
  assert.equal(tracesByRun.json?.total, 1);
  assert.equal(tracesByRun.json?.traces?.[0]?.contextType, "agreement_acceptance");
  assert.equal(tracesByRun.json?.traces?.[0]?.delegationChain?.[0]?.delegationId, "dlg_ops_del_1");

  const chainHash = tracesByRun.json?.traces?.[0]?.chainHash;
  assert.equal(typeof chainHash, "string");
  assert.ok(chainHash.length > 0);

  const tracesByChain = await request(api, {
    method: "GET",
    path: `/ops/delegation/chains/${encodeURIComponent(chainHash)}`,
    headers: opsHeaders
  });
  assert.equal(tracesByChain.statusCode, 200);
  assert.equal(tracesByChain.json?.total, 1);

  const revoke = await request(api, {
    method: "POST",
    path: "/ops/delegation/emergency-revoke",
    headers: opsHeaders,
    body: {
      delegationId: "dlg_ops_del_1",
      reason: "delegate compromised"
    }
  });
  assert.equal(revoke.statusCode, 200);
  assert.equal(revoke.json?.ok, true);
  assert.equal(revoke.json?.affectedTraceCount, 1);
  assert.equal(revoke.json?.revoked?.agents?.some((row) => row?.agentId === "agt_market_ops_del_delegate"), true);

  const delegateIdentity = await request(api, {
    method: "GET",
    path: "/agents/agt_market_ops_del_delegate"
  });
  assert.equal(delegateIdentity.statusCode, 200);
  assert.equal(delegateIdentity.json?.agentIdentity?.status, "revoked");

  const createTask2 = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_ops_del_rfq_create_2" },
    body: {
      rfqId: "rfq_ops_del_2",
      title: "Delegation blocked after revoke",
      capability: "translate",
      posterAgentId: "agt_market_ops_del_poster",
      budgetCents: 2100,
      currency: "USD"
    }
  });
  assert.equal(createTask2.statusCode, 201);

  const bid2 = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_ops_del_2/bids",
    headers: { "x-idempotency-key": "market_ops_del_bid_create_2" },
    body: {
      bidId: "bid_ops_del_2",
      bidderAgentId: "agt_market_ops_del_bidder",
      amountCents: 1300,
      currency: "USD",
      etaSeconds: 600
    }
  });
  assert.equal(bid2.statusCode, 201);

  const proposals2 = normalizeForCanonicalJson(bid2.json?.bid?.negotiation?.proposals ?? [], { path: "$" });
  const latestProposal2 = proposals2[proposals2.length - 1];
  const runId2 = "run_market_ops_del_2";
  const acceptanceCore2 = normalizeForCanonicalJson(
    {
      schemaVersion: "MarketplaceAgreementAcceptanceSignature.v2",
      agreementId: "agr_rfq_ops_del_2_bid_ops_del_2",
      tenantId: createTask2.json?.rfq?.tenantId,
      rfqId: "rfq_ops_del_2",
      runId: runId2,
      bidId: "bid_ops_del_2",
      acceptedByAgentId: "agt_market_ops_del_operator",
      acceptedProposalId: latestProposal2?.proposalId ?? null,
      acceptedRevision: Number.isSafeInteger(Number(latestProposal2?.revision)) ? Number(latestProposal2.revision) : null,
      acceptedProposalHash: latestProposal2?.proposalHash ?? null,
      offerChainHash: sha256Hex(canonicalJsonStringify(proposals2)),
      proposalCount: proposals2.length,
      actingOnBehalfOfPrincipalAgentId: "agt_market_ops_del_operator",
      actingOnBehalfOfDelegateAgentId: "agt_market_ops_del_delegate",
      actingOnBehalfOfChainHash: actingOnBehalfOf.chainHash
    },
    { path: "$" }
  );
  const acceptanceHash2 = sha256Hex(canonicalJsonStringify(acceptanceCore2));
  const signature2 = signHashHexEd25519(acceptanceHash2, delegateKeypair.privateKeyPem);

  const blocked = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_ops_del_2/accept",
    headers: { "x-idempotency-key": "market_ops_del_accept_blocked_2" },
    body: {
      bidId: "bid_ops_del_2",
      runId: runId2,
      acceptedByAgentId: "agt_market_ops_del_operator",
      acceptanceSignature: {
        signerAgentId: "agt_market_ops_del_delegate",
        signerKeyId: delegateRegistration.keyId,
        signedAt,
        actingOnBehalfOf,
        signature: signature2
      }
    }
  });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json?.error, "invalid acceptance signature");

  const audit = await request(api, {
    method: "GET",
    path: "/ops/audit?limit=20",
    headers: opsHeaders
  });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json?.audit?.some((row) => row?.action === "DELEGATION_EMERGENCY_REVOKE"), true);
});

test("API e2e: counterOfferPolicy enforces proposer role, max revisions, and timeout expiry", async () => {
  let nowMs = Date.parse("2026-03-01T00:00:00.000Z");
  const api = createApi({
    now: () => new Date(nowMs).toISOString()
  });
  await registerAgent(api, "agt_market_policy_poster");
  await registerAgent(api, "agt_market_policy_bidder");
  await creditWallet(api, {
    agentId: "agt_market_policy_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_market_policy_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_policy_rfq_create_1" },
    body: {
      rfqId: "rfq_policy_1",
      title: "Policy constrained task",
      capability: "translate",
      posterAgentId: "agt_market_policy_poster",
      budgetCents: 2000,
      currency: "USD",
      counterOfferPolicy: {
        allowPosterCounterOffers: false,
        allowBidderCounterOffers: true,
        maxRevisions: 2,
        timeoutSeconds: 1
      }
    }
  });
  assert.equal(createTask.statusCode, 201);
  assert.equal(createTask.json?.rfq?.counterOfferPolicy?.allowPosterCounterOffers, false);
  assert.equal(createTask.json?.rfq?.counterOfferPolicy?.allowBidderCounterOffers, true);
  assert.equal(createTask.json?.rfq?.counterOfferPolicy?.maxRevisions, 2);
  assert.equal(createTask.json?.rfq?.counterOfferPolicy?.timeoutSeconds, 1);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_1/bids",
    headers: { "x-idempotency-key": "market_policy_bid_1" },
    body: {
      bidId: "bid_policy_1",
      bidderAgentId: "agt_market_policy_bidder",
      amountCents: 1200,
      currency: "USD"
    }
  });
  assert.equal(bid.statusCode, 201);
  assert.equal(bid.json?.bid?.counterOfferPolicy?.maxRevisions, 2);
  const initialProposalId = bid.json?.bid?.negotiation?.proposals?.[0]?.proposalId;
  assert.ok(typeof initialProposalId === "string" && initialProposalId.length > 0);

  const blockedPosterCounter = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_1/bids/bid_policy_1/counter-offer",
    headers: { "x-idempotency-key": "market_policy_counter_blocked_1" },
    body: {
      proposerAgentId: "agt_market_policy_poster",
      amountCents: 1100
    }
  });
  assert.equal(blockedPosterCounter.statusCode, 409);

  const bidderCounter = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_1/bids/bid_policy_1/counter-offer",
    headers: { "x-idempotency-key": "market_policy_counter_bidder_1" },
    body: {
      proposerAgentId: "agt_market_policy_bidder",
      amountCents: 1150
    }
  });
  assert.equal(bidderCounter.statusCode, 200);
  assert.equal(bidderCounter.json?.negotiation?.latestRevision, 2);
  const latestProposalId = bidderCounter.json?.proposal?.proposalId;
  assert.ok(typeof latestProposalId === "string" && latestProposalId.length > 0);

  const overRevisionCounter = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_1/bids/bid_policy_1/counter-offer",
    headers: { "x-idempotency-key": "market_policy_counter_bidder_2" },
    body: {
      proposerAgentId: "agt_market_policy_bidder",
      amountCents: 1140
    }
  });
  assert.equal(overRevisionCounter.statusCode, 409);

  nowMs += 2_000;

  const acceptAfterTimeout = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_policy_1/accept",
    headers: { "x-idempotency-key": "market_policy_accept_1" },
    body: {
      bidId: "bid_policy_1",
      acceptedByAgentId: "agt_market_policy_poster"
    }
  });
  assert.equal(acceptAfterTimeout.statusCode, 409);
  assert.equal(acceptAfterTimeout.json?.error, "marketplace bid negotiation expired");

  const bidsAfterTimeout = await request(api, {
    method: "GET",
    path: "/marketplace/rfqs/rfq_policy_1/bids?status=all"
  });
  assert.equal(bidsAfterTimeout.statusCode, 200);
  assert.equal(bidsAfterTimeout.json?.bids?.[0]?.negotiation?.state, "expired");
  assert.ok(typeof bidsAfterTimeout.json?.bids?.[0]?.negotiation?.expiredAt === "string");

  const lifecycleArtifacts = await api.store.listArtifacts({
    tenantId: "tenant_default",
    sourceEventId: latestProposalId,
    artifactType: "MarketplaceLifecycle.v1"
  });
  const submitted = lifecycleArtifacts.filter((row) => row?.eventType === "proposal.submitted");
  const expired = lifecycleArtifacts.filter((row) => row?.eventType === "proposal.expired");
  assert.equal(submitted.length, 1);
  assert.equal(expired.length, 1);
});

test("API e2e: agreement cancellation before run start enforces evidence and applies kill fee settlement", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_cancel_poster");
  await registerAgent(api, "agt_market_cancel_bidder");
  await registerAgent(api, "agt_market_cancel_operator");
  await creditWallet(api, {
    agentId: "agt_market_cancel_poster",
    amountCents: 10000,
    idempotencyKey: "wallet_credit_market_cancel_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_cancel_rfq_create_1" },
    body: {
      rfqId: "rfq_cancel_1",
      title: "Cancelable task",
      capability: "translate",
      posterAgentId: "agt_market_cancel_poster",
      budgetCents: 2500,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_cancel_1/bids",
    headers: { "x-idempotency-key": "market_cancel_bid_create_1" },
    body: {
      bidId: "bid_cancel_1",
      bidderAgentId: "agt_market_cancel_bidder",
      amountCents: 2000,
      currency: "USD",
      etaSeconds: 900
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_cancel_1/accept",
    headers: { "x-idempotency-key": "market_cancel_accept_1" },
    body: {
      bidId: "bid_cancel_1",
      acceptedByAgentId: "agt_market_cancel_operator",
      agreementTerms: {
        cancellation: {
          allowCancellationBeforeStart: true,
          killFeeRatePct: 15,
          requireEvidenceOnCancellation: true
        }
      }
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);
  assert.ok(typeof accept.json?.agreement?.acceptedProposalId === "string" && accept.json?.agreement?.acceptedProposalId.length > 0);

  const cancelWithoutEvidence = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/cancel`,
    headers: { "x-idempotency-key": "market_cancel_before_start_0" },
    body: {
      cancellationId: "cancel_rfq_1_missing",
      cancelledByAgentId: "agt_market_cancel_poster",
      reason: "customer cancelled before dispatch"
    }
  });
  assert.equal(cancelWithoutEvidence.statusCode, 400);
  assert.equal(cancelWithoutEvidence.json?.error, "agreement cancellation requires evidenceRef");

  const cancel = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/cancel`,
    headers: { "x-idempotency-key": "market_cancel_before_start_1" },
    body: {
      cancellationId: "cancel_rfq_1",
      cancelledByAgentId: "agt_market_cancel_poster",
      reason: "customer cancelled before dispatch",
      evidenceRef: `evidence://${runId}/cancel_note.txt`
    }
  });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.json?.rfq?.status, "cancelled");
  assert.equal(cancel.json?.run?.status, "failed");
  assert.equal(cancel.json?.settlement?.status, "released");
  assert.equal(cancel.json?.settlement?.releaseRatePct, 15);
  assert.equal(cancel.json?.settlement?.releasedAmountCents, 300);
  assert.equal(cancel.json?.settlement?.refundedAmountCents, 1700);
  assert.equal(cancel.json?.settlement?.decisionStatus, "manual_resolved");
  assert.equal(cancel.json?.settlement?.decisionMode, "manual-review");
  assert.equal(cancel.json?.cancellation?.cancellationId, "cancel_rfq_1");
  assert.equal(cancel.json?.cancellation?.killFeeRatePct, 15);
  assert.equal(cancel.json?.cancellation?.releasedAmountCents, 300);
  assert.equal(cancel.json?.cancellation?.refundedAmountCents, 1700);
  assert.equal(cancel.json?.rfq?.metadata?.cancellation?.cancellationId, "cancel_rfq_1");

  const posterWallet = await request(api, {
    method: "GET",
    path: "/agents/agt_market_cancel_poster/wallet"
  });
  assert.equal(posterWallet.statusCode, 200);
  assert.equal(posterWallet.json?.wallet?.availableCents, 9700);
  assert.equal(posterWallet.json?.wallet?.escrowLockedCents, 0);

  const bidderWallet = await request(api, {
    method: "GET",
    path: "/agents/agt_market_cancel_bidder/wallet"
  });
  assert.equal(bidderWallet.statusCode, 200);
  assert.equal(bidderWallet.json?.wallet?.availableCents, 300);
  assert.equal(bidderWallet.json?.wallet?.escrowLockedCents, 0);

  const eventAfterCancel = await request(api, {
    method: "POST",
    path: `/agents/agt_market_cancel_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": cancel.json?.run?.lastChainHash,
      "x-idempotency-key": "market_cancel_append_after_terminal_1"
    },
    body: {
      type: "RUN_HEARTBEAT",
      payload: {
        progressPct: 10
      }
    }
  });
  assert.equal(eventAfterCancel.statusCode, 400);
  assert.equal(eventAfterCancel.json?.error, "run update rejected");

  const lifecycleArtifacts = await api.store.listArtifacts({
    tenantId: "tenant_default",
    rfqId: "rfq_cancel_1",
    artifactType: "MarketplaceLifecycle.v1"
  });
  const agreementCancelled = lifecycleArtifacts.filter((row) => row?.eventType === "marketplace.agreement.cancelled");
  const proposalCancelled = lifecycleArtifacts.filter((row) => row?.eventType === "proposal.cancelled");
  assert.equal(agreementCancelled.length, 1);
  assert.equal(agreementCancelled[0]?.sourceEventId, "cancel_rfq_1");
  assert.equal(proposalCancelled.length, 1);
  assert.equal(proposalCancelled[0]?.sourceEventId, accept.json?.agreement?.acceptedProposalId);
});

test("API e2e: agreement cancellation enforces counterparty signoff and dispute-first after start", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_cancel_guard_poster");
  await registerAgent(api, "agt_market_cancel_guard_bidder");
  await registerAgent(api, "agt_market_cancel_guard_operator");
  await creditWallet(api, {
    agentId: "agt_market_cancel_guard_poster",
    amountCents: 5000,
    idempotencyKey: "wallet_credit_market_cancel_guard_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_cancel_guard_rfq_create_1" },
    body: {
      rfqId: "rfq_cancel_guard_1",
      title: "Cancelable with signoff",
      capability: "translate",
      posterAgentId: "agt_market_cancel_guard_poster",
      budgetCents: 1200,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_cancel_guard_1/bids",
    headers: { "x-idempotency-key": "market_cancel_guard_bid_create_1" },
    body: {
      bidId: "bid_cancel_guard_1",
      bidderAgentId: "agt_market_cancel_guard_bidder",
      amountCents: 1000,
      currency: "USD"
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_cancel_guard_1/accept",
    headers: { "x-idempotency-key": "market_cancel_guard_accept_1" },
    body: {
      bidId: "bid_cancel_guard_1",
      acceptedByAgentId: "agt_market_cancel_guard_operator",
      agreementTerms: {
        cancellation: {
          allowCancellationBeforeStart: true,
          killFeeRatePct: 0,
          requireEvidenceOnCancellation: false,
          requireCounterpartyAcceptance: true
        }
      }
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const cancelMissingAcceptance = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/cancel`,
    headers: { "x-idempotency-key": "market_cancel_guard_missing_accept_1" },
    body: {
      cancellationId: "cancel_guard_missing_accept",
      cancelledByAgentId: "agt_market_cancel_guard_poster",
      reason: "customer cancelled before dispatch"
    }
  });
  assert.equal(cancelMissingAcceptance.statusCode, 400);
  assert.equal(cancelMissingAcceptance.json?.error, "acceptedByAgentId is required by agreement cancellation policy");

  const cancelWithNonCounterparty = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/cancel`,
    headers: { "x-idempotency-key": "market_cancel_guard_non_counterparty_1" },
    body: {
      cancellationId: "cancel_guard_non_counterparty",
      cancelledByAgentId: "agt_market_cancel_guard_poster",
      acceptedByAgentId: "agt_market_cancel_guard_operator",
      reason: "customer cancelled before dispatch"
    }
  });
  assert.equal(cancelWithNonCounterparty.statusCode, 409);
  assert.equal(cancelWithNonCounterparty.json?.error, "acceptedByAgentId must be a marketplace agreement counterparty");

  const runStart = await request(api, {
    method: "POST",
    path: `/agents/agt_market_cancel_guard_bidder/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": "market_cancel_guard_run_started_1"
    },
    body: {
      type: "RUN_STARTED",
      payload: {
        taskRef: `marketplace://rfqs/rfq_cancel_guard_1`
      }
    }
  });
  assert.equal(runStart.statusCode, 201);

  const cancelAfterStart = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/cancel`,
    headers: { "x-idempotency-key": "market_cancel_guard_after_start_1" },
    body: {
      cancellationId: "cancel_guard_after_start",
      cancelledByAgentId: "agt_market_cancel_guard_poster",
      acceptedByAgentId: "agt_market_cancel_guard_bidder",
      reason: "customer cancelled after start"
    }
  });
  assert.equal(cancelAfterStart.statusCode, 409);
  assert.equal(
    cancelAfterStart.json?.error,
    "agreement cancellation is only allowed before run start; use /runs/{runId}/dispute/open"
  );
});

test("API e2e: agreement cancellation accepts optional counterparty signature", async () => {
  const api = createApi();
  await registerAgent(api, "agt_market_cancel_sig_poster");
  const bidderKeypair = createEd25519Keypair();
  const bidderRegistration = await registerAgent(api, "agt_market_cancel_sig_bidder", {
    publicKeyPem: bidderKeypair.publicKeyPem
  });
  await registerAgent(api, "agt_market_cancel_sig_operator");
  await creditWallet(api, {
    agentId: "agt_market_cancel_sig_poster",
    amountCents: 7000,
    idempotencyKey: "wallet_credit_market_cancel_sig_poster_1"
  });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": "market_cancel_sig_rfq_create_1" },
    body: {
      rfqId: "rfq_cancel_sig_1",
      title: "Signed cancellation task",
      capability: "translate",
      posterAgentId: "agt_market_cancel_sig_poster",
      budgetCents: 2200,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201);

  const bid = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_cancel_sig_1/bids",
    headers: { "x-idempotency-key": "market_cancel_sig_bid_create_1" },
    body: {
      bidId: "bid_cancel_sig_1",
      bidderAgentId: "agt_market_cancel_sig_bidder",
      amountCents: 1400,
      currency: "USD"
    }
  });
  assert.equal(bid.statusCode, 201);

  const accept = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs/rfq_cancel_sig_1/accept",
    headers: { "x-idempotency-key": "market_cancel_sig_accept_1" },
    body: {
      bidId: "bid_cancel_sig_1",
      acceptedByAgentId: "agt_market_cancel_sig_operator",
      agreementTerms: {
        cancellation: {
          allowCancellationBeforeStart: true,
          killFeeRatePct: 10,
          requireEvidenceOnCancellation: false,
          requireCounterpartyAcceptance: true
        }
      }
    }
  });
  assert.equal(accept.statusCode, 200);
  const runId = accept.json?.run?.runId;

  const cancellationCore = normalizeForCanonicalJson(
    {
      schemaVersion: "MarketplaceAgreementCancellationAcceptanceSignature.v2",
      tenantId: accept.json?.agreement?.tenantId,
      runId,
      agreementId: accept.json?.agreement?.agreementId,
      rfqId: accept.json?.agreement?.rfqId,
      bidId: accept.json?.agreement?.bidId,
      cancellationId: "cancel_sig_1",
      cancelledByAgentId: "agt_market_cancel_sig_poster",
      acceptedByAgentId: "agt_market_cancel_sig_bidder",
      reason: "cancel before start",
      evidenceRef: "evidence://cancel_sig",
      termsHash: accept.json?.agreement?.termsHash,
      killFeeRatePct: 10,
      actingOnBehalfOfPrincipalAgentId: null,
      actingOnBehalfOfDelegateAgentId: null,
      actingOnBehalfOfChainHash: null
    },
    { path: "$" }
  );
  const cancellationHash = sha256Hex(canonicalJsonStringify(cancellationCore));
  const cancellationSignature = signHashHexEd25519(cancellationHash, bidderKeypair.privateKeyPem);
  const invalidCancellationSignature = `${cancellationSignature.slice(0, -2)}ab`;

  const cancellationInvalid = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/cancel`,
    headers: { "x-idempotency-key": "market_cancel_sig_invalid_1" },
    body: {
      cancellationId: "cancel_sig_1",
      cancelledByAgentId: "agt_market_cancel_sig_poster",
      acceptedByAgentId: "agt_market_cancel_sig_bidder",
      reason: "cancel before start",
      evidenceRef: "evidence://cancel_sig",
      acceptanceSignature: {
        signerAgentId: "agt_market_cancel_sig_bidder",
        signerKeyId: bidderRegistration.keyId,
        signedAt: "2026-03-04T10:30:00.000Z",
        signature: invalidCancellationSignature
      }
    }
  });
  assert.equal(cancellationInvalid.statusCode, 400);
  assert.equal(cancellationInvalid.json?.error, "invalid acceptance signature");

  const cancellation = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/agreement/cancel`,
    headers: { "x-idempotency-key": "market_cancel_sig_valid_1" },
    body: {
      cancellationId: "cancel_sig_1",
      cancelledByAgentId: "agt_market_cancel_sig_poster",
      acceptedByAgentId: "agt_market_cancel_sig_bidder",
      reason: "cancel before start",
      evidenceRef: "evidence://cancel_sig",
      acceptanceSignature: {
        signerAgentId: "agt_market_cancel_sig_bidder",
        signerKeyId: bidderRegistration.keyId,
        signedAt: "2026-03-04T10:30:00.000Z",
        signature: cancellationSignature
      }
    }
  });
  assert.equal(cancellation.statusCode, 200);
  assert.equal(cancellation.json?.acceptanceSignatureVerification?.present, true);
  assert.equal(cancellation.json?.acceptanceSignatureVerification?.valid, true);
  assert.equal(
    cancellation.json?.cancellation?.acceptanceSignature?.schemaVersion,
    "MarketplaceAgreementCancellationAcceptanceSignature.v2"
  );
  assert.equal(cancellation.json?.cancellation?.acceptanceSignature?.acceptanceHash, cancellationHash);
  assert.equal(cancellation.json?.cancellation?.acceptanceSignature?.signerAgentId, "agt_market_cancel_sig_bidder");
});
