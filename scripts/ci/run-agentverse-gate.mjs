#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = "AgentverseGateReport.v1";
const DEFAULT_REPORT_PATH = "artifacts/gates/agentverse-gate.json";

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  return [
    "usage: node scripts/ci/run-agentverse-gate.mjs [options]",
    "",
    "options:",
    "  --out <file>        Report output path (default: artifacts/gates/agentverse-gate.json)",
    "  --help              Show help"
  ].join("\n");
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseArgs(argv, cwd = process.cwd()) {
  const out = {
    reportPath: path.resolve(cwd, DEFAULT_REPORT_PATH),
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "").trim();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--out") {
      const next = normalizeOptionalString(argv[i + 1]);
      if (!next) throw new Error("--out requires a file path");
      out.reportPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      const next = normalizeOptionalString(arg.slice("--out=".length));
      if (!next) throw new Error("--out requires a file path");
      out.reportPath = path.resolve(cwd, next);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return out;
}

function runCheck({ id, command, args = [] }) {
  const startedAt = nowIso();
  const res = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const completedAt = nowIso();
  const commandLine = `${command} ${args.join(" ")}`.trim();
  const stdout = String(res.stdout ?? "");
  const stderr = String(res.stderr ?? "");

  return {
    id,
    command: commandLine,
    startedAt,
    completedAt,
    ok: res.status === 0,
    exitCode: Number.isInteger(res.status) ? res.status : 1,
    signal: res.signal ?? null,
    stdoutPreview: stdout.slice(0, 2000),
    stderrPreview: stderr.slice(0, 2000)
  };
}

export function evaluateVerdict(checkRows) {
  const checks = Array.isArray(checkRows) ? checkRows : [];
  const totalChecks = checks.length;
  const passedChecks = checks.filter((row) => row?.ok === true).length;
  const failedChecks = totalChecks - passedChecks;
  const ok = totalChecks > 0 && failedChecks === 0;
  return {
    ok,
    status: ok ? "pass" : "fail_closed",
    requiredChecks: totalChecks,
    passedChecks,
    failedChecks
  };
}

function buildBlockingIssues(checkRows) {
  const out = [];
  for (const row of checkRows) {
    if (row?.ok === true) continue;
    out.push({
      checkId: row?.id ?? "unknown_check",
      reasonCode: "AGENTVERSE_GATE_CHECK_FAILED",
      message: `check ${row?.id ?? "unknown_check"} failed`,
      exitCode: Number.isInteger(row?.exitCode) ? row.exitCode : null
    });
  }
  return out;
}

export async function runAgentverseGate(args, options = {}) {
  const runCheckFn = typeof options.runCheckFn === "function" ? options.runCheckFn : runCheck;
  const startedAt = nowIso();

  const checks = [
    {
      id: "agentverse_bridge_import_smoke",
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        "await import('./src/agentverse/bridge/index.js'); await import('./src/agentverse/index.js');"
      ]
    },
    {
      id: "agentverse_unit_tests",
      command: process.execPath,
      args: [
        "--test",
        "test/agentverse/agent-daemon.test.js",
        "test/agentverse/agent-daemon-live-api.test.js",
        "test/agentverse/cli-commands.test.js",
        "test/agentverse/policy-engine.test.js",
        "test/agentverse/registry.test.js",
        "test/agentverse/scaffold-init.test.js",
        "test/agentverse/scaffold.test.js"
      ]
    },
    {
      id: "agentverse_cli_routing_smoke",
      command: process.execPath,
      args: ["--test", "test/cli-agentverse-routing.test.js"]
    },
    {
      id: "agentverse_build_pipeline_live_smoke",
      command: process.execPath,
      args: ["--test", "test/agentverse/agent-build-pipeline-smoke.test.js"]
    },
    {
      id: "agentverse_demo_sim_smoke",
      command: process.execPath,
      args: ["--test", "test/cli-agent-substrate-smoke.test.js"]
    }
  ];

  const rows = [];
  for (const check of checks) {
    let row = null;
    try {
      row = runCheckFn(check);
    } catch (err) {
      row = {
        id: check.id,
        command: `${check.command} ${(check.args ?? []).join(" ")}`.trim(),
        startedAt: nowIso(),
        completedAt: nowIso(),
        ok: false,
        exitCode: 1,
        signal: null,
        stdoutPreview: "",
        stderrPreview: String(err?.message ?? err).slice(0, 2000)
      };
    }
    rows.push(row);
  }

  const verdict = evaluateVerdict(rows);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
    startedAt,
    completedAt: nowIso(),
    ok: verdict.ok,
    checks: rows,
    blockingIssues: buildBlockingIssues(rows),
    summary: {
      totalChecks: verdict.requiredChecks,
      passedChecks: verdict.passedChecks,
      failedChecks: verdict.failedChecks
    },
    verdict
  };

  await mkdir(path.dirname(args.reportPath), { recursive: true });
  await writeFile(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return { report, reportPath: args.reportPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const { report, reportPath } = await runAgentverseGate(args);
    process.stdout.write(`agentverse gate report: ${reportPath}\n`);
    process.stdout.write(`agentverse gate verdict: ${report.verdict.status}\n`);
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`error: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
