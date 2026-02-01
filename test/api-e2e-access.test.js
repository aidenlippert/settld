import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { makeBookedPayload, request } from "./api-test-harness.js";

test("API e2e: access gating, revocation, and no-secrets", async () => {
  const api = createApi();

  const now = Date.now();
  const bookingStartAt = new Date(now + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 65 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: { "x-idempotency-key": "robot_reg_access_1" },
    body: { robotId: "rob_access", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_access/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash, "x-idempotency-key": "rob_access_avail_1" },
    body: {
      availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const createJob = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { "x-idempotency-key": "job_create_access_1" },
    body: { templateId: "reset_lite", constraints: { privacyMode: "minimal" } }
  });
  assert.equal(createJob.statusCode, 201);
  const jobId = createJob.json.job.id;
  let lastChainHash = createJob.json.job.lastChainHash;

  const postServerEvent = async (type, payload, idempotencyKey) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": idempotencyKey },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    lastChainHash = res.json?.job?.lastChainHash ?? lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_access" }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    lastChainHash = res.json?.job?.lastChainHash ?? lastChainHash;
    return res;
  };

  assert.equal((await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_access")).statusCode, 201);
  assert.equal(
    (
      await postServerEvent(
        "BOOKED",
        makeBookedPayload({
          paymentHoldId: "hold_access",
          startAt: bookingStartAt,
          endAt: bookingEndAt,
          environmentTier: "ENV_MANAGED_BUILDING",
          requiresOperatorCoverage: false
        }),
        "b_access"
      )
    ).statusCode,
    201
  );
  assert.equal((await postServerEvent("MATCHED", { robotId: "rob_access" }, "m_access")).statusCode, 201);
  assert.equal(
    (await postServerEvent("RESERVED", { robotId: "rob_access", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_access_1" }, "r_access"))
      .statusCode,
    201
  );
  assert.equal((await postRobotEvent("EN_ROUTE", { etaSeconds: 60 })).statusCode, 201);

  // Cannot grant access without a plan.
  const noPlanGrant = await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId: "ap_missing" });
  assert.equal(noPlanGrant.statusCode, 400);

  // Cannot issue access plan containing secrets.
  const badPlan = await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId: "ap_bad",
      method: "SMART_LOCK_CODE",
      credentialRef: "vault://access/ap_bad/v1",
      code: "1234",
      validFrom: new Date(now - 60_000).toISOString(),
      validTo: new Date(now + 60 * 60_000).toISOString(),
      revocable: true
    },
    "ap_bad_1"
  );
  assert.equal(badPlan.statusCode, 400);

  const accessPlanId = "ap_ok";
  const goodPlan = await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "SMART_LOCK_CODE",
      credentialRef: "vault://access/ap_ok/v1",
      scope: { areas: ["ENTRYWAY"], noGo: ["BEDROOM_2"] },
      validFrom: new Date(now - 60_000).toISOString(),
      validTo: new Date(now + 60 * 60_000).toISOString(),
      revocable: true,
      requestedBy: "system"
    },
    "ap_ok_1"
  );
  assert.equal(goodPlan.statusCode, 201);

  assert.equal((await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "SMART_LOCK_CODE" })).statusCode, 201);
  assert.equal((await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] })).statusCode, 201);

  const revoked = await postServerEvent(
    "ACCESS_REVOKED",
    { jobId, accessPlanId, requestedBy: "customer", reason: "user revoked access" },
    "revoke_1"
  );
  assert.equal(revoked.statusCode, 201);
  assert.equal(revoked.json.job.status, "ABORTING_SAFE_EXIT");

  const rejectedWork = await postRobotEvent("CHECKPOINT_REACHED", { checkpoint: "scan_start" });
  assert.equal(rejectedWork.statusCode, 400);

  const aborted = await postRobotEvent("EXECUTION_ABORTED", { reason: "access revoked" });
  assert.equal(aborted.statusCode, 201);
  assert.equal(aborted.json.job.status, "ABORTED");
});
