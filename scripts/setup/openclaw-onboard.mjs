#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCircleBootstrap } from "./circle-bootstrap.mjs";
import { runWizard } from "./wizard.mjs";

const WALLET_PROVIDERS = new Set(["circle"]);
const WALLET_BOOTSTRAP_MODES = new Set(["auto", "local", "remote"]);
const FORMAT_OPTIONS = new Set(["text", "json"]);

function usage() {
  const text = [
    "usage:",
    "  node scripts/setup/openclaw-onboard.mjs [flags]",
    "",
    "flags:",
    "  --base-url <url>                 Settld API base URL (or SETTLD_BASE_URL)",
    "  --tenant-id <id>                 Settld tenant ID (or SETTLD_TENANT_ID)",
    "  --settld-api-key <key>           Settld tenant API key (or SETTLD_API_KEY)",
    "  --wallet-provider <name>         Wallet provider (circle; default: circle)",
    "  --wallet-bootstrap <auto|local|remote>  Wallet setup path (default: auto)",
    "  --circle-api-key <key>           Circle API key (or CIRCLE_API_KEY)",
    "  --circle-mode <auto|sandbox|production>  Circle host selection (default: auto)",
    "  --circle-base-url <url>          Force Circle API URL",
    "  --circle-blockchain <name>       Force Circle blockchain",
    "  --profile-id <id>                Starter profile id (default: engineering-spend)",
    "  --skip-profile-apply             Skip profile apply",
    "  --smoke                          Run MCP smoke check (default: on)",
    "  --no-smoke                       Disable MCP smoke check",
    "  --dry-run                        Dry-run host config write",
    "  --out-env <path>                 Write combined env file (KEY=VALUE)",
    "  --format <text|json>             Output format (default: text)",
    "  --help                           Show this help"
  ].join("\n");
  process.stderr.write(`${text}\n`);
}

function readArgValue(argv, index, rawArg) {
  const arg = String(rawArg ?? "");
  const eq = arg.indexOf("=");
  if (eq >= 0) return { value: arg.slice(eq + 1), nextIndex: index };
  return { value: String(argv[index + 1] ?? ""), nextIndex: index + 1 };
}

