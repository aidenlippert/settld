import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg: outbox workers are safe under concurrency (dispatch + ledger)", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const storeA = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  const storeB = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });

  try {
    const apiA = createApi({ store: storeA });
    const apiB = createApi({ store: storeB });

    const now = Date.now();
    const availStartAt = new Date(now - 60 * 60_000).toISOString();
    const availEndAt = new Date(now + 24 * 60 * 60_000).toISOString();
    const startAt = new Date(now + 10 * 60_000).toISOString();
    const endAt = new Date(now + 70 * 60_000).toISOString();

    const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
    const regRobot = await request(apiA, {
      method: "POST",
      path: "/robots/register",
      body: { robotId: "rob_pg", publicKeyPem: robotPublicKeyPem, trustScore: 0.8, homeZoneId: "zone_a" }
    });
    assert.equal(regRobot.statusCode, 201);
    const setAvail = await request(apiA, {
      method: "POST",
      path: "/robots/rob_pg/availability",
      headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
      body: { availability: [{ startAt: availStartAt, endAt: availEndAt }] }
    });
    assert.equal(setAvail.statusCode, 201);

    const created = await request(apiA, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: { zoneId: "zone_a" } } });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;
    let prev = created.json.job.lastChainHash;

    const quote = await request(apiA, {
      method: "POST",
      path: `/jobs/${jobId}/quote`,
      headers: { "x-proxy-expected-prev-chain-hash": prev },
      body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
    });
    assert.equal(quote.statusCode, 201);
    prev = quote.json.job.lastChainHash;

    const book = await request(apiA, {
      method: "POST",
      path: `/jobs/${jobId}/book`,
      headers: { "x-proxy-expected-prev-chain-hash": prev },
      body: { paymentHoldId: "hold_pg", startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
    });
    assert.equal(book.statusCode, 201);

    const [tickA, tickB] = await Promise.all([apiA.tickDispatch(), apiB.tickDispatch()]);
    assert.equal(tickA.processed.length + tickB.processed.length, 1);

    const eventsRes = await request(apiA, { method: "GET", path: `/jobs/${jobId}/events` });
    assert.equal(eventsRes.statusCode, 200);
    const confirmedCount = eventsRes.json.events.filter((e) => e?.type === "DISPATCH_CONFIRMED").length;
    assert.equal(confirmedCount, 1);

    // Prove ledger outbox processing is concurrency-safe as well.
    const entryId = `jnl_${schema}`;
    const cashBeforeRes = await storeA.pg.pool.query("SELECT balance_cents FROM ledger_balances WHERE account_id = $1", ["acct_cash"]);
    const cashBefore = cashBeforeRes.rows.length ? Number(cashBeforeRes.rows[0].balance_cents) : 0;

    const entry = {
      id: entryId,
      memo: "pg concurrency test",
      at: new Date().toISOString(),
      postings: [
        { accountId: "acct_cash", amountCents: 1 },
        { accountId: "acct_customer_escrow", amountCents: -1 }
      ]
    };

    await storeA.pg.pool.query("INSERT INTO outbox (topic, payload_json) VALUES ($1, $2::jsonb)", [
      "LEDGER_ENTRY_APPLY",
      JSON.stringify({ type: "LEDGER_ENTRY_APPLY", entry })
    ]);

    await Promise.all([storeA.processOutbox(), storeB.processOutbox()]);

    const entryCountRes = await storeA.pg.pool.query("SELECT COUNT(*)::int AS c FROM ledger_entries WHERE entry_id = $1", [entryId]);
    assert.equal(Number(entryCountRes.rows[0].c), 1);

    const cashAfterRes = await storeA.pg.pool.query("SELECT balance_cents FROM ledger_balances WHERE account_id = $1", ["acct_cash"]);
    const cashAfter = cashAfterRes.rows.length ? Number(cashAfterRes.rows[0].balance_cents) : 0;
    assert.equal(cashAfter, cashBefore + 1);
  } finally {
    await storeB.close();
    await storeA.close();
  }
});

