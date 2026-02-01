import fs from "node:fs/promises";
import path from "node:path";

import { createApi } from "../../src/api/app.js";
import { createStore } from "../../src/api/store.js";
import { keyIdFromPublicKeyPem } from "../../src/core/crypto.js";
import { sha256Hex } from "../../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../../src/core/event-chain.js";
import { resetDeterministicIds } from "../../src/core/ids.js";
import { buildJobProofBundleV1, buildMonthProofBundleV1 } from "../../src/core/proof-bundle.js";
import { GOVERNANCE_STREAM_ID } from "../../src/core/governance.js";
import { contractDocumentV1FromLegacyContract, hashContractDocumentV1 } from "../../src/core/contract-document.js";
import { MONTH_CLOSE_BASIS, makeMonthCloseStreamId } from "../../src/core/month-close.js";
import { DEFAULT_TENANT_ID } from "../../src/core/tenancy.js";

import { request } from "../../test/api-test-harness.js";
import { writeFilesToDir, writeZipFromDir, ensureDir } from "../proof-bundle/lib.mjs";

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

async function writeJson(filepath, value) {
  const dir = path.dirname(filepath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function safeJson(res) {
  if (res?.json) return res.json;
  if (!res?.body) return null;
  if (typeof res.body !== "string") return res.body;

  const trimmed = res.body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return res.body;
    }
  }
  return res.body;
}

