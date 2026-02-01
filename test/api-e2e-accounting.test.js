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

test("API e2e v0.8.1: operator cost recorded after settlement without changing settlement balances", async () => {
  let nowMs = Date.parse("2026-01-26T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });

  api.store.config.operatorCost.basis = "SHIFT_RATE";
  api.store.config.operatorCost.rateCentsPerMinuteByZone.default = 123;

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_cost", publicKeyPem: robotPublicKeyPem } });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_cost/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: {
      availability: [{ startAt: new Date(nowMs - 60 * 60_000).toISOString(), endAt: new Date(nowMs + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const { publicKeyPem: operatorPublicKeyPem, privateKeyPem: operatorPrivateKeyPem } = createEd25519Keypair();
  const operatorKeyId = keyIdFromPublicKeyPem(operatorPublicKeyPem);
  const regOperator = await request(api, {
    method: "POST",
    path: "/operators/register",
    body: { operatorId: "op_cost", publicKeyPem: operatorPublicKeyPem }
  });
  assert.equal(regOperator.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
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

  const postSignedEvent = async ({ type, actor, payload, at, signer }) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const bookingStartAt = new Date(nowMs).toISOString();
  const bookingEndAt = new Date(nowMs + 60 * 60_000).toISOString();

  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_cost");
  await postServerEvent(
    "BOOKED",
    makeBookedPayload({
      paymentHoldId: "hold_cost",
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false
    }),
    "b_cost"
  );
  await postServerEvent("MATCHED", { robotId: "rob_cost" }, "m_cost");
  await postServerEvent("RESERVED", { robotId: "rob_cost", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_cost" }, "r_cost");

  const accessPlanId = "ap_cost";
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "BUILDING_CONCIERGE",
      credentialRef: "vault://access/ap_cost/v1",
      scope: { areas: ["ENTRYWAY"], noGo: [] },
      validFrom: bookingStartAt,
      validTo: bookingEndAt,
      revocable: true,
      requestedBy: "system"
    },
    "ap_cost"
  );

  nowMs += 60_000;
  await postSignedEvent({
    type: "EN_ROUTE",
    actor: { type: "robot", id: "rob_cost" },
    payload: { etaSeconds: 60 },
    at: new Date(nowMs).toISOString(),
    signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
  });

  nowMs += 60_000;
  await postSignedEvent({
    type: "ACCESS_GRANTED",
    actor: { type: "robot", id: "rob_cost" },
    payload: { jobId, accessPlanId, method: "BUILDING_CONCIERGE" },
    at: new Date(nowMs).toISOString(),
    signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
  });

  nowMs += 60_000;
  await postSignedEvent({
    type: "EXECUTION_STARTED",
    actor: { type: "robot", id: "rob_cost" },
    payload: { plan: ["navigate"] },
    at: new Date(nowMs).toISOString(),
    signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
  });

  nowMs += 60_000;
  const assistStartedAt = new Date(nowMs).toISOString();
  await postSignedEvent({
    type: "ASSIST_STARTED",
    actor: { type: "operator", id: "op_cost" },
    payload: { reason: "uncertain_object" },
    at: assistStartedAt,
    signer: { keyId: operatorKeyId, privateKeyPem: operatorPrivateKeyPem }
  });

  nowMs += 90_000;
  const assistEndedAt = new Date(nowMs).toISOString();
  await postSignedEvent({
    type: "ASSIST_ENDED",
    actor: { type: "operator", id: "op_cost" },
    payload: { outcome: "approved" },
    at: assistEndedAt,
    signer: { keyId: operatorKeyId, privateKeyPem: operatorPrivateKeyPem }
  });

  nowMs += 5 * 60_000;
  await postSignedEvent({
    type: "EXECUTION_COMPLETED",
    actor: { type: "robot", id: "rob_cost" },
    payload: { report: { durationSeconds: 10 } },
    at: new Date(nowMs).toISOString(),
    signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
  });

  nowMs += 30_000;
  await postServerEvent("SETTLED", { settlement: "demo" }, "s_cost");

  // Settlement balances unchanged.
  assert.equal(api.store.ledger.balances.get("acct_cash"), 6500);
  assert.equal(api.store.ledger.balances.get("acct_customer_escrow"), 0);
  assert.equal(api.store.ledger.balances.get("acct_platform_revenue"), -1300);
  assert.equal(api.store.ledger.balances.get("acct_owner_payable"), -4745);
  assert.equal(api.store.ledger.balances.get("acct_operator_payable"), -325);
  assert.equal(api.store.ledger.balances.get("acct_insurance_reserve"), -130);

  nowMs += 30_000;
  const tick = await api.tickJobAccounting();
  assert.equal(tick.processed.length, 1);

  const eventsRes = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(eventsRes.statusCode, 200);
  const costEvent = findLastEvent(eventsRes.json.events, "OPERATOR_COST_RECORDED");
  assert.ok(costEvent, "expected OPERATOR_COST_RECORDED");
  assert.equal(costEvent.payload.assistSeconds, 90);
  assert.equal(costEvent.payload.rateCentsPerMinute, 123);
  assert.equal(costEvent.payload.costCents, 246);

  assert.equal(api.store.ledger.balances.get("acct_operator_labor_expense"), 246);
  assert.equal(api.store.ledger.balances.get("acct_operator_cost_accrued"), -246);

  // Existing settlement balances remain unchanged after costing.
  assert.equal(api.store.ledger.balances.get("acct_cash"), 6500);
  assert.equal(api.store.ledger.balances.get("acct_customer_escrow"), 0);
  assert.equal(api.store.ledger.balances.get("acct_platform_revenue"), -1300);
  assert.equal(api.store.ledger.balances.get("acct_owner_payable"), -4745);
  assert.equal(api.store.ledger.balances.get("acct_operator_payable"), -325);
  assert.equal(api.store.ledger.balances.get("acct_insurance_reserve"), -130);
});

test("API e2e v0.8.2: SLA breach detected; credits disabled by default", async () => {
  let nowMs = Date.parse("2026-01-26T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_sla", publicKeyPem: robotPublicKeyPem } });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_sla/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: {
      availability: [{ startAt: new Date(nowMs - 60 * 60_000).toISOString(), endAt: new Date(nowMs + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_sla" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const bookingStartAt = new Date(nowMs).toISOString();
  const bookingEndAt = new Date(nowMs + 30 * 60_000).toISOString();
  const sla = { slaVersion: 1, mustStartWithinWindow: true, maxStallMs: 5 * 60_000, maxExecutionMs: 90 * 60_000 };

  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_sla");
  await postServerEvent(
    "BOOKED",
    makeBookedPayload({
      paymentHoldId: "hold_sla",
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      sla
    }),
    "b_sla"
  );
  await postServerEvent("MATCHED", { robotId: "rob_sla" }, "m_sla");
  await postServerEvent("RESERVED", { robotId: "rob_sla", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_sla" }, "r_sla");

  const accessPlanId = "ap_sla";
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "BUILDING_CONCIERGE",
      credentialRef: "vault://access/ap_sla/v1",
      scope: { areas: ["ENTRYWAY"], noGo: [] },
      validFrom: bookingStartAt,
      validTo: bookingEndAt,
      revocable: true,
      requestedBy: "system"
    },
    "ap_sla"
  );

  nowMs += 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, new Date(nowMs).toISOString());
  nowMs += 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "BUILDING_CONCIERGE" }, new Date(nowMs).toISOString());
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, new Date(nowMs).toISOString());

  // Complete after the booking window ends to force COMPLETE_LATE.
  nowMs = Date.parse(bookingEndAt) + 5 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, new Date(nowMs).toISOString());

  nowMs += 30_000;
  await postServerEvent("SETTLED", { settlement: "demo" }, "s_sla");

  nowMs += 30_000;
  const tick = await api.tickJobAccounting();
  assert.equal(tick.processed.length, 1);

  const eventsRes = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(eventsRes.statusCode, 200);

  const breachEvent = findLastEvent(eventsRes.json.events, "SLA_BREACH_DETECTED");
  assert.ok(breachEvent, "expected SLA_BREACH_DETECTED");
  assert.equal(breachEvent.payload.window.startAt, bookingStartAt);
  assert.equal(breachEvent.payload.window.endAt, bookingEndAt);
  assert.ok(Array.isArray(breachEvent.payload.breaches));
  assert.equal(breachEvent.payload.breaches[0].type, "COMPLETE_LATE");

  const creditEvent = findLastEvent(eventsRes.json.events, "SLA_CREDIT_ISSUED");
  assert.equal(creditEvent, null);
  assert.equal(api.store.ledger.balances.get("acct_customer_credits_payable"), 0);
});

test("API e2e v0.8.2: SLA credit issuance is replay-safe when enabled", async () => {
  let nowMs = Date.parse("2026-01-26T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_credit", publicKeyPem: robotPublicKeyPem } });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_credit/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: {
      availability: [{ startAt: new Date(nowMs - 60 * 60_000).toISOString(), endAt: new Date(nowMs + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_credit" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const bookingStartAt = new Date(nowMs).toISOString();
  const bookingEndAt = new Date(nowMs + 30 * 60_000).toISOString();
  const sla = { slaVersion: 1, mustStartWithinWindow: true, maxStallMs: 5 * 60_000, maxExecutionMs: 90 * 60_000 };
  const creditPolicy = { enabled: true, defaultAmountCents: 500, maxAmountCents: 1000, currency: "USD" };

  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_credit");
  await postServerEvent(
    "BOOKED",
    makeBookedPayload({
      paymentHoldId: "hold_credit",
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      sla,
      creditPolicy
    }),
    "b_credit"
  );
  await postServerEvent("MATCHED", { robotId: "rob_credit" }, "m_credit");
  await postServerEvent("RESERVED", { robotId: "rob_credit", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_credit" }, "r_credit");

  const accessPlanId = "ap_credit";
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "BUILDING_CONCIERGE",
      credentialRef: "vault://access/ap_credit/v1",
      scope: { areas: ["ENTRYWAY"], noGo: [] },
      validFrom: bookingStartAt,
      validTo: bookingEndAt,
      revocable: true,
      requestedBy: "system"
    },
    "ap_credit"
  );

  nowMs += 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, new Date(nowMs).toISOString());
  nowMs += 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "BUILDING_CONCIERGE" }, new Date(nowMs).toISOString());
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, new Date(nowMs).toISOString());

  nowMs = Date.parse(bookingEndAt) + 5 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, new Date(nowMs).toISOString());

  nowMs += 30_000;
  await postServerEvent("SETTLED", { settlement: "demo" }, "s_credit");

  nowMs += 30_000;
  const tick1 = await api.tickJobAccounting();
  assert.equal(tick1.processed.length, 1);

  const afterFirst = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(afterFirst.statusCode, 200);
  const countAfterFirst = afterFirst.json.events.length;

  const creditEvent = findLastEvent(afterFirst.json.events, "SLA_CREDIT_ISSUED");
  assert.ok(creditEvent, "expected SLA_CREDIT_ISSUED");
  assert.equal(creditEvent.payload.amountCents, 500);
  assert.equal(api.store.ledger.balances.get("acct_customer_credits_payable"), -500);
  assert.equal(api.store.ledger.balances.get("acct_sla_credits_expense"), 500);

  // Replay: reset worker cursor and re-run; should not append or double-post.
  api.store.jobAccountingCursor = 0;
  const tick2 = await api.tickJobAccounting();
  assert.ok(tick2.processed.length >= 1);

  const afterSecond = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(afterSecond.statusCode, 200);
  assert.equal(afterSecond.json.events.length, countAfterFirst);
  assert.equal(api.store.ledger.balances.get("acct_customer_credits_payable"), -500);
  assert.equal(api.store.ledger.balances.get("acct_sla_credits_expense"), 500);
});

