#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const PRODUCTION_CUTOVER_GATE_SCHEMA_VERSION = "ProductionCutoverGateReport.v1";
const DEFAULT_GATE_REPORT_PATH = "artifacts/gates/production-cutover-gate.json";
const DEFAULT_MCP_HOST_SMOKE_REPORT_PATH = "artifacts/ops/mcp-host-smoke.json";
const DEFAULT_MCP_HOST_CERT_MATRIX_REPORT_PATH = "artifacts/ops/mcp-host-cert-matrix.json";
const DEFAULT_X402_HITL_SMOKE_REPORT_PATH = "artifacts/ops/x402-hitl-smoke.json";

function usage() {
  return [
    "usage: node scripts/ci/run-production-cutover-gate.mjs [options]",
    "",
    "options:",
    "  --report <file>      Gate report output path (default: artifacts/gates/production-cutover-gate.json)",
    "  --help               Show help"
  ].join("\n");
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toExitCode(code, signal) {
  if (Number.isInteger(code)) return code;
  if (signal) return 1;
  return 1;
}

export function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const out = {
    reportPath: path.resolve(cwd, normalizeOptionalString(env.PRODUCTION_CUTOVER_GATE_REPORT_PATH) ?? DEFAULT_GATE_REPORT_PATH),
    help: false
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
    throw new Error(`unknown argument: ${arg}`);
  }

  return out;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      server.close(() => {
        if (!Number.isInteger(port) || port <= 0) {
          reject(new Error("failed to allocate loopback port"));
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProc(child) {
  if (!child || typeof child.kill !== "function") return;
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(3000).then(() => false)
  ]);
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

async function waitForApiHealth({ baseUrl, child, timeoutMs = 30_000, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`ephemeral api exited before ready (${child.exitCode})`);
    }
    const response = await fetch(`${baseUrl}/healthz`).catch(() => null);
    if (response?.ok) return;
    await sleep(intervalMs);
  }
  throw new Error("ephemeral api readiness timed out");
}

function runNodeScript(scriptPath, args = [], { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: toExitCode(code, signal),
        signal
      });
    });
  });
}

function startNodeProc({ name, scriptPath, env }) {
  const logs = [];
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const push = (line) => {
    if (!line) return;
    logs.push(line);
    if (logs.length > 240) logs.shift();
  };
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) push(`[${name}:stdout] ${line}`);
  });
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) push(`[${name}:stderr] ${line}`);
  });
  return { child, logs };
}

async function startEphemeralApi(env = process.env) {
  const port = await pickPort();
  const opsToken = randomId("ops");
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = startNodeProc({
    name: "cutover-api",
    scriptPath: "src/api/server.js",
    env: {
      ...env,
      PORT: String(port),
      PROXY_BIND_HOST: "127.0.0.1",
      PROXY_OPS_TOKEN: opsToken,
      PROXY_AUTOTICK_INTERVAL_MS: "200"
    }
  });
  await waitForApiHealth({ baseUrl, child: api.child });
  return {
    ...api,
    baseUrl,
    opsToken,
    port
  };
}

function toStatus(exitCode) {
  return exitCode === 0 ? "passed" : "failed";
}

export function evaluateGateVerdict(checks) {
  const rows = Array.isArray(checks) ? checks : [];
  const passedChecks = rows.filter((row) => row?.status === "passed").length;
  const requiredChecks = rows.length;
  const failedChecks = requiredChecks - passedChecks;
  const ok = requiredChecks > 0 && failedChecks === 0;
  return {
    ok,
    status: ok ? "pass" : "fail",
    requiredChecks,
    passedChecks,
    failedChecks
  };
}

async function runCheck(check) {
  const startedAt = Date.now();
  let row = {
    id: check.id,
    label: check.label,
    status: "failed",
    exitCode: 1,
    reportPath: check.reportPath,
    durationMs: 0,
    command: [process.execPath, check.scriptPath, ...check.args]
  };
  try {
    const result = await runNodeScript(check.scriptPath, check.args, { env: check.env });
    row = {
      ...row,
      status: toStatus(result.exitCode),
      exitCode: result.exitCode
    };
  } catch (err) {
    row = {
      ...row,
      status: "failed",
      exitCode: 1,
      error: err?.message ?? String(err)
    };
  }
  return {
    ...row,
    durationMs: Date.now() - startedAt
  };
}

