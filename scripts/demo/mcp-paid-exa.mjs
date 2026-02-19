#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { canonicalJsonStringify } from "../../src/core/canonical-json.js";
import { sha256Hex } from "../../src/core/crypto.js";
import { verifySettldPayTokenV1 } from "../../src/core/settld-pay-token.js";
import { computeToolProviderSignaturePayloadHashV1, verifyToolProviderSignatureV1 } from "../../src/core/tool-provider-signature.js";
import { verifyX402ReceiptRecord } from "../../src/core/x402-receipt-verifier.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/demo/mcp-paid-exa.mjs [--circle <stub|sandbox|production>] [--workload <exa|weather|llm>]",
    "  node scripts/demo/mcp-paid-exa.mjs --circle=sandbox",
    "  node scripts/demo/mcp-paid-exa.mjs --workload=weather",
    "  node scripts/demo/mcp-paid-exa.mjs --workload=llm",
    "",
    "Environment overrides:",
    "  SETTLD_DEMO_CIRCLE_MODE=stub|sandbox|production",
    "  SETTLD_DEMO_WORKLOAD=exa|weather|llm",
    "  SETTLD_DEMO_RUN_BATCH_SETTLEMENT=1",
    "  SETTLD_DEMO_BATCH_PROVIDER_WALLET_ID=<circle wallet id>"
  ].join("\n");
}

function parseCliArgs(argv) {
  const out = {
    circleMode: null,
    workload: null,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "").trim();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--circle") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--circle requires a value");
      out.circleMode = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--circle=")) {
      out.circleMode = arg.slice("--circle=".length).trim();
      continue;
    }
    if (arg === "--workload") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--workload requires a value");
      out.workload = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--workload=")) {
      out.workload = arg.slice("--workload=".length).trim();
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function readBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  throw new Error(`${name} must be a boolean (1/0/true/false)`);
}

function sanitize(text) {
  return String(text ?? "").replaceAll(/[\r\n]+/g, " ").trim();
}

function sanitizeIdSegment(text, { maxLen = 96 } = {}) {
  const raw = String(text ?? "").trim();
  const safe = raw.replaceAll(/[^A-Za-z0-9:_-]/g, "_").slice(0, maxLen);
  return safe || "unknown";
}

function runCommand({ cmd, args, env, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({
        code: null,
        timeout: true,
        stdout,
        stderr
      });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        timeout: false,
        stdout,
        stderr
      });
    });
  });
}

function normalizeCircleMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "stub" || raw === "test") return "stub";
  if (raw === "sandbox") return "sandbox";
  if (raw === "production" || raw === "prod") return "production";
  throw new Error("circle mode must be stub|sandbox|production");
}

function normalizeWorkload(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "exa") return "exa";
  if (raw === "weather") return "weather";
  if (raw === "llm") return "llm";
  throw new Error("workload must be exa|weather|llm");
}

function buildWorkloadUpstreamUrl({ upstreamBaseUrl, workload, toolArgs }) {
  if (workload === "weather") {
    const url = new URL("/weather/current", upstreamBaseUrl);
    url.searchParams.set("city", String(toolArgs?.city ?? "Chicago"));
    url.searchParams.set("unit", String(toolArgs?.unit ?? "f"));
    return url;
  }
  if (workload === "llm") {
    const url = new URL("/llm/completions", upstreamBaseUrl);
    url.searchParams.set("prompt", String(toolArgs?.prompt ?? ""));
    url.searchParams.set("model", String(toolArgs?.model ?? "gpt-4o-mini"));
    url.searchParams.set("maxTokens", String(toolArgs?.maxTokens ?? 128));
    return url;
  }
  const url = new URL("/exa/search", upstreamBaseUrl);
  url.searchParams.set("q", String(toolArgs?.query ?? ""));
  url.searchParams.set("numResults", String(toolArgs?.numResults ?? 3));
  return url;
}

function pickSettldHeaders(headers) {
  const out = {};
  if (!headers || typeof headers.entries !== "function") return out;
  for (const [key, value] of headers.entries()) {
    if (String(key).toLowerCase().startsWith("x-settld-")) out[key] = value;
  }
  return out;
}

function readEnvString(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return String(raw).trim();
}

