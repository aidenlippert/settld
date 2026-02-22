#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";
import { sha256Hex } from "../../src/core/crypto.js";
import { SUPPORTED_HOSTS } from "../setup/host-config.mjs";

const REPORT_SCHEMA_VERSION = "OnboardingHostSuccessGateReport.v1";
const ARTIFACT_HASH_SCOPE = "OnboardingHostSuccessGateDeterministicCore.v1";
const DEFAULT_REPORT_PATH = "artifacts/gates/onboarding-host-success-gate.json";
const DEFAULT_METRICS_DIR = "artifacts/ops/onboarding-host-success";
const DEFAULT_ATTEMPTS_PER_HOST = 1;
const DEFAULT_MIN_SUCCESS_RATE_PCT = 90;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PROFILE_ID = "engineering-spend";
const DEFAULT_HOSTS = Object.freeze([...SUPPORTED_HOSTS]);
const SETTLD_BIN = path.resolve(process.cwd(), "bin", "settld.js");

function usage() {
  return [
    "usage: node scripts/ci/run-onboarding-host-success-gate.mjs [options]",
    "",
    "options:",
    "  --report <file>              Output report path (default: artifacts/gates/onboarding-host-success-gate.json)",
    "  --metrics-dir <dir>          Metrics directory (default: artifacts/ops/onboarding-host-success)",
    "  --hosts <csv>                Hosts to test (default: codex,claude,cursor,openclaw)",
    "  --attempts <n>               Attempts per host (default: 1)",
    "  --min-success-rate-pct <n>   Minimum pass rate per host in percent (default: 90)",
    "  --timeout-ms <n>             Per-attempt timeout (default: 60000)",
    "  --base-url <url>             Settld API URL (required)",
    "  --tenant-id <id>             Tenant ID (required)",
    "  --api-key <key>              Tenant API key (required)",
    "  --profile-id <id>            Starter profile ID (default: engineering-spend)",
    "  --clean-home-root <dir>      Root dir for isolated HOME per attempt (default: os tmpdir)",
    "  --help                       Show help",
    "",
    "env fallbacks:",
    "  ONBOARDING_HOST_SUCCESS_GATE_REPORT_PATH",
    "  ONBOARDING_HOST_SUCCESS_METRICS_DIR",
    "  ONBOARDING_HOST_SUCCESS_HOSTS",
    "  ONBOARDING_HOST_SUCCESS_ATTEMPTS",
    "  ONBOARDING_HOST_SUCCESS_RATE_MIN_PCT",
    "  ONBOARDING_HOST_SUCCESS_TIMEOUT_MS",
    "  ONBOARDING_PROFILE_ID",
    "  ONBOARDING_CLEAN_HOME_ROOT",
    "  SETTLD_BASE_URL / SETTLD_RUNTIME_BASE_URL / SETTLD_RUNTIME_URL / SETTLD_API_URL",
    "  SETTLD_TENANT_ID / SETTLD_RUNTIME_TENANT_ID",
    "  SETTLD_API_KEY / SETTLD_RUNTIME_BEARER_TOKEN / SETTLD_BEARER_TOKEN / SETTLD_TOKEN"
  ].join("\n");
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toPositiveInt(value, fieldName, fallback) {
  const resolved = normalizeOptionalString(value);
  if (resolved === null) return fallback;
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be an integer >= 1`);
  }
  return parsed;
}

function toPercent(value, fieldName, fallback) {
  const resolved = normalizeOptionalString(value);
  if (resolved === null) return fallback;
  const parsed = Number(resolved);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${fieldName} must be between 0 and 100`);
  }
  return parsed;
}