function parseArgs(argv) {
  const out = {
    baseUrl: null,
    tenantId: null,
    settldApiKey: null,
    walletProvider: "circle",
    walletBootstrap: "auto",
    circleApiKey: null,
    circleMode: "auto",
    circleBaseUrl: null,
    circleBlockchain: null,
    profileId: "engineering-spend",
    skipProfileApply: false,
    smoke: true,
    dryRun: false,
    outEnv: null,
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
    if (arg === "--skip-profile-apply") {
      out.skipProfileApply = true;
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
    if (arg === "--wallet-provider" || arg.startsWith("--wallet-provider=")) {
      const parsed = readArgValue(argv, i, arg);
      out.walletProvider = String(parsed.value).trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--wallet-bootstrap" || arg.startsWith("--wallet-bootstrap=")) {
      const parsed = readArgValue(argv, i, arg);
      out.walletBootstrap = String(parsed.value).trim().toLowerCase();
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
      out.circleMode = String(parsed.value).trim().toLowerCase();
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
    if (arg === "--format" || arg.startsWith("--format=")) {
      const parsed = readArgValue(argv, i, arg);
      out.format = String(parsed.value).trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  if (!WALLET_PROVIDERS.has(out.walletProvider)) {
    throw new Error(`unsupported --wallet-provider=${out.walletProvider}; supported: circle`);
  }
  if (!WALLET_BOOTSTRAP_MODES.has(out.walletBootstrap)) {
    throw new Error("--wallet-bootstrap must be auto|local|remote");
  }
  if (!FORMAT_OPTIONS.has(out.format)) {
    throw new Error("--format must be text|json");
  }
  if (out.outEnv) out.outEnv = path.resolve(process.cwd(), out.outEnv);
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

function mustString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
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

  const circle = {};
  if (typeof circleMode === "string" && circleMode.trim()) circle.mode = circleMode.trim();
  if (typeof circleBaseUrl === "string" && circleBaseUrl.trim()) circle.baseUrl = circleBaseUrl.trim();
  if (typeof circleBlockchain === "string" && circleBlockchain.trim()) circle.blockchain = circleBlockchain.trim();
  if (Object.keys(circle).length > 0) body.circle = circle;

  const url = new URL(
    `/v1/tenants/${encodeURIComponent(String(tenantId ?? ""))}/onboarding/wallet-bootstrap`,
    normalizedBaseUrl
  );
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

export async function runOpenclawOnboard({
  argv = process.argv.slice(2),
  fetchImpl = fetch,
  runCircleBootstrapImpl = runCircleBootstrap,
  requestRemoteWalletBootstrapImpl = requestRemoteWalletBootstrap,
  runWizardImpl = runWizard,
  stdout = process.stdout
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return { ok: true, code: 0 };
  }

  const baseUrl = mustString(args.baseUrl ?? process.env.SETTLD_BASE_URL ?? "", "SETTLD_BASE_URL / --base-url");
  const normalizedBaseUrl = normalizeHttpUrl(baseUrl);
  if (!normalizedBaseUrl) throw new Error(`invalid Settld base URL: ${baseUrl}`);

  const tenantId = mustString(args.tenantId ?? process.env.SETTLD_TENANT_ID ?? "tenant_default", "SETTLD_TENANT_ID / --tenant-id");
  const settldApiKey = mustString(args.settldApiKey ?? process.env.SETTLD_API_KEY ?? "", "SETTLD_API_KEY / --settld-api-key");
  const circleApiKey = String(args.circleApiKey ?? process.env.CIRCLE_API_KEY ?? "").trim();
  const walletBootstrapMode =
    args.walletBootstrap === "auto"
      ? (circleApiKey ? "local" : "remote")
      : args.walletBootstrap;

  let circle = null;
  if (walletBootstrapMode === "local") {
    const requiredCircleApiKey = mustString(circleApiKey, "CIRCLE_API_KEY / --circle-api-key (required for --wallet-bootstrap=local)");
    const circleArgv = ["--api-key", requiredCircleApiKey, "--mode", args.circleMode, "--format", "json", "--exclude-api-key"];
    if (args.circleBaseUrl) circleArgv.push("--base-url", args.circleBaseUrl);
    if (args.circleBlockchain) circleArgv.push("--blockchain", args.circleBlockchain);
    if (args.dryRun) circleArgv.push("--no-faucet");

    circle = await runCircleBootstrapImpl({ argv: circleArgv, fetchImpl, stdout: { write() {} } });
  } else {
    circle = await requestRemoteWalletBootstrapImpl({
      baseUrl: normalizedBaseUrl,
      tenantId,
      settldApiKey,
      walletProvider: args.walletProvider,
      circleMode: args.circleMode,
      circleBaseUrl: args.circleBaseUrl,
      circleBlockchain: args.circleBlockchain,
      fetchImpl
    });
  }

  const wizardArgv = [
    "--non-interactive",
    "--mode",
    "manual",
    "--host",
    "openclaw",
    "--base-url",
    normalizedBaseUrl,
    "--tenant-id",
    tenantId,
    "--api-key",
    settldApiKey
  ];
  if (args.skipProfileApply) wizardArgv.push("--skip-profile-apply");
  else wizardArgv.push("--profile-id", args.profileId || "engineering-spend");
  if (args.smoke) wizardArgv.push("--smoke");
  if (args.dryRun) wizardArgv.push("--dry-run");

  const wizardResult = await runWizardImpl({
    argv: wizardArgv,
    fetchImpl,
    stdout,
    extraEnv: circle?.env && typeof circle.env === "object" ? circle.env : null
  });

  const mergedEnv = {
    ...(circle?.env && typeof circle.env === "object" ? circle.env : {}),
    ...(wizardResult?.env && typeof wizardResult.env === "object" ? wizardResult.env : {})
  };

  if (args.outEnv) {
    await fs.mkdir(path.dirname(args.outEnv), { recursive: true });
    await fs.writeFile(args.outEnv, toEnvFileText(mergedEnv), "utf8");
  }

  const payload = {
    ok: true,
    host: "openclaw",
    walletProvider: args.walletProvider,
    walletBootstrap: {
      mode: walletBootstrapMode
    },
    circle: {
      mode: circle?.mode ?? null,
      baseUrl: circle?.baseUrl ?? null,
      blockchain: circle?.blockchain ?? null,
      wallets: circle?.wallets ?? null,
      tokenIdUsdc: circle?.tokenIdUsdc ?? null,
      faucetEnabled: Boolean(circle?.faucetEnabled)
    },
    settld: {
      baseUrl: normalizedBaseUrl,
      tenantId,
      smoke: Boolean(args.smoke),
      profileApplied: !args.skipProfileApply,
      profileId: args.skipProfileApply ? null : (args.profileId || "engineering-spend")
    },
    env: mergedEnv,
    outEnv: args.outEnv ?? null
  };

  if (args.format === "json") {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const lines = [];
    lines.push("OpenClaw onboarding complete.");
    lines.push(`Settld: ${normalizedBaseUrl} (tenant=${tenantId})`);
    lines.push(`Wallet provider: ${args.walletProvider}`);
    lines.push(`Wallet bootstrap mode: ${walletBootstrapMode}`);
    lines.push(`Circle mode: ${circle?.mode ?? "unknown"}`);
    lines.push(`Circle spend wallet: ${circle?.wallets?.spend?.walletId ?? "n/a"}`);
    lines.push(`Circle escrow wallet: ${circle?.wallets?.escrow?.walletId ?? "n/a"}`);
    lines.push(`Circle token USDC: ${circle?.tokenIdUsdc ?? "n/a"}`);
    if (args.outEnv) lines.push(`Wrote env file: ${args.outEnv}`);
    lines.push("");
    lines.push("Combined exports:");
    lines.push(toExportText(mergedEnv));
    lines.push("");
    lines.push("Next:");
    lines.push("1. Start OpenClaw and use your normal agent flow.");
    lines.push("2. Run `npm run mcp:probe` if you want an immediate health check.");
    stdout.write(`${lines.join("\n")}\n`);
  }

  return payload;
}

async function main(argv = process.argv.slice(2)) {
  try {
    await runOpenclawOnboard({ argv });
  } catch (err) {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
