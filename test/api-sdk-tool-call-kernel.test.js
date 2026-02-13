import test from "node:test";
import assert from "node:assert/strict";

import { SettldClient } from "../packages/api-sdk/src/index.js";

function makeJsonResponse(body, { status = 200, requestId = "req_sdk_toolcall_1" } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId
    }
  });
}

test("api-sdk: tool-call kernel wrappers compute deterministic ids and dispatch expected endpoints", async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/ops/tool-calls/holds/lock")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return makeJsonResponse(
        {
          hold: {
            schemaVersion: "FundingHold.v1",
            holdHash: "a".repeat(64),
            agreementHash: body.agreementHash,
            receiptHash: body.receiptHash,
            payerAgentId: body.payerAgentId,
            payeeAgentId: body.payeeAgentId,
            amountCents: body.amountCents,
            heldAmountCents: 2000,
            currency: body.currency,
            holdbackBps: body.holdbackBps,
            challengeWindowMs: body.challengeWindowMs,
            status: "held",
            createdAt: "2026-02-11T00:00:00.000Z",
            resolvedAt: null,
            metadata: null
          }
        },
        { status: 201 }
      );
    }
    if (String(url).endsWith("/tool-calls/arbitration/open")) {
      return makeJsonResponse(
        {
          arbitrationCase: { caseId: "arb_case_tc_demo", status: "under_review" },
          arbitrationCaseArtifact: { artifactId: "arbitration_case_arb_case_tc_demo" }
        },
        { status: 201 }
      );
    }
    if (String(url).includes("/ops/tool-calls/replay-evaluate?agreementHash=")) {
      return makeJsonResponse({
        ok: true,
        agreementHash: "1".repeat(64),
        replay: { stage: "terminal_dispute" },
        comparisons: { chainConsistent: true }
      });
    }
    if (String(url).includes("/ops/reputation/facts?")) {
      return makeJsonResponse({
        ok: true,
        tenantId: "tenant_sdk",
        agentId: "agt_payee_1",
        toolId: "tool_call",
        window: "allTime",
        asOf: "2026-02-11T00:10:00.000Z",
        windowStartAt: null,
        facts: {
          totals: {
            decisions: { approved: 1, rejected: 0 }
          }
        },
        events: []
      });
    }
    if (String(url).includes("/artifacts/")) {
      const artifactId = decodeURIComponent(String(url).split("/artifacts/")[1] ?? "");
      return makeJsonResponse({ artifact: { artifactId, schemaVersion: "ArbitrationCase.v1" } });
    }
    return makeJsonResponse({});
  };

  const client = new SettldClient({
    baseUrl: "https://api.settld.local",
    tenantId: "tenant_sdk",
    opsToken: "tok_ops",
    fetch: fetchStub
  });

  const agreementA = client.createAgreement({
    toolId: "cap_demo",
    manifestHash: "f".repeat(64),
    callId: "call_demo_1",
    input: { text: "hello" },
    settlementTerms: { amountCents: 10000, currency: "USD" },
    createdAt: "2026-02-11T00:00:00.000Z"
  });
  const agreementB = client.createAgreement({
    toolId: "cap_demo",
    manifestHash: "f".repeat(64),
    callId: "call_demo_1",
    input: { text: "hello" },
    settlementTerms: { amountCents: 10000, currency: "USD" },
    createdAt: "2026-02-11T00:00:00.000Z"
  });
  assert.equal(agreementA.agreementHash, agreementB.agreementHash);
  assert.equal(agreementA.agreement.schemaVersion, "ToolCallAgreement.v1");
  assert.match(agreementA.agreementHash, /^[0-9a-f]{64}$/);

  const evidence = client.signEvidence({
    agreement: agreementA.agreement,
    output: { upper: "HELLO", length: 5 },
    outputRef: "evidence://demo/output.json",
    startedAt: "2026-02-11T00:00:01.000Z",
    completedAt: "2026-02-11T00:00:02.000Z"
  });
  assert.equal(evidence.evidence.schemaVersion, "ToolCallEvidence.v1");
  assert.match(evidence.evidenceHash, /^[0-9a-f]{64}$/);

  const settled = await client.settle(
    {
      agreement: agreementA.agreement,
      evidence: evidence.evidence,
      payerAgentId: "agt_payer_1",
      payeeAgentId: "agt_payee_1",
      amountCents: 10000,
      currency: "USD",
      holdbackBps: 2000,
      challengeWindowMs: 60000,
      settledAt: "2026-02-11T00:00:03.000Z"
    },
    { idempotencyKey: "idmp_toolcall_settle_1" }
  );
  assert.equal(settled.hold?.holdHash, "a".repeat(64));
  assert.match(settled.receiptHash, /^[0-9a-f]{64}$/);

  assert.equal(calls[0].url, "https://api.settld.local/ops/tool-calls/holds/lock");
  assert.equal(calls[0].init?.method, "POST");
  const settleBody = JSON.parse(String(calls[0].init?.body ?? "{}"));
  assert.equal(settleBody.agreementHash, agreementA.agreementHash);
  assert.equal(settleBody.receiptHash, settled.receiptHash);
  assert.equal(calls[0].init?.headers?.["x-proxy-ops-token"], "tok_ops");

  await client.openDispute(
    {
      agreementHash: settled.agreementHash,
      receiptHash: settled.receiptHash,
      holdHash: String(settled.hold?.holdHash ?? ""),
      openedByAgentId: "agt_payee_1",
      arbiterAgentId: "agt_arbiter_1",
      summary: "quality dispute",
      evidenceRefs: ["evidence://demo/output.json"],
      signerKeyId: "key_demo_signer",
      signature: "sig_demo_open_dispute"
    },
    { idempotencyKey: "idmp_toolcall_open_1" }
  );
  assert.equal(calls[1].url, "https://api.settld.local/tool-calls/arbitration/open");
  assert.equal(calls[1].init?.method, "POST");
  const openBody = JSON.parse(String(calls[1].init?.body ?? "{}"));
  assert.equal(openBody.openedByAgentId, "agt_payee_1");
  assert.equal(openBody.disputeOpenEnvelope?.openedByAgentId, "agt_payee_1");
  assert.equal(openBody.disputeOpenEnvelope?.agreementHash, settled.agreementHash);
  assert.equal(openBody.disputeOpenEnvelope?.receiptHash, settled.receiptHash);
  assert.equal(openBody.disputeOpenEnvelope?.holdHash, String(settled.hold?.holdHash ?? ""));

  const replay = await client.opsGetToolCallReplayEvaluate("1".repeat(64));
  assert.equal(replay.body?.comparisons?.chainConsistent, true);
  assert.equal(
    calls[2].url,
    "https://api.settld.local/ops/tool-calls/replay-evaluate?agreementHash=1111111111111111111111111111111111111111111111111111111111111111"
  );

  const reputation = await client.opsGetReputationFacts({
    agentId: "agt_payee_1",
    toolId: "tool_call",
    window: "allTime",
    includeEvents: true
  });
  assert.equal(reputation.body?.facts?.totals?.decisions?.approved, 1);
  assert.equal(
    calls[3].url,
    "https://api.settld.local/ops/reputation/facts?agentId=agt_payee_1&toolId=tool_call&window=allTime&includeEvents=1"
  );

  const artifacts = await client.getArtifacts({ artifactIds: ["arbitration_case_arb_case_tc_demo", "arbitration_verdict_demo"] });
  assert.equal(artifacts.artifacts.length, 2);
  assert.equal(calls[4].url, "https://api.settld.local/artifacts/arbitration_case_arb_case_tc_demo");
  assert.equal(calls[5].url, "https://api.settld.local/artifacts/arbitration_verdict_demo");
});
