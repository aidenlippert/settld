import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { buildJobProofBundleV1, verifyProofBundleManifestV1, buildMonthProofBundleV1 } from "../src/core/proof-bundle.js";
import { makeMonthCloseStreamId, MONTH_CLOSE_BASIS } from "../src/core/month-close.js";

import { request } from "./api-test-harness.js";

test("proof-bundle: manifest verification fails on 1-byte tamper", async () => {
  let nowMs = Date.parse("2026-01-15T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  const reg = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_proof", publicKeyPem: robotPublicKeyPem } });
  assert.equal(reg.statusCode, 201);
  const avail = await request(api, {
    method: "POST",
    path: "/robots/rob_proof/availability",
    headers: { "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
    body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
  });
  assert.equal(avail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      startAt: "2026-01-15T10:30:00.000Z",
      endAt: "2026-01-15T11:00:00.000Z",
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false
    }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: "2026-01-15T10:30:00.000Z",
      endAt: "2026-01-15T11:00:00.000Z",
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false
    }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

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

  const settled = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { type: "SETTLED", actor: { type: "system", id: "proxy" }, payload: { settlement: "demo" } }
  });
  assert.equal(settled.statusCode, 201);

  await api.tickJobAccounting({ maxMessages: 50 });
  await api.tickArtifacts({ maxMessages: 200 });

  // Month close so we can produce a month bundle too.
  nowMs = Date.parse("2026-02-02T00:00:00.000Z");
  const closeReq = await request(api, { method: "POST", path: "/ops/month-close", body: { month: "2026-01" } });
  assert.equal(closeReq.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const tenantId = "tenant_default";
  const jobEvents = api.store.jobEvents.get(`${tenantId}\n${jobId}`) ?? [];
  const jobSnapshot = api.store.jobs.get(`${tenantId}\n${jobId}`) ?? null;
  assert.ok(jobSnapshot);
  const artifacts = await api.store.listArtifacts({ tenantId, jobId });
  const publicKeyByKeyId = api.store.publicKeyByKeyId instanceof Map ? api.store.publicKeyByKeyId : new Map();

  const { files } = buildJobProofBundleV1({
    tenantId,
    jobId,
    jobEvents,
    jobSnapshot,
    artifacts,
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    generatedAt: nowIso()
  });

  const manifestBytes = files.get("manifest.json");
  assert.ok(manifestBytes);
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  const verified = verifyProofBundleManifestV1({ files, manifest });
  assert.deepEqual(verified, { ok: true });

  // Flip one byte in one file.
  const tamperedFiles = new Map(files);
  const anyName = Array.from(files.keys()).find((k) => k !== "manifest.json");
  assert.ok(anyName);
  const b = Buffer.from(tamperedFiles.get(anyName));
  b[0] = (b[0] + 1) % 255;
  tamperedFiles.set(anyName, b);

  const verifiedTamper = verifyProofBundleManifestV1({ files: tamperedFiles, manifest });
  assert.equal(verifiedTamper.ok, false);

  // Month bundle basic sanity.
  const monthId = makeMonthCloseStreamId({ month: "2026-01", basis: MONTH_CLOSE_BASIS.SETTLED_AT });
  const monthEvents = api.store.monthEvents.get(`${tenantId}\n${monthId}`) ?? [];
  assert.ok(monthEvents.length);
  const allArtifacts = await api.store.listArtifacts({ tenantId });
  const monthArtifacts = allArtifacts.filter((a) => String(a?.month ?? a?.period ?? "") === "2026-01");
  const monthBundle = buildMonthProofBundleV1({
    tenantId,
    period: "2026-01",
    basis: MONTH_CLOSE_BASIS.SETTLED_AT,
    monthEvents,
    artifacts: monthArtifacts,
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    generatedAt: nowIso()
  });
  assert.ok(monthBundle.files.get("manifest.json"));
});
