import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { request } from "./api-test-harness.js";

async function registerRobot(api, { tenantId = null, robotId, publicKeyPem, availability }) {
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
      ...(tenantId ? { "x-proxy-tenant-id": tenantId } : {}),
      "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash
    },
    body: { availability }
  });
  assert.equal(availRes.statusCode, 201);
}

test("API e2e v1.2: monthly statements include only jobs settled in month; tenant isolated; supports CSV", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  await registerRobot(api, {
    tenantId: "tenant_default",
    robotId: "rob_stmt",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });
  await registerRobot(api, {
    tenantId: "tenant_other",
    robotId: "rob_stmt",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const createAndSettleJob = async ({ tenantId, customerId, siteId, settledAt }) => {
    nowMs = Date.parse(settledAt) - 30 * 60_000;
    const bookingStartAt = new Date(nowMs).toISOString();
    const bookingEndAt = new Date(nowMs + 30 * 60_000).toISOString();

    const created = await request(api, {
      method: "POST",
      path: "/jobs",
      headers: tenantId ? { "x-proxy-tenant-id": tenantId } : undefined,
      body: { templateId: "reset_lite", customerId, siteId, constraints: {} }
    });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;
    let lastChainHash = created.json.job.lastChainHash;

    const quote = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/quote`,
      headers: {
        ...(tenantId ? { "x-proxy-tenant-id": tenantId } : {}),
        "x-proxy-expected-prev-chain-hash": lastChainHash
      },
      body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
    });
    assert.equal(quote.statusCode, 201);
    lastChainHash = quote.json.job.lastChainHash;

    const book = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/book`,
      headers: {
        ...(tenantId ? { "x-proxy-tenant-id": tenantId } : {}),
        "x-proxy-expected-prev-chain-hash": lastChainHash
      },
      body: {
        paymentHoldId: `hold_${jobId}`,
        startAt: bookingStartAt,
        endAt: bookingEndAt,
        environmentTier: "ENV_MANAGED_BUILDING",
        requiresOperatorCoverage: false
      }
    });
    assert.equal(book.statusCode, 201);
    lastChainHash = book.json.job.lastChainHash;

    const postServerEvent = async (type, payload, idempotencyKey) => {
      const res = await request(api, {
        method: "POST",
        path: `/jobs/${jobId}/events`,
        headers: {
          ...(tenantId ? { "x-proxy-tenant-id": tenantId } : {}),
          "x-proxy-expected-prev-chain-hash": lastChainHash,
          "x-idempotency-key": idempotencyKey
        },
        body: { type, actor: { type: "system", id: "proxy" }, payload }
      });
      assert.equal(res.statusCode, 201);
      lastChainHash = res.json.job.lastChainHash;
      return res;
    };

    const postRobotEvent = async (type, payload, at) => {
      const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_stmt" }, payload, at });
      const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
      const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, headers: tenantId ? { "x-proxy-tenant-id": tenantId } : undefined, body: finalized });
      assert.equal(res.statusCode, 201);
      lastChainHash = res.json.job.lastChainHash;
      return res;
    };

    await postServerEvent("MATCHED", { robotId: "rob_stmt" }, `m_${jobId}`);
    await postServerEvent("RESERVED", { robotId: "rob_stmt", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

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
        validTo: bookingEndAt,
        revocable: true,
        requestedBy: "system"
      },
      `ap_${jobId}`
    );

    nowMs += 60_000;
    await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, new Date(nowMs).toISOString());
    nowMs += 60_000;
    await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, new Date(nowMs).toISOString());
    nowMs += 60_000;
    await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, new Date(nowMs).toISOString());
    nowMs += 5 * 60_000;
    await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, new Date(nowMs).toISOString());

    nowMs = Date.parse(settledAt);
    await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);

    return { jobId };
  };

  const jobJan = await createAndSettleJob({ tenantId: "tenant_default", customerId: "cust_a", siteId: "site_1", settledAt: "2026-01-20T12:00:00.000Z" });
  await createAndSettleJob({ tenantId: "tenant_default", customerId: "cust_a", siteId: "site_1", settledAt: "2026-02-05T12:00:00.000Z" });
  await createAndSettleJob({ tenantId: "tenant_other", customerId: "cust_a", siteId: "site_1", settledAt: "2026-01-22T12:00:00.000Z" });

  const jan = await request(api, {
    method: "GET",
    path: "/ops/statements?customerId=cust_a&month=2026-01",
    headers: { "x-proxy-tenant-id": "tenant_default" }
  });
  assert.equal(jan.statusCode, 200);
  assert.equal(jan.json.statement.month, "2026-01");
  assert.equal(jan.json.statement.customerId, "cust_a");
  const jobIds = jan.json.statement.jobs.map((j) => j.jobId).sort();
  assert.deepEqual(jobIds, [jobJan.jobId]);

  const csv = await request(api, {
    method: "GET",
    path: "/ops/statements?customerId=cust_a&month=2026-01&format=csv",
    headers: { "x-proxy-tenant-id": "tenant_default" }
  });
  assert.equal(csv.statusCode, 200);
  assert.match(String(csv.body), /^jobId,customerId,siteId,templateId,zoneId,environmentTier,bookedAt,settledAt,amountCents/);
});
