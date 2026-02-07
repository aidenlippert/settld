import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { sha256Hex } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

(databaseUrl ? test : test.skip)("pg: money rail operations and provider events are durable across restart", async () => {
  const schema = makeSchema();
  const tenantId = "tenant_default";
  const month = "2026-01";
  const partyId = "pty_pg_money_rails_1";
  const partyRole = "operator";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw", "x-proxy-tenant-id": tenantId };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_finr", "x-proxy-tenant-id": tenantId };

  let storeA = null;
  let storeB = null;
  try {
    storeA = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });
    const apiA = createApi({
      store: storeA,
      opsTokens: ["tok_finw:finance_write", "tok_finr:finance_read"].join(";")
    });

    const monthCloseRequested = await request(apiA, {
      method: "POST",
      path: "/ops/month-close",
      headers: financeWriteHeaders,
      body: { month }
    });
    assert.equal(monthCloseRequested.statusCode, 202);
    await apiA.tickMonthClose({ maxMessages: 50 });

    const statement = {
      type: "PartyStatementBody.v1",
      v: 1,
      currency: "USD",
      tenantId,
      partyId,
      partyRole,
      period: month,
      basis: "settledAt",
      payoutCents: 2100
    };
    const statementHash = sha256Hex(JSON.stringify(statement));
    const artifact = {
      artifactId: `pstmt_${tenantId}_${partyId}_${month}_${statementHash}`,
      artifactType: "PartyStatement.v1",
      partyId,
      partyRole,
      period: month,
      statement,
      artifactHash: statementHash
    };
    await apiA.store.putArtifact({ tenantId, artifact });
    await apiA.store.putPartyStatement({
      tenantId,
      statement: {
        partyId,
        period: month,
        basis: "settledAt",
        status: "CLOSED",
        statementHash,
        artifactId: artifact.artifactId,
        artifactHash: artifact.artifactHash,
        closedAt: new Date("2026-02-01T00:00:00.000Z").toISOString()
      }
    });

    const enqueue = await request(apiA, {
      method: "POST",
      path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
      headers: {
        ...financeWriteHeaders,
        "x-idempotency-key": "pg_money_rails_enqueue_1"
      },
      body: { counterpartyRef: "bank:acct_pg_1" }
    });
    assert.equal(enqueue.statusCode, 201);
    const providerId = String(enqueue.json?.moneyRailOperation?.providerId ?? "");
    const operationId = String(enqueue.json?.moneyRailOperation?.operationId ?? "");
    assert.equal(providerId, "stub_default");
    assert.ok(operationId);

    const ingested = await request(apiA, {
      method: "POST",
      path: `/ops/money-rails/${encodeURIComponent(providerId)}/events/ingest`,
      headers: {
        ...financeWriteHeaders,
        "x-idempotency-key": "pg_money_rails_ingest_1"
      },
      body: {
        operationId,
        eventType: "submitted",
        eventId: "evt_pg_submit_1",
        at: "2026-02-07T00:01:00.000Z"
      }
    });
    assert.equal(ingested.statusCode, 200);
    assert.equal(ingested.json?.operation?.state, "submitted");

    await storeA.close();
    storeA = null;

    storeB = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
    const apiB = createApi({
      store: storeB,
      opsTokens: ["tok_finw:finance_write", "tok_finr:finance_read"].join(";")
    });

    const status = await request(apiB, {
      method: "GET",
      path: `/ops/money-rails/${encodeURIComponent(providerId)}/operations/${encodeURIComponent(operationId)}`,
      headers: financeReadHeaders
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json?.operation?.state, "submitted");

    const operationCountRes = await storeB.pg.pool.query(
      "SELECT COUNT(*)::int AS c FROM money_rail_operations WHERE tenant_id = $1 AND provider_id = $2 AND operation_id = $3",
      [tenantId, providerId, operationId]
    );
    assert.equal(Number(operationCountRes.rows[0]?.c ?? 0), 1);

    const eventCountRes = await storeB.pg.pool.query(
      "SELECT COUNT(*)::int AS c FROM money_rail_provider_events WHERE tenant_id = $1 AND provider_id = $2 AND operation_id = $3",
      [tenantId, providerId, operationId]
    );
    assert.equal(Number(eventCountRes.rows[0]?.c ?? 0), 1);
  } finally {
    try {
      await storeB?.close?.();
    } catch {}
    try {
      await storeA?.close?.();
    } catch {}
  }
});