async function runX402HitlCheck({ reportPath, tenantId, protocol, env }) {
  const startedAt = Date.now();
  const row = {
    id: "x402_hitl_smoke",
    label: "x402 HITL escalation smoke",
    status: "failed",
    exitCode: 1,
    reportPath,
    durationMs: 0,
    command: [process.execPath, "scripts/ops/run-x402-hitl-smoke.mjs"]
  };

  let api = null;
  try {
    api = await startEphemeralApi(env);
    const args = ["--base-url", api.baseUrl, "--tenant-id", tenantId, "--protocol", protocol, "--ops-token", api.opsToken, "--out", reportPath];
    row.command = [process.execPath, "scripts/ops/run-x402-hitl-smoke.mjs", ...args];

    const result = await runNodeScript("scripts/ops/run-x402-hitl-smoke.mjs", args, { env });
    row.status = toStatus(result.exitCode);
    row.exitCode = result.exitCode;
    row.ephemeralApi = {
      baseUrl: api.baseUrl,
      port: api.port,
      started: true
    };
  } catch (err) {
    row.status = "failed";
    row.exitCode = 1;
    row.error = err?.message ?? String(err);
    if (api?.baseUrl) {
      row.ephemeralApi = {
        baseUrl: api.baseUrl,
        port: api.port,
        started: true,
        logsTail: api.logs.slice(-40)
      };
    }
  } finally {
    if (api?.child) {
      await stopProc(api.child);
      row.ephemeralApi = {
        ...(row.ephemeralApi ?? {
          baseUrl: api.baseUrl,
          port: api.port,
          started: true
        }),
        stopped: true
      };
    }
    row.durationMs = Date.now() - startedAt;
  }

  return row;
}

export async function runProductionCutoverGate(args, env = process.env, cwd = process.cwd()) {
  const startedAt = Date.now();
  const mcpHostSmokeReportPath = path.resolve(cwd, normalizeOptionalString(env.MCP_HOST_SMOKE_REPORT_PATH) ?? DEFAULT_MCP_HOST_SMOKE_REPORT_PATH);
  const mcpHostCertMatrixReportPath = path.resolve(
    cwd,
    normalizeOptionalString(env.MCP_HOST_CERT_MATRIX_REPORT_PATH) ?? DEFAULT_MCP_HOST_CERT_MATRIX_REPORT_PATH
  );
  const x402HitlSmokeReportPath = path.resolve(cwd, normalizeOptionalString(env.X402_HITL_SMOKE_REPORT_PATH) ?? DEFAULT_X402_HITL_SMOKE_REPORT_PATH);
  const tenantId = normalizeOptionalString(env.SETTLD_TENANT_ID) ?? "tenant_default";
  const protocol = normalizeOptionalString(env.SETTLD_PROTOCOL) ?? "1.0";

  const checks = [];

  checks.push(
    await runCheck({
      id: "mcp_host_runtime_smoke",
      label: "MCP host runtime smoke",
      scriptPath: "scripts/ci/run-mcp-host-smoke.mjs",
      args: [],
      env: { ...env, MCP_HOST_SMOKE_REPORT_PATH: mcpHostSmokeReportPath },
      reportPath: mcpHostSmokeReportPath
    })
  );

  checks.push(
    await runCheck({
      id: "mcp_host_cert_matrix",
      label: "MCP host certification matrix",
      scriptPath: "scripts/ci/run-mcp-host-cert-matrix.mjs",
      args: ["--report", mcpHostCertMatrixReportPath],
      env,
      reportPath: mcpHostCertMatrixReportPath
    })
  );

  checks.push(
    await runX402HitlCheck({
      reportPath: x402HitlSmokeReportPath,
      tenantId,
      protocol,
      env
    })
  );

  const verdict = evaluateGateVerdict(checks);
  const report = {
    schemaVersion: PRODUCTION_CUTOVER_GATE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    checks,
    verdict
  };

  await mkdir(path.dirname(args.reportPath), { recursive: true });
  await writeFile(args.reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  return { report, reportPath: args.reportPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { report, reportPath } = await runProductionCutoverGate(args, process.env, process.cwd());
  process.stdout.write(`wrote production cutover gate report: ${reportPath}\n`);
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
