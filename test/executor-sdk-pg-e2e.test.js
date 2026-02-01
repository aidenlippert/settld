import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";
import { createExecutorSdk } from "../packages/executor-sdk/src/index.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeInProcessFetch(api) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[String(k).toLowerCase()] = String(v);

    const bodyText = init.body === undefined ? null : typeof init.body === "string" ? init.body : Buffer.from(init.body).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : undefined;

    const res = await request(api, { method, path: `${u.pathname}${u.search}`, headers, body });
    return {
      status: res.statusCode,
      ok: res.statusCode >= 200 && res.statusCode < 300,
      async text() {
        return res.body ?? "";
      }
    };
  };
}

(databaseUrl ? test : test.skip)("executor-sdk: pg e2e emits events -> artifacts -> delivery", async () => {
  const schema = `t_sdk_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });

  const deliveries = [];
  const fetchFn = async (url, init) => {
    deliveries.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ?? null });
    return { status: 200, ok: true };
  };

  try {
    const api = createApi({
      store,
      fetchFn,
      exportDestinations: {
        tenant_default: [
          { destinationId: "wh_1", url: "https://receiver.test/webhook", secret: "shh" }
        ]
      }
    });

    const now = Date.now();
    const availStartAt = new Date(now - 60 * 60_000).toISOString();
    const availEndAt = new Date(now + 24 * 60 * 60_000).toISOString();
    const startAt = new Date(now + 10 * 60_000).toISOString();
    const endAt = new Date(now + 70 * 60_000).toISOString();

    const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
    const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

    const regRobot = await request(api, {
      method: "POST",
      path: "/robots/register",
      body: { robotId: "rob_pg_sdk", publicKeyPem: robotPublicKeyPem, trustScore: 0.8, homeZoneId: "zone_a" }
    });
    assert.equal(regRobot.statusCode, 201);

    const setAvail = await request(api, {
      method: "POST",
      path: "/robots/rob_pg_sdk/availability",
      headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
      body: { availability: [{ startAt: availStartAt, endAt: availEndAt }] }
    });
    assert.equal(setAvail.statusCode, 201);

    const created = await request(api, {
      method: "POST",
      path: "/jobs",
      body: { templateId: "reset_lite", constraints: { zoneId: "zone_a" } }
    });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;
    let prev = created.json.job.lastChainHash;

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
      body: { paymentHoldId: "hold_pg_sdk", startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
    });
    assert.equal(book.statusCode, 201);

    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await api.tickDispatch({ maxMessages: 100 });
      if (!r.processed.length) break;
    }

    const sdk = createExecutorSdk({
      baseUrl: "http://in-process",
      tenantId: "tenant_default",
      principalId: "robot:rob_pg_sdk",
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem },
      fetch: makeInProcessFetch(api)
    });

    // RESERVED -> EN_ROUTE
    await sdk.appendEvent(jobId, "EN_ROUTE", { type: "robot", id: "rob_pg_sdk" }, null);

    // Issue access plan (server-signed)
    const accessPlanId = "ap_pg_sdk_1";
    await sdk.appendEvent(
      jobId,
      "ACCESS_PLAN_ISSUED",
      { type: "ops", id: "connector_pg" },
      {
        jobId,
        accessPlanId,
        method: "BUILDING_CONCIERGE",
        credentialRef: "vault://access/ap_pg_sdk_1/v1",
        scope: { areas: ["LOBBY"], noGo: [] },
        validFrom: startAt,
        validTo: endAt,
        revocable: true,
        requestedBy: "ops"
      },
      { mode: "server" }
    );

    // EN_ROUTE -> ACCESS_GRANTED
    const accessAt = new Date(Date.parse(startAt) + 5 * 60_000).toISOString();
    await sdk.appendEvent(
      jobId,
      "ACCESS_GRANTED",
      { type: "robot", id: "rob_pg_sdk" },
      { jobId, accessPlanId, method: "BUILDING_CONCIERGE" },
      { at: accessAt }
    );

    // ACCESS_GRANTED -> EXECUTING
    const startedAt = new Date(Date.parse(accessAt) + 10_000).toISOString();
    await sdk.appendEvent(
      jobId,
      "JOB_EXECUTION_STARTED",
      { type: "robot", id: "rob_pg_sdk" },
      { jobId, robotId: "rob_pg_sdk", startedAt, stage: "TASK" },
      { at: startedAt }
    );

    const hbAt = new Date(Date.parse(startedAt) + 30_000).toISOString();
    await sdk.appendEvent(
      jobId,
      "JOB_HEARTBEAT",
      { type: "robot", id: "rob_pg_sdk" },
      { jobId, robotId: "rob_pg_sdk", t: hbAt, stage: "TASK", progress: 0.25, assistRequested: false },
      { at: hbAt }
    );

    const doneAt = new Date(Date.parse(hbAt) + 60_000).toISOString();
    await sdk.appendEvent(
      jobId,
      "JOB_EXECUTION_COMPLETED",
      { type: "robot", id: "rob_pg_sdk" },
      { jobId, robotId: "rob_pg_sdk", completedAt: doneAt },
      { at: doneAt }
    );

    // COMPLETED -> SETTLED (server-signed)
    const settledAt = new Date(Date.parse(doneAt) + 5_000).toISOString();
    await sdk.appendEvent(jobId, "SETTLED", { type: "finance", id: "settlement_v1" }, null, { mode: "server", at: settledAt });

    // Generate artifacts and deliver.
    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await api.tickArtifacts({ maxMessages: 50 });
      if (!r.processed.length) break;
    }
    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await api.tickDeliveries({ maxMessages: 50 });
      if (!r.processed.length) break;
    }

    assert.ok(deliveries.length >= 1);
    const deliveredTypes = deliveries.map((d) => String(d.headers?.["x-proxy-artifact-type"] ?? "")).filter(Boolean);
    assert.ok(deliveredTypes.includes("WorkCertificate.v1"));
    assert.ok(deliveredTypes.includes("SettlementStatement.v1"));
  } finally {
    await store.close();
  }
});
