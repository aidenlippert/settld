import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

(databaseUrl ? test : test.skip)("pg api e2e: finance reconciliation triage survives refresh", async () => {
  const schema = makeSchema();
  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });

  try {
    const api = createApi({
      store,
      opsTokens: ["tok_finw:finance_write", "tok_finr:finance_read"].join(";")
    });

    const financeWriteHeaders = {
      "x-proxy-ops-token": "tok_finw",
      "x-proxy-tenant-id": "tenant_default",
      "x-nooterra-protocol": "1.0"
    };
    const financeReadHeaders = {
      "x-proxy-ops-token": "tok_finr",
      "x-proxy-tenant-id": "tenant_default"
    };

    const upserted = await request(api, {
      method: "POST",
      path: "/ops/finance/reconciliation/triage",
      headers: {
        ...financeWriteHeaders,
        "x-idempotency-key": "pg_fin_recon_triage_upsert_1"
      },
      body: {
        action: "investigate_terminal_failure",
        sourceType: "money_rails_reconcile",
        period: "2026-01",
        providerId: "stub_default",
        mismatchType: "terminal_failure",
        mismatchKey: "operation:op_pg_triage_1",
        mismatchCode: "insufficient_liquidity",
        status: "in_progress",
        severity: "critical",
        ownerPrincipalId: "ops.finance@nooterra.test",
        notes: "Investigating mismatch"
      }
    });
    assert.equal(upserted.statusCode, 200, upserted.body);
    assert.equal(upserted.json?.changed, true);
    assert.equal(upserted.json?.triage?.status, "in_progress");
    assert.equal(upserted.json?.triage?.revision, 1);
    const triageKey = String(upserted.json?.triage?.triageKey ?? "");
    assert.ok(triageKey.length > 0);

    await store.refreshFromDb();

    const listed = await request(api, {
      method: "GET",
      path: "/ops/finance/reconciliation/triage?period=2026-01&providerId=stub_default&sourceType=money_rails_reconcile",
      headers: financeReadHeaders,
      auth: "none"
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json?.count, 1);
    assert.equal(listed.json?.triages?.[0]?.triageKey, triageKey);
    assert.equal(listed.json?.triages?.[0]?.status, "in_progress");

    const resolved = await request(api, {
      method: "POST",
      path: "/ops/finance/reconciliation/triage",
      headers: {
        ...financeWriteHeaders,
        "x-idempotency-key": "pg_fin_recon_triage_resolve_1"
      },
      body: {
        triageKey,
        action: "resolve_mismatch",
        status: "resolved",
        notes: "Resolved in pg test"
      }
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json?.triage?.status, "resolved");
    assert.equal(resolved.json?.triage?.revision, 2);

    await store.refreshFromDb();

    const resolvedList = await request(api, {
      method: "GET",
      path: "/ops/finance/reconciliation/triage?period=2026-01&providerId=stub_default&sourceType=money_rails_reconcile&status=resolved",
      headers: financeReadHeaders,
      auth: "none"
    });
    assert.equal(resolvedList.statusCode, 200, resolvedList.body);
    assert.equal(resolvedList.json?.count, 1);
    assert.equal(resolvedList.json?.triages?.[0]?.triageKey, triageKey);
    assert.equal(resolvedList.json?.triages?.[0]?.status, "resolved");

    const count = await store.pg.pool.query(
      "SELECT COUNT(*)::int AS c FROM snapshots WHERE tenant_id = $1 AND aggregate_type = 'finance_reconciliation_triage'",
      ["tenant_default"]
    );
    assert.equal(Number(count.rows[0]?.c ?? 0), 1);
  } finally {
    await store.close();
  }
});
