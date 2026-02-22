#!/usr/bin/env node

import fs from "node:fs/promises";
import fsNative from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { bootstrapWalletProvider } from "../../src/core/wallet-provider-bootstrap.js";
import { extractBootstrapMcpEnv, loadHostConfigHelper, runWizard } from "./wizard.mjs";
import { SUPPORTED_HOSTS } from "./host-config.mjs";
import { defaultSessionPath, readSavedSession } from "./session-store.mjs";

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
const ONBOARDING_DOCS_PATH = "docs/QUICKSTART_MCP_HOSTS.md";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const SETTLD_BIN = path.join(REPO_ROOT, "bin", "settld.js");
const PROFILE_FINGERPRINT_REGEX = /^[0-9a-f]{64}$/;
const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_DIM = "\u001b[2m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_MAGENTA = "\u001b[35m";

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
    "  --bootstrap-api-key <key>       Onboarding bootstrap API key used to mint tenant API key",
    "  --magic-link-api-key <key>      Alias for --bootstrap-api-key",
    "  --session-file <path>           Saved login session path (default: ~/.settld/session.json)",
    "  --bootstrap-key-id <id>         Optional API key ID hint for runtime bootstrap",
    "  --bootstrap-scopes <csv>        Optional scopes for generated tenant API key",
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
    bootstrapApiKey: null,
    sessionFile: defaultSessionPath(),
    bootstrapKeyId: null,
    bootstrapScopes: null,
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
    if (
      arg === "--bootstrap-api-key" ||
      arg === "--magic-link-api-key" ||
      arg.startsWith("--bootstrap-api-key=") ||
      arg.startsWith("--magic-link-api-key=")
    ) {
      const parsed = readArgValue(argv, i, arg);
      out.bootstrapApiKey = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--session-file" || arg.startsWith("--session-file=")) {
      const parsed = readArgValue(argv, i, arg);
      out.sessionFile = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--bootstrap-key-id" || arg.startsWith("--bootstrap-key-id=")) {
      const parsed = readArgValue(argv, i, arg);
      out.bootstrapKeyId = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--bootstrap-scopes" || arg.startsWith("--bootstrap-scopes=")) {
      const parsed = readArgValue(argv, i, arg);
      out.bootstrapScopes = parsed.value;
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
  out.sessionFile = path.resolve(process.cwd(), String(out.sessionFile ?? "").trim() || defaultSessionPath());
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

function supportsColor(output = process.stdout, env = process.env) {
  if (!output?.isTTY) return false;
  if (String(env.NO_COLOR ?? "").trim()) return false;
  if (String(env.FORCE_COLOR ?? "").trim() === "0") return false;
  return true;
}

function tint(enabled, code, value) {
  const text = String(value ?? "");
  if (!enabled) return text;
  return `${code}${text}${ANSI_RESET}`;
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

function parseJsonOrNull(text) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
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
    maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runSettldProfileInitProbe({ profileId, outPath, timeoutMs = 12000 } = {}) {
  const args = [SETTLD_BIN, "profile", "init", String(profileId ?? ""), "--out", String(outPath ?? ""), "--force", "--format", "json"];
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runSettldProfileSimulateProbe({ profilePath, timeoutMs = 12000 } = {}) {
  const args = [SETTLD_BIN, "profile", "simulate", String(profilePath ?? ""), "--format", "json"];
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export async function runProfileSimulationPreflight({ profileId, timeoutMs = 12000 } = {}) {
  const resolvedProfileId = String(profileId ?? "").trim() || "engineering-spend";
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-profile-preflight-"));
  const profilePath = path.join(tmpDir, `${resolvedProfileId}.profile.json`);
  try {
    const initProbe = runSettldProfileInitProbe({ profileId: resolvedProfileId, outPath: profilePath, timeoutMs });
    if (initProbe.error?.code === "ETIMEDOUT") {
      return { ok: false, detail: "profile init timed out" };
    }
    if (initProbe.status !== 0) {
      const detail = String(initProbe.stderr || initProbe.stdout || "").trim() || `exit ${initProbe.status}`;
      return { ok: false, detail: `profile init failed: ${detail}` };
    }
    const initJson = parseJsonOrNull(initProbe.stdout);
    const initFingerprint = typeof initJson?.profileFingerprint === "string" ? initJson.profileFingerprint.trim().toLowerCase() : "";
    if (!PROFILE_FINGERPRINT_REGEX.test(initFingerprint)) {
      return { ok: false, detail: "profile init output missing valid profileFingerprint" };
    }

    const simulateProbe = runSettldProfileSimulateProbe({ profilePath, timeoutMs });
    if (simulateProbe.error?.code === "ETIMEDOUT") {
      return { ok: false, detail: "profile simulate timed out" };
    }
    if (simulateProbe.status !== 0) {
      const detail = String(simulateProbe.stderr || simulateProbe.stdout || "").trim() || `exit ${simulateProbe.status}`;
      return { ok: false, detail: `profile simulate failed: ${detail}` };
    }

    const simulateJson = parseJsonOrNull(simulateProbe.stdout);
    if (!simulateJson || typeof simulateJson !== "object") {
      return { ok: false, detail: "profile simulate did not return valid JSON output" };
    }

    const decision = typeof simulateJson.decision === "string" ? simulateJson.decision.trim().toLowerCase() : "";
    if (decision === "allow") {
      return {
        ok: true,
        detail: `profile ${resolvedProfileId} baseline simulation decision=allow (fingerprint=${initFingerprint})`
      };
    }

    const reasonCodes = Array.isArray(simulateJson.reasonCodes) ? simulateJson.reasonCodes.map((value) => String(value)).filter(Boolean) : [];
    const firstHint = Array.isArray(simulateJson.reasonDetails)
      ? simulateJson.reasonDetails.find((row) => typeof row?.remediationHint === "string" && row.remediationHint.trim())
      : null;
    const hintText = firstHint ? `; remediation=${String(firstHint.remediationHint).trim()}` : "";
    const reasonText = reasonCodes.length ? reasonCodes.join(",") : "none";
    return {
      ok: false,
      detail: `profile ${resolvedProfileId} baseline simulation decision=${decision || "unknown"} reasonCodes=${reasonText}${hintText}`
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
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
  const probeJson = parseJsonOrNull(probe.stdout);
  if (!probeJson || typeof probeJson !== "object" || probeJson.schemaVersion !== "SettldProfileTemplateCatalog.v1") {
    fail("tenant_auth", "profile list probe returned invalid JSON schema");
  }
  const catalogProfiles = Array.isArray(probeJson.profiles) ? probeJson.profiles : [];
  if (!catalogProfiles.length) {
    fail("tenant_auth", "profile list probe returned empty profile catalog");
  }
  const missingFingerprint = catalogProfiles.some((row) => {
    const fingerprint = typeof row?.profileFingerprint === "string" ? row.profileFingerprint.trim().toLowerCase() : "";
    return !PROFILE_FINGERPRINT_REGEX.test(fingerprint);
  });
  if (missingFingerprint) {
    fail("tenant_auth", "profile list probe returned profile rows without valid profileFingerprint");
  }
  ok("tenant_auth", "tenant + API key accepted");

  if (config.skipProfileApply === true) {
    ok("profile_policy", "skipped (skip-profile-apply enabled)");
  } else {
    const profilePolicy = await runProfileSimulationPreflight({ profileId: config.profileId });
    if (!profilePolicy.ok) {
      fail("profile_policy", profilePolicy.detail);
    }
    ok("profile_policy", profilePolicy.detail);
  }

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

function findOptionIndex(options, value, fallback = 0) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  const idx = options.findIndex((option) => String(option?.value ?? "").trim().toLowerCase() === normalized);
  if (idx < 0) return fallback;
  return idx;
}

async function promptSelect(
  rl,
  stdin,
  stdout,
  label,
  options,
  { defaultValue = null, hint = null, color = false } = {}
) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(`${label} requires at least one option`);
  }
  const normalizedOptions = options.map((option) => {
    const value = String(option?.value ?? "").trim();
    const display = String(option?.label ?? value).trim() || value;
    const detail = typeof option?.hint === "string" ? option.hint.trim() : "";
    return { value, label: display, hint: detail };
  });
  if (!stdin?.isTTY || typeof stdin.setRawMode !== "function") {
    const fallbackValue = defaultValue ?? normalizedOptions[0].value;
    const joined = normalizedOptions.map((option) => option.value).join("/");
    const picked = (
      await promptLine(rl, `${label} (${joined})`, {
        defaultValue: fallbackValue
      })
    ).toLowerCase();
    const idx = findOptionIndex(normalizedOptions, picked, -1);
    if (idx < 0) {
      throw new Error(`${label} must be one of: ${normalizedOptions.map((option) => option.value).join(", ")}`);
    }
    return normalizedOptions[idx].value;
  }

  let index = findOptionIndex(normalizedOptions, defaultValue, 0);
  const wasRaw = stdin.isRaw === true;
  let renderedLines = 0;

  const render = () => {
    const lines = [];
    lines.push(tint(color, ANSI_CYAN, `${label} (arrow keys + Enter)`));
    for (let i = 0; i < normalizedOptions.length; i += 1) {
      const option = normalizedOptions[i];
      const prefix = i === index ? tint(color, ANSI_GREEN, "●") : tint(color, ANSI_DIM, "○");
      const detail = option.hint ? ` - ${option.hint}` : "";
      lines.push(`  ${prefix} ${i === index ? tint(color, ANSI_BOLD, option.label) : option.label}${tint(color, ANSI_DIM, detail)}`);
    }
    if (hint) lines.push(`  ${tint(color, ANSI_DIM, hint)}`);
    if (renderedLines > 0) {
      stdout.write(`\u001b[${renderedLines}A`);
    }
    for (const line of lines) {
      stdout.write(`\u001b[2K\r${line}\n`);
    }
    renderedLines = lines.length;
  };

  if (typeof rl?.pause === "function") rl.pause();
  if (!wasRaw) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  render();

  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off("data", onData);
      if (!wasRaw) stdin.setRawMode(false);
      if (typeof rl?.resume === "function") rl.resume();
    };

    const resolveWithSelection = () => {
      const selected = normalizedOptions[index];
      cleanup();
      stdout.write(`\u001b[2K\r${tint(color, ANSI_CYAN, label)}: ${tint(color, ANSI_GREEN, selected.label)}\n`);
      resolve(selected.value);
    };

    const onData = (chunk) => {
      const key = String(chunk ?? "");
      if (!key) return;
      if (key === "\u0003") {
        cleanup();
        reject(new Error("setup cancelled by user"));
        return;
      }
      if (key === "\r" || key === "\n") {
        resolveWithSelection();
        return;
      }
      if (key === "\u001b[A" || key === "k" || key === "K") {
        index = (index - 1 + normalizedOptions.length) % normalizedOptions.length;
        render();
        return;
      }
      if (key === "\u001b[B" || key === "j" || key === "J") {
        index = (index + 1) % normalizedOptions.length;
        render();
      }
    };

    stdin.on("data", onData);
  });
}

async function promptBooleanChoice(
  rl,
  stdin,
  stdout,
  label,
  defaultValue,
  { trueLabel = "Yes", falseLabel = "No", hint = null, color = false } = {}
) {
  const selected = await promptSelect(
    rl,
    stdin,
    stdout,
    label,
    [
      { value: "yes", label: trueLabel },
      { value: "no", label: falseLabel }
    ],
    { defaultValue: defaultValue ? "yes" : "no", hint, color }
  );
  return selected === "yes";
}

function upsertWalletEnvRow(rows, key, value) {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) return;
  const normalizedValue = String(value ?? "");
  const idx = rows.findIndex((row) => String(row?.key ?? "").trim() === normalizedKey);
  if (idx >= 0) {
    rows[idx] = { key: normalizedKey, value: normalizedValue };
    return;
  }
  rows.push({ key: normalizedKey, value: normalizedValue });
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
    steps.push("Run `openclaw doctor` and ensure OpenClaw itself is onboarded (`openclaw onboard --install-daemon`).");
    steps.push("Run `openclaw tui`.");
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

function resolveByoWalletEnv({ walletProvider, walletEnvRows, runtimeEnv }) {
  const env = {};
  for (const row of walletEnvRows ?? []) env[row.key] = row.value;
  if (walletProvider === "circle") {
    for (const key of CIRCLE_BYO_REQUIRED_KEYS) {
      if (typeof env[key] === "string" && env[key].trim()) continue;
      const fromProcess = String(runtimeEnv[key] ?? "").trim();
      if (fromProcess) env[key] = fromProcess;
    }
    const missing = CIRCLE_BYO_REQUIRED_KEYS.filter((key) => !(typeof env[key] === "string" && String(env[key]).trim()));
    if (missing.length) {
      throw new Error(
        `BYO wallet mode missing required env keys: ${missing.join(", ")} (set --wallet-env KEY=VALUE or shell env; see ${ONBOARDING_DOCS_PATH}#3-wallet-modes-managed-vs-byo)`
      );
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

function parseScopes(raw) {
  if (!raw || !String(raw).trim()) return [];
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(",")) {
    const scope = String(part ?? "").trim();
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  return out;
}

async function requestRuntimeBootstrapMcpEnv({
  baseUrl,
  tenantId,
  bootstrapApiKey,
  sessionCookie,
  bootstrapKeyId = null,
  bootstrapScopes = [],
  idempotencyKey = null,
  fetchImpl = fetch
} = {}) {
  const normalizedBaseUrl = normalizeHttpUrl(baseUrl);
  if (!normalizedBaseUrl) throw new Error(`invalid runtime bootstrap base URL: ${baseUrl}`);
  const apiKey = String(bootstrapApiKey ?? "").trim();
  const cookie = String(sessionCookie ?? "").trim();
  if (!apiKey && !cookie) {
    throw new Error("runtime bootstrap requires bootstrap API key or saved login session");
  }

  const headers = {
    "content-type": "application/json"
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  if (cookie) headers.cookie = cookie;
  if (idempotencyKey) headers["x-idempotency-key"] = String(idempotencyKey);

  const body = {
    apiKey: {
      create: true,
      description: "settld setup runtime bootstrap"
    }
  };
  if (bootstrapKeyId) body.apiKey.keyId = String(bootstrapKeyId);
  if (Array.isArray(bootstrapScopes) && bootstrapScopes.length > 0) {
    body.apiKey.scopes = bootstrapScopes;
  }

  const url = new URL(
    `/v1/tenants/${encodeURIComponent(String(tenantId ?? ""))}/onboarding/runtime-bootstrap`,
    normalizedBaseUrl
  );
  const res = await fetchImpl(url.toString(), {
    method: "POST",
    headers,
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
    throw new Error(`runtime bootstrap request failed (${res.status}): ${String(message)}`);
  }
  return extractBootstrapMcpEnv(json);
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
  const sessionFile = String(args.sessionFile ?? runtimeEnv.SETTLD_SESSION_FILE ?? defaultSessionPath()).trim();
  const savedSession = await readSavedSession({ sessionPath: sessionFile });
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
    bootstrapApiKey: String(
      args.bootstrapApiKey ?? runtimeEnv.SETTLD_BOOTSTRAP_API_KEY ?? runtimeEnv.MAGIC_LINK_API_KEY ?? ""
    ).trim(),
    sessionFile,
    sessionCookie: String(runtimeEnv.SETTLD_SESSION_COOKIE ?? "").trim(),
    bootstrapKeyId: String(args.bootstrapKeyId ?? runtimeEnv.SETTLD_BOOTSTRAP_KEY_ID ?? "").trim(),
    bootstrapScopes: String(args.bootstrapScopes ?? runtimeEnv.SETTLD_BOOTSTRAP_SCOPES ?? "").trim(),
    walletProvider: args.walletProvider,
    walletBootstrap: args.walletBootstrap,
    circleApiKey: String(args.circleApiKey ?? runtimeEnv.CIRCLE_API_KEY ?? "").trim(),
    circleMode: args.circleMode,
    circleBaseUrl: String(args.circleBaseUrl ?? runtimeEnv.CIRCLE_BASE_URL ?? "").trim(),
    circleBlockchain: String(args.circleBlockchain ?? runtimeEnv.CIRCLE_BLOCKCHAIN ?? "").trim(),
    walletEnvRows: Array.isArray(args.walletEnvRows) ? args.walletEnvRows.map((row) => ({ ...row })) : [],
    profileId: args.profileId,
    skipProfileApply: Boolean(args.skipProfileApply),
    preflight: Boolean(args.preflight),
    smoke: Boolean(args.smoke),
    dryRun: Boolean(args.dryRun),
    installedHosts
  };
  if (savedSession) {
    if (!out.baseUrl) out.baseUrl = String(savedSession.baseUrl ?? "").trim();
    if (!out.tenantId) out.tenantId = String(savedSession.tenantId ?? "").trim();
    if (!out.sessionCookie) out.sessionCookie = String(savedSession.cookie ?? "").trim();
  }

  if (args.nonInteractive) {
    if (!SUPPORTED_HOSTS.includes(out.host)) throw new Error(`--host must be one of: ${SUPPORTED_HOSTS.join(", ")}`);
    if (!out.baseUrl) throw new Error("--base-url is required");
    if (!out.tenantId) throw new Error("--tenant-id is required");
    if (!out.settldApiKey && !out.bootstrapApiKey && !out.sessionCookie) {
      throw new Error("--settld-api-key, --bootstrap-api-key, or saved login session is required");
    }
    if (out.walletMode === "managed" && out.walletBootstrap === "local" && !out.circleApiKey) {
      throw new Error("--circle-api-key is required for --wallet-mode managed --wallet-bootstrap local");
    }
    return out;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("interactive mode requires a TTY. Re-run with --non-interactive and explicit flags.");
  }
  const color = supportsColor(stdout, runtimeEnv);
  const mutableOutput = createMutableOutput(stdout);
  const rl = createInterface({ input: stdin, output: mutableOutput });
  try {
    const title = tint(color, ANSI_BOLD, "Settld guided setup");
    const subtitle = tint(color, ANSI_DIM, "Deterministic onboarding for trusted agent spend");
    stdout.write(`${title}\n`);
    stdout.write(`${tint(color, ANSI_MAGENTA, "===================")}\n`);
    stdout.write(`${subtitle}\n`);
    if (installedHosts.length > 0) {
      stdout.write(`${tint(color, ANSI_CYAN, "Detected hosts")}: ${installedHosts.join(", ")}\n`);
    } else {
      stdout.write(`${tint(color, ANSI_CYAN, "Detected hosts")}: none (will still write config files)\n`);
    }
    if (savedSession?.tenantId) {
      stdout.write(`${tint(color, ANSI_GREEN, "Saved login session")}: tenant ${savedSession.tenantId}\n`);
    }
    stdout.write("\n");

    const hostPromptDefault = out.host && SUPPORTED_HOSTS.includes(out.host) ? out.host : defaultHost;
    const hostOptions = SUPPORTED_HOSTS.map((host) => ({
      value: host,
      label: installedHosts.includes(host) ? `${host} (detected)` : host
    }));
    out.host = await promptSelect(
      rl,
      stdin,
      stdout,
      "Select host",
      hostOptions,
      { defaultValue: hostPromptDefault, hint: "Up/Down arrows change selection", color }
    );

    if (!out.walletMode) out.walletMode = "managed";
    out.walletMode = await promptSelect(
      rl,
      stdin,
      stdout,
      "Select wallet mode",
      [
        { value: "managed", label: "managed", hint: "Settld bootstraps wallet env for you" },
        { value: "byo", label: "byo", hint: "Use your existing wallet IDs and secrets" },
        { value: "none", label: "none", hint: "No payment rail wiring during setup" }
      ],
      { defaultValue: out.walletMode, color }
    );

    if (!out.baseUrl) {
      out.baseUrl = await promptLine(rl, "Settld base URL", { defaultValue: "https://api.settld.work" });
    }
    if (!out.tenantId) {
      out.tenantId = await promptLine(rl, "Tenant ID", { defaultValue: "tenant_default" });
    }
    if (!out.settldApiKey) {
      const canUseSavedSession =
        Boolean(out.sessionCookie) &&
        (!savedSession ||
          (normalizeHttpUrl(out.baseUrl) === normalizeHttpUrl(savedSession?.baseUrl) &&
            String(out.tenantId ?? "").trim() === String(savedSession?.tenantId ?? "").trim()));
      const keyOptions = [];
      if (canUseSavedSession) {
        keyOptions.push({
          value: "session",
          label: "Use saved login session",
          hint: `Reuse ${out.sessionFile} to mint runtime key`
        });
      }
      keyOptions.push(
        { value: "bootstrap", label: "Generate during setup", hint: "Use onboarding bootstrap API key" },
        { value: "manual", label: "Paste existing key", hint: "Use an existing tenant API key" }
      );
      const keyMode = await promptSelect(
        rl,
        stdin,
        stdout,
        "How should setup get your Settld API key?",
        keyOptions,
        { defaultValue: canUseSavedSession ? "session" : "bootstrap", color }
      );
      if (keyMode === "bootstrap") {
        if (!out.bootstrapApiKey) {
          out.bootstrapApiKey = await promptSecretLine(rl, mutableOutput, stdout, "Onboarding bootstrap API key");
        }
        if (!out.bootstrapKeyId) {
          out.bootstrapKeyId = await promptLine(rl, "Generated key ID (optional)", { required: false });
        }
        if (!out.bootstrapScopes) {
          out.bootstrapScopes = await promptLine(rl, "Generated key scopes CSV (optional)", { required: false });
        }
      } else if (keyMode === "manual") {
        out.settldApiKey = await promptSecretLine(rl, mutableOutput, stdout, "Settld API key");
      } else {
        out.bootstrapApiKey = "";
      }
    }

    if (out.walletMode === "managed") {
      out.walletBootstrap = await promptSelect(
        rl,
        stdin,
        stdout,
        "Managed wallet bootstrap",
        [
          { value: "auto", label: "auto", hint: "Use local Circle key when present, else remote bootstrap" },
          { value: "local", label: "local", hint: "Always use local Circle API key flow" },
          { value: "remote", label: "remote", hint: "Always use tenant onboarding endpoint" }
        ],
        { defaultValue: out.walletBootstrap || "auto", color }
      );
      if (out.walletBootstrap === "local" && !out.circleApiKey) {
        out.circleApiKey = await promptSecretLine(rl, mutableOutput, stdout, "Circle API key");
      }
    } else if (out.walletMode === "byo" && out.walletProvider === "circle") {
      for (const key of CIRCLE_BYO_REQUIRED_KEYS) {
        const alreadySet = out.walletEnvRows.find((row) => row?.key === key && String(row?.value ?? "").trim() !== "");
        if (alreadySet) continue;
        const inheritedValue = String(runtimeEnv[key] ?? "").trim();
        if (inheritedValue) {
          upsertWalletEnvRow(out.walletEnvRows, key, inheritedValue);
          continue;
        }
        const isSecret = key === "CIRCLE_ENTITY_SECRET_HEX";
        const value = isSecret
          ? await promptSecretLine(rl, mutableOutput, stdout, key, { required: true })
          : await promptLine(rl, key, { required: true });
        upsertWalletEnvRow(out.walletEnvRows, key, value);
      }
    }

    if (args.preflightOnly) {
      out.preflight = true;
      out.smoke = false;
      out.skipProfileApply = true;
      out.dryRun = true;
    } else {
      out.preflight = await promptBooleanChoice(
        rl,
        stdin,
        stdout,
        "Run preflight checks?",
        out.preflight,
        {
          trueLabel: "Yes - validate API/auth/paths",
          falseLabel: "No - skip preflight",
          color
        }
      );
      out.smoke = await promptBooleanChoice(
        rl,
        stdin,
        stdout,
        "Run MCP smoke test?",
        out.smoke,
        {
          trueLabel: "Yes - run settld.about probe",
          falseLabel: "No - skip smoke",
          color
        }
      );

      const applyProfile = await promptBooleanChoice(
        rl,
        stdin,
        stdout,
        "Apply starter policy profile?",
        !out.skipProfileApply,
        {
          trueLabel: "Yes - apply profile now",
          falseLabel: "No - skip profile apply",
          color
        }
      );
      out.skipProfileApply = !applyProfile;
      if (applyProfile) {
        out.profileId = await promptLine(rl, "Starter profile ID", {
          defaultValue: out.profileId || "engineering-spend"
        });
      }

      out.dryRun = await promptBooleanChoice(
        rl,
        stdin,
        stdout,
        "Dry run host config write?",
        out.dryRun,
        {
          trueLabel: "Yes - preview only",
          falseLabel: "No - write config",
          color
        }
      );
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
  requestRuntimeBootstrapMcpEnvImpl = requestRuntimeBootstrapMcpEnv,
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
  let settldApiKey = String(config.settldApiKey ?? "").trim();
  let runtimeBootstrapEnv = null;
  if (!settldApiKey) {
    if (showSteps) stdout.write("Generating tenant runtime API key via onboarding bootstrap/session...\n");
    runtimeBootstrapEnv = await requestRuntimeBootstrapMcpEnvImpl({
      baseUrl: normalizedBaseUrl,
      tenantId,
      bootstrapApiKey: config.bootstrapApiKey,
      sessionCookie: config.sessionCookie,
      bootstrapKeyId: config.bootstrapKeyId || null,
      bootstrapScopes: parseScopes(config.bootstrapScopes),
      fetchImpl
    });
    settldApiKey = mustString(runtimeBootstrapEnv?.SETTLD_API_KEY ?? "", "runtime bootstrap SETTLD_API_KEY");
  }
  const runtimeBootstrapOptionalEnv = {};
  if (runtimeBootstrapEnv?.SETTLD_PAID_TOOLS_BASE_URL) {
    runtimeBootstrapOptionalEnv.SETTLD_PAID_TOOLS_BASE_URL = String(runtimeBootstrapEnv.SETTLD_PAID_TOOLS_BASE_URL);
  }
  if (runtimeBootstrapEnv?.SETTLD_PAID_TOOLS_AGENT_PASSPORT) {
    runtimeBootstrapOptionalEnv.SETTLD_PAID_TOOLS_AGENT_PASSPORT = String(runtimeBootstrapEnv.SETTLD_PAID_TOOLS_AGENT_PASSPORT);
  }

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
    walletEnv = resolveByoWalletEnv({
      walletProvider: config.walletProvider,
      walletEnvRows: config.walletEnvRows,
      runtimeEnv
    });
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
      env: {
        SETTLD_BASE_URL: normalizedBaseUrl,
        SETTLD_TENANT_ID: tenantId,
        SETTLD_API_KEY: settldApiKey,
        ...runtimeBootstrapOptionalEnv,
        ...walletEnv
      },
      outEnv: args.outEnv ?? null,
      reportPath: args.reportPath ?? null
    };
    if (args.outEnv) {
      await fs.mkdir(path.dirname(args.outEnv), { recursive: true });
      await fs.writeFile(args.outEnv, toEnvFileText(payload.env), "utf8");
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
    extraEnv: {
      ...runtimeBootstrapOptionalEnv,
      ...walletEnv
    }
  });
  step += 1;

  const mergedEnv = {
    ...runtimeBootstrapOptionalEnv,
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
