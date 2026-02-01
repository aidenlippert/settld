import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { hmacSignArtifact } from "../src/core/artifacts.js";
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

test("API e2e v1.4: settled job generates artifacts and delivers via signed webhooks", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();

  const dest = { destinationId: "d1", url: "https://example.invalid/webhook", secret: "sek", artifactTypes: ["WorkCertificate.v1", "SettlementStatement.v1"] };

  // Inject fetch to keep tests safe under concurrent node --test runs.
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response("ok", { status: 200 });
  };

  const api = createApi({
    now: nowIso,
    exportDestinations: { tenant_default: [dest] },
    deliveryMaxAttempts: 2,
    fetchFn
  });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  await registerRobot(api, {
    robotId: "rob_art",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-20T10:30:00.000Z";
  const bookingEndAt = "2026-01-20T11:00:00.000Z";

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
    body: { paymentHoldId: `hold_${jobId}`, startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  const postServerEvent = async (type, payload, idem) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": idem },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload) => {
    const at = nowIso();
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_art" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("MATCHED", { robotId: "rob_art" }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId: "rob_art", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

  const accessPlanId = `ap_${jobId}`;
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "DOCKED_IN_BUILDING",
      credentialRef: `vault://access/${accessPlanId}/v1`,
      scope: { areas: ["ENTRYWAY"], noGo: [] },
      validFrom: bookingStartAt,
      validTo: bookingEndAt,
      revocable: true,
      requestedBy: "system"
    },
    `ap_${jobId}`
  );

  // Access events must occur within the access plan window.
  nowMs = Date.parse(bookingStartAt) - 2 * 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 });
  nowMs = Date.parse(bookingStartAt) + 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" });
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] });
  nowMs += 5 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } });

  await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);

  // Build artifacts + enqueue deliveries.
  const built = await api.tickArtifacts({ maxMessages: 50 });
  assert.ok(Array.isArray(built.processed));

  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const types = artifacts.map((a) => a.artifactType).sort();
  assert.deepEqual(types, ["SettlementStatement.v1", "WorkCertificate.v1"]);

  const deliveries = await api.store.listDeliveries({ tenantId: "tenant_default" });
  assert.equal(deliveries.length, 2);

  const delivered = await api.tickDeliveries({ maxMessages: 10 });
  assert.ok(Array.isArray(delivered.processed));

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, dest.url);
    const headers = call.init?.headers ?? {};
    const ts = headers["x-proxy-timestamp"] ?? headers["X-Proxy-Timestamp"];
    const sig = headers["x-proxy-signature"] ?? headers["X-Proxy-Signature"];
    assert.ok(ts);
    assert.ok(sig);
    const body = JSON.parse(String(call.init.body));
    const expected = hmacSignArtifact({ secret: dest.secret, timestamp: ts, bodyJson: body });
    assert.equal(sig, expected);
  }
});
