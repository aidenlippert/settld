import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { makeBookedPayload, request } from "./api-test-harness.js";

test("API e2e: lifecycle with signing, concurrency, and idempotency", async () => {
  const api = createApi();

  const now = Date.now();
  const bookingStartAt = new Date(now + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 65 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const { publicKeyPem: operatorPublicKeyPem, privateKeyPem: operatorPrivateKeyPem } = createEd25519Keypair();
  const operatorKeyId = keyIdFromPublicKeyPem(operatorPublicKeyPem);

  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: { "x-idempotency-key": "robot_reg_1" },
    body: { robotId: "rob_demo", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.statusCode, 201);

  // Make robot available for the booking window.
  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_demo/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash, "x-idempotency-key": "rob_demo_avail_1" },
    body: {
      availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const regOperator = await request(api, {
    method: "POST",
    path: "/operators/register",
    headers: { "x-idempotency-key": "op_reg_1" },
    body: { operatorId: "op_demo", publicKeyPem: operatorPublicKeyPem }
  });
  assert.equal(regOperator.statusCode, 201);

  const createJob = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { "x-idempotency-key": "job_create_1" },
    body: { templateId: "reset_lite", constraints: { privacyMode: "minimal" } }
  });
  assert.equal(createJob.statusCode, 201);
  const jobId = createJob.json.job.id;
  let lastChainHash = createJob.json.job.lastChainHash;
  assert.ok(lastChainHash);

  const postServerEvent = async (type, payload, idempotencyKey) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": idempotencyKey },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_demo" }, payload });
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

  const postOperatorEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "operator", id: "op_demo" }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: operatorKeyId, privateKeyPem: operatorPrivateKeyPem }
    });

    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q1");
  await postServerEvent(
    "BOOKED",
    makeBookedPayload({
      paymentHoldId: "hold_1",
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false
    }),
    "b1"
  );
  await postServerEvent("MATCHED", { robotId: "rob_demo" }, "m1");
  await postServerEvent("RESERVED", { robotId: "rob_demo", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_1" }, "r1");

  const accessPlanId = "ap_demo";
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "BUILDING_CONCIERGE",
      credentialRef: "vault://access/ap_demo/v1",
      scope: { areas: ["ENTRYWAY"], noGo: ["BEDROOM_2"] },
      validFrom: new Date(now - 60_000).toISOString(),
      validTo: new Date(now + 60 * 60_000).toISOString(),
      revocable: true,
      requestedBy: "system"
    },
    "ap1"
  );

  await postRobotEvent("EN_ROUTE", { etaSeconds: 120 });
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "BUILDING_CONCIERGE" });
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] });

  await postOperatorEvent("ASSIST_STARTED", { reason: "uncertain_object" });
  await postOperatorEvent("ASSIST_ENDED", { outcome: "approved" });

  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } });
  const settleExpectedPrev = lastChainHash;
  await postServerEvent("SETTLED", { settlement: "demo" }, "s1");

  assert.equal(api.store.ledger.balances.get("acct_cash"), 6500);
  assert.equal(api.store.ledger.balances.get("acct_customer_escrow"), 0);
  assert.equal(api.store.ledger.balances.get("acct_platform_revenue"), -1300);
  assert.equal(api.store.ledger.balances.get("acct_owner_payable"), -4745);
  assert.equal(api.store.ledger.balances.get("acct_operator_payable"), -325);
  assert.equal(api.store.ledger.balances.get("acct_developer_royalty_payable"), 0);
  assert.equal(api.store.ledger.balances.get("acct_insurance_reserve"), -130);

  // Idempotency: replay a server event call with same key + payload returns the same event.
  const beforeReplay = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(beforeReplay.statusCode, 200);
  const countBefore = beforeReplay.json.events.length;

  const replay = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": settleExpectedPrev, "x-idempotency-key": "s1" },
    body: { type: "SETTLED", actor: { type: "system", id: "proxy" }, payload: { settlement: "demo" } }
  });
  assert.equal(replay.statusCode, 201);

  const afterReplay = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  const countAfter = afterReplay.json.events.length;
  assert.equal(countAfter, countBefore, "idempotent replay should not append a second event");

  // Concurrency: wrong expected prev hash returns 409.
  const conflict = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": "deadbeef", "x-idempotency-key": "conflict1" },
    body: { type: "QUOTE_PROPOSED", actor: { type: "system", id: "proxy" }, payload: { amountCents: 1 } }
  });
  assert.equal(conflict.statusCode, 409);
});
