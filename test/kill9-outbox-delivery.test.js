import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { createPgPool } from "../src/db/pg.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";

import { dropSchema, getFreePort, requestJson, startApiServer, waitForHealth } from "./kill9-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `k9_${Date.now()}_${Math.random().toString(16).slice(2)}`.replaceAll("-", "_");
}

function authHeaders() {
  const token = process.env.PROXY_OPS_TOKEN ?? "kill9_ops";
  return { authorization: `Bearer ${token}` };
}

async function createWebhookReceiver() {
  const bodiesByDedupeKey = new Map();

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const dedupeKey = req.headers["x-proxy-dedupe-key"] ? String(req.headers["x-proxy-dedupe-key"]) : "";
    const list = bodiesByDedupeKey.get(dedupeKey) ?? [];
    list.push(body);
    bodiesByDedupeKey.set(dedupeKey, list);
    res.statusCode = 200;
    res.end("ok");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : null;
  const url = `http://127.0.0.1:${port}/webhook`;
  return {
    url,
    bodiesByDedupeKey,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function waitUntil(fn, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const out = await fn();
      if (out) return out;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  if (lastErr) throw lastErr;
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function registerRobot({ baseUrl, robotId, publicKeyPem, availability }) {
  const reg = await requestJson({
    baseUrl,
    method: "POST",
    path: "/robots/register",
    headers: authHeaders(),
    body: { robotId, publicKeyPem }
  });
  assert.equal(reg.statusCode, 201, reg.text);
  const prev = reg.json?.robot?.lastChainHash ?? null;
  assert.ok(prev, "robot register response missing lastChainHash");

  const avail = await requestJson({
    baseUrl,
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: { ...authHeaders(), "x-proxy-expected-prev-chain-hash": prev },
    body: { availability }
  });
  assert.equal(avail.statusCode, 201, avail.text);
}

async function createSettledJob({ baseUrl, robotId, robotKeyId, robotPrivateKeyPem }) {
  const nowMs = Date.now();
  const bookingStartAt = new Date(nowMs + 60_000).toISOString();
  const bookingEndAt = new Date(nowMs + 3 * 60_000).toISOString();

  const created = await requestJson({
    baseUrl,
    method: "POST",
    path: "/jobs",
    headers: authHeaders(),
    body: { templateId: "reset_lite", constraints: {} }
  });
  assert.equal(created.statusCode, 201, created.text);
  const jobId = created.json?.job?.id ?? null;
  assert.ok(jobId, "job create response missing job.id");
  let lastChainHash = created.json?.job?.lastChainHash ?? null;
  assert.ok(lastChainHash, "job create response missing job.lastChainHash");

  const quote = await requestJson({
    baseUrl,
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { ...authHeaders(), "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.statusCode, 201, quote.text);
  lastChainHash = quote.json?.job?.lastChainHash ?? null;
  assert.ok(lastChainHash);

  const book = await requestJson({
    baseUrl,
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { ...authHeaders(), "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { paymentHoldId: `hold_${jobId}`, startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(book.statusCode, 201, book.text);
  lastChainHash = book.json?.job?.lastChainHash ?? null;
  assert.ok(lastChainHash);

  const postServerEvent = async (type, payload, idemKey) => {
    const res = await requestJson({
      baseUrl,
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { ...authHeaders(), "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": idemKey },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(res.statusCode, 201, res.text);
    lastChainHash = res.json?.job?.lastChainHash ?? null;
    assert.ok(lastChainHash);
  };

  const postRobotEvent = async (type, payload, at) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: robotId }, payload, at });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await requestJson({ baseUrl, method: "POST", path: `/jobs/${jobId}/events`, headers: authHeaders(), body: finalized });
    assert.equal(res.statusCode, 201, res.text);
    lastChainHash = res.json?.job?.lastChainHash ?? null;
    assert.ok(lastChainHash);
  };

  await postServerEvent("MATCHED", { robotId }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId, startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

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

  const enRouteAt = new Date(nowMs + 30_000).toISOString();
  const accessGrantedAt = new Date(nowMs + 70_000).toISOString();
  const startedAt = new Date(nowMs + 90_000).toISOString();
  const completedAt = new Date(nowMs + 120_000).toISOString();

  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, enRouteAt);
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, accessGrantedAt);
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, startedAt);
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, completedAt);

  await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);

  return { jobId };
}

(databaseUrl ? test : test.skip)("kill9: ledger outbox apply is exactly-once under crash", async () => {
  const schema = makeSchema();
  const port = await getFreePort();

  const server1 = startApiServer({
    databaseUrl,
    schema,
    port,
    env: {
      NODE_ENV: "test",
      PROXY_ENABLE_FAILPOINTS: "1",
      PROXY_FAILPOINTS: "ledger.apply.after_insert_before_outbox_done"
    }
  });

  const pool = await createPgPool({ databaseUrl, schema });
  try {
    await waitForHealth({ baseUrl: server1.baseUrl, timeoutMs: 10_000 });

    const entryId = `jnl_${schema}`;
    await pool.query("INSERT INTO outbox (topic, payload_json) VALUES ($1, $2::jsonb)", [
      "LEDGER_ENTRY_APPLY",
      JSON.stringify({
        type: "LEDGER_ENTRY_APPLY",
        tenantId: "tenant_default",
        entry: {
          id: entryId,
          memo: "kill9 ledger test",
          at: new Date().toISOString(),
          postings: [
            { accountId: "acct_cash", amountCents: 5 },
            { accountId: "acct_customer_escrow", amountCents: -5 }
          ]
        }
      })
    ]);

    // Any write request will call store.processOutbox() and should crash during ledger apply.
    await requestJson({
      baseUrl: server1.baseUrl,
      method: "POST",
      path: "/robots/register",
      headers: authHeaders(),
      body: { robotId: `rob_${schema}`, publicKeyPem: createEd25519Keypair().publicKeyPem }
    }).catch(() => {});

    const exit = await server1.waitForExit({ timeoutMs: 10_000 });
    assert.equal(exit.signal, "SIGKILL");

    const port2 = await getFreePort();
    const server2 = startApiServer({
      databaseUrl,
      schema,
      port: port2,
      env: {
        NODE_ENV: "test"
      }
    });
    try {
      await waitForHealth({ baseUrl: server2.baseUrl, timeoutMs: 10_000 });

      // Trigger outbox processing again.
      await requestJson({
        baseUrl: server2.baseUrl,
        method: "POST",
        path: "/robots/register",
        headers: authHeaders(),
        body: { robotId: `rob2_${schema}`, publicKeyPem: createEd25519Keypair().publicKeyPem }
      });

      await waitUntil(async () => {
        const r = await pool.query("SELECT COUNT(*)::int AS c FROM ledger_entries WHERE entry_id = $1", [entryId]);
        return Number(r.rows[0].c) === 1;
      });

      const entries = await pool.query("SELECT entry_json FROM ledger_entries WHERE entry_id = $1 LIMIT 1", [entryId]);
      assert.equal(entries.rows.length, 1);
      const postings = entries.rows[0].entry_json?.postings ?? [];
      const net = postings.reduce((sum, p) => sum + (Number.isSafeInteger(p?.amountCents) ? p.amountCents : 0), 0);
      assert.equal(net, 0);

      const outboxDone = await pool.query(
        "SELECT COUNT(*)::int AS c FROM outbox WHERE topic = 'LEDGER_ENTRY_APPLY' AND processed_at IS NOT NULL AND (payload_json->'entry'->>'id') = $1",
        [entryId]
      );
      assert.equal(Number(outboxDone.rows[0].c), 1);
    } finally {
      await server2.stop();
    }
  } finally {
    await pool.end();
    await server1.stop().catch(() => {});
    await dropSchema({ databaseUrl, schema });
  }
});

(databaseUrl ? test : test.skip)("kill9: artifact worker is idempotent under crash after persist", async () => {
  const schema = makeSchema();

  const receiver = await createWebhookReceiver();
  const destinations = {
    tenant_default: [
      {
        destinationId: "d1",
        url: receiver.url,
        secret: "sek",
        artifactTypes: ["WorkCertificate.v1", "SettlementStatement.v1"]
      }
    ]
  };

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  const robotId = `rob_${schema}`;

  const pool = await createPgPool({ databaseUrl, schema });
  let jobId = null;

  const port1 = await getFreePort();
  const server1 = startApiServer({
    databaseUrl,
    schema,
    port: port1,
    env: {
      NODE_ENV: "test"
    }
  });

  try {
    await waitForHealth({ baseUrl: server1.baseUrl, timeoutMs: 10_000 });

    await registerRobot({
      baseUrl: server1.baseUrl,
      robotId,
      publicKeyPem: robotPublicKeyPem,
      availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
    });

    ({ jobId } = await createSettledJob({
      baseUrl: server1.baseUrl,
      robotId,
      robotKeyId,
      robotPrivateKeyPem
    }));
  } finally {
    await server1.stop();
  }

  const port2 = await getFreePort();
  const server2 = startApiServer({
    databaseUrl,
    schema,
    port: port2,
    env: {
      NODE_ENV: "test",
      PROXY_ENABLE_FAILPOINTS: "1",
      PROXY_FAILPOINTS: "artifact.after_persist_before_enqueue",
      PROXY_AUTOTICK: "1",
      PROXY_AUTOTICK_INTERVAL_MS: "25",
      PROXY_RECLAIM_AFTER_SECONDS: "1",
      PROXY_EXPORT_DESTINATIONS: JSON.stringify(destinations)
    }
  });

  let crashArtifactRow = null;
  try {
    await waitForHealth({ baseUrl: server2.baseUrl, timeoutMs: 10_000 });
    const exit = await server2.waitForExit({ timeoutMs: 10_000 });
    assert.equal(exit.signal, "SIGKILL");

    crashArtifactRow = await pool.query(
      "SELECT artifact_id, artifact_hash FROM artifacts WHERE tenant_id = $1 AND job_id = $2 ORDER BY artifact_id ASC LIMIT 1",
      ["tenant_default", jobId]
    );
    assert.ok(crashArtifactRow.rows.length >= 1);
  } finally {
    await server2.stop().catch(() => {});
  }

  const port3 = await getFreePort();
  const server3 = startApiServer({
    databaseUrl,
    schema,
    port: port3,
    env: {
      NODE_ENV: "test",
      PROXY_AUTOTICK: "1",
      PROXY_AUTOTICK_INTERVAL_MS: "25",
      PROXY_RECLAIM_AFTER_SECONDS: "1",
      PROXY_EXPORT_DESTINATIONS: JSON.stringify(destinations)
    }
  });

  try {
    await waitForHealth({ baseUrl: server3.baseUrl, timeoutMs: 10_000 });

    await waitUntil(async () => {
      const r = await pool.query("SELECT COUNT(*)::int AS c FROM artifacts WHERE tenant_id = $1 AND job_id = $2", ["tenant_default", jobId]);
      return Number(r.rows[0].c) >= 2;
    });

    const artifacts = await pool.query(
      "SELECT artifact_id, artifact_type, artifact_hash FROM artifacts WHERE tenant_id = $1 AND job_id = $2 ORDER BY artifact_id ASC",
      ["tenant_default", jobId]
    );
    assert.equal(artifacts.rows.length, 2);
    const ids = artifacts.rows.map((r) => String(r.artifact_id));
    assert.equal(new Set(ids).size, 2);

    if (crashArtifactRow?.rows?.length) {
      const crashedId = String(crashArtifactRow.rows[0].artifact_id);
      const crashedHash = String(crashArtifactRow.rows[0].artifact_hash);
      const after = artifacts.rows.find((r) => String(r.artifact_id) === crashedId);
      assert.ok(after);
      assert.equal(String(after.artifact_hash), crashedHash);
    }

    const deliveries = await pool.query("SELECT dedupe_key FROM deliveries WHERE tenant_id = $1 ORDER BY dedupe_key ASC", ["tenant_default"]);
    assert.equal(deliveries.rows.length, 2);
    assert.equal(new Set(deliveries.rows.map((r) => String(r.dedupe_key))).size, 2);
  } finally {
    await server3.stop();
    await receiver.close();
    await pool.end();
    await dropSchema({ databaseUrl, schema });
  }
});

(databaseUrl ? test : test.skip)("kill9: webhook delivery resend is safe under crash after send", async () => {
  const schema = makeSchema();

  let receiver = null;
  let pool = null;
  let server1 = null;
  let server2 = null;
  let server3 = null;

  try {
    receiver = await createWebhookReceiver();
    const destinations = {
      tenant_default: [
        {
          destinationId: "d1",
          url: receiver.url,
          secret: "sek",
          artifactTypes: ["WorkCertificate.v1"]
        }
      ]
    };

    const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
    const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
    const robotId = `rob_${schema}`;

    pool = await createPgPool({ databaseUrl, schema });
    let jobId = null;

    const port1 = await getFreePort();
    server1 = startApiServer({
      databaseUrl,
      schema,
      port: port1,
      env: {
        NODE_ENV: "test"
      }
    });
    try {
      await waitForHealth({ baseUrl: server1.baseUrl, timeoutMs: 10_000 });

      await registerRobot({
        baseUrl: server1.baseUrl,
        robotId,
        publicKeyPem: robotPublicKeyPem,
        availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
      });

      ({ jobId } = await createSettledJob({
        baseUrl: server1.baseUrl,
        robotId,
        robotKeyId,
        robotPrivateKeyPem
      }));
    } finally {
      await server1.stop();
      server1 = null;
    }

    const port2 = await getFreePort();
    server2 = startApiServer({
      databaseUrl,
      schema,
      port: port2,
      env: {
        NODE_ENV: "test",
        PROXY_ENABLE_FAILPOINTS: "1",
        PROXY_FAILPOINTS: "delivery.webhook.after_post_before_mark",
        PROXY_AUTOTICK: "1",
        PROXY_AUTOTICK_INTERVAL_MS: "25",
        PROXY_RECLAIM_AFTER_SECONDS: "1",
        PROXY_EXPORT_DESTINATIONS: JSON.stringify(destinations)
      }
    });

    try {
      await waitForHealth({ baseUrl: server2.baseUrl, timeoutMs: 10_000 });
      // CI can be slow to process outbox -> delivery -> failpoint, so keep this generous.
      const exit = await server2.waitForExit({ timeoutMs: 30_000 });
      assert.equal(exit.signal, "SIGKILL");
    } finally {
      await server2.stop().catch(() => {});
      server2 = null;
    }

    const port3 = await getFreePort();
    server3 = startApiServer({
      databaseUrl,
      schema,
      port: port3,
      env: {
        NODE_ENV: "test",
        PROXY_AUTOTICK: "1",
        PROXY_AUTOTICK_INTERVAL_MS: "25",
        PROXY_RECLAIM_AFTER_SECONDS: "1",
        PROXY_EXPORT_DESTINATIONS: JSON.stringify(destinations)
      }
    });

    try {
      await waitForHealth({ baseUrl: server3.baseUrl, timeoutMs: 10_000 });

      const dedupeKey = await waitUntil(() => {
        for (const [k, calls] of receiver.bodiesByDedupeKey.entries()) {
          if (k && Array.isArray(calls) && calls.length >= 2) return k;
        }
        return null;
      });

      const bodies = receiver.bodiesByDedupeKey.get(dedupeKey) ?? [];
      assert.ok(bodies.length >= 2);
      for (const b of bodies) assert.equal(b, bodies[0]);

      await waitUntil(async () => {
        const r = await pool.query("SELECT state FROM deliveries WHERE tenant_id = $1 AND dedupe_key = $2 LIMIT 1", ["tenant_default", dedupeKey]);
        return r.rows.length && String(r.rows[0].state) === "delivered";
      });

      const count = await pool.query("SELECT COUNT(*)::int AS c FROM deliveries WHERE tenant_id = $1 AND dedupe_key = $2", [
        "tenant_default",
        dedupeKey
      ]);
      assert.equal(Number(count.rows[0].c), 1);

      const deliveryRows = await pool.query("SELECT state, attempts FROM deliveries WHERE tenant_id = $1 AND dedupe_key = $2 LIMIT 1", [
        "tenant_default",
        dedupeKey
      ]);
      assert.equal(String(deliveryRows.rows[0].state), "delivered");
      assert.ok(Number(deliveryRows.rows[0].attempts) >= 2);
    } finally {
      await server3.stop();
      server3 = null;
    }
  } finally {
    await server3?.stop?.().catch(() => {});
    await server2?.stop?.().catch(() => {});
    await server1?.stop?.().catch(() => {});
    await receiver?.close?.().catch(() => {});
    await pool?.end?.().catch(() => {});
    await dropSchema({ databaseUrl, schema }).catch(() => {});
  }
});
