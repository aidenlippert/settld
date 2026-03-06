import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("API e2e: ops policy workspace page renders control-plane UX", async () => {
  const api = createApi({
    opsTokens: ["tok_opsr:ops_read", "tok_opsw:ops_write", "tok_aud:audit_read"].join(";")
  });

  const workspace = await request(api, {
    method: "GET",
    path: "/ops/policy/workspace",
    headers: {
      "x-proxy-tenant-id": "tenant_policy_workspace",
      "x-proxy-ops-token": "tok_opsr"
    },
    auth: "none"
  });
  assert.equal(workspace.statusCode, 200, workspace.body);
  assert.ok(String(workspace.headers?.get("content-type") ?? "").includes("text/html"));
  assert.match(workspace.body, /Settlement Policy Control Plane/);
  assert.match(workspace.body, /id="policyControlWorkspaceRoot"/);
  assert.match(workspace.body, /id="policyVersionsTable"/);
  assert.match(workspace.body, /id="policyRolloutHistoryTable"/);
  assert.match(workspace.body, /id="policyUpsertBtn"/);
  assert.match(workspace.body, /id="policyRolloutBtn"/);
  assert.match(workspace.body, /id="policyRollbackBtn"/);
  assert.match(workspace.body, /id="policyDiffBtn"/);
  assert.match(workspace.body, /\/ops\/settlement-policies\/state/);
  assert.match(workspace.body, /\/ops\/settlement-policies\/rollout/);
  assert.match(workspace.body, /\/ops\/settlement-policies\/rollback/);
  assert.match(workspace.body, /\/ops\/settlement-policies\/diff/);
  assert.match(workspace.body, /\/runs\/\$\{encodeURIComponent\(runId\)\}\/settlement\/policy-replay/);
  assert.match(workspace.body, /x-nooterra-protocol/);

  const queryAuthWorkspace = await request(api, {
    method: "GET",
    path: "/ops/policy/workspace?tenantId=tenant_policy_workspace&opsToken=tok_opsr",
    headers: {},
    auth: "none"
  });
  assert.equal(queryAuthWorkspace.statusCode, 403, queryAuthWorkspace.body);

  const forbidden = await request(api, {
    method: "GET",
    path: "/ops/policy/workspace?tenantId=tenant_policy_workspace&opsToken=tok_aud",
    headers: {},
    auth: "none"
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

test("API e2e: ops settlement policy control endpoints support state, rollout, rollback, and diff", async () => {
  const api = createApi({
    opsTokens: ["tok_opsr:ops_read", "tok_opsw:ops_write", "tok_aud:audit_read"].join(";")
  });
  const writeHeaders = {
    "x-proxy-tenant-id": "tenant_policy_workspace",
    "x-proxy-ops-token": "tok_opsw",
    "x-nooterra-protocol": "1.0"
  };
  const readHeaders = {
    "x-proxy-tenant-id": "tenant_policy_workspace",
    "x-proxy-ops-token": "tok_opsr"
  };

  const upsertV1 = await request(api, {
    method: "POST",
    path: "/marketplace/settlement-policies",
    headers: {
      ...writeHeaders,
      "x-idempotency-key": "policy_workspace_upsert_v1"
    },
    body: {
      policyId: "market.default.auto-v1",
      policyVersion: 1,
      verificationMethod: {
        mode: "deterministic",
        source: "verifier://nooterra-verify"
      },
      policy: {
        mode: "automatic",
        rules: {
          requireDeterministicVerification: true,
          autoReleaseOnGreen: true,
          autoReleaseOnAmber: false,
          autoReleaseOnRed: false,
          greenReleaseRatePct: 100,
          amberReleaseRatePct: 20,
          redReleaseRatePct: 0
        }
      },
      description: "baseline active policy"
    }
  });
  assert.equal(upsertV1.statusCode, 201, upsertV1.body);

  const upsertV2 = await request(api, {
    method: "POST",
    path: "/marketplace/settlement-policies",
    headers: {
      ...writeHeaders,
      "x-idempotency-key": "policy_workspace_upsert_v2"
    },
    body: {
      policyId: "market.default.auto-v1",
      policyVersion: 2,
      verificationMethod: {
        mode: "deterministic",
        source: "verifier://nooterra-verify"
      },
      policy: {
        mode: "automatic",
        rules: {
          requireDeterministicVerification: true,
          autoReleaseOnGreen: true,
          autoReleaseOnAmber: false,
          autoReleaseOnRed: false,
          greenReleaseRatePct: 100,
          amberReleaseRatePct: 35,
          redReleaseRatePct: 0
        }
      },
      description: "candidate rollout policy"
    }
  });
  assert.equal(upsertV2.statusCode, 201, upsertV2.body);

  const stateBefore = await request(api, {
    method: "GET",
    path: "/ops/settlement-policies/state?policyId=market.default.auto-v1",
    headers: readHeaders
  });
  assert.equal(stateBefore.statusCode, 200, stateBefore.body);
  assert.equal(stateBefore.json?.policies?.length, 2);
  assert.equal(stateBefore.json?.rollout?.stages?.active?.policyId, "market.default.auto-v1");
  assert.equal(stateBefore.json?.rollout?.stages?.active?.policyVersion, 2);

  const rolloutDraft = await request(api, {
    method: "POST",
    path: "/ops/settlement-policies/rollout",
    headers: {
      ...writeHeaders,
      "x-idempotency-key": "policy_workspace_rollout_draft"
    },
    body: {
      stage: "draft",
      policyRef: {
        policyId: "market.default.auto-v1",
        policyVersion: 1
      },
      note: "queue v1 for comparison"
    }
  });
  assert.equal(rolloutDraft.statusCode, 200, rolloutDraft.body);
  assert.equal(rolloutDraft.json?.action, "draft_selected");

  const rolloutActive = await request(api, {
    method: "POST",
    path: "/ops/settlement-policies/rollout",
    headers: {
      ...writeHeaders,
      "x-idempotency-key": "policy_workspace_rollout_active"
    },
    body: {
      stage: "active",
      policyRef: {
        policyId: "market.default.auto-v1",
        policyVersion: 1
      },
      note: "manual promotion for test"
    }
  });
  assert.equal(rolloutActive.statusCode, 200, rolloutActive.body);
  assert.equal(rolloutActive.json?.action, "active_promoted");
  assert.equal(rolloutActive.json?.rollout?.stages?.active?.policyVersion, 1);

  const rollback = await request(api, {
    method: "POST",
    path: "/ops/settlement-policies/rollback",
    headers: {
      ...writeHeaders,
      "x-idempotency-key": "policy_workspace_rollback"
    },
    body: {
      note: "restore previous stable policy"
    }
  });
  assert.equal(rollback.statusCode, 200, rollback.body);
  assert.equal(rollback.json?.action, "active_rollback");
  assert.equal(rollback.json?.rollout?.stages?.active?.policyVersion, 2);

  const stateAfter = await request(api, {
    method: "GET",
    path: "/ops/settlement-policies/state?policyId=market.default.auto-v1",
    headers: readHeaders
  });
  assert.equal(stateAfter.statusCode, 200, stateAfter.body);
  assert.equal(stateAfter.json?.rollout?.stages?.active?.policyVersion, 2);
  assert.ok((stateAfter.json?.rolloutHistory?.length ?? 0) >= 2);

  const diff = await request(api, {
    method: "GET",
    path: "/ops/settlement-policies/diff?fromPolicyId=market.default.auto-v1&fromPolicyVersion=1&toPolicyId=market.default.auto-v1&toPolicyVersion=2",
    headers: readHeaders
  });
  assert.equal(diff.statusCode, 200, diff.body);
  assert.equal(diff.json?.schemaVersion, "TenantSettlementPolicyDiff.v1");
  assert.equal(diff.json?.fromPolicyRef?.policyVersion, 1);
  assert.equal(diff.json?.toPolicyRef?.policyVersion, 2);
  assert.ok((diff.json?.summary?.changed ?? 0) >= 1);
  assert.ok(Array.isArray(diff.json?.changes));
});
