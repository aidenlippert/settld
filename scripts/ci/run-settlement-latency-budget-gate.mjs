#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMetricsRequestHeaders, getOne, loadMetricsText, parsePrometheusText } from "../slo/check.mjs";
import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";
import { sha256Hex } from "../../src/core/crypto.js";

const REPORT_SCHEMA_VERSION = "SettlementLatencyBudgetGateReport.v1";
const REPORT_HASH_SCOPE = "SettlementLatencyBudgetGateDeterministicCore.v1";
const DEFAULT_REPORT_PATH = "artifacts/gates/settlement-latency-budget-gate.json";

const LATENCY_ROUTE_SPECS = Object.freeze([
  {
    id: "policy_replay",
    route: "/runs/:runId/settlement/policy-replay",
    thresholdKey: "policyReplayP95MaxMs",
    metricCandidates: [
      { name: "run_settlement_policy_replay_latency_ms_p95_gauge" },
      { name: "run_settlement_read_latency_ms_p95_gauge", labels: { route: "policy_replay" } }
    ]
  },
  {
    id: "replay_evaluate",
    route: "/runs/:runId/settlement/replay-evaluate",
    thresholdKey: "replayEvaluateP95MaxMs",
    metricCandidates: [
      { name: "run_settlement_replay_evaluate_latency_ms_p95_gauge" },
      { name: "run_settlement_read_latency_ms_p95_gauge", labels: { route: "replay_evaluate" } }
    ]
  },
  {
    id: "explainability",
    route: "/runs/:runId/settlement/explainability",
    thresholdKey: "explainabilityP95MaxMs",
    metricCandidates: [
      { name: "run_settlement_explainability_latency_ms_p95_gauge" },
      { name: "run_settlement_read_latency_ms_p95_gauge", labels: { route: "explainability" } }
    ]
  }
]);

function usage() {
  return [
    "usage: node scripts/ci/run-settlement-latency-budget-gate.mjs [options]",
    "",
    "options:",
    "  --report <file>        Output report path (default: artifacts/gates/settlement-latency-budget-gate.json)",
    "  --metrics-file <file>  Metrics snapshot file (optional; otherwise fetch /metrics)",
    "  --api-base-url <url>   Base URL when fetching metrics (default: http://127.0.0.1:3000)",
    "  --metrics-path <path>  Metrics path (default: /metrics)",
    "  --strict               Treat threshold breaches as blocking failures",
    "  --warn-only            Always report threshold breaches as warnings",
    "  --help                 Show help",
    "",
    "threshold env vars:",
    "  SLO_SETTLEMENT_POLICY_REPLAY_P95_MAX_MS       (default: 800)",
    "  SLO_SETTLEMENT_REPLAY_EVALUATE_P95_MAX_MS     (default: 800)",
    "  SLO_SETTLEMENT_EXPLAINABILITY_P95_MAX_MS      (default: 1200)",
    "  SLO_SETTLEMENT_LATENCY_BUDGET_STRICT          (default: 0)"
  ].join("\n");
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseThresholdNumber(raw, fallback, name, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  if (value < min) throw new TypeError(`${name} must be >= ${min}`);
  if (Number.isFinite(max) && value > max) throw new TypeError(`${name} must be <= ${max}`);
  return value;
}

function parseBooleanLike(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "") return fallback;
  if (["1", "true", "yes", "on", "strict"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "warn"].includes(normalized)) return false;
  return fallback;
}

function cmpString(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function resolveThresholds(env = process.env) {
  return {
    policyReplayP95MaxMs: parseThresholdNumber(
      env.SLO_SETTLEMENT_POLICY_REPLAY_P95_MAX_MS,
      800,
      "SLO_SETTLEMENT_POLICY_REPLAY_P95_MAX_MS"
    ),
    replayEvaluateP95MaxMs: parseThresholdNumber(
      env.SLO_SETTLEMENT_REPLAY_EVALUATE_P95_MAX_MS,
      800,
      "SLO_SETTLEMENT_REPLAY_EVALUATE_P95_MAX_MS"
    ),
    explainabilityP95MaxMs: parseThresholdNumber(
      env.SLO_SETTLEMENT_EXPLAINABILITY_P95_MAX_MS,
      1200,
      "SLO_SETTLEMENT_EXPLAINABILITY_P95_MAX_MS"
    )
  };
}

export function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const envMetricsFile = normalizeOptionalString(env.SLO_SETTLEMENT_LATENCY_METRICS_FILE) ?? normalizeOptionalString(env.SLO_METRICS_FILE);
  const out = {
    help: false,
    reportPath: path.resolve(cwd, normalizeOptionalString(env.SETTLEMENT_LATENCY_BUDGET_REPORT_PATH) ?? DEFAULT_REPORT_PATH),
    metricsFile: envMetricsFile ? path.resolve(cwd, envMetricsFile) : null,
    apiBaseUrl: normalizeOptionalString(env.SLO_API_BASE_URL) ?? "http://127.0.0.1:3000",
    metricsPath: normalizeOptionalString(env.SLO_METRICS_PATH) ?? "/metrics",
    strictMode: parseBooleanLike(env.SLO_SETTLEMENT_LATENCY_BUDGET_STRICT, false)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? "").trim();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--report") {
      const value = normalizeOptionalString(argv[index + 1]);
      if (!value) throw new Error("--report requires a file path");
      out.reportPath = path.resolve(cwd, value);
      index += 1;
      continue;
    }
    if (arg === "--metrics-file") {
      const value = normalizeOptionalString(argv[index + 1]);
      if (!value) throw new Error("--metrics-file requires a file path");
      out.metricsFile = path.resolve(cwd, value);
      index += 1;
      continue;
    }
    if (arg === "--api-base-url") {
      const value = normalizeOptionalString(argv[index + 1]);
      if (!value) throw new Error("--api-base-url requires a URL");
      out.apiBaseUrl = value;
      index += 1;
      continue;
    }
    if (arg === "--metrics-path") {
      const value = normalizeOptionalString(argv[index + 1]);
      if (!value) throw new Error("--metrics-path requires a path");
      out.metricsPath = value;
      index += 1;
      continue;
    }
    if (arg === "--strict") {
      out.strictMode = true;
      continue;
    }
    if (arg === "--warn-only") {
      out.strictMode = false;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return out;
}

