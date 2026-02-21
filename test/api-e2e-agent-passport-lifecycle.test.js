import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";
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
}

function buildProtocolAgentPassport({ agentId, passportId, nowAt }) {
  return {
    schemaVersion: "AgentPassport.v1",
    passportId,
    agentId,
    tenantId: "tenant_default",
    principalRef: {
      principalType: "service",
      principalId: `principal_${agentId}`
    },
    identityAnchors: {
      jwksUri: "https://example.com/.well-known/jwks.json",
      activeKeyId: `key_${agentId}`,
      keysetHash: sha256Hex(`keyset_${agentId}`)
    },
    delegationRoot: {
      rootGrantId: `grant_${passportId}`,
      rootGrantHash: sha256Hex(`root_${passportId}`),
      issuedAt: nowAt,
      expiresAt: null,
      revokedAt: null
    },
    policyEnvelope: {
      maxPerCallCents: 2500,
      maxDailyCents: 25000,
      allowedRiskClasses: ["read", "compute", "action", "financial"],
      requireApprovalAboveCents: null
    },
    status: "active",
    createdAt: nowAt,
    updatedAt: nowAt
  };
}

test("API e2e: issue/get/revoke agent passport lifecycle", async () => {
  const api = createApi();
  const agentId = "agt_passport_lifecycle_1";
  const nowAt = "2026-02-21T00:00:00.000Z";

  await registerAgent(api, { agentId });
  const issue = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/passport`,
    headers: { "x-idempotency-key": "passport_issue_1" },
    body: {
      agentPassport: buildProtocolAgentPassport({
        agentId,
        passportId: "pass_lifecycle_1",
        nowAt
      })
    }
  });
  assert.equal(issue.statusCode, 201, issue.body);
  assert.equal(issue.json?.agentPassport?.schemaVersion, "AgentPassport.v1");
  assert.equal(issue.json?.agentPassport?.agentId, agentId);
  assert.equal(issue.json?.agentPassport?.tenantId, "tenant_default");
  assert.equal(issue.json?.agentPassport?.status, "active");
  assert.equal(issue.json?.agentPassport?.passportId, "pass_lifecycle_1");

  const fetched = await request(api, {
    method: "GET",
    path: `/agents/${encodeURIComponent(agentId)}/passport`
  });
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(fetched.json?.agentPassport?.passportId, "pass_lifecycle_1");
  assert.equal(fetched.json?.agentPassport?.status, "active");

  const revoked = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/passport/revoke`,
    headers: { "x-idempotency-key": "passport_revoke_1" },
    body: {
      reasonCode: "MANUAL_REVIEW",
      reason: "risk escalation"
    }
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json?.agentPassport?.status, "revoked");
  assert.equal(revoked.json?.agentPassport?.metadata?.lifecycle?.reasonCode, "MANUAL_REVIEW");
  assert.equal(revoked.json?.agentPassport?.metadata?.lifecycle?.reasonMessage, "risk escalation");
  assert.ok(typeof revoked.json?.agentPassport?.delegationRoot?.revokedAt === "string");

  const fetchedRevoked = await request(api, {
    method: "GET",
    path: `/agents/${encodeURIComponent(agentId)}/passport`
  });
  assert.equal(fetchedRevoked.statusCode, 200, fetchedRevoked.body);
  assert.equal(fetchedRevoked.json?.agentPassport?.status, "revoked");
});

test("API e2e: agent passport endpoint enforces idempotency and identity binding", async () => {
  const api = createApi();
  const agentId = "agt_passport_lifecycle_2";
  const nowAt = "2026-02-21T00:01:00.000Z";
  await registerAgent(api, { agentId });

  const first = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/passport`,
    headers: { "x-idempotency-key": "passport_issue_2" },
    body: {
      agentPassport: buildProtocolAgentPassport({
        agentId,
        passportId: "pass_lifecycle_2",
        nowAt
      })
    }
  });
  assert.equal(first.statusCode, 201, first.body);

  const replay = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/passport`,
    headers: { "x-idempotency-key": "passport_issue_2" },
    body: {
      agentPassport: buildProtocolAgentPassport({
        agentId,
        passportId: "pass_lifecycle_2",
        nowAt
      })
    }
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json?.agentPassport?.passportId, "pass_lifecycle_2");

  const mismatchIdempotency = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/passport`,
    headers: { "x-idempotency-key": "passport_issue_2" },
    body: {
      agentPassport: buildProtocolAgentPassport({
        agentId,
        passportId: "pass_lifecycle_2_changed",
        nowAt
      })
    }
  });
  assert.equal(mismatchIdempotency.statusCode, 409, mismatchIdempotency.body);

  const agentMismatch = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/passport`,
    headers: { "x-idempotency-key": "passport_issue_2_mismatch" },
    body: {
      agentPassport: buildProtocolAgentPassport({
        agentId: "agt_other",
        passportId: "pass_lifecycle_2_other",
        nowAt
      })
    }
  });
  assert.equal(agentMismatch.statusCode, 409, agentMismatch.body);
  assert.equal(agentMismatch.json?.error?.code ?? agentMismatch.json?.code, "AGENT_PASSPORT_AGENT_MISMATCH");
});
