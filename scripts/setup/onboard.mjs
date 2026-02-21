#!/usr/bin/env node

import fs from "node:fs/promises";
import fsNative from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { bootstrapWalletProvider } from "../../src/core/wallet-provider-bootstrap.js";
import { loadHostConfigHelper, runWizard } from "./wizard.mjs";
import { SUPPORTED_HOSTS } from "./host-config.mjs";

const WALLET_MODES = new Set(["managed", "byo", "none"]);
const WALLET_PROVIDERS = new Set(["circle"]);
const WALLET_BOOTSTRAP_MODES = new Set(["auto", "local", "remote"]);
const FORMAT_OPTIONS = new Set(["text", "json"]);
const HOST_BINARY_HINTS = Object.freeze({
  codex: "codex",
  claude: "claude",
  cursor: "cursor",
  openclaw: "openclaw"
});
const HOST_SELECTION_ORDER = Object.freeze(["openclaw", "codex", "claude", "cursor"]);
const CIRCLE_BYO_REQUIRED_KEYS = Object.freeze([
  "CIRCLE_BASE_URL",
  "CIRCLE_BLOCKCHAIN",
  "CIRCLE_WALLET_ID_SPEND",
  "CIRCLE_WALLET_ID_ESCROW",
  "CIRCLE_TOKEN_ID_USDC",
  "CIRCLE_ENTITY_SECRET_HEX"
]);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const SETTLD_BIN = path.join(REPO_ROOT, "bin", "settld.js");

function usage() {
  const text = [
    "usage:",
    "  settld setup [flags]",
    "  settld onboard [flags]",
    "  node scripts/setup/onboard.mjs [flags]",
    "",
    "flags:",
    "  --non-interactive               Disable prompts; require explicit flags",
    `  --host <${SUPPORTED_HOSTS.join("|")}>      Host target (default: auto-detect, fallback openclaw)`,
    "  --base-url <url>                Settld API base URL (or SETTLD_BASE_URL)",
    "  --tenant-id <id>                Settld tenant ID (or SETTLD_TENANT_ID)",
    "  --settld-api-key <key>          Settld tenant API key (or SETTLD_API_KEY)",
    "  --wallet-mode <managed|byo|none> Wallet setup mode (default: managed)",
    "  --wallet-provider <name>        Wallet provider (circle; default: circle)",
    "  --wallet-bootstrap <auto|local|remote> Managed wallet setup path (default: auto)",
    "  --wallet-env <KEY=VALUE>        BYO wallet env row (repeatable)",
    "  --circle-api-key <key>          Circle API key (or CIRCLE_API_KEY)",
    "  --circle-mode <auto|sandbox|production> Circle host selection (default: auto)",
    "  --circle-base-url <url>         Force Circle API URL",
    "  --circle-blockchain <name>      Force Circle blockchain",
    "  --profile-id <id>               Starter profile id (default: engineering-spend)",
    "  --skip-profile-apply            Skip profile apply",
    "  --preflight                     Run connectivity/auth/path preflight checks (default: on)",
    "  --no-preflight                  Skip preflight checks",
    "  --preflight-only                Run only preflight checks, then exit",
    "  --smoke                         Run MCP smoke check (default: on)",
    "  --no-smoke                      Disable MCP smoke check",
    "  --dry-run                       Dry-run host config write",
    "  --out-env <path>                Write combined env file (KEY=VALUE)",
    "  --report-path <path>            Write JSON report payload to disk",
    "  --format <text|json>            Output format (default: text)",
    "  --help                          Show this help"
  ].join("\n");
  process.stderr.write(`${text}\n`);
}

function readArgValue(argv, index, rawArg) {
  const arg = String(rawArg ?? "");
  const eq = arg.indexOf("=");
  if (eq >= 0) return { value: arg.slice(eq + 1), nextIndex: index };
  return { value: String(argv[index + 1] ?? ""), nextIndex: index + 1 };
}

