import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { presignS3Url } from "../src/core/s3-presign.js";
import { verifyArtifactHash, verifySettlementBalances } from "../packages/artifact-verify/src/index.js";
import { hmacSignArtifact } from "../src/core/artifacts.js";

const RUN = process.env.RUN_RECEIVER_E2E === "1";

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  if (lastErr) throw lastErr;
  throw new Error("timeout");
}

function startNodeProcess({ name, cmd, args, env }) {
  const proc = spawn(cmd, args, {
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      // eslint-disable-next-line no-console
      console.error(`${name} exited`, { code, signal });
    }
  });
  return proc;
}

async function stopProc(proc) {
  if (!proc || typeof proc.kill !== "function") return;
  if (proc.exitCode !== null && proc.exitCode !== undefined) return;
  try {
    proc.kill("SIGTERM");
  } catch {}
  const exited = await Promise.race([
    new Promise((resolve) => proc.on("exit", () => resolve(true))),
    sleep(3000).then(() => false)
  ]);
  if (!exited) {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
}

async function httpJson({ baseUrl, method, path, headers, body }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(headers ?? {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const json = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
  return { status: res.status, json, text, headers: res.headers };
}

async function composeUpDeps() {
  const proc = spawn("docker", ["compose", "up", "-d", "postgres", "minio", "minio-init"], { stdio: "inherit" });
  const code = await new Promise((resolve) => proc.on("exit", resolve));
  if (code !== 0) throw new Error("docker compose up failed");
}

async function composeDownDeps() {
  const proc = spawn("docker", ["compose", "down", "--remove-orphans"], { stdio: "inherit" });
  await new Promise((resolve) => proc.on("exit", resolve));
}

async function waitForMinio() {
  await waitFor(async () => {
    const res = await fetch("http://127.0.0.1:9000/minio/health/ready").catch(() => null);
    return res && res.status === 200;
  });
}

async function createApiKey({ apiBase, tenantId, opsToken }) {
  const res = await httpJson({
    baseUrl: apiBase,
    method: "POST",
    path: "/ops/api-keys",
    headers: { "x-proxy-tenant-id": tenantId, "x-proxy-ops-token": opsToken },
    body: { scopes: ["ops_write", "finance_write", "audit_read", "ops_read", "finance_read"] }
  });
  assert.equal(res.status, 201, res.text);
  return { bearer: `Bearer ${res.json.keyId}.${res.json.secret}` };
}

async function runJobLifecycle({ apiBase, authHeader, tenantId }) {
  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  // register robot
  const reg = await httpJson({
    baseUrl: apiBase,
    method: "POST",
    path: "/robots/register",
    headers: { "x-proxy-tenant-id": tenantId, authorization: authHeader },
    body: { robotId: "rob_receiver", publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(reg.status, 201, reg.text);

  const avail = await httpJson({
    baseUrl: apiBase,
    method: "POST",
    path: "/robots/rob_receiver/availability",
    headers: { "x-proxy-tenant-id": tenantId, authorization: authHeader, "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
    body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
  });
  assert.equal(avail.status, 201, avail.text);

  const created = await httpJson({
    baseUrl: apiBase,
    method: "POST",
    path: "/jobs",
    headers: { "x-proxy-tenant-id": tenantId, authorization: authHeader },
    body: { templateId: "reset_lite", constraints: {} }
  });
  assert.equal(created.status, 201, created.text);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const bookingStartAt = "2026-01-20T10:30:00.000Z";
  const bookingEndAt = "2026-01-20T11:00:00.000Z";

  const quote = await httpJson({
    baseUrl: apiBase,
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-tenant-id": tenantId, authorization: authHeader, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.status, 201, quote.text);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await httpJson({
    baseUrl: apiBase,
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-tenant-id": tenantId, authorization: authHeader, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { paymentHoldId: `hold_${jobId}`, startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(book.status, 201, book.text);
  lastChainHash = book.json.job.lastChainHash;

  const postServerEvent = async (type, payload, idem) => {
    const r = await httpJson({
      baseUrl: apiBase,
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: {
        "x-proxy-tenant-id": tenantId,
        authorization: authHeader,
        "x-proxy-expected-prev-chain-hash": lastChainHash,
        "x-idempotency-key": idem
      },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(r.status, 201, r.text);
    lastChainHash = r.json.job.lastChainHash;
  };

  const postRobotEvent = async (type, payload, at) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_receiver" }, payload, at });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const r = await httpJson({ baseUrl: apiBase, method: "POST", path: `/jobs/${jobId}/events`, headers: { "x-proxy-tenant-id": tenantId, authorization: authHeader }, body: finalized });
    assert.equal(r.status, 201, r.text);
    lastChainHash = r.json.job.lastChainHash;
  };

  await postServerEvent("MATCHED", { robotId: "rob_receiver" }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId: "rob_receiver", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

  const accessPlanId = `ap_${jobId}`;
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "DOCKED_IN_BUILDING",
      credentialRef: `vault://access/${accessPlanId}/v1`,
      scope: { areas: ["ENTRYWAY"], noGo: [] },
      validFrom: bookingStartAt,
      validTo: bookingEndAt,
      revocable: true,
      requestedBy: "system"
    },
    `ap_${jobId}`
  );

  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 }, "2026-01-20T10:28:00.000Z");
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" }, "2026-01-20T10:31:00.000Z");
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] }, "2026-01-20T10:32:00.000Z");
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } }, "2026-01-20T10:37:00.000Z");

  await postServerEvent("SETTLED", { settlement: "demo" }, `s_${jobId}`);

  return { jobId };
}

async function getStoredArtifactFromMinio({ key, accessKeyId, secretAccessKey }) {
  const url = presignS3Url({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "proxy-artifacts",
    key,
    method: "GET",
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
    expiresInSeconds: 60
  });
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

async function headMinioObject({ key, accessKeyId, secretAccessKey }) {
  const url = presignS3Url({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "proxy-artifacts",
    key,
    method: "HEAD",
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
    expiresInSeconds: 60
  });
  const res = await fetch(url, { method: "HEAD" });
  return { status: res.status };
}

test("receiver e2e: happy path (deliver -> verify -> store -> ack)", { skip: !RUN }, async () => {
  await composeUpDeps();
  await waitForMinio();

  const tenantId = "tenant_default";
  const opsToken = "tok";
  const destinationId = "receiver_v1";
  const secret = "receiversecret";

  const apiPort = await pickPort();
  const receiverPort = await pickPort();
  const schema = `e2e_receiver_${String(Math.random()).slice(2, 10)}`;
  const dedupePath = `.tmp/receiver_${schema}.jsonl`;
  await fs.mkdir(".tmp", { recursive: true });

  const apiProc = startNodeProcess({
    name: "api",
    cmd: "node",
    args: ["src/api/server.js"],
    env: {
      NODE_ENV: "test",
      PORT: String(apiPort),
      STORE: "pg",
      DATABASE_URL: "postgres://proxy:proxy@127.0.0.1:5432/proxy",
      PROXY_PG_SCHEMA: schema,
      PROXY_MIGRATE_ON_STARTUP: "1",
      PROXY_OPS_TOKENS: `${opsToken}:ops_read,ops_write,finance_read,finance_write,audit_read`,
      PROXY_AUTOTICK: "1",
      PROXY_AUTOTICK_INTERVAL_MS: "100",
      PROXY_AUTOTICK_MAX_MESSAGES: "200",
      PROXY_EXPORT_DESTINATIONS: JSON.stringify({
        [tenantId]: [{ destinationId, kind: "webhook", url: `http://127.0.0.1:${receiverPort}/deliveries/settld`, secret }]
      })
    }
  });

  const receiverProc = startNodeProcess({
    name: "receiver",
    cmd: "node",
    args: ["services/receiver/src/server.js"],
    env: {
      NODE_ENV: "test",
      RECEIVER_PORT: String(receiverPort),
      RECEIVER_TENANT_ID: tenantId,
      RECEIVER_DESTINATION_ID: destinationId,
      RECEIVER_ACK_URL: `http://127.0.0.1:${apiPort}/exports/ack`,
      RECEIVER_ALLOW_INLINE_SECRETS: "1",
      RECEIVER_HMAC_SECRET: secret,
      RECEIVER_S3_ENDPOINT: "http://127.0.0.1:9000",
      RECEIVER_S3_REGION: "us-east-1",
      RECEIVER_S3_BUCKET: "proxy-artifacts",
      RECEIVER_S3_PREFIX: "settld/",
      RECEIVER_S3_FORCE_PATH_STYLE: "1",
      RECEIVER_S3_ACCESS_KEY_ID: "proxy",
      RECEIVER_S3_SECRET_ACCESS_KEY: "proxysecret",
      RECEIVER_DEDUPE_DB_PATH: dedupePath
    }
  });

  const apiBase = `http://127.0.0.1:${apiPort}`;
  await waitFor(async () => (await fetch(`${apiBase}/health`).catch(() => null))?.status === 200);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${receiverPort}/ready`).catch(() => null))?.status === 200);

  const auth = await createApiKey({ apiBase, tenantId, opsToken });
  await runJobLifecycle({ apiBase, authHeader: auth.bearer, tenantId });

  const deliveries = await waitFor(async () => {
    const r = await httpJson({
      baseUrl: apiBase,
      method: "GET",
      path: "/ops/deliveries?state=delivered&limit=50",
      headers: { "x-proxy-tenant-id": tenantId, "x-proxy-ops-token": opsToken }
    });
    if (r.status !== 200) return null;
    const list = r.json?.deliveries ?? [];
    if (list.length !== 1) return null;
    if (!list[0].ackedAt) return null;
    return list[0];
  });

  const artifactKey = `settld/artifacts/${deliveries.artifactType}/${deliveries.artifactHash}.json`;
  const stored = await getStoredArtifactFromMinio({ key: artifactKey, accessKeyId: "proxy", secretAccessKey: "proxysecret" });
  assert.equal(stored.status, 200);
  assert.equal(verifyArtifactHash(stored.json).ok, true);
  assert.equal(verifySettlementBalances(stored.json).ok, true);

  await stopProc(receiverProc);
  await stopProc(apiProc);
  await composeDownDeps();
});

test("receiver e2e: retry (timeout once) -> dedupe -> single store", { skip: !RUN }, async () => {
  await composeUpDeps();
  await waitForMinio();

  const tenantId = "tenant_default";
  const opsToken = "tok";
  const destinationId = "receiver_v1";
  const secret = "receiversecret";

  const apiPort = await pickPort();
  const receiverPort = await pickPort();
  const schema = `e2e_receiver_retry_${String(Math.random()).slice(2, 10)}`;
  const dedupePath = `.tmp/receiver_${schema}.jsonl`;
  await fs.mkdir(".tmp", { recursive: true });

  const apiProc = startNodeProcess({
    name: "api",
    cmd: "node",
    args: ["src/api/server.js"],
    env: {
      NODE_ENV: "test",
      PORT: String(apiPort),
      STORE: "pg",
      DATABASE_URL: "postgres://proxy:proxy@127.0.0.1:5432/proxy",
      PROXY_PG_SCHEMA: schema,
      PROXY_MIGRATE_ON_STARTUP: "1",
      PROXY_OPS_TOKENS: `${opsToken}:ops_read,ops_write,finance_read,finance_write,audit_read`,
      PROXY_AUTOTICK: "1",
      PROXY_AUTOTICK_INTERVAL_MS: "100",
      PROXY_AUTOTICK_MAX_MESSAGES: "200",
      PROXY_DELIVERY_HTTP_TIMEOUT_MS: "200",
      PROXY_EXPORT_DESTINATIONS: JSON.stringify({
        [tenantId]: [{ destinationId, kind: "webhook", url: `http://127.0.0.1:${receiverPort}/deliveries/settld`, secret }]
      })
    }
  });

  const receiverProc = startNodeProcess({
    name: "receiver",
    cmd: "node",
    args: ["services/receiver/src/server.js"],
    env: {
      NODE_ENV: "test",
      RECEIVER_PORT: String(receiverPort),
      RECEIVER_TENANT_ID: tenantId,
      RECEIVER_DESTINATION_ID: destinationId,
      RECEIVER_ACK_URL: `http://127.0.0.1:${apiPort}/exports/ack`,
      RECEIVER_ALLOW_INLINE_SECRETS: "1",
      RECEIVER_HMAC_SECRET: secret,
      RECEIVER_S3_ENDPOINT: "http://127.0.0.1:9000",
      RECEIVER_S3_REGION: "us-east-1",
      RECEIVER_S3_BUCKET: "proxy-artifacts",
      RECEIVER_S3_PREFIX: "settld/",
      RECEIVER_S3_FORCE_PATH_STYLE: "1",
      RECEIVER_S3_ACCESS_KEY_ID: "proxy",
      RECEIVER_S3_SECRET_ACCESS_KEY: "proxysecret",
      RECEIVER_DEDUPE_DB_PATH: dedupePath,
      RECEIVER_TEST_DELAY_FIRST_RESPONSE_MS: "1000"
    }
  });

  const apiBase = `http://127.0.0.1:${apiPort}`;
  await waitFor(async () => (await fetch(`${apiBase}/health`).catch(() => null))?.status === 200);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${receiverPort}/ready`).catch(() => null))?.status === 200);

  const auth = await createApiKey({ apiBase, tenantId, opsToken });
  await runJobLifecycle({ apiBase, authHeader: auth.bearer, tenantId });

  await waitFor(async () => {
    const r = await httpJson({
      baseUrl: apiBase,
      method: "GET",
      path: "/ops/deliveries?state=delivered&limit=50",
      headers: { "x-proxy-tenant-id": tenantId, "x-proxy-ops-token": opsToken }
    });
    if (r.status !== 200) return null;
    const list = r.json?.deliveries ?? [];
    if (list.length !== 1) return null;
    if (!list[0].ackedAt) return null;
    return true;
  });

  const logRaw = await fs.readFile(dedupePath, "utf8");
  const storedEvents = logRaw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "STORED");
  assert.equal(storedEvents.length, 1);

  await stopProc(receiverProc);
  await stopProc(apiProc);
  await composeDownDeps();
});

test("receiver e2e: tamper -> 422 -> no store, no ACK", { skip: !RUN }, async () => {
  await composeUpDeps();
  await waitForMinio();

  const tenantId = "tenant_default";
  const opsToken = "tok";
  const destinationId = "receiver_v1";
  const secret = "receiversecret";

  const apiPort = await pickPort();
  const receiverPort = await pickPort();
  const schema = `e2e_receiver_tamper_${String(Math.random()).slice(2, 10)}`;
  const dedupePath = `.tmp/receiver_${schema}.jsonl`;
  await fs.mkdir(".tmp", { recursive: true });

  const apiProc = startNodeProcess({
    name: "api",
    cmd: "node",
    args: ["src/api/server.js"],
    env: {
      NODE_ENV: "test",
      PORT: String(apiPort),
      STORE: "pg",
      DATABASE_URL: "postgres://proxy:proxy@127.0.0.1:5432/proxy",
      PROXY_PG_SCHEMA: schema,
      PROXY_MIGRATE_ON_STARTUP: "1",
      PROXY_OPS_TOKENS: `${opsToken}:ops_read,ops_write,finance_read,finance_write,audit_read`,
      PROXY_AUTOTICK: "1",
      PROXY_AUTOTICK_INTERVAL_MS: "100",
      PROXY_AUTOTICK_MAX_MESSAGES: "200",
      PROXY_EXPORT_DESTINATIONS: JSON.stringify({
        [tenantId]: [{ destinationId, kind: "webhook", url: `http://127.0.0.1:${receiverPort}/deliveries/settld`, secret }]
      })
    }
  });

  const receiverProc = startNodeProcess({
    name: "receiver",
    cmd: "node",
    args: ["services/receiver/src/server.js"],
    env: {
      NODE_ENV: "test",
      RECEIVER_PORT: String(receiverPort),
      RECEIVER_TENANT_ID: tenantId,
      RECEIVER_DESTINATION_ID: destinationId,
      RECEIVER_ACK_URL: `http://127.0.0.1:${apiPort}/exports/ack`,
      RECEIVER_ALLOW_INLINE_SECRETS: "1",
      RECEIVER_HMAC_SECRET: secret,
      RECEIVER_S3_ENDPOINT: "http://127.0.0.1:9000",
      RECEIVER_S3_REGION: "us-east-1",
      RECEIVER_S3_BUCKET: "proxy-artifacts",
      RECEIVER_S3_PREFIX: "settld/",
      RECEIVER_S3_FORCE_PATH_STYLE: "1",
      RECEIVER_S3_ACCESS_KEY_ID: "proxy",
      RECEIVER_S3_SECRET_ACCESS_KEY: "proxysecret",
      RECEIVER_DEDUPE_DB_PATH: dedupePath
    }
  });

  const apiBase = `http://127.0.0.1:${apiPort}`;
  await waitFor(async () => (await fetch(`${apiBase}/health`).catch(() => null))?.status === 200);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${receiverPort}/ready`).catch(() => null))?.status === 200);

  const auth = await createApiKey({ apiBase, tenantId, opsToken });
  await runJobLifecycle({ apiBase, authHeader: auth.bearer, tenantId });

  const delivery = await waitFor(async () => {
    const r = await httpJson({
      baseUrl: apiBase,
      method: "GET",
      path: "/ops/deliveries?state=delivered&limit=50",
      headers: { "x-proxy-tenant-id": tenantId, "x-proxy-ops-token": opsToken }
    });
    const list = r.json?.deliveries ?? [];
    if (list.length !== 1) return null;
    if (!list[0].artifactHash) return null;
    if (!list[0].artifactType) return null;
    return list[0];
  });

  const tamperedHash = "a".repeat(64);
  const artifactKey = `settld/artifacts/${delivery.artifactType}/${delivery.artifactHash}.json`;
  const stored = await getStoredArtifactFromMinio({ key: artifactKey, accessKeyId: "proxy", secretAccessKey: "proxysecret" });
  assert.equal(stored.status, 200);
  const tampered = { ...stored.json, artifactHash: tamperedHash };

  const dedupeKey = `tamper_${Date.now()}`;
  const ts = new Date().toISOString();
  const sig = hmacSignArtifact({ secret, timestamp: ts, bodyJson: tampered });

  const res = await httpJson({
    baseUrl: `http://127.0.0.1:${receiverPort}`,
    method: "POST",
    path: "/deliveries/settld",
    headers: {
      "x-proxy-dedupe-key": dedupeKey,
      "x-proxy-delivery-id": "999999",
      "x-proxy-artifact-type": delivery.artifactType,
      "x-proxy-timestamp": ts,
      "x-proxy-signature": sig
    },
    body: tampered
  });
  assert.equal(res.status, 422);

  const key = `settld/artifacts/${delivery.artifactType}/${tamperedHash}.json`;
  const head = await headMinioObject({ key, accessKeyId: "proxy", secretAccessKey: "proxysecret" });
  assert.equal(head.status, 404);

  await stopProc(receiverProc);
  await stopProc(apiProc);
  await composeDownDeps();
});

