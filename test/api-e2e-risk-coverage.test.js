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

test("API e2e v1.6: coverage fees fund reserve; parametric credits include triggers; CoverageCertificate emitted", async () => {
  let nowMs = Date.parse("2026-01-26T09:50:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();

  const api = createApi({ now: nowIso });

  // Register a robot for quoting + execution.
  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_cov", publicKeyPem: robotPublicKeyPem } });
  assert.equal(regRobot.statusCode, 201);
  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_cov/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
  });
  assert.equal(setAvail.statusCode, 201);

  // Create a coverage contract that charges a per-job fee and funds SLA credits from the coverage reserve.
  const upsertContract = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    body: {
      contractId: "contract_cov",
      name: "Coverage Contract",
      policies: {
        creditPolicy: { enabled: true, defaultAmountCents: 300, maxAmountCents: 300, currency: "USD" },
        coveragePolicy: {
          required: true,
          coverageTierId: "tier_a",
          feeModel: "PER_JOB",
          feeCentsPerJob: 500,
          creditFundingModel: "COVERAGE_RESERVE",
          responseSlaSeconds: 60,
          includedAssistSeconds: 300,
          overageRateCentsPerMinute: 200
        }
      }
    }
  });
  assert.equal(upsertContract.statusCode, 201);

  // Create, quote, and book a job under the coverage contract.
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
      contractId: "contract_cov"
    }
  });
  assert.equal(quote.statusCode, 201);
  assert.equal(quote.json.event.payload.breakdown.coverageFeeCents, 500);
  assert.equal(quote.json.event.payload.amountCents, 7650);
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
      contractId: "contract_cov"
    }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  // CoverageCertificate should enqueue on BOOKED (and include booking-time risk if available).
  const built = await api.tickArtifacts({ maxMessages: 50 });
  assert.ok(Array.isArray(built.processed));
  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const coverageCert = artifacts.find((a) => a?.artifactType === "CoverageCertificate.v1") ?? null;
  assert.ok(coverageCert, "expected CoverageCertificate.v1");
  assert.equal(coverageCert.coverage.required, true);
  assert.equal(coverageCert.coverage.feeCentsPerJob, 500);
  assert.equal(coverageCert.coverage.creditFundingModel, "COVERAGE_RESERVE");
  assert.ok(Number.isSafeInteger(coverageCert.job?.risk?.riskScore ?? null));

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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_cov" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  // Minimal dispatch + access setup.
  await postServerEvent("MATCHED", { robotId: "rob_cov" }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId: "rob_cov", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

  const accessPlanId = `ap_${jobId}`;
  const accessValidTo = "2026-01-26T11:30:00.000Z";
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "DOCKED_IN_BUILDING",
      credentialRef: `vault://access/${accessPlanId}/v1`,
      scope: { areas: ["ENTRYWAY"], noGo: [] },
      validFrom: bookingStartAt,
      validTo: accessValidTo,
      revocable: true,
      requestedBy: "system"
    },
    `ap_${jobId}`
  );

  // Execute late (after bookingEndAt) to trigger START_LATE SLA breach.
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

  // Settlement posts coverage fee into reserve and does not share it into owner payout.
  assert.equal(api.store.ledger.balances.get("acct_cash"), 7650);
  assert.equal(api.store.ledger.balances.get("acct_customer_escrow"), 0);
  assert.equal(api.store.ledger.balances.get("acct_platform_revenue"), -1430);
  assert.equal(api.store.ledger.balances.get("acct_owner_payable"), -5577);
  assert.equal(api.store.ledger.balances.get("acct_insurance_reserve"), -143);
  assert.equal(api.store.ledger.balances.get("acct_coverage_reserve"), -500);

  nowMs += 30_000;
  const tick = await api.tickJobAccounting();
  assert.equal(tick.processed.length, 1);

  const eventsRes = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(eventsRes.statusCode, 200);
  const breach = findLastEvent(eventsRes.json.events, "SLA_BREACH_DETECTED");
  assert.ok(breach, "expected SLA_BREACH_DETECTED");
  const credit = findLastEvent(eventsRes.json.events, "SLA_CREDIT_ISSUED");
  assert.ok(credit, "expected SLA_CREDIT_ISSUED");
  assert.equal(credit.payload.amountCents, 300);
  assert.ok(credit.payload.trigger, "expected credit trigger details");
  assert.equal(credit.payload.trigger.breachEventId, breach.id);
  assert.ok(Array.isArray(credit.payload.trigger.breaches));
  assert.equal(credit.payload.trigger.breaches[0].type, "START_LATE");

  // Credit is funded from coverage reserve, not SLA credits expense.
  assert.equal(api.store.ledger.balances.get("acct_sla_credits_expense"), 0);
  assert.equal(api.store.ledger.balances.get("acct_customer_credits_payable"), -300);
  assert.equal(api.store.ledger.balances.get("acct_coverage_reserve"), -200);

  const statement = await request(api, { method: "GET", path: "/ops/statements?month=2026-01" });
  assert.equal(statement.statusCode, 200);
  const row = statement.json.statement.jobs.find((j) => j.jobId === jobId) ?? null;
  assert.ok(row);
  assert.equal(row.coverageFeeCents, 500);
  assert.equal(row.creditFundingModel, "COVERAGE_RESERVE");
});

