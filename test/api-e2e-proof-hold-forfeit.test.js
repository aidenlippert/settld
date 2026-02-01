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

test("API e2e: held job can be forfeited and settled as no-charge finality (strict mode)", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  await registerRobot(api, {
    robotId: "rob_forfeit",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const contractRes = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    body: { contractId: "contract_strict_forfeit", name: "Strict Proof Contract", policies: { proofPolicy: { gateMode: "strict" } } }
  });
  assert.equal(contractRes.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-20T10:30:00.000Z";
  const bookingEndAt = "2026-01-20T11:00:00.000Z";

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false, contractId: "contract_strict_forfeit" }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { paymentHoldId: `hold_${jobId}`, startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false, contractId: "contract_strict_forfeit" }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  const postServerEvent = async (type, payload, idem) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": idem },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload, at) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_forfeit" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("MATCHED", { robotId: "rob_forfeit" }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId: "rob_forfeit", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

  const accessPlanId = `ap_${jobId}`;
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    { jobId, accessPlanId, method: "DOCKED_IN_BUILDING", credentialRef: `vault://access/${accessPlanId}/v1`, scope: { areas: ["ENTRYWAY"], noGo: [] }, validFrom: bookingStartAt, validTo: bookingEndAt, revocable: true, requestedBy: "system" },
    `ap_${jobId}`
  );

  nowMs = Date.parse(bookingStartAt) - 2 * 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, nowIso());
  nowMs = Date.parse(bookingStartAt) + 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, nowIso());
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, nowIso());

  // No ZONE_COVERAGE_REPORTED => INSUFFICIENT_EVIDENCE.
  nowMs += 3 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, nowIso());

  await api.tickProof({ maxMessages: 50 });

  const refreshed = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(refreshed.statusCode, 200);
  lastChainHash = refreshed.json.job.lastChainHash;
  assert.equal(refreshed.json.job.status, "COMPLETED");
  assert.equal(refreshed.json.job.proof?.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(refreshed.json.job.settlementHold?.status, "HELD");
  const holdId = refreshed.json.job.settlementHold?.holdId;
  assert.ok(holdId);

  // Record an auditable finance decision that will back the forfeiture.
  nowMs = Date.parse("2026-01-20T11:59:30.000Z");
  const decisionId = `dec_${jobId}`;
  const decision = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `dec_${jobId}` },
    body: {
      type: "DECISION_RECORDED",
      actor: { type: "finance", id: "proxy" },
      payload: { jobId, decisionId, kind: "SETTLEMENT_FORFEIT", holdId, forfeitureReason: "DISPUTE_WINDOW_EXPIRED" }
    }
  });
  assert.equal(decision.statusCode, 201);
  lastChainHash = decision.json.job.lastChainHash;

  // Forfeit the hold (finance decision), then settle as no-charge finality.
  nowMs = Date.parse("2026-01-20T12:00:00.000Z");
  const forfeited = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `f_${jobId}` },
    body: {
      type: "SETTLEMENT_FORFEITED",
      actor: { type: "finance", id: "proxy" },
      payload: { jobId, holdId, forfeitureReason: "DISPUTE_WINDOW_EXPIRED", decisionId }
    }
  });
  assert.equal(forfeited.statusCode, 201);
  assert.equal(forfeited.json?.event?.payload?.decisionEventRef?.decisionId, decisionId);
  assert.equal(forfeited.json?.event?.payload?.decisionEventRef?.kind, "SETTLEMENT_FORFEIT");
  lastChainHash = forfeited.json.job.lastChainHash;

  const settled = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `s_${jobId}` },
    body: { type: "SETTLED", actor: { type: "finance", id: "proxy" }, payload: { settlement: "no-charge" } }
  });
  assert.equal(settled.statusCode, 201);
  assert.equal(settled.json.job.status, "SETTLED");
  const settledEventId = settled.json?.event?.id ?? null;
  const ref = settled.json?.event?.payload?.settlementProofRef ?? null;
  assert.ok(settledEventId);
  assert.ok(ref);
  assert.equal(ref.status, "FAIL");
  assert.ok(ref.forfeit);
  assert.equal(ref.forfeit.holdId, holdId);
  assert.equal(ref.forfeit.forfeitureReason, "DISPUTE_WINDOW_EXPIRED");

  // Effective proof in artifacts should reflect settlement finality.
  await api.tickArtifacts({ maxMessages: 200 });
  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const certs = artifacts.filter((a) => a?.artifactType === "WorkCertificate.v1" && a?.sourceEventId === settledEventId);
  assert.equal(certs.length, 1);
  const cert = certs[0] ?? null;
  assert.ok(cert);
  assert.equal(cert.proof?.status, "FAIL");
  assert.equal(cert.proof?.source?.kind, "SETTLEMENT");
  assert.equal(cert.proof?.source?.disposition?.kind, "FORFEIT");
  assert.equal(cert.proof?.source?.proofEventId, ref.proofEventId);
  assert.equal(cert.sourceEventType, "SETTLED");

  const effective = await request(api, { method: "GET", path: `/jobs/${jobId}/artifacts/effective?type=WorkCertificate.v1` });
  assert.equal(effective.statusCode, 200);
  assert.equal(effective.json?.artifact?.artifactType, "WorkCertificate.v1");
  assert.equal(effective.json?.artifact?.sourceEventId, settledEventId);
  assert.equal(effective.json?.selection?.kind, "SETTLED_EVENT");
});
