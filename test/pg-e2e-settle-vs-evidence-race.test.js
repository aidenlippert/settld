import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";

import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

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

(databaseUrl ? test : test.skip)("pg e2e: settle vs late-evidence append race never silently mints money on a moved head", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();

  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storeA = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  const storeB = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });

  try {
    const apiA = createApi({ store: storeA, now: nowIso });
    const apiB = createApi({ store: storeB, now: nowIso });

    const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
    const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

    await registerRobot(apiA, {
      robotId: "rob_pg_race",
      publicKeyPem: robotPublicKeyPem,
      availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
    });

    const contractRes = await request(apiA, {
      method: "POST",
      path: "/ops/contracts",
      body: { contractId: "contract_pg_race", name: "Strict Proof Contract", policies: { proofPolicy: { gateMode: "strict" } } }
    });
    assert.equal(contractRes.statusCode, 201);

    const created = await request(apiA, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;
    let lastChainHash = created.json.job.lastChainHash;

    const bookingStartAt = "2026-01-20T10:30:00.000Z";
    const bookingEndAt = "2026-01-20T11:00:00.000Z";

    const quote = await request(apiA, {
      method: "POST",
      path: `/jobs/${jobId}/quote`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false, contractId: "contract_pg_race" }
    });
    assert.equal(quote.statusCode, 201);
    lastChainHash = quote.json.job.lastChainHash;

    const book = await request(apiA, {
      method: "POST",
      path: `/jobs/${jobId}/book`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: {
        paymentHoldId: `hold_${jobId}`,
        startAt: bookingStartAt,
        endAt: bookingEndAt,
        environmentTier: "ENV_MANAGED_BUILDING",
        requiresOperatorCoverage: false,
        contractId: "contract_pg_race"
      }
    });
    assert.equal(book.statusCode, 201);
    lastChainHash = book.json.job.lastChainHash;

    const postServerEvent = async (api, type, payload, idem) => {
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

    const postRobotEvent = async (api, type, payload, at) => {
      const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_pg_race" }, payload, at });
      const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
      const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
      if (res.statusCode === 201) lastChainHash = res.json.job.lastChainHash;
      return res;
    };

    await postServerEvent(apiA, "MATCHED", { robotId: "rob_pg_race" }, `m_${jobId}`);
    await postServerEvent(apiA, "RESERVED", { robotId: "rob_pg_race", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

    const accessPlanId = `ap_${jobId}`;
    await postServerEvent(
      apiA,
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
    await postRobotEvent(apiA, "EN_ROUTE", { etaSeconds: 60 }, nowIso());
    assert.ok(lastChainHash);
    nowMs = Date.parse(bookingStartAt) + 60_000;
    await postRobotEvent(apiA, "ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, nowIso());
    nowMs += 60_000;
    await postRobotEvent(apiA, "EXECUTION_STARTED", { plan: ["navigate"] }, nowIso());

    // Initial PASS proof.
    nowMs += 2 * 60_000;
    await postRobotEvent(
      apiA,
      "ZONE_COVERAGE_REPORTED",
      { jobId, zoneId: "zone_default", coveragePct: 100, window: { startAt: bookingStartAt, endAt: bookingEndAt }, source: "robot" },
      nowIso()
    );
    nowMs += 3 * 60_000;
    await postRobotEvent(apiA, "EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, nowIso());

    await apiA.tickProof({ maxMessages: 50 });

    const refreshed = await request(apiA, { method: "GET", path: `/jobs/${jobId}` });
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.json.job.status, "COMPLETED");
    assert.equal(refreshed.json.job.proof?.status, "PASS");
    lastChainHash = refreshed.json.job.lastChainHash;

    // Prepare a robot-signed late evidence event that would flip the proof to FAIL.
    nowMs += 30_000;
    const lateEvidenceDraft = createChainedEvent({
      streamId: jobId,
      type: "ZONE_COVERAGE_REPORTED",
      actor: { type: "robot", id: "rob_pg_race" },
      payload: { jobId, zoneId: "zone_default", coveragePct: 10, window: { startAt: bookingStartAt, endAt: "2026-01-20T11:00:01.000Z" }, source: "robot" },
      at: nowIso()
    });
    const lateEvidenceFinalized = finalizeChainedEvent({
      event: lateEvidenceDraft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });

    nowMs = Date.parse("2026-01-20T12:00:00.000Z");
    const settleReq = request(apiA, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `s_${jobId}` },
      body: { type: "SETTLED", actor: { type: "finance", id: "proxy" }, payload: { settlement: "demo" } }
    });

    const evidenceReq = request(apiB, { method: "POST", path: `/jobs/${jobId}/events`, body: lateEvidenceFinalized });

    const [settleRes, evidenceRes] = await Promise.all([settleReq, evidenceReq]);

    const okCount = [settleRes, evidenceRes].filter((r) => r.statusCode === 201).length;
    const conflictCount = [settleRes, evidenceRes].filter((r) => r.statusCode === 409).length;
    assert.equal(okCount, 1);
    assert.equal(conflictCount, 1);

    // If settlement lost the race, retrying settlement should fail stale-proof until re-proof is computed.
    if (settleRes.statusCode === 409) {
      assert.equal(evidenceRes.statusCode, 201);
      lastChainHash = evidenceRes.json.job.lastChainHash;

      const retryStale = await request(apiA, {
        method: "POST",
        path: `/jobs/${jobId}/events`,
        headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `s_${jobId}_retry` },
        body: { type: "SETTLED", actor: { type: "finance", id: "proxy" }, payload: { settlement: "demo" } }
      });
      assert.equal(retryStale.statusCode, 400);
      assert.equal(retryStale.json?.code, "PROOF_STALE");

      await apiA.tickProof({ maxMessages: 50 });
      const afterProof = await request(apiA, { method: "GET", path: `/jobs/${jobId}` });
      assert.equal(afterProof.statusCode, 200);
      lastChainHash = afterProof.json.job.lastChainHash;

      const settled = await request(apiA, {
        method: "POST",
        path: `/jobs/${jobId}/events`,
        headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `s_${jobId}_final` },
        body: { type: "SETTLED", actor: { type: "finance", id: "proxy" }, payload: { settlement: "demo" } }
      });
      assert.equal(settled.statusCode, 201);
      assert.equal(settled.json.job.status, "SETTLED");
      assert.equal(settled.json.event?.payload?.settlementProofRef?.status, "FAIL");
    } else {
      // If settlement won the race, the late evidence append must be rejected (409) and can be retried with the new head.
      assert.equal(settleRes.statusCode, 201);
      assert.equal(evidenceRes.statusCode, 409);
      assert.equal(settleRes.json.job.status, "SETTLED");

      lastChainHash = settleRes.json.job.lastChainHash;
      const retryDraft = createChainedEvent({
        streamId: jobId,
        type: "ZONE_COVERAGE_REPORTED",
        actor: { type: "robot", id: "rob_pg_race" },
        payload: { jobId, zoneId: "zone_default", coveragePct: 10, window: { startAt: bookingStartAt, endAt: "2026-01-20T11:00:01.000Z" }, source: "robot" },
        at: nowIso()
      });
      const retryFinalized = finalizeChainedEvent({
        event: retryDraft,
        prevChainHash: lastChainHash,
        signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
      });
      const retriedEvidence = await request(apiB, { method: "POST", path: `/jobs/${jobId}/events`, body: retryFinalized });
      assert.equal(retriedEvidence.statusCode, 201);
      assert.equal(retriedEvidence.json.job.status, "SETTLED");
    }
  } finally {
    await storeB.close();
    await storeA.close();
  }
});