function normalizeHttpUrl(value, fieldName) {
  const raw = normalizeOptionalString(value);
  if (!raw) throw new Error(`${fieldName} is required`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http(s)`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

function parseHostsCsv(value) {
  const raw = normalizeOptionalString(value);
  if (!raw) return [...DEFAULT_HOSTS];
  const seen = new Set();
  const out = [];
  for (const part of raw.split(",")) {
    const host = String(part).trim().toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  if (!out.length) throw new Error("--hosts must contain at least one host");
  for (const host of out) {
    if (!SUPPORTED_HOSTS.includes(host)) {
      throw new Error(`unsupported host in --hosts: ${host}`);
    }
  }
  return out;
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
}

function summarizeText(text, limit = 260) {
  const value = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function buildOnboardingArgs({ host, baseUrl, tenantId, apiKey, profileId }) {
  return [
    SETTLD_BIN,
    "setup",
    "--non-interactive",
    "--host",
    host,
    "--base-url",
    baseUrl,
    "--tenant-id",
    tenantId,
    "--settld-api-key",
    apiKey,
    "--wallet-mode",
    "none",
    "--profile-id",
    profileId,
    "--preflight-only",
    "--no-smoke",
    "--format",
    "json"
  ];
}

function evaluateAttemptResult({ statusCode, stdout, stderr, durationMs }) {
  const parsed = parseJsonOrNull(stdout);
  if (statusCode !== 0) {
    return {
      ok: false,
      detail: summarizeText(stderr || stdout) || `exit ${statusCode}`,
      parsed,
      durationMs
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      detail: "onboarding output is not valid JSON",
      parsed,
      durationMs
    };
  }
  const requiredChecks = new Set(["api_health", "tenant_auth", "profile_policy", "host_config"]);
  const presentChecks = new Set(
    Array.isArray(parsed?.preflight?.checks)
      ? parsed.preflight.checks.map((row) => String(row?.name ?? "").trim()).filter(Boolean)
      : []
  );
  const missingChecks = [...requiredChecks].filter((check) => !presentChecks.has(check));
  if (parsed.ok !== true || parsed.preflightOnly !== true || parsed?.preflight?.ok !== true || missingChecks.length > 0) {
    const missingText = missingChecks.length ? `missing preflight checks: ${missingChecks.join(", ")}` : "preflight output not ok";
    return {
      ok: false,
      detail: missingText,
      parsed,
      durationMs
    };
  }
  return {
    ok: true,
    detail: "onboarding preflight passed",
    parsed,
    durationMs
  };
}

export async function runOnboardingHostAttempt({
  host,
  attempt,
  baseUrl,
  tenantId,
  apiKey,
  profileId,
  timeoutMs,
  cleanHomeRoot = null
} = {}) {
  const root = cleanHomeRoot ? path.resolve(cleanHomeRoot) : os.tmpdir();
  const tempHome = await mkdtemp(path.join(root, `settld-onboard-${host}-a${attempt}-`));
  const startedAt = Date.now();
  try {
    const result = spawnSync(process.execPath, buildOnboardingArgs({ host, baseUrl, tenantId, apiKey, profileId }), {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome
      },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1_048_576,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const durationMs = Date.now() - startedAt;
    if (result.error?.code === "ETIMEDOUT") {
      return {
        ok: false,
        detail: `attempt timed out after ${timeoutMs}ms`,
        durationMs
      };
    }
    return evaluateAttemptResult({
      statusCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

function roundRate(value) {
  return Math.round(value * 100) / 100;
}

function buildHostMetricsText(row) {
  const host = String(row.host ?? "");
  return [
    `onboarding_host_setup_attempts_total_gauge{host="${host}"} ${row.attempts}`,
    `onboarding_host_setup_success_total_gauge{host="${host}"} ${row.successes}`,
    `onboarding_host_setup_failure_total_gauge{host="${host}"} ${row.failures}`,
    `onboarding_host_setup_success_rate_pct_gauge{host="${host}"} ${row.successRatePct}`
  ].join("\n") + "\n";
}

export function evaluateHostSuccessVerdict(hosts, { minSuccessRatePct }) {
  const rows = Array.isArray(hosts) ? hosts : [];
  const requiredHosts = rows.length;
  const passedHosts = rows.filter((row) => row?.status === "passed").length;
  const failedHosts = requiredHosts - passedHosts;
  const ok = requiredHosts > 0 && failedHosts === 0;
  return {
    ok,
    status: ok ? "pass" : "fail",
    requiredHosts,
    passedHosts,
    failedHosts,
    minSuccessRatePct
  };
}

export function computeOnboardingHostSuccessArtifactHash(report) {
  const hosts = Array.isArray(report?.hosts) ? report.hosts : [];
  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      artifactHashScope: ARTIFACT_HASH_SCOPE,
      context: {
        attemptsPerHost: report?.context?.attemptsPerHost ?? null,
        minSuccessRatePct: report?.context?.minSuccessRatePct ?? null,
        hosts: report?.context?.hosts ?? []
      },
      hosts: hosts.map((row) => ({
        host: row?.host ?? null,
        attempts: row?.attempts ?? null,
        successes: row?.successes ?? null,
        failures: row?.failures ?? null,
        successRatePct: row?.successRatePct ?? null,
        status: row?.status ?? null
      })),
      verdict: report?.verdict ?? null
    },
    { path: "$" }
  );
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const out = {
    help: false,
    reportPath: path.resolve(cwd, normalizeOptionalString(env.ONBOARDING_HOST_SUCCESS_GATE_REPORT_PATH) ?? DEFAULT_REPORT_PATH),
    metricsDir: path.resolve(cwd, normalizeOptionalString(env.ONBOARDING_HOST_SUCCESS_METRICS_DIR) ?? DEFAULT_METRICS_DIR),
    hosts: parseHostsCsv(normalizeOptionalString(env.ONBOARDING_HOST_SUCCESS_HOSTS) ?? DEFAULT_HOSTS.join(",")),
    attemptsPerHost: toPositiveInt(env.ONBOARDING_HOST_SUCCESS_ATTEMPTS, "ONBOARDING_HOST_SUCCESS_ATTEMPTS", DEFAULT_ATTEMPTS_PER_HOST),
    minSuccessRatePct: toPercent(
      env.ONBOARDING_HOST_SUCCESS_RATE_MIN_PCT,
      "ONBOARDING_HOST_SUCCESS_RATE_MIN_PCT",
      DEFAULT_MIN_SUCCESS_RATE_PCT
    ),
    timeoutMs: toPositiveInt(env.ONBOARDING_HOST_SUCCESS_TIMEOUT_MS, "ONBOARDING_HOST_SUCCESS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    baseUrl: normalizeOptionalString(
      env.SETTLD_BASE_URL ?? env.SETTLD_RUNTIME_BASE_URL ?? env.SETTLD_RUNTIME_URL ?? env.SETTLD_API_URL
    ),
    tenantId: normalizeOptionalString(env.SETTLD_TENANT_ID ?? env.SETTLD_RUNTIME_TENANT_ID),
    apiKey: normalizeOptionalString(env.SETTLD_API_KEY ?? env.SETTLD_RUNTIME_BEARER_TOKEN ?? env.SETTLD_BEARER_TOKEN ?? env.SETTLD_TOKEN),
    profileId: normalizeOptionalString(env.ONBOARDING_PROFILE_ID) ?? DEFAULT_PROFILE_ID,
    cleanHomeRoot: normalizeOptionalString(env.ONBOARDING_CLEAN_HOME_ROOT)
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "").trim();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--report") {
      const value = normalizeOptionalString(argv[i + 1]);
      if (!value) throw new Error("--report requires a file path");
      out.reportPath = path.resolve(cwd, value);
      i += 1;
      continue;
    }
    if (arg === "--metrics-dir") {
      const value = normalizeOptionalString(argv[i + 1]);
      if (!value) throw new Error("--metrics-dir requires a directory path");
      out.metricsDir = path.resolve(cwd, value);
      i += 1;
      continue;
    }
    if (arg === "--hosts") {
      const value = normalizeOptionalString(argv[i + 1]);
      if (!value) throw new Error("--hosts requires a csv value");
      out.hosts = parseHostsCsv(value);
      i += 1;
      continue;
    }
    if (arg === "--attempts") {
      out.attemptsPerHost = toPositiveInt(argv[i + 1], "--attempts", DEFAULT_ATTEMPTS_PER_HOST);
      i += 1;
      continue;
    }
    if (arg === "--min-success-rate-pct") {
      out.minSuccessRatePct = toPercent(argv[i + 1], "--min-success-rate-pct", DEFAULT_MIN_SUCCESS_RATE_PCT);
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      out.timeoutMs = toPositiveInt(argv[i + 1], "--timeout-ms", DEFAULT_TIMEOUT_MS);
      i += 1;
      continue;
    }
    if (arg === "--base-url") {
      out.baseUrl = normalizeOptionalString(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--tenant-id") {
      out.tenantId = normalizeOptionalString(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--api-key") {
      out.apiKey = normalizeOptionalString(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--profile-id") {
      out.profileId = normalizeOptionalString(argv[i + 1]) ?? DEFAULT_PROFILE_ID;
      i += 1;
      continue;
    }
    if (arg === "--clean-home-root") {
      const value = normalizeOptionalString(argv[i + 1]);
      if (!value) throw new Error("--clean-home-root requires a directory path");
      out.cleanHomeRoot = path.resolve(cwd, value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!out.help) {
    out.baseUrl = normalizeHttpUrl(out.baseUrl, "--base-url");
    if (!out.tenantId) throw new Error("--tenant-id is required");
    if (!out.apiKey) throw new Error("--api-key is required");
  }

  return out;
}

export async function runOnboardingHostSuccessGate(args, env = process.env, cwd = process.cwd(), deps = {}) {
  const runAttempt = deps.runAttempt ?? runOnboardingHostAttempt;
  const generatedAt = new Date().toISOString();
  const hostRows = [];
  const blockingIssues = [];

  for (const host of args.hosts) {
    const attempts = [];
    for (let index = 1; index <= args.attemptsPerHost; index += 1) {
      const attempt = await runAttempt({
        host,
        attempt: index,
        baseUrl: args.baseUrl,
        tenantId: args.tenantId,
        apiKey: args.apiKey,
        profileId: args.profileId,
        timeoutMs: args.timeoutMs,
        cleanHomeRoot: args.cleanHomeRoot,
        env,
        cwd
      });
      attempts.push({
        attempt: index,
        ok: attempt.ok === true,
        durationMs: Number(attempt.durationMs ?? 0),
        detail: String(attempt.detail ?? "")
      });
    }
    const successes = attempts.filter((row) => row.ok === true).length;
    const failures = attempts.length - successes;
    const successRatePct = attempts.length > 0 ? roundRate((successes / attempts.length) * 100) : 0;
    const status = successRatePct >= args.minSuccessRatePct ? "passed" : "failed";
    const row = {
      host,
      attempts: attempts.length,
      successes,
      failures,
      successRatePct,
      status,
      runs: attempts
    };
    hostRows.push(row);
    if (status !== "passed") {
      const firstFailure = attempts.find((attempt) => attempt.ok !== true);
      blockingIssues.push({
        host,
        code: "host_success_rate_below_threshold",
        detail:
          firstFailure?.detail ||
          `host success rate ${successRatePct}% below threshold ${args.minSuccessRatePct}%`
      });
    }
  }

  hostRows.sort((left, right) => String(left.host).localeCompare(String(right.host)));
  const verdict = evaluateHostSuccessVerdict(hostRows, { minSuccessRatePct: args.minSuccessRatePct });

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt,
    artifactHashScope: ARTIFACT_HASH_SCOPE,
    context: {
      baseUrl: args.baseUrl,
      tenantId: args.tenantId,
      profileId: args.profileId,
      attemptsPerHost: args.attemptsPerHost,
      minSuccessRatePct: args.minSuccessRatePct,
      timeoutMs: args.timeoutMs,
      hosts: [...args.hosts]
    },
    hosts: hostRows,
    blockingIssues,
    verdict
  };
  report.artifactHash = computeOnboardingHostSuccessArtifactHash(report);

  await mkdir(path.dirname(args.reportPath), { recursive: true });
  await writeFile(args.reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  await mkdir(args.metricsDir, { recursive: true });
  for (const row of hostRows) {
    const metricsPath = path.join(args.metricsDir, `${row.host}.prom`);
    await writeFile(metricsPath, buildHostMetricsText(row), "utf8");
  }

  return { report, reportPath: args.reportPath, metricsDir: args.metricsDir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env, process.cwd());
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const { report, reportPath, metricsDir } = await runOnboardingHostSuccessGate(args, process.env, process.cwd());
  process.stdout.write(`wrote onboarding host success gate report: ${reportPath}\n`);
  process.stdout.write(`wrote onboarding host success metrics: ${metricsDir}\n`);
  if (!report.verdict.ok) process.exitCode = 1;
}

const isDirectExecution = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
