import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { request } from "./api-test-harness.js";

function findLastEvent(events, type) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === type) return e;
  }
  return null;
}

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

async function registerOperator(api, { operatorId, publicKeyPem }) {
  const reg = await request(api, { method: "POST", path: "/operators/register", body: { operatorId, publicKeyPem } });
  assert.equal(reg.statusCode, 201);
}

test("API e2e v1.6.1: INSURER_RECOVERABLE credits create receivable; reimbursements clear; CreditMemo includes funding", async () => {
  let nowMs = Date.parse("2026-01-26T09:50:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();

  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  await registerRobot(api, {
    robotId: "rob_ins",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const upsertContract = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    body: {
      contractId: "contract_ins",
      name: "Insurer Recoverable",
      policies: {
        creditPolicy: { enabled: true, defaultAmountCents: 300, maxAmountCents: 300, currency: "USD" },
        coveragePolicy: {
          required: true,
          coverageTierId: "tier_ins",
          feeModel: "PER_JOB",
          feeCentsPerJob: 500,
          creditFundingModel: "INSURER_RECOVERABLE",
          insurerId: "ins_a",
          recoverablePercent: 100,
          reserveFundPercent: 0,
          responseSlaSeconds: 60,
          includedAssistSeconds: 300,
          overageRateCentsPerMinute: 200
        }
      }
    }
  });
  assert.equal(upsertContract.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-26T10:00:00.000Z";
  const bookingEndAt = "2026-01-26T10:30:00.000Z";

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      contractId: "contract_ins"
    }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      contractId: "contract_ins"
    }
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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_ins" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("MATCHED", { robotId: "rob_ins" }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId: "rob_ins", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

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
      validTo: "2026-01-26T11:30:00.000Z",
      revocable: true,
      requestedBy: "system"
    },
    `ap_${jobId}`
  );

  // Execute late to trigger START_LATE breach.
  nowMs = Date.parse(bookingStartAt) + 2 * 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, nowIso());
  nowMs = Date.parse(bookingEndAt) + 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, nowIso());
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, nowIso());
  nowMs += 5 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, nowIso());

  nowMs += 30_000;
  await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);

  nowMs += 30_000;
  const tick = await api.tickJobAccounting();
  assert.equal(tick.processed.length, 1);

  assert.equal(api.store.ledger.balances.get("acct_sla_credits_expense"), 0);
  assert.equal(api.store.ledger.balances.get("acct_insurer_receivable"), 300);
  assert.equal(api.store.ledger.balances.get("acct_customer_credits_payable"), -300);

  const built = await api.tickArtifacts({ maxMessages: 50 });
  assert.ok(Array.isArray(built.processed));
  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const creditMemo = artifacts.find((a) => a?.artifactType === "CreditMemo.v1") ?? null;
  assert.ok(creditMemo, "expected CreditMemo.v1");
  assert.equal(creditMemo.credit?.funding?.model, "INSURER_RECOVERABLE");
  assert.equal(creditMemo.credit?.funding?.insurerId, "ins_a");
  assert.equal(creditMemo.credit?.funding?.recoverableCents, 300);
  assert.ok(typeof creditMemo.credit?.funding?.receivableRefId === "string" && creditMemo.credit.funding.receivableRefId.includes(jobId));

  // Record reimbursement within month and verify receivable clears.
  nowMs = Date.parse("2026-01-30T12:00:00.000Z");
  const reimb = await request(api, {
    method: "POST",
    path: "/ops/insurer-reimbursements",
    body: { insurerId: "ins_a", amountCents: 300, month: "2026-01", recordedAt: nowIso(), reference: "wire_1" }
  });
  assert.equal(reimb.statusCode, 201);

  assert.equal(api.store.ledger.balances.get("acct_insurer_receivable"), 0);

  const receivables = await request(api, { method: "GET", path: "/ops/receivables?month=2026-01" });
  assert.equal(receivables.statusCode, 200);
  const row = receivables.json.receivables.find((r) => r.insurerId === "ins_a") ?? null;
  assert.ok(row);
  assert.equal(row.creditsRecoverableCents, 300);
  assert.equal(row.reimbursementsCents, 300);
  assert.equal(row.balanceCents, 0);
});

