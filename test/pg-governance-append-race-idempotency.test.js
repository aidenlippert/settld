import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { GOVERNANCE_STREAM_ID } from "../src/core/governance.js";

import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg: governance append race returns alreadyExists for identical TENANT_POLICY_UPDATED", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storeA = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  const storeB = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });

  try {
    const apiA = createApi({ store: storeA, opsTokens: "tok_fin:finance_write" });
    const apiB = createApi({ store: storeB, opsTokens: "tok_fin:finance_write" });

    const tenantId = "tenant_gov_race_a";
    const body = {
      type: "TENANT_POLICY_UPDATED",
      scope: "tenant",
      payload: { effectiveFrom: "2026-01-01T00:00:00.000Z", policy: { finance: { monthCloseHoldPolicy: "ALLOW_WITH_DISCLOSURE" } } }
    };

    const reqA = request(apiA, {
      method: "POST",
      path: "/ops/governance/events",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_fin",
        "x-proxy-expected-prev-chain-hash": "null",
        "x-idempotency-key": "idem_gov_race_a"
      },
      body
    });

    const reqB = request(apiB, {
      method: "POST",
      path: "/ops/governance/events",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_fin",
        "x-proxy-expected-prev-chain-hash": "null",
        "x-idempotency-key": "idem_gov_race_b"
      },
      body
    });

    const [a, b] = await Promise.all([reqA, reqB]);
    const status = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(status, [200, 201]);
    const already = a.statusCode === 200 ? a : b;
    assert.equal(already.json?.alreadyExists, true);

    const events = await storeA.listAggregateEvents({ tenantId, aggregateType: "month", aggregateId: GOVERNANCE_STREAM_ID });
    const policies = events.filter((e) => e?.type === "TENANT_POLICY_UPDATED");
    assert.equal(policies.length, 1);
    assert.equal(String(policies[0]?.payload?.effectiveFrom ?? ""), "2026-01-01T00:00:00.000Z");
  } finally {
    await storeB.close();
    await storeA.close();
  }
});

(databaseUrl ? test : test.skip)("pg: governance append race returns typed conflict for differing TENANT_POLICY_UPDATED payloads", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storeA = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  const storeB = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });

  try {
    const apiA = createApi({ store: storeA, opsTokens: "tok_fin:finance_write" });
    const apiB = createApi({ store: storeB, opsTokens: "tok_fin:finance_write" });

    const tenantId = "tenant_gov_race_b";
    const effectiveFrom = "2026-02-01T00:00:00.000Z";

    const reqA = request(apiA, {
      method: "POST",
      path: "/ops/governance/events",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_fin",
        "x-proxy-expected-prev-chain-hash": "null",
        "x-idempotency-key": "idem_gov_race_c"
      },
      body: {
        type: "TENANT_POLICY_UPDATED",
        scope: "tenant",
        payload: { effectiveFrom, policy: { finance: { monthCloseHoldPolicy: "ALLOW_WITH_DISCLOSURE" } } }
      }
    });

    const reqB = request(apiB, {
      method: "POST",
      path: "/ops/governance/events",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_fin",
        "x-proxy-expected-prev-chain-hash": "null",
        "x-idempotency-key": "idem_gov_race_d"
      },
      body: {
        type: "TENANT_POLICY_UPDATED",
        scope: "tenant",
        payload: { effectiveFrom, policy: { finance: { monthCloseHoldPolicy: "BLOCK_ANY_OPEN_HOLDS" } } }
      }
    });

    const [a, b] = await Promise.all([reqA, reqB]);
    const ok = a.statusCode === 201 ? a : b.statusCode === 201 ? b : null;
    const conflict = a.statusCode === 409 ? a : b.statusCode === 409 ? b : null;
    assert.ok(ok, "expected one request to succeed with 201");
    assert.ok(conflict, "expected one request to conflict with 409");
    assert.equal(conflict.json?.code, "GOVERNANCE_EFFECTIVE_FROM_CONFLICT");
  } finally {
    await storeB.close();
    await storeA.close();
  }
});

