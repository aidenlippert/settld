import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { request } from "./api-test-harness.js";

test("API e2e v0.5: deterministic quoting and supply gating", async () => {
  const api = createApi();

  const now = Date.now();
  const availStartAt = new Date(now - 60 * 60_000).toISOString();
  const availEndAt = new Date(now + 2 * 60 * 60_000).toISOString();

  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt = new Date(now + 40 * 60_000).toISOString();

  const tooLateStartAt = new Date(now + 4 * 60 * 60_000).toISOString();
  const tooLateEndAt = new Date(now + 5 * 60 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: { "x-idempotency-key": "ops_r_reg_1" },
    body: { robotId: "rob_ops_1", publicKeyPem: robotPublicKeyPem, trustScore: 0.9 }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_ops_1/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash, "x-idempotency-key": "ops_r_av_1" },
    body: { availability: [{ startAt: availStartAt, endAt: availEndAt }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const createJob = async (key) => {
    const res = await request(api, {
      method: "POST",
      path: "/jobs",
      headers: { "x-idempotency-key": key },
      body: { templateId: "reset_lite", constraints: { privacyMode: "minimal" } }
    });
    assert.equal(res.statusCode, 201);
    return res.json.job;
  };

  const jobA = await createJob("ops_job_a");
  const jobB = await createJob("ops_job_b");

  const quoteJob = async (jobId, lastChainHash) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/quote`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `ops_quote_${jobId}` },
      body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
    });
    assert.equal(res.statusCode, 201);
    return res.json;
  };

  const quoteA = await quoteJob(jobA.id, jobA.lastChainHash);
  const quoteB = await quoteJob(jobB.id, jobB.lastChainHash);

  assert.deepEqual(quoteA.event.payload.breakdown, quoteB.event.payload.breakdown);
  assert.equal(quoteA.event.payload.amountCents, quoteB.event.payload.amountCents);
  assert.equal(quoteA.event.payload.amountCents, 7150);

  const jobNoSupply = await createJob("ops_job_nosupply");
  const quoteNoSupply = await request(api, {
    method: "POST",
    path: `/jobs/${jobNoSupply.id}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": jobNoSupply.lastChainHash },
    body: { startAt: tooLateStartAt, endAt: tooLateEndAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(quoteNoSupply.statusCode, 409);
});

test("API e2e v0.5: operator coverage gates quote/book/dispatch", async () => {
  const api = createApi();

  const now = Date.now();
  const bookingStartAt = new Date(now + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 65 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: { "x-idempotency-key": "ops_cov_robot_reg" },
    body: { robotId: "rob_cov", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_cov/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const createJob = await request(api, {
    method: "POST",
    path: "/jobs",
    body: { templateId: "reset_lite", constraints: {} }
  });
  assert.equal(createJob.statusCode, 201);
  const jobId = createJob.json.job.id;

  // In-home implies operator coverage required.
  const quoteNoOps = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": createJob.json.job.lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_IN_HOME" }
  });
  assert.equal(quoteNoOps.statusCode, 409);

  const { publicKeyPem: operatorPublicKeyPem, privateKeyPem: operatorPrivateKeyPem } = createEd25519Keypair();
  const operatorKeyId = keyIdFromPublicKeyPem(operatorPublicKeyPem);

  const regOperator = await request(api, {
    method: "POST",
    path: "/operators/register",
    body: { operatorId: "op_cov", publicKeyPem: operatorPublicKeyPem }
  });
  assert.equal(regOperator.statusCode, 201);
  let operatorPrev = regOperator.json.operator.lastChainHash;

  const openShiftDraft = createChainedEvent({
    streamId: "op_cov",
    type: "OPERATOR_SHIFT_OPENED",
    actor: { type: "operator", id: "op_cov" },
    payload: { operatorId: "op_cov", shiftId: "shift_1" }
  });
  const openShift = finalizeChainedEvent({
    event: openShiftDraft,
    prevChainHash: operatorPrev,
    signer: { keyId: operatorKeyId, privateKeyPem: operatorPrivateKeyPem }
  });
  const shiftRes = await request(api, { method: "POST", path: "/operators/op_cov/events", body: openShift });
  assert.equal(shiftRes.statusCode, 201);
  operatorPrev = shiftRes.json.operator.lastChainHash;

  const quoteOk = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": createJob.json.job.lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_IN_HOME" }
  });
  assert.equal(quoteOk.statusCode, 201);
  let jobPrev = quoteOk.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": jobPrev },
    body: { paymentHoldId: "hold_cov_1", startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_IN_HOME" }
  });
  assert.equal(book.statusCode, 201);
  jobPrev = book.json.job.lastChainHash;

  const dispatch = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/dispatch`,
    headers: { "x-proxy-expected-prev-chain-hash": jobPrev },
    body: {}
  });
  assert.equal(dispatch.statusCode, 201);
  assert.equal(dispatch.json.job.status, "RESERVED");
});

test("API e2e v0.5: robot overlapping reservations are blocked at dispatch", async () => {
  const api = createApi();

  const now = Date.now();
  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt = new Date(now + 70 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    body: { robotId: "rob_one", publicKeyPem: robotPublicKeyPem, trustScore: 0.8 }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_one/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: {
      availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const createAndBook = async (jobKey) => {
    const createJob = await request(api, { method: "POST", path: "/jobs", headers: { "x-idempotency-key": jobKey }, body: { templateId: "reset_lite", constraints: {} } });
    assert.equal(createJob.statusCode, 201);
    const jobId = createJob.json.job.id;
    let prev = createJob.json.job.lastChainHash;

    const quote = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/quote`,
      headers: { "x-proxy-expected-prev-chain-hash": prev },
      body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
    });
    assert.equal(quote.statusCode, 201);
    prev = quote.json.job.lastChainHash;

    const book = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/book`,
      headers: { "x-proxy-expected-prev-chain-hash": prev },
      body: { paymentHoldId: `hold_${jobKey}`, startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
    });
    assert.equal(book.statusCode, 201);
    prev = book.json.job.lastChainHash;

    return { jobId, prev };
  };

  const job1 = await createAndBook("ops_rsv_job1");
  const job2 = await createAndBook("ops_rsv_job2");

  const dispatch1 = await request(api, { method: "POST", path: `/jobs/${job1.jobId}/dispatch`, headers: { "x-proxy-expected-prev-chain-hash": job1.prev }, body: {} });
  assert.equal(dispatch1.statusCode, 201);

  const dispatch2 = await request(api, { method: "POST", path: `/jobs/${job2.jobId}/dispatch`, headers: { "x-proxy-expected-prev-chain-hash": job2.prev }, body: {} });
  assert.equal(dispatch2.statusCode, 409);
});

