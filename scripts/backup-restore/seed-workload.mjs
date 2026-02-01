/**
 * Seeds a deterministic workload into Postgres using the in-process API.
 *
 * Outputs JSON with:
 *  - tenantId
 *  - jobIds
 *  - month
 */
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../../src/core/event-chain.js";
import { createBackupRestoreApiClient } from "./client.mjs";
import { makeBookedPayload } from "../../test/api-test-harness.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const TENANT_ID = process.env.TENANT_ID ?? "tenant_default";
const MONTH = process.env.MONTH ?? "2026-01";
const JOBS = Number(process.env.JOBS ?? "10");
const SCHEMA = process.env.PROXY_PG_SCHEMA ?? "public";

if (!Number.isSafeInteger(JOBS) || JOBS <= 0) throw new Error("JOBS must be a positive integer");

const { request, close, tenantId } = await createBackupRestoreApiClient({
  databaseUrl: DATABASE_URL,
  schema: SCHEMA,
  tenantId: TENANT_ID
});

// Fixed time anchors for determinism.
const baseNow = Date.parse("2026-01-15T10:00:00.000Z");
const bookingStartAt = new Date(baseNow + 5 * 60_000).toISOString();
const bookingEndAt = new Date(baseNow + 65 * 60_000).toISOString();

// Register one robot + one operator with signing keys.
const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

const { publicKeyPem: operatorPublicKeyPem, privateKeyPem: operatorPrivateKeyPem } = createEd25519Keypair();
const operatorKeyId = keyIdFromPublicKeyPem(operatorPublicKeyPem);

const regRobot = await request({
  method: "POST",
  path: "/robots/register",
  headers: { "x-idempotency-key": "backup_robot_reg_1" },
  body: { robotId: "rob_backup", publicKeyPem: robotPublicKeyPem, trustScore: 0.9, homeZoneId: "zone_a" }
});
if (regRobot.statusCode !== 201) throw new Error(`robot register failed: ${regRobot.statusCode} ${regRobot.body}`);

const robotPrev = regRobot.json?.robot?.lastChainHash;
const setAvail = await request({
  method: "POST",
  path: "/robots/rob_backup/availability",
  headers: { "x-idempotency-key": "backup_robot_avail_1", "x-proxy-expected-prev-chain-hash": robotPrev },
  body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
});
if (setAvail.statusCode !== 201) throw new Error(`robot availability failed: ${setAvail.statusCode} ${setAvail.body}`);

const regOperator = await request({
  method: "POST",
  path: "/operators/register",
  headers: { "x-idempotency-key": "backup_op_reg_1" },
  body: { operatorId: "op_backup", publicKeyPem: operatorPublicKeyPem }
});
if (regOperator.statusCode !== 201) throw new Error(`operator register failed: ${regOperator.statusCode} ${regOperator.body}`);

const jobIds = [];

for (let i = 0; i < JOBS; i += 1) {
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

  const postRobotEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: "rob_backup" }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: prev,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request({ method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    if (res.statusCode !== 201) throw new Error(`robot event ${type} failed: ${res.statusCode} ${res.body}`);
    prev = res.json?.job?.lastChainHash;
    return res;
  };

  const postOperatorEvent = async (type, payload) => {
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "operator", id: "op_backup" }, payload });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: prev,
      signer: { keyId: operatorKeyId, privateKeyPem: operatorPrivateKeyPem }
    });
    const res = await request({ method: "POST", path: `/jobs/${jobId}/events`, body: finalized });
    if (res.statusCode !== 201) throw new Error(`operator event ${type} failed: ${res.statusCode} ${res.body}`);
    prev = res.json?.job?.lastChainHash;
    return res;
  };

  // Quote/book/match/reserve/execute/settle.
  await postServerEvent("QUOTE_PROPOSED", { amountCents: 6500 + i, currency: "USD" }, `backup_quote_${i}`);
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
  await postServerEvent("MATCHED", { robotId: "rob_backup" }, `backup_match_${i}`);
  await postServerEvent(
    "RESERVED",
    { robotId: "rob_backup", startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_backup_${i}` },
    `backup_reserve_${i}`
  );

  await postRobotEvent("EXECUTION_STARTED", { plan: ["navigate"] });
  await postOperatorEvent("ASSIST_STARTED", { reason: "backup_test" });
  await postOperatorEvent("ASSIST_ENDED", { outcome: "approved" });
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 10 } });
  await postServerEvent("SETTLED", { settlement: "backup" }, `backup_settle_${i}`);
}

// Request month close and wait for CLOSED.
const closeReq = await request({ method: "POST", path: "/ops/month-close", body: { month: MONTH } });
if (closeReq.statusCode !== 202) throw new Error(`month close request failed: ${closeReq.statusCode} ${closeReq.body}`);

for (let i = 0; i < 50; i += 1) {
  const status = await request({ method: "GET", path: `/ops/month-close?month=${encodeURIComponent(MONTH)}` });
  if (status.statusCode === 200 && status.json?.monthClose?.status === "CLOSED") break;
  // allow outbox catch up
  await new Promise((r) => setTimeout(r, 100));
  if (i === 49) throw new Error("month close did not reach CLOSED");
}

await close();

process.stdout.write(JSON.stringify({ tenantId, jobIds, month: MONTH }, null, 2) + "\n");

