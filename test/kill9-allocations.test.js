import test from "node:test";
import assert from "node:assert/strict";

import { createPgPool } from "../src/db/pg.js";
import { createEd25519Keypair } from "../src/core/crypto.js";

import { dropSchema, getFreePort, requestJson, startApiServer, waitForHealth } from "./kill9-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `k9_alloc_${Date.now()}_${Math.random().toString(16).slice(2)}`.replaceAll("-", "_");
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

(databaseUrl ? test : test.skip)("kill9: ledger allocations are persisted and not duplicated under crash/retry", async () => {
  const schema = makeSchema();

  const run = async ({ failpointName }) => {
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

      // Create a job so snapshots contain a job record to attribute allocations against.
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

      const suffix = String(failpointName).replaceAll(/[^a-zA-Z0-9]+/g, "_");
      const entryId = `jnl_${schema}_${suffix}`;
      const outboxInserted = await pool.query(
        "INSERT INTO outbox (topic, tenant_id, payload_json) VALUES ($1, $2, $3::jsonb) RETURNING id",
        [
          "LEDGER_ENTRY_APPLY",
          "tenant_default",
          JSON.stringify({
            type: "LEDGER_ENTRY_APPLY",
            tenantId: "tenant_default",
            jobId,
            entry: {
              id: entryId,
              memo: "kill9 allocations test",
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
      const outboxId = Number(outboxInserted.rows?.[0]?.id ?? 0);
      assert.ok(Number.isFinite(outboxId) && outboxId > 0);

      // Drain outbox through the ops endpoint so pg-mode tests don't depend on PROXY_AUTOTICK.
      // Server should crash during ledger apply due to the failpoint.
      await requestJson({
        baseUrl: server1.baseUrl,
        method: "POST",
        path: "/ops/maintenance/outbox/run",
        headers: { ...authHeaders(), "x-proxy-tenant-id": "tenant_default" },
        body: { maxMessages: 1000, passes: 3 }
      }).catch(() => {});

      const exit = await server1.waitForExit();
      assert.equal(exit.signal, "SIGKILL");

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
          body: { maxMessages: 1000, passes: 10 }
        });

        await waitUntil(async () => {
          const r = await pool.query("SELECT COUNT(*)::int AS c FROM ledger_entries WHERE tenant_id = $1 AND entry_id = $2", [
            "tenant_default",
            entryId
          ]);
          return Number(r.rows[0].c) === 1;
        });

        await waitUntil(async () => {
          const r = await pool.query("SELECT processed_at IS NOT NULL AS ok FROM outbox WHERE id = $1", [outboxId]);
          return r.rows.length ? Boolean(r.rows[0].ok) : false;
        });

        // Allocation invariants (do not assume one allocation per posting).
        const entryRes = await pool.query("SELECT entry_json FROM ledger_entries WHERE tenant_id = $1 AND entry_id = $2 LIMIT 1", [
          "tenant_default",
          entryId
        ]);
        assert.ok(entryRes.rows.length);
        const entry = entryRes.rows[0].entry_json;
        assert.ok(entry?.postings?.length);

        const allocRes = await pool.query(
          "SELECT posting_id, SUM(amount_cents)::bigint AS sum_cents FROM ledger_allocations WHERE tenant_id = $1 AND entry_id = $2 GROUP BY posting_id ORDER BY posting_id ASC",
          ["tenant_default", entryId]
        );
        const sumsByPosting = new Map(allocRes.rows.map((r) => [String(r.posting_id), Number(r.sum_cents)]));
        for (let i = 0; i < entry.postings.length; i += 1) {
          const postingId = `p${i}`;
          const expected = Number(entry.postings[i].amountCents);
          const actual = sumsByPosting.get(postingId);
          assert.notEqual(actual, undefined);
          assert.equal(actual, expected);
        }
      } finally {
        await server2.stop();
      }
    } finally {
      await pool.end();
      await server1.stop().catch(() => {});
    }
  };

  try {
    await run({ failpointName: "ledger.apply.after_postings_before_allocations" });
    await run({ failpointName: "ledger.apply.after_allocations_before_outbox_done" });
  } finally {
    await dropSchema({ databaseUrl, schema });
  }
});
