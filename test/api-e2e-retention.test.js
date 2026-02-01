import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem, sha256Hex } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { buildEvidenceDownloadUrl } from "../src/core/evidence-store.js";
import { request } from "./api-test-harness.js";

function findLastEvent(events, type) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === type) return e;
  }
  return null;
}

test("API e2e v1.2: retention tick expires obj:// evidence and appends EVIDENCE_EXPIRED", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });

  // Contract enabling evidence retention.
  const contractId = "contract_retention_1d";
  const contractRes = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    body: {
      contractId,
      name: "Retention 1 day",
      isDefault: false,
      policies: {
        slaOverridesByEnvironmentTier: {},
        creditPolicy: { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" },
        evidencePolicy: { retentionDays: 1 }
      }
    }
  });
  assert.equal(contractRes.statusCode, 201);

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_ret", publicKeyPem: robotPublicKeyPem } });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_ret/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-10T00:00:00.000Z" }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", contractId, constraints: { privacyMode: "minimal" } } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = new Date(nowMs).toISOString();
  const bookingEndAt = new Date(nowMs + 60 * 60_000).toISOString();

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { paymentHoldId: "hold_ret", startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  const postServerEvent = async (type, payload, idempotencyKey) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": idempotencyKey },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload, at) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_ret" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("MATCHED", { robotId: "rob_ret" }, "m_ret");
  await postServerEvent("RESERVED", { robotId: "rob_ret", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_ret" }, "r_ret");

  const accessPlanId = "ap_ret";
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "DOCKED_IN_BUILDING",
      credentialRef: "vault://access/ap_ret/v1",
      scope: { areas: ["ENTRYWAY"] },
      validFrom: bookingStartAt,
      validTo: bookingEndAt,
      revocable: true,
      requestedBy: "system"
    },
    "ap_ret"
  );

  nowMs += 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 10 }, new Date(nowMs).toISOString());
  nowMs += 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, new Date(nowMs).toISOString());
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, new Date(nowMs).toISOString());

  const incidentId = "inc_ret_1";
  nowMs += 30_000;
  await postRobotEvent(
    "INCIDENT_DETECTED",
    { jobId, incidentId, type: "DAMAGE_PROPERTY", severity: 4, summary: "impact detected", signals: { impactG: 3.0 } },
    new Date(nowMs).toISOString()
  );

  const evidenceId = "evid_ret_1";
  const evidenceRef = `obj://evidence/${evidenceId}`;
  await api.store.evidenceStore.putEvidence({ tenantId: "tenant_default", evidenceRef, data: Buffer.from("retained", "utf8") });

  nowMs += 30_000;
  await postRobotEvent(
    "EVIDENCE_CAPTURED",
    { jobId, incidentId, evidenceId, evidenceRef, kind: "STILL_IMAGE", contentType: "text/plain", redaction: { state: "NONE" } },
    new Date(nowMs).toISOString()
  );

  // Build a long-lived download URL for the test (bypasses /jobs/:id/evidence TTL).
  const secret = sha256Hex(api.store.serverSigner.privateKeyPem);
  const downloadUrl = buildEvidenceDownloadUrl({
    tenantId: "tenant_default",
    jobId,
    evidenceId,
    evidenceRef,
    expiresAt: "2026-01-04T00:00:00.000Z",
    secret
  });

  // Advance time beyond retention.
  nowMs = Date.parse("2026-01-03T00:00:00.000Z");
  const tick = await api.tickEvidenceRetention();
  assert.ok(tick.processed.some((p) => p.jobId === jobId));

  const after = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(after.statusCode, 200);
  const expiredEvent = findLastEvent(after.json.events, "EVIDENCE_EXPIRED");
  assert.ok(expiredEvent, "expected EVIDENCE_EXPIRED");
  assert.equal(expiredEvent.payload.evidenceId, evidenceId);

  const downloadAfter = await request(api, { method: "GET", path: downloadUrl });
  assert.equal(downloadAfter.statusCode, 410);
  assert.equal(downloadAfter.json.code, "EVIDENCE_EXPIRED");
});