function parseWalletEnvAssignment(raw) {
  const text = String(raw ?? "").trim();
  const eq = text.indexOf("=");
  if (eq <= 0) throw new Error("--wallet-env requires KEY=VALUE");
  const key = text.slice(0, eq).trim();
  const value = text.slice(eq + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid --wallet-env key: ${key}`);
  }
  return { key, value };
}

function parseArgs(argv) {
  const out = {
    nonInteractive: false,
    host: null,
    baseUrl: null,
    tenantId: null,
    settldApiKey: null,
    walletMode: "managed",
    walletProvider: "circle",
    walletBootstrap: "auto",
    walletEnvRows: [],
    circleApiKey: null,
    circleMode: "auto",
    circleBaseUrl: null,
    circleBlockchain: null,
    profileId: "engineering-spend",
    skipProfileApply: false,
    preflight: true,
    preflightOnly: false,
    smoke: true,
    dryRun: false,
    outEnv: null,
    reportPath: null,
    format: "text",
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--non-interactive" || arg === "--yes") {
      out.nonInteractive = true;
      continue;
    }
    if (arg === "--skip-profile-apply") {
      out.skipProfileApply = true;
      continue;
    }
    if (arg === "--preflight") {
      out.preflight = true;
      continue;
    }
    if (arg === "--no-preflight") {
      out.preflight = false;
      continue;
    }
    if (arg === "--preflight-only") {
      out.preflightOnly = true;
      continue;
    }
    if (arg === "--smoke") {
      out.smoke = true;
      continue;
    }
    if (arg === "--no-smoke") {
      out.smoke = false;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }

    if (arg === "--host" || arg.startsWith("--host=")) {
      const parsed = readArgValue(argv, i, arg);
      out.host = String(parsed.value ?? "").trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      const parsed = readArgValue(argv, i, arg);
      out.baseUrl = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--tenant-id" || arg.startsWith("--tenant-id=")) {
      const parsed = readArgValue(argv, i, arg);
      out.tenantId = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--settld-api-key" || arg.startsWith("--settld-api-key=")) {
      const parsed = readArgValue(argv, i, arg);
      out.settldApiKey = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--wallet-mode" || arg.startsWith("--wallet-mode=")) {
      const parsed = readArgValue(argv, i, arg);
      out.walletMode = String(parsed.value ?? "").trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--wallet-provider" || arg.startsWith("--wallet-provider=")) {
      const parsed = readArgValue(argv, i, arg);
      out.walletProvider = String(parsed.value ?? "").trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--wallet-bootstrap" || arg.startsWith("--wallet-bootstrap=")) {
      const parsed = readArgValue(argv, i, arg);
      out.walletBootstrap = String(parsed.value ?? "").trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--wallet-env" || arg.startsWith("--wallet-env=")) {
      const parsed = readArgValue(argv, i, arg);
      out.walletEnvRows.push(parseWalletEnvAssignment(parsed.value));
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--circle-api-key" || arg.startsWith("--circle-api-key=")) {
      const parsed = readArgValue(argv, i, arg);
      out.circleApiKey = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--circle-mode" || arg.startsWith("--circle-mode=")) {
      const parsed = readArgValue(argv, i, arg);
      out.circleMode = String(parsed.value ?? "").trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--circle-base-url" || arg.startsWith("--circle-base-url=")) {
      const parsed = readArgValue(argv, i, arg);
      out.circleBaseUrl = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--circle-blockchain" || arg.startsWith("--circle-blockchain=")) {
      const parsed = readArgValue(argv, i, arg);
      out.circleBlockchain = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--profile-id" || arg.startsWith("--profile-id=")) {
      const parsed = readArgValue(argv, i, arg);
      out.profileId = String(parsed.value ?? "").trim();
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--out-env" || arg.startsWith("--out-env=")) {
      const parsed = readArgValue(argv, i, arg);
      out.outEnv = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--report-path" || arg.startsWith("--report-path=")) {
      const parsed = readArgValue(argv, i, arg);
      out.reportPath = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const parsed = readArgValue(argv, i, arg);
      out.format = String(parsed.value ?? "").trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  if (out.host && !SUPPORTED_HOSTS.includes(out.host)) {
    throw new Error(`--host must be one of: ${SUPPORTED_HOSTS.join(", ")}`);
  }
  if (!WALLET_MODES.has(out.walletMode)) throw new Error("--wallet-mode must be managed|byo|none");
  if (!WALLET_PROVIDERS.has(out.walletProvider)) throw new Error(`--wallet-provider must be one of: ${[...WALLET_PROVIDERS].join(", ")}`);
  if (!WALLET_BOOTSTRAP_MODES.has(out.walletBootstrap)) throw new Error("--wallet-bootstrap must be auto|local|remote");
  if (!FORMAT_OPTIONS.has(out.format)) throw new Error("--format must be text|json");
  if (out.preflightOnly && out.preflight === false) {
    throw new Error("--preflight-only cannot be combined with --no-preflight");
  }
  if (out.outEnv) out.outEnv = path.resolve(process.cwd(), out.outEnv);
  if (out.reportPath) out.reportPath = path.resolve(process.cwd(), out.reportPath);
  return out;
}

function normalizeHttpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString().replace(/\/+$/, "");
}

function commandExists(command, { platform = process.platform } = {}) {
  const lookupCmd = platform === "win32" ? "where" : "which";
  const probe = spawnSync(lookupCmd, [command], { stdio: "ignore" });
  return probe.status === 0;
}

function detectInstalledHosts({ platform = process.platform } = {}) {
  const out = [];
  for (const host of HOST_SELECTION_ORDER) {
    const bin = HOST_BINARY_HINTS[host];
    if (!bin) continue;
    if (commandExists(bin, { platform })) out.push(host);
  }
  return out;
}

function selectDefaultHost({ explicitHost, installedHosts }) {
  if (explicitHost && SUPPORTED_HOSTS.includes(explicitHost)) return explicitHost;
  if (Array.isArray(installedHosts) && installedHosts.length > 0) return installedHosts[0];
  return "openclaw";
}

function healthUrlForBase(baseUrl) {
  const normalized = normalizeHttpUrl(baseUrl);
  if (!normalized) return null;
  return `${normalized}/healthz`;
}

function runSettldProfileListProbe({ baseUrl, tenantId, apiKey, timeoutMs = 12000 } = {}) {
  const args = [
    SETTLD_BIN,
    "profile",
    "list",
    "--format",
    "json"
  ];
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SETTLD_BASE_URL: String(baseUrl ?? ""),
      SETTLD_TENANT_ID: String(tenantId ?? ""),
      SETTLD_API_KEY: String(apiKey ?? "")
    },
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function nearestExistingDirectory(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    try {
      const stat = await fs.stat(current);
      if (stat.isDirectory()) return current;
      current = path.dirname(current);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      const next = path.dirname(current);
      if (next === current) return null;
      current = next;
    }
  }
}

async function assertPathLikelyWritable(configPath) {
  const dir = path.dirname(path.resolve(String(configPath ?? "")));
  const existingDir = await nearestExistingDirectory(dir);
  if (!existingDir) {
    throw new Error(`could not locate an existing parent directory for host config path: ${configPath}`);
  }
  await fs.access(existingDir, fsNative.constants.W_OK);
}

async function runPreflightChecks({
  config,
  normalizedBaseUrl,
  tenantId,
  settldApiKey,
  hostHelper,
  walletEnv,
  fetchImpl = fetch,
  stdout = process.stdout,
  verbose = true
} = {}) {
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail });
  const fail = (name, detail) => {
    const error = new Error(`${name} preflight failed: ${detail}`);
    error.preflightChecks = checks;
    throw error;
  };

  if (verbose) stdout.write("Preflight checks...\n");
  const healthUrl = healthUrlForBase(normalizedBaseUrl);
  if (!healthUrl) fail("api_health", `invalid Settld base URL: ${normalizedBaseUrl}`);
  let healthRes;
  try {
    healthRes = await fetchImpl(healthUrl, { method: "GET" });
  } catch (err) {
    fail("api_health", `cannot reach ${healthUrl}: ${err?.message ?? String(err)}`);
  }
  if (!healthRes?.ok) {
    fail("api_health", `GET ${healthUrl} returned HTTP ${healthRes?.status ?? "unknown"}`);
  }
  ok("api_health", `reachable (${healthUrl})`);

  const probe = runSettldProfileListProbe({
    baseUrl: normalizedBaseUrl,
    tenantId,
    apiKey: settldApiKey
  });
  if (probe.error && probe.error.code === "ETIMEDOUT") {
    fail("tenant_auth", "profile list probe timed out");
  }
  if (probe.status !== 0) {
    const message = String(probe.stderr || probe.stdout || "").trim() || `exit ${probe.status}`;
    fail("tenant_auth", message);
  }
  ok("tenant_auth", "tenant + API key accepted");

  const hostConfigProbe = await hostHelper.applyHostConfig({
    host: config.host,
    env: {
      SETTLD_BASE_URL: normalizedBaseUrl,
      SETTLD_TENANT_ID: tenantId,
      SETTLD_API_KEY: settldApiKey,
      ...(walletEnv ?? {})
    },
    configPath: null,
    dryRun: true
  });
  if (!hostConfigProbe?.configPath) {
    fail("host_config", "host config path could not be resolved");
  }
  try {
    await assertPathLikelyWritable(hostConfigProbe.configPath);
  } catch (err) {
    fail("host_config", `path not writable (${hostConfigProbe.configPath}): ${err?.message ?? String(err)}`);
  }
  ok("host_config", `${hostConfigProbe.configPath}`);
  if (verbose) stdout.write("Preflight checks passed.\n");
  return {
    ok: true,
    checks,
    hostConfigPreview: hostConfigProbe
  };
}

function mustString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

async function promptLine(rl, label, { required = true, defaultValue = null } = {}) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  const value = answer.trim() || (defaultValue ? String(defaultValue).trim() : "");
  if (!required) return value;
  if (value) return value;
  throw new Error(`${label} is required`);
}

function createMutableOutput(output) {
  return {
    muted: false,
    write(chunk, encoding, callback) {
      if (this.muted) {
        if (typeof callback === "function") callback();
        return true;
      }
      return output.write(chunk, encoding, callback);
    }
  };
}

async function promptSecretLine(rl, outputProxy, stdout, label, { required = true } = {}) {
  stdout.write(`${label}: `);
  outputProxy.muted = true;
  let answer = "";
  try {
    answer = await rl.question("");
  } finally {
    outputProxy.muted = false;
    stdout.write("\n");
  }
  const value = String(answer ?? "").trim();
  if (value || !required) return value;
  throw new Error(`${label} is required`);
}

function toEnvFileText(env) {
  const keys = Object.keys(env).sort();
  return `${keys.map((k) => `${k}=${String(env[k] ?? "")}`).join("\n")}\n`;
}

function shellQuote(value) {
  const s = String(value ?? "");
  if (!s) return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function toExportText(env) {
  const keys = Object.keys(env).sort();
  return keys.map((k) => `export ${k}=${shellQuote(env[k])}`).join("\n");
}

function printStep(stdout, index, total, label) {
  stdout.write(`[${index}/${total}] ${label}\n`);
}

async function writeJsonReport(reportPath, payload) {
  if (!reportPath) return;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function inferCircleReserveMode(baseUrl) {
  const normalized = normalizeHttpUrl(baseUrl);
  if (!normalized) return null;
  if (normalized.includes("api-sandbox.circle.com")) return "sandbox";
  return "production";
}

function buildHostNextSteps({ host, installedHosts }) {
  const steps = [];
  const installed = Array.isArray(installedHosts) && installedHosts.includes(host);
  if (!installed) {
    const bin = HOST_BINARY_HINTS[host] ?? host;
    steps.push(`Install ${host} CLI/app so MCP config can be consumed (expected binary: ${bin}).`);
  }
  if (host === "openclaw") {
    steps.push("Run `openclaw doctor` then `openclaw tui`.");
    steps.push("In OpenClaw, ask for a Settld tool call (for example: `run settld.about`).");
    return steps;
  }
  if (host === "codex") {
    steps.push("Restart Codex so it reloads MCP config.");
    steps.push("Run a Settld tool call (for example: `settld.about`).");
    return steps;
  }
  if (host === "claude") {
    steps.push("Restart Claude Desktop so it reloads MCP config.");
    steps.push("Run a Settld tool call (for example: `settld.about`).");
    return steps;
  }
  if (host === "cursor") {
    steps.push("Restart Cursor so it reloads MCP config.");
    steps.push("Run a Settld tool call (for example: `settld.about`).");
    return steps;
  }
  steps.push("Run a Settld MCP tool call (for example: `settld.about`).");
  return steps;
}

function resolveByoWalletEnv({ args, runtimeEnv }) {
  const env = {};
  for (const row of args.walletEnvRows) env[row.key] = row.value;
  if (args.walletProvider === "circle") {
    for (const key of CIRCLE_BYO_REQUIRED_KEYS) {
      if (typeof env[key] === "string" && env[key].trim()) continue;
      const fromProcess = String(runtimeEnv[key] ?? "").trim();
      if (fromProcess) env[key] = fromProcess;
    }
    const missing = CIRCLE_BYO_REQUIRED_KEYS.filter((key) => !(typeof env[key] === "string" && String(env[key]).trim()));
    if (missing.length) {
      throw new Error(`BYO wallet mode missing required env keys: ${missing.join(", ")} (set --wallet-env KEY=VALUE or shell env)`);
    }
    if (!(typeof env.X402_CIRCLE_RESERVE_MODE === "string" && String(env.X402_CIRCLE_RESERVE_MODE).trim())) {
      env.X402_CIRCLE_RESERVE_MODE = inferCircleReserveMode(env.CIRCLE_BASE_URL) ?? "production";
    }
    if (!(typeof env.X402_REQUIRE_EXTERNAL_RESERVE === "string" && String(env.X402_REQUIRE_EXTERNAL_RESERVE).trim())) {
      env.X402_REQUIRE_EXTERNAL_RESERVE = "1";
    }
  }
  return env;
}

async function requestRemoteWalletBootstrap({
  baseUrl,
  tenantId,
  settldApiKey,
  walletProvider,
  circleMode,
  circleBaseUrl,
  circleBlockchain,
  fetchImpl = fetch
} = {}) {
  const normalizedBaseUrl = normalizeHttpUrl(baseUrl);
  if (!normalizedBaseUrl) throw new Error(`invalid wallet bootstrap base URL: ${baseUrl}`);

  const body = {
    provider: walletProvider
  };
  if (walletProvider === "circle") {
    const circle = {};
    if (typeof circleMode === "string" && circleMode.trim()) circle.mode = circleMode.trim();
    if (typeof circleBaseUrl === "string" && circleBaseUrl.trim()) circle.baseUrl = circleBaseUrl.trim();
    if (typeof circleBlockchain === "string" && circleBlockchain.trim()) circle.blockchain = circleBlockchain.trim();
    if (Object.keys(circle).length > 0) body.circle = circle;
  }

  const url = new URL(`/v1/tenants/${encodeURIComponent(String(tenantId ?? ""))}/onboarding/wallet-bootstrap`, normalizedBaseUrl);
  const res = await fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": String(settldApiKey ?? "")
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object"
        ? json?.message ?? json?.error ?? `HTTP ${res.status}`
        : text || `HTTP ${res.status}`;
    throw new Error(`remote wallet bootstrap failed (${res.status}): ${String(message)}`);
  }
  const bootstrap = json?.walletBootstrap;
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) {
    throw new Error("remote wallet bootstrap response missing walletBootstrap object");
  }
  if (!bootstrap.env || typeof bootstrap.env !== "object" || Array.isArray(bootstrap.env)) {
    throw new Error("remote wallet bootstrap response missing walletBootstrap.env");
  }
  return bootstrap;
}

async function resolveRuntimeConfig({
  args,
  runtimeEnv,
  stdin = process.stdin,
  stdout = process.stdout,
  detectInstalledHostsImpl = detectInstalledHosts
}) {
  const installedHosts = detectInstalledHostsImpl();
  const defaultHost = selectDefaultHost({
    explicitHost: args.host ? String(args.host).toLowerCase() : "",
    installedHosts
  });
  const out = {
    host: args.host ?? defaultHost,
    walletMode: args.walletMode,
    baseUrl: String(args.baseUrl ?? runtimeEnv.SETTLD_BASE_URL ?? "").trim(),
    tenantId: String(args.tenantId ?? runtimeEnv.SETTLD_TENANT_ID ?? "").trim(),
    settldApiKey: String(args.settldApiKey ?? runtimeEnv.SETTLD_API_KEY ?? "").trim(),
    walletProvider: args.walletProvider,
    walletBootstrap: args.walletBootstrap,
    circleApiKey: String(args.circleApiKey ?? runtimeEnv.CIRCLE_API_KEY ?? "").trim(),
    circleMode: args.circleMode,
    circleBaseUrl: String(args.circleBaseUrl ?? runtimeEnv.CIRCLE_BASE_URL ?? "").trim(),
    circleBlockchain: String(args.circleBlockchain ?? runtimeEnv.CIRCLE_BLOCKCHAIN ?? "").trim(),
    profileId: args.profileId,
    skipProfileApply: Boolean(args.skipProfileApply),
    preflight: Boolean(args.preflight),
    smoke: Boolean(args.smoke),
    dryRun: Boolean(args.dryRun),
    installedHosts
  };

  if (args.nonInteractive) {
    if (!SUPPORTED_HOSTS.includes(out.host)) throw new Error(`--host must be one of: ${SUPPORTED_HOSTS.join(", ")}`);
    if (!out.baseUrl) throw new Error("--base-url is required");
    if (!out.tenantId) throw new Error("--tenant-id is required");
    if (!out.settldApiKey) throw new Error("--settld-api-key is required");
    if (out.walletMode === "managed" && out.walletBootstrap === "local" && !out.circleApiKey) {
      throw new Error("--circle-api-key is required for --wallet-mode managed --wallet-bootstrap local");
    }
    return out;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("interactive mode requires a TTY. Re-run with --non-interactive and explicit flags.");
  }
  const mutableOutput = createMutableOutput(stdout);
  const rl = createInterface({ input: stdin, output: mutableOutput });
  try {
    stdout.write("Settld guided setup\n");
    stdout.write("===================\n");
    if (installedHosts.length > 0) {
      stdout.write(`Detected hosts: ${installedHosts.join(", ")}\n`);
    } else {
      stdout.write("Detected hosts: none (will still write config files)\n");
    }
    stdout.write("\n");

    const hostPromptDefault = out.host && SUPPORTED_HOSTS.includes(out.host) ? out.host : defaultHost;
    out.host = (
      await promptLine(rl, `Host (${SUPPORTED_HOSTS.join("/")})`, {
        defaultValue: hostPromptDefault
      })
    ).toLowerCase();
    if (!SUPPORTED_HOSTS.includes(out.host)) throw new Error(`host must be one of: ${SUPPORTED_HOSTS.join(", ")}`);
    if (!out.walletMode) out.walletMode = "managed";
    out.walletMode = (
      await promptLine(rl, "Wallet mode (managed/byo/none)", { defaultValue: out.walletMode, required: true })
    ).toLowerCase();
    if (!WALLET_MODES.has(out.walletMode)) throw new Error("wallet mode must be managed, byo, or none");

    if (!out.baseUrl) {
      out.baseUrl = await promptLine(rl, "Settld base URL", { defaultValue: "https://api.settld.work" });
    }
    if (!out.tenantId) {
      out.tenantId = await promptLine(rl, "Tenant ID", { defaultValue: "tenant_default" });
    }
    if (!out.settldApiKey) out.settldApiKey = await promptSecretLine(rl, mutableOutput, stdout, "Settld API key");

    if (out.walletMode === "managed") {
      out.walletBootstrap = (
        await promptLine(rl, "Managed wallet bootstrap (auto/local/remote)", {
          defaultValue: out.walletBootstrap || "auto",
          required: true
        })
      ).toLowerCase();
      if (!WALLET_BOOTSTRAP_MODES.has(out.walletBootstrap)) throw new Error("wallet bootstrap must be auto, local, or remote");
      if (out.walletBootstrap === "local" && !out.circleApiKey) {
        out.circleApiKey = await promptSecretLine(rl, mutableOutput, stdout, "Circle API key");
      }
    }
    return out;
  } finally {
    rl.close();
  }
}

export async function runOnboard({
  argv = process.argv.slice(2),
  fetchImpl = fetch,
  stdin = process.stdin,
  stdout = process.stdout,
  runtimeEnv = process.env,
  runWizardImpl = runWizard,
  loadHostConfigHelperImpl = loadHostConfigHelper,
  bootstrapWalletProviderImpl = bootstrapWalletProvider,
  requestRemoteWalletBootstrapImpl = requestRemoteWalletBootstrap,
  runPreflightChecksImpl = runPreflightChecks,
  detectInstalledHostsImpl = detectInstalledHosts
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return { ok: true, code: 0 };
  }

  const showSteps = args.format !== "json";
  const totalSteps = args.preflightOnly ? 4 : 5;
  let step = 1;

  if (showSteps) printStep(stdout, step, totalSteps, "Resolve setup configuration");
  const config = await resolveRuntimeConfig({
    args,
    runtimeEnv,
    stdin,
    stdout,
    detectInstalledHostsImpl
  });
  step += 1;
  const normalizedBaseUrl = normalizeHttpUrl(mustString(config.baseUrl, "SETTLD_BASE_URL / --base-url"));
  if (!normalizedBaseUrl) throw new Error(`invalid Settld base URL: ${config.baseUrl}`);
  const tenantId = mustString(config.tenantId, "SETTLD_TENANT_ID / --tenant-id");
  const settldApiKey = mustString(config.settldApiKey, "SETTLD_API_KEY / --settld-api-key");

  if (showSteps) printStep(stdout, step, totalSteps, "Resolve wallet configuration");
  let walletBootstrapMode = "none";
  let wallet = null;
  let walletEnv = {};
  if (config.walletMode === "managed") {
    walletBootstrapMode =
      config.walletBootstrap === "auto"
        ? (config.circleApiKey ? "local" : "remote")
        : config.walletBootstrap;
    if (walletBootstrapMode === "local") {
      if (!config.circleApiKey) throw new Error("Circle API key is required for local managed wallet bootstrap");
      wallet = await bootstrapWalletProviderImpl({
        provider: config.walletProvider,
        apiKey: config.circleApiKey,
        mode: config.circleMode,
        baseUrl: config.circleBaseUrl || null,
        blockchain: config.circleBlockchain || null,
        includeApiKey: false,
        fetchImpl
      });
    } else {
      wallet = await requestRemoteWalletBootstrapImpl({
        baseUrl: normalizedBaseUrl,
        tenantId,
        settldApiKey,
        walletProvider: config.walletProvider,
        circleMode: config.circleMode,
        circleBaseUrl: config.circleBaseUrl || null,
        circleBlockchain: config.circleBlockchain || null,
        fetchImpl
      });
    }
    walletEnv = wallet?.env && typeof wallet.env === "object" ? { ...wallet.env } : {};
  } else if (config.walletMode === "byo") {
    walletBootstrapMode = "byo";
    walletEnv = resolveByoWalletEnv({ args, runtimeEnv });
  }
  step += 1;

  let preflight = { ok: false, skipped: true, checks: [] };
  if (config.preflight) {
    if (showSteps) printStep(stdout, step, totalSteps, "Run preflight checks");
    const hostHelper = await loadHostConfigHelperImpl();
    preflight = await runPreflightChecksImpl({
      config,
      normalizedBaseUrl,
      tenantId,
      settldApiKey,
      hostHelper,
      walletEnv,
      fetchImpl,
      stdout,
      verbose: showSteps
    });
  } else {
    if (showSteps) printStep(stdout, step, totalSteps, "Skip preflight checks");
  }
  step += 1;

  if (args.preflightOnly) {
    if (showSteps) printStep(stdout, step, totalSteps, "Finalize preflight-only output");
    const payload = {
      ok: true,
      preflightOnly: true,
      host: config.host,
      wallet: {
        mode: config.walletMode,
        bootstrapMode: walletBootstrapMode,
        provider: config.walletProvider,
        details: wallet && typeof wallet === "object" ? wallet : null
      },
      settld: {
        baseUrl: normalizedBaseUrl,
        tenantId,
        preflight: Boolean(config.preflight),
        smoke: false,
        profileApplied: false,
        profileId: null
      },
      preflight,
      hostInstallDetected: Array.isArray(config.installedHosts) && config.installedHosts.includes(config.host),
      installedHosts: config.installedHosts,
      env: walletEnv,
      outEnv: args.outEnv ?? null,
      reportPath: args.reportPath ?? null
    };
    if (args.outEnv) {
      await fs.mkdir(path.dirname(args.outEnv), { recursive: true });
      await fs.writeFile(args.outEnv, toEnvFileText(walletEnv), "utf8");
    }
    await writeJsonReport(args.reportPath, payload);
    if (args.format === "json") {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      const lines = [];
      lines.push("Settld preflight completed.");
      lines.push(`Host: ${config.host}`);
      lines.push(`Settld: ${normalizedBaseUrl} (tenant=${tenantId})`);
      lines.push(`Wallet mode: ${config.walletMode}`);
      lines.push(`Wallet bootstrap mode: ${walletBootstrapMode}`);
      if (args.outEnv) lines.push(`Wrote env file: ${args.outEnv}`);
      if (args.reportPath) lines.push(`Wrote report: ${args.reportPath}`);
      lines.push("");
      lines.push("Preflight checks:");
      for (const row of preflight.checks ?? []) {
        lines.push(`- ${row.name}: ${row.detail}`);
      }
      stdout.write(`${lines.join("\n")}\n`);
    }
    return payload;
  }

  if (showSteps) printStep(stdout, step, totalSteps, "Write host config + apply policy/smoke");
  const wizardArgv = [
    "--non-interactive",
    "--mode",
    "manual",
    "--host",
    config.host,
    "--base-url",
    normalizedBaseUrl,
    "--tenant-id",
    tenantId,
    "--api-key",
    settldApiKey
  ];
  if (config.skipProfileApply) wizardArgv.push("--skip-profile-apply");
  else wizardArgv.push("--profile-id", config.profileId || "engineering-spend");
  if (config.smoke) wizardArgv.push("--smoke");
  if (config.dryRun) wizardArgv.push("--dry-run");

  const wizardResult = await runWizardImpl({
    argv: wizardArgv,
    fetchImpl,
    stdout,
    extraEnv: walletEnv
  });
  step += 1;

  const mergedEnv = {
    ...(walletEnv ?? {}),
    ...(wizardResult?.env && typeof wizardResult.env === "object" ? wizardResult.env : {})
  };

  if (args.outEnv) {
    await fs.mkdir(path.dirname(args.outEnv), { recursive: true });
    await fs.writeFile(args.outEnv, toEnvFileText(mergedEnv), "utf8");
  }

  if (showSteps) printStep(stdout, step, totalSteps, "Finalize output");
  const payload = {
    ok: true,
    host: config.host,
    wallet: {
      mode: config.walletMode,
      bootstrapMode: walletBootstrapMode,
      provider: config.walletProvider,
      details: wallet && typeof wallet === "object" ? wallet : null
    },
    settld: {
      baseUrl: normalizedBaseUrl,
      tenantId,
      preflight: Boolean(config.preflight),
      smoke: Boolean(config.smoke),
      profileApplied: !config.skipProfileApply,
      profileId: config.skipProfileApply ? null : (config.profileId || "engineering-spend")
    },
    preflight,
    hostInstallDetected: Array.isArray(config.installedHosts) && config.installedHosts.includes(config.host),
    installedHosts: config.installedHosts,
    env: mergedEnv,
    outEnv: args.outEnv ?? null,
    reportPath: args.reportPath ?? null
  };
  await writeJsonReport(args.reportPath, payload);

  if (args.format === "json") {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const lines = [];
    lines.push("Settld onboard complete.");
    lines.push(`Host: ${config.host}`);
    lines.push(`Settld: ${normalizedBaseUrl} (tenant=${tenantId})`);
    lines.push(`Preflight: ${config.preflight ? "passed" : "skipped"}`);
    lines.push(`Wallet mode: ${config.walletMode}`);
    lines.push(`Wallet bootstrap mode: ${walletBootstrapMode}`);
    if (wallet?.wallets?.spend?.walletId) lines.push(`Spend wallet: ${wallet.wallets.spend.walletId}`);
    if (wallet?.wallets?.escrow?.walletId) lines.push(`Escrow wallet: ${wallet.wallets.escrow.walletId}`);
    if (wallet?.tokenIdUsdc) lines.push(`USDC token id: ${wallet.tokenIdUsdc}`);
    if (args.outEnv) lines.push(`Wrote env file: ${args.outEnv}`);
    lines.push("");
    lines.push("Combined exports:");
    lines.push(toExportText(mergedEnv));
    lines.push("");
    lines.push("Next:");
    let step = 1;
    for (const row of buildHostNextSteps({ host: config.host, installedHosts: config.installedHosts })) {
      lines.push(`${step}. ${row}`);
      step += 1;
    }
    lines.push(`${step}. Run \`npm run mcp:probe\` for an immediate health check.`);
    stdout.write(`${lines.join("\n")}\n`);
  }

  return payload;
}

async function main(argv = process.argv.slice(2)) {
  try {
    await runOnboard({ argv });
  } catch (err) {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