function firstFiniteMetric(series, candidates) {
  for (const candidate of candidates) {
    const value = getOne(series, {
      name: candidate.name,
      where: (labels) => {
        const expectedLabels = candidate.labels && typeof candidate.labels === "object" ? candidate.labels : null;
        if (!expectedLabels) return true;
        for (const [key, expected] of Object.entries(expectedLabels)) {
          const actual = typeof labels?.[key] === "string" ? labels[key] : null;
          if (actual !== expected) return false;
        }
        return true;
      }
    });
    if (Number.isFinite(value)) {
      return {
        metricName: candidate.name,
        labels: candidate.labels ?? null,
        value: Number(value)
      };
    }
  }
  return null;
}

function buildIssueId(prefix, routeId) {
  return `${prefix}_${routeId}`;
}

export function evaluateSettlementLatencyBudgets({ series, thresholds, strictMode }) {
  const checks = [];
  const warnings = [];
  const blockingIssues = [];

  for (const spec of LATENCY_ROUTE_SPECS) {
    const thresholdMs = Number(thresholds?.[spec.thresholdKey]);
    const metric = firstFiniteMetric(series, spec.metricCandidates);
    if (!metric) {
      const check = {
        id: `${spec.id}_p95_ms`,
        route: spec.route,
        routeId: spec.id,
        ok: false,
        thresholdMs,
        actualP95Ms: null,
        metricName: null,
        detail: "missing p95 latency metric for route",
        severity: "blocking"
      };
      checks.push(check);
      blockingIssues.push({
        id: buildIssueId("missing_metric", spec.id),
        route: spec.route,
        routeId: spec.id,
        thresholdMs,
        actualP95Ms: null,
        detail: check.detail
      });
      continue;
    }

    const exceeds = metric.value > thresholdMs;
    const warningOnly = exceeds && strictMode !== true;
    const check = {
      id: `${spec.id}_p95_ms`,
      route: spec.route,
      routeId: spec.id,
      ok: !exceeds || warningOnly,
      thresholdMs,
      actualP95Ms: metric.value,
      metricName: metric.metricName,
      metricLabels: metric.labels,
      detail: exceeds ? "p95 exceeded threshold" : "within threshold",
      severity: exceeds ? (warningOnly ? "warning" : "blocking") : "pass"
    };
    checks.push(check);

    if (warningOnly) {
      warnings.push({
        id: buildIssueId("latency_budget_warning", spec.id),
        route: spec.route,
        routeId: spec.id,
        thresholdMs,
        actualP95Ms: metric.value,
        metricName: metric.metricName,
        detail: "p95 latency exceeded configured threshold (warning mode)"
      });
      continue;
    }

    if (exceeds) {
      blockingIssues.push({
        id: buildIssueId("latency_budget_breach", spec.id),
        route: spec.route,
        routeId: spec.id,
        thresholdMs,
        actualP95Ms: metric.value,
        metricName: metric.metricName,
        detail: "p95 latency exceeded configured threshold (strict mode)"
      });
    }
  }

  checks.sort((left, right) => cmpString(left.id, right.id));
  warnings.sort((left, right) => cmpString(left.id, right.id));
  blockingIssues.sort((left, right) => cmpString(left.id, right.id));

  const missingMetricCount = checks.filter((row) => row.actualP95Ms === null).length;
  const breachedCount = checks.filter((row) => row.actualP95Ms !== null && Number(row.actualP95Ms) > Number(row.thresholdMs)).length;
  const ok = blockingIssues.length === 0;
  const status = ok ? (warnings.length > 0 ? "warn" : "pass") : "fail";

  return {
    checks,
    warnings,
    blockingIssues,
    summary: {
      totalChecks: checks.length,
      missingMetricCount,
      thresholdBreaches: breachedCount
    },
    verdict: {
      ok,
      status,
      blockingIssueCount: blockingIssues.length,
      warningCount: warnings.length
    }
  };
}

