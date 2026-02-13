/**
 * Seed a minimal "payout operationId" in a live tenant so we can run:
 *  - money-rails-chargeback-evidence
 *  - design-partner-run-packet
 *
 * This uses only public HTTP endpoints (no direct DB access) and creates:
 *  - a robot (with signer key)
 *  - a job that reaches SETTLED via robot-signed events
 *  - a month-close for the target period
 *  - a payout enqueue that returns a money-rail operationId (stub_default)
 *
 * Required env:
 *  - SETTLD_OPS_TOKEN
 *
 * Optional env:
 *  - SETTLD_BASE_URL (default: https://api.settld.work)
 *  - SETTLD_TENANT_ID (default: tenant_default)
 *  - SETTLD_PROTOCOL (default: 1.0)
 *  - SETTLD_PERIOD (default: current UTC YYYY-MM)
 */

import { computeSlaPolicy } from "../../src/core/sla.js";
import { buildPolicySnapshot, computePolicyHash } from "../../src/core/policy.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../../src/core/event-chain.js";

function env(name, fallback = null) {
  const v = process.env[name];
  if (v === undefined || v === null) return fallback;
  const s = String(v);
  return s.trim() === "" ? fallback : s;
}

function mustEnv(name) {
  const v = env(name, null);
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function nowIso() {
  return new Date().toISOString();
}

function utcPeriodFromNow() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function assertOk(res, msg) {
  if (!res.ok) {
    const detail = typeof res.text === "string" ? res.text : JSON.stringify(res.json ?? null);
    throw new Error(`${msg} (status=${res.status}): ${detail}`);
  }
}

async function requestJson({ baseUrl, tenantId, opsToken, protocol, method, path, headers = {}, body = undefined }) {
  const url = new URL(path, baseUrl);
  const isWrite = method !== "GET" && method !== "HEAD";

  const reqHeaders = {
    "x-proxy-tenant-id": tenantId,
    "x-proxy-ops-token": opsToken,
    ...(isWrite ? { "x-settld-protocol": protocol } : null),
    ...(body !== undefined ? { "content-type": "application/json" } : null),
    ...headers
  };

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return {
    ok: res.ok,
    status: res.status,
    text,
    json
  };
}

function buildBookedPayload({
  startAt,
  endAt,
  environmentTier,
  requiresOperatorCoverage = false,
  zoneId = "zone_a",
  customerId = "cust_p0_money_rails",
  siteId = "site_p0_money_rails",
  contractId = "contract_default",
  contractVersion = 1,
  paymentHoldId
} = {}) {
  if (!paymentHoldId) throw new TypeError("paymentHoldId is required");
  const sla = computeSlaPolicy({ environmentTier });
  const policySnapshot = buildPolicySnapshot({
    contractId,
    contractVersion,
    environmentTier,
    requiresOperatorCoverage,
    sla,
    creditPolicy: { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" },
    evidencePolicy: { retentionDays: 0 },
    claimPolicy: { currency: "USD", autoApproveThresholdCents: 0, maxPayoutCents: 0, reservePercent: 0 },
    coveragePolicy: { required: false, responseSlaSeconds: 0, includedAssistSeconds: 0, overageRateCentsPerMinute: 0 }
  });
  const policyHash = computePolicyHash(policySnapshot);

  return {
    paymentHoldId,
    startAt,
    endAt,
    environmentTier,
    requiresOperatorCoverage,
    zoneId,
    sla,
    customerId,
    siteId,
    contractId,
    contractVersion,
    creditPolicy: { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" },
    evidencePolicy: { retentionDays: 0 },
    policySnapshot,
    policyHash
  };
}

async function waitForOutboxDrain({ baseUrl, tenantId, opsToken, protocol, timeoutMs = 600_000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hz = await requestJson({ baseUrl, tenantId, opsToken, protocol, method: "GET", path: "/healthz" });
    if (hz.ok) {
      const pending = Number(hz.json?.outboxPending ?? 0);
      if (Number.isFinite(pending) && pending <= 0) return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for outbox to drain");
}

async function drainOutboxBestEffort({ baseUrl, tenantId, opsToken, protocol, timeoutMs = 600_000 } = {}) {
  // Preferred: explicit ops endpoint (works even when PROXY_AUTOTICK is disabled).
  // Fallback: wait for background workers to drain (requires PROXY_AUTOTICK=1).
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await requestJson({
      baseUrl,
      tenantId,
      opsToken,
      protocol,
      method: "POST",
      path: "/ops/maintenance/outbox/run",
      body: { maxMessages: 1000, passes: 10 }
    });

    // If the endpoint doesn't exist yet on the target baseUrl, fall back to passive waiting.
    if (!run.ok && (run.status === 404 || run.status === 501)) {
      await waitForOutboxDrain({ baseUrl, tenantId, opsToken, protocol, timeoutMs });
      return;
    }

    const hz = await requestJson({ baseUrl, tenantId, opsToken, protocol, method: "GET", path: "/healthz" });
    if (hz.ok) {
      const pending = Number(hz.json?.outboxPending ?? 0);
      if (Number.isFinite(pending) && pending <= 0) return;
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out draining outbox");
}

async function pollMonthCloseClosed({ baseUrl, tenantId, opsToken, protocol, month, timeoutMs = 600_000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const st = await requestJson({
      baseUrl,
      tenantId,
      opsToken,
      protocol,
      method: "GET",
      path: `/ops/month-close?month=${encodeURIComponent(month)}`
    });
    if (st.ok && st.json?.monthClose?.status === "CLOSED") return st.json?.monthClose ?? null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for month-close CLOSED");
}

async function main() {
  const baseUrl = env("SETTLD_BASE_URL", "https://api.settld.work");
  const tenantId = env("SETTLD_TENANT_ID", "tenant_default");
  const protocol = env("SETTLD_PROTOCOL", "1.0");
  const opsToken = mustEnv("SETTLD_OPS_TOKEN");
  const period = env("SETTLD_PERIOD", utcPeriodFromNow());
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error("SETTLD_PERIOD must match YYYY-MM");

  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(publicKeyPem);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const robotId = `rob_p0_money_${suffix}`;
  const t0 = Date.now();
  const startAt = new Date(t0 + 5 * 60_000).toISOString();
  const endAt = new Date(t0 + 65 * 60_000).toISOString();

  const regRobot = await requestJson({
    baseUrl,
    tenantId,
    opsToken,
    protocol,
    method: "POST",
    path: "/robots/register",
    headers: { "x-idempotency-key": `p0_money_rails_robot_${suffix}` },
    body: { robotId, trustScore: 0.9, homeZoneId: "zone_a", publicKeyPem: String(publicKeyPem) }
  });
  assertOk(regRobot, "robot register failed");
  let robotPrevChainHash = regRobot.json?.robot?.lastChainHash ?? null;
  if (!robotPrevChainHash) throw new Error("robot register missing lastChainHash");

  // Robot must be available for the reservation window.
  const robotAvail = await requestJson({
    baseUrl,
    tenantId,
    opsToken,
    protocol,
    method: "POST",
    path: `/robots/${encodeURIComponent(robotId)}/availability`,
    headers: {
      "x-idempotency-key": `p0_money_rails_robot_avail_${suffix}`,
      "x-proxy-expected-prev-chain-hash": robotPrevChainHash
    },
    body: { availability: [{ startAt, endAt }] }
  });
  assertOk(robotAvail, "robot availability set failed");
  robotPrevChainHash = robotAvail.json?.robot?.lastChainHash ?? robotPrevChainHash;

  const jobCreate = await requestJson({
    baseUrl,
    tenantId,
    opsToken,
    protocol,
    method: "POST",
    path: "/jobs",
    headers: { "x-idempotency-key": `p0_money_rails_job_${suffix}` },
    body: { templateId: "reset_lite", constraints: { zoneId: "zone_a" }, customerId: "cust_p0_money_rails", siteId: "site_p0_money_rails" }
  });
  assertOk(jobCreate, "job create failed");
  const jobId = jobCreate.json?.job?.id ?? null;
  let prevChainHash = jobCreate.json?.job?.lastChainHash ?? null;
  if (!jobId || !prevChainHash) throw new Error("job create missing id/lastChainHash");

  async function postServerEvent(type, payload, idemSuffix) {
    const res = await requestJson({
      baseUrl,
      tenantId,
      opsToken,
      protocol,
      method: "POST",
      path: `/jobs/${encodeURIComponent(jobId)}/events`,
      headers: {
        "x-idempotency-key": `p0_money_rails_${suffix}_${idemSuffix}`,
        "x-proxy-expected-prev-chain-hash": prevChainHash
      },
      body: { type, actor: { type: "system", id: "p0_money_rails" }, payload }
    });
    assertOk(res, `job event ${type} failed`);
    prevChainHash = res.json?.job?.lastChainHash ?? prevChainHash;
    return res;
  }

  function makeSignedJobEventBody({ type, actor, payload, at }) {
    const draft = createChainedEvent({ streamId: jobId, type, actor, payload, at });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: String(privateKeyPem) }
    });
    return finalized;
  }

  async function postSignedEvent({ type, actor, payload, at, idemSuffix }) {
    const event = makeSignedJobEventBody({ type, actor, payload, at });
    const res = await requestJson({
      baseUrl,
      tenantId,
      opsToken,
      protocol,
      method: "POST",
      path: `/jobs/${encodeURIComponent(jobId)}/events`,
      headers: { "x-idempotency-key": `p0_money_rails_${suffix}_${idemSuffix}` },
      body: event
    });
    assertOk(res, `signed job event ${type} failed`);
    prevChainHash = res.json?.job?.lastChainHash ?? prevChainHash;
    return res;
  }

  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD" }, "quote");
  await postServerEvent(
    "BOOKED",
    buildBookedPayload({
      startAt,
      endAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      paymentHoldId: `hold_p0_money_${jobId}`
    }),
    "book"
  );
  await postServerEvent("MATCHED", { robotId, operatorPartyId: "pty_operator_p0_money" }, "match");
  await postServerEvent("RESERVED", { robotId, startAt, endAt, reservationId: `res_p0_${suffix}` }, "reserve");

  const accessPlanId = `ap_${jobId}`;
  const validFrom = new Date(t0 - 60_000).toISOString();
  const validTo = new Date(t0 + 2 * 60 * 60_000).toISOString();
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "SMART_LOCK_CODE",
      credentialRef: `vault://p0_money_rails/${jobId}`,
      scope: { areas: ["lobby"], noGo: [] },
      validFrom,
      validTo,
      revocable: true,
      requestedBy: "p0_money_rails_seed"
    },
    "access_plan"
  );

  // Robot-signed events to reach COMPLETED.
  const actorRobot = { type: "robot", id: robotId };
  await postSignedEvent({ type: "EN_ROUTE", actor: actorRobot, payload: null, at: nowIso(), idemSuffix: "en_route" });
  await postSignedEvent(
    {
      type: "ACCESS_GRANTED",
      actor: actorRobot,
      payload: { jobId, accessPlanId, method: "SMART_LOCK_CODE" },
      at: nowIso(),
      idemSuffix: "access_granted"
    }
  );
  await postSignedEvent({ type: "EXECUTION_STARTED", actor: actorRobot, payload: null, at: nowIso(), idemSuffix: "exec_started" });
  await postSignedEvent({ type: "EXECUTION_COMPLETED", actor: actorRobot, payload: null, at: nowIso(), idemSuffix: "exec_completed" });

  await postServerEvent("SETTLED", { note: "p0_money_rails_seed" }, "settle");

  // Ensure ledger/outbox work has time to apply before month-close.
  await drainOutboxBestEffort({ baseUrl, tenantId, opsToken, protocol, timeoutMs: 600_000 });

  const monthCloseReq = await requestJson({
    baseUrl,
    tenantId,
    opsToken,
    protocol,
    method: "POST",
    path: "/ops/month-close",
    headers: { "x-idempotency-key": `p0_money_rails_month_close_${period}` },
    body: { month: period }
  });
  assertOk(monthCloseReq, "month close request failed");

  // Month-close runs via outbox processing.
  await drainOutboxBestEffort({ baseUrl, tenantId, opsToken, protocol, timeoutMs: 600_000 });
  await pollMonthCloseClosed({ baseUrl, tenantId, opsToken, protocol, month: period, timeoutMs: 600_000 });

  const partyStatements = await requestJson({
    baseUrl,
    tenantId,
    opsToken,
    protocol,
    method: "GET",
    path: `/ops/party-statements?period=${encodeURIComponent(period)}`
  });
  assertOk(partyStatements, "party statements list failed");

  const statements = Array.isArray(partyStatements.json?.statements) ? partyStatements.json.statements : [];
  if (!statements.length) throw new Error("no party statements found after month close");

  let payout = null;
  for (const s of statements) {
    const partyId = s?.partyId ? String(s.partyId) : "";
    if (!partyId) continue;
    // eslint-disable-next-line no-await-in-loop
    const enq = await requestJson({
      baseUrl,
      tenantId,
      opsToken,
      protocol,
      method: "POST",
      path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(period)}/enqueue`,
      headers: { "x-idempotency-key": `p0_money_rails_payout_${partyId}_${period}_${suffix}` },
      body: { moneyRailProviderId: "stub_default", counterpartyRef: `bank:acct_demo_${suffix}` }
    });
    if (enq.ok && enq.json?.moneyRailOperation?.operationId) {
      payout = { partyId, response: enq.json };
      break;
    }
  }
  if (!payout) throw new Error("failed to enqueue any payout (no party had payout due?)");

  const out = {
    baseUrl,
    tenantId,
    period,
    robotId,
    robotKeyId,
    jobId,
    moneyRail: {
      providerId: payout.response.moneyRailOperation.providerId ?? null,
      operationId: payout.response.moneyRailOperation.operationId ?? null,
      partyId: payout.partyId
    }
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

await main();
