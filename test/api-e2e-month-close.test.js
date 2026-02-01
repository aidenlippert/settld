import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { request } from "./api-test-harness.js";

async function registerRobot(api, { robotId, publicKeyPem, availability }) {
  const reg = await request(api, { method: "POST", path: "/robots/register", body: { robotId, publicKeyPem } });
  assert.equal(reg.statusCode, 201);

  const availRes = await request(api, {
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: { "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
    body: { availability }
  });
  assert.equal(availRes.statusCode, 201);
}

test("API e2e v1.5: month close makes the settledAt month immutable (reject backdated settlement); reopen restores posting", async () => {
  let nowMs = Date.parse("2026-01-15T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  await registerRobot(api, {
    robotId: "rob_month",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const createBookedJob = async ({ bookingStartAt, bookingEndAt }) => {
    const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;
    let lastChainHash = created.json.job.lastChainHash;

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
    return { jobId, lastChainHash };
  };

  const postServerEvent = async ({ jobId }, { lastChainHash }, type, payload) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    return res;
  };

  const job1Window = { startAt: "2026-01-15T10:30:00.000Z", endAt: "2026-01-15T11:00:00.000Z" };
  const job1 = await createBookedJob({ bookingStartAt: job1Window.startAt, bookingEndAt: job1Window.endAt });

  nowMs = Date.parse("2026-01-15T10:40:00.000Z");
  const cancelledAt1 = nowIso();
  const cancelled1 = await postServerEvent(job1, job1, "JOB_CANCELLED", {
    jobId: job1.jobId,
    cancelledAt: cancelledAt1,
    reason: "OPS",
    requestedBy: "ops"
  });
  assert.equal(cancelled1.statusCode, 201);
  job1.lastChainHash = cancelled1.json.job.lastChainHash;

  nowMs = Date.parse("2026-01-15T10:45:00.000Z");
  const settled1 = await postServerEvent(job1, job1, "SETTLED", { settlement: "refund" });
  assert.equal(settled1.statusCode, 201);

  const job2Window = { startAt: "2026-01-16T10:30:00.000Z", endAt: "2026-01-16T11:00:00.000Z" };
  const job2 = await createBookedJob({ bookingStartAt: job2Window.startAt, bookingEndAt: job2Window.endAt });

  nowMs = Date.parse("2026-01-16T10:40:00.000Z");
  const cancelledAt2 = nowIso();
  const cancelled2 = await postServerEvent(job2, job2, "JOB_CANCELLED", {
    jobId: job2.jobId,
    cancelledAt: cancelledAt2,
    reason: "OPS",
    requestedBy: "ops"
  });
  assert.equal(cancelled2.statusCode, 201);
  job2.lastChainHash = cancelled2.json.job.lastChainHash;

  // Close January (settledAt basis) and confirm statement artifact is stored.
  nowMs = Date.parse("2026-02-02T00:00:00.000Z");
  const closeReq = await request(api, { method: "POST", path: "/ops/month-close", body: { month: "2026-01" } });
  assert.equal(closeReq.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 10 });

  const closed = await request(api, { method: "GET", path: "/ops/month-close?month=2026-01" });
  assert.equal(closed.statusCode, 200);
  assert.equal(closed.json.monthClose.status, "CLOSED");
  assert.equal(closed.json.monthClose.month, "2026-01");
  assert.ok(closed.json.monthClose.statementArtifactId);
  assert.ok(closed.json.monthClose.statementArtifactHash);
  assert.equal(closed.json.statementArtifact?.artifactId, closed.json.monthClose.statementArtifactId);
  assert.equal(closed.json.statementArtifact?.artifactHash, closed.json.monthClose.statementArtifactHash);

  // Attempt to backdate a settlement into the closed month => rejected.
  nowMs = Date.parse("2026-01-20T12:00:00.000Z");
  const rejected = await request(api, {
    method: "POST",
    path: `/jobs/${job2.jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": job2.lastChainHash },
    body: { type: "SETTLED", actor: { type: "system", id: "proxy" }, payload: { settlement: "refund" } }
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json.error, "event rejected");
  assert.equal(rejected.json.details?.message, "cannot settle: month is closed");

  // Reopen requires finance_write.
  const limitedKeyId = authKeyId();
  const limitedSecret = authKeySecret();
  const limitedSecretHash = hashAuthKeySecret(limitedSecret);
  await api.store.putAuthKey({
    tenantId: "tenant_default",
    authKey: { keyId: limitedKeyId, secretHash: limitedSecretHash, scopes: ["ops_write"], status: "active", createdAt: nowIso() }
  });
  const forbiddenReopen = await request(api, {
    method: "POST",
    path: "/ops/month-close/reopen",
    headers: { authorization: `Bearer ${limitedKeyId}.${limitedSecret}` },
    body: { month: "2026-01", reason: "correction" },
    auth: "none"
  });
  assert.equal(forbiddenReopen.statusCode, 403);

  // Reopen month, then allow the settlement.
  nowMs = Date.parse("2026-02-03T00:00:00.000Z");
  const reopen = await request(api, { method: "POST", path: "/ops/month-close/reopen", body: { month: "2026-01", reason: "correction" } });
  assert.equal(reopen.statusCode, 201);

  const audit = await request(api, { method: "GET", path: "/ops/audit?limit=20" });
  assert.equal(audit.statusCode, 200);
  assert.ok(audit.json.audit.some((a) => a?.details?.path === "/ops/month-close/reopen"));

  nowMs = Date.parse("2026-01-20T12:00:00.000Z");
  const settled2 = await request(api, {
    method: "POST",
    path: `/jobs/${job2.jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": job2.lastChainHash },
    body: { type: "SETTLED", actor: { type: "system", id: "proxy" }, payload: { settlement: "refund" } }
  });
  assert.equal(settled2.statusCode, 201);
});
