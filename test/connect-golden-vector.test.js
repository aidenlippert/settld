import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createDefaultContract } from "../src/core/contracts.js";
import { CONTRACT_COMPILER_ID } from "../src/core/contract-compiler.js";
import { contractDocumentV1FromLegacyContract } from "../src/core/contract-document.js";
import { hashSplitPlanV1 } from "../src/core/contract-document.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
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

test("connect v1 golden: splitPlanHash is pinned in operatorPolicyHash and surfaced in SettlementStatement", async () => {
  let nowMs = Date.parse("2026-01-21T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  // 1) Prove splitPlanHash affects the compiled operator policyHash (no accidental drift).
  const baseLegacy = createDefaultContract({ tenantId: "tenant_default", nowIso });
  baseLegacy.contractId = "ctr_connect_golden";
  baseLegacy.contractVersion = 1;
  baseLegacy.customerId = "cust_connect";
  baseLegacy.isDefault = true;

  const splitPlanA = {
    type: "SplitPlan.v1",
    v: 1,
    currency: "USD",
    rules: [
      { partyRole: "platform", share: { type: "percentage", valueBasisPoints: 1000 }, appliesTo: "gross" },
      { partyRole: "operator", share: { type: "remainder" }, appliesTo: "gross" }
    ]
  };
  const splitPlanB = {
    ...splitPlanA,
    rules: [
      { partyRole: "platform", share: { type: "percentage", valueBasisPoints: 900 }, appliesTo: "gross" },
      { partyRole: "operator", share: { type: "remainder" }, appliesTo: "gross" }
    ]
  };

  const docA = {
    ...contractDocumentV1FromLegacyContract(baseLegacy),
    parties: {
      platform: { partyId: "pty_platform", requiresSignature: false },
      operator: { partyId: "pty_operator:op_connect", requiresSignature: false },
      customer: { partyId: "pty_customer:cust_connect", requiresSignature: false }
    },
    connect: { enabled: true, splitPlan: splitPlanA }
  };
  const docB = { ...docA, connect: { enabled: true, splitPlan: splitPlanB } };

  const simA = await request(api, { method: "POST", path: "/ops/contracts-v2/simulate", body: { doc: docA } });
  assert.equal(simA.statusCode, 200);
  assert.equal(simA.json?.compilerId, CONTRACT_COMPILER_ID);
  assert.ok(simA.json?.policyTemplate?.connect?.splitPlanHash);

  const simB = await request(api, { method: "POST", path: "/ops/contracts-v2/simulate", body: { doc: docB } });
  assert.equal(simB.statusCode, 200);
  assert.notEqual(simA.json?.policyHash, simB.json?.policyHash);

  // 2) Create/publish/activate the operator v2 contract with connect enabled.
  const createdV2 = await request(api, { method: "POST", path: "/ops/contracts-v2", body: { doc: docA } });
  assert.equal(createdV2.statusCode, 201);

  const publish = await request(api, {
    method: "POST",
    path: "/ops/contracts-v2/ctr_connect_golden/publish",
    body: { contractVersion: 1 }
  });
  assert.equal(publish.statusCode, 200);
  const operatorContractHash = publish.json?.contract?.contractHash ?? publish.json?.contractHash ?? null;
  assert.ok(operatorContractHash);

  const activate = await request(api, {
    method: "POST",
    path: "/ops/contracts-v2/ctr_connect_golden/activate",
    body: { contractVersion: 1 }
  });
  assert.equal(activate.statusCode, 200);
  const operatorPolicyHash = activate.json?.policyHash ?? null;
  assert.ok(operatorPolicyHash);

  // 3) Run a small job lifecycle and pin the operator contract/policy on MATCHED.
  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  await registerRobot(api, {
    robotId: "rob_connect",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const createdJob = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(createdJob.statusCode, 201);
  const jobId = createdJob.json?.job?.id ?? null;
  assert.ok(jobId);
  let lastChainHash = createdJob.json.job.lastChainHash;

  const bookingStartAt = "2026-01-21T10:30:00.000Z";
  const bookingEndAt = "2026-01-21T11:00:00.000Z";

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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_connect" }, payload, at });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    if (res.statusCode !== 201) {
      throw new Error(`robot event rejected: status=${res.statusCode} body=${JSON.stringify(res.json)}`);
    }
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const matched = await postServerEvent(
    "MATCHED",
    {
      robotId: "rob_connect",
      operatorContractHash,
      operatorPolicyHash,
      operatorCompilerId: CONTRACT_COMPILER_ID
    },
    `m_${jobId}`
  );
  assert.equal(matched.json.job.operatorContractHash, operatorContractHash);
  assert.equal(matched.json.job.operatorPolicyHash, operatorPolicyHash);

  await postServerEvent(
    "RESERVED",
    { robotId: "rob_connect", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` },
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

  nowMs = Date.parse(bookingStartAt) - 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 });
  nowMs = Date.parse(bookingStartAt) + 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" });
  nowMs += 30_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] });
  nowMs += 5 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } });

  await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);

  await api.tickArtifacts({ maxMessages: 50 });
  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const stmt = artifacts.find((a) => a.artifactType === "SettlementStatement.v1") ?? null;
  assert.ok(stmt);
  assert.equal(stmt.job.operatorContractHash, operatorContractHash);
  assert.equal(stmt.job.operatorPolicyHash, operatorPolicyHash);
  assert.equal(stmt.settlement?.splitPlanHash, hashSplitPlanV1(splitPlanA));

  const rollups = Array.isArray(stmt.settlement?.partyRollups) ? stmt.settlement.partyRollups : [];
  assert.ok(rollups.length >= 1);
  const balanceDeltaTotal = rollups.reduce((sum, r) => sum + (Number.isSafeInteger(r?.balanceDeltaCents) ? r.balanceDeltaCents : 0), 0);
  assert.equal(balanceDeltaTotal, 0);

  // Re-run artifacts tick: statement should be deterministic/reused.
  await api.tickArtifacts({ maxMessages: 50 });
  const artifacts2 = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const stmts = artifacts2.filter((a) => a.artifactType === "SettlementStatement.v1");
  assert.equal(stmts.length, 1);
});