test("receiver e2e: ACK outage -> store succeeds -> ACK retries until success", { skip: !RUN }, async () => {
  await composeUpDeps();
  await waitForMinio();

  const tenantId = "tenant_default";
  const opsToken = "tok";
  const destinationId = "receiver_v1";
  const secret = "receiversecret";

  const apiPort = await pickPort();
  const receiverPort = await pickPort();
  const schema = `e2e_receiver_ack_${String(Math.random()).slice(2, 10)}`;
  const dedupePath = `.tmp/receiver_${schema}.jsonl`;
  await fs.mkdir(".tmp", { recursive: true });

  const commonApiEnv = {
    NODE_ENV: "test",
    PORT: String(apiPort),
    STORE: "pg",
    DATABASE_URL: "postgres://proxy:proxy@127.0.0.1:5432/proxy",
    PROXY_PG_SCHEMA: schema,
    PROXY_MIGRATE_ON_STARTUP: "1",
    PROXY_OPS_TOKENS: `${opsToken}:ops_read,ops_write,finance_read,finance_write,audit_read`,
    PROXY_AUTOTICK: "1",
    PROXY_AUTOTICK_INTERVAL_MS: "100",
    PROXY_AUTOTICK_MAX_MESSAGES: "200",
    PROXY_EXPORT_DESTINATIONS: JSON.stringify({
      [tenantId]: [{ destinationId, kind: "webhook", url: `http://127.0.0.1:${receiverPort}/deliveries/settld`, secret }]
    })
  };

  let apiProc = startNodeProcess({ name: "api", cmd: "node", args: ["src/api/server.js"], env: commonApiEnv });
  const receiverProc = startNodeProcess({
    name: "receiver",
    cmd: "node",
    args: ["services/receiver/src/server.js"],
    env: {
      NODE_ENV: "test",
      RECEIVER_PORT: String(receiverPort),
      RECEIVER_TENANT_ID: tenantId,
      RECEIVER_DESTINATION_ID: destinationId,
      RECEIVER_ACK_URL: `http://127.0.0.1:${apiPort}/exports/ack`,
      RECEIVER_ALLOW_INLINE_SECRETS: "1",
      RECEIVER_HMAC_SECRET: secret,
      RECEIVER_S3_ENDPOINT: "http://127.0.0.1:9000",
      RECEIVER_S3_REGION: "us-east-1",
      RECEIVER_S3_BUCKET: "proxy-artifacts",
      RECEIVER_S3_PREFIX: "settld/",
      RECEIVER_S3_FORCE_PATH_STYLE: "1",
      RECEIVER_S3_ACCESS_KEY_ID: "proxy",
      RECEIVER_S3_SECRET_ACCESS_KEY: "proxysecret",
      RECEIVER_DEDUPE_DB_PATH: dedupePath,
      RECEIVER_TEST_ACK_INITIAL_DELAY_MS: "3000"
    }
  });

  const apiBase = `http://127.0.0.1:${apiPort}`;
  await waitFor(async () => (await fetch(`${apiBase}/health`).catch(() => null))?.status === 200);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${receiverPort}/ready`).catch(() => null))?.status === 200);

  const auth = await createApiKey({ apiBase, tenantId, opsToken });
  await runJobLifecycle({ apiBase, authHeader: auth.bearer, tenantId });

  // Wait until Settld marks it delivered (receiver already stored).
  await waitFor(async () => {
    const r = await httpJson({
      baseUrl: apiBase,
      method: "GET",
      path: "/ops/deliveries?state=delivered&limit=50",
      headers: { "x-proxy-tenant-id": tenantId, "x-proxy-ops-token": opsToken }
    });
    const list = r.json?.deliveries ?? [];
    if (list.length !== 1) return null;
    if (!list[0].deliveredAt) return null;
    if (list[0].ackedAt) return null;
    return true;
  });

  // Kill Settld before ACK worker starts; ACK will fail then retry.
  await stopProc(apiProc);
  await sleep(4000);

  apiProc = startNodeProcess({ name: "api", cmd: "node", args: ["src/api/server.js"], env: commonApiEnv });
  await waitFor(async () => (await fetch(`${apiBase}/health`).catch(() => null))?.status === 200);

  // Eventually ACK succeeds.
  await waitFor(async () => {
    const r = await httpJson({
      baseUrl: apiBase,
      method: "GET",
      path: "/ops/deliveries?state=delivered&limit=50",
      headers: { "x-proxy-tenant-id": tenantId, "x-proxy-ops-token": opsToken }
    });
    const list = r.json?.deliveries ?? [];
    if (list.length !== 1) return null;
    if (!list[0].ackedAt) return null;
    return true;
  }, { timeoutMs: 60_000, intervalMs: 500 });

  await stopProc(receiverProc);
  await stopProc(apiProc);
  await composeDownDeps();
});
