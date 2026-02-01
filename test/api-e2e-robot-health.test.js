import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { request } from "./api-test-harness.js";

test("API e2e v0.8: quarantined robot is not dispatched", async () => {
  const api = createApi();

  const now = Date.now();
  const availStartAt = new Date(now - 60 * 60_000).toISOString();
  const availEndAt = new Date(now + 24 * 60 * 60_000).toISOString();
  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt = new Date(now + 70 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_quarantine", publicKeyPem: robotPublicKeyPem, trustScore: 0.9 } });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_quarantine/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: availStartAt, endAt: availEndAt }] }
  });
  assert.equal(setAvail.statusCode, 201);
  let robotPrev = setAvail.json.robot.lastChainHash;

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let jobPrev = created.json.job.lastChainHash;

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": jobPrev },
    body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(quote.statusCode, 201);
  jobPrev = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": jobPrev },
    body: { paymentHoldId: "hold_q", startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(book.statusCode, 201);

  // Quarantine the robot after booking, before dispatch worker runs.
  const quarantinedAt = new Date().toISOString();
  const quarantine = await request(api, {
    method: "POST",
    path: "/robots/rob_quarantine/events",
    headers: { "x-proxy-expected-prev-chain-hash": robotPrev },
    body: {
      type: "ROBOT_QUARANTINED",
      actor: { type: "system", id: "proxy" },
      payload: { robotId: "rob_quarantine", quarantinedAt, reason: "MANUAL", manualClearRequired: true, notes: "test quarantine" }
    }
  });
  assert.equal(quarantine.statusCode, 201);
  assert.equal(quarantine.json.robot.status, "quarantined");

  const tick = await api.tickDispatch();
  assert.equal(tick.processed.length, 1);
  assert.equal(tick.processed[0].status, "failed");
  assert.equal(tick.processed[0].reason, "NO_ROBOTS");

  const after = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json.job.status, "BOOKED");
});

test("API e2e v0.8: high-severity incident triggers robot quarantine via policy worker", async () => {
  const api = createApi();

  const now = Date.now();
  const availStartAt = new Date(now - 60 * 60_000).toISOString();
  const availEndAt = new Date(now + 24 * 60 * 60_000).toISOString();
  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt = new Date(now + 70 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_inc", publicKeyPem: robotPublicKeyPem, trustScore: 0.9 } });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_inc/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: availStartAt, endAt: availEndAt }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let jobPrev = created.json.job.lastChainHash;

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": jobPrev },
    body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(quote.statusCode, 201);
  jobPrev = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": jobPrev },
    body: { paymentHoldId: "hold_inc", startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(book.statusCode, 201);

  const dispatchTick = await api.tickDispatch();
  assert.equal(dispatchTick.processed.length, 1);

  const jobAfterDispatch = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(jobAfterDispatch.statusCode, 200);
  assert.equal(jobAfterDispatch.json.job.status, "RESERVED");
  let lastChainHash = jobAfterDispatch.json.job.lastChainHash;

  const postRobotJobEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_inc" }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postRobotJobEvent("EN_ROUTE", { etaSeconds: 60 });

  await postRobotJobEvent("INCIDENT_DETECTED", {
    jobId,
    incidentId: "inc_sev4",
    type: "SAFETY_NEAR_MISS",
    severity: 4,
    summary: "near miss detected",
    signals: { bump: true }
  });

  const health = await api.tickRobotHealth();
  assert.equal(health.processed.length, 1);
  assert.equal(health.processed[0].robotId, "rob_inc");
  assert.equal(health.processed[0].status, "quarantined");

  const robotAfter = await request(api, { method: "GET", path: "/robots/rob_inc" });
  assert.equal(robotAfter.statusCode, 200);
  assert.equal(robotAfter.json.robot.status, "quarantined");
  assert.equal(robotAfter.json.robot.quarantine.reason, "INCIDENT");
});
