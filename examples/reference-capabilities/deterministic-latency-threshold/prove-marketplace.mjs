import assert from "node:assert/strict";

import { SETTLEMENT_VERIFIER_SOURCE } from "../../../src/core/settlement-verifier.js";

const baseUrl = String(process.env.SETTLD_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const tenantId = String(process.env.SETTLD_TENANT_ID || "tenant_default");
const opsToken = String(process.env.SETTLD_OPS_TOKEN || "tok_ops");
const protocol = String(process.env.SETTLD_PROTOCOL || "1.0");

function reqId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

async function requestJson({ method, pathname, body = undefined, idempotencyKey = null, headers: extraHeaders = null }) {
  const url = new URL(pathname, `${baseUrl}/`);
  const headers = {
    "content-type": "application/json",
    "x-proxy-tenant-id": tenantId,
    "x-settld-protocol": protocol,
    "x-proxy-ops-token": opsToken,
    "x-request-id": reqId("det_ref")
  };
  if (idempotencyKey) headers["x-idempotency-key"] = String(idempotencyKey);
  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value === null || value === undefined || String(value).trim() === "") continue;
      headers[String(key)] = String(value);
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(parsed?.message || parsed?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function registerAgent(agentId) {
  const key = await requestJson({
    method: "POST",
    pathname: "/agents/register",
    idempotencyKey: reqId(`register_${agentId}`),
    body: {
      agentId,
      displayName: agentId,
      owner: { ownerType: "service", ownerId: "examples.det_verifier" },
      capabilities: ["translate"]
    }
  });
  return key;
}

async function main() {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 6)}`;
  const poster = `agt_detref_poster_${suffix}`;
  const bidder = `agt_detref_bidder_${suffix}`;
  const operator = `agt_detref_operator_${suffix}`;
  const rfqId = `rfq_detref_${suffix}`;
  const bidId = `bid_detref_${suffix}`;

  await registerAgent(poster);
  await registerAgent(bidder);
  await registerAgent(operator);

  await requestJson({
    method: "POST",
    pathname: `/agents/${encodeURIComponent(poster)}/wallet/credit`,
    idempotencyKey: reqId("wallet_credit"),
    body: { amountCents: 5000, currency: "USD" }
  });

  await requestJson({
    method: "POST",
    pathname: "/marketplace/rfqs",
    idempotencyKey: reqId("rfq_create"),
    body: {
      rfqId,
      title: "Deterministic verifier plugin example",
      capability: "translate",
      posterAgentId: poster,
      budgetCents: 2200,
      currency: "USD"
    }
  });

  await requestJson({
    method: "POST",
    pathname: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`,
    idempotencyKey: reqId("bid_create"),
    body: {
      bidId,
      bidderAgentId: bidder,
      amountCents: 2000,
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

  const accepted = await requestJson({
    method: "POST",
    pathname: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/accept`,
    idempotencyKey: reqId("accept"),
    body: {
      bidId,
      acceptedByAgentId: operator
    }
  });

  const runId = String(accepted?.run?.runId || "");
  const prevChainHash = String(accepted?.run?.lastChainHash || "");
  assert(runId, "accept did not return runId");
  assert(prevChainHash, "accept did not return run.lastChainHash");

  const completed = await requestJson({
    method: "POST",
    pathname: `/agents/${encodeURIComponent(bidder)}/runs/${encodeURIComponent(runId)}/events`,
    idempotencyKey: reqId("run_complete"),
    headers: { "x-proxy-expected-prev-chain-hash": prevChainHash },
    body: {
      type: "RUN_COMPLETED",
      payload: {
        outputRef: `evidence://${runId}/output.json`,
        metrics: { latencyMs: 250 }
      }
    }
  });

  const settlement = await requestJson({
    method: "GET",
    pathname: `/runs/${encodeURIComponent(runId)}/settlement`
  });
  const replay = await requestJson({
    method: "GET",
    pathname: `/runs/${encodeURIComponent(runId)}/settlement/replay-evaluate`
  });

  const decisionRecord = settlement?.decisionRecord ?? settlement?.settlement?.decisionTrace?.decisionRecord ?? null;
  assert(decisionRecord, "settlement decisionRecord missing");
  assert.equal(decisionRecord?.verifierRef?.modality, "deterministic");
  assert.equal(decisionRecord?.verifierRef?.verifierId, "settld.deterministic.latency-threshold");
  assert.match(String(decisionRecord?.verifierRef?.verifierHash ?? ""), /^[0-9a-f]{64}$/);
  assert.equal(replay?.comparisons?.verifierRefMatchesStored, true);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        rfqId,
        bidId,
        runId,
        settlementStatus: completed?.settlement?.status ?? null,
        decisionStatus: completed?.settlement?.decisionStatus ?? null,
        verifierRef: decisionRecord?.verifierRef ?? null,
        replayComparisons: replay?.comparisons ?? null
      },
      null,
      2
    )}\n`
  );
}

await main();
