#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";
import { sha256Hex } from "../../src/core/crypto.js";

const REPORT_SCHEMA_VERSION = "MoneyRailsDegradedModeGateReport.v1";
const REPORT_HASH_SCOPE = "MoneyRailsDegradedModeGateDeterministicCore.v1";
const DEFAULT_REPORT_PATH = "artifacts/gates/money-rails-degraded-mode-gate.json";
const DEFAULT_TEST_FILE = "test/api-e2e-money-rails-degraded-mode.test.js";

function usage() {
  return [
    "usage: node scripts/ci/run-money-rails-degraded-mode-gate.mjs [options]",
    "",
    "options:",
    "  --report <file>      Output report path (default: artifacts/gates/money-rails-degraded-mode-gate.json)",
    "  --test-file <file>   Node test file to execute (default: test/api-e2e-money-rails-degraded-mode.test.js)",
    "  --node <path>        Node executable path (default: current process.execPath)",
    "  --help               Show help",
    "",
    "env fallbacks:",
    "  MONEY_RAILS_DEGRADED_MODE_GATE_REPORT_PATH",
    "  MONEY_RAILS_DEGRADED_MODE_TEST_FILE",
    "  MONEY_RAILS_DEGRADED_MODE_NODE_EXEC"
  ].join("\n");
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function cmpString(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function parseTapCounter(output, label) {
  const pattern = new RegExp(`(?:^|\\n)\\s*#\\s*${label}\\s+(\\d+)\\s*(?:\\n|$)`, "i");
  const match = pattern.exec(String(output ?? ""));
  if (!match) return null;
  const value = Number.parseInt(String(match[1]), 10);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function parseTapSummary(output) {
  const text = String(output ?? "");
  const tests = parseTapCounter(text, "tests");
  const pass = parseTapCounter(text, "pass");
  const fail = parseTapCounter(text, "fail");
  const skipped = parseTapCounter(text, "skipped");
  const todo = parseTapCounter(text, "todo");
  const cancelled = parseTapCounter(text, "cancelled");
  const hasAny = [tests, pass, fail, skipped, todo, cancelled].some((value) => Number.isSafeInteger(value));
  if (!hasAny) return null;
  return {
    tests: Number.isSafeInteger(tests) ? tests : null,
    pass: Number.isSafeInteger(pass) ? pass : null,
    fail: Number.isSafeInteger(fail) ? fail : null,
    skipped: Number.isSafeInteger(skipped) ? skipped : null,
    todo: Number.isSafeInteger(todo) ? todo : null,
    cancelled: Number.isSafeInteger(cancelled) ? cancelled : null
  };
}

function runMoneyRailsDegradedModeE2e({ nodeExec, testFile, cwd }) {
  const startedAtMs = Date.now();
  const res = spawnSync(nodeExec, ["--test", testFile], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024
  });
  const endedAtMs = Date.now();

  return {
    command: `${nodeExec} --test ${testFile}`,
    exitCode: Number.isInteger(res.status) ? res.status : 1,
    signal: res.signal ?? null,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
    error: res.error ? String(res.error?.message ?? res.error) : null
  };
}

function makeCheck({ id, ok, failureCode = null, detail = null }) {
  return {
    id,
    ok: ok === true,
    status: ok === true ? "pass" : "fail",
    ...(failureCode ? { failureCode } : {}),
    detail: detail ?? null
  };
}

export function evaluateMoneyRailsDegradedModeGate({ runResult }) {
  const outputCombined = `${String(runResult?.stdout ?? "")}${String(runResult?.stderr ?? "")}`;
  const tapSummary = parseTapSummary(outputCombined);

  const checks = [];

  checks.push(
    makeCheck({
      id: "money_rails_degraded_mode_test_exit_zero",
      ok: Number(runResult?.exitCode) === 0 && !runResult?.signal,
      failureCode: "DEGRADED_MODE_TEST_EXECUTION_FAILED",
      detail: {
        exitCode: Number.isInteger(runResult?.exitCode) ? runResult.exitCode : null,
        signal: runResult?.signal ?? null,
        error: runResult?.error ?? null
      }
    })
  );

  checks.push(
    makeCheck({
      id: "money_rails_degraded_mode_tap_summary_present",
      ok: Boolean(tapSummary),
      failureCode: "DEGRADED_MODE_TAP_SUMMARY_MISSING",
      detail: {
        hasTapSummary: Boolean(tapSummary)
      }
    })
  );

  const assertionsPassed =
    tapSummary &&
    Number.isInteger(tapSummary.fail) &&
    tapSummary.fail === 0 &&
    Number.isInteger(tapSummary.pass) &&
    tapSummary.pass > 0;

  checks.push(
    makeCheck({
      id: "money_rails_degraded_mode_assertions_passed",
      ok: Boolean(assertionsPassed),
      failureCode: "DEGRADED_MODE_ASSERTIONS_FAILED",
      detail: {
        tests: tapSummary?.tests ?? null,
        pass: tapSummary?.pass ?? null,
        fail: tapSummary?.fail ?? null,
        skipped: tapSummary?.skipped ?? null,
        todo: tapSummary?.todo ?? null,
        cancelled: tapSummary?.cancelled ?? null
      }
    })
  );

  checks.sort((a, b) => cmpString(a.id, b.id));

  const blockingIssues = checks
    .filter((row) => row.ok !== true)
    .map((row) => ({
      id: `money_rails_degraded_mode_gate:${row.id}`,
      code: row.failureCode ?? "DEGRADED_MODE_GATE_CHECK_FAILED",
      detail: row.detail ?? null
    }))
    .sort((a, b) => cmpString(a.id, b.id));

  const ok = blockingIssues.length === 0;

  return {
    checks,
    tapSummary,
    blockingIssues,
    verdict: {
      ok,
      status: ok ? "pass" : "fail",
      blockingIssueCount: blockingIssues.length
    }
  };
}

export function computeMoneyRailsDegradedModeGateArtifactHash(report) {
  const normalizedChecks = Array.isArray(report?.checks)
    ? report.checks
        .map((row) =>
          normalizeForCanonicalJson(
            {
              id: row?.id ?? null,
              ok: row?.ok === true,
              status: row?.status ?? null,
              failureCode: row?.failureCode ?? null,
              detail: row?.detail ?? null
            },
            { path: "$" }
          )
        )
        .sort((a, b) => cmpString(a.id, b.id))
    : [];

  const normalizedBlockingIssues = Array.isArray(report?.blockingIssues)
    ? report.blockingIssues
        .map((issue) =>
          normalizeForCanonicalJson(
            {
              id: issue?.id ?? null,
              code: issue?.code ?? null,
              detail: issue?.detail ?? null
            },
            { path: "$" }
          )
        )
        .sort((a, b) => cmpString(a.id, b.id))
    : [];

  const deterministicCore = normalizeForCanonicalJson(
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      artifactHashScope: REPORT_HASH_SCOPE,
      input: {
        testFile: report?.input?.testFile ?? null,
        nodeExec: report?.input?.nodeExec ?? null
      },
      execution: {
        command: report?.execution?.command ?? null,
        exitCode: Number.isInteger(report?.execution?.exitCode) ? report.execution.exitCode : null,
        signal: report?.execution?.signal ?? null,
        durationMs: Number.isSafeInteger(report?.execution?.durationMs) ? report.execution.durationMs : null,
        stdoutSha256: report?.execution?.stdoutSha256 ?? null,
        stderrSha256: report?.execution?.stderrSha256 ?? null,
        error: report?.execution?.error ?? null
      },
      tapSummary: report?.tapSummary ?? null,
      checks: normalizedChecks,
      blockingIssues: normalizedBlockingIssues,
      verdict: report?.verdict ?? null
    },
    { path: "$" }
  );
  return sha256Hex(canonicalJsonStringify(deterministicCore));
}

export function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const out = {
    help: false,
    reportPath: path.resolve(cwd, normalizeOptionalString(env.MONEY_RAILS_DEGRADED_MODE_GATE_REPORT_PATH) ?? DEFAULT_REPORT_PATH),
    testFile: path.resolve(cwd, normalizeOptionalString(env.MONEY_RAILS_DEGRADED_MODE_TEST_FILE) ?? DEFAULT_TEST_FILE),
    nodeExec: normalizeOptionalString(env.MONEY_RAILS_DEGRADED_MODE_NODE_EXEC) ?? process.execPath
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
    if (arg === "--test-file") {
      const value = normalizeOptionalString(argv[index + 1]);
      if (!value) throw new Error("--test-file requires a file path");
      out.testFile = path.resolve(cwd, value);
      index += 1;
      continue;
    }
    if (arg === "--node") {
      const value = normalizeOptionalString(argv[index + 1]);
      if (!value) throw new Error("--node requires an executable path");
      out.nodeExec = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return out;
}

export async function runMoneyRailsDegradedModeGate(args, env = process.env, cwd = process.cwd(), { runTestFn } = {}) {
  const execute = typeof runTestFn === "function" ? runTestFn : runMoneyRailsDegradedModeE2e;
  const runResult = await execute({ nodeExec: args.nodeExec, testFile: args.testFile, cwd, env });
  const evaluation = evaluateMoneyRailsDegradedModeGate({ runResult });

  const report = normalizeForCanonicalJson(
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      input: {
        testFile: path.relative(cwd, args.testFile),
        nodeExec: args.nodeExec
      },
      execution: {
        command: runResult.command,
        exitCode: runResult.exitCode,
        signal: runResult.signal,
        durationMs: runResult.durationMs,
        stdoutSha256: sha256Hex(runResult.stdout ?? ""),
        stderrSha256: sha256Hex(runResult.stderr ?? ""),
        stdoutPreview: String(runResult.stdout ?? "").slice(0, 4000),
        stderrPreview: String(runResult.stderr ?? "").slice(0, 4000),
        error: runResult.error ?? null
      },
      tapSummary: evaluation.tapSummary,
      checks: evaluation.checks,
      blockingIssues: evaluation.blockingIssues,
      verdict: evaluation.verdict,
      artifactHashScope: REPORT_HASH_SCOPE,
      artifactHash: null
    },
    { path: "$" }
  );

  report.artifactHash = computeMoneyRailsDegradedModeGateArtifactHash(report);

  await mkdir(path.dirname(args.reportPath), { recursive: true });
  await writeFile(args.reportPath, `${canonicalJsonStringify(report)}\n`, "utf8");

  return {
    report,
    reportPath: args.reportPath
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env, process.cwd());
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { report, reportPath } = await runMoneyRailsDegradedModeGate(args, process.env, process.cwd());
  process.stdout.write(`${canonicalJsonStringify(report)}\n`);
  process.stdout.write(`wrote money rails degraded mode gate report: ${reportPath}\n`);
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
