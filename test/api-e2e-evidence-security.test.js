import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { DEFAULT_TENANT_ID } from "../src/core/tenancy.js";
import { makeBookedPayload, request } from "./api-test-harness.js";

async function putAuthKey(api, { scopes }) {
  const keyId = authKeyId();
  const secret = authKeySecret();
  const secretHash = hashAuthKeySecret(secret);
  const createdAt = typeof api.store.nowIso === "function" ? api.store.nowIso() : new Date().toISOString();

  if (typeof api.store.putAuthKey === "function") {
    await api.store.putAuthKey({
      tenantId: DEFAULT_TENANT_ID,
      authKey: { keyId, secretHash, scopes, status: "active", createdAt }
    });
  } else {
    if (!(api.store.authKeys instanceof Map)) api.store.authKeys = new Map();
    api.store.authKeys.set(`${DEFAULT_TENANT_ID}\n${keyId}`, {
      tenantId: DEFAULT_TENANT_ID,
      keyId,
      secretHash,
      scopes,
      status: "active",
      createdAt,
      updatedAt: createdAt
    });
  }

  return `Bearer ${keyId}.${secret}`;
}

async function setupEvidenceJob(api) {
  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_evid_sec", publicKeyPem: robotPublicKeyPem } });
  assert.equal(regRobot.statusCode, 201);

  const now = Date.now();
  const bookingStartAt = new Date(now + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 65 * 60_000).toISOString();

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_evid_sec/availability",
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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_evid_sec" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    if (res.statusCode === 201 && res.json?.job?.lastChainHash) {
      lastChainHash = res.json.job.lastChainHash;
    }
    return res;
  };

  const postRobotEventOk = async (type, payload, at) => {
    const res = await postRobotEvent(type, payload, at);
    assert.equal(res.statusCode, 201);
    return res;
  };

  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_evid_sec");
  await postServerEvent(
    "BOOKED",
    makeBookedPayload({
      paymentHoldId: "hold_evid_sec",
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false
    }),
    "b_evid_sec"
  );
  await postServerEvent("MATCHED", { robotId: "rob_evid_sec" }, "m_evid_sec");
  await postServerEvent("RESERVED", { robotId: "rob_evid_sec", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_evid_sec" }, "r_evid_sec");

  const accessPlanId = "ap_evid_sec";
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "DOCKED_IN_BUILDING",
      credentialRef: "vault://access/ap_evid_sec/v1",
      scope: { areas: ["ENTRYWAY"] },
      validFrom: new Date(now - 60_000).toISOString(),
      validTo: new Date(now + 60 * 60_000).toISOString(),
      revocable: true,
      requestedBy: "system"
    },
    "ap_evid_sec_1"
  );

  const at0 = new Date(now + 1 * 60_000).toISOString();
  await postRobotEventOk("EN_ROUTE", { etaSeconds: 10 }, at0);
  const at1 = new Date(now + 2 * 60_000).toISOString();
  await postRobotEventOk("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, at1);
  const at2 = new Date(now + 3 * 60_000).toISOString();
  await postRobotEventOk("EXECUTION_STARTED", { plan: ["navigate"] }, at2);

  const incidentId = "inc_evid_sec_1";
  const at3 = new Date(now + 4 * 60_000).toISOString();
  await postRobotEventOk(
    "INCIDENT_DETECTED",
    { jobId, incidentId, type: "DAMAGE_PROPERTY", severity: 4, summary: "impact detected", signals: { impactG: 3.1 } },
    at3
  );

  return { jobId, incidentId, postRobotEvent };
}

test("API e2e: evidence download requires audit_read scope", async () => {
  const api = createApi();
  const { jobId, incidentId, postRobotEvent } = await setupEvidenceJob(api);

  const evidenceId = "evid_sec_1";
  const evidenceRef = `obj://evidence/${evidenceId}`;
  await api.store.evidenceStore.putEvidence({ tenantId: DEFAULT_TENANT_ID, evidenceRef, data: Buffer.from("hello", "utf8") });

  await postRobotEvent(
    "EVIDENCE_CAPTURED",
    { jobId, incidentId, evidenceId, evidenceRef, kind: "STILL_IMAGE", contentType: "text/plain", redaction: { state: "NONE" } },
    new Date(Date.now() + 5 * 60_000).toISOString()
  );
  // Ensure evidence is attached before exporting.
  const eventsRes = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(eventsRes.statusCode, 200);
  assert.ok(eventsRes.json.events.some((e) => e?.type === "EVIDENCE_CAPTURED" && e?.payload?.evidenceId === evidenceId));

  const exportAuth = await putAuthKey(api, { scopes: ["ops_read", "audit_read"] });
  const exportRes = await request(api, { method: "GET", path: `/jobs/${jobId}/evidence`, headers: { authorization: exportAuth } });
  assert.equal(exportRes.statusCode, 200);

  const item = exportRes.json.evidence.evidence[0];
  assert.ok(item.downloadUrl);

  const opsReadAuth = await putAuthKey(api, { scopes: ["ops_read"] });
  const denied = await request(api, { method: "GET", path: item.downloadUrl, headers: { authorization: opsReadAuth } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json.code, "FORBIDDEN");
});

test("API e2e: evidenceRef SSRF targets are rejected with stable reason codes", async () => {
  const api = createApi();
  const { jobId, incidentId, postRobotEvent } = await setupEvidenceJob(api);

  const res = await postRobotEvent(
    "EVIDENCE_CAPTURED",
    {
      jobId,
      incidentId,
      evidenceId: "evid_ssrf_1",
      evidenceRef: "https://169.254.169.254/latest/meta-data/",
      kind: "STILL_IMAGE",
      contentType: "text/plain",
      redaction: { state: "NONE" }
    },
    new Date(Date.now() + 5 * 60_000).toISOString()
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.json.error, "event rejected");
  assert.equal(res.json.code, "URL_HOST_FORBIDDEN");
});
