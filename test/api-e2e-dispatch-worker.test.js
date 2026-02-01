import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { request } from "./api-test-harness.js";

test("API e2e v0.7: dispatch worker respects zones and picks highest trustScore", async () => {
  const api = createApi();

  const now = Date.now();
  const availStartAt = new Date(now - 60 * 60_000).toISOString();
  const availEndAt = new Date(now + 24 * 60 * 60_000).toISOString();

  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt = new Date(now + 70 * 60_000).toISOString();

  const registerRobot = async ({ robotId, trustScore, zoneId }) => {
    const { publicKeyPem } = createEd25519Keypair();
    const reg = await request(api, {
      method: "POST",
      path: "/robots/register",
      body: { robotId, publicKeyPem, trustScore, homeZoneId: zoneId }
    });
    assert.equal(reg.statusCode, 201);
    const setAvail = await request(api, {
      method: "POST",
      path: `/robots/${robotId}/availability`,
      headers: { "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
      body: { availability: [{ startAt: availStartAt, endAt: availEndAt }] }
    });
    assert.equal(setAvail.statusCode, 201);
  };

  await registerRobot({ robotId: "rob_zone_a_low", trustScore: 0.2, zoneId: "zone_a" });
  await registerRobot({ robotId: "rob_zone_a_high", trustScore: 0.8, zoneId: "zone_a" });
  await registerRobot({ robotId: "rob_zone_b_highest", trustScore: 0.99, zoneId: "zone_b" });

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: { zoneId: "zone_a" } } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let prev = created.json.job.lastChainHash;

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": prev },
    body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(quote.statusCode, 201);
  prev = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": prev },
    body: { paymentHoldId: "hold_zone", startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(book.statusCode, 201);

  const dispatchTick = await api.tickDispatch();
  assert.equal(dispatchTick.processed.length, 1);
  assert.equal(dispatchTick.processed[0].jobId, jobId);

  const after = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json.job.status, "RESERVED");
  assert.equal(after.json.job.reservation.robotId, "rob_zone_a_high");
});

test("API e2e v0.7: operator coverage reservation gates dispatch worker", async () => {
  const api = createApi();

  const now = Date.now();
  const availStartAt = new Date(now - 60 * 60_000).toISOString();
  const availEndAt = new Date(now + 24 * 60 * 60_000).toISOString();
  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt = new Date(now + 70 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    body: { robotId: "rob_cov_dispatch", publicKeyPem: robotPublicKeyPem, trustScore: 0.5 }
  });
  assert.equal(regRobot.statusCode, 201);
  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_cov_dispatch/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: availStartAt, endAt: availEndAt }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const { publicKeyPem: robot2PublicKeyPem } = createEd25519Keypair();
  const regRobot2 = await request(api, {
    method: "POST",
    path: "/robots/register",
    body: { robotId: "rob_cov_dispatch_2", publicKeyPem: robot2PublicKeyPem, trustScore: 0.4 }
  });
  assert.equal(regRobot2.statusCode, 201);
  const setAvail2 = await request(api, {
    method: "POST",
    path: "/robots/rob_cov_dispatch_2/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot2.json.robot.lastChainHash },
    body: { availability: [{ startAt: availStartAt, endAt: availEndAt }] }
  });
  assert.equal(setAvail2.statusCode, 201);

  const { publicKeyPem: operatorPublicKeyPem, privateKeyPem: operatorPrivateKeyPem } = createEd25519Keypair();
  const operatorKeyId = keyIdFromPublicKeyPem(operatorPublicKeyPem);
  const regOperator = await request(api, { method: "POST", path: "/operators/register", body: { operatorId: "op_cov_dispatch", publicKeyPem: operatorPublicKeyPem } });
  assert.equal(regOperator.statusCode, 201);

  const openShiftDraft = createChainedEvent({
    streamId: "op_cov_dispatch",
    type: "OPERATOR_SHIFT_OPENED",
    actor: { type: "operator", id: "op_cov_dispatch" },
    payload: { operatorId: "op_cov_dispatch", shiftId: "shift_cov_1", maxConcurrentJobs: 1 }
  });
  const openShift = finalizeChainedEvent({
    event: openShiftDraft,
    prevChainHash: regOperator.json.operator.lastChainHash,
    signer: { keyId: operatorKeyId, privateKeyPem: operatorPrivateKeyPem }
  });
  const shiftRes = await request(api, { method: "POST", path: "/operators/op_cov_dispatch/events", body: openShift });
  assert.equal(shiftRes.statusCode, 201);

  const createAndBook = async (paymentHoldId) => {
    const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;
    let prev = created.json.job.lastChainHash;

    const quote = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/quote`,
      headers: { "x-proxy-expected-prev-chain-hash": prev },
      body: { startAt, endAt, environmentTier: "ENV_IN_HOME" }
    });
    assert.equal(quote.statusCode, 201);
    prev = quote.json.job.lastChainHash;

    const book = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/book`,
      headers: { "x-proxy-expected-prev-chain-hash": prev },
      body: { paymentHoldId, startAt, endAt, environmentTier: "ENV_IN_HOME" }
    });
    assert.equal(book.statusCode, 201);
    return jobId;
  };

  const job1Id = await createAndBook("hold_cov_job1");
  const job2Id = await createAndBook("hold_cov_job2");

  const dispatchTick = await api.tickDispatch();
  assert.equal(dispatchTick.processed.length, 2);

  const job1 = await request(api, { method: "GET", path: `/jobs/${job1Id}` });
  assert.equal(job1.statusCode, 200);
  assert.equal(job1.json.job.status, "RESERVED");
  assert.equal(job1.json.job.operatorCoverage.status, "reserved");
  assert.equal(job1.json.job.operatorCoverage.operatorId, "op_cov_dispatch");

  const job2 = await request(api, { method: "GET", path: `/jobs/${job2Id}` });
  assert.equal(job2.statusCode, 200);
  assert.equal(job2.json.job.status, "BOOKED");
  assert.equal(job2.json.job.operatorCoverage.status, "none");

  const job2Events = await request(api, { method: "GET", path: `/jobs/${job2Id}/events` });
  assert.equal(job2Events.statusCode, 200);
  let failed = null;
  for (let i = job2Events.json.events.length - 1; i >= 0; i -= 1) {
    const e = job2Events.json.events[i];
    if (e?.type === "DISPATCH_FAILED") {
      failed = e;
      break;
    }
  }
  assert.ok(failed, "expected a DISPATCH_FAILED event");
  assert.equal(failed.payload.reason, "NO_OPERATORS");
});

