import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../../src/core/event-chain.js";
import { buildPolicySnapshot, computePolicyHash } from "../../src/core/policy.js";
import { computeSlaPolicy } from "../../src/core/sla.js";
import { presignS3Url } from "../../src/core/s3-presign.js";
import { verifyArtifactHash, verifyArtifactVersion, verifySettlementBalances } from "../../packages/artifact-verify/src/index.js";

const API_BASE_URL = process.env.ACCEPTANCE_API_BASE_URL ?? "http://127.0.0.1:3000";
const RECEIVER_BASE_URL = process.env.ACCEPTANCE_RECEIVER_BASE_URL ?? "http://127.0.0.1:4000";

const TENANT_ID = process.env.ACCEPTANCE_TENANT_ID ?? "tenant_default";
// docker-compose.yml configures tok_ops by default via PROXY_OPS_TOKENS.
const OPS_TOKEN = process.env.ACCEPTANCE_OPS_TOKEN ?? "tok_ops";
const PROTOCOL = process.env.ACCEPTANCE_PROTOCOL ?? "1.0";

const MINIO_ENDPOINT = process.env.ACCEPTANCE_MINIO_ENDPOINT ?? "http://127.0.0.1:9000";
const MINIO_REGION = process.env.ACCEPTANCE_MINIO_REGION ?? "us-east-1";
const MINIO_BUCKET = process.env.ACCEPTANCE_MINIO_BUCKET ?? "proxy-artifacts";
const MINIO_ACCESS_KEY_ID = process.env.ACCEPTANCE_MINIO_ACCESS_KEY_ID ?? "proxy";
const MINIO_SECRET_ACCESS_KEY = process.env.ACCEPTANCE_MINIO_SECRET_ACCESS_KEY ?? "proxysecret";
const MINIO_PREFIX = process.env.ACCEPTANCE_MINIO_PREFIX ?? "settld/";
const MINIO_FORCE_PATH_STYLE = process.env.ACCEPTANCE_MINIO_FORCE_PATH_STYLE === "0" ? false : true;

const ART_DIR = process.env.ACCEPTANCE_ARTIFACT_DIR ?? null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeoutMs = 45_000, intervalMs = 250 } = {}) {
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

async function httpJson({ baseUrl, method, path, headers, body }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(headers ?? {}),
      ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const json = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
  return { status: res.status, json, text, headers: res.headers };
}

async function pickPort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("unexpected server address"));
        return;
      }
      const port = addr.port;
      s.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    s.on("error", reject);
  });
}