test("API e2e: SLA credit ladder uses max lateness to pick tier", async () => {
  let nowMs = Date.parse("2026-01-26T00:00:00.000Z");
  const api = createApi({ now: () => new Date(nowMs).toISOString() });

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_ladder", publicKeyPem: robotPublicKeyPem } });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_ladder/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: {
      availability: [{ startAt: new Date(nowMs - 60 * 60_000).toISOString(), endAt: new Date(nowMs + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
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
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_ladder" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    assert.equal(res.statusCode, 201);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const bookingStartAt = new Date(nowMs).toISOString();
  const bookingEndAt = new Date(nowMs + 30 * 60_000).toISOString();
  const sla = { slaVersion: 1, mustStartWithinWindow: true, maxStallMs: 5 * 60_000, maxExecutionMs: 90 * 60_000 };
  const creditPolicy = {
    enabled: true,
    defaultAmountCents: 0,
    maxAmountCents: 2000,
    currency: "USD",
    ladder: [
      { latenessMsGte: 5 * 60_000, amountCents: 500 },
      { latenessMsGte: 15 * 60_000, amountCents: 1000 },
      { latenessMsGte: 30 * 60_000, amountCents: 2000 }
    ]
  };

  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "q_ladder");
  await postServerEvent(
    "BOOKED",
    makeBookedPayload({
      paymentHoldId: "hold_ladder",
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      sla,
      creditPolicy
    }),
    "b_ladder"
  );
  await postServerEvent("MATCHED", { robotId: "rob_ladder" }, "m_ladder");
  await postServerEvent("RESERVED", { robotId: "rob_ladder", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_ladder" }, "r_ladder");

  const accessPlanId = "ap_ladder";
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "BUILDING_CONCIERGE",
      credentialRef: "vault://access/ap_ladder/v1",
      scope: { areas: ["ENTRYWAY"], noGo: [] },
      validFrom: bookingStartAt,
      validTo: bookingEndAt,
      revocable: true,
      requestedBy: "system"
    },
    "ap_ladder"
  );

  nowMs += 60_000;
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, new Date(nowMs).toISOString());
  nowMs += 60_000;
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "BUILDING_CONCIERGE" }, new Date(nowMs).toISOString());
  nowMs += 60_000;
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, new Date(nowMs).toISOString());

  // Complete 20 minutes late => ladder picks the 15m tier.
  nowMs = Date.parse(bookingEndAt) + 20 * 60_000;
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, new Date(nowMs).toISOString());

  nowMs += 30_000;
  await postServerEvent("SETTLED", { settlement: "demo" }, "s_ladder");

  nowMs += 30_000;
  const tick = await api.tickJobAccounting();
  assert.equal(tick.processed.length, 1);

  const eventsRes = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(eventsRes.statusCode, 200);
  const creditEvent = findLastEvent(eventsRes.json.events, "SLA_CREDIT_ISSUED");
  assert.ok(creditEvent, "expected SLA_CREDIT_ISSUED");
  assert.equal(creditEvent.payload.amountCents, 1000);
});