test("API e2e v0.7: stalled execution enqueues and assigns operator assist", async () => {
  let nowMs = Date.parse("2026-01-26T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });

  const bookingStartAt = new Date(nowMs - 60_000).toISOString();
  const bookingEndAt = new Date(nowMs + 60 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    body: { robotId: "rob_stall", publicKeyPem: robotPublicKeyPem, trustScore: 0.8 }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_stall/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: new Date(nowMs - 60 * 60_000).toISOString(), endAt: new Date(nowMs + 24 * 60 * 60_000).toISOString() }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const { publicKeyPem: operatorPublicKeyPem, privateKeyPem: operatorPrivateKeyPem } = createEd25519Keypair();
  const operatorKeyId = keyIdFromPublicKeyPem(operatorPublicKeyPem);
  const regOperator = await request(api, {
    method: "POST",
    path: "/operators/register",
    body: { operatorId: "op_stall", publicKeyPem: operatorPublicKeyPem }
  });
  assert.equal(regOperator.statusCode, 201);

  const openShiftDraft = createChainedEvent({
    streamId: "op_stall",
    type: "OPERATOR_SHIFT_OPENED",
    actor: { type: "operator", id: "op_stall" },
    payload: { operatorId: "op_stall", shiftId: "shift_stall_1", maxConcurrentJobs: 1 },
    at: new Date(nowMs).toISOString()
  });
  const openShift = finalizeChainedEvent({
    event: openShiftDraft,
    prevChainHash: regOperator.json.operator.lastChainHash,
    signer: { keyId: operatorKeyId, privateKeyPem: operatorPrivateKeyPem }
  });
  const shiftRes = await request(api, { method: "POST", path: "/operators/op_stall/events", body: openShift });
  assert.equal(shiftRes.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let prev = created.json.job.lastChainHash;

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": prev },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_IN_HOME" }
  });
  assert.equal(quote.statusCode, 201);
  prev = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": prev },
    body: { paymentHoldId: "hold_stall", startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_IN_HOME" }
  });
  assert.equal(book.statusCode, 201);

  const dispatchTick = await api.tickDispatch();
  assert.equal(dispatchTick.processed.length, 1);

  const afterDispatch = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(afterDispatch.statusCode, 200);
  assert.equal(afterDispatch.json.job.status, "RESERVED");
  let lastChainHash = afterDispatch.json.job.lastChainHash;

  const accessPlanId = "ap_stall";
  const issuePlan = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      type: "ACCESS_PLAN_ISSUED",
      actor: { type: "system", id: "proxy" },
      payload: {
        jobId,
        accessPlanId,
        method: "DOCKED_IN_BUILDING",
        credentialRef: "vault://access/ap_stall/v1",
        scope: { areas: ["ENTRYWAY"] },
        validFrom: new Date(nowMs - 60_000).toISOString(),
        validTo: new Date(nowMs + 60 * 60_000).toISOString(),
        revocable: true,
        requestedBy: "system"
      }
    }
  });
  assert.equal(issuePlan.statusCode, 201);
  lastChainHash = issuePlan.json.job.lastChainHash;

  const postRobotEvent = async (type, payload) => {
    const at = new Date(nowMs).toISOString();
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_stall" }, payload, at });
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

  await postRobotEvent("EN_ROUTE", { etaSeconds: 10 });
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" });

  await postRobotEvent("JOB_EXECUTION_STARTED", { jobId, robotId: "rob_stall", startedAt: new Date(nowMs).toISOString(), stage: "TASK" });
  nowMs += 30_000;
  await postRobotEvent("JOB_HEARTBEAT", { jobId, robotId: "rob_stall", t: new Date(nowMs).toISOString(), stage: "TASK", progress: 0 });

  // In-home stalls after 3 * 30s = 90s without a heartbeat.
  nowMs += 91_000;
  const liveness = await api.tickLiveness();
  assert.equal(liveness.appended.length, 1);
  assert.equal(liveness.appended[0].type, "JOB_EXECUTION_STALLED");

  const queue = await api.tickOperatorQueue();
  assert.equal(queue.processed.length, 1);
  assert.equal(queue.processed[0].jobId, jobId);
  assert.equal(queue.processed[0].status, "assigned");

  const afterQueue = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(afterQueue.statusCode, 200);
  assert.equal(afterQueue.json.job.status, "STALLED");
  assert.equal(afterQueue.json.job.assist.status, "assigned");
  assert.equal(afterQueue.json.job.assist.operatorId, "op_stall");
});
