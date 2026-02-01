import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";

import { request } from "./api-test-harness.js";

async function createAuth(api, { tenantId = "tenant_default", scopes }) {
  const keyId = authKeyId();
  const secret = authKeySecret();
  const secretHash = hashAuthKeySecret(secret);
  const createdAt = typeof api.store.nowIso === "function" ? api.store.nowIso() : new Date().toISOString();
  await api.store.putAuthKey({
    tenantId,
    authKey: { keyId, secretHash, scopes, status: "active", createdAt }
  });
  return { authorization: `Bearer ${keyId}.${secret}` };
}

async function registerRobot(api, { robotId, publicKeyPem, availability, headers }) {
  const reg = await request(api, { method: "POST", path: "/robots/register", body: { robotId, publicKeyPem }, headers });
  assert.equal(reg.statusCode, 201);
  const availRes = await request(api, {
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: { ...headers, "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
    body: { availability }
  });
  assert.equal(availRes.statusCode, 201);
}

test("API e2e: held job updates missingEvidence checklist when still insufficient (zone-specific tokens)", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  const headers = await createAuth(api, { scopes: ["ops_read", "ops_write", "finance_write", "audit_read"] });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  await registerRobot(api, {
    robotId: "rob_hold_update",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }],
    headers
  });

  const contractRes = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    headers,
    body: { contractId: "contract_strict_hold_update", name: "Strict Hold Update", policies: { proofPolicy: { gateMode: "strict" } } }
  });
  assert.equal(contractRes.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} }, headers });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-20T10:30:00.000Z";
  const bookingEndAt = "2026-01-20T11:00:00.000Z";

  const requiredZones = {
    schemaVersion: "ZoneSet.v1",
    zoneSetId: `zones_${jobId}`,
    zones: [
      { zoneId: "zone_a", label: "zone_a" },
      { zoneId: "zone_b", label: "zone_b" }
    ]
  };

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { ...headers, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      contractId: "contract_strict_hold_update"
    }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { ...headers, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      contractId: "contract_strict_hold_update",
      requiredZones
    }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  const postServerEvent = async (type, payload, idem) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { ...headers, "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": idem },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload, at) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_hold_update" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized, headers });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("MATCHED", { robotId: "rob_hold_update" }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId: "rob_hold_update", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

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

  nowMs = Date.parse(bookingStartAt) - 2 * 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, nowIso());
  nowMs = Date.parse(bookingStartAt) + 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, nowIso());
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, nowIso());

  nowMs += 3 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, nowIso());
  await api.tickProof({ maxMessages: 50 });

  const held1 = await request(api, { method: "GET", path: `/jobs/${jobId}`, headers });
  assert.equal(held1.statusCode, 200);
  assert.equal(held1.json.job.settlementHold?.status, "HELD");
  const missing1 = held1.json.job.settlementHold?.missingEvidence ?? [];
  const ref1 = held1.json.job.settlementHold?.triggeringProofRef ?? null;
  assert.ok(ref1);
  assert.ok(Array.isArray(missing1));
  assert.ok(missing1.includes("ZONE_COVERAGE"));
  const details1 = missing1.filter((t) => typeof t === "string" && t.startsWith("ZONE_COVERAGE:"));
  assert.equal(details1.length, 2);

  lastChainHash = held1.json.job.lastChainHash;

  // Provide coverage for only one required zone; proof remains INSUFFICIENT but checklist should shrink.
  nowMs += 30_000;
  await postRobotEvent(
    "ZONE_COVERAGE_REPORTED",
    {
      jobId,
      zoneId: "zone_a",
      coveragePct: 100,
      window: { startAt: bookingStartAt, endAt: bookingEndAt },
      source: "robot"
    },
    nowIso()
  );
  await api.tickProof({ maxMessages: 50 });

  const held2 = await request(api, { method: "GET", path: `/jobs/${jobId}`, headers });
  assert.equal(held2.statusCode, 200);
  assert.equal(held2.json.job.settlementHold?.status, "HELD");
  const missing2 = held2.json.job.settlementHold?.missingEvidence ?? [];
  const ref2 = held2.json.job.settlementHold?.triggeringProofRef ?? null;
  assert.ok(ref2);
  assert.ok(Array.isArray(missing2));
  assert.ok(missing2.includes("ZONE_COVERAGE"));
  const details2 = missing2.filter((t) => typeof t === "string" && t.startsWith("ZONE_COVERAGE:"));
  assert.equal(details2.length, 1);
  assert.ok(details1.includes(details2[0]));
  assert.notEqual(ref2.factsHash, ref1.factsHash);
});