function assertCircleModeInputs({ mode }) {
  if (mode === "stub") return;
  const required = ["CIRCLE_API_KEY", "CIRCLE_WALLET_ID_SPEND", "CIRCLE_WALLET_ID_ESCROW", "CIRCLE_TOKEN_ID_USDC"];
  const missing = required.filter((name) => !readEnvString(name));
  if (missing.length > 0) {
    throw new Error(`circle mode ${mode} requires env: ${missing.join(", ")}`);
  }
  const hasTemplate = Boolean(readEnvString("CIRCLE_ENTITY_SECRET_CIPHERTEXT_TEMPLATE"));
  const hasStatic = Boolean(readEnvString("CIRCLE_ENTITY_SECRET_CIPHERTEXT")) && readBoolEnv("CIRCLE_ALLOW_STATIC_ENTITY_SECRET", false);
  const hasEntitySecretHex = Boolean(readEnvString("ENTITY_SECRET")) || Boolean(readEnvString("CIRCLE_ENTITY_SECRET_HEX"));
  if (!hasTemplate && !hasStatic && !hasEntitySecretHex) {
    throw new Error(
      `circle mode ${mode} requires ENTITY_SECRET/CIRCLE_ENTITY_SECRET_HEX (preferred), CIRCLE_ENTITY_SECRET_CIPHERTEXT_TEMPLATE, or CIRCLE_ENTITY_SECRET_CIPHERTEXT with CIRCLE_ALLOW_STATIC_ENTITY_SECRET=1`
    );
  }
}

function buildReserveTransitions(gate) {
  const transitions = [];
  const createdAt = typeof gate?.createdAt === "string" && gate.createdAt.trim() !== "" ? gate.createdAt : null;
  const auth = gate?.authorization && typeof gate.authorization === "object" && !Array.isArray(gate.authorization) ? gate.authorization : null;
  const reserve = auth?.reserve && typeof auth.reserve === "object" && !Array.isArray(auth.reserve) ? auth.reserve : null;

  if (createdAt) {
    transitions.push({
      phase: "gate_created",
      authorizationStatus: "pending",
      reserveStatus: null,
      at: createdAt
    });
  }

  const reservedAt = typeof reserve?.reservedAt === "string" && reserve.reservedAt.trim() !== "" ? reserve.reservedAt : null;
  if (reserve && reservedAt) {
    transitions.push({
      phase: "authorize_payment",
      authorizationStatus: "reserved",
      reserveStatus: "reserved",
      at: reservedAt
    });
  }

  const finalAuthStatus = typeof auth?.status === "string" && auth.status.trim() !== "" ? auth.status : null;
  const finalReserveStatus = typeof reserve?.status === "string" && reserve.status.trim() !== "" ? reserve.status : null;
  const finalAt =
    (typeof reserve?.settledAt === "string" && reserve.settledAt.trim() !== "" ? reserve.settledAt : null) ??
    (typeof gate?.resolvedAt === "string" && gate.resolvedAt.trim() !== "" ? gate.resolvedAt : null) ??
    (typeof auth?.updatedAt === "string" && auth.updatedAt.trim() !== "" ? auth.updatedAt : null) ??
    (typeof gate?.updatedAt === "string" && gate.updatedAt.trim() !== "" ? gate.updatedAt : null);
  if (finalAuthStatus || finalReserveStatus || finalAt) {
    const previous = transitions[transitions.length - 1] ?? null;
    const changed =
      !previous ||
      previous.authorizationStatus !== finalAuthStatus ||
      previous.reserveStatus !== finalReserveStatus ||
      previous.at !== finalAt;
    if (changed) {
      transitions.push({
        phase: "gate_verify",
        authorizationStatus: finalAuthStatus,
        reserveStatus: finalReserveStatus,
        at: finalAt
      });
    }
  }

  return transitions;
}

function log(prefix, msg) {
  process.stderr.write(`[${prefix}] ${msg}\n`);
}

function spawnProc({ name, cmd, args, env }) {
  log(name, `spawn: ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, {
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (buf) => {
    const s = sanitize(buf.toString("utf8"));
    if (s) log(name, s);
  });
  child.stderr?.on("data", (buf) => {
    const s = sanitize(buf.toString("utf8"));
    if (s) log(name, s);
  });
  child.on("exit", (code, signal) => {
    log(name, `exit: code=${code} signal=${signal ?? ""}`);
  });
  return child;
}

async function waitForHealth(url, { name, timeoutMs = 30_000, proc = null } = {}) {
  const start = Date.now();
  while (true) {
    if (proc && proc.exitCode !== null) {
      throw new Error(`${name ?? url} exited before becoming ready (exitCode=${proc.exitCode})`);
    }
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return;
    } catch {
      // retry
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${name ?? url} did not become ready within ${timeoutMs}ms: ${url}`);
    }
    await delay(250);
  }
}