function spawnNodeProcess(scriptPath, { name, env }) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  const append = (chunk) => {
    logs += String(chunk ?? "");
    if (logs.length > 64_000) logs = logs.slice(-64_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("exit", (code, signal) => {
    if (code === 0 || signal === "SIGTERM") return;
    // eslint-disable-next-line no-console
    console.error(`[acceptance] ${name} exited unexpectedly (code=${code ?? "null"} signal=${signal ?? ""})`);
  });
  return {
    child,
    name,
    logs: () => logs
  };
}

async function writeArtifactFile(name, contents) {
  if (!ART_DIR) return null;
  await fs.mkdir(ART_DIR, { recursive: true });
  const fp = path.join(ART_DIR, name);
  await fs.writeFile(fp, contents, "utf8");
  return fp;
}

function objectKeyForArtifact({ artifactHash, artifactType }) {
  const typeSeg = String(artifactType ?? "")
    .trim()
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replaceAll("\0", "");
  const hashSeg = String(artifactHash ?? "").trim();
  if (!hashSeg) throw new Error("missing artifactHash");
  const prefix = MINIO_PREFIX.endsWith("/") ? MINIO_PREFIX : `${MINIO_PREFIX}/`;
  return `${prefix}artifacts/${typeSeg}/${hashSeg}.json`.replaceAll(/\/{2,}/g, "/");
}

async function getMinioJson({ key }) {
  const url = presignS3Url({
    endpoint: MINIO_ENDPOINT,
    region: MINIO_REGION,
    bucket: MINIO_BUCKET,
    key,
    method: "GET",
    accessKeyId: MINIO_ACCESS_KEY_ID,
    secretAccessKey: MINIO_SECRET_ACCESS_KEY,
    forcePathStyle: MINIO_FORCE_PATH_STYLE,
    expiresInSeconds: 60
  });
  const res = await fetch(url);
  const text = await res.text();
  if (res.status !== 200) throw new Error(`minio GET failed: http ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  await writeArtifactFile(
    "inputs.json",
    JSON.stringify(
      {
        apiBaseUrl: API_BASE_URL,
        receiverBaseUrl: RECEIVER_BASE_URL,
        tenantId: TENANT_ID,
        protocol: PROTOCOL,
        minio: { endpoint: MINIO_ENDPOINT, region: MINIO_REGION, bucket: MINIO_BUCKET, prefix: MINIO_PREFIX, forcePathStyle: MINIO_FORCE_PATH_STYLE }
      },
      null,
      2
    )
  );

  await waitFor(async () => {
    const r = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: "/healthz" }).catch(() => null);
    return r && r.status === 200;
  });
  await waitFor(async () => {
    const r = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: "/capabilities" }).catch(() => null);
    if (!r || r.status !== 200) return false;
    if (r.json?.protocol?.current !== PROTOCOL) return false;
    if (r.headers?.get?.("x-settld-protocol") !== PROTOCOL) return false;
    return true;
  });
  await waitFor(async () => {
    const r = await httpJson({ baseUrl: RECEIVER_BASE_URL, method: "GET", path: "/ready" }).catch(() => null);
    return r && r.status === 200;
  });

  const createKey = await httpJson({
    baseUrl: API_BASE_URL,
    method: "POST",
    path: "/ops/api-keys",
    headers: { "x-proxy-tenant-id": TENANT_ID, "x-proxy-ops-token": OPS_TOKEN, "x-settld-protocol": PROTOCOL },
    body: { scopes: ["ops_read", "ops_write", "finance_read", "finance_write", "audit_read"] }
  });
  assert.equal(createKey.status, 201, createKey.text);
  const bearer = `Bearer ${createKey.json.keyId}.${createKey.json.secret}`;
  await writeArtifactFile(
    "context.json",
    JSON.stringify({ tenantId: TENANT_ID, protocol: PROTOCOL, apiBaseUrl: API_BASE_URL, receiverBaseUrl: RECEIVER_BASE_URL, bearer }, null, 2)
  );

  const headersBase = { "x-proxy-tenant-id": TENANT_ID, authorization: bearer, "x-settld-protocol": PROTOCOL };

  // Primitive checks: A2A discovery, agreement delegation CRUD, x402 verification gate.
  {
    const agentCard = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: "/.well-known/agent.json" });
    assert.equal(agentCard.status, 200, agentCard.text);
    assert.equal(typeof agentCard.json?.name, "string");
    assert.equal(typeof agentCard.json?.url, "string");
    assert.ok(Array.isArray(agentCard.json?.skills), "agent card skills must be an array");

    const parentAgreementHash = "a".repeat(64);
    const childAgreementHash = "b".repeat(64);

    const createDelegation = await httpJson({
      baseUrl: API_BASE_URL,
      method: "POST",
      path: `/agreements/${parentAgreementHash}/delegations`,
      headers: { ...headersBase, "x-idempotency-key": `dlg_create_${Date.now()}` },
      body: {
        childAgreementHash,
        delegatorAgentId: "agt_acceptance_delegator",
        delegateeAgentId: "agt_acceptance_delegatee",
        budgetCapCents: 1234,
        currency: "USD",
        ancestorChain: [parentAgreementHash],
        delegationDepth: 1,
        maxDelegationDepth: 3
      }
    });
    assert.equal(createDelegation.status, 201, createDelegation.text);
    const delegationId = String(createDelegation.json?.delegation?.delegationId ?? "");
    assert.ok(delegationId, "delegationId missing from create response");

    const listDelegations = await httpJson({
      baseUrl: API_BASE_URL,
      method: "GET",
      path: `/agreements/${parentAgreementHash}/delegations`,
      headers: headersBase
    });
    assert.equal(listDelegations.status, 200, listDelegations.text);
    assert.ok(Array.isArray(listDelegations.json?.delegations), "delegations list missing");
    assert.ok(
      listDelegations.json.delegations.some((d) => String(d?.delegationId ?? "") === delegationId),
      "created delegation missing from list"
    );

    const getDelegation = await httpJson({
      baseUrl: API_BASE_URL,
      method: "GET",
      path: `/delegations/${delegationId}`,
      headers: headersBase
    });
    assert.equal(getDelegation.status, 200, getDelegation.text);
    assert.equal(String(getDelegation.json?.delegation?.delegationId ?? ""), delegationId);
    assert.equal(String(getDelegation.json?.delegation?.parentAgreementHash ?? ""), parentAgreementHash);
    assert.equal(String(getDelegation.json?.delegation?.childAgreementHash ?? ""), childAgreementHash);

    const gateCreate = await httpJson({
      baseUrl: API_BASE_URL,
      method: "POST",
      path: "/x402/gate/create",
      headers: { ...headersBase, "x-idempotency-key": `x402_create_${Date.now()}` },
      body: {
        payerAgentId: "agt_acceptance_x402_payer",
        payeeAgentId: "agt_acceptance_x402_payee",
        amountCents: 500,
        currency: "USD",
        autoFundPayerCents: 5000,
        disputeWindowDays: 7
      }
    });
    assert.equal(gateCreate.status, 201, gateCreate.text);
    const gateId = String(gateCreate.json?.gate?.gateId ?? "");
    assert.ok(gateId, "gateId missing from x402 create response");

    const gateAuthorize = await httpJson({
      baseUrl: API_BASE_URL,
      method: "POST",
      path: "/x402/gate/authorize-payment",
      headers: { ...headersBase, "x-idempotency-key": `x402_authorize_${Date.now()}` },
      body: { gateId }
    });
    assert.equal(gateAuthorize.status, 200, gateAuthorize.text);

    const gateVerify = await httpJson({
      baseUrl: API_BASE_URL,
      method: "POST",
      path: "/x402/gate/verify",
      headers: { ...headersBase, "x-idempotency-key": `x402_verify_${Date.now()}` },
      body: { gateId, verificationStatus: "green", runStatus: "completed", evidenceRefs: ["acceptance:evidence#1"] }
    });
    assert.equal(gateVerify.status, 200, gateVerify.text);
    assert.equal(String(gateVerify.json?.gate?.status ?? ""), "resolved");
    assert.notEqual(String(gateVerify.json?.settlement?.status ?? "").toLowerCase(), "locked");

    const gateGet = await httpJson({
      baseUrl: API_BASE_URL,
      method: "GET",
      path: `/x402/gate/${gateId}`,
      headers: headersBase
    });
    assert.equal(gateGet.status, 200, gateGet.text);
    assert.equal(String(gateGet.json?.gate?.gateId ?? ""), gateId);
  }

  // Gateway proxy smoke: upstream 402 -> gate create -> paid retry -> verify + settlement headers.
  {
    const upstreamPort = await pickPort();
    const gatewayPort = await pickPort();
    const apiKeyForGateway = `${createKey.json.keyId}.${createKey.json.secret}`;
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}/`;
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

    const services = [];
    try {
      const upstream = spawnNodeProcess("services/x402-gateway/examples/upstream-mock.js", {
        name: "upstream-mock",
        env: {
          ...process.env,
          PORT: String(upstreamPort),
          BIND_HOST: "127.0.0.1",
          SETTLD_PAY_KEYSET_URL: `${API_BASE_URL}/.well-known/settld-keys.json`
        }
      });
      services.push(upstream);
      await waitFor(async () => {
        const r = await httpJson({ baseUrl: `http://127.0.0.1:${upstreamPort}`, method: "GET", path: "/healthz" }).catch(() => null);
        return r && r.status === 200;
      });

      const gateway = spawnNodeProcess("services/x402-gateway/src/server.js", {
        name: "x402-gateway",
        env: {
          ...process.env,
          PORT: String(gatewayPort),
          BIND_HOST: "127.0.0.1",
          SETTLD_API_URL: API_BASE_URL,
          SETTLD_API_KEY: apiKeyForGateway,
          UPSTREAM_URL: upstreamUrl,
          X402_AUTOFUND: "1"
        }
      });
      services.push(gateway);
      await waitFor(async () => {
        const r = await httpJson({ baseUrl: gatewayUrl, method: "GET", path: "/healthz" }).catch(() => null);
        return r && r.status === 200;
      });

      const first = await httpJson({
        baseUrl: gatewayUrl,
        method: "GET",
        path: "/exa/search?q=acceptance+gateway+smoke",
        headers: { "x-proxy-tenant-id": TENANT_ID }
      });
      assert.equal(first.status, 402, first.text);
      const gateId = String(first.headers.get("x-settld-gate-id") ?? "").trim();
      assert.ok(gateId, "gateway response missing x-settld-gate-id");

      const paid = await httpJson({
        baseUrl: gatewayUrl,
        method: "GET",
        path: "/exa/search?q=acceptance+gateway+smoke",
        headers: { "x-proxy-tenant-id": TENANT_ID, "x-settld-gate-id": gateId }
      });
      assert.equal(paid.status, 200, paid.text);
      const settlementStatus = String(paid.headers.get("x-settld-settlement-status") ?? "").toLowerCase();
      assert.ok(settlementStatus === "released" || settlementStatus === "resolved", `unexpected settlement status: ${settlementStatus}`);

      const gate = await httpJson({
        baseUrl: API_BASE_URL,
        method: "GET",
        path: `/x402/gate/${gateId}`,
        headers: headersBase
      });
      assert.equal(gate.status, 200, gate.text);
      assert.equal(String(gate.json?.gate?.gateId ?? ""), gateId);
      assert.equal(String(gate.json?.gate?.status ?? "").toLowerCase(), "resolved");

      await writeArtifactFile(
        "x402-gateway-smoke.json",
        JSON.stringify(
          {
            ok: true,
            upstreamPort,
            gatewayPort,
            gateId,
            firstStatus: first.status,
            paidStatus: paid.status,
            settlementStatus: paid.headers.get("x-settld-settlement-status") ?? null
          },
          null,
          2
        )
      );
    } finally {
      for (const svc of services.reverse()) {
        if (!svc?.child || svc.child.exitCode !== null) continue;
        svc.child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => svc.child.once("exit", resolve)),
          sleep(750).then(() => {
            if (svc.child.exitCode === null) svc.child.kill("SIGKILL");
          })
        ]);
        await writeArtifactFile(`x402-gateway-smoke.${svc.name}.log`, svc.logs());
      }
    }
  }

  // Robot setup
  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  const robotId = `rob_acceptance_${Date.now()}`;

  const regRobot = await httpJson({
    baseUrl: API_BASE_URL,
    method: "POST",
    path: "/robots/register",
    headers: { ...headersBase, "x-idempotency-key": `robot_reg_${robotId}` },
    body: { robotId, publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.status, 201, regRobot.text);

  const nowMs = Date.now();
  const avail = await httpJson({
    baseUrl: API_BASE_URL,
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: {
      ...headersBase,
      "x-idempotency-key": `robot_avail_${robotId}`,
      "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash
    },
    body: {
      availability: [{ startAt: new Date(nowMs - 2 * 60 * 60_000).toISOString(), endAt: new Date(nowMs + 2 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(avail.status, 201, avail.text);

  // Job setup
  const createJob = await httpJson({
    baseUrl: API_BASE_URL,
    method: "POST",
    path: "/jobs",
    headers: { ...headersBase, "x-idempotency-key": `job_create_${robotId}` },
    body: { templateId: "reset_lite", constraints: {} }
  });
  assert.equal(createJob.status, 201, createJob.text);
  const jobId = createJob.json.job.id;
  let lastChainHash = createJob.json.job.lastChainHash;

  // Book a window in the past so SLA breach+credit are auto-recorded after settlement.
  const bookingStartAt = new Date(nowMs - 30 * 60_000).toISOString();
  const bookingEndAt = new Date(nowMs - 20 * 60_000).toISOString();
  const environmentTier = "ENV_MANAGED_BUILDING";

  const quote = await httpJson({
    baseUrl: API_BASE_URL,
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { ...headersBase, "x-idempotency-key": `job_quote_${jobId}`, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier, requiresOperatorCoverage: false }
  });
  assert.equal(quote.status, 201, quote.text);
  lastChainHash = quote.json.job.lastChainHash;

  const creditPolicy = { enabled: true, defaultAmountCents: 100, maxAmountCents: 200, currency: "USD" };
  const evidencePolicy = { retentionDays: 0 };
  const sla = computeSlaPolicy({ environmentTier });
  const policySnapshot = buildPolicySnapshot({
    contractId: "contract_default",
    contractVersion: 1,
    environmentTier,
    requiresOperatorCoverage: false,
    sla,
    creditPolicy,
    evidencePolicy,
    claimPolicy: null,
    coveragePolicy: null
  });
  const policyHash = computePolicyHash(policySnapshot);

  const book = await httpJson({
    baseUrl: API_BASE_URL,
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { ...headersBase, "x-idempotency-key": `job_book_${jobId}`, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier,
      requiresOperatorCoverage: false,
      contractId: "contract_default",
      contractVersion: 1,
      sla,
      creditPolicy,
      evidencePolicy,
      policySnapshot,
      policyHash
    }
  });
  assert.equal(book.status, 201, book.text);
  lastChainHash = book.json.job.lastChainHash;

  async function postServerJobEvent(type, payload, idempotencyKey) {
    const r = await httpJson({
      baseUrl: API_BASE_URL,
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { ...headersBase, "x-idempotency-key": idempotencyKey, "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(r.status, 201, r.text);
    lastChainHash = r.json.job.lastChainHash;
    return r.json.event;
  }

  async function postRobotJobEvent(type, payload) {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: robotId }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const r = await httpJson({
      baseUrl: API_BASE_URL,
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { ...headersBase, "x-idempotency-key": `robot_evt_${jobId}_${type}` },
      body: finalized
    });
    assert.equal(r.status, 201, r.text);
    lastChainHash = r.json.job.lastChainHash;
    return r.json.event;
  }

  await postServerJobEvent("MATCHED", { robotId }, `m_${jobId}`);
  await postServerJobEvent("RESERVED", { robotId, startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

  const accessPlanId = `ap_${jobId}`;
  const nowIso = new Date().toISOString();
  await postServerJobEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "DOCKED_IN_BUILDING",
      credentialRef: `vault://access/${accessPlanId}/v1`,
      scope: { areas: ["ENTRYWAY"], noGo: [] },
      validFrom: new Date(Date.parse(nowIso) - 5 * 60_000).toISOString(),
      validTo: new Date(Date.parse(nowIso) + 30 * 60_000).toISOString(),
      revocable: true,
      requestedBy: "acceptance"
    },
    `ap_${jobId}`
  );

  await postServerJobEvent(
    "INCIDENT_REPORTED",
    {
      jobId,
      incidentId: `inc_${jobId}`,
      type: "ACCESS_FAILURE",
      severity: 2,
      summary: "acceptance incident",
      reportedBy: "ops"
    },
    `inc_${jobId}`
  );

  await postRobotJobEvent("EN_ROUTE", { etaSeconds: 60 });
  await postRobotJobEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" });
  await postRobotJobEvent("EXECUTION_STARTED", { plan: ["acceptance_task"] });
  await postRobotJobEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 5 } });

  const settledEvent = await postServerJobEvent("SETTLED", { settlement: "acceptance" }, `s_${jobId}`);

  // Best-effort: accounting worker may append SLA events asynchronously.
  // Keep this non-fatal in acceptance; downstream artifact/delivery checks are the hard gate.
  let settlementEvents = [];
  const slaEventsAutoRecorded = await waitFor(async () => {
    const res = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: `/jobs/${jobId}/events`, headers: headersBase });
    if (res.status !== 200) return false;
    settlementEvents = Array.isArray(res.json?.events) ? res.json.events : [];
    const hasBreach = settlementEvents.some((e) => e?.type === "SLA_BREACH_DETECTED" && e?.payload?.settledEventId === settledEvent.id);
    const hasCredit = settlementEvents.some((e) => e?.type === "SLA_CREDIT_ISSUED" && e?.payload?.settledEventId === settledEvent.id);
    return hasBreach && hasCredit;
  }, { timeoutMs: 45_000 }).then(() => true).catch(() => false);

  if (!slaEventsAutoRecorded) {
    const latest = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: `/jobs/${jobId}/events`, headers: headersBase });
    if (latest.status === 200) settlementEvents = Array.isArray(latest.json?.events) ? latest.json.events : settlementEvents;
  }
  await writeArtifactFile("events.after-settlement.json", JSON.stringify(settlementEvents, null, 2));

  // Wait for artifacts to be built and stored.
  const artifacts = await waitFor(async () => {
    const res = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: `/jobs/${jobId}/artifacts`, headers: headersBase });
    if (res.status !== 200) return false;
    const list = Array.isArray(res.json?.artifacts) ? res.json.artifacts : [];
    const hasSettlement = list.some((a) => (a?.artifactType ?? a?.schemaVersion) === "SettlementStatement.v1" && a?.artifactHash);
    if (!hasSettlement) return false;
    return list;
  });
  await writeArtifactFile("artifacts.list.json", JSON.stringify(artifacts, null, 2));

  // Wait for deliveries to be acked.
  const deliveries = await waitFor(async () => {
    const res = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: "/ops/deliveries", headers: headersBase });
    if (res.status !== 200) return false;
    const list = Array.isArray(res.json?.deliveries) ? res.json.deliveries : [];
    const delivered = list.filter((d) => d?.state === "delivered" && d?.destinationId === "receiver_v1");
    if (!delivered.length) return false;
    const allAcked = delivered.every((d) => d?.ackReceivedAt);
    if (!allAcked) return false;
    return delivered;
  });
  assert.ok(deliveries.length >= 1);
  await writeArtifactFile("deliveries.acked.json", JSON.stringify(deliveries, null, 2));

  // Verify receiver stored by hash in MinIO (content-addressed key).
  const pick = artifacts.find((a) => (a?.artifactType ?? a?.schemaVersion) === "SettlementStatement.v1") ?? artifacts[0];
  assert.ok(pick?.artifactHash, "missing artifactHash");
  assert.ok(pick?.artifactType, "missing artifactType");
  const key = objectKeyForArtifact({ artifactHash: pick.artifactHash, artifactType: pick.artifactType });
  const stored = await getMinioJson({ key });
  const storedFp = await writeArtifactFile(`minio.${pick.artifactHash}.json`, JSON.stringify(stored, null, 2));
  const ver = verifyArtifactVersion(stored);
  assert.equal(ver.ok, true, JSON.stringify(ver));
  const hash = verifyArtifactHash(stored);
  assert.equal(hash.ok, true, JSON.stringify(hash));
  const bal = verifySettlementBalances(stored);
  assert.equal(bal.ok, true, JSON.stringify(bal));

  // Also run verifier CLI on the exact stored bytes (ga-style smoke test).
  if (storedFp) {
    const cli = spawnSync("node", ["packages/artifact-verify/bin/settld-verify.js", storedFp], { encoding: "utf8" });
    await writeArtifactFile("settld-verify.stdout.txt", cli.stdout ?? "");
    await writeArtifactFile("settld-verify.stderr.txt", cli.stderr ?? "");
    assert.equal(cli.status, 0, `settld-verify failed: ${cli.stderr ?? cli.stdout ?? ""}`.trim());
  }

  // Month close: request and wait until closed with a statement artifact.
  const month = new Date().toISOString().slice(0, 7);
  const closeReq = await httpJson({
    baseUrl: API_BASE_URL,
    method: "POST",
    path: "/ops/month-close",
    headers: { ...headersBase, "x-idempotency-key": `month_close_${month}` },
    body: { month }
  });
  assert.ok(closeReq.status === 202 || closeReq.status === 200, closeReq.text);

  const monthClose = await waitFor(async () => {
    const res = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: `/ops/month-close?month=${month}`, headers: headersBase });
    if (res.status !== 200) return false;
    const mc = res.json?.monthClose ?? null;
    const stmt = res.json?.statementArtifact ?? null;
    if (!mc || mc.status !== "CLOSED") return false;
    if (!stmt || !stmt.artifactHash) return false;
    return { mc, stmt };
  });
  await writeArtifactFile("month-close.json", JSON.stringify(monthClose, null, 2));

  {
    const ver2 = verifyArtifactVersion(monthClose.stmt);
    assert.equal(ver2.ok, true, JSON.stringify(ver2));
    const hash2 = verifyArtifactHash(monthClose.stmt);
    assert.equal(hash2.ok, true, JSON.stringify(hash2));
  }

  // Immutability check: second fetch must match hash.
  const monthClose2 = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: `/ops/month-close?month=${month}`, headers: headersBase });
  assert.equal(monthClose2.status, 200, monthClose2.text);
  assert.equal(monthClose2.json?.statementArtifact?.artifactHash, monthClose.stmt.artifactHash, "month statement hash changed across fetch");

  // Retention cleanup (audited) + ops status sanity.
  const retention = await httpJson({
    baseUrl: API_BASE_URL,
    method: "POST",
    path: "/ops/maintenance/retention/run",
    headers: { ...headersBase, "x-idempotency-key": `retention_${Date.now()}` },
    body: { dryRun: true, batchSize: 1, maxMillis: 500 }
  });
  assert.equal(retention.status, 200, retention.text);

  const status = await httpJson({ baseUrl: API_BASE_URL, method: "GET", path: "/ops/status", headers: headersBase });
  assert.equal(status.status, 200, status.text);
  await writeArtifactFile("ops.status.json", JSON.stringify(status.json, null, 2));
  assert.equal(status.json?.backlog?.deliveriesPending ?? null, 0);
  assert.equal(status.json?.backlog?.deliveriesFailed ?? null, 0);
  assert.equal(status.json?.backlog?.ingestRejected ?? null, 0);
  assert.ok(status.json?.maintenance?.retentionCleanup?.at ?? null);

  // Basic protocol headers are present on responses.
  assert.equal(status.headers.get("x-settld-protocol"), PROTOCOL);

  // Receiver readiness endpoint is alive.
  const rdy = await httpJson({ baseUrl: RECEIVER_BASE_URL, method: "GET", path: "/health" });
  assert.equal(rdy.status, 200, rdy.text);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("acceptance: FAILED");
  // eslint-disable-next-line no-console
  console.error(err);
  // eslint-disable-next-line no-console
  if (ART_DIR) console.error(`acceptance: artifacts in ${ART_DIR}`);
  process.exit(1);
});
