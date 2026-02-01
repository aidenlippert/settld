import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { makeBookedPayload, request } from "./api-test-harness.js";

test("API e2e: skills licensing, usage enforcement, and royalty settlement", async () => {
  const api = createApi();

  const now = Date.now();
  const bookingStartAt = new Date(now + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 65 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: { "x-idempotency-key": "robot_reg_skills_1" },
    body: { robotId: "rob_skills", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_skills/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash, "x-idempotency-key": "rob_skills_avail_1" },
    body: {
      availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const createJob = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { "x-idempotency-key": "job_create_skills_1" },
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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_skills" }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    lastChainHash = res.json?.job?.lastChainHash ?? lastChainHash;
    return res;
  };

  assert.equal((await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_skills")).statusCode, 201);
  assert.equal(
    (
      await postServerEvent(
        "BOOKED",
        makeBookedPayload({
          paymentHoldId: "hold_skills",
          startAt: bookingStartAt,
          endAt: bookingEndAt,
          environmentTier: "ENV_MANAGED_BUILDING",
          requiresOperatorCoverage: false
        }),
        "b_skills"
      )
    ).statusCode,
    201
  );
  assert.equal((await postServerEvent("MATCHED", { robotId: "rob_skills" }, "m_skills")).statusCode, 201);
  assert.equal(
    (await postServerEvent("RESERVED", { robotId: "rob_skills", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_skills_1" }, "r_skills"))
      .statusCode,
    201
  );

  const accessPlanId = "ap_skills";
  assert.equal(
    (
      await postServerEvent(
        "ACCESS_PLAN_ISSUED",
        {
          jobId,
          accessPlanId,
          method: "DOCKED_IN_BUILDING",
          credentialRef: "vault://access/ap_skills/v1",
          scope: { areas: ["ENTRYWAY"] },
          validFrom: new Date(now - 60_000).toISOString(),
          validTo: new Date(now + 60 * 60_000).toISOString(),
          revocable: true,
          requestedBy: "system"
        },
        "ap_skills_1"
      )
    ).statusCode,
    201
  );

  // License two skills before execution.
  const lic1 = {
    jobId,
    skill: { skillId: "skill_reset_lite", version: "1.0.0", developerId: "dev_a" },
    pricing: { model: "PER_JOB", amountCents: 399, currency: "USD" },
    licenseId: "lic_1",
    terms: { refundableUntilState: "EXECUTING", requiresCertificationTier: "CERTIFIED" }
  };
  const lic2 = {
    jobId,
    skill: { skillId: "skill_wipe_surfaces", version: "1.2.0", developerId: "dev_b" },
    pricing: { model: "PER_JOB", amountCents: 250, currency: "USD" },
    licenseId: "lic_2"
  };

  assert.equal((await postServerEvent("SKILL_LICENSED", lic1, "lic1")).statusCode, 201);
  assert.equal((await postServerEvent("SKILL_LICENSED", lic2, "lic2")).statusCode, 201);

  assert.equal((await postRobotEvent("EN_ROUTE", { etaSeconds: 10 })).statusCode, 201);
  assert.equal((await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" })).statusCode, 201);
  assert.equal((await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] })).statusCode, 201);

  // Cannot license after execution starts.
  const lateLicense = await postServerEvent("SKILL_LICENSED", { ...lic1, licenseId: "lic_late" }, "lic_late");
  assert.equal(lateLicense.statusCode, 400);

  // Cannot use a skill without a license.
  const unlicensedUse = await postRobotEvent("SKILL_USED", { jobId, licenseId: "lic_missing", step: "wipe" });
  assert.equal(unlicensedUse.statusCode, 400);

  // Can use a licensed skill during execution.
  assert.equal((await postRobotEvent("SKILL_USED", { jobId, licenseId: "lic_1", step: "reset" })).statusCode, 201);

  assert.equal((await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } })).statusCode, 201);
  assert.equal((await postServerEvent("SETTLED", { settlement: "demo" }, "settle_skills")).statusCode, 201);

  assert.equal(api.store.ledger.balances.get("acct_cash"), 6500);
  assert.equal(api.store.ledger.balances.get("acct_customer_escrow"), 0);
  assert.equal(api.store.ledger.balances.get("acct_platform_revenue"), -1300);
  assert.equal(api.store.ledger.balances.get("acct_operator_payable"), 0);
  assert.equal(api.store.ledger.balances.get("acct_developer_royalty_payable"), -649);
  assert.equal(api.store.ledger.balances.get("acct_insurance_reserve"), -130);
  assert.equal(api.store.ledger.balances.get("acct_owner_payable"), -4421);
});
