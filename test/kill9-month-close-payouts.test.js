import test from "node:test";
import assert from "node:assert/strict";

import { createPgPool } from "../src/db/pg.js";
import { createEd25519Keypair } from "../src/core/crypto.js";

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

(databaseUrl ? test : test.skip)("kill9: month close party statements + payouts are restart-safe (no dupes)", async () => {
  const schema = makeSchema();
  const month = new Date().toISOString().slice(0, 7); // current UTC month

  const run = async ({ failpointName, expectPayoutBeforeCrash }) => {
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

      const created = await requestJson({
        baseUrl: server1.baseUrl,
        method: "POST",
        path: "/jobs",
        headers: authHeaders(),
        body: { templateId: "reset_lite", constraints: {} }
      });
      assert.equal(created.statusCode, 201);
      const jobId = created.json?.job?.id ?? null;
      assert.ok(jobId);
      let lastChainHash = created.json?.job?.lastChainHash ?? null;
      assert.ok(lastChainHash);

      // Minimal booking to allow SETTLED.
      const quote = await requestJson({
        baseUrl: server1.baseUrl,
        method: "POST",
        path: `/jobs/${jobId}/quote`,
        headers: { ...authHeaders(), "x-proxy-expected-prev-chain-hash": lastChainHash },
        body: {
          startAt: new Date(Date.now() + 60_000).toISOString(),
          endAt: new Date(Date.now() + 120_000).toISOString(),
          environmentTier: "ENV_MANAGED_BUILDING",
          requiresOperatorCoverage: false
        }
      });
      assert.equal(quote.statusCode, 201);
      lastChainHash = quote.json?.job?.lastChainHash ?? lastChainHash;

      const book = await requestJson({
        baseUrl: server1.baseUrl,
        method: "POST",
        path: `/jobs/${jobId}/book`,
        headers: { ...authHeaders(), "x-proxy-expected-prev-chain-hash": lastChainHash },
        body: {
          paymentHoldId: `hold_${jobId}`,
          startAt: new Date(Date.now() + 60_000).toISOString(),
          endAt: new Date(Date.now() + 120_000).toISOString(),
          environmentTier: "ENV_MANAGED_BUILDING",
          requiresOperatorCoverage: false
        }
      });
      assert.equal(book.statusCode, 201);
      lastChainHash = book.json?.job?.lastChainHash ?? lastChainHash;

      const settled = await requestJson({
        baseUrl: server1.baseUrl,
        method: "POST",
        path: `/jobs/${jobId}/events`,
        headers: { ...authHeaders(), "x-proxy-expected-prev-chain-hash": lastChainHash },
        body: { type: "SETTLED", actor: { type: "system", id: "proxy" }, payload: { settlement: "demo" } }
      });
      assert.equal(settled.statusCode, 201);

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
              memo: `job:${jobId} SETTLED (kill9 payout seed)`,
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

      const exit = await server1.waitForExit({ timeoutMs: 10_000 });
      assert.equal(exit.signal, "SIGKILL");

      // Verify partial state based on crash window.
      const payoutCountBefore = await pool.query(
        "SELECT COUNT(*)::int AS c FROM artifacts WHERE tenant_id = $1 AND artifact_type = $2 AND (artifact_json->>'period') = $3",
        ["tenant_default", "PayoutInstruction.v1", month]
      );
      if (expectPayoutBeforeCrash) {
        assert.equal(Number(payoutCountBefore.rows[0].c), 1);
      } else {
        assert.equal(Number(payoutCountBefore.rows[0].c), 0);
      }

      const port2 = await getFreePort();
      const server2 = startApiServer({
        databaseUrl,
        schema,
        port: port2,
        env: { NODE_ENV: "test" }
      });

      try {
        await waitForHealth({ baseUrl: server2.baseUrl, timeoutMs: 10_000 });

        // Trigger outbox processing again.
        await requestJson({
          baseUrl: server2.baseUrl,
          method: "POST",
          path: "/robots/register",
          headers: authHeaders(),
          body: { robotId: `rob_${schema}_${Date.now()}`, publicKeyPem: createEd25519Keypair().publicKeyPem }
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
    }
  };

  try {
    await run({ failpointName: "month_close.after_party_statements_before_payouts", expectPayoutBeforeCrash: false });
    await run({ failpointName: "month_close.after_payouts_before_outbox_done", expectPayoutBeforeCrash: true });
  } finally {
    await dropSchema({ databaseUrl, schema });
  }
});

