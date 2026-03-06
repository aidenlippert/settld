import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePrometheusText } from "../scripts/slo/check.mjs";
import {
  computeSettlementLatencyBudgetArtifactHash,
  evaluateSettlementLatencyBudgets,
  parseArgs,
  resolveThresholds,
  runSettlementLatencyBudgetGate
} from "../scripts/ci/run-settlement-latency-budget-gate.mjs";

test("settlement latency budget gate parser: resolves env defaults and strict override flags", () => {
  const cwd = "/tmp/nooterra";
  const args = parseArgs(
    ["--report", "artifacts/custom/settlement-latency-gate.json", "--strict"],
    {
      SETTLEMENT_LATENCY_BUDGET_REPORT_PATH: "artifacts/gates/default-settlement-latency.json",
      SLO_API_BASE_URL: "http://localhost:3030"
    },
    cwd
  );
  assert.equal(args.reportPath, path.resolve(cwd, "artifacts/custom/settlement-latency-gate.json"));
  assert.equal(args.apiBaseUrl, "http://localhost:3030");
  assert.equal(args.strictMode, true);
});

test("settlement latency budget evaluator: passes when p95 is within thresholds", () => {
  const thresholds = resolveThresholds({
    SLO_SETTLEMENT_POLICY_REPLAY_P95_MAX_MS: "700",
    SLO_SETTLEMENT_REPLAY_EVALUATE_P95_MAX_MS: "700",
    SLO_SETTLEMENT_EXPLAINABILITY_P95_MAX_MS: "1000"
  });
  const series = parsePrometheusText(
    [
      "run_settlement_policy_replay_latency_ms_p95_gauge 640",
      "run_settlement_replay_evaluate_latency_ms_p95_gauge 680",
      "run_settlement_explainability_latency_ms_p95_gauge 900"
    ].join("\n")
  );
  const result = evaluateSettlementLatencyBudgets({ series, thresholds, strictMode: true });
  assert.equal(result.verdict.ok, true);
  assert.equal(result.verdict.status, "pass");
  assert.equal(result.blockingIssues.length, 0);
  assert.equal(result.warnings.length, 0);
});

test("settlement latency budget evaluator: emits warnings (not blocking) in warn-only mode", () => {
  const thresholds = resolveThresholds({
    SLO_SETTLEMENT_POLICY_REPLAY_P95_MAX_MS: "700",
    SLO_SETTLEMENT_REPLAY_EVALUATE_P95_MAX_MS: "700",
    SLO_SETTLEMENT_EXPLAINABILITY_P95_MAX_MS: "1000"
  });
  const series = parsePrometheusText(
    [
      "run_settlement_policy_replay_latency_ms_p95_gauge 701",
      "run_settlement_replay_evaluate_latency_ms_p95_gauge 702",
      "run_settlement_explainability_latency_ms_p95_gauge 1001"
    ].join("\n")
  );
  const result = evaluateSettlementLatencyBudgets({ series, thresholds, strictMode: false });
  assert.equal(result.verdict.ok, true);
  assert.equal(result.verdict.status, "warn");
  assert.equal(result.blockingIssues.length, 0);
  assert.equal(result.warnings.length, 3);
});

test("settlement latency budget evaluator: fails on threshold breaches in strict mode", () => {
  const thresholds = resolveThresholds({
    SLO_SETTLEMENT_POLICY_REPLAY_P95_MAX_MS: "700",
    SLO_SETTLEMENT_REPLAY_EVALUATE_P95_MAX_MS: "700",
    SLO_SETTLEMENT_EXPLAINABILITY_P95_MAX_MS: "1000"
  });
  const series = parsePrometheusText(
    [
      "run_settlement_policy_replay_latency_ms_p95_gauge 760",
      "run_settlement_replay_evaluate_latency_ms_p95_gauge 740",
      "run_settlement_explainability_latency_ms_p95_gauge 1100"
    ].join("\n")
  );
  const result = evaluateSettlementLatencyBudgets({ series, thresholds, strictMode: true });
  assert.equal(result.verdict.ok, false);
  assert.equal(result.verdict.status, "fail");
  assert.equal(result.blockingIssues.length, 3);
});

test("settlement latency budget evaluator: fails closed when a required route metric is missing", () => {
  const thresholds = resolveThresholds({
    SLO_SETTLEMENT_POLICY_REPLAY_P95_MAX_MS: "700",
    SLO_SETTLEMENT_REPLAY_EVALUATE_P95_MAX_MS: "700",
    SLO_SETTLEMENT_EXPLAINABILITY_P95_MAX_MS: "1000"
  });
  const series = parsePrometheusText(
    [
      "run_settlement_policy_replay_latency_ms_p95_gauge 640",
      "run_settlement_explainability_latency_ms_p95_gauge 900"
    ].join("\n")
  );
  const result = evaluateSettlementLatencyBudgets({ series, thresholds, strictMode: false });
  assert.equal(result.verdict.ok, false);
  assert.equal(result.blockingIssues.some((issue) => issue.id === "missing_metric_replay_evaluate"), true);
});

test("settlement latency budget gate runner: writes report and stable artifact hash", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-settlement-latency-gate-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const metricsPath = path.join(tmpRoot, "metrics.prom");
  const reportPath = path.join(tmpRoot, "out", "settlement-latency-budget-gate.json");

  await fs.writeFile(
    metricsPath,
    [
      "run_settlement_policy_replay_latency_ms_p95_gauge 650",
      "run_settlement_replay_evaluate_latency_ms_p95_gauge 680",
      "run_settlement_explainability_latency_ms_p95_gauge 850"
    ].join("\n") + "\n",
    "utf8"
  );

  const { report } = await runSettlementLatencyBudgetGate(
    {
      help: false,
      reportPath,
      metricsFile: metricsPath,
      apiBaseUrl: "http://127.0.0.1:3000",
      metricsPath: "/metrics",
      strictMode: true
    },
    {
      SLO_SETTLEMENT_POLICY_REPLAY_P95_MAX_MS: "700",
      SLO_SETTLEMENT_REPLAY_EVALUATE_P95_MAX_MS: "700",
      SLO_SETTLEMENT_EXPLAINABILITY_P95_MAX_MS: "1000"
    },
    tmpRoot
  );

  assert.equal(report.schemaVersion, "SettlementLatencyBudgetGateReport.v1");
  assert.equal(report.verdict.ok, true);
  assert.equal(report.artifactHash, computeSettlementLatencyBudgetArtifactHash(report));

  const mutated = { ...report, generatedAt: "2099-01-01T00:00:00.000Z" };
  assert.equal(computeSettlementLatencyBudgetArtifactHash(mutated), report.artifactHash);
});
