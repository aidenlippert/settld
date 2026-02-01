import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { makeBookedPayload, request } from "./api-test-harness.js";

test("API e2e: incident → evidence → claim → adjust → paid (ledger is deterministic)", async () => {
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
    headers: { "x-idempotency-key": "robot_reg_claims_1" },
    body: { robotId: "rob_claims", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_claims/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash, "x-idempotency-key": "rob_claims_avail_1" },
    body: {
      availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  await request(api, {
    method: "POST",
    path: "/operators/register",
    headers: { "x-idempotency-key": "op_reg_claims_1" },
    body: { operatorId: "op_claims", publicKeyPem: operatorPublicKeyPem }
  });

  const createJob = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { "x-idempotency-key": "job_create_claims_1" },
    body: { templateId: "reset_lite", constraints: { privacyMode: "minimal" } }
  });
  assert.equal(createJob.statusCode, 201);
  const jobId = createJob.json.job.id;
  let lastChainHash = createJob.json.job.lastChainHash;

  const postServerEvent = async (type, payload, idempotencyKey, actor = { type: "system", id: "proxy" }) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": idempotencyKey },
      body: { type, actor, payload }
    });
    if (res.statusCode === 201) lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_claims" }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    if (res.statusCode === 201) lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postOperatorEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "operator", id: "op_claims" }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: operatorKeyId, privateKeyPem: operatorPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    if (res.statusCode === 201) lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  assert.equal((await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_claims")).statusCode, 201);
  assert.equal(
    (
      await postServerEvent(
        "BOOKED",
        makeBookedPayload({
          paymentHoldId: "hold_claims",
          startAt: bookingStartAt,
          endAt: bookingEndAt,
          environmentTier: "ENV_MANAGED_BUILDING",
          requiresOperatorCoverage: false
        }),
        "b_claims"
      )
    ).statusCode,
    201
  );
  assert.equal((await postServerEvent("MATCHED", { robotId: "rob_claims" }, "m_claims")).statusCode, 201);
  assert.equal(
    (await postServerEvent("RESERVED", { robotId: "rob_claims", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_claims_1" }, "r_claims"))
      .statusCode,
    201
  );

  const accessPlanId = "ap_claims";
  assert.equal(
    (
      await postServerEvent(
        "ACCESS_PLAN_ISSUED",
        {
          jobId,
          accessPlanId,
          method: "DOCKED_IN_BUILDING",
          credentialRef: "vault://access/ap_claims/v1",
          scope: { areas: ["ENTRYWAY"] },
          validFrom: new Date(now - 60_000).toISOString(),
          validTo: new Date(now + 60 * 60_000).toISOString(),
          revocable: true,
          requestedBy: "system"
        },
        "ap_claims_1"
      )
    ).statusCode,
    201
  );

  assert.equal((await postRobotEvent("EN_ROUTE", { etaSeconds: 10 })).statusCode, 201);
  assert.equal((await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" })).statusCode, 201);
  assert.equal((await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] })).statusCode, 201);

  const incidentId = "inc_claims_1";
  assert.equal(
    (
      await postRobotEvent("INCIDENT_DETECTED", {
        jobId,
        incidentId,
        type: "DAMAGE_PROPERTY",
        severity: 4,
        summary: "impact detected",
        signals: { impactG: 3.2 }
      })
    ).statusCode,
    201
  );

  const badEvidence = await postRobotEvent("EVIDENCE_CAPTURED", {
    jobId,
    incidentId,
    evidenceId: "evid_bad_1",
    evidenceRef: "obj://evidence/evid_bad_1",
    kind: "VIDEO_CLIP",
    durationSeconds: 10,
    redaction: { state: "NONE" },
    data: "base64:AAAA"
  });
  assert.equal(badEvidence.statusCode, 400);

  assert.equal(
    (
      await postRobotEvent("EVIDENCE_CAPTURED", {
        jobId,
        incidentId,
        evidenceId: "evid_1",
        evidenceRef: "obj://evidence/evid_1",
        kind: "VIDEO_CLIP",
        durationSeconds: 10,
        contentType: "video/mp4",
        redaction: { state: "NONE" }
      })
    ).statusCode,
    201
  );

  assert.equal((await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } })).statusCode, 201);
  assert.equal((await postServerEvent("SETTLED", { settlement: "demo" }, "settle_claims")).statusCode, 201);

  // No incident -> cannot open claim.
  const noIncidentClaim = await postServerEvent(
    "CLAIM_OPENED",
    { jobId, claimId: "cl_missing_inc", incidentId: "inc_missing", reasonCode: "DAMAGE_PROPERTY" },
    "cl_missing_inc"
  );
  assert.equal(noIncidentClaim.statusCode, 400);

  const claimId = "cl_1";
  assert.equal(
    (
      await postServerEvent(
        "CLAIM_OPENED",
        { jobId, claimId, incidentId, reasonCode: "DAMAGE_PROPERTY", description: "scratched wall" },
        "cl_open_1"
      )
    ).statusCode,
    201
  );

  assert.equal((await postOperatorEvent("CLAIM_TRIAGED", { jobId, claimId, triageCode: "REVIEW", notes: "needs payout" })).statusCode, 201);

  const approveExpectedPrev = lastChainHash;
  assert.equal(
    (
      await postServerEvent(
        "CLAIM_APPROVED",
        { jobId, claimId, currency: "USD", amounts: { payoutCents: 5000, refundCents: 1000 }, reasonCode: "DAMAGE_PROPERTY" },
        "cl_approve_1"
      )
    ).statusCode,
    201
  );

  const beforeReplay = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(beforeReplay.statusCode, 200);
  const countBefore = beforeReplay.json.events.length;

  const replayApproval = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": approveExpectedPrev, "x-idempotency-key": "cl_approve_1" },
    body: {
      type: "CLAIM_APPROVED",
      actor: { type: "system", id: "proxy" },
      payload: { jobId, claimId, currency: "USD", amounts: { payoutCents: 5000, refundCents: 1000 }, reasonCode: "DAMAGE_PROPERTY" }
    }
  });
  assert.equal(replayApproval.statusCode, 201);

  const afterReplay = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(afterReplay.statusCode, 200);
  const countAfter = afterReplay.json.events.length;
  assert.equal(countAfter, countBefore, "idempotent replay should not append a second approval event");

  const adjusted = await postServerEvent("JOB_ADJUSTED", { jobId, claimId, adjustmentId: "adj_1" }, "adj_1");
  assert.equal(adjusted.statusCode, 201);
  assert.ok(adjusted.json.ledgerEntryId);
  assert.equal(adjusted.json.job.claims[0].claimId, claimId);

  const paid = await postServerEvent(
    "CLAIM_PAID",
    { jobId, claimId, amountCents: 6000, currency: "USD", paymentRef: "stripe:tr_123" },
    "cl_paid_1"
  );
  assert.equal(paid.statusCode, 201);
  assert.ok(paid.json.ledgerEntryId);
  assert.equal(paid.json.job.claims[0].status, "PAID");

  assert.equal(api.store.ledger.balances.get("acct_cash"), 500);
  assert.equal(api.store.ledger.balances.get("acct_customer_escrow"), 0);
  assert.equal(api.store.ledger.balances.get("acct_platform_revenue"), -1100);
  assert.equal(api.store.ledger.balances.get("acct_owner_payable"), -4290);
  assert.equal(api.store.ledger.balances.get("acct_insurance_reserve"), -110);
  assert.equal(api.store.ledger.balances.get("acct_claims_expense"), 5000);
  assert.equal(api.store.ledger.balances.get("acct_claims_payable"), 0);
});