async function mintApiKey({ apiUrl, opsToken, tenantId }) {
  const res = await fetch(new URL("/ops/api-keys", apiUrl), {
    method: "POST",
    headers: {
      "x-proxy-ops-token": opsToken,
      authorization: `Bearer ${opsToken}`,
      "x-proxy-tenant-id": tenantId,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      scopes: ["ops_read", "ops_write", "finance_read", "finance_write", "audit_read"],
      description: "mcp paid tool demo"
    })
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(`mint api key failed: HTTP ${res.status} ${text}`);
  const keyId = json?.keyId;
  const secret = json?.secret;
  if (typeof keyId !== "string" || typeof secret !== "string" || !keyId || !secret) {
    throw new Error(`mint api key returned unexpected body: ${text}`);
  }
  return `${keyId}.${secret}`;
}

async function runMcpToolCall({
  baseUrl,
  tenantId,
  apiKey,
  paidToolsBaseUrl,
  toolName,
  toolArgs,
  timeoutMs = 20_000
}) {
  const child = spawn(process.execPath, ["scripts/mcp/settld-mcp-server.mjs"], {
    env: {
      ...process.env,
      SETTLD_BASE_URL: baseUrl,
      SETTLD_TENANT_ID: tenantId,
      SETTLD_API_KEY: apiKey,
      SETTLD_PROTOCOL: "1.0",
      SETTLD_PAID_TOOLS_BASE_URL: paidToolsBaseUrl
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += String(chunk);
  });

  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf("\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const id = msg?.id;
      if (id !== undefined && id !== null && pending.has(String(id))) {
        const item = pending.get(String(id));
        pending.delete(String(id));
        item.resolve(msg);
      }
    }
  });

  function rpc(method, params = {}) {
    const id = String(Math.random()).slice(2);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(payload + "\n");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs).unref?.();
    });
  }

  try {
    const initialize = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "settld-demo-mcp-paid-exa", version: "s1" },
      capabilities: {}
    });
    const called = await rpc("tools/call", {
      name: toolName,
      arguments: toolArgs
    });

    const text = called?.result?.content?.[0]?.text ?? "";
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    return {
      initialize,
      called,
      parsed,
      stderr: stderrBuf
    };
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await Promise.race([delay(100), new Promise((resolve) => child.once("exit", resolve))]);
  }
}

async function writeArtifactJson(dir, filename, value) {
  await writeFile(path.join(dir, filename), JSON.stringify(value, null, 2) + "\n", "utf8");
}

function parseJsonLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function reportCheckOk(report, checkId) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const row = checks.find((item) => item && item.id === checkId);
  return row?.ok === true;
}

function receiptVerificationCoreOk(report) {
  return (
    reportCheckOk(report, "settlement_kernel_artifacts") &&
    reportCheckOk(report, "request_hash_binding") &&
    reportCheckOk(report, "response_hash_binding") &&
    reportCheckOk(report, "provider_output_signature_crypto")
  );
}

async function exportAndVerifyReceiptSample({
  artifactDir,
  apiUrl,
  apiKey,
  tenantId
}) {
  const exportRes = await fetch(new URL("/x402/receipts/export?limit=25", apiUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "x-proxy-tenant-id": tenantId,
      "x-settld-protocol": "1.0",
      accept: "application/json"
    }
  });
  const exportBody = await exportRes.text();
  if (!exportRes.ok) {
    throw new Error(`x402 receipt export failed: HTTP ${exportRes.status} ${sanitize(exportBody).slice(0, 300)}`);
  }

  const exportPath = path.join(artifactDir, "x402-receipts.export.jsonl");
  const normalizedExportBody = exportBody.endsWith("\n") ? exportBody : `${exportBody}\n`;
  await writeFile(exportPath, normalizedExportBody, "utf8");

  const receipts = parseJsonLines(exportBody);
  const sampleReceipt = receipts[0] ?? null;
  const sampleDecisionId =
    typeof sampleReceipt?.decisionRecord?.decisionId === "string" && sampleReceipt.decisionRecord.decisionId.trim() !== ""
      ? sampleReceipt.decisionRecord.decisionId.trim()
      : typeof sampleReceipt?.settlementReceipt?.decisionRef?.decisionId === "string" &&
          sampleReceipt.settlementReceipt.decisionRef.decisionId.trim() !== ""
        ? sampleReceipt.settlementReceipt.decisionRef.decisionId.trim()
        : null;
  const sampleSettlementReceiptId =
    typeof sampleReceipt?.settlementReceipt?.receiptId === "string" && sampleReceipt.settlementReceipt.receiptId.trim() !== ""
      ? sampleReceipt.settlementReceipt.receiptId.trim()
      : typeof sampleReceipt?.receiptId === "string" && sampleReceipt.receiptId.trim() !== ""
        ? sampleReceipt.receiptId.trim()
        : null;
  const sampleVerification =
    sampleReceipt && typeof sampleReceipt === "object" && !Array.isArray(sampleReceipt)
      ? {
          nonStrict: verifyX402ReceiptRecord({ receipt: sampleReceipt, strict: false }),
          strict: verifyX402ReceiptRecord({ receipt: sampleReceipt, strict: true })
        }
      : null;

  const verificationArtifact = {
    schemaVersion: "X402ReceiptSampleVerification.v1",
    generatedAt: new Date().toISOString(),
    exportPath: "x402-receipts.export.jsonl",
    exportedReceiptCount: receipts.length,
    sampleReceiptId: typeof sampleReceipt?.receiptId === "string" ? sampleReceipt.receiptId : null,
    sampleDecisionId,
    sampleSettlementReceiptId,
    sampleVerification,
    sampleVerificationCoreOk: receiptVerificationCoreOk(sampleVerification?.nonStrict)
  };
  await writeArtifactJson(artifactDir, "x402-receipts.sample-verification.json", verificationArtifact);

  return {
    ok:
      receipts.length > 0 &&
      receiptVerificationCoreOk(sampleVerification?.nonStrict),
    nonStrictOk: Boolean(sampleVerification?.nonStrict?.ok),
    strictOk: Boolean(sampleVerification?.strict?.ok),
    exportedReceiptCount: receipts.length,
    sampleReceiptId: verificationArtifact.sampleReceiptId,
    sampleDecisionId,
    sampleSettlementReceiptId
  };
}