test("API e2e v1.6.1: OPERATOR_CHARGEBACK credits reduce operator payable then create receivable remainder", async () => {
  let nowMs = Date.parse("2026-01-26T09:50:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();

  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  await registerRobot(api, {
    robotId: "rob_cb",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

  const { publicKeyPem: operatorPublicKeyPem, privateKeyPem: operatorPrivateKeyPem } = createEd25519Keypair();
  const operatorKeyId = keyIdFromPublicKeyPem(operatorPublicKeyPem);
  await registerOperator(api, { operatorId: "op_cb", publicKeyPem: operatorPublicKeyPem });

  const upsertContract = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    body: {
      contractId: "contract_cb",
      name: "Operator Chargeback",
      policies: {
        creditPolicy: { enabled: true, defaultAmountCents: 500, maxAmountCents: 500, currency: "USD" },
        coveragePolicy: {
          required: false,
          coverageTierId: null,
          feeModel: "PER_JOB",
          feeCentsPerJob: 0,
          creditFundingModel: "OPERATOR_CHARGEBACK",
          reserveFundPercent: 0,
          responseSlaSeconds: 0,
          includedAssistSeconds: 0,
          overageRateCentsPerMinute: 0
        }
      }
    }
  });
  assert.equal(upsertContract.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-26T10:00:00.000Z";
  const bookingEndAt = "2026-01-26T10:30:00.000Z";

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      contractId: "contract_cb"
    }
  });
  assert.equal(quote.statusCode, 201);
  const amountCents = quote.json.event.payload.amountCents;
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      contractId: "contract_cb"
    }
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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_cb" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postOperatorEvent = async (type, payload, at) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "operator", id: "op_cb" }, payload, at });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: operatorKeyId, privateKeyPem: operatorPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  await postServerEvent("MATCHED", { robotId: "rob_cb" }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId: "rob_cb", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

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
      validTo: "2026-01-26T11:30:00.000Z",
      revocable: true,
      requestedBy: "system"
    },
    `ap_${jobId}`
  );

  // Execute late to trigger START_LATE breach. Include operator assist so operator payable exists.
  nowMs = Date.parse(bookingStartAt) + 2 * 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, nowIso());
  nowMs = Date.parse(bookingEndAt) + 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, nowIso());
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, nowIso());

  nowMs += 30_000;
  await postOperatorEvent("ASSIST_STARTED", { reason: "uncertain_object" }, nowIso());
  nowMs += 30_000;
  await postOperatorEvent("ASSIST_ENDED", { outcome: "approved" }, nowIso());

  nowMs += 5 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, nowIso());

  nowMs += 30_000;
  await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);

  // Operator fee is 5% of the service amount (quote amount, no coverage fee in this contract).
  const expectedOperatorFeeCents = Math.floor((amountCents * 0.05));
  assert.equal(api.store.ledger.balances.get("acct_operator_payable"), -expectedOperatorFeeCents);

  nowMs += 30_000;
  const tick = await api.tickJobAccounting();
  assert.equal(tick.processed.length, 1);

  // Credit is funded from operator payable first, with remainder as operator chargeback receivable.
  assert.equal(api.store.ledger.balances.get("acct_sla_credits_expense"), 0);
  assert.equal(api.store.ledger.balances.get("acct_customer_credits_payable"), -500);
  assert.equal(api.store.ledger.balances.get("acct_operator_payable"), 0);
  assert.equal(api.store.ledger.balances.get("acct_operator_chargeback_receivable"), 500 - expectedOperatorFeeCents);

  const built = await api.tickArtifacts({ maxMessages: 50 });
  assert.ok(Array.isArray(built.processed));
  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const creditMemo = artifacts.find((a) => a?.artifactType === "CreditMemo.v1") ?? null;
  assert.ok(creditMemo, "expected CreditMemo.v1");
  assert.equal(creditMemo.credit?.funding?.model, "OPERATOR_CHARGEBACK");

  const eventsRes = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(eventsRes.statusCode, 200);
  const credit = findLastEvent(eventsRes.json.events, "SLA_CREDIT_ISSUED");
  assert.ok(credit);
  assert.equal(credit.payload.amountCents, 500);

  const statement = await request(api, { method: "GET", path: "/ops/statements?month=2026-01" });
  assert.equal(statement.statusCode, 200);
  assert.equal(statement.json.statement.summary.creditsFromOperatorChargebackCents, 500);
});