async function main() {
  resetDeterministicIds();

  const runId = "finance_pack_v1";
  const root = path.resolve("demo/finance-pack/output", runId);
  const latest = path.resolve("demo/finance-pack/output/latest");

  let nowMs = Date.parse("2026-01-20T09:50:00.000Z");
  const nowIso = () => isoFromMs(nowMs);

  const serverSignerKeypair = JSON.parse(
    await fs.readFile(new URL("./fixtures/server-signer.json", import.meta.url), "utf8")
  );
  const store = createStore({ serverSignerKeypair });
  const api = createApi({ store, now: nowIso, ingestToken: "ingest_tok" });
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
  const robotKeypairFixture = JSON.parse(
    await fs.readFile(new URL("./fixtures/robot-keypair.json", import.meta.url), "utf8")
  );
  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = robotKeypairFixture;
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

  // 1) Create a contract with credits enabled (so the demo shows SLA -> CreditMemo).
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
        evidencePolicy: { retentionDays: 30 }
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

  const bookingStartAt = "2026-01-20T10:00:00.000Z";
  const bookingEndAt = "2026-01-20T10:15:00.000Z";
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
  const customerContractHash = book.json.event?.payload?.customerContractHash ?? null;

  // 3) Match/reserve + access.
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

  await postServerEvent("MATCHED", { robotId, operatorPartyId: "pty_operator_demo" }, "demo_match");
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

  // 4) Robot telemetry (late start -> SLA breach -> credit).
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

  const accounting = await api.tickJobAccounting({ maxMessages: 200 });
  steps.push({ name: "tick.jobAccounting", result: accounting });

  const artifactsTick = await api.tickArtifacts({ maxMessages: 400 });
  steps.push({ name: "tick.artifacts", result: artifactsTick });

  // 5) Configure a minimal finance account map (so journal CSV renders).
  const financeMap = {
    schemaVersion: "FinanceAccountMap.v1",
    accounts: {
      acct_customer_escrow: "2100",
      acct_platform_revenue: "4000",
      acct_owner_payable: "2000",
      acct_operator_payable: "2010",
      acct_sla_credits_expense: "4900",
      acct_customer_credits_payable: "2110",
      acct_cash: "1000",
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
      acct_developer_royalty_payable: "2020"
    }
  };

  const financeMapRes = await request(api, {
    method: "PUT",
    path: "/ops/finance/account-map",
    headers: protocolHeaders,
    body: { mapping: financeMap }
  });
  recordStep("ops.finance.account-map.put", financeMapRes);
  if (financeMapRes.statusCode !== 200) throw new Error("failed to set finance account map");

  // 6) Month close + GLBatch + CSV.
  const month = "2026-01";
  const monthCloseReq = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: { ...protocolHeaders, "x-idempotency-key": "demo_month_close" },
    body: { month, basis: MONTH_CLOSE_BASIS.SETTLED_AT }
  });
  recordStep("ops.month-close.request", monthCloseReq);
  if (monthCloseReq.statusCode !== 202) throw new Error("month close request failed");

  const monthCloseTick = await api.tickMonthClose({ maxMessages: 50 });
  steps.push({ name: "tick.monthClose", result: monthCloseTick });

  const glBatchRes = await request(api, { method: "GET", path: `/ops/finance/gl-batch?period=${encodeURIComponent(month)}`, headers: protocolHeaders });
  recordStep("ops.finance.gl-batch.get", glBatchRes);
  if (glBatchRes.statusCode !== 200) throw new Error("GL batch not found after month close");

  const glCsvRes = await request(api, { method: "GET", path: `/ops/finance/gl-batch.csv?period=${encodeURIComponent(month)}`, headers: protocolHeaders });
  recordStep("ops.finance.gl-batch.csv.get", glCsvRes);
  if (glCsvRes.statusCode !== 200) throw new Error("GL CSV not available");
  const glCsv = glCsvRes.body;

  // Collect artifacts.
  const artifacts = await api.store.listArtifacts({ tenantId: "tenant_default", jobId });
  const allArtifacts = await api.store.listArtifacts({ tenantId: "tenant_default" });

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

  const glBatchArtifact = glBatchRes.json?.artifact ?? null;

  // Proof bundles (job + month).
  const jobEvents = api.store.jobEvents.get(`tenant_default\n${jobId}`) ?? [];
  const monthId = makeMonthCloseStreamId({ month, basis: MONTH_CLOSE_BASIS.SETTLED_AT });
  const monthEvents = api.store.monthEvents.get(`tenant_default\n${monthId}`) ?? [];

  const contractDocsByHash = new Map();
  const contract = api.store.contracts.get(`tenant_default\n${contractId}`) ?? null;
  if (contract && typeof contract === "object" && customerContractHash) {
    const contractDoc = contractDocumentV1FromLegacyContract({ ...contract, contractVersion: contract.contractVersion ?? 1 });
    const hash = hashContractDocumentV1(contractDoc);
    if (hash === customerContractHash) contractDocsByHash.set(hash, contractDoc);
  }

  const publicKeyByKeyId = api.store.publicKeyByKeyId instanceof Map ? api.store.publicKeyByKeyId : new Map();
  const manifestSigner = api.store?.serverSigner ? { keyId: api.store.serverSigner.keyId, privateKeyPem: api.store.serverSigner.privateKeyPem } : null;
  let signerKeys = [];
  if (typeof api.store.listSignerKeys === "function") {
    const tenantKeys = await api.store.listSignerKeys({ tenantId: "tenant_default" });
    const defaultKeys = await api.store.listSignerKeys({ tenantId: "tenant_default" });
    const all = [...(tenantKeys ?? []), ...(defaultKeys ?? [])];
    const byKeyId = new Map();
    for (const r of all) {
      const keyId = r?.keyId ? String(r.keyId) : null;
      if (!keyId) continue;
      byKeyId.set(keyId, r);
    }
    signerKeys = Array.from(byKeyId.values());
  }
  const generatedAt = nowIso();
  const tenantGovernanceEvents = api.store.monthEvents.get(`tenant_default\n${GOVERNANCE_STREAM_ID}`) ?? [];
  const tenantGovernanceSnapshot = {
    streamId: GOVERNANCE_STREAM_ID,
    lastChainHash: tenantGovernanceEvents.length ? tenantGovernanceEvents[tenantGovernanceEvents.length - 1]?.chainHash ?? null : null,
    lastEventId: tenantGovernanceEvents.length ? tenantGovernanceEvents[tenantGovernanceEvents.length - 1]?.id ?? null : null
  };
  const governanceEvents = api.store.monthEvents.get(`${DEFAULT_TENANT_ID}\n${GOVERNANCE_STREAM_ID}`) ?? [];
  const governanceSnapshot = {
    streamId: GOVERNANCE_STREAM_ID,
    lastChainHash: governanceEvents.length ? governanceEvents[governanceEvents.length - 1]?.chainHash ?? null : null,
    lastEventId: governanceEvents.length ? governanceEvents[governanceEvents.length - 1]?.id ?? null : null
  };

  const jobBundle = buildJobProofBundleV1({
    tenantId: "tenant_default",
    jobId,
    jobEvents,
    jobSnapshot: api.store.jobs.get(`tenant_default\n${jobId}`) ?? created.json.job,
    governanceEvents,
    governanceSnapshot,
    tenantGovernanceEvents,
    tenantGovernanceSnapshot,
    artifacts,
    contractDocsByHash,
    publicKeyByKeyId,
    signerKeys,
    manifestSigner,
    generatedAt
  });

  const monthArtifacts = allArtifacts.filter((a) => {
    if (!a || typeof a !== "object") return false;
    if (a.month && String(a.month) === month) return true;
    if (a.period && String(a.period) === month) return true;
    return false;
  });

  const journalCsvArtifact =
    monthArtifacts
      .filter((a) => a?.artifactType === "JournalCsv.v1" && String(a?.period ?? "") === String(month))
      .sort((a, b) => String(a?.artifactId ?? "").localeCompare(String(b?.artifactId ?? "")))
      .slice(-1)[0] ?? null;

  const monthBundle = buildMonthProofBundleV1({
    tenantId: "tenant_default",
    period: month,
    basis: MONTH_CLOSE_BASIS.SETTLED_AT,
    monthEvents,
    governanceEvents,
    governanceSnapshot,
    tenantGovernanceEvents,
    tenantGovernanceSnapshot,
    artifacts: monthArtifacts,
    contractDocsByHash,
    publicKeyByKeyId,
    signerKeys,
    manifestSigner,
    generatedAt
  });

  // Write outputs.
  await fs.rm(latest, { recursive: true, force: true });
  await fs.mkdir(latest, { recursive: true });

  await writeJson(path.join(root, "run.json"), {
    runId,
    tenantId: "tenant_default",
    jobId,
    month,
    bookedPolicyHash,
    customerContractHash,
    outputs: Object.keys(artifactsByType).sort(),
    glBatchArtifactHash: glBatchArtifact?.artifactHash ?? null
  });
  await writeJson(path.join(latest, "run.json"), {
    runId,
    tenantId: "tenant_default",
    jobId,
    month,
    bookedPolicyHash,
    customerContractHash,
    outputs: Object.keys(artifactsByType).sort(),
    glBatchArtifactHash: glBatchArtifact?.artifactHash ?? null
  });

  for (const [artifactType, artifact] of Object.entries(artifactsByType)) {
    await writeJson(path.join(root, `${artifactType}.json`), artifact);
    await writeJson(path.join(latest, `${artifactType}.json`), artifact);
  }

  await writeJson(path.join(root, "GLBatch.v1.json"), glBatchArtifact);
  await writeJson(path.join(latest, "GLBatch.v1.json"), glBatchArtifact);
  await fs.writeFile(path.join(root, "GLBatch.v1.csv"), glCsv, "utf8");
  await fs.writeFile(path.join(latest, "GLBatch.v1.csv"), glCsv, "utf8");

  if (journalCsvArtifact) {
    await writeJson(path.join(root, "JournalCsv.v1.json"), journalCsvArtifact);
    await writeJson(path.join(latest, "JournalCsv.v1.json"), journalCsvArtifact);
    if (typeof journalCsvArtifact.csv === "string") {
      await fs.writeFile(path.join(root, "JournalCsv.v1.csv"), journalCsvArtifact.csv, "utf8");
      await fs.writeFile(path.join(latest, "JournalCsv.v1.csv"), journalCsvArtifact.csv, "utf8");
    }
  }

  await writeJson(path.join(root, "steps.json"), { steps });
  await writeJson(path.join(latest, "steps.json"), { steps });

  // Proof bundle directories + zip.
  const jobBundleDir = path.join(root, "proof", "job");
  const monthBundleDir = path.join(root, "proof", "month");
  ensureDir(jobBundleDir);
  ensureDir(monthBundleDir);
  writeFilesToDir({ files: jobBundle.files, outDir: jobBundleDir });
  writeFilesToDir({ files: monthBundle.files, outDir: monthBundleDir });
  await writeZipFromDir({ dir: jobBundleDir, outPath: path.join(root, "JobProofBundle.v1.zip") });
  await writeZipFromDir({ dir: monthBundleDir, outPath: path.join(root, "MonthProofBundle.v1.zip") });

  // Also mirror proof bundles to latest.
  const jobBundleDirLatest = path.join(latest, "proof", "job");
  const monthBundleDirLatest = path.join(latest, "proof", "month");
  ensureDir(jobBundleDirLatest);
  ensureDir(monthBundleDirLatest);
  writeFilesToDir({ files: jobBundle.files, outDir: jobBundleDirLatest });
  writeFilesToDir({ files: monthBundle.files, outDir: monthBundleDirLatest });
  await writeZipFromDir({ dir: jobBundleDirLatest, outPath: path.join(latest, "JobProofBundle.v1.zip") });
  await writeZipFromDir({ dir: monthBundleDirLatest, outPath: path.join(latest, "MonthProofBundle.v1.zip") });

  // Console summary.
  process.stdout.write(`ok\njobId=${jobId}\nmonth=${month}\noutput=${latest}\n`);
  process.stdout.write(`glBatchHash=${glBatchArtifact?.artifactHash ?? "missing"}\n`);
  process.stdout.write(`glCsvSha256=${sha256Hex(new TextEncoder().encode(glCsv))}\n`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
