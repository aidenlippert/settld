/**
 * Seeds a deterministic workload into Postgres using the in-process API.
 *
 * Outputs JSON with:
 *  - tenantId
 *  - jobIds
 *  - month
 */
import { createBackupRestoreApiClient } from "./client.mjs";
import { makeBookedPayload } from "../../test/api-test-harness.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const TENANT_ID = process.env.TENANT_ID ?? "tenant_default";
const MONTH = process.env.MONTH ?? "2026-01";
const JOBS = Number(process.env.JOBS ?? "10");
const SCHEMA = process.env.PROXY_PG_SCHEMA ?? "public";
const requireMonthCloseRaw = String(process.env.BACKUP_RESTORE_REQUIRE_MONTH_CLOSE ?? "").trim().toLowerCase();
const REQUIRE_MONTH_CLOSE = requireMonthCloseRaw === "" ? true : requireMonthCloseRaw === "1" || requireMonthCloseRaw === "true";

function log(message, details = null) {
  const at = new Date().toISOString();
  if (details && typeof details === "object") {
    process.stderr.write(`[seed-workload ${at}] ${message} ${JSON.stringify(details)}\n`);
    return;
  }
  process.stderr.write(`[seed-workload ${at}] ${message}\n`);
}

if (!Number.isSafeInteger(JOBS) || JOBS <= 0) throw new Error("JOBS must be a positive integer");
if (!/^\d{4}-\d{2}$/.test(MONTH)) throw new Error("MONTH must match YYYY-MM");

let nowMs = Date.parse(`${MONTH}-15T10:00:00.000Z`);
if (!Number.isFinite(nowMs)) throw new Error("invalid MONTH timestamp anchor");
const nowIso = () => new Date(nowMs).toISOString();

const { api, request, close, tenantId } = await createBackupRestoreApiClient({
  databaseUrl: DATABASE_URL,
  schema: SCHEMA,
  tenantId: TENANT_ID,
  now: nowIso
});
log("api client ready", { tenantId, schema: SCHEMA, jobs: JOBS, month: MONTH });

log("upserting finance account map");
const accountMap = await request({
  method: "PUT",
  path: "/ops/finance/account-map",
  body: {
    mapping: {
      schemaVersion: "FinanceAccountMap.v1",
      accounts: {
        acct_cash: "1000",
        acct_customer_escrow: "2100",
        acct_platform_revenue: "4000",
        acct_owner_payable: "2000",
        acct_operator_payable: "2010",
        acct_insurance_reserve: "2150",
        acct_coverage_reserve: "2160",
        acct_coverage_unearned: "2170",
        acct_coverage_revenue: "4010",
        acct_coverage_payout_expense: "5100",
        acct_insurer_receivable: "1200",
        acct_operator_chargeback_receivable: "1210",
        acct_claims_expense: "5200",
        acct_claims_payable: "2200",
        acct_operator_labor_expense: "5300",
        acct_operator_cost_accrued: "2210",
        acct_developer_royalty_payable: "2020",
        acct_sla_credits_expense: "4900",
        acct_customer_credits_payable: "2110"
      }
    }
  }
});
if (accountMap.statusCode !== 200) throw new Error(`ops finance account-map failed: ${accountMap.statusCode} ${accountMap.body}`);

log("setting month close hold policy to ALLOW_WITH_DISCLOSURE");
const govEventsRes = await request({
  method: "GET",
  path: "/ops/governance/events"
});
if (govEventsRes.statusCode !== 200) {
  throw new Error(`governance events read failed: ${govEventsRes.statusCode} ${govEventsRes.body}`);
}
const govEvents = Array.isArray(govEventsRes.json?.events) ? govEventsRes.json.events : [];
const govPrevChainHash = govEvents.length
  ? (typeof govEvents[govEvents.length - 1]?.chainHash === "string" ? govEvents[govEvents.length - 1].chainHash : null)
  : null;
const govPolicyRes = await request({
  method: "POST",
  path: "/ops/governance/events",
  headers: {
    "x-proxy-expected-prev-chain-hash": govPrevChainHash ?? "null",
    "x-idempotency-key": "backup_month_close_policy_allow_disclosure_v1"
  },
  body: {
    type: "TENANT_POLICY_UPDATED",
    scope: "tenant",
    payload: {
      effectiveFrom: `${MONTH}-01T00:00:00.000Z`,
      policy: { finance: { monthCloseHoldPolicy: "ALLOW_WITH_DISCLOSURE" } },
      reason: "backup-restore-drill"
    }
  }
});
if (govPolicyRes.statusCode !== 200 && govPolicyRes.statusCode !== 201) {
  throw new Error(`month close policy update failed: ${govPolicyRes.statusCode} ${govPolicyRes.body}`);
}

log("registering backup robot");
const regRobot = await request({
  method: "POST",
  path: "/robots/register",
  headers: { "x-idempotency-key": "backup_robot_reg_1" },
  body: { robotId: "rob_backup", trustScore: 0.9, homeZoneId: "zone_a" }
});
if (regRobot.statusCode !== 201) throw new Error(`robot register failed: ${regRobot.statusCode} ${regRobot.body}`);
let robotPrev = regRobot.json?.robot?.lastChainHash ?? null;
if (!robotPrev) throw new Error("robot registration missing lastChainHash");

