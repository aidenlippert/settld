#!/usr/bin/env node
import { Readable } from "node:stream";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { createPgStore } from "../src/db/store-pg.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function makeReq({ method, path, headers, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = path;
  req.headers = headers ?? {};
  return req;
}

function makeRes() {
  const headers = new Map();
  return {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    end(payload) {
      this.body = payload ?? "";
      this.headers = headers;
      this.ended = true;
    }
  };
}

async function request(api, { method, path, body, headers }) {
  const reqHeaders = { ...(headers ?? {}) };
  if (body !== undefined) reqHeaders["content-type"] = "application/json";
  const req = makeReq({ method, path, headers: reqHeaders, body });
  const res = makeRes();
  await api.handle(req, res);
  const text = typeof res.body === "string" ? res.body : Buffer.from(res.body ?? "").toString("utf8");
  const json = text ? JSON.parse(text) : null;
  return { statusCode: res.statusCode, json, headers: res.headers };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const mode = args.store ?? process.env.STORE ?? (process.env.DATABASE_URL ? "pg" : "memory");
  const jobsCount = Number(args.jobs ?? "200");
  const robotsCount = Number(args.robots ?? "20");
  const dispatchWorkers = Number(args["dispatch-workers"] ?? "2");
  const zoneId = args.zone ?? "zone_default";

  if (!Number.isSafeInteger(jobsCount) || jobsCount <= 0) throw new Error("--jobs must be a positive integer");
  if (!Number.isSafeInteger(robotsCount) || robotsCount <= 0) throw new Error("--robots must be a positive integer");
  if (!Number.isSafeInteger(dispatchWorkers) || dispatchWorkers <= 0) throw new Error("--dispatch-workers must be a positive integer");

  let schema = args.schema ?? null;
  const databaseUrl = process.env.DATABASE_URL ?? null;
  if (mode === "pg") {
    if (!databaseUrl) throw new Error("STORE=pg requires DATABASE_URL");
    if (!schema) schema = `chaos_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  const stores = [];
  const apis = [];

  if (mode === "pg") {
    for (let i = 0; i < dispatchWorkers; i += 1) {
      const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: i === 0 });
      stores.push(store);
      apis.push(createApi({ store }));
    }
  } else {
    const store = createStore();
    stores.push(store);
    apis.push(createApi({ store }));
  }

  const api0 = apis[0];
  const now = Date.now();
  const availStartAt = new Date(now - 60 * 60_000).toISOString();
  const availEndAt = new Date(now + 48 * 60 * 60_000).toISOString();

  // Seed robots.
  for (let i = 0; i < robotsCount; i += 1) {
    const robotId = `rob_chaos_${i}`;
    const reg = await request(api0, { method: "POST", path: "/robots/register", body: { robotId, trustScore: 0.8, homeZoneId: zoneId } });
    if (reg.statusCode !== 201) throw new Error(`robot register failed: ${JSON.stringify(reg.json)}`);
    const prev = reg.json.robot.lastChainHash;
    const avail = await request(api0, {
      method: "POST",
      path: `/robots/${robotId}/availability`,
      headers: { "x-proxy-expected-prev-chain-hash": prev },
      body: { availability: [{ startAt: availStartAt, endAt: availEndAt }], timezone: "UTC" }
    });
    if (avail.statusCode !== 201) throw new Error(`robot availability failed: ${JSON.stringify(avail.json)}`);
  }

  // Create jobs (booked + dispatch requested).
  const pilotStartBase = new Date(now + 10 * 60_000).toISOString();
  for (let i = 0; i < jobsCount; i += 1) {
    const startAt = new Date(Date.parse(pilotStartBase) + (i % 120) * 60_000).toISOString(); // spread over ~2h
    const res = await request(api0, {
      method: "POST",
      path: "/pilot/jobs",
      body: { startAt, autoBook: true, zoneId }
    });
    if (res.statusCode !== 201 && res.statusCode !== 409) {
      throw new Error(`pilot job create failed: status=${res.statusCode} body=${JSON.stringify(res.json)}`);
    }
  }

  if (mode !== "pg") {
    // Single-process dispatch loop for memory store.
    let loops = 0;
    while (loops < 10_000) {
      loops += 1;
      const r = await api0.tickDispatch({ maxMessages: 100 });
      if (!r.processed.length) break;
    }
    console.log(`dispatch processed (memory): jobs=${jobsCount}`);
    return;
  }

  const pool = stores[0].pg.pool;
  async function countPending(topic) {
    const res = await pool.query("SELECT COUNT(*)::int AS c FROM outbox WHERE processed_at IS NULL AND topic = $1", [topic]);
    return Number(res.rows[0].c);
  }

  // Dispatch loop with random restarts.
  let tick = 0;
  while (true) {
    const pending = await countPending("DISPATCH_REQUESTED");
    if (pending === 0) break;

    tick += 1;
    await Promise.all(apis.map((api) => api.tickDispatch({ maxMessages: 100 })));

    // Randomly restart one worker every ~10 ticks.
    if (tick % 10 === 0 && apis.length > 1) {
      const idx = 1 + Math.floor(Math.random() * (apis.length - 1));
      const store = stores[idx];
      await store.close();
      const newStore = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });
      stores[idx] = newStore;
      apis[idx] = createApi({ store: newStore });
    }

    // Avoid tight loop.
    await sleep(25);
  }

  // Invariants.
  const confirmedRes = await pool.query(
    `
      SELECT aggregate_id, COUNT(*) FILTER (WHERE type = 'DISPATCH_CONFIRMED')::int AS confirmed
      FROM events
      WHERE aggregate_type = 'job'
      GROUP BY aggregate_id
    `
  );
  for (const row of confirmedRes.rows) {
    const confirmed = Number(row.confirmed);
    if (confirmed > 1) throw new Error(`invariant violation: job ${row.aggregate_id} has ${confirmed} DISPATCH_CONFIRMED events`);
  }

  const pendingDispatch = await countPending("DISPATCH_REQUESTED");
  const pendingLedgerRes = await pool.query("SELECT COUNT(*)::int AS c FROM outbox WHERE processed_at IS NULL AND topic = 'LEDGER_ENTRY_APPLY'");
  const pendingNotifyRes = await pool.query("SELECT COUNT(*)::int AS c FROM outbox WHERE processed_at IS NULL AND topic LIKE 'NOTIFY_%'");

  console.log(
    JSON.stringify(
      {
        schema,
        jobsCount,
        robotsCount,
        dispatchWorkers,
        pending: {
          dispatch: pendingDispatch,
          ledger: Number(pendingLedgerRes.rows[0].c),
          notify: Number(pendingNotifyRes.rows[0].c)
        },
        jobsConfirmedChecked: confirmedRes.rows.length
      },
      null,
      2
    )
  );

  for (const store of stores) {
    await store.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

