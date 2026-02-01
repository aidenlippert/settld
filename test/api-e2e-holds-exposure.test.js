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

test("API e2e: /ops/holds includes finance-legible exposure (gross/net + splits + held)", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  const headers = await createAuth(api, { scopes: ["ops_read", "ops_write", "finance_write", "audit_read"] });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  await registerRobot(api, {
    robotId: "rob_hold_exposure",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }],
    headers
  });

  const contractRes = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    headers,
    body: {
      contractId: "contract_strict_hold_exposure",
      name: "Strict Proof Hold Exposure",
      policies: {
        proofPolicy: { gateMode: "strict" },
        coveragePolicy: { required: true, feeCentsPerJob: 250 }
      }
    }
  });
  assert.equal(contractRes.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} }, headers });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-20T10:30:00.000Z";
  const bookingEndAt = "2026-01-20T11:00:00.000Z";

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { ...headers, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      contractId: "contract_strict_hold_exposure"
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
      contractId: "contract_strict_hold_exposure"
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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_hold_exposure" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized, headers });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("MATCHED", { robotId: "rob_hold_exposure" }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId: "rob_hold_exposure", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

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

  // No ZONE_COVERAGE_REPORTED => INSUFFICIENT_EVIDENCE => HELD in strict mode.
  nowMs += 3 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, nowIso());

  await api.tickProof({ maxMessages: 50 });

  nowMs += 2 * 60_000;

  const holdsRes = await request(api, { method: "GET", path: "/ops/holds?status=HELD&limit=50", headers });
  assert.equal(holdsRes.statusCode, 200);
  const holds = holdsRes.json?.holds ?? [];
  const row = holds.find((h) => h?.jobId === jobId) ?? null;
  assert.ok(row);

  // Total must not double-count coverage fee.
  assert.equal(row.expectedTotalCents, row.expectedAmountCents);
  assert.equal(row.expectedServiceAmountCents, row.expectedAmountCents - row.expectedCoverageFeeCents);

  assert.ok(row.expectedSplits);
  const service = row.expectedServiceAmountCents;
  assert.equal(row.expectedSplits.platformFeeCents, Math.floor(service * 0.2));
  assert.equal(row.expectedSplits.insuranceReserveCents, Math.floor(service * 0.02));
  assert.equal(row.expectedSplits.operatorFeeCents, 0);

  assert.ok(row.holdPolicy);
  assert.equal(row.holdPolicy.gateMode, "strict");
  assert.equal(row.holdPolicy.holdPercent, 100);

  assert.ok(row.heldExposure);
  assert.equal(row.heldExposure.amountGrossCents, row.expectedAmountCents);
  assert.equal(row.heldExposure.coverageFeeCents, row.expectedCoverageFeeCents);
  assert.equal(row.heldExposure.amountNetCents, row.expectedServiceAmountCents);

  assert.ok(typeof row.heldAt === "string" && row.heldAt.length > 0);
  assert.equal(row.ageSeconds, Math.max(0, Math.floor((Date.parse(nowIso()) - Date.parse(row.heldAt)) / 1000)));

  assert.ok(Array.isArray(row.reasonCodes));
  assert.ok(row.reasonCodes.includes("MISSING_ZONE_COVERAGE") || row.reasonCodes.includes("REQUIRED_ZONES_MISSING"));
  assert.ok(Array.isArray(row.missingEvidence));
  assert.ok(row.missingEvidence.includes("ZONE_COVERAGE"));
  assert.equal(row.releaseHint?.kind, "MISSING_EVIDENCE");

  assert.ok(row.triggeringProofRef);
  assert.equal(row.triggeringProofRef.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(row.triggeringProofRef.factsHash, row.factsHash);
  assert.equal(row.triggeringProofRef.evaluatedAtChainHash, row.evaluatedAtChainHash);

  assert.equal(row.currency, "USD");
  assert.ok(row.pricingAnchor);
  assert.equal(row.pricingAnchor.evaluatedAtChainHash, row.evaluatedAtChainHash);
  assert.equal(row.pricingAnchor.customerPolicyHash, row.triggeringProofRef.customerPolicyHash);

  assert.ok(row.expectedExposure);
  assert.equal(row.expectedExposure.amountGrossCents, row.expectedAmountCents);
});
