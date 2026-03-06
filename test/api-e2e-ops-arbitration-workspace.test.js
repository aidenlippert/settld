import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { canonicalJsonStringify, normalizeForCanonicalJson } from "../src/core/canonical-json.js";
import { createEd25519Keypair, sha256Hex, signHashHexEd25519 } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { tenantId, agentId, ownerId = "svc_arb_workspace_test", publicKeyPem: providedPublicKeyPem = null }) {
  const publicKeyPem = providedPublicKeyPem ?? createEd25519Keypair().publicKeyPem;
  const created = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `register_${tenantId}_${agentId}`
    },
    body: {
      agentId,
      displayName: agentId,
      owner: { ownerType: "service", ownerId },
      publicKeyPem
    }
  });
  assert.equal(created.statusCode, 201);
  return {
    keyId: created.json?.keyId ?? null,
    publicKeyPem
  };
}

async function createArbitrationCaseFixture(
  api,
  { tenantId, payerAgentId, payeeAgentId, arbiterAgentId, runId, disputeId, caseId, evidenceRefs, idempotencyPrefix }
) {
  const createdRun = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_create`
    },
    body: {
      runId,
      taskType: "analysis",
      settlement: {
        payerAgentId,
        amountCents: 1200,
        currency: "USD",
        disputeWindowDays: 3
      }
    }
  });
  assert.equal(createdRun.statusCode, 201);

  const prevChainHash = createdRun.json?.run?.lastChainHash;
  assert.ok(prevChainHash);
  const completed = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_complete`,
      "x-proxy-expected-prev-chain-hash": prevChainHash
    },
    body: {
      type: "RUN_COMPLETED",
      payload: { outputRef: `evidence://${runId}/output.json` }
    }
  });
  assert.equal(completed.statusCode, 201);

  const openedDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_dispute_open`
    },
    body: {
      disputeId,
      openedByAgentId: payerAgentId,
      reason: "workspace packet test",
      disputePriority: "high",
      evidenceRefs
    }
  });
  assert.equal(openedDispute.statusCode, 200);

  const openedArbitration = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/open`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_arbitration_open`
    },
    body: {
      disputeId,
      caseId,
      arbiterAgentId,
      evidenceRefs
    }
  });
  assert.equal(openedArbitration.statusCode, 201);
}

test("API e2e: ops arbitration workspace page renders queue + case workspace controls", async () => {
  const api = createApi({
    opsTokens: ["tok_finr:finance_read", "tok_finw:finance_write", "tok_opsr:ops_read", "tok_aud:audit_read"].join(";")
  });

  const workspace = await request(api, {
    method: "GET",
    path: "/ops/arbitration/workspace",
    headers: {
      "x-proxy-tenant-id": "tenant_arb_workspace",
      "x-proxy-ops-token": "tok_finr"
    },
    auth: "none"
  });
  assert.equal(workspace.statusCode, 200, workspace.body);
  assert.ok(String(workspace.headers?.get("content-type") ?? "").includes("text/html"));
  assert.match(workspace.body, /Arbitration Operator Workspace/);
  assert.match(workspace.body, /id="arbitrationWorkspaceRoot"/);
  assert.match(workspace.body, /id="arbitrationQueueTable"/);
  assert.match(workspace.body, /id="arbitrationCasePanel"/);
  assert.match(workspace.body, /id="arbitrationEvidenceTimeline"/);
  assert.match(workspace.body, /id="arbitrationRelatedCases"/);
  assert.match(workspace.body, /id="arbitrationAppealChain"/);
  assert.match(workspace.body, /id="arbitrationAuditLinks"/);
  assert.match(workspace.body, /id="assignArbiterBtn"/);
  assert.match(workspace.body, /id="submitVerdictBtn"/);
  assert.match(workspace.body, /id="openAppealBtn"/);
  assert.match(workspace.body, /\/ops\/arbitration\/queue/);
  assert.match(workspace.body, /x-nooterra-protocol/);

  const workspaceWithQueryAuth = await request(api, {
    method: "GET",
    path: "/ops/arbitration/workspace?tenantId=tenant_arb_workspace&opsToken=tok_finr",
    headers: {},
    auth: "none"
  });
  assert.equal(workspaceWithQueryAuth.statusCode, 403, workspaceWithQueryAuth.body);

  const forbidden = await request(api, {
    method: "GET",
    path: "/ops/arbitration/workspace?tenantId=tenant_arb_workspace&opsToken=tok_aud",
    headers: {},
    auth: "none"
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

test("API e2e: ops arbitration case workspace endpoint returns packet + actionability", async () => {
  let nowAt = "2026-02-09T10:00:00.000Z";
  const api = createApi({
    now: () => nowAt,
    opsTokens: ["tok_finr:finance_read", "tok_finw:finance_write", "tok_opsr:ops_read", "tok_aud:audit_read"].join(";")
  });

  const tenantId = "tenant_arb_case_workspace";
  const payerAgentId = "agt_arb_ws_payer";
  const payeeAgentId = "agt_arb_ws_payee";
  const arbiterAgentId = "agt_arb_ws_arbiter";
  const runId = "run_arb_ws_1";
  const disputeId = "dispute_arb_ws_1";
  const caseId = "arb_case_ws_1";
  const evidenceRefs = ["evidence://arb/ws/1.json", "evidence://arb/ws/2.json"];

  await registerAgent(api, { tenantId, agentId: payerAgentId });
  await registerAgent(api, { tenantId, agentId: payeeAgentId });
  await registerAgent(api, { tenantId, agentId: arbiterAgentId });

  const credit = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "arb_ws_credit_1"
    },
    body: {
      amountCents: 10000,
      currency: "USD"
    }
  });
  assert.equal(credit.statusCode, 201);

  await createArbitrationCaseFixture(api, {
    tenantId,
    payerAgentId,
    payeeAgentId,
    arbiterAgentId,
    runId,
    disputeId,
    caseId,
    evidenceRefs,
    idempotencyPrefix: "arb_ws_case_1"
  });

  nowAt = "2026-02-09T12:00:00.000Z";

  const workspaceRead = await request(api, {
    method: "GET",
    path: `/ops/arbitration/cases/${encodeURIComponent(caseId)}/workspace?slaHours=24`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(workspaceRead.statusCode, 200, workspaceRead.body);
  assert.equal(workspaceRead.json?.tenantId, tenantId);
  assert.equal(workspaceRead.json?.runId, runId);
  assert.equal(workspaceRead.json?.caseId, caseId);
  assert.equal(workspaceRead.json?.queueItem?.caseId, caseId);
  assert.equal(workspaceRead.json?.queueItem?.priority, "high");
  assert.ok(Array.isArray(workspaceRead.json?.timeline));
  assert.ok(workspaceRead.json.timeline.some((row) => row?.eventType === "dispute.opened"));
  assert.ok(workspaceRead.json.timeline.some((row) => row?.eventType === "arbitration.opened"));
  assert.ok(workspaceRead.json.timeline.some((row) => row?.eventType === "dispute.window_ends"));
  assert.ok(Array.isArray(workspaceRead.json?.evidenceRefs?.all));
  assert.deepEqual(workspaceRead.json.evidenceRefs.all, evidenceRefs);
  assert.equal(workspaceRead.json?.actionability?.canWrite, false);
  assert.equal(workspaceRead.json?.actionability?.canAssignArbiter, false);
  assert.equal(workspaceRead.json?.actionability?.canSubmitVerdict, false);
  assert.equal(workspaceRead.json?.actionability?.canOpenAppeal, false);
  assert.ok(Array.isArray(workspaceRead.json?.relatedCases));
  assert.ok(workspaceRead.json.relatedCases.some((row) => row?.caseId === caseId));
  assert.equal(workspaceRead.json?.appealChain?.parentCaseId ?? null, null);
  assert.ok(Array.isArray(workspaceRead.json?.appealChain?.childCaseIds));
  assert.equal(workspaceRead.json?.links?.runSettlement, `/runs/${encodeURIComponent(runId)}/settlement`);
  assert.equal(
    workspaceRead.json?.links?.selectedArbitrationCase,
    `/runs/${encodeURIComponent(runId)}/arbitration/cases/${encodeURIComponent(caseId)}`
  );
  assert.equal(workspaceRead.json?.links?.opsAudit, "/ops/audit?limit=200");
  assert.match(String(workspaceRead.json?.links?.arbitrationCaseArtifactStatus ?? ""), /\/artifacts\/arbitration_case_arb_case_ws_1\/status$/);
  assert.equal(workspaceRead.json?.links?.arbitrationVerdictArtifactStatus ?? null, null);
  assert.ok(workspaceRead.json?.run?.run);
  assert.ok(Array.isArray(workspaceRead.json?.run?.recentEvents));

  const workspaceWrite = await request(api, {
    method: "GET",
    path: `/ops/arbitration/cases/${encodeURIComponent(caseId)}/workspace`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    }
  });
  assert.equal(workspaceWrite.statusCode, 200, workspaceWrite.body);
  assert.equal(workspaceWrite.json?.actionability?.canWrite, true);
  assert.equal(workspaceWrite.json?.actionability?.canAssignArbiter, true);
  assert.equal(workspaceWrite.json?.actionability?.canAddEvidence, true);
  assert.equal(workspaceWrite.json?.actionability?.canSubmitVerdict, true);
  assert.equal(workspaceWrite.json?.actionability?.canCloseCase, false);
  assert.equal(workspaceWrite.json?.actionability?.canOpenAppeal, false);

  const invalidSla = await request(api, {
    method: "GET",
    path: `/ops/arbitration/cases/${encodeURIComponent(caseId)}/workspace?slaHours=0`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(invalidSla.statusCode, 400, invalidSla.body);

  const missingCase = await request(api, {
    method: "GET",
    path: "/ops/arbitration/cases/arb_case_ws_missing/workspace",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(missingCase.statusCode, 404, missingCase.body);

  const forbidden = await request(api, {
    method: "GET",
    path: `/ops/arbitration/cases/${encodeURIComponent(caseId)}/workspace`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_aud"
    }
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

test("API e2e: ops arbitration workspace covers signed verdict -> close -> appeal -> workspace refresh", async () => {
  let nowAt = "2026-02-10T10:00:00.000Z";
  const api = createApi({
    now: () => nowAt,
    opsTokens: ["tok_finr:finance_read", "tok_finw:finance_write", "tok_opsr:ops_read", "tok_aud:audit_read"].join(";")
  });

  const tenantId = "tenant_arb_workspace_appeal_flow";
  const payerAgentId = "agt_arb_ws2_payer";
  const payeeAgentId = "agt_arb_ws2_payee";
  const arbiterAgentId = "agt_arb_ws2_arbiter";
  const runId = "run_arb_ws2_1";
  const disputeId = "dispute_arb_ws2_1";
  const caseId = "arb_case_ws2_1";
  const appealCaseId = "arb_case_ws2_appeal_1";
  const evidenceRefs = ["evidence://arb/ws2/1.json"];
  const arbiterKeypair = createEd25519Keypair();

  await registerAgent(api, { tenantId, agentId: payerAgentId });
  await registerAgent(api, { tenantId, agentId: payeeAgentId });
  const arbiterRegistration = await registerAgent(api, {
    tenantId,
    agentId: arbiterAgentId,
    publicKeyPem: arbiterKeypair.publicKeyPem
  });
  assert.ok(typeof arbiterRegistration.keyId === "string" && arbiterRegistration.keyId.length > 0);

  const credit = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "arb_ws2_credit_1"
    },
    body: {
      amountCents: 10000,
      currency: "USD"
    }
  });
  assert.equal(credit.statusCode, 201);

  await createArbitrationCaseFixture(api, {
    tenantId,
    payerAgentId,
    payeeAgentId,
    arbiterAgentId,
    runId,
    disputeId,
    caseId,
    evidenceRefs,
    idempotencyPrefix: "arb_ws2_case_1"
  });

  const workspaceBeforeVerdict = await request(api, {
    method: "GET",
    path: `/ops/arbitration/cases/${encodeURIComponent(caseId)}/workspace`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    }
  });
  assert.equal(workspaceBeforeVerdict.statusCode, 200, workspaceBeforeVerdict.body);
  assert.equal(workspaceBeforeVerdict.json?.arbitrationCase?.status, "under_review");
  assert.equal(workspaceBeforeVerdict.json?.actionability?.canSubmitVerdict, true);
  assert.equal(workspaceBeforeVerdict.json?.actionability?.canCloseCase, false);
  assert.equal(workspaceBeforeVerdict.json?.actionability?.canOpenAppeal, false);

  const verdictIssuedAt = nowAt;
  const arbitrationVerdictCore = normalizeForCanonicalJson(
    {
      schemaVersion: "ArbitrationVerdict.v1",
      verdictId: "arb_vrd_ws2_1",
      caseId,
      tenantId,
      runId,
      settlementId: workspaceBeforeVerdict.json?.settlement?.settlement?.settlementId,
      disputeId,
      arbiterAgentId,
      outcome: "accepted",
      releaseRatePct: 100,
      rationale: "operator accepted verified outcome",
      evidenceRefs,
      issuedAt: verdictIssuedAt,
      appealRef: null
    },
    { path: "$" }
  );
  const arbitrationVerdictHash = sha256Hex(canonicalJsonStringify(arbitrationVerdictCore));
  const arbitrationVerdictSignature = signHashHexEd25519(arbitrationVerdictHash, arbiterKeypair.privateKeyPem);

  const issueVerdict = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/verdict`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "arb_ws2_verdict_1"
    },
    body: {
      caseId,
      arbitrationVerdict: {
        caseId,
        verdictId: "arb_vrd_ws2_1",
        arbiterAgentId,
        outcome: "accepted",
        releaseRatePct: 100,
        rationale: "operator accepted verified outcome",
        evidenceRefs,
        issuedAt: verdictIssuedAt,
        signerKeyId: arbiterRegistration.keyId,
        signature: arbitrationVerdictSignature
      }
    }
  });
  assert.equal(issueVerdict.statusCode, 200, issueVerdict.body);
  assert.equal(issueVerdict.json?.arbitrationCase?.status, "verdict_issued");
  assert.equal(issueVerdict.json?.arbitrationVerdict?.verdictHash, arbitrationVerdictHash);

  const workspaceAfterVerdict = await request(api, {
    method: "GET",
    path: `/ops/arbitration/cases/${encodeURIComponent(caseId)}/workspace`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    }
  });
  assert.equal(workspaceAfterVerdict.statusCode, 200, workspaceAfterVerdict.body);
  assert.equal(workspaceAfterVerdict.json?.arbitrationCase?.status, "verdict_issued");
  assert.equal(workspaceAfterVerdict.json?.actionability?.canSubmitVerdict, false);
  assert.equal(workspaceAfterVerdict.json?.actionability?.canCloseCase, true);
  assert.equal(workspaceAfterVerdict.json?.actionability?.canOpenAppeal, true);
  assert.ok(workspaceAfterVerdict.json?.timeline?.some((row) => row?.eventType === "arbitration.verdict_issued"));
  assert.match(
    String(workspaceAfterVerdict.json?.links?.arbitrationVerdictArtifactStatus ?? ""),
    /\/artifacts\/arbitration_verdict_arb_vrd_ws2_1\/status$/
  );

  const closeCase = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/close`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "arb_ws2_close_1"
    },
    body: {
      caseId,
      summary: "arbitration finalized by operator"
    }
  });
  assert.equal(closeCase.statusCode, 200, closeCase.body);
  assert.equal(closeCase.json?.arbitrationCase?.status, "closed");

  const workspaceAfterClose = await request(api, {
    method: "GET",
    path: `/ops/arbitration/cases/${encodeURIComponent(caseId)}/workspace`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    }
  });
  assert.equal(workspaceAfterClose.statusCode, 200, workspaceAfterClose.body);
  assert.equal(workspaceAfterClose.json?.arbitrationCase?.status, "closed");
  assert.equal(workspaceAfterClose.json?.actionability?.canCloseCase, false);
  assert.equal(workspaceAfterClose.json?.actionability?.canOpenAppeal, true);
  assert.ok(workspaceAfterClose.json?.timeline?.some((row) => row?.eventType === "arbitration.closed"));

  nowAt = "2026-02-10T12:00:00.000Z";
  const openAppeal = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/appeal`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "arb_ws2_appeal_1"
    },
    body: {
      caseId: appealCaseId,
      parentCaseId: caseId,
      reason: "new evidence requires second review",
      arbiterAgentId,
      evidenceRefs
    }
  });
  assert.equal(openAppeal.statusCode, 201, openAppeal.body);
  assert.equal(openAppeal.json?.arbitrationCase?.caseId, appealCaseId);
  assert.equal(openAppeal.json?.arbitrationCase?.status, "under_review");
  assert.equal(openAppeal.json?.arbitrationCase?.appealRef?.parentCaseId, caseId);

  const parentWorkspaceAfterAppeal = await request(api, {
    method: "GET",
    path: `/ops/arbitration/cases/${encodeURIComponent(caseId)}/workspace`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    }
  });
  assert.equal(parentWorkspaceAfterAppeal.statusCode, 200, parentWorkspaceAfterAppeal.body);
  assert.ok(Array.isArray(parentWorkspaceAfterAppeal.json?.relatedCases));
  assert.ok(parentWorkspaceAfterAppeal.json.relatedCases.some((row) => row?.caseId === appealCaseId));
  const relatedAppealRow = parentWorkspaceAfterAppeal.json.relatedCases.find((row) => row?.caseId === appealCaseId);
  assert.equal(relatedAppealRow?.appealRef?.parentCaseId, caseId);
  assert.ok(Array.isArray(parentWorkspaceAfterAppeal.json?.appealChain?.childCaseIds));
  assert.ok(parentWorkspaceAfterAppeal.json.appealChain.childCaseIds.includes(appealCaseId));

  const appealWorkspace = await request(api, {
    method: "GET",
    path: `/ops/arbitration/cases/${encodeURIComponent(appealCaseId)}/workspace`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    }
  });
  assert.equal(appealWorkspace.statusCode, 200, appealWorkspace.body);
  assert.equal(appealWorkspace.json?.arbitrationCase?.caseId, appealCaseId);
  assert.equal(appealWorkspace.json?.arbitrationCase?.status, "under_review");
  assert.equal(appealWorkspace.json?.actionability?.canSubmitVerdict, false);
  assert.equal(appealWorkspace.json?.actionability?.canOpenAppeal, false);
  assert.equal(appealWorkspace.json?.appealChain?.parentCaseId, caseId);
});
