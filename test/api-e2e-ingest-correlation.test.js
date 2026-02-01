import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

test("API e2e v1.4: correlation linking + ingest by correlationKey", async () => {
  const api = createApi({ ingestToken: "ingest_tok" });

  // Quote gating requires at least one available robot for the window.
  const { publicKeyPem } = createEd25519Keypair();
  const reg = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_ingest", publicKeyPem } });
  assert.equal(reg.statusCode, 201);
  const avail = await request(api, {
    method: "POST",
    path: "/robots/rob_ingest/availability",
    headers: { "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
    body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
  });
  assert.equal(avail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", siteId: "site_a", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  // Quote + book so the job is in a realistic state.
  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: "2026-01-20T10:30:00.000Z", endAt: "2026-01-20T11:00:00.000Z", environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false, siteId: "site_a" }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: "2026-01-20T10:30:00.000Z",
      endAt: "2026-01-20T11:00:00.000Z",
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      siteId: "site_a"
    }
  });
  assert.equal(book.statusCode, 201);

  // Link external correlation key to job.
  const link = await request(api, {
    method: "POST",
    path: "/ops/correlations/link",
    body: { jobId, siteId: "site_a", correlationKey: "ext_123" }
  });
  assert.equal(link.statusCode, 201);

  // Ingest a server-signed, non-transition event via correlation key.
  const ingested = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    headers: { "x-proxy-ingest-token": "ingest_tok", "x-idempotency-key": "ing_1" },
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
  assert.equal(ingested.statusCode, 200);
  assert.ok(Array.isArray(ingested.json.events));
  assert.equal(ingested.json.events[0].type, "DISPATCH_EVALUATED");
  assert.equal(ingested.json.results[0].status, "accepted");

  // Idempotent retry returns same response.
  const retry = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    headers: { "x-proxy-ingest-token": "ingest_tok", "x-idempotency-key": "ing_1" },
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
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json.events[0].id, ingested.json.events[0].id);
});