export function computeSettlementLatencyBudgetArtifactHash(report) {
  const normalizedChecks = Array.isArray(report?.checks)
    ? report.checks.map((row) =>
        normalizeForCanonicalJson(
          {
            id: row?.id ?? null,
            route: row?.route ?? null,
            routeId: row?.routeId ?? null,
            ok: row?.ok === true,
            thresholdMs: Number.isFinite(Number(row?.thresholdMs)) ? Number(row.thresholdMs) : null,
            actualP95Ms: Number.isFinite(Number(row?.actualP95Ms)) ? Number(row.actualP95Ms) : null,
            metricName: row?.metricName ?? null,
            metricLabels: row?.metricLabels ?? null,
            severity: row?.severity ?? null,
            detail: row?.detail ?? null
          },
          { path: "$" }
        )
      )
    : [];
  normalizedChecks.sort((left, right) => cmpString(left.id, right.id));

  const normalizeIssues = (issues) => {
    const rows = Array.isArray(issues) ? issues : [];
    const normalized = rows.map((issue) =>
      normalizeForCanonicalJson(
        {
          id: issue?.id ?? null,
          route: issue?.route ?? null,
          routeId: issue?.routeId ?? null,
          thresholdMs: Number.isFinite(Number(issue?.thresholdMs)) ? Number(issue.thresholdMs) : null,
          actualP95Ms: Number.isFinite(Number(issue?.actualP95Ms)) ? Number(issue.actualP95Ms) : null,
          metricName: issue?.metricName ?? null,
          detail: issue?.detail ?? null
        },
        { path: "$" }
      )
    );
    normalized.sort((left, right) => cmpString(left.id, right.id));
    return normalized;
  };

  const deterministicCore = normalizeForCanonicalJson(
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      artifactHashScope: REPORT_HASH_SCOPE,
      strictMode: report?.strictMode === true,
      thresholds: report?.thresholds ?? null,
      source: {
        metricsPath: report?.source?.metricsPath ?? null,
        metricsFile: report?.source?.metricsFile ?? null,
        apiBaseUrl: report?.source?.apiBaseUrl ?? null
      },
      checks: normalizedChecks,
      warnings: normalizeIssues(report?.warnings),
      blockingIssues: normalizeIssues(report?.blockingIssues),
      summary: report?.summary ?? null,
      verdict: report?.verdict ?? null
    },
    { path: "$" }
  );
  return sha256Hex(canonicalJsonStringify(deterministicCore));
}

export async function runSettlementLatencyBudgetGate(args, env = process.env, cwd = process.cwd()) {
  const thresholds = resolveThresholds(env);
  const metricsText = await loadMetricsText({
    metricsFile: args.metricsFile,
    apiBaseUrl: args.apiBaseUrl,
    metricsPath: args.metricsPath,
    requestHeaders: buildMetricsRequestHeaders(env),
    flushDelayMs: args.metricsFile ? 0 : 250
  });
  const series = parsePrometheusText(metricsText);
  const evaluation = evaluateSettlementLatencyBudgets({ series, thresholds, strictMode: args.strictMode === true });
  const report = normalizeForCanonicalJson(
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      strictMode: args.strictMode === true,
      thresholds,
      source: {
        metricsFile: args.metricsFile ? path.relative(cwd, args.metricsFile) : null,
        apiBaseUrl: args.metricsFile ? null : args.apiBaseUrl,
        metricsPath: args.metricsPath
      },
      checks: evaluation.checks,
      warnings: evaluation.warnings,
      blockingIssues: evaluation.blockingIssues,
      summary: evaluation.summary,
      verdict: evaluation.verdict,
      artifactHashScope: REPORT_HASH_SCOPE,
      artifactHash: null
    },
    { path: "$" }
  );
  report.artifactHash = computeSettlementLatencyBudgetArtifactHash(report);

  await mkdir(path.dirname(args.reportPath), { recursive: true });
  await writeFile(args.reportPath, `${canonicalJsonStringify(report)}\n`, "utf8");
  return { report, reportPath: args.reportPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env, process.cwd());
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const { report, reportPath } = await runSettlementLatencyBudgetGate(args, process.env, process.cwd());
  process.stdout.write(`${canonicalJsonStringify(report)}\n`);
  process.stdout.write(`wrote settlement latency budget gate report: ${reportPath}\n`);
  if (report?.verdict?.ok !== true) process.exitCode = 1;
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
