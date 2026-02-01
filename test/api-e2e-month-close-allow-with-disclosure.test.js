import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";

import { request } from "./api-test-harness.js";

async function registerRobot(api, { tenantId, robotId, publicKeyPem, availability }) {
  const reg = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: tenantId ? { "x-proxy-tenant-id": tenantId } : undefined,
    body: { robotId, publicKeyPem }
  });
  assert.equal(reg.statusCode, 201);

  const availRes = await request(api, {
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: {
      ...(tenantId ? { "x-proxy-tenant-id": tenantId } : null),
      "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash
    },
    body: { availability }
  });
  assert.equal(availRes.statusCode, 201);
}

test("API e2e: month close can proceed with ALLOW_WITH_DISCLOSURE closeHoldPolicy even if unresolved holds exist", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });
  const tenantId = "tenant_month_close_disclosure";

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  await registerRobot(api, {
    tenantId,
    robotId: "rob_month_hold2",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const contractRes = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    headers: { "x-proxy-tenant-id": tenantId },
    body: { contractId: "contract_strict_month2", name: "Strict Proof Contract", policies: { proofPolicy: { gateMode: "strict" } } }
  });
  assert.equal(contractRes.statusCode, 201);

  // Governance policy: allow close with disclosure.
  const govRes = await request(api, {
    method: "POST",
    path: "/ops/governance/events",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-expected-prev-chain-hash": "null",
      "x-idempotency-key": "idem_gov_policy_1"
    },
    body: {
      type: "TENANT_POLICY_UPDATED",
      scope: "tenant",
      payload: { effectiveFrom: "2026-01-01T00:00:00.000Z", policy: { finance: { monthCloseHoldPolicy: "ALLOW_WITH_DISCLOSURE" } }, reason: "pilot" }
    }
  });
  assert.equal(govRes.statusCode, 201);

  const created = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { "x-proxy-tenant-id": tenantId },
    body: { templateId: "reset_lite", constraints: {} }
  });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-20T10:30:00.000Z";
  const bookingEndAt = "2026-01-20T11:00:00.000Z";

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-tenant-id": tenantId, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false, contractId: "contract_strict_month2" }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-tenant-id": tenantId, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      contractId: "contract_strict_month2"
    }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  const postServerEvent = async (type, payload) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-tenant-id": tenantId, "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
  };

  const postRobotEvent = async (type, payload, at) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_month_hold2" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-tenant-id": tenantId },
      body: finalized
    });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
  };

  await postServerEvent("MATCHED", { robotId: "rob_month_hold2" });
  await postServerEvent("RESERVED", { robotId: "rob_month_hold2", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` });

  const accessPlanId = `ap_${jobId}`;
  await postServerEvent("ACCESS_PLAN_ISSUED", {
    jobId,
    accessPlanId,
    method: "DOCKED_IN_BUILDING",
    credentialRef: `vault://access/${accessPlanId}/v1`,
    scope: { areas: ["ENTRYWAY"], noGo: [] },
    validFrom: bookingStartAt,
    validTo: bookingEndAt,
    revocable: true,
    requestedBy: "system"
  });

  nowMs = Date.parse(bookingStartAt) - 2 * 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, nowIso());

  nowMs = Date.parse(bookingStartAt) + 30_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, nowIso());
  nowMs += 30_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, nowIso());
  nowMs += 3 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, nowIso());

  await api.tickProof({ maxMessages: 50 });

  const refreshed = await request(api, { method: "GET", path: `/jobs/${jobId}`, headers: { "x-proxy-tenant-id": tenantId } });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json.job.settlementHold?.status, "HELD");

  nowMs = Date.parse("2026-02-02T00:00:00.000Z");
  const closeReq = await request(api, { method: "POST", path: "/ops/month-close", headers: { "x-proxy-tenant-id": tenantId }, body: { month: "2026-01" } });
  assert.equal(closeReq.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 10 });

  const monthClose = await request(api, { method: "GET", path: "/ops/month-close?month=2026-01", headers: { "x-proxy-tenant-id": tenantId } });
  assert.equal(monthClose.statusCode, 200);
  assert.equal(monthClose.json.monthClose.status, "CLOSED");
});
