import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { makeScopedKey, normalizeTenantId } from "../src/core/tenancy.js";
import { request } from "./api-test-harness.js";

function countIngestRecordsForTenant(store, tenantId) {
  tenantId = normalizeTenantId(tenantId);
  let count = 0;
  for (const r of store.ingestRecords?.values?.() ?? []) {
    if (!r || typeof r !== "object") continue;
    if (normalizeTenantId(r.tenantId ?? "tenant_default") !== tenantId) continue;
    count += 1;
  }
  return count;
}

test("API e2e: retention cleanup purges ingest_records in batches and is tenant-scoped", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });

  api.store.getConfig("tenant_default").retention.ingestRecordsDays = 1;
  api.store.ensureTenant("tenant_other");
  api.store.getConfig("tenant_other").retention.ingestRecordsDays = 1;

  const jobA = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(jobA.statusCode, 201);

  const jobB = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { "x-proxy-tenant-id": "tenant_other" },
    body: { templateId: "reset_lite", constraints: {} }
  });
  assert.equal(jobB.statusCode, 201);

  const ingestOne = async ({ tenantId, jobId, externalEventId }) => {
    const res = await request(api, {
      method: "POST",
      path: "/ingest/proxy",
      headers: { "x-proxy-tenant-id": tenantId, "x-idempotency-key": `ingest_${tenantId}_${externalEventId}` },
      body: {
        source: "test",
        jobId,
        events: [{ externalEventId, type: "MATCHED", actor: { type: "system", id: "ingest" }, payload: {} }]
      },
      auth: "none"
    });
    assert.equal(res.statusCode, 200);
  };

  await ingestOne({ tenantId: "tenant_default", jobId: jobA.json.job.id, externalEventId: "ext_a1" });
  await ingestOne({ tenantId: "tenant_default", jobId: jobA.json.job.id, externalEventId: "ext_a2" });
  await ingestOne({ tenantId: "tenant_other", jobId: jobB.json.job.id, externalEventId: "ext_b1" });

  assert.equal(countIngestRecordsForTenant(api.store, "tenant_default"), 2);
  assert.equal(countIngestRecordsForTenant(api.store, "tenant_other"), 1);

  // Advance beyond 1-day retention.
  nowMs += 2 * 24 * 60 * 60_000;

  await api.tickRetentionCleanup({ tenantId: "tenant_default", maxRows: 1 });
  assert.equal(countIngestRecordsForTenant(api.store, "tenant_default"), 1);
  assert.equal(countIngestRecordsForTenant(api.store, "tenant_other"), 1);

  await api.tickRetentionCleanup({ tenantId: "tenant_default", maxRows: 10 });
  assert.equal(countIngestRecordsForTenant(api.store, "tenant_default"), 0);
  assert.equal(countIngestRecordsForTenant(api.store, "tenant_other"), 1);
});

test("API e2e: maxOpenJobs quota rejects new job creation", async () => {
  const api = createApi();
  api.store.getConfig("tenant_default").quotas.maxOpenJobs = 1;

  const first = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(first.statusCode, 201);

  const second = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json.code, "TENANT_QUOTA_EXCEEDED");
});

test("API e2e: maxIngestDlqDepth quota rejects ingest once DLQ depth is reached", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });
  api.store.getConfig("tenant_default").quotas.maxIngestDlqDepth = 1;

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;

	  const first = await request(api, {
	    method: "POST",
	    path: "/ingest/proxy",
	    headers: { "x-idempotency-key": "ingest_ext_1" },
	    body: { source: "test", jobId, events: [{ externalEventId: "ext_1", type: "MATCHED", actor: { type: "system", id: "ingest" }, payload: {} }] },
	    auth: "none"
	  });
	  assert.equal(first.statusCode, 200);
	  assert.equal(countIngestRecordsForTenant(api.store, "tenant_default"), 1);

	  const blocked = await request(api, {
	    method: "POST",
	    path: "/ingest/proxy",
	    headers: { "x-idempotency-key": "ingest_ext_2" },
	    body: { source: "test", jobId, events: [{ externalEventId: "ext_2", type: "MATCHED", actor: { type: "system", id: "ingest" }, payload: {} }] },
	    auth: "none"
	  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json.code, "TENANT_QUOTA_EXCEEDED");
});

test("API e2e: delivery requeue resets attempts and is audited", async () => {
  const api = createApi();

  const tenantId = "tenant_default";
  const created = await api.store.createDelivery({
    tenantId,
    delivery: {
      destinationId: "dst_test",
      artifactType: "WorkCertificate.v1",
      artifactId: "art_1",
      artifactHash: "hash_1",
      dedupeKey: "dedupe_1"
    }
  });
  const key = makeScopedKey({ tenantId, id: created.deliveryId });
  const existing = api.store.deliveries.get(key);
  existing.state = "failed";
  existing.attempts = 9;
  existing.lastError = "failed";
  existing.expiresAt = "2026-01-02T00:00:00.000Z";
  existing.ackedAt = "2026-01-01T00:00:00.000Z";
  api.store.deliveries.set(key, existing);

  const requeue = await request(api, { method: "POST", path: `/ops/deliveries/${created.deliveryId}/requeue` });
  assert.equal(requeue.statusCode, 200);
  assert.equal(requeue.json.delivery.state, "pending");
  assert.equal(requeue.json.delivery.attempts, 0);
  assert.equal(requeue.json.delivery.lastError, null);
  assert.equal(requeue.json.delivery.expiresAt, null);
  assert.equal(requeue.json.delivery.ackedAt, null);

  const audit = await request(api, { method: "GET", path: "/ops/audit?limit=10" });
  assert.equal(audit.statusCode, 200);
  assert.ok(audit.json.audit.some((a) => a?.action === "DELIVERY_REQUEUE"));
});
