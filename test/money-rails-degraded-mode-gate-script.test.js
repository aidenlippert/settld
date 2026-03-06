import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeMoneyRailsDegradedModeGateArtifactHash,
  evaluateMoneyRailsDegradedModeGate,
  parseArgs,
  parseTapSummary,
  runMoneyRailsDegradedModeGate
} from "../scripts/ci/run-money-rails-degraded-mode-gate.mjs";

test("money rails degraded mode gate parser: resolves defaults and cli overrides", () => {
  const cwd = "/tmp/nooterra";
  const args = parseArgs(
    ["--report", "artifacts/custom/degraded-gate.json", "--test-file", "test/custom.test.js", "--node", "/opt/node"],
    {
      MONEY_RAILS_DEGRADED_MODE_GATE_REPORT_PATH: "artifacts/gates/default.json",
      MONEY_RAILS_DEGRADED_MODE_TEST_FILE: "test/default.test.js"
    },
    cwd
  );

  assert.equal(args.reportPath, path.resolve(cwd, "artifacts/custom/degraded-gate.json"));
  assert.equal(args.testFile, path.resolve(cwd, "test/custom.test.js"));
  assert.equal(args.nodeExec, "/opt/node");
});

test("money rails degraded mode gate tap parser: extracts summary counters", () => {
  const parsed = parseTapSummary(
    [
      "TAP version 13",
      "1..2",
      "# tests 2",
      "# pass 2",
      "# fail 0",
      "# skipped 0",
      "# todo 0",
      "# cancelled 0"
    ].join("\n")
  );

  assert.deepEqual(parsed, {
    tests: 2,
    pass: 2,
    fail: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0
  });
});

test("money rails degraded mode gate evaluator: passes when e2e exits cleanly with zero fails", () => {
  const result = evaluateMoneyRailsDegradedModeGate({
    runResult: {
      exitCode: 0,
      signal: null,
      error: null,
      stdout: ["# tests 2", "# pass 2", "# fail 0"].join("\n"),
      stderr: "",
      durationMs: 123,
      command: "node --test test/api-e2e-money-rails-degraded-mode.test.js"
    }
  });

  assert.equal(result.verdict.ok, true);
  assert.equal(result.verdict.status, "pass");
  assert.equal(result.blockingIssues.length, 0);
});

test("money rails degraded mode gate evaluator: fails closed on non-zero test execution", () => {
  const result = evaluateMoneyRailsDegradedModeGate({
    runResult: {
      exitCode: 1,
      signal: null,
      error: "boom",
      stdout: "",
      stderr: "fatal",
      durationMs: 42,
      command: "node --test test/api-e2e-money-rails-degraded-mode.test.js"
    }
  });

  assert.equal(result.verdict.ok, false);
  assert.equal(result.blockingIssues.some((issue) => issue.code === "DEGRADED_MODE_TEST_EXECUTION_FAILED"), true);
  assert.equal(result.blockingIssues.some((issue) => issue.code === "DEGRADED_MODE_TAP_SUMMARY_MISSING"), true);
  assert.equal(result.blockingIssues.some((issue) => issue.code === "DEGRADED_MODE_ASSERTIONS_FAILED"), true);
});

test("money rails degraded mode gate runner: writes report and stable artifact hash", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-money-rails-degraded-gate-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const reportPath = path.join(tmpRoot, "out", "money-rails-degraded-mode-gate.json");

  const { report } = await runMoneyRailsDegradedModeGate(
    {
      help: false,
      reportPath,
      testFile: path.join(tmpRoot, "fake.test.js"),
      nodeExec: process.execPath
    },
    process.env,
    tmpRoot,
    {
      runTestFn: async () => ({
        command: "node --test fake.test.js",
        exitCode: 0,
        signal: null,
        durationMs: 88,
        stdout: ["# tests 2", "# pass 2", "# fail 0"].join("\n"),
        stderr: "",
        error: null
      })
    }
  );

  assert.equal(report.schemaVersion, "MoneyRailsDegradedModeGateReport.v1");
  assert.equal(report.verdict.ok, true);
  assert.equal(report.artifactHash, computeMoneyRailsDegradedModeGateArtifactHash(report));

  const loaded = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(loaded.schemaVersion, "MoneyRailsDegradedModeGateReport.v1");

  const mutated = { ...report, generatedAt: "2099-01-01T00:00:00.000Z" };
  assert.equal(computeMoneyRailsDegradedModeGateArtifactHash(mutated), report.artifactHash);
});
