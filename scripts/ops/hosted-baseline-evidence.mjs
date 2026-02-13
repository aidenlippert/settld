#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";
import { sha256Hex, signHashHexEd25519 } from "../../src/core/crypto.js";

const DEFAULT_REQUIRED_METRICS = Object.freeze([
  "replay_mismatch_gauge",
  "disputes_over_sla_gauge",
  "arbitration_over_sla_gauge",
  "settlement_holds_over_24h_gauge",
  "worker_outbox_pending_total_gauge",
  "worker_deliveries_pending_total_gauge"
]);

const RATE_LIMIT_MODE = Object.freeze({
  OPTIONAL: "optional",
  REQUIRED: "required",
  DISABLED: "disabled"
});

function usage() {
  // eslint-disable-next-line no-console
  console.error(
    "usage: node scripts/ops/hosted-baseline-evidence.mjs --ops-token <tok> [--base-url <url>] [--tenant-id <id>] [--environment <name>] [--metrics-ops-token <tok>] [--required-metrics <csv>] [--require-billing-catalog <true|false>] [--require-maintenance-schedulers <true|false>] [--rate-limit-mode <optional|required|disabled>] [--rate-limit-probe-requests <n>] [--rate-limit-probe-path <path>] [--run-backup-restore <true|false>] [--database-url <url>] [--restore-database-url <url>] [--backup-restore-schema <schema>] [--backup-restore-jobs <n>] [--backup-restore-month <YYYY-MM>] [--backup-restore-evidence-path <file>] [--require-backup-restore <true|false>] [--signing-key-file <pem>] [--signature-key-id <id>] [--out <file>]"
  );
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseBooleanArg(raw, { name }) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  throw new Error(`${name} must be one of true|false`);
}

function parseIntegerArg(raw, { name, min = null } = {}) {
  const text = normalizeOptionalString(raw);
  if (text === null) throw new Error(`${name} is required`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be a safe integer`);
  if (min !== null && n < min) throw new Error(`${name} must be >= ${min}`);
  return n;
}

function parseCsvList(value) {
  const text = normalizeOptionalString(value);
  if (!text) return [];
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parsePrometheusMetricNames(text) {
  const names = new Set();
  const lines = String(text ?? "").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const token = line.split(/\s+/)[0] ?? "";
    const metricName = token.split("{")[0]?.trim() ?? "";
    if (metricName) names.add(metricName);
  }
  return names;
}

function tailText(input, maxChars = 12_000) {
  const text = String(input ?? "");
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function validateBackupRestoreDatabaseUrl(raw, { name }) {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return {
      ok: false,
      reason: `${name} is missing`
    };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      reason: `${name} is not a valid URL`
    };
  }
  if (!(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:")) {
    return {
      ok: false,
      reason: `${name} must use postgres:// or postgresql://`
    };
  }
  const host = normalizeOptionalString(parsed.hostname);
  if (!host) {
    return {
      ok: false,
      reason: `${name} must include a hostname`
    };
  }
  if (host === "..." || host.toLowerCase() === "redacted" || host.toLowerCase() === "example.com") {
    return {
      ok: false,
      reason: `${name} hostname looks redacted (${host}); pass the real database host`
    };
  }
  if (value.includes("://...") || value.includes("<") || value.includes(">")) {
    return {
      ok: false,
      reason: `${name} appears to be a placeholder; pass the real database URL`
    };
  }
  return { ok: true, reason: null };
}

