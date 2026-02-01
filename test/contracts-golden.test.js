import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { makeScopedKey } from "../src/core/tenancy.js";
import { CONTRACT_COMPILER_ID } from "../src/core/contract-compiler.js";
import { contractDocumentV1FromLegacyContract, hashContractDocumentV1 } from "../src/core/contract-document.js";
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

test("contracts v1 golden: booking pins customerContractHash and artifacts carry anchors", async () => {
  let nowMs = Date.parse("2026-01-20T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();

  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  await registerRobot(api, {
    robotId: "rob_contracts",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

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
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { paymentHoldId: `hold_${jobId}`, startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  const booking = book.json.job.booking;
  assert.ok(booking);
  assert.ok(booking.customerContractHash);
  assert.equal(booking.customerCompilerId, CONTRACT_COMPILER_ID);
  assert.ok(booking.policyHash);

  const contractId = booking.contractId;
  const legacyContract = api.store.contracts.get(makeScopedKey({ tenantId: "tenant_default", id: contractId }));
  assert.ok(legacyContract);
  const expectedContractHash = hashContractDocumentV1(contractDocumentV1FromLegacyContract(legacyContract));
  assert.equal(booking.customerContractHash, expectedContractHash);

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

  const postRobotEvent = async (type, payload) => {
    const at = nowIso();
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_contracts" }, payload, at });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const matched = await postServerEvent("MATCHED", { robotId: "rob_contracts" }, `m_${jobId}`);
  assert.equal(matched.json.job.customerContractHash, expectedContractHash);
  assert.equal(matched.json.job.customerCompilerId, CONTRACT_COMPILER_ID);
  assert.equal(matched.json.job.customerPolicyHash, booking.policyHash);
  assert.equal(matched.json.job.operatorContractHash, expectedContractHash);
  assert.equal(matched.json.job.operatorCompilerId, CONTRACT_COMPILER_ID);
  assert.equal(matched.json.job.operatorPolicyHash, booking.policyHash);
  await postServerEvent(
    "RESERVED",
    { robotId: "rob_contracts", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` },
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
      validTo: bookingEndAt,
      revocable: true,
      requestedBy: "system"
    },
    `ap_${jobId}`
  );

  nowMs = Date.parse(bookingStartAt) - 2 * 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 });
  nowMs = Date.parse(bookingStartAt) + 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" });
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] });
  nowMs += 5 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } });

  await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);

  await api.tickArtifacts({ maxMessages: 50 });
  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const workCert = artifacts.find((a) => a.artifactType === "WorkCertificate.v1");
  assert.ok(workCert);
  assert.equal(workCert.job.customerContractHash, expectedContractHash);
  assert.equal(workCert.job.customerCompilerId, CONTRACT_COMPILER_ID);
  assert.equal(workCert.job.customerPolicyHash, booking.policyHash);
  assert.equal(workCert.job.operatorContractHash, expectedContractHash);
  assert.equal(workCert.job.operatorCompilerId, CONTRACT_COMPILER_ID);
  assert.equal(workCert.job.operatorPolicyHash, booking.policyHash);
});
