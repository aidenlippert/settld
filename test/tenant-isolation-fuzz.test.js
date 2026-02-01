import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createChainedEvent } from "../src/core/event-chain.js";
import { request } from "./api-test-harness.js";

test("tenant isolation: cross-tenant reads/writes are impossible (fuzz-ish)", async () => {
  const api = createApi();

  // Seed two jobs with the same jobId in different tenants (forces store-key correctness).
  const jobIdShared = "job_shared";
  const createdA = createChainedEvent({
    streamId: jobIdShared,
    type: "JOB_CREATED",
    actor: { type: "system", id: "seed" },
    payload: { tenantId: "tenant_a", templateId: "reset_lite", customerId: "cust_a", siteId: "site_a", constraints: {} }
  });
  const createdB = createChainedEvent({
    streamId: jobIdShared,
    type: "JOB_CREATED",
    actor: { type: "system", id: "seed" },
    payload: { tenantId: "tenant_b", templateId: "reset_lite", customerId: "cust_b", siteId: "site_b", constraints: {} }
  });

  await api.store.commitTx({ ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId: "tenant_a", jobId: jobIdShared, events: [createdA] }] });
  await api.store.commitTx({ ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId: "tenant_b", jobId: jobIdShared, events: [createdB] }] });

  const getA = await request(api, { method: "GET", path: `/jobs/${jobIdShared}`, headers: { "x-proxy-tenant-id": "tenant_a" } });
  assert.equal(getA.statusCode, 200);
  assert.equal(getA.json.job.id, jobIdShared);
  assert.equal(getA.json.job.tenantId, "tenant_a");

  const getB = await request(api, { method: "GET", path: `/jobs/${jobIdShared}`, headers: { "x-proxy-tenant-id": "tenant_b" } });
  assert.equal(getB.statusCode, 200);
  assert.equal(getB.json.job.id, jobIdShared);
  assert.equal(getB.json.job.tenantId, "tenant_b");

  // Seed a job in tenant A only; tenant B must not see it.
  const jobIdOnlyA = "job_only_a";
  const createdOnlyA = createChainedEvent({
    streamId: jobIdOnlyA,
    type: "JOB_CREATED",
    actor: { type: "system", id: "seed" },
    payload: { tenantId: "tenant_a", templateId: "reset_lite", customerId: "cust_a", siteId: "site_a", constraints: {} }
  });
  await api.store.commitTx({ ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId: "tenant_a", jobId: jobIdOnlyA, events: [createdOnlyA] }] });

  const getOnlyAFromB = await request(api, { method: "GET", path: `/jobs/${jobIdOnlyA}`, headers: { "x-proxy-tenant-id": "tenant_b" } });
  assert.equal(getOnlyAFromB.statusCode, 404);

  // Mutation attempt: tenant B cannot append to tenant A job stream (it should 404 due to missing stream in tenant B).
  const appendFromB = await request(api, {
    method: "POST",
    path: `/jobs/${jobIdOnlyA}/events`,
    headers: { "x-proxy-tenant-id": "tenant_b", "x-proxy-expected-prev-chain-hash": "" },
    body: { type: "QUOTE_PROPOSED", actor: { type: "system", id: "seed" }, payload: { amountCents: 1, currency: "USD" } }
  });
  assert.equal(appendFromB.statusCode, 404);

  // Injection-ish job IDs should never leak data (should behave like a normal unknown jobId).
  const payloads = ["' OR '1'='1", "'; DROP TABLE jobs; --", "tenant_a' OR tenant_id='tenant_b"];
  for (const p of payloads) {
    const res = await request(api, { method: "GET", path: `/jobs/${encodeURIComponent(p)}`, headers: { "x-proxy-tenant-id": "tenant_b" } });
    assert.equal(res.statusCode, 404);
  }
});

