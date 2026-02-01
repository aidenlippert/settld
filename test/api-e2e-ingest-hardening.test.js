import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerRobot(api, { robotId }) {
  const { publicKeyPem } = createEd25519Keypair();
  const reg = await request(api, { method: "POST", path: "/robots/register", body: { robotId, publicKeyPem } });
  assert.equal(reg.statusCode, 201);
  const avail = await request(api, {
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: { "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
    body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
  });
  assert.equal(avail.statusCode, 201);
}

test("API e2e v1.4.1: ingest externalEventId is idempotent across requests", async () => {
  const api = createApi({ ingestToken: "ingest_tok" });
  await registerRobot(api, { robotId: "rob_ing" });

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", siteId: "site_a", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z", environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { paymentHoldId: `hold_${jobId}`, startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z", environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false, siteId: "site_a" }
  });
  assert.equal(book.statusCode, 201);

  const link = await request(api, { method: "POST", path: "/ops/correlations/link", body: { jobId, siteId: "site_a", correlationKey: "ext_123" } });
  assert.equal(link.statusCode, 201);

  const first = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    headers: { "x-proxy-ingest-token": "ingest_tok", "x-idempotency-key": "req_1" },
    body: {
      source: "vendor_demo",
      siteId: "site_a",
      correlationKey: "ext_123",
      events: [
        {
          externalEventId: "ext_evt_1",
          type: "DISPATCH_EVALUATED",
          at: "2026-01-20T10:31:00.000Z",
          payload: {
            jobId,
            evaluatedAt: "2026-01-20T10:31:00.000Z",
            window: { startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z" },
            zoneId: "default",
            requiresOperatorCoverage: false,
            candidates: [],
            selected: null
          }
        }
      ]
    }
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json.results[0].status, "accepted");
  assert.equal(first.json.events.length, 1);

  const second = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    headers: { "x-proxy-ingest-token": "ingest_tok", "x-idempotency-key": "req_2" },
    body: {
      source: "vendor_demo",
      siteId: "site_a",
      correlationKey: "ext_123",
      events: [
        {
          externalEventId: "ext_evt_1",
          type: "DISPATCH_EVALUATED",
          at: "2026-01-20T10:31:00.000Z",
          payload: {
            jobId,
            evaluatedAt: "2026-01-20T10:31:00.000Z",
            window: { startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z" },
            zoneId: "default",
            requiresOperatorCoverage: false,
            candidates: [],
            selected: null
          }
        }
      ]
    }
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json.results[0].status, "duplicate");
  assert.equal(second.json.events.length, 0);
});

test("API e2e v1.4.1: out-of-order ingest is rejected and appears in DLQ", async () => {
  const api = createApi({ ingestToken: "ingest_tok" });
  await registerRobot(api, { robotId: "rob_ing2" });

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", siteId: "site_a", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z", environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { paymentHoldId: `hold_${jobId}`, startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z", environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  // Move job past BOOKED so DISPATCH_EVALUATED becomes invalid.
  const matched = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `m_${jobId}` },
    body: { type: "MATCHED", actor: { type: "system", id: "proxy" }, payload: { robotId: "rob_ing2" } }
  });
  assert.equal(matched.statusCode, 201);
  lastChainHash = matched.json.job.lastChainHash;

  const reserved = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `r_${jobId}` },
    body: {
      type: "RESERVED",
      actor: { type: "system", id: "proxy" },
      payload: { robotId: "rob_ing2", startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z", reservationId: `rsv_${jobId}` }
    }
  });
  assert.equal(reserved.statusCode, 201);

  const link = await request(api, { method: "POST", path: "/ops/correlations/link", body: { jobId, siteId: "site_a", correlationKey: "ext_456" } });
  assert.equal(link.statusCode, 201);

  const ingest = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    headers: { "x-proxy-ingest-token": "ingest_tok", "x-idempotency-key": "req_oOO" },
    body: {
      source: "vendor_demo",
      siteId: "site_a",
      correlationKey: "ext_456",
      events: [
        {
          externalEventId: "ext_evt_oOO",
          type: "DISPATCH_EVALUATED",
          at: "2026-01-20T10:31:00.000Z",
          payload: {
            jobId,
            evaluatedAt: "2026-01-20T10:31:00.000Z",
            window: { startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z" },
            zoneId: "default",
            requiresOperatorCoverage: false,
            candidates: [],
            selected: null
          }
        }
      ]
    }
  });
  assert.equal(ingest.statusCode, 200);
  assert.equal(ingest.json.results[0].status, "rejected");

  const dlq = await request(api, { method: "GET", path: "/ops/dlq?type=ingest" });
  assert.equal(dlq.statusCode, 200);
  assert.ok(Array.isArray(dlq.json.ingest));
  assert.ok(dlq.json.ingest.some((r) => r.externalEventId === "ext_evt_oOO"));
});

test("API e2e v1.4.1: expired correlation rejects ingest", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const api = createApi({ ingestToken: "ingest_tok", now: () => new Date(nowMs).toISOString() });
  await registerRobot(api, { robotId: "rob_ing3" });

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", siteId: "site_a", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z", environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { paymentHoldId: `hold_${jobId}`, startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z", environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(book.statusCode, 201);

  const link = await request(api, {
    method: "POST",
    path: "/ops/correlations/link",
    body: { jobId, siteId: "site_a", correlationKey: "ext_exp", expiresAt: "2026-01-20T10:05:00.000Z" }
  });
  assert.equal(link.statusCode, 201);

  nowMs = Date.parse("2026-01-20T10:06:00.000Z");

  const ingested = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    headers: { "x-proxy-ingest-token": "ingest_tok", "x-idempotency-key": "req_exp" },
    body: {
      source: "vendor_demo",
      siteId: "site_a",
      correlationKey: "ext_exp",
      events: [
        {
          externalEventId: "ext_evt_exp",
          type: "DISPATCH_EVALUATED",
          at: "2026-01-20T10:04:00.000Z",
          payload: {
            jobId,
            evaluatedAt: "2026-01-20T10:04:00.000Z",
            window: { startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z" },
            zoneId: "default",
            requiresOperatorCoverage: false,
            candidates: [],
            selected: null
          }
        }
      ]
    }
  });
  assert.equal(ingested.statusCode, 404);
});

test("API e2e v1.4.1: correlation collisions require forceRelink", async () => {
  const api = createApi();

  const j1 = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", siteId: "site_a", constraints: {} } });
  assert.equal(j1.statusCode, 201);
  const job1 = j1.json.job.id;

  const j2 = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", siteId: "site_a", constraints: {} } });
  assert.equal(j2.statusCode, 201);
  const job2 = j2.json.job.id;

  const link1 = await request(api, { method: "POST", path: "/ops/correlations/link", body: { jobId: job1, siteId: "site_a", correlationKey: "ext_collide" } });
  assert.equal(link1.statusCode, 201);

  const link2 = await request(api, { method: "POST", path: "/ops/correlations/link", body: { jobId: job2, siteId: "site_a", correlationKey: "ext_collide" } });
  assert.equal(link2.statusCode, 409);

  const link3 = await request(api, {
    method: "POST",
    path: "/ops/correlations/link",
    body: { jobId: job2, siteId: "site_a", correlationKey: "ext_collide", forceRelink: true }
  });
  assert.equal(link3.statusCode, 201);

  const list = await request(api, { method: "GET", path: "/ops/correlations?siteId=site_a" });
  assert.equal(list.statusCode, 200);
  const hit = list.json.correlations.find((c) => c.correlationKey === "ext_collide");
  assert.equal(hit.jobId, job2);
});

