import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { tenantId, agentId, ownerId = "svc_billable_test" }) {
  const { publicKeyPem } = createEd25519Keypair();
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
}

test("API e2e: billable usage events are emitted and queryable by tenant+period", async () => {
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: ["tok_finr:finance_read", "tok_finw:finance_write"].join(";")
  });

  const tenantId = "tenant_billable_events";
  const payerAgentId = "agt_billable_payer";
  const payeeAgentId = "agt_billable_payee";
  const arbiterAgentId = "agt_billable_arbiter";
  const runId = "run_billable_1";

  await registerAgent(api, { tenantId, agentId: payerAgentId });
  await registerAgent(api, { tenantId, agentId: payeeAgentId });
  await registerAgent(api, { tenantId, agentId: arbiterAgentId });

  const credit = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "billable_credit_1"
    },
    body: {
      amountCents: 5000,
      currency: "USD"
    }
  });
  assert.equal(credit.statusCode, 201);

  const createdRun = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "billable_run_create_1"
    },
    body: {
      runId,
      taskType: "analysis",
      settlement: {
        payerAgentId,
        amountCents: 1500,
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
      "x-idempotency-key": "billable_run_complete_1",
      "x-proxy-expected-prev-chain-hash": prevChainHash
    },
    body: {
      type: "RUN_COMPLETED",
      payload: { outputRef: "evidence://billable/run1/output.json" }
    }
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json?.settlement?.status, "released");

  const openedDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "billable_dispute_open_1"
    },
    body: {
      disputeId: "dispute_billable_1",
      reason: "need arbitration",
      openedByAgentId: payerAgentId
    }
  });
  assert.equal(openedDispute.statusCode, 200);
  assert.equal(openedDispute.json?.settlement?.disputeStatus, "open");

  const openArbitration = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/open`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "billable_arbitration_open_1"
    },
    body: {
      caseId: "arb_case_billable_1",
      disputeId: "dispute_billable_1",
      arbiterAgentId
    }
  });
  assert.equal(openArbitration.statusCode, 201);

  const period = "2026-02";
  const allEvents = await request(api, {
    method: "GET",
    path: `/ops/finance/billable-events?period=${encodeURIComponent(period)}&limit=50`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(allEvents.statusCode, 200);
  assert.equal(allEvents.json?.period, period);
  const events = Array.isArray(allEvents.json?.events) ? allEvents.json.events : [];
  assert.equal(events.length, 3);

  const byType = new Map();
  for (const event of events) {
    byType.set(String(event?.eventType ?? ""), (byType.get(String(event?.eventType ?? "")) ?? 0) + 1);
  }
  assert.equal(byType.get("verified_run"), 1);
  assert.equal(byType.get("settled_volume"), 1);
  assert.equal(byType.get("arbitration_usage"), 1);

  const settledEvent = events.find((event) => event?.eventType === "settled_volume");
  assert.equal(settledEvent?.amountCents, 1500);
  assert.equal(settledEvent?.currency, "USD");

  const arbitrationOnly = await request(api, {
    method: "GET",
    path: `/ops/finance/billable-events?period=${encodeURIComponent(period)}&eventType=arbitration_usage&limit=50`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(arbitrationOnly.statusCode, 200);
  assert.equal(arbitrationOnly.json?.count, 1);
  assert.equal(arbitrationOnly.json?.events?.[0]?.eventType, "arbitration_usage");

  const replay = await request(api, {
    method: "GET",
    path: `/ops/finance/billable-events?period=${encodeURIComponent(period)}&limit=50`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json, allEvents.json);
});