test("API e2e: claim approval cap requires elevated actor", async () => {
  const api = createApi();

  const now = Date.now();
  const bookingStartAt = new Date(now + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 65 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: { "x-idempotency-key": "robot_reg_claims_2" },
    body: { robotId: "rob_claims2", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_claims2/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash, "x-idempotency-key": "rob_claims2_avail_1" },
    body: {
      availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const createJob = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { "x-idempotency-key": "job_create_claims_2" },
    body: { templateId: "reset_lite", constraints: { privacyMode: "minimal" } }
  });
  assert.equal(createJob.statusCode, 201);
  const jobId = createJob.json.job.id;
  let lastChainHash = createJob.json.job.lastChainHash;

  const postServerEvent = async (type, payload, idempotencyKey, actor = { type: "system", id: "proxy" }) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": idempotencyKey },
      body: { type, actor, payload }
    });
    if (res.statusCode === 201) lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_claims2" }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    if (res.statusCode === 201) lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  assert.equal((await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_claims2")).statusCode, 201);
  assert.equal(
    (
      await postServerEvent(
        "BOOKED",
        makeBookedPayload({
          paymentHoldId: "hold_claims2",
          startAt: bookingStartAt,
          endAt: bookingEndAt,
          environmentTier: "ENV_MANAGED_BUILDING",
          requiresOperatorCoverage: false
        }),
        "b_claims2"
      )
    ).statusCode,
    201
  );
  assert.equal((await postServerEvent("MATCHED", { robotId: "rob_claims2" }, "m_claims2")).statusCode, 201);
  assert.equal(
    (await postServerEvent("RESERVED", { robotId: "rob_claims2", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_claims2_1" }, "r_claims2"))
      .statusCode,
    201
  );

  const accessPlanId = "ap_claims2";
  assert.equal(
    (
      await postServerEvent(
        "ACCESS_PLAN_ISSUED",
        {
          jobId,
          accessPlanId,
          method: "DOCKED_IN_BUILDING",
          credentialRef: "vault://access/ap_claims2/v1",
          scope: { areas: ["ENTRYWAY"] },
          validFrom: new Date(now - 60_000).toISOString(),
          validTo: new Date(now + 60 * 60_000).toISOString(),
          revocable: true,
          requestedBy: "system"
        },
        "ap_claims2_1"
      )
    ).statusCode,
    201
  );

  assert.equal((await postRobotEvent("EN_ROUTE", { etaSeconds: 10 })).statusCode, 201);
  assert.equal((await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" })).statusCode, 201);
  assert.equal((await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] })).statusCode, 201);

  const incidentId = "inc_claims_2";
  assert.equal(
    (
      await postServerEvent(
        "INCIDENT_REPORTED",
        { jobId, incidentId, type: "DAMAGE_PROPERTY", severity: 2, summary: "customer report", reportedBy: "customer" },
        "inc_rep_2",
        { type: "requester", id: "household_demo" }
      )
    ).statusCode,
    201
  );

  assert.equal((await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } })).statusCode, 201);
  assert.equal((await postServerEvent("SETTLED", { settlement: "demo" }, "settle_claims2")).statusCode, 201);

  const claimId = "cl_cap_1";
  assert.equal(
    (await postServerEvent("CLAIM_OPENED", { jobId, claimId, incidentId, reasonCode: "DAMAGE_PROPERTY" }, "cl_cap_open_1")).statusCode,
    201
  );

  const tooLarge = await postServerEvent(
    "CLAIM_APPROVED",
    { jobId, claimId, currency: "USD", amounts: { payoutCents: 20_000, refundCents: 0 }, reasonCode: "DAMAGE_PROPERTY" },
    "cl_cap_approve_1"
  );
  assert.equal(tooLarge.statusCode, 400);

  const elevated = await postServerEvent(
    "CLAIM_APPROVED",
    { jobId, claimId, currency: "USD", amounts: { payoutCents: 20_000, refundCents: 0 }, reasonCode: "DAMAGE_PROPERTY" },
    "cl_cap_approve_2",
    { type: "system", id: "proxy_admin" }
  );
  assert.equal(elevated.statusCode, 201);
});
