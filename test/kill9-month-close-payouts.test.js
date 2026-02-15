import test from "node:test";
import assert from "node:assert/strict";

import { createPgPool } from "../src/db/pg.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";

import { dropSchema, getFreePort, requestJson, startApiServer, waitForHealth } from "./kill9-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `k9_monthclose_${Date.now()}_${Math.random().toString(16).slice(2)}`.replaceAll("-", "_");
}

function authHeaders() {
  const token = process.env.PROXY_OPS_TOKEN ?? "kill9_ops";
  return { authorization: `Bearer ${token}` };
}

async function waitUntil(fn, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fn().catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timeout");
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

(databaseUrl ? test : test.skip)("kill9: month close party statements + payouts are restart-safe (no dupes)", async () => {
  const month = new Date().toISOString().slice(0, 7); // current UTC month

  const run = async ({ failpointName }) => {
    const schema = makeSchema();
    const port = await getFreePort();
    const server1 = startApiServer({
      databaseUrl,
      schema,
      port,
      env: {
        NODE_ENV: "test",
        PROXY_ENABLE_FAILPOINTS: "1",
        PROXY_FAILPOINTS: String(failpointName)
      }
    });

    const pool = await createPgPool({ databaseUrl, schema });
    try {
      await waitForHealth({ baseUrl: server1.baseUrl, timeoutMs: 10_000 });

      const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
      const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
      const robotId = `rob_${schema}_${String(failpointName).replaceAll(/[^a-zA-Z0-9]+/g, "_")}`;
      await registerRobot({
        baseUrl: server1.baseUrl,
        robotId,
        publicKeyPem: robotPublicKeyPem,
        availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
      });

      const { jobId } = await createSettledJob({
        baseUrl: server1.baseUrl,
        robotId,
        robotKeyId,
        robotPrivateKeyPem
      });

      // Ensure at least one operator-payable allocation exists (used to generate payout instructions).
      await pool.query(
        "INSERT INTO outbox (topic, tenant_id, payload_json) VALUES ($1, $2, $3::jsonb)",
        [
          "LEDGER_ENTRY_APPLY",
          "tenant_default",
          JSON.stringify({
            type: "LEDGER_ENTRY_APPLY",
            tenantId: "tenant_default",
            jobId,
            entry: {
              id: `jnl_${schema}_${String(failpointName).replaceAll(/[^a-zA-Z0-9]+/g, "_")}`,
              memo: `job:${jobId} (kill9 payout seed)`,
              at: new Date().toISOString(),
              postings: [
                { accountId: "acct_platform_revenue", amountCents: -5 },
                { accountId: "acct_owner_payable", amountCents: -5 },
                { accountId: "acct_customer_escrow", amountCents: 10 }
              ]
            }
          })
        ]
      );

      // Trigger month close; server should die during outbox month-close processing.
      await requestJson({
        baseUrl: server1.baseUrl,
        method: "POST",
        path: "/ops/month-close",
        headers: authHeaders(),
        body: { month }
      }).catch(() => {});

      const exit = await server1.waitForExit();
      assert.equal(exit.signal, "SIGKILL");

      // SIGKILL aborts the in-flight TX, so we should not observe partially persisted payout artifacts.
      const payoutCountBefore = await pool.query(
        "SELECT COUNT(*)::int AS c FROM artifacts WHERE tenant_id = $1 AND artifact_type = $2 AND (artifact_json->>'period') = $3",
        ["tenant_default", "PayoutInstruction.v1", month]
      );
      assert.equal(Number(payoutCountBefore.rows[0].c), 0);

      const port2 = await getFreePort();
      const server2 = startApiServer({
        databaseUrl,
        schema,
        port: port2,
        env: { NODE_ENV: "test" }
      });

      try {
        await waitForHealth({ baseUrl: server2.baseUrl, timeoutMs: 10_000 });

        await requestJson({
          baseUrl: server2.baseUrl,
          method: "POST",
          path: "/ops/maintenance/outbox/run",
          headers: { ...authHeaders(), "x-proxy-tenant-id": "tenant_default" },
          body: { maxMessages: 1000, passes: 20 }
        });

        await waitUntil(async () => {
          const r = await pool.query(
            "SELECT COUNT(*)::int AS c FROM outbox WHERE topic = 'MONTH_CLOSE_REQUESTED' AND processed_at IS NOT NULL",
            []
          );
          return Number(r.rows[0].c) >= 1;
        });

        // Party statements are closed exactly once per (tenant, party, period) due to PK.
        await waitUntil(async () => {
          const r = await pool.query(
            "SELECT COUNT(*)::int AS c FROM party_statements WHERE tenant_id = $1 AND period = $2 AND status = 'CLOSED'",
            ["tenant_default", month]
          );
          return Number(r.rows[0].c) >= 1;
        });

        // PayoutInstruction is hash-addressed and should not duplicate under retries.
        await waitUntil(async () => {
          const r = await pool.query(
            "SELECT COUNT(*)::int AS c FROM artifacts WHERE tenant_id = $1 AND artifact_type = $2 AND (artifact_json->>'period') = $3",
            ["tenant_default", "PayoutInstruction.v1", month]
          );
          return Number(r.rows[0].c) === 1;
        });
      } finally {
        await server2.stop();
      }
    } finally {
      await pool.end();
      await server1.stop().catch(() => {});
      await dropSchema({ databaseUrl, schema }).catch(() => {});
    }
  };

  await run({ failpointName: "month_close.after_party_statements_before_payouts" });
  await run({ failpointName: "month_close.after_payouts_before_outbox_done" });
});
