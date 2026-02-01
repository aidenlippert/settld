import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

test("persistence: tx log replay restores projections and idempotency", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proxy-core-"));

  const store1 = createStore({ persistenceDir: dir });
  const api1 = createApi({ store: store1 });

  const keyId = authKeyId();
  const secret = authKeySecret();
  await store1.putAuthKey({
    tenantId: "tenant_default",
    authKey: {
      keyId,
      secretHash: hashAuthKeySecret(secret),
      scopes: ["ops_write", "finance_write", "audit_read"],
      status: "active",
      createdAt: typeof store1.nowIso === "function" ? store1.nowIso() : new Date().toISOString()
    }
  });
  const authorization = `Bearer ${keyId}.${secret}`;

  const now = Date.now();
  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt = new Date(now + 40 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();

  const regRobot = await request(api1, {
    method: "POST",
    path: "/robots/register",
    headers: { authorization, "x-idempotency-key": "persist_robot_reg" },
    body: { robotId: "rob_persist", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.statusCode, 201);
  const regRobotBody = regRobot.json;

  const setAvail = await request(api1, {
    method: "POST",
    path: "/robots/rob_persist/availability",
    headers: {
      authorization,
      "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash,
      "x-idempotency-key": "persist_robot_avail"
    },
    body: {
      availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.statusCode, 201);

  const createJob = await request(api1, {
    method: "POST",
    path: "/jobs",
    headers: { authorization, "x-idempotency-key": "persist_job_create" },
    body: { templateId: "reset_lite", constraints: {} }
  });
  assert.equal(createJob.statusCode, 201);
  const jobId = createJob.json.job.id;
  const preQuoteHash = createJob.json.job.lastChainHash;

  const quote = await request(api1, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { authorization, "x-proxy-expected-prev-chain-hash": preQuoteHash, "x-idempotency-key": "persist_quote" },
    body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(quote.statusCode, 201);
  const preBookHash = quote.json.job.lastChainHash;

  const book = await request(api1, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { authorization, "x-proxy-expected-prev-chain-hash": preBookHash, "x-idempotency-key": "persist_book" },
    body: { paymentHoldId: "hold_persist", startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(book.statusCode, 201);
  const preDispatchHash = book.json.job.lastChainHash;

  const dispatch = await request(api1, {
    method: "POST",
    path: `/jobs/${jobId}/dispatch`,
    headers: { authorization, "x-proxy-expected-prev-chain-hash": preDispatchHash, "x-idempotency-key": "persist_dispatch" },
    body: {}
  });
  assert.equal(dispatch.statusCode, 201);

  store1.persistence?.close();

  const store2 = createStore({ persistenceDir: dir });
  const api2 = createApi({ store: store2 });

  const robot2 = await request(api2, { method: "GET", path: "/robots/rob_persist", headers: { authorization } });
  assert.equal(robot2.statusCode, 200);
  assert.equal(robot2.json.robot.id, "rob_persist");
  assert.equal(robot2.json.robot.availability.length, 1);

  const job2 = await request(api2, { method: "GET", path: `/jobs/${jobId}`, headers: { authorization } });
  assert.equal(job2.statusCode, 200);
  assert.equal(job2.json.job.status, "RESERVED");
  assert.equal(job2.json.job.reservation.robotId, "rob_persist");

  assert.equal(store2.ledger.balances.get("acct_cash"), 7150);
  assert.equal(store2.ledger.balances.get("acct_customer_escrow"), -7150);

  // Idempotency survives restart (returns the original cached body).
  const regRobotRetry = await request(api2, {
    method: "POST",
    path: "/robots/register",
    headers: { authorization, "x-idempotency-key": "persist_robot_reg" },
    body: { robotId: "rob_persist", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobotRetry.statusCode, 201);
  assert.deepEqual(regRobotRetry.json, regRobotBody);

  const quoteRetry = await request(api2, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { authorization, "x-proxy-expected-prev-chain-hash": preQuoteHash, "x-idempotency-key": "persist_quote" },
    body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(quoteRetry.statusCode, 201);
  assert.equal(quoteRetry.json.event.id, quote.json.event.id);

  store2.persistence?.close();
  await fs.rm(dir, { recursive: true, force: true });
});