async function runBatchSettlementDemo({
  artifactDir,
  providerId,
  circleMode,
  enabled
}) {
  if (!enabled) {
    return {
      enabled: false,
      ok: true,
      skipped: true,
      reason: "disabled"
    };
  }

  const providerWalletId = readEnvString("SETTLD_DEMO_BATCH_PROVIDER_WALLET_ID", readEnvString("CIRCLE_WALLET_ID_ESCROW", null));
  if (circleMode !== "stub" && !providerWalletId) {
    throw new Error("batch settlement demo requires SETTLD_DEMO_BATCH_PROVIDER_WALLET_ID or CIRCLE_WALLET_ID_ESCROW");
  }

  const registryPath = path.join(artifactDir, "batch-payout-registry.json");
  const statePath = path.join(artifactDir, "batch-worker-state.json");
  const outDir = path.join(artifactDir, "batch-settlement-run");
  const artifactRoot = path.dirname(artifactDir);
  const registry = {
    schemaVersion: "X402ProviderPayoutRegistry.v1",
    providers: [
      {
        providerId,
        destination: {
          type: "circle_wallet",
          walletId: providerWalletId ?? "wallet_demo_stub",
          blockchain: readEnvString("CIRCLE_BLOCKCHAIN", circleMode === "production" ? "BASE" : "BASE-SEPOLIA"),
          token: "USDC"
        }
      }
    ]
  };
  await writeArtifactJson(artifactDir, "batch-payout-registry.json", registry);

  const args = [
    "scripts/settlement/x402-batch-worker.mjs",
    "--artifact-root",
    artifactRoot,
    "--registry",
    registryPath,
    "--state",
    statePath,
    "--out-dir",
    outDir,
    "--execute-circle",
    "--circle-mode",
    circleMode
  ];
  const run = await runCommand({
    cmd: "node",
    args,
    timeoutMs: readIntEnv("SETTLD_DEMO_BATCH_SETTLEMENT_TIMEOUT_MS", 90_000)
  });
  if (run.timeout) throw new Error("batch settlement command timed out");
  if (run.code !== 0) {
    throw new Error(`batch settlement failed (exit=${run.code}): ${sanitize(run.stderr) || sanitize(run.stdout)}`);
  }
  const stdoutLines = String(run.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = stdoutLines[stdoutLines.length - 1] ?? "";
  let parsed = null;
  try {
    parsed = lastLine ? JSON.parse(lastLine) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.ok !== true) {
    throw new Error(`batch settlement returned unexpected output: ${sanitize(run.stdout).slice(0, 300)}`);
  }

  const artifact = {
    enabled: true,
    ok: true,
    circleMode,
    command: ["node", ...args],
    artifactRoot,
    registryPath,
    statePath,
    outDir,
    result: parsed
  };
  await writeArtifactJson(artifactDir, "batch-settlement.json", artifact);
  return artifact;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const apiPort = readIntEnv("SETTLD_DEMO_API_PORT", 3000);
  const upstreamPort = readIntEnv("SETTLD_DEMO_UPSTREAM_PORT", 9402);
  const gatewayPort = readIntEnv("SETTLD_DEMO_GATEWAY_PORT", 8402);
  const keepAlive = readBoolEnv("SETTLD_DEMO_KEEP_ALIVE", false);
  const runBatchSettlement = readBoolEnv("SETTLD_DEMO_RUN_BATCH_SETTLEMENT", false);
  const circleMode = normalizeCircleMode(cli.circleMode ?? readEnvString("SETTLD_DEMO_CIRCLE_MODE", "stub"));
  const workload = normalizeWorkload(cli.workload ?? readEnvString("SETTLD_DEMO_WORKLOAD", "exa"));
  const externalReserveRequired = circleMode !== "stub";
  assertCircleModeInputs({ mode: circleMode });
  const opsToken = String(process.env.SETTLD_DEMO_OPS_TOKEN ?? "tok_ops").trim() || "tok_ops";
  const tenantId = String(process.env.SETTLD_TENANT_ID ?? "tenant_default").trim() || "tenant_default";

  const workloadConfig = (() => {
    if (workload === "weather") {
      const city = String(process.env.SETTLD_DEMO_CITY ?? "Chicago").trim() || "Chicago";
      const unitRaw = String(process.env.SETTLD_DEMO_UNIT ?? "f").trim().toLowerCase();
      const unit = unitRaw === "c" ? "c" : "f";
      return {
        toolName: "settld.weather_current_paid",
        toolArgs: { city, unit },
        description: `weather city=${city} unit=${unit}`
      };
    }
    if (workload === "llm") {
      const prompt = String(process.env.SETTLD_DEMO_PROMPT ?? "Summarize why deferred settlement matters for paid API calls.").trim();
      const model = String(process.env.SETTLD_DEMO_MODEL ?? "gpt-4o-mini").trim() || "gpt-4o-mini";
      const maxTokens = readIntEnv("SETTLD_DEMO_MAX_TOKENS", 128);
      return {
        toolName: "settld.llm_completion_paid",
        toolArgs: { prompt, model, maxTokens },
        description: `llm model=${model} maxTokens=${maxTokens}`
      };
    }
    const query = String(process.env.SETTLD_DEMO_QUERY ?? "dentist near me chicago").trim() || "dentist near me chicago";
    const numResults = readIntEnv("SETTLD_DEMO_NUM_RESULTS", 3);
    return {
      toolName: "settld.exa_search_paid",
      toolArgs: { query, numResults },
      description: `exa query=${query} numResults=${numResults}`
    };
  })();

  const now = new Date();
  const runId = now.toISOString().replaceAll(":", "").replaceAll(".", "");
  const artifactDir =
    process.env.SETTLD_DEMO_ARTIFACT_DIR && String(process.env.SETTLD_DEMO_ARTIFACT_DIR).trim() !== ""
      ? String(process.env.SETTLD_DEMO_ARTIFACT_DIR).trim()
      : path.join("artifacts", `mcp-paid-${workload}`, runId);

  const apiUrl = new URL(`http://127.0.0.1:${apiPort}`);
  const upstreamUrl = new URL(`http://127.0.0.1:${upstreamPort}`);
  const gatewayUrl = new URL(`http://127.0.0.1:${gatewayPort}`);
  const providerId = `agt_x402_payee_${sanitizeIdSegment(upstreamUrl.host)}`;

  await mkdir(artifactDir, { recursive: true });

  const procs = [];
  const stopAll = () => {
    for (const p of procs) {
      try {
        p.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  };

  let summary = {
    ok: false,
    runId,
    artifactDir,
    workload,
    toolName: workloadConfig.toolName,
    toolArgs: workloadConfig.toolArgs,
    providerId,
    circleMode,
    timestamps: { startedAt: now.toISOString(), completedAt: null }
  };

  process.on("SIGINT", () => {
    log("demo", "SIGINT: shutting down...");
    stopAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    log("demo", "SIGTERM: shutting down...");
    stopAll();
    process.exit(143);
  });

  try {
    const api = spawnProc({
      name: "api",
      cmd: "node",
      args: ["src/api/server.js"],
      env: {
        PROXY_OPS_TOKEN: opsToken,
        BIND_HOST: "127.0.0.1",
        PORT: String(apiPort),
        X402_CIRCLE_RESERVE_MODE: circleMode,
        X402_REQUIRE_EXTERNAL_RESERVE: externalReserveRequired ? "1" : "0"
      }
    });
    procs.push(api);
    await waitForHealth(new URL("/healthz", apiUrl).toString(), { name: "api /healthz", proc: api });

    const apiKey = await mintApiKey({ apiUrl, opsToken, tenantId });
    log("demo", "SETTLD_API_KEY minted");

    const upstream = spawnProc({
      name: "upstream",
      cmd: "node",
      args: ["services/x402-gateway/examples/upstream-mock.js"],
      env: {
        BIND_HOST: "127.0.0.1",
        PORT: String(upstreamPort),
        SETTLD_PROVIDER_ID: providerId,
        SETTLD_PAY_KEYSET_URL: new URL("/.well-known/settld-keys.json", apiUrl).toString()
      }
    });
    procs.push(upstream);
    await waitForHealth(new URL("/healthz", upstreamUrl).toString(), { name: "upstream /healthz", proc: upstream });

    const providerKeyRes = await fetch(new URL("/settld/provider-key", upstreamUrl));
    if (!providerKeyRes.ok) throw new Error(`provider key fetch failed: HTTP ${providerKeyRes.status}`);
    const providerKey = await providerKeyRes.json();
    const providerPublicKeyPem = typeof providerKey?.publicKeyPem === "string" ? providerKey.publicKeyPem : null;
    if (!providerPublicKeyPem) throw new Error("provider did not return publicKeyPem");

    const gateway = spawnProc({
      name: "gateway",
      cmd: "node",
      args: ["services/x402-gateway/src/server.js"],
      env: {
        BIND_HOST: "127.0.0.1",
        SETTLD_API_URL: apiUrl.toString(),
        SETTLD_API_KEY: apiKey,
        UPSTREAM_URL: upstreamUrl.toString(),
        X402_AUTOFUND: "1",
        X402_PROVIDER_PUBLIC_KEY_PEM: providerPublicKeyPem,
        PORT: String(gatewayPort)
      }
    });
    procs.push(gateway);
    await waitForHealth(new URL("/healthz", gatewayUrl).toString(), { name: "gateway /healthz", proc: gateway });

    const mcp = await runMcpToolCall({
      baseUrl: apiUrl.toString(),
      tenantId,
      apiKey,
      paidToolsBaseUrl: gatewayUrl.toString(),
      toolName: workloadConfig.toolName,
      toolArgs: workloadConfig.toolArgs
    });
    await writeArtifactJson(artifactDir, "mcp-call.raw.json", mcp.called);
    await writeArtifactJson(artifactDir, "mcp-call.parsed.json", mcp.parsed ?? {});

    if (mcp.called?.result?.isError) {
      throw new Error(`mcp tool call returned error: ${mcp.called?.result?.content?.[0]?.text ?? "unknown"}`);
    }
    if (!mcp.parsed?.result || typeof mcp.parsed.result !== "object") {
      throw new Error("mcp parsed result missing");
    }

    const result = mcp.parsed.result;
    const responseBody = result.response ?? null;
    const headers = result.headers ?? {};
    const gateId = typeof headers["x-settld-gate-id"] === "string" ? headers["x-settld-gate-id"] : "";
    if (!gateId) throw new Error("missing x-settld-gate-id from paid response headers");
    await writeArtifactJson(artifactDir, "response-body.json", responseBody ?? {});

    const gateStateRes = await fetch(new URL(`/x402/gate/${encodeURIComponent(gateId)}`, apiUrl), {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-proxy-tenant-id": tenantId,
        "x-settld-protocol": "1.0"
      }
    });
    const gateStateText = await gateStateRes.text();
    let gateState = null;
    try {
      gateState = gateStateText ? JSON.parse(gateStateText) : null;
    } catch {
      gateState = null;
    }
    if (!gateStateRes.ok) throw new Error(`gate state fetch failed: HTTP ${gateStateRes.status} ${gateStateText}`);
    await writeArtifactJson(artifactDir, "gate-state.json", gateState ?? {});

    const reserveState = (() => {
      const gate = gateState?.gate ?? null;
      const auth = gate?.authorization && typeof gate.authorization === "object" && !Array.isArray(gate.authorization) ? gate.authorization : null;
      const reserve = auth?.reserve && typeof auth.reserve === "object" && !Array.isArray(auth.reserve) ? auth.reserve : null;
      const circleReserveId =
        typeof reserve?.reserveId === "string" && reserve.reserveId.trim() !== ""
          ? reserve.reserveId.trim()
          : typeof reserve?.circleTransferId === "string" && reserve.circleTransferId.trim() !== ""
            ? reserve.circleTransferId.trim()
            : null;
      return {
        mode: circleMode,
        externalReserveRequired,
        authorizationRef: typeof auth?.authorizationRef === "string" ? auth.authorizationRef : null,
        circleReserveId,
        reserve,
        transitions: buildReserveTransitions(gate),
        rail: {
          provider: "circle",
          mode: circleMode,
          blockchain: readEnvString("CIRCLE_BLOCKCHAIN", circleMode === "production" ? "BASE" : "BASE-SEPOLIA"),
          tokenId: readEnvString("CIRCLE_TOKEN_ID_USDC", null),
          spendWalletId: readEnvString("CIRCLE_WALLET_ID_SPEND", null),
          escrowWalletId: readEnvString("CIRCLE_WALLET_ID_ESCROW", null)
        },
        payoutDestination: {
          type: "agent_wallet",
          payeeAgentId: providerId,
          note: "Batch payout worker is not enabled in this demo run."
        }
      };
    })();
    await writeArtifactJson(artifactDir, "reserve-state.json", reserveState);

    // Write a provisional summary so artifact-driven settlement workers can
    // discover this run before final summary enrichment.
    const preBatchSummary = {
      ...summary,
      ok: true,
      gateId,
      workload,
      toolName: workloadConfig.toolName,
      toolArgs: workloadConfig.toolArgs,
      circleReserveId: reserveState.circleReserveId,
      reserveTransitions: reserveState.transitions,
      payoutDestination: reserveState.payoutDestination,
      artifactFiles: [
        "mcp-call.raw.json",
        "mcp-call.parsed.json",
        "response-body.json",
        "gate-state.json",
        "reserve-state.json"
      ]
    };
    await writeArtifactJson(artifactDir, "summary.json", preBatchSummary);

    const providerSignatureVerification = (() => {
      const responseHash = sha256Hex(canonicalJsonStringify(responseBody ?? {}));
      const signature = {
        schemaVersion: "ToolProviderSignature.v1",
        algorithm: "ed25519",
        keyId: String(headers["x-settld-provider-key-id"] ?? ""),
        signedAt: String(headers["x-settld-provider-signed-at"] ?? ""),
        nonce: String(headers["x-settld-provider-nonce"] ?? ""),
        responseHash,
        payloadHash: computeToolProviderSignaturePayloadHashV1({
          responseHash,
          nonce: String(headers["x-settld-provider-nonce"] ?? ""),
          signedAt: String(headers["x-settld-provider-signed-at"] ?? "")
        }),
        signatureBase64: String(headers["x-settld-provider-signature"] ?? "")
      };
      let ok = false;
      let error = null;
      try {
        ok = verifyToolProviderSignatureV1({ signature, publicKeyPem: providerPublicKeyPem });
      } catch (err) {
        ok = false;
        error = err?.message ?? String(err ?? "");
      }
      return {
        ok,
        error,
        responseHashExpected: responseHash,
        responseHashHeader: String(headers["x-settld-provider-response-sha256"] ?? ""),
        signature
      };
    })();
    await writeArtifactJson(artifactDir, "provider-signature-verification.json", providerSignatureVerification);

    const tokenVerification = await (async () => {
      const token = gateState?.gate?.authorization?.token?.value;
      if (typeof token !== "string" || token.trim() === "") return { ok: false, skipped: true, reason: "token_missing" };
      const keysetRes = await fetch(new URL("/.well-known/settld-keys.json", apiUrl));
      const keysetText = await keysetRes.text();
      let keyset = null;
      try {
        keyset = keysetText ? JSON.parse(keysetText) : null;
      } catch {
        keyset = null;
      }
      if (!keysetRes.ok || !keyset) return { ok: false, skipped: true, reason: "keyset_unavailable", status: keysetRes.status };
      let verified = null;
      try {
        verified = verifySettldPayTokenV1({
          token,
          keyset,
          expectedAudience: String(gateState?.gate?.payeeAgentId ?? ""),
          expectedPayeeProviderId: String(gateState?.gate?.payeeAgentId ?? "")
        });
      } catch (err) {
        return { ok: false, skipped: false, code: "VERIFY_THROW", message: err?.message ?? String(err ?? "") };
      }
      return { ok: Boolean(verified?.ok), verification: verified };
    })();
    await writeArtifactJson(artifactDir, "settld-pay-token-verification.json", tokenVerification);

    const replayProbe = await (async () => {
      const token = gateState?.gate?.authorization?.token?.value;
      if (typeof token !== "string" || token.trim() === "") {
        return {
          attempted: false,
          skipped: true,
          reason: "token_missing"
        };
      }
      const probeUrl = buildWorkloadUpstreamUrl({
        upstreamBaseUrl: upstreamUrl,
        workload,
        toolArgs: workloadConfig.toolArgs
      });
      const res = await fetch(probeUrl, {
        method: "GET",
        headers: {
          authorization: `SettldPay ${token}`,
          "x-proxy-tenant-id": tenantId
        }
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const headers = pickSettldHeaders(res.headers);
      const duplicate = String(headers["x-settld-provider-replay"] ?? "").toLowerCase() === "duplicate";
      return {
        attempted: true,
        skipped: false,
        url: probeUrl.toString(),
        statusCode: res.status,
        duplicate,
        headers,
        body: json ?? text
      };
    })();
    const replayCounters = {
      schemaVersion: "X402ProviderReplayCounters.v1",
      totalRequests: replayProbe.attempted ? 1 : 0,
      duplicateResponses: replayProbe.attempted && replayProbe.duplicate ? 1 : 0,
      duplicateRate: replayProbe.attempted ? (replayProbe.duplicate ? 1 : 0) : null
    };
    await writeArtifactJson(artifactDir, "provider-replay-probe.json", {
      replayProbe,
      replayCounters
    });

    const receiptExport = await exportAndVerifyReceiptSample({
      artifactDir,
      apiUrl,
      apiKey,
      tenantId
    });

    const batchSettlement = await runBatchSettlementDemo({
      artifactDir,
      providerId,
      circleMode,
      enabled: runBatchSettlement
    });

    const passChecks = {
      settlementStatus: String(headers["x-settld-settlement-status"] ?? "") === "released",
      verificationStatus: String(headers["x-settld-verification-status"] ?? "") === "green",
      providerSignature: providerSignatureVerification.ok === true,
      tokenVerified: tokenVerification.ok === true,
      batchSettlement: batchSettlement.ok === true,
      receiptExport: receiptExport.ok === true,
      receiptVerifier: receiptExport.ok === true,
      reserveTracked:
        typeof reserveState?.circleReserveId === "string" &&
        reserveState.circleReserveId.trim() !== "" &&
        Array.isArray(reserveState?.transitions) &&
        reserveState.transitions.length >= 2
    };

    summary = {
      ...summary,
      ok: Object.values(passChecks).every(Boolean),
      passChecks,
      gateId,
      workload,
      toolName: workloadConfig.toolName,
      toolArgs: workloadConfig.toolArgs,
      workloadDescription: workloadConfig.description,
      circleReserveId: reserveState.circleReserveId,
      reserveTransitions: reserveState.transitions,
      payoutDestination: reserveState.payoutDestination,
      replayCounters,
      replayProbe,
      receiptExport,
      batchSettlement,
      artifactFiles: [
        "mcp-call.raw.json",
        "mcp-call.parsed.json",
        "response-body.json",
        "gate-state.json",
        "reserve-state.json",
        "provider-signature-verification.json",
        "settld-pay-token-verification.json",
        "provider-replay-probe.json",
        "x402-receipts.export.jsonl",
        "x402-receipts.sample-verification.json",
        ...(runBatchSettlement ? ["batch-payout-registry.json", "batch-worker-state.json", "batch-settlement.json"] : [])
      ],
      timestamps: {
        ...summary.timestamps,
        completedAt: new Date().toISOString()
      }
    };

    await writeArtifactJson(artifactDir, "summary.json", summary);

    if (!summary.ok) {
      process.stdout.write(`FAIL artifactDir=${artifactDir}\n`);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`PASS artifactDir=${artifactDir}\n`);
    process.stdout.write(`gateId=${gateId}\n`);
    if (typeof receiptExport.sampleDecisionId === "string" && receiptExport.sampleDecisionId.trim() !== "") {
      process.stdout.write(`decisionId=${receiptExport.sampleDecisionId.trim()}\n`);
    }
    if (typeof receiptExport.sampleSettlementReceiptId === "string" && receiptExport.sampleSettlementReceiptId.trim() !== "") {
      process.stdout.write(`settlementReceiptId=${receiptExport.sampleSettlementReceiptId.trim()}\n`);
    }

    if (!keepAlive) {
      stopAll();
      return;
    }

    log("demo", "Services are running. Press Ctrl+C to stop.");
    // eslint-disable-next-line no-constant-condition
    while (true) await delay(1000);
  } catch (err) {
    summary = {
      ...summary,
      ok: false,
      error: err?.message ?? String(err ?? ""),
      timestamps: {
        ...summary.timestamps,
        completedAt: new Date().toISOString()
      }
    };
    try {
      await writeArtifactJson(artifactDir, "summary.json", summary);
    } catch {
      // ignore
    }
    process.stdout.write(`FAIL artifactDir=${artifactDir}\n`);
    process.stderr.write(`${err?.stack ?? err?.message ?? String(err ?? "")}\n`);
    process.exitCode = 1;
  } finally {
    if (!keepAlive) stopAll();
  }
}

main();
