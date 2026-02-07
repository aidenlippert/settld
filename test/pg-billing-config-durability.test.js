import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

(databaseUrl ? test : test.skip)("pg: tenant billing config survives restart", async () => {
  const schema = makeSchema();
  const tenantId = "tenant_pg_billing_cfg";

  let storeA = null;
  let storeB = null;
  try {
    storeA = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });
    const apiA = createApi({
      store: storeA,
      now: () => "2026-02-07T00:00:00.000Z",
      opsTokens: "tok_finr:finance_read;tok_finw:finance_write"
    });

    const setPlan = await request(apiA, {
      method: "PUT",
      path: "/ops/finance/billing/plan",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_finw"
      },
      body: {
        plan: "builder",
        hardLimitEnforced: true,
        planOverrides: {
          includedVerifiedRunsPerMonth: 12345
        }
      }
    });
    assert.equal(setPlan.statusCode, 200);
    assert.equal(setPlan.json?.billing?.plan, "builder");

    const setSubscription = await request(apiA, {
      method: "PUT",
      path: "/ops/finance/billing/subscription",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_finw"
      },
      body: {
        subscription: {
          provider: "stripe",
          customerId: "cus_pg_001",
          subscriptionId: "sub_pg_001",
          status: "active",
          plan: "growth",
          currentPeriodStart: "2026-02-01T00:00:00.000Z",
          currentPeriodEnd: "2026-03-01T00:00:00.000Z"
        }
      }
    });
    assert.equal(setSubscription.statusCode, 200);
    assert.equal(setSubscription.json?.subscription?.subscriptionId, "sub_pg_001");
    assert.equal(setSubscription.json?.resolvedPlan?.planId, "growth");

    await storeA.close();
    storeA = null;

    storeB = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
    const apiB = createApi({
      store: storeB,
      now: () => "2026-02-07T00:00:00.000Z",
      opsTokens: "tok_finr:finance_read;tok_finw:finance_write"
    });

    const getPlan = await request(apiB, {
      method: "GET",
      path: "/ops/finance/billing/plan",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_finr"
      }
    });
    assert.equal(getPlan.statusCode, 200);
    assert.equal(getPlan.json?.billing?.plan, "growth");

    const getSubscription = await request(apiB, {
      method: "GET",
      path: "/ops/finance/billing/subscription",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_finr"
      }
    });
    assert.equal(getSubscription.statusCode, 200);
    assert.equal(getSubscription.json?.subscription?.provider, "stripe");
    assert.equal(getSubscription.json?.subscription?.customerId, "cus_pg_001");
    assert.equal(getSubscription.json?.subscription?.subscriptionId, "sub_pg_001");

    const rowCount = await storeB.pg.pool.query("SELECT COUNT(*)::int AS c FROM tenant_billing_config WHERE tenant_id = $1", [tenantId]);
    assert.equal(Number(rowCount.rows[0]?.c ?? 0), 1);
  } finally {
    try {
      await storeB?.close?.();
    } catch {}
    try {
      await storeA?.close?.();
    } catch {}
  }
});