function parseArgs(argv) {
  const out = {
    baseUrl: "http://127.0.0.1:3000",
    tenantId: "tenant_default",
    environment: null,
    opsToken: null,
    metricsOpsToken: null,
    requiredMetrics: [...DEFAULT_REQUIRED_METRICS],
    requireBillingCatalog: true,
    requireMaintenanceSchedulers: true,
    rateLimitMode: RATE_LIMIT_MODE.OPTIONAL,
    rateLimitProbeRequests: 0,
    rateLimitProbePath: "/ops/status",
    runBackupRestore: false,
    databaseUrl: null,
    restoreDatabaseUrl: null,
    backupRestoreSchema: null,
    backupRestoreJobs: null,
    backupRestoreMonth: null,
    backupRestoreEvidencePath: null,
    requireBackupRestore: false,
    signingKeyFile: null,
    signatureKeyId: null,
    outPath: null,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (arg === "--base-url") {
      out.baseUrl = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--tenant-id") {
      out.tenantId = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--environment") {
      out.environment = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--ops-token") {
      out.opsToken = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--metrics-ops-token") {
      out.metricsOpsToken = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--required-metrics") {
      out.requiredMetrics = parseCsvList(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--require-billing-catalog") {
      out.requireBillingCatalog = parseBooleanArg(argv[i + 1], { name: "--require-billing-catalog" });
      i += 1;
      continue;
    }
    if (arg === "--require-maintenance-schedulers") {
      out.requireMaintenanceSchedulers = parseBooleanArg(argv[i + 1], { name: "--require-maintenance-schedulers" });
      i += 1;
      continue;
    }
    if (arg === "--rate-limit-mode") {
      out.rateLimitMode = String(argv[i + 1] ?? "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--rate-limit-probe-requests") {
      out.rateLimitProbeRequests = parseIntegerArg(argv[i + 1], { name: "--rate-limit-probe-requests", min: 0 });
      i += 1;
      continue;
    }
    if (arg === "--rate-limit-probe-path") {
      out.rateLimitProbePath = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--run-backup-restore") {
      out.runBackupRestore = parseBooleanArg(argv[i + 1], { name: "--run-backup-restore" });
      i += 1;
      continue;
    }
    if (arg === "--database-url") {
      out.databaseUrl = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--restore-database-url") {
      out.restoreDatabaseUrl = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--backup-restore-schema") {
      out.backupRestoreSchema = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--backup-restore-jobs") {
      out.backupRestoreJobs = parseIntegerArg(argv[i + 1], { name: "--backup-restore-jobs", min: 1 });
      i += 1;
      continue;
    }
    if (arg === "--backup-restore-month") {
      out.backupRestoreMonth = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--backup-restore-evidence-path") {
      out.backupRestoreEvidencePath = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--require-backup-restore") {
      out.requireBackupRestore = parseBooleanArg(argv[i + 1], { name: "--require-backup-restore" });
      i += 1;
      continue;
    }
    if (arg === "--signing-key-file") {
      out.signingKeyFile = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--signature-key-id") {
      out.signatureKeyId = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--out") {
      out.outPath = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  out.baseUrl = normalizeOptionalString(out.baseUrl) ?? out.baseUrl;
  out.tenantId = normalizeOptionalString(out.tenantId) ?? out.tenantId;
  out.environment = normalizeOptionalString(out.environment);
  out.opsToken = normalizeOptionalString(out.opsToken);
  out.metricsOpsToken = normalizeOptionalString(out.metricsOpsToken);
  out.rateLimitProbePath = normalizeOptionalString(out.rateLimitProbePath) ?? "/ops/status";
  out.databaseUrl = normalizeOptionalString(out.databaseUrl);
  out.restoreDatabaseUrl = normalizeOptionalString(out.restoreDatabaseUrl);
  out.backupRestoreSchema = normalizeOptionalString(out.backupRestoreSchema);
  out.backupRestoreMonth = normalizeOptionalString(out.backupRestoreMonth);
  out.backupRestoreEvidencePath = normalizeOptionalString(out.backupRestoreEvidencePath);
  out.signingKeyFile = normalizeOptionalString(out.signingKeyFile);
  out.signatureKeyId = normalizeOptionalString(out.signatureKeyId);
  out.outPath = normalizeOptionalString(out.outPath);

  if (!Object.values(RATE_LIMIT_MODE).includes(out.rateLimitMode)) {
    throw new Error(`--rate-limit-mode must be ${Object.values(RATE_LIMIT_MODE).join("|")}`);
  }
  if (!out.rateLimitProbePath.startsWith("/")) {
    throw new Error("--rate-limit-probe-path must start with /");
  }
  if (out.backupRestoreMonth && !/^\d{4}-\d{2}$/.test(out.backupRestoreMonth)) {
    throw new Error("--backup-restore-month must match YYYY-MM");
  }

  return out;
}

async function requestJson({ baseUrl, pathName, method = "GET", headers = {}, body = undefined }) {
  const url = new URL(pathName, baseUrl);
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders["content-type"] = "application/json";
  const response = await fetch(url.toString(), {
    method: String(method),
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return {
    ok: response.ok,
    statusCode: response.status,
    body: json
  };
}

async function requestText({ baseUrl, pathName, method = "GET", headers = {} }) {
  const url = new URL(pathName, baseUrl);
  const response = await fetch(url.toString(), {
    method: String(method),
    headers
  });
  const text = await response.text();
  return {
    ok: response.ok,
    statusCode: response.status,
    text
  };
}

function getHeaders({ tenantId, opsToken }) {
  const headers = {
    "x-proxy-tenant-id": String(tenantId)
  };
  if (opsToken) headers["x-proxy-ops-token"] = String(opsToken);
  return headers;
}

function validateBillingCatalog(catalogBody) {
  const failures = [];
  const plans = catalogBody?.plans;
  if (!plans || typeof plans !== "object" || Array.isArray(plans)) {
    failures.push("catalog.plans must be an object");
    return { ok: false, failures, summary: null };
  }
  for (const planId of ["free", "builder", "growth", "enterprise"]) {
    const plan = plans[planId];
    if (!plan || typeof plan !== "object") {
      failures.push(`missing plan ${planId}`);
      continue;
    }
    const requiredNumericFields = [
      "subscriptionCents",
      "includedVerifiedRunsPerMonth",
      "verifiedRunOverageMilliCents",
      "settledVolumeFeeBps",
      "arbitrationCaseFeeCents",
      "hardLimitVerifiedRunsPerMonth"
    ];
    for (const field of requiredNumericFields) {
      const value = Number(plan?.[field]);
      if (!Number.isFinite(value)) failures.push(`plan ${planId} missing numeric ${field}`);
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    summary: {
      planIds: Object.keys(plans).sort()
    }
  };
}

async function loadBackupRestoreEvidenceFromPath(evidencePath) {
  const resolved = path.resolve(evidencePath);
  const raw = await fs.readFile(resolved, "utf8");
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw: tailText(raw, 16_000) };
  }
  return {
    source: "file",
    path: resolved,
    hash: sha256Hex(raw),
    payload: parsed
  };
}

function runBackupRestoreDrill({
  tenantId,
  databaseUrl,
  restoreDatabaseUrl,
  schema,
  jobs,
  month
}) {
  const scriptPath = fileURLToPath(new URL("../backup-restore-test.sh", import.meta.url));
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    RESTORE_DATABASE_URL: restoreDatabaseUrl,
    TENANT_ID: tenantId
  };
  if (schema) env.PROXY_PG_SCHEMA = schema;
  if (jobs !== null && jobs !== undefined) env.JOBS = String(jobs);
  if (month) env.MONTH = String(month);

  const started = Date.now();
  const run = spawnSync("bash", [scriptPath], {
    env,
    encoding: "utf8",
    stdio: "pipe"
  });
  const finished = Date.now();

  return {
    source: "command",
    command: `bash ${scriptPath}`,
    runtimeMs: finished - started,
    status: typeof run.status === "number" ? run.status : null,
    signal: run.signal ?? null,
    ok: run.status === 0,
    stdoutTail: tailText(run.stdout, 16_000),
    stderrTail: tailText(run.stderr, 16_000)
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    usage();
    // eslint-disable-next-line no-console
    console.error(err?.message ?? String(err));
    process.exit(1);
  }

  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.opsToken) {
    usage();
    // eslint-disable-next-line no-console
    console.error("--ops-token is required");
    process.exit(1);
  }

  const opsHeaders = getHeaders({ tenantId: args.tenantId, opsToken: args.opsToken });
  const metricsHeaders = getHeaders({
    tenantId: args.tenantId,
    opsToken: args.metricsOpsToken ?? args.opsToken
  });

  const failures = [];

  const healthz = await requestJson({
    baseUrl: args.baseUrl,
    pathName: "/healthz",
    method: "GET",
    headers: {}
  });
  const healthzOk = healthz.ok === true && healthz.statusCode === 200 && healthz.body?.ok === true;
  if (!healthzOk) failures.push("healthz check failed");

  const opsStatus = await requestJson({
    baseUrl: args.baseUrl,
    pathName: "/ops/status",
    method: "GET",
    headers: opsHeaders
  });
  const maintenance = opsStatus?.body?.maintenance ?? null;
  const hasRequiredMaintenanceSchedulers =
    maintenance &&
    typeof maintenance === "object" &&
    maintenance.financeReconciliation?.enabled === true &&
    maintenance.moneyRailReconciliation?.enabled === true;
  const opsStatusOk = opsStatus.ok === true && opsStatus.statusCode === 200 && opsStatus.body?.ok === true;
  if (!opsStatusOk) failures.push("ops status check failed");
  if (args.requireMaintenanceSchedulers && !hasRequiredMaintenanceSchedulers) {
    failures.push("required maintenance schedulers are not enabled");
  }

  const metrics = await requestText({
    baseUrl: args.baseUrl,
    pathName: "/metrics",
    method: "GET",
    headers: metricsHeaders
  });
  const metricNames = metrics.ok ? parsePrometheusMetricNames(metrics.text) : new Set();
  const missingMetrics = args.requiredMetrics.filter((name) => !metricNames.has(name));
  const metricsOk = metrics.ok === true && metrics.statusCode === 200 && missingMetrics.length === 0;
  if (!metricsOk) failures.push("metrics check failed");

  const billingCatalog = await requestJson({
    baseUrl: args.baseUrl,
    pathName: "/ops/finance/billing/catalog",
    method: "GET",
    headers: opsHeaders
  });
  const billingValidation = billingCatalog.ok ? validateBillingCatalog(billingCatalog.body) : { ok: false, failures: ["catalog request failed"] };
  const billingOk = billingCatalog.ok === true && billingCatalog.statusCode === 200 && billingValidation.ok === true;
  if (args.requireBillingCatalog && !billingOk) failures.push("billing catalog/quotas check failed");

  let rateLimitProbe = null;
  if (args.rateLimitProbeRequests > 0) {
    const statusCodeCounts = {};
    for (let i = 0; i < args.rateLimitProbeRequests; i += 1) {
      const res = await requestJson({
        baseUrl: args.baseUrl,
        pathName: args.rateLimitProbePath,
        method: "GET",
        headers: opsHeaders
      });
      const key = String(res.statusCode);
      statusCodeCounts[key] = Number(statusCodeCounts[key] ?? 0) + 1;
    }
    const saw429 = Number(statusCodeCounts["429"] ?? 0) > 0;
    let modePass = true;
    if (args.rateLimitMode === RATE_LIMIT_MODE.REQUIRED && saw429 !== true) modePass = false;
    if (args.rateLimitMode === RATE_LIMIT_MODE.DISABLED && saw429 === true) modePass = false;
    if (!modePass) failures.push(`rate-limit probe failed for mode=${args.rateLimitMode}`);
    rateLimitProbe = {
      path: args.rateLimitProbePath,
      requests: args.rateLimitProbeRequests,
      mode: args.rateLimitMode,
      statusCodeCounts,
      saw429,
      ok: modePass
    };
  }

  let backupRestore = null;
  if (args.runBackupRestore) {
    const databaseUrl = args.databaseUrl ?? normalizeOptionalString(process.env.DATABASE_URL);
    const restoreDatabaseUrl = args.restoreDatabaseUrl ?? normalizeOptionalString(process.env.RESTORE_DATABASE_URL);
    if (!databaseUrl || !restoreDatabaseUrl) {
      failures.push("backup/restore run requested but database URLs are missing");
      backupRestore = {
        source: "command",
        ok: false,
        error: "DATABASE_URL and RESTORE_DATABASE_URL are required"
      };
    } else {
      const sourceDbValidation = validateBackupRestoreDatabaseUrl(databaseUrl, { name: "DATABASE_URL" });
      const restoreDbValidation = validateBackupRestoreDatabaseUrl(restoreDatabaseUrl, { name: "RESTORE_DATABASE_URL" });
      if (!sourceDbValidation.ok || !restoreDbValidation.ok) {
        const reasons = [sourceDbValidation.reason, restoreDbValidation.reason].filter(Boolean);
        failures.push("backup/restore run requested but database URLs are invalid");
        backupRestore = {
          source: "command",
          ok: false,
          error: reasons.join("; ")
        };
      } else {
        backupRestore = runBackupRestoreDrill({
          tenantId: args.tenantId,
          databaseUrl,
          restoreDatabaseUrl,
          schema: args.backupRestoreSchema,
          jobs: args.backupRestoreJobs,
          month: args.backupRestoreMonth
        });
        if (backupRestore.ok !== true) failures.push("backup/restore drill failed");
      }
    }
  } else if (args.backupRestoreEvidencePath) {
    try {
      backupRestore = await loadBackupRestoreEvidenceFromPath(args.backupRestoreEvidencePath);
    } catch (err) {
      failures.push(`backup/restore evidence read failed: ${err?.message ?? String(err)}`);
      backupRestore = {
        source: "file",
        path: args.backupRestoreEvidencePath,
        ok: false,
        error: err?.message ?? String(err)
      };
    }
  }

  if (args.requireBackupRestore && !backupRestore) {
    failures.push("backup/restore evidence is required but missing");
  }

  const reportCore = normalizeForCanonicalJson({
    type: "HostedBaselineEvidence.v1",
    v: 1,
    capturedAt: new Date().toISOString(),
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    inputs: {
      baseUrl: args.baseUrl,
      tenantId: args.tenantId,
      environment: args.environment,
      requireBillingCatalog: args.requireBillingCatalog,
      requireMaintenanceSchedulers: args.requireMaintenanceSchedulers,
      requiredMetrics: args.requiredMetrics,
      rateLimitMode: args.rateLimitMode,
      rateLimitProbeRequests: args.rateLimitProbeRequests,
      rateLimitProbePath: args.rateLimitProbePath,
      runBackupRestore: args.runBackupRestore,
      backupRestoreEvidencePath: args.backupRestoreEvidencePath,
      requireBackupRestore: args.requireBackupRestore
    },
    checks: {
      healthz: {
        ok: healthzOk,
        statusCode: healthz.statusCode,
        body: healthz.body
      },
      opsStatus: {
        ok: opsStatusOk,
        statusCode: opsStatus.statusCode,
        maintenanceSchedulersEnabled: hasRequiredMaintenanceSchedulers,
        summary: opsStatusOk
          ? {
              process: {
                startedAt: opsStatus.body?.process?.startedAt ?? null,
                uptimeSeconds: opsStatus.body?.process?.uptimeSeconds ?? null
              },
              maintenance: opsStatus.body?.maintenance ?? null
            }
          : null
      },
      metrics: {
        ok: metricsOk,
        statusCode: metrics.statusCode,
        metricCount: metricNames.size,
        missingMetrics
      },
      billingCatalog: {
        ok: billingOk,
        statusCode: billingCatalog.statusCode,
        validation: billingValidation
      },
      rateLimitProbe,
      backupRestore
    }
  });

  const artifactHash = sha256Hex(canonicalJsonStringify(reportCore));
  const output = {
    ...reportCore,
    artifactHash
  };

  if (args.signingKeyFile) {
    const pem = await fs.readFile(path.resolve(args.signingKeyFile), "utf8");
    output.signature = {
      algorithm: "Ed25519",
      keyId: args.signatureKeyId ?? null,
      signatureBase64: signHashHexEd25519(artifactHash, pem)
    };
  }

  if (args.outPath) {
    const target = path.resolve(args.outPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(output, null, 2));
  process.exit(failures.length === 0 ? 0 : 2);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack ?? err?.message ?? String(err));
  process.exit(1);
});
