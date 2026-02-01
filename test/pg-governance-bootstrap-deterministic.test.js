import test from "node:test";
import assert from "node:assert/strict";

import { createPgPool, quoteIdent } from "../src/db/pg.js";
import { createPgStore } from "../src/db/store-pg.js";
import { GOVERNANCE_STREAM_ID } from "../src/core/governance.js";
import { DEFAULT_TENANT_ID } from "../src/core/tenancy.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg: governance bootstrap registration is idempotent across restarts", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let storeA = null;
  let storeB = null;
  try {
    storeA = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });
    const aEvents = await storeA.listAggregateEvents({ tenantId: DEFAULT_TENANT_ID, aggregateType: "month", aggregateId: GOVERNANCE_STREAM_ID });
    assert.ok(Array.isArray(aEvents));
    assert.ok(aEvents.length >= 1);
    const aHead = aEvents[aEvents.length - 1]?.chainHash ?? null;
    assert.ok(aHead);

    await storeA.close();
    storeA = null;

    storeB = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });
    const bEvents = await storeB.listAggregateEvents({ tenantId: DEFAULT_TENANT_ID, aggregateType: "month", aggregateId: GOVERNANCE_STREAM_ID });
    assert.equal(bEvents.length, aEvents.length);
    const bHead = bEvents[bEvents.length - 1]?.chainHash ?? null;
    assert.equal(bHead, aHead);
  } finally {
    try {
      await storeB?.close?.();
    } catch {}
    try {
      await storeA?.close?.();
    } catch {}

    const adminPool = await createPgPool({ databaseUrl, schema: "public" });
    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    } finally {
      await adminPool.end();
    }
  }
});

