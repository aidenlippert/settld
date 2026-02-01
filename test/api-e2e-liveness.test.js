import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { makeBookedPayload, request } from "./api-test-harness.js";

test("API e2e v0.6: execution heartbeats, stall detection, and resume", async () => {
  let nowMs = Date.parse("2026-01-26T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });

  const bookingStartAt = new Date(nowMs + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(nowMs + 65 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    body: { robotId: "rob_live", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_live/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: {
      availability: [{ startAt: new Date(nowMs - 60 * 60_000).toISOString(), endAt: new Date(nowMs + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const createJob = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(createJob.statusCode, 201);
  const jobId = createJob.json.job.id;
  let lastChainHash = createJob.json.job.lastChainHash;

  const postServerEvent = async (type, payload, key) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": key },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    lastChainHash = res.json?.job?.lastChainHash ?? lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload) => {
    const at = new Date(nowMs).toISOString();
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_live" }, payload, at });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    lastChainHash = res.json?.job?.lastChainHash ?? lastChainHash;
    return res;
  };

  assert.equal((await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_live")).statusCode, 201);
  assert.equal(
    (
      await postServerEvent(
        "BOOKED",
        makeBookedPayload({
          paymentHoldId: "hold_live",
          startAt: bookingStartAt,
          endAt: bookingEndAt,
          environmentTier: "ENV_MANAGED_BUILDING",
          requiresOperatorCoverage: false
        }),
        "b_live"
      )
    ).statusCode,
    201
  );
  assert.equal((await postServerEvent("MATCHED", { robotId: "rob_live" }, "m_live")).statusCode, 201);
  assert.equal(
    (await postServerEvent("RESERVED", { robotId: "rob_live", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_live_1" }, "r_live"))
      .statusCode,
    201
  );

  const accessPlanId = "ap_live";
  assert.equal(
    (
      await postServerEvent(
        "ACCESS_PLAN_ISSUED",
        {
          jobId,
          accessPlanId,
          method: "DOCKED_IN_BUILDING",
          credentialRef: "vault://access/ap_live/v1",
          scope: { areas: ["ENTRYWAY"] },
          validFrom: new Date(nowMs - 60_000).toISOString(),
          validTo: new Date(nowMs + 60 * 60_000).toISOString(),
          revocable: true,
          requestedBy: "system"
        },
        "ap_live_1"
      )
    ).statusCode,
    201
  );

  assert.equal((await postRobotEvent("EN_ROUTE", { etaSeconds: 10 })).statusCode, 201);
  assert.equal((await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" })).statusCode, 201);

  // Heartbeat is rejected before execution starts.
  const hbEarly = await postRobotEvent("JOB_HEARTBEAT", {
    jobId,
    robotId: "rob_live",
    t: new Date(nowMs).toISOString(),
    stage: "TASK",
    progress: 0
  });
  assert.equal(hbEarly.statusCode, 400);

  // Start execution (v0.6 event family).
  const started = await postRobotEvent("JOB_EXECUTION_STARTED", {
    jobId,
    robotId: "rob_live",
    startedAt: new Date(nowMs).toISOString(),
    stage: "TASK"
  });
  assert.equal(started.statusCode, 201);
  assert.equal(started.json.job.status, "EXECUTING");

  // Heartbeat accepted during execution.
  nowMs += 30_000;
  const hb1 = await postRobotEvent("JOB_HEARTBEAT", {
    jobId,
    robotId: "rob_live",
    t: new Date(nowMs).toISOString(),
    stage: "TASK",
    progress: 1
  });
  assert.equal(hb1.statusCode, 201);

  // Stall after missing heartbeats beyond the tier policy.
  nowMs += 181_000;
  const tick1 = await api.tickLiveness();
  assert.equal(tick1.appended.length, 1);
  assert.equal(tick1.appended[0].type, "JOB_EXECUTION_STALLED");
  lastChainHash = tick1.appended[0].chainHash;

  const jobAfterStall = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(jobAfterStall.statusCode, 200);
  assert.equal(jobAfterStall.json.job.status, "STALLED");

  // Heartbeats can be accepted while stalled; server tick resumes once heartbeats are back.
  nowMs += 10_000;
  const hb2 = await postRobotEvent("JOB_HEARTBEAT", {
    jobId,
    robotId: "rob_live",
    t: new Date(nowMs).toISOString(),
    stage: "TASK",
    progress: 2
  });
  assert.equal(hb2.statusCode, 201);

  const tick2 = await api.tickLiveness();
  assert.equal(tick2.appended.length, 1);
  assert.equal(tick2.appended[0].type, "JOB_EXECUTION_RESUMED");
  lastChainHash = tick2.appended[0].chainHash;

  const jobAfterResume = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(jobAfterResume.statusCode, 200);
  assert.equal(jobAfterResume.json.job.status, "EXECUTING");

  // After completion, liveness tick does not stall.
  nowMs += 5_000;
  const completed = await postRobotEvent("JOB_EXECUTION_COMPLETED", {
    jobId,
    robotId: "rob_live",
    completedAt: new Date(nowMs).toISOString()
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json.job.status, "COMPLETED");

  nowMs += 10 * 60_000;
  const tick3 = await api.tickLiveness();
  assert.equal(tick3.appended.length, 0);
});