nowMs += 1_000;
log("setting robot availability");
const setAvail = await request({
  method: "POST",
  path: "/robots/rob_backup/availability",
  headers: { "x-idempotency-key": "backup_robot_avail_1", "x-proxy-expected-prev-chain-hash": robotPrev },
  body: { availability: [{ startAt: `${MONTH}-01T00:00:00.000Z`, endAt: `${MONTH}-28T23:59:59.999Z` }] }
});
if (setAvail.statusCode !== 201) throw new Error(`robot availability failed: ${setAvail.statusCode} ${setAvail.body}`);
robotPrev = setAvail.json?.robot?.lastChainHash ?? robotPrev;

const bookingStartAt = `${MONTH}-15T10:30:00.000Z`;
const bookingEndAt = `${MONTH}-15T11:00:00.000Z`;

const jobIds = [];

for (let i = 0; i < JOBS; i += 1) {
  if (i === 0 || i === JOBS - 1 || i % 10 === 0) {
    log("seeding jobs progress", { current: i + 1, total: JOBS });
  }
  const created = await request({
    method: "POST",
    path: "/jobs",
    headers: { "x-idempotency-key": `backup_job_create_${i}` },
    body: { templateId: "reset_lite", constraints: { zoneId: "zone_a" } }
  });
  if (created.statusCode !== 201) throw new Error(`job create failed: ${created.statusCode} ${created.body}`);

  const jobId = created.json?.job?.id;
  let prev = created.json?.job?.lastChainHash;
  if (!jobId || !prev) throw new Error("job create did not return id/lastChainHash");
  jobIds.push(jobId);

  const postServerEvent = async (type, payload, idempotencyKey) => {
    const res = await request({
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": prev, "x-idempotency-key": idempotencyKey },
      body: { type, actor: { type: "system", id: "backup" }, payload }
    });
    if (res.statusCode !== 201) throw new Error(`post ${type} failed: ${res.statusCode} ${res.body}`);
    prev = res.json?.job?.lastChainHash;
    return res;
  };

  nowMs += 1_000;
  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500 + i, currency: "USD" }, `backup_quote_${i}`);
  nowMs += 1_000;
  await postServerEvent(
    "BOOKED",
    makeBookedPayload({
      paymentHoldId: `hold_backup_${jobId}`,
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_MANAGED_BUILDING",
      requiresOperatorCoverage: false,
      customerId: "cust_backup",
      siteId: "site_backup"
    }),
    `backup_book_${i}`
  );
  nowMs += 1_000;
  await postServerEvent("MATCHED", { robotId: "rob_backup", operatorPartyId: "pty_operator_backup" }, `backup_match_${i}`);
  nowMs += 1_000;
  await postServerEvent("JOB_CANCELLED", { jobId, cancelledAt: nowIso(), reason: "OPS", requestedBy: "ops" }, `backup_cancel_${i}`);
  nowMs += 1_000;
  await postServerEvent("SETTLED", { settlement: "backup" }, `backup_settle_${i}`);
}

log("draining job accounting queue");
for (let i = 0; i < 50; i += 1) {
  const tick = await api.tickJobAccounting({ maxMessages: 200 });
  if (!Array.isArray(tick?.processed) || tick.processed.length === 0) break;
}
log("draining artifact queue");
for (let i = 0; i < 50; i += 1) {
  const tick = await api.tickArtifacts({ maxMessages: 200 });
  if (!Array.isArray(tick?.processed) || tick.processed.length === 0) break;
}

if (REQUIRE_MONTH_CLOSE) {
  nowMs += 1_000;
  log("requesting month close");
  const closeReq = await request({ method: "POST", path: "/ops/month-close", body: { month: MONTH } });
  if (closeReq.statusCode !== 200 && closeReq.statusCode !== 202) {
    throw new Error(`month close request failed: ${closeReq.statusCode} ${closeReq.body}`);
  }

  let closed = false;
  log("polling month close status");
  for (let i = 0; i < 240; i += 1) {
    const tick = await api.tickMonthClose({ maxMessages: 50 });
    const failedTick = Array.isArray(tick?.processed) ? tick.processed.find((row) => row?.status === "failed") : null;
    if (failedTick) {
      throw new Error(`month close tick failed: ${JSON.stringify(failedTick)}`);
    }
    await api.tickArtifacts({ maxMessages: 200 });
    const status = await request({ method: "GET", path: `/ops/month-close?month=${encodeURIComponent(MONTH)}` });
    if (status.statusCode === 200 && status.json?.monthClose?.status === "CLOSED") {
      closed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!closed) throw new Error("month close did not reach CLOSED");
} else {
  log("skipping month close request (set BACKUP_RESTORE_REQUIRE_MONTH_CLOSE=1 to enforce)");
}

await close();
log("seed workload complete");

process.stdout.write(JSON.stringify({ tenantId, jobIds, month: MONTH }, null, 2) + "\n");
