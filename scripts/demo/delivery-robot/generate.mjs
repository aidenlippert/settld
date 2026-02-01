import fs from "node:fs/promises";
import path from "node:path";

import { createApi } from "../../../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../../../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../../../src/core/event-chain.js";

import { request } from "../../../test/api-test-harness.js";

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

async function writeJson(filepath, value) {
  const dir = path.dirname(filepath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function safeJson(res) {
  return res?.json ?? (res?.body ? JSON.parse(res.body) : null);
}

async function main() {
  const runId = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replaceAll("-", "");
  const root = path.resolve("demo/delivery-robot/output", runId);
  const latest = path.resolve("demo/delivery-robot/output/latest");

  let nowMs = Date.parse("2026-01-20T09:50:00.000Z");
  const nowIso = () => isoFromMs(nowMs);

  const api = createApi({ now: nowIso, ingestToken: "ingest_tok" });

  const protocolHeaders = { "x-settld-protocol": "1.0" };

  const steps = [];
  const recordStep = (name, res, extra = null) => {
    const json = safeJson(res);
    steps.push({
      name,
      statusCode: res?.statusCode ?? null,
      code: res?.headers?.get?.("x-proxy-error-code") ?? null,
      body: json ?? res?.body ?? null,
      ...(extra ? { extra } : null)
    });
  };

  // 0) Register a robot key (for client-finalized telemetry).
  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotId = "rob_demo_delivery";
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const robotReg = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: { ...protocolHeaders, "x-idempotency-key": "demo_robot_reg" },
    body: { robotId, publicKeyPem: robotPublicKeyPem }
  });
  recordStep("robot.register", robotReg);
  if (robotReg.statusCode !== 201) throw new Error("robot.register failed");

  const robotAvail = await request(api, {
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: { ...protocolHeaders, "x-idempotency-key": "demo_robot_avail", "x-proxy-expected-prev-chain-hash": robotReg.json.robot.lastChainHash },
    body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
  });
  recordStep("robot.availability", robotAvail);
  if (robotAvail.statusCode !== 201) throw new Error("robot.availability failed");

  // 1) Create a contract with credits enabled (to show SLA -> CreditMemo).
  const contractId = "c_demo_delivery";
  const contractCreate = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    headers: protocolHeaders,
    body: {
      contractId,
      name: "Demo Contract (delivery)",
      isDefault: false,
      policies: {
        creditPolicy: {
          enabled: true,
          defaultAmountCents: 1250,
          maxAmountCents: 1250,
          currency: "USD"
        },
        evidencePolicy: { retentionDays: 30 },
        coveragePolicy: {
          required: true,
          feeModel: "PER_JOB",
          feeCentsPerJob: 1650,
          creditFundingModel: "PLATFORM_EXPENSE",
          reserveFundPercent: 100,
          insurerId: null,
          recoverablePercent: 100,
          recoverableTerms: null,
          responseSlaSeconds: 0,
          includedAssistSeconds: 0,
          overageRateCentsPerMinute: 0
        }
      }
    }
  });
  recordStep("ops.contracts.create", contractCreate);
  if (contractCreate.statusCode !== 201) throw new Error("ops.contracts.create failed");

  // 2) Create + quote + book a job.
  const created = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { ...protocolHeaders, "x-idempotency-key": "demo_job_create" },
    body: { templateId: "reset_standard", customerId: "cust_demo", siteId: "site_demo", contractId, constraints: {} }
  });
  recordStep("jobs.create", created);
  if (created.statusCode !== 201) throw new Error("jobs.create failed");
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  // 15 minute SLA window for the demo story (startAt → endAt).
  const bookingStartAt = "2026-01-20T10:00:00.000Z";
  const bookingEndAt = "2026-01-20T10:15:00.000Z";
  // Allow late starts in the access plan window; SLA window is still the booking window.
  const accessValidTo = "2026-01-20T10:45:00.000Z";

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { ...protocolHeaders, "x-idempotency-key": "demo_job_quote", "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_HOSPITALITY",
      requiresOperatorCoverage: false,
      customerId: "cust_demo",
      siteId: "site_demo",
      contractId
    }
  });
  recordStep("jobs.quote", quote);
  if (quote.statusCode !== 201) throw new Error("jobs.quote failed");
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { ...protocolHeaders, "x-idempotency-key": "demo_job_book", "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: {
      paymentHoldId: `hold_${jobId}`,
      startAt: bookingStartAt,
      endAt: bookingEndAt,
      environmentTier: "ENV_HOSPITALITY",
      requiresOperatorCoverage: false,
      customerId: "cust_demo",
      siteId: "site_demo",
      contractId
    }
  });
  recordStep("jobs.book", book);
  if (book.statusCode !== 201) throw new Error("jobs.book failed");
  lastChainHash = book.json.job.lastChainHash;
  const bookedPolicyHash = book.json.event?.payload?.policyHash ?? null;

  // 3) Update the contract post-booking to demonstrate pinning (policyHash is immutable per job).
  const contractUpdate = await request(api, {
    method: "POST",
    path: "/ops/contracts",
    headers: protocolHeaders,
    body: { contractId, policies: { creditPolicy: { enabled: true, defaultAmountCents: 9000, maxAmountCents: 9000, currency: "USD" } } }
  });
  recordStep("ops.contracts.update", contractUpdate);
  if (contractUpdate.statusCode !== 201) throw new Error("ops.contracts.update failed");

  // 4) Correlation + ingest sample telemetry from an upstream ops platform.
  // Advance time so ingest events aren't rejected as "future timestamp" (max skew is small).
  nowMs = Date.parse("2026-01-20T10:06:00.000Z");
  const correlationKey = "ext_delivery_412";
  const link = await request(api, {
    method: "POST",
    path: "/ops/correlations/link",
    headers: protocolHeaders,
    body: { jobId, siteId: "site_demo", correlationKey }
  });
  recordStep("ops.correlations.link", link);
  if (link.statusCode !== 201) throw new Error("ops.correlations.link failed");

  const ingestRequest = {
    source: "demo_dispatch",
    siteId: "site_demo",
    correlationKey,
    events: [
      {
        externalEventId: "ext_evt_dispatch_eval_1",
        type: "DISPATCH_EVALUATED",
        at: "2026-01-20T10:05:00.000Z",
        payload: {
          jobId,
          evaluatedAt: "2026-01-20T10:05:00.000Z",
          window: { startAt: bookingStartAt, endAt: bookingEndAt },
          zoneId: "default",
          requiresOperatorCoverage: false,
          candidates: [],
          selected: null
        }
      }
    ]
  };
  const ingest = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    auth: "none",
    headers: { ...protocolHeaders, "x-proxy-ingest-token": "ingest_tok", "x-idempotency-key": "demo_ingest_1" },
    body: ingestRequest
  });
  recordStep("ingest.proxy", ingest, { ingestRequest });
  if (ingest.statusCode !== 200) throw new Error(`ingest.proxy failed (status ${ingest.statusCode})`);
  if ((ingest.json?.results?.[0]?.status ?? null) !== "accepted") {
    throw new Error(`ingest.proxy rejected: ${ingest.json?.results?.[0]?.reasonCode ?? "UNKNOWN"}`);
  }
  if (Array.isArray(ingest.json?.events) && ingest.json.events.length) {
    const head = ingest.json.events[ingest.json.events.length - 1];
    if (head?.chainHash) lastChainHash = head.chainHash;
  }

  // Helpers to append job events.
  const postServerEvent = async (type, payload, idempotencyKey) => {
    const res = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: {
        ...protocolHeaders,
        ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        "x-proxy-expected-prev-chain-hash": lastChainHash
      },
      body: { type, actor: { type: "system", id: "proxy" }, payload }
    });
    recordStep(`jobs.events.${type}`, res);
    if (res.statusCode !== 201) throw new Error(`jobs.events.${type} failed (status ${res.statusCode}): ${res.body ?? ""}`);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  const postRobotEvent = async (type, payload) => {
    const at = nowIso();
    const draft = createChainedEvent({ streamId: jobId, type, actor: { type: "robot", id: robotId }, payload, at });
    const finalized = finalizeChainedEvent({
      event: draft,
      prevChainHash: lastChainHash,
      signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem }
    });
    const res = await request(api, { method: "POST", path: `/jobs/${jobId}/events`, headers: protocolHeaders, body: finalized });
    recordStep(`jobs.events.${type}.robot`, res);
    if (res.statusCode !== 201) throw new Error(`jobs.events.${type} (robot) failed (status ${res.statusCode}): ${res.body ?? ""}`);
    lastChainHash = res.json.job.lastChainHash;
    return res;
  };

  // 5) Match/reserve + access.
  await postServerEvent("MATCHED", { robotId }, "demo_match");
  await postServerEvent("RESERVED", { robotId, startAt: bookingStartAt, endAt: bookingEndAt, reservationId: `rsv_${jobId}` }, "demo_reserve");

  const accessPlanId = `ap_${jobId}`;
  await postServerEvent(
    "ACCESS_PLAN_ISSUED",
    {
      jobId,
      accessPlanId,
      method: "DOCKED_IN_BUILDING",
      credentialRef: `vault://access/${accessPlanId}/v1`,
      scope: { areas: ["LOADING_DOCK"], noGo: [] },
      validFrom: bookingStartAt,
      validTo: accessValidTo,
      revocable: true,
      requestedBy: "system"
    },
    "demo_access_plan"
  );

  // 6) Robot telemetry (late start -> SLA breach -> credit).
  nowMs = Date.parse("2026-01-20T09:58:00.000Z");
  await postRobotEvent("EN_ROUTE", { etaSeconds: 60 });
  nowMs = Date.parse("2026-01-20T10:01:00.000Z");
  await postRobotEvent("ACCESS_GRANTED", { jobId, accessPlanId, method: "DOCKED_IN_BUILDING" });
  nowMs = Date.parse("2026-01-20T10:18:00.000Z"); // after SLA window end
  await postRobotEvent("EXECUTION_STARTED", { plan: ["deliver"], destination: "room_412" });
  nowMs = Date.parse("2026-01-20T10:18:32.000Z");
  await postRobotEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 32 }, deliveredTo: "room_412" });

  nowMs += 60_000;
  await postServerEvent("SETTLED", { settlement: "demo" }, "demo_settle");

  const accounting = await api.tickJobAccounting({ maxMessages: 50 });
  steps.push({ name: "tick.jobAccounting", result: accounting });

  const artifactsTick = await api.tickArtifacts({ maxMessages: 200 });
  steps.push({ name: "tick.artifacts", result: artifactsTick });

  const timeline = await request(api, { method: "GET", path: `/ops/jobs/${jobId}/timeline`, headers: protocolHeaders });
  recordStep("ops.jobs.timeline", timeline);

  const artifactsRes = await request(api, { method: "GET", path: `/jobs/${jobId}/artifacts`, headers: protocolHeaders });
  recordStep("jobs.artifacts", artifactsRes);

  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const latestByType = new Map();
  for (const a of artifacts) {
    const t = a?.artifactType ?? a?.schemaVersion ?? null;
    if (!t) continue;
    const prev = latestByType.get(t) ?? null;
    const at = Date.parse(a?.generatedAt ?? a?.createdAt ?? 0);
    const bt = Date.parse(prev?.generatedAt ?? prev?.createdAt ?? 0);
    if (!prev || (Number.isFinite(at) && Number.isFinite(bt) && at > bt)) latestByType.set(t, a);
  }
  const artifactsByType = Object.fromEntries(Array.from(latestByType.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

  const output = {
    runId,
    scenario: "delivery_robot_late",
    tenantId: "tenant_default",
    jobId,
    bookedPolicyHash,
    contractId,
    contractVersionAtBooking: book.json.event?.payload?.contractVersion ?? null,
    contractVersionAfterUpdate: contractUpdate.json.contract?.contractVersion ?? null,
    artifacts: Object.keys(artifactsByType).sort(),
    notes: [
      "Booking pins policyHash; later contract updates do not change bookedPolicyHash.",
      "Robot starts after booking window end -> SLA_BREACH_DETECTED, then SLA_CREDIT_ISSUED (creditPolicy enabled)."
    ]
  };

  // Write outputs.
  await fs.rm(latest, { recursive: true, force: true });
  await fs.mkdir(latest, { recursive: true });

  await writeJson(path.join(root, "run.json"), output);
  await writeJson(path.join(latest, "run.json"), output);

  await writeJson(path.join(root, "sample_ingest_request.json"), ingestRequest);
  await writeJson(path.join(latest, "sample_ingest_request.json"), ingestRequest);

  await writeJson(path.join(root, "sample_ingest_response.json"), ingest.json);
  await writeJson(path.join(latest, "sample_ingest_response.json"), ingest.json);

  await writeJson(path.join(root, "timeline.json"), timeline.json);
  await writeJson(path.join(latest, "timeline.json"), timeline.json);

  await writeJson(path.join(root, "artifacts_index.json"), { artifacts });
  await writeJson(path.join(latest, "artifacts_index.json"), { artifacts });

  for (const [artifactType, artifact] of Object.entries(artifactsByType)) {
    const filename = `${artifactType}.json`;
    await writeJson(path.join(root, filename), artifact);
    await writeJson(path.join(latest, filename), artifact);
  }

  await writeJson(path.join(root, "steps.json"), { steps });
  await writeJson(path.join(latest, "steps.json"), { steps });

  // Console summary (for 30-second demo).
  // Keep output stable and readable.
  process.stdout.write(
    [
      "Demo generated.",
      `- Job: ${jobId}`,
      `- Booked policyHash: ${bookedPolicyHash}`,
      `- Artifacts: ${Object.keys(artifactsByType).sort().join(", ") || "(none)"}`,
      `- Output: demo/delivery-robot/output/${runId}/`,
      "Open demo/delivery-robot/output/latest/ for the most recent run."
    ].join("\n") + "\n"
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
