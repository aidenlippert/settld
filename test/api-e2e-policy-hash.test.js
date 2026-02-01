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

test("API e2e v1.5: policyHash is pinned at booking; SLA credits reference the booking policyHash after contract updates", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  await registerRobot(api, {
    robotId: "rob_policy",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const contractCreate = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    body: {
      contractId: "c_policy",
      name: "c_policy",
      isDefault: false,
      policies: {
        slaOverridesByEnvironmentTier: {},
        creditPolicy: { enabled: true, defaultAmountCents: 500, maxAmountCents: 500, currency: "USD" },
        evidencePolicy: { retentionDays: 0 }
      }
    }
  });
  assert.equal(contractCreate.statusCode, 201);
  assert.equal(contractCreate.json.contract.contractVersion, 1);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-20T10:30:00.000Z";
  const bookingEndAt = "2026-01-20T11:00:00.000Z";
  const accessValidTo = "2026-01-20T11:30:00.000Z";

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      contractId: "c_policy"
    }
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
      contractId: "c_policy"
    }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;
  const bookedPolicyHash = book.json.event?.payload?.policyHash ?? null;
  assert.ok(bookedPolicyHash);
  assert.equal(book.json.event.payload.contractId, "c_policy");
  assert.equal(book.json.event.payload.contractVersion, 1);

  const contractUpdate = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    body: {
      contractId: "c_policy",
      policies: { creditPolicy: { enabled: true, defaultAmountCents: 900, maxAmountCents: 900, currency: "USD" } }
    }
  });
  assert.equal(contractUpdate.statusCode, 201);
  assert.equal(contractUpdate.json.contract.contractVersion, 2);

  const postServerEvent = async (type, payload, idempotencyKey) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: {
        "x-proxy-expected-prev-chain-hash": lastChainHash,
        ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {})
      },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload) => {
    const at = nowIso();
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_policy" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("MATCHED", { robotId: "rob_policy" }, `m_${jobId}`);
  await postServerEvent(
    "RESERVED",
    { robotId: "rob_policy", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` },
    `r_${jobId}`
  );

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
      validTo: accessValidTo,
      revocable: true,
      requestedBy: "system"
    },
    `ap_${jobId}`
  );

  nowMs = Date.parse(bookingStartAt) - 2 * 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 });
  nowMs = Date.parse(bookingStartAt) + 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" });
  nowMs = Date.parse(bookingEndAt) + 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"], stage: "TASK" });
  nowMs += 5 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } });

  nowMs += 60_000;
  await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);

  await api.tickJobAccounting({ maxMessages: 20 });

  const timeline = await request(api, { method: "GET", path: `/ops/jobs/${jobId}/timeline` });
  assert.equal(timeline.statusCode, 200);

  const breach = timeline.json.events.find((e) => e?.type === "SLA_BREACH_DETECTED") ?? null;
  assert.ok(breach);
  assert.equal(breach.payload.policyHash, bookedPolicyHash);

  const credit = timeline.json.events.find((e) => e?.type === "SLA_CREDIT_ISSUED") ?? null;
  assert.ok(credit);
  assert.equal(credit.payload.policyHash, bookedPolicyHash);
  assert.equal(credit.payload.amountCents, 500);

  const jobRes = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(jobRes.statusCode, 200);
  assert.equal(jobRes.json.job.booking.policyHash, bookedPolicyHash);
  assert.equal(jobRes.json.job.booking.contractId, "c_policy");
  assert.equal(jobRes.json.job.booking.contractVersion, 1);
});

