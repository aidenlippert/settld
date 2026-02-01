import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { request } from "./api-test-harness.js";

test("API e2e v0.6: reschedule replaces reservation and frees robot for other jobs", async () => {
  const api = createApi();

  const now = Date.now();
  const windowAStart = new Date(now + 10 * 60_000).toISOString();
  const windowAEnd = new Date(now + 70 * 60_000).toISOString();

  const windowBStart = new Date(now + 3 * 60 * 60_000).toISOString();
  const windowBEnd = new Date(now + 4 * 60 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_sched", publicKeyPem: robotPublicKeyPem, trustScore: 0.8 } });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_sched/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const createAndBook = async (jobKey) => {
    const created = await request(api, { method: "POST", path: "/jobs", headers: { "x-idempotency-key": jobKey }, body: { templateId: "reset_lite", constraints: {} } });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;
    let prev = created.json.job.lastChainHash;

    const quote = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/quote`,
      headers: { "x-proxy-expected-prev-chain-hash": prev },
      body: { startAt: windowAStart, endAt: windowAEnd, environmentTier: "ENV_MANAGED_BUILDING" }
    });
    assert.equal(quote.statusCode, 201);
    prev = quote.json.job.lastChainHash;

    const book = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/book`,
      headers: { "x-proxy-expected-prev-chain-hash": prev },
      body: { paymentHoldId: `hold_${jobKey}`, startAt: windowAStart, endAt: windowAEnd, environmentTier: "ENV_MANAGED_BUILDING" }
    });
    assert.equal(book.statusCode, 201);
    prev = book.json.job.lastChainHash;
    return { jobId, prev };
  };

  const job1 = await createAndBook("rsv_job1");
  const job2 = await createAndBook("rsv_job2");

  const dispatch1 = await request(api, { method: "POST", path: `/jobs/${job1.jobId}/dispatch`, headers: { "x-proxy-expected-prev-chain-hash": job1.prev }, body: {} });
  assert.equal(dispatch1.statusCode, 201);
  const job1AfterDispatch = dispatch1.json.job;

  const dispatch2Fail = await request(api, { method: "POST", path: `/jobs/${job2.jobId}/dispatch`, headers: { "x-proxy-expected-prev-chain-hash": job2.prev }, body: {} });
  assert.equal(dispatch2Fail.statusCode, 409);

  const reschedule = await request(api, {
    method: "POST",
    path: `/jobs/${job1.jobId}/reschedule`,
    headers: { "x-proxy-expected-prev-chain-hash": job1AfterDispatch.lastChainHash, "x-idempotency-key": "resched_1" },
    body: { startAt: windowBStart, endAt: windowBEnd, reason: "CUSTOMER_REQUEST" }
  });
  assert.equal(reschedule.statusCode, 201);
  assert.equal(reschedule.json.events.length, 3);
  assert.equal(reschedule.json.job.status, "RESERVED");
  assert.equal(reschedule.json.job.booking.startAt, windowBStart);
  assert.equal(reschedule.json.job.reservation.startAt, windowBStart);

  // Idempotency returns the original response body.
  const rescheduleRetry = await request(api, {
    method: "POST",
    path: `/jobs/${job1.jobId}/reschedule`,
    headers: { "x-proxy-expected-prev-chain-hash": job1AfterDispatch.lastChainHash, "x-idempotency-key": "resched_1" },
    body: { startAt: windowBStart, endAt: windowBEnd, reason: "CUSTOMER_REQUEST" }
  });
  assert.equal(rescheduleRetry.statusCode, 201);
  assert.deepEqual(rescheduleRetry.json, reschedule.json);

  const dispatch2 = await request(api, { method: "POST", path: `/jobs/${job2.jobId}/dispatch`, headers: { "x-proxy-expected-prev-chain-hash": job2.prev }, body: {} });
  assert.equal(dispatch2.statusCode, 201);
});

test("API e2e v0.6: reschedule is rejected after execution starts", async () => {
  const api = createApi();

  const now = Date.now();
  const bookingStartAt = new Date(now + 10 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 70 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_exec", publicKeyPem: robotPublicKeyPem, trustScore: 0.8 } });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_exec/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let prev = created.json.job.lastChainHash;

  const quote = await request(api, { method: "POST", path: `/jobs/${jobId}/quote`, headers: { "x-proxy-expected-prev-chain-hash": prev }, body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING" } });
  assert.equal(quote.statusCode, 201);
  prev = quote.json.job.lastChainHash;

  const book = await request(api, { method: "POST", path: `/jobs/${jobId}/book`, headers: { "x-proxy-expected-prev-chain-hash": prev }, body: { paymentHoldId: "hold_exec", startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING" } });
  assert.equal(book.statusCode, 201);
  prev = book.json.job.lastChainHash;

  const dispatch = await request(api, { method: "POST", path: `/jobs/${jobId}/dispatch`, headers: { "x-proxy-expected-prev-chain-hash": prev }, body: {} });
  assert.equal(dispatch.statusCode, 201);
  prev = dispatch.json.job.lastChainHash;

  // Issue access plan (server event via /events).
  const accessPlanId = "ap_exec";
  const issuePlan = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": prev },
    body: {
      type: "ACCESS_PLAN_ISSUED",
      actor: { type: "system", id: "proxy" },
      payload: {
        jobId,
        accessPlanId,
        method: "DOCKED_IN_BUILDING",
        credentialRef: "vault://access/ap_exec/v1",
        validFrom: new Date(now - 60_000).toISOString(),
        validTo: new Date(now + 60 * 60_000).toISOString(),
        revocable: true,
        requestedBy: "system"
      }
    }
  });
  assert.equal(issuePlan.statusCode, 201);
  prev = issuePlan.json.job.lastChainHash;

  const agentSignedEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_exec" }, payload });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: prev, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    prev = res.json?.job?.lastChainHash ?? prev;
    return res;
  };

  assert.equal((await agentSignedEvent("EN_ROUTE", { etaSeconds: 10 })).statusCode, 201);
  assert.equal((await agentSignedEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" })).statusCode, 201);
  assert.equal((await agentSignedEvent("EXECUTION_STARTED", { plan: ["navigate"] })).statusCode, 201);

  const reschedule = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/reschedule`,
    headers: { "x-proxy-expected-prev-chain-hash": prev },
    body: { startAt: new Date(now + 2 * 60 * 60_000).toISOString(), endAt: new Date(now + 3 * 60 * 60_000).toISOString(), reason: "CUSTOMER_REQUEST" }
  });
  assert.equal(reschedule.statusCode, 400);
});

