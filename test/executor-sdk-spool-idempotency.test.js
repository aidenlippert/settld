import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";
import { createExecutorSdk } from "../packages/executor-sdk/src/index.js";

function makeInProcessFetch(api, { throwAfterFirstEventPost = false } = {}) {
  let threw = false;

  return async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[String(k).toLowerCase()] = String(v);

    const bodyText = init.body === undefined ? null : typeof init.body === "string" ? init.body : Buffer.from(init.body).toString("utf8");
    const chunks = bodyText === null ? [] : [Buffer.from(bodyText, "utf8")];
    const req = Readable.from(chunks);
    req.method = method;
    req.url = `${u.pathname}${u.search}`;
    req.headers = headers;

    const resHeaders = new Map();
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        resHeaders.set(String(name).toLowerCase(), String(value));
      },
      end(payload) {
        this.body = payload ?? "";
      }
    };

    await api.handle(req, res);

    const isEventPost = method === "POST" && u.pathname.includes("/events");
    if (throwAfterFirstEventPost && isEventPost && !threw) {
      threw = true;
      throw new Error("simulated network drop after server commit");
    }

    const text = typeof res.body === "string" ? res.body : Buffer.from(res.body ?? "").toString("utf8");
    return {
      status: res.statusCode,
      ok: res.statusCode >= 200 && res.statusCode < 300,
      async text() {
        return text;
      }
    };
  };
}

test("executor-sdk: disk spool survives retry without duplicating side-effects", async () => {
  const store = createStore();
  const api = createApi({ store });

  const keyId = authKeyId();
  const secret = authKeySecret();
  await store.putAuthKey({
    tenantId: "tenant_default",
    authKey: {
      keyId,
      secretHash: hashAuthKeySecret(secret),
      scopes: ["ops_write", "finance_write", "audit_read"],
      status: "active",
      createdAt: typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString()
    }
  });
  const apiKey = `${keyId}.${secret}`;

  const now = Date.now();
  const availStartAt = new Date(now - 60 * 60_000).toISOString();
  const availEndAt = new Date(now + 24 * 60 * 60_000).toISOString();
  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt = new Date(now + 70 * 60_000).toISOString();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, {
    method: "POST",
    path: "/robots/register",
    body: { robotId: "rob_sdk", publicKeyPem: robotPublicKeyPem, trustScore: 0.8, homeZoneId: "zone_a" }
  });
  assert.equal(regRobot.statusCode, 201);

  const setAvail = await request(api, {
    method: "POST",
    path: "/robots/rob_sdk/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: availStartAt, endAt: availEndAt }] }
  });
  assert.equal(setAvail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: { zoneId: "zone_a" } } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let prev = created.json.job.lastChainHash;

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": prev },
    body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(quote.statusCode, 201);
  prev = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": prev },
    body: { paymentHoldId: "hold_sdk", startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }
  });
  assert.equal(book.statusCode, 201);

  // Dispatch to RESERVED.
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await api.tickDispatch({ maxMessages: 100 });
    if (!r.processed.length) break;
  }

  const jobAfterDispatch = await request(api, { method: "GET", path: `/jobs/${jobId}` });
  assert.equal(jobAfterDispatch.statusCode, 200);
  assert.equal(jobAfterDispatch.json.job.status, "RESERVED");

  const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld_spool_"));

  const sdkA = createExecutorSdk({
    baseUrl: "http://in-process",
    tenantId: "tenant_default",
    principalId: "robot:rob_sdk",
    signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem },
    spoolDir,
    apiKey,
    fetch: makeInProcessFetch(api, { throwAfterFirstEventPost: true })
  });

  // EN_ROUTE is a robot-signed transition from RESERVED -> EN_ROUTE.
  await sdkA.appendEvent(jobId, "EN_ROUTE", { type: "robot", id: "rob_sdk" }, null);

  // "Restart": new client instance, same spool dir, network stable.
  const sdkB = createExecutorSdk({
    baseUrl: "http://in-process",
    tenantId: "tenant_default",
    principalId: "robot:rob_sdk",
    signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem },
    spoolDir,
    apiKey,
    fetch: makeInProcessFetch(api, { throwAfterFirstEventPost: false })
  });

  await sdkB.flushSpool({ maxItems: 100, allowReorder: true });

  const eventsRes = await request(api, { method: "GET", path: `/jobs/${jobId}/events` });
  assert.equal(eventsRes.statusCode, 200);
  const enRouteCount = eventsRes.json.events.filter((e) => e?.type === "EN_ROUTE").length;
  assert.equal(enRouteCount, 1);
});
