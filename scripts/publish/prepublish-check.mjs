#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = "AgentversePrepublishCheckReport.v1";
const DEFAULT_REPORT_PATH = "artifacts/publish/prepublish-check.json";

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  return [
    "usage: node scripts/publish/prepublish-check.mjs [options]",
    "",
    "options:",
    "  --out <file>   Report output path (default: artifacts/publish/prepublish-check.json)",
    "  --help         Show help"
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
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && command === "npm"
  });
  const completedAt = nowIso();
  return {
    id,
    command: `${command} ${args.join(" ")}`.trim(),
    startedAt,
    completedAt,
    ok: result.status === 0,
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    signal: result.signal ?? null,
    stdoutPreview: String(result.stdout ?? "").slice(0, 2000),
    stderrPreview: String(result.stderr ?? "").slice(0, 2000)
  };
}

function evaluateVerdict(checkRows) {
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
  return checkRows
    .filter((row) => row?.ok !== true)
    .map((row) => ({
      checkId: row?.id ?? "unknown_check",
      reasonCode: "PREPUBLISH_CHECK_FAILED",
      message: `check ${row?.id ?? "unknown_check"} failed`,
      exitCode: Number.isInteger(row?.exitCode) ? row.exitCode : null
    }));
}

export async function runPrepublishCheck(args, options = {}) {
  const runCheckFn = typeof options.runCheckFn === "function" ? options.runCheckFn : runCheck;

  const checks = [
    {
      id: "version_consistency",
      command: process.execPath,
      args: ["scripts/ci/check-version-consistency.mjs"]
    },
    {
      id: "agentverse_bridge_import_smoke",
      command: process.execPath,
      args: ["--input-type=module", "-e", "await import('./src/agentverse/bridge/index.js');"]
    },
    {
      id: "agentverse_gate",
      command: process.execPath,
      args: ["scripts/ci/run-agentverse-gate.mjs", "--out", "artifacts/gates/agentverse-gate.prepublish.json"]
    },
    {
      id: "npm_pack_dry_run",
      command: "npm",
      args: ["pack", "--dry-run"]
    }
  ];

  const rows = checks.map((check) => {
    try {
      return runCheckFn(check);
    } catch (err) {
      return {
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
  });

  const verdict = evaluateVerdict(rows);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
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
    const { report, reportPath } = await runPrepublishCheck(args);
    process.stdout.write(`prepublish check report: ${reportPath}\n`);
    process.stdout.write(`prepublish check verdict: ${report.verdict.status}\n`);
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`error: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
