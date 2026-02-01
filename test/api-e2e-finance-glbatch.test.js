import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

test("API e2e: month close emits GLBatch.v1 and CSV render fails loudly without finance map", async () => {
  let nowMs = Date.parse("2026-01-15T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  const reg = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_glbatch", publicKeyPem: robotPublicKeyPem } });
  assert.equal(reg.statusCode, 201);
  const avail = await request(api, {
    method: "POST",
    path: "/robots/rob_glbatch/availability",
    headers: { "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
    body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
  });
  assert.equal(avail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-15T10:30:00.000Z";
  const bookingEndAt = "2026-01-15T11:00:00.000Z";

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false
    }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  const matched = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { type: "MATCHED", actor: { type: "system", id: "proxy" }, payload: { robotId: "rob_glbatch", operatorPartyId: "pty_operator_demo" } }
  });
  assert.equal(matched.statusCode, 201);
  lastChainHash = matched.json.job.lastChainHash;

  nowMs = Date.parse("2026-01-15T10:45:00.000Z");
  const cancelledAt = nowIso();
  const cancelled = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      type: "JOB_CANCELLED",
      actor: { type: "system", id: "proxy" },
      payload: { jobId, cancelledAt, reason: "OPS", requestedBy: "ops" }
    }
  });
  assert.equal(cancelled.statusCode, 201);
  lastChainHash = cancelled.json.job.lastChainHash;

  nowMs = Date.parse("2026-01-15T10:46:00.000Z");
  const settled = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { type: "SETTLED", actor: { type: "system", id: "proxy" }, payload: { settlement: "demo" } }
  });
  assert.equal(settled.statusCode, 201);

  // Seed a deterministic entry with operator_payable so allocations + GLBatch have party attribution.
  api.store.outbox.push({
    type: "LEDGER_ENTRY_APPLY",
    tenantId: "tenant_default",
    jobId,
    entry: {
      id: `jnl_glbatch_${jobId}`,
      memo: `job:${jobId} SETTLED (gl batch seed)`,
      at: nowIso(),
      postings: [
        { accountId: "acct_customer_escrow", amountCents: 10000 },
        { accountId: "acct_platform_revenue", amountCents: -1500 },
        { accountId: "acct_operator_payable", amountCents: -8500 }
      ]
    }
  });

  nowMs = Date.parse("2026-02-02T00:00:00.000Z");
  const closeReq = await request(api, { method: "POST", path: "/ops/month-close", body: { month: "2026-01" } });
  assert.equal(closeReq.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const gl = await request(api, { method: "GET", path: "/ops/finance/gl-batch?period=2026-01" });
  assert.equal(gl.statusCode, 200);
  assert.equal(gl.json.artifact.artifactType, "GLBatch.v1");
  assert.equal(gl.json.artifact.period, "2026-01");
  assert.ok(Array.isArray(gl.json.artifact.batch?.lines));
  assert.ok(gl.json.artifact.batch.lines.length > 0);

  const csvMissing = await request(api, { method: "GET", path: "/ops/finance/gl-batch.csv?period=2026-01" });
  assert.equal(csvMissing.statusCode, 409);
  assert.equal(csvMissing.json.code, "FINANCE_ACCOUNT_MAP_REQUIRED");

  const accountIds = new Set((gl.json.artifact.batch?.lines ?? []).map((l) => String(l?.accountId ?? "")).filter((id) => id && id.trim()));
  assert.ok(accountIds.size > 0);
  const accounts = {};
  for (const id of Array.from(accountIds).sort()) accounts[id] = `ext_${id}`;

  const mapRes = await request(api, {
    method: "PUT",
    path: "/ops/finance/account-map",
    body: {
      mapping: {
        schemaVersion: "FinanceAccountMap.v1",
        accounts
      }
    }
  });
  assert.equal(mapRes.statusCode, 200);

  const csv = await request(api, { method: "GET", path: "/ops/finance/gl-batch.csv?period=2026-01" });
  assert.equal(csv.statusCode, 200);
  assert.ok(String(csv.headers.get("content-type") ?? "").includes("text/csv"));
  assert.ok(csv.body.includes("externalAccount"));
  assert.ok(csv.body.includes("jnl_glbatch_"));
});
