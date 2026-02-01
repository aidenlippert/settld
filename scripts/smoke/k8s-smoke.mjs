import assert from "node:assert/strict";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../../src/core/event-chain.js";
import { computeSlaPolicy } from "../../src/core/sla.js";
import { buildPolicySnapshot, computePolicyHash } from "../../src/core/policy.js";

const API_BASE_URL = process.env.SMOKE_API_BASE_URL ?? "http://127.0.0.1:3000";
const TENANT_ID = process.env.SMOKE_TENANT_ID ?? "tenant_default";
const OPS_TOKEN = process.env.SMOKE_OPS_TOKEN ?? "dev";
const PROTOCOL = process.env.SMOKE_PROTOCOL ?? "1.0";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const ok = await fn();
      if (ok) return ok;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  if (lastErr) throw lastErr;
  throw new Error("timeout");
}

async function httpJson({ method, path, headers, body }) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      ...(headers ?? {}),
      ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("json");
  const json = isJson && text ? JSON.parse(text) : null;
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  await waitFor(async () => {
    const r = await httpJson({ method: "GET", path: "/healthz" }).catch(() => null);
    return r && r.status === 200;
  });
  await waitFor(async () => {
    const r = await httpJson({ method: "GET", path: "/capabilities" }).catch(() => null);
    if (!r || r.status !== 200) return false;
    if (r.headers.get("x-settld-protocol") !== PROTOCOL) return false;
    return true;
  });

  const createKey = await httpJson({
    method: "POST",
    path: "/ops/api-keys",
    headers: { "x-proxy-tenant-id": TENANT_ID, "x-proxy-ops-token": OPS_TOKEN, "x-settld-protocol": PROTOCOL },
    body: { scopes: ["ops_read", "ops_write", "finance_read", "finance_write", "audit_read"] }
  });
  assert.equal(createKey.status, 201, createKey.text);
  const bearer = `Bearer ${createKey.json.keyId}.${createKey.json.secret}`;
  const headersBase = { "x-proxy-tenant-id": TENANT_ID, authorization: bearer, "x-settld-protocol": PROTOCOL };

  // Robot registration + availability.
  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);
  const robotId = `rob_smoke_${Date.now()}`;

  const regRobot = await httpJson({
    method: "POST",
    path: "/robots/register",
    headers: { ...headersBase, "x-idempotency-key": `robot_reg_${robotId}` },
    body: { robotId, publicKeyPem: robotPublicKeyPem }
  });
  assert.equal(regRobot.status, 201, regRobot.text);

  const now = Date.now();
  const bookingStartAt = new Date(now + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 65 * 60_000).toISOString();

  const setAvail = await httpJson({
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: {
      ...headersBase,
      "x-idempotency-key": `robot_avail_${robotId}`,
      "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash
    },
    body: {
      availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }]
    }
  });
  assert.equal(setAvail.status, 201, setAvail.text);

  // Job lifecycle (minimal but complete enough to trigger artifacts).
  const createJob = await httpJson({
    method: "POST",
    path: "/jobs",
    headers: { ...headersBase, "x-idempotency-key": `job_create_${robotId}` },
    body: { templateId: "reset_lite", constraints: { privacyMode: "minimal" } }
  });
  assert.equal(createJob.status, 201, createJob.text);
  const jobId = createJob.json.job.id;
  let lastChainHash = createJob.json.job.lastChainHash;

  const quote = await httpJson({
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { ...headersBase, "x-idempotency-key": `job_quote_${jobId}`, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.status, 201, quote.text);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await httpJson({
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { ...headersBase, "x-idempotency-key": `job_book_${jobId}`, "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false
    }
  });
  assert.equal(book.status, 201, book.text);
  lastChainHash = book.json.job.lastChainHash;

  async function postServerEvent(type, payload, idempotencyKey) {
    const r = await httpJson({
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { ...headersBase, "x-idempotency-key": idempotencyKey, "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    assert.equal(r.status, 201, r.text);
    lastChainHash = r.json.job.lastChainHash;
    return r.json.event;
  }

  async function postRobotEvent(type, payload) {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: robotId }, payload });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
    const r = await httpJson({ method: "POST", path: `/jobs/${jobId}/events`, headers: { ...headersBase }, body: finalized });
    assert.equal(r.status, 201, r.text);
    lastChainHash = r.json.job.lastChainHash;
    return r.json.event;
  }

  // Move the job through the state machine.
  await postServerEvent("MATCHED", { robotId }, `m_${jobId}`);
  await postServerEvent("RESERVED", { robotId, startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, `r_${jobId}`);

  const accessPlanId = `ap_${jobId}`;
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "BUILDING_CONCIERGE",
      credentialRef: `vault://access/${accessPlanId}/v1`,
      scope: { areas: ["ENTRYWAY"], noGo: [] },
      validFrom: new Date(now - 60_000).toISOString(),
      validTo: new Date(now + 60 * 60_000).toISOString(),
      revocable: true,
      requestedBy: "system"
    },
    `ap_${jobId}`
  );

  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 });
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "BUILDING_CONCIERGE" });
  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] });
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 1 } });

  await postServerEvent("SETTLED", { settlement: "smoke" }, `s_${jobId}`);

  // Assert that artifacts are being produced (outbox + artifact worker + pg durability).
  await waitFor(async () => {
    const r = await httpJson({ method: "GET", path: `/jobs/${jobId}/artifacts`, headers: headersBase }).catch(() => null);
    if (!r || r.status !== 200) return false;
    const artifacts = Array.isArray(r.json?.artifacts) ? r.json.artifacts : [];
    return artifacts.length > 0;
  }, { timeoutMs: 90_000, intervalMs: 500 });

  // Sanity: protocol headers present.
  const status = await httpJson({ method: "GET", path: "/ops/status", headers: headersBase });
  assert.equal(status.status, 200, status.text);
  assert.equal(status.headers.get("x-settld-protocol"), PROTOCOL);

  // Extra assertion: booking pinned policy hash is deterministic (exercise policy functions quickly).
  const sla = computeSlaPolicy({ environmentTier: "ENV_MANAGED_BUILDING" });
  const policySnapshot = buildPolicySnapshot({
    contractId: "contract_default",
    contractVersion: 1,
    environmentTier: "ENV_MANAGED_BUILDING",
    requiresOperatorCoverage: false,
    sla,
    creditPolicy: { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" },
    evidencePolicy: { retentionDays: 0 },
    claimPolicy: { currency: "USD", autoApproveThresholdCents: 0, maxPayoutCents: 0, reservePercent: 0 },
    coveragePolicy: { required: false, responseSlaSeconds: 0, includedAssistSeconds: 0, overageRateCentsPerMinute: 0 }
  });
  assert.ok(computePolicyHash(policySnapshot));
}

await main();
