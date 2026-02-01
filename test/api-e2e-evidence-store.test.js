import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { makeBookedPayload, request } from "./api-test-harness.js";

function findLastEvent(events, type) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === type) return e;
  }
  return null;
}

test("API e2e v1.2: evidence export includes signed download URLs; download logs EVIDENCE_VIEWED", async () => {
  const api = createApi();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_evid", publicKeyPem: robotPublicKeyPem } });
  assert.equal(regRobot.statusCode, 201);

  const now = Date.now();
  const bookingStartAt = new Date(now + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 65 * 60_000).toISOString();

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_evid/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: { privacyMode: "minimal" } } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_evid" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_evid");
  await postServerEvent(
    "BOOKED",
    makeBookedPayload({
      paymentHoldId: "hold_evid",
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false
    }),
    "b_evid"
  );
  await postServerEvent("MATCHED", { robotId: "rob_evid" }, "m_evid");
  await postServerEvent("RESERVED", { robotId: "rob_evid", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_evid" }, "r_evid");

  const accessPlanId = "ap_evid";
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "DOCKED_IN_BUILDING",
      credentialRef: "vault://access/ap_evid/v1",
      scope: { areas: ["ENTRYWAY"] },
      validFrom: new Date(now - 60_000).toISOString(),
      validTo: new Date(now + 60 * 60_000).toISOString(),
      revocable: true,
      requestedBy: "system"
    },
    "ap_evid_1"
  );

  const at0 = new Date(now + 1 * 60_000).toISOString();
  await postRobotEvent("EN_ROUTE", { etaSeconds: 10 }, at0);
  const at1 = new Date(now + 2 * 60_000).toISOString();
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, at1);
  const at2 = new Date(now + 3 * 60_000).toISOString();
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, at2);

  const incidentId = "inc_evid_1";
  const at3 = new Date(now + 4 * 60_000).toISOString();
  await postRobotEvent(
    "INCIDENT_DETECTED",
    { jobId, incidentId, type: "DAMAGE_PROPERTY", severity: 4, summary: "impact detected", signals: { impactG: 3.1 } },
    at3
  );

  const evidenceId = "evid_1";
  const evidenceRef = `obj://evidence/${evidenceId}`;
  await api.store.evidenceStore.putEvidence({ tenantId: "tenant_default", evidenceRef, data: Buffer.from("hello", "utf8") });

  const at4 = new Date(now + 5 * 60_000).toISOString();
  await postRobotEvent(
    "EVIDENCE_CAPTURED",
    {
      jobId,
      incidentId,
      evidenceId,
      evidenceRef,
      kind: "STILL_IMAGE",
      contentType: "text/plain",
      redaction: { state: "NONE" }
    },
    at4
  );

  const exportRes = await request(api, { method: "GET", path: `/jobs/${jobId}/evidence` });
  assert.equal(exportRes.statusCode, 200);

  const item = exportRes.json.evidence.evidence[0];
  assert.equal(item.evidenceId, evidenceId);
  assert.ok(item.downloadUrl);
  assert.ok(item.downloadExpiresAt);

  const downloadRes = await request(api, { method: "GET", path: item.downloadUrl });
  assert.equal(downloadRes.statusCode, 200);
  assert.equal(downloadRes.body, "hello");

  const eventsRes = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(eventsRes.statusCode, 200);
  const viewed = findLastEvent(eventsRes.json.events, "EVIDENCE_VIEWED");
  assert.ok(viewed, "expected EVIDENCE_VIEWED");
  assert.equal(viewed.payload.evidenceId, evidenceId);
  assert.equal(viewed.payload.evidenceRef, evidenceRef);
});
