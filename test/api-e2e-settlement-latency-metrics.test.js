import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";
import { getOne, parsePrometheusText } from "../scripts/slo/check.mjs";

async function registerAgent(api, agentId) {
  const { publicKeyPem } = createEd25519Keypair();
  const created = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `register_${agentId}` },
    body: {
      agentId,
      displayName: agentId,
      owner: { ownerType: "service", ownerId: "svc_settlement_latency_metrics" },
      publicKeyPem,
      capabilities: ["translate", "summarize"]
    }
  });
  assert.equal(created.statusCode, 201, created.body);
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

async function setupRun(api, { prefix }) {
  const posterAgentId = `agt_${prefix}_poster`;
  const bidderAgentId = `agt_${prefix}_bidder`;
  const operatorAgentId = `agt_${prefix}_operator`;
  const rfqId = `rfq_${prefix}`;
  const bidId = `bid_${prefix}`;

  await registerAgent(api, posterAgentId);
  await registerAgent(api, bidderAgentId);
  await registerAgent(api, operatorAgentId);
  await creditWallet(api, { agentId: posterAgentId, amountCents: 8000, idempotencyKey: `wallet_credit_${prefix}_1` });

  const createTask = await request(api, {
    method: "POST",
    path: "/marketplace/rfqs",
    headers: { "x-idempotency-key": `rfq_create_${prefix}_1` },
    body: {
      rfqId,
      title: `Settlement latency metrics ${prefix}`,
      capability: "translate",
      posterAgentId,
      budgetCents: 2200,
      currency: "USD"
    }
  });
  assert.equal(createTask.statusCode, 201, createTask.body);

  const bid = await request(api, {
    method: "POST",
    path: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`,
    headers: { "x-idempotency-key": `bid_create_${prefix}_1` },
    body: {
      bidId,
      bidderAgentId,
      amountCents: 2000,
      currency: "USD",
      verificationMethod: { mode: "attested", attestor: "oracle://settlement-latency-metrics" },
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
  assert.equal(bid.statusCode, 201, bid.body);

  const accept = await request(api, {
    method: "POST",
    path: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/accept`,
    headers: { "x-idempotency-key": `bid_accept_${prefix}_1` },
    body: {
      bidId,
      acceptedByAgentId: operatorAgentId
    }
  });
  assert.equal(accept.statusCode, 200, accept.body);

  const runId = accept.json?.run?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);

  const complete = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(bidderAgentId)}/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-expected-prev-chain-hash": accept.json?.run?.lastChainHash,
      "x-idempotency-key": `run_complete_${prefix}_1`
    },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { settlementReleaseRatePct: 100 }
      }
    }
  });
  assert.equal(complete.statusCode, 201, complete.body);

  return { runId };
}

test("API e2e: settlement retrieval routes emit p95 latency gauges", async () => {
  const api = createApi();
  const { runId } = await setupRun(api, { prefix: "settlement_latency_metrics" });

  const policyReplay = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/policy-replay`
  });
  assert.equal(policyReplay.statusCode, 200, policyReplay.body);

  const replayEvaluate = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/replay-evaluate`
  });
  assert.equal(replayEvaluate.statusCode, 200, replayEvaluate.body);

  const explainability = await request(api, {
    method: "GET",
    path: `/runs/${encodeURIComponent(runId)}/settlement/explainability`
  });
  assert.equal(explainability.statusCode, 200, explainability.body);

  const metricsResponse = await request(api, {
    method: "GET",
    path: "/metrics"
  });
  assert.equal(metricsResponse.statusCode, 200, metricsResponse.body);
  const series = parsePrometheusText(String(metricsResponse.body ?? ""));

  const policyReplayP95 = getOne(series, { name: "run_settlement_policy_replay_latency_ms_p95_gauge" });
  const replayEvaluateP95 = getOne(series, { name: "run_settlement_replay_evaluate_latency_ms_p95_gauge" });
  const explainabilityP95 = getOne(series, { name: "run_settlement_explainability_latency_ms_p95_gauge" });
  assert.equal(Number.isFinite(policyReplayP95), true);
  assert.equal(Number.isFinite(replayEvaluateP95), true);
  assert.equal(Number.isFinite(explainabilityP95), true);

  const policyReplaySamples = getOne(series, {
    name: "run_settlement_latency_samples_total",
    where: (labels) => labels?.route === "policy_replay"
  });
  const replayEvaluateSamples = getOne(series, {
    name: "run_settlement_latency_samples_total",
    where: (labels) => labels?.route === "replay_evaluate"
  });
  const explainabilitySamples = getOne(series, {
    name: "run_settlement_latency_samples_total",
    where: (labels) => labels?.route === "explainability"
  });
  assert.equal(Number(policyReplaySamples) >= 1, true);
  assert.equal(Number(replayEvaluateSamples) >= 1, true);
  assert.equal(Number(explainabilitySamples) >= 1, true);
});
