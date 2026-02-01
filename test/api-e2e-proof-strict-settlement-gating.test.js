import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";

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

test("API e2e: strict proof gating blocks settlement until PROOF_EVALUATED=PASS", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  await registerRobot(api, {
    robotId: "rob_strict",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const contractRes = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    body: { contractId: "contract_strict", name: "Strict Proof Contract", policies: { proofPolicy: { gateMode: "strict" } } }
  });
  assert.equal(contractRes.statusCode, 201);

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
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false, contractId: "contract_strict" }
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
      requiresOperatorCoverage: false,
      contractId: "contract_strict"
    }
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

  const postRobotEvent = async (type, payload, at) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_strict" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("MATCHED", { robotId: "rob_strict" }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId: "rob_strict", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

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

  nowMs = Date.parse(bookingStartAt) - 2 * 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, nowIso());
  nowMs = Date.parse(bookingStartAt) + 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, nowIso());
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, nowIso());

  nowMs += 2 * 60_000;
  await postRobotEvent(
    "ZONE_COVERAGE_REPORTED",
    { jobId, zoneId: "zone_default", coveragePct: 100, window: { startAt: bookingStartAt, endAt: bookingEndAt }, source: "robot" },
    nowIso()
  );

  nowMs += 3 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, nowIso());

  // Strict mode: settlement rejected until PROOF_EVALUATED exists and is PASS.
  nowMs = Date.parse("2026-01-20T12:00:00.000Z");
  const settleBeforeProof = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `s_${jobId}_pre` },
    body: { type: "SETTLED", actor: { type: "system", id: "proxy" }, payload: { settlement: "demo" } }
  });
  assert.equal(settleBeforeProof.statusCode, 400);
  assert.equal(settleBeforeProof.json?.code, "PROOF_REQUIRED");

  await api.tickProof({ maxMessages: 50 });
  const refreshed = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(refreshed.statusCode, 200);
  lastChainHash = refreshed.json.job.lastChainHash;

  const settled = await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);
  assert.ok(settled.json?.event);
  assert.equal(settled.json.event.type, "SETTLED");

  await api.tickArtifacts({ maxMessages: 200 });
  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  assert.ok(artifacts.some((a) => String(a?.artifactType ?? a?.schemaVersion ?? "") === "ProofReceipt.v1"));
});
