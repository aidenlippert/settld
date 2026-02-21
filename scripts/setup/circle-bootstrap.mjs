#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { bootstrapCircleProvider } from "../../src/core/wallet-provider-bootstrap.js";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const MODE_SET = new Set(["auto", "sandbox", "production"]);
const FORMAT_SET = new Set(["text", "json"]);

const DEFAULTS = Object.freeze({
  mode: "auto",
  format: "text",
  faucet: null,
  outEnv: null,
  includeApiKey: true,
  registerEntitySecret: false,
  recoveryDir: "artifacts/circle-recovery"
});

function usage() {
  const text = [
    "usage:",
    "  node scripts/setup/circle-bootstrap.mjs [flags]",
    "",
    "flags:",
    "  --api-key <key>                 Circle API key (or CIRCLE_API_KEY env)",
    "  --mode <auto|sandbox|production>  Host/mode selection (default: auto)",
    "  --base-url <url>                Override Circle base URL",
    "  --blockchain <name>             Override blockchain (default: BASE-SEPOLIA sandbox, BASE production)",
    "  --spend-wallet-id <id>          Use a specific spend wallet id",
    "  --escrow-wallet-id <id>         Use a specific escrow wallet id",
    "  --token-id-usdc <id>            Force USDC token id",
    "  --entity-secret-hex <hex64>     Force entity secret hex (otherwise generated)",
    "  --faucet                        Request sandbox faucet top-ups",
    "  --no-faucet                     Disable faucet requests",
    "  --register-entity-secret        Register entity secret ciphertext with Circle SDK",
    "  --recovery-dir <path>           Recovery file output dir for registration",
    "  --format <text|json>            Output format (default: text)",
    "  --out-env <path>                Write KEY=VALUE lines to file",
    "  --exclude-api-key               Do not include CIRCLE_API_KEY in printed exports",
    "  --help                          Show this help"
  ].join("\n");
  process.stderr.write(`${text}\n`);
}

function readArgValue(argv, index, arg) {
  const raw = String(arg ?? "");
  const eq = raw.indexOf("=");
  if (eq >= 0) return { value: raw.slice(eq + 1), nextIndex: index };
  return { value: String(argv[index + 1] ?? ""), nextIndex: index + 1 };
}

export function parseArgs(argv) {
  const out = {
    ...DEFAULTS,
    apiKey: null,
    baseUrl: null,
    blockchain: null,
    spendWalletId: null,
    escrowWalletId: null,
    tokenIdUsdc: null,
    entitySecretHex: null,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--faucet") {
      out.faucet = true;
      continue;
    }
    if (arg === "--no-faucet") {
      out.faucet = false;
      continue;
    }
    if (arg === "--exclude-api-key") {
      out.includeApiKey = false;
      continue;
    }
    if (arg === "--register-entity-secret") {
      out.registerEntitySecret = true;
      continue;
    }

    if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      const parsed = readArgValue(argv, i, arg);
      out.apiKey = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      const parsed = readArgValue(argv, i, arg);
      out.mode = String(parsed.value).trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      const parsed = readArgValue(argv, i, arg);
      out.baseUrl = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--blockchain" || arg.startsWith("--blockchain=")) {
      const parsed = readArgValue(argv, i, arg);
      out.blockchain = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--spend-wallet-id" || arg.startsWith("--spend-wallet-id=")) {
      const parsed = readArgValue(argv, i, arg);
      out.spendWalletId = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--escrow-wallet-id" || arg.startsWith("--escrow-wallet-id=")) {
      const parsed = readArgValue(argv, i, arg);
      out.escrowWalletId = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--token-id-usdc" || arg.startsWith("--token-id-usdc=")) {
      const parsed = readArgValue(argv, i, arg);
      out.tokenIdUsdc = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--entity-secret-hex" || arg.startsWith("--entity-secret-hex=")) {
      const parsed = readArgValue(argv, i, arg);
      out.entitySecretHex = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const parsed = readArgValue(argv, i, arg);
      out.format = String(parsed.value).trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--out-env" || arg.startsWith("--out-env=")) {
      const parsed = readArgValue(argv, i, arg);
      out.outEnv = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--recovery-dir" || arg.startsWith("--recovery-dir=")) {
      const parsed = readArgValue(argv, i, arg);
      out.recoveryDir = parsed.value;
      i = parsed.nextIndex;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  if (!MODE_SET.has(out.mode)) {
    throw new Error("--mode must be auto|sandbox|production");
  }
  if (!FORMAT_SET.has(out.format)) {
    throw new Error("--format must be text|json");
  }
  if (out.outEnv) {
    out.outEnv = path.resolve(process.cwd(), out.outEnv);
  }
  if (out.recoveryDir) {
    out.recoveryDir = path.resolve(process.cwd(), out.recoveryDir);
  }
  return out;
}

function shellQuote(value) {
  const s = String(value ?? "");
  if (!s) return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function toEnvFileText(env) {
  const keys = Object.keys(env).sort();
  return `${keys.map((k) => `${k}=${env[k]}`).join("\n")}\n`;
}

function toExportText(env) {
  const keys = Object.keys(env).sort();
  return keys.map((k) => `export ${k}=${shellQuote(env[k])}`).join("\n");
}

function maskKey(value) {
  const raw = String(value ?? "");
  if (raw.length <= 14) return "***";
  return `${raw.slice(0, 10)}...${raw.slice(-4)}`;
}

async function maybeRegisterEntitySecret({ apiKey, entitySecretHex, recoveryDir }) {
  await fs.mkdir(recoveryDir, { recursive: true });
  const result = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret: entitySecretHex,
    recoveryFileDownloadPath: recoveryDir
  });
  return result?.data ?? result ?? null;
}

export async function runCircleBootstrap({ argv = process.argv.slice(2), fetchImpl = fetch, stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return { ok: true, code: 0 };
  }

  const apiKey = String(args.apiKey ?? process.env.CIRCLE_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("CIRCLE_API_KEY / --api-key is required");

  const providerResult = await bootstrapCircleProvider({
    apiKey,
    mode: args.mode,
    baseUrl: args.baseUrl,
    blockchain: args.blockchain,
    spendWalletId: args.spendWalletId,
    escrowWalletId: args.escrowWalletId,
    tokenIdUsdc: args.tokenIdUsdc,
    faucet: args.faucet,
    includeApiKey: args.includeApiKey,
    entitySecretHex: args.entitySecretHex,
    fetchImpl
  });

  let entitySecretRegistration = null;
  if (args.registerEntitySecret) {
    entitySecretRegistration = await maybeRegisterEntitySecret({
      apiKey,
      entitySecretHex: providerResult.entitySecretHex,
      recoveryDir: args.recoveryDir
    });
  }

  const payload = {
    ok: true,
    mode: providerResult.mode,
    baseUrl: providerResult.baseUrl,
    blockchain: providerResult.blockchain,
    wallets: providerResult.wallets,
    tokenIdUsdc: providerResult.tokenIdUsdc,
    entitySecretHex: providerResult.entitySecretHex,
    entitySecretRegistration,
    faucetEnabled: providerResult.faucetEnabled,
    faucetResults: providerResult.faucetResults,
    env: providerResult.env,
    apiKeyMasked: maskKey(apiKey),
    outEnv: args.outEnv ?? null
  };

  if (args.outEnv) {
    await fs.mkdir(path.dirname(args.outEnv), { recursive: true });
    await fs.writeFile(args.outEnv, toEnvFileText(providerResult.env), "utf8");
  }

  if (args.format === "json") {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const lines = [];
    lines.push("Circle bootstrap complete.");
    lines.push(`Mode: ${providerResult.mode}`);
    lines.push(`Base URL: ${providerResult.baseUrl}`);
    lines.push(`Blockchain: ${providerResult.blockchain}`);
    lines.push(`API key: ${maskKey(apiKey)}`);
    lines.push(`Spend wallet: ${providerResult.wallets?.spend?.walletId ?? "n/a"} (${providerResult.wallets?.spend?.address ?? "n/a"})`);
    lines.push(`Escrow wallet: ${providerResult.wallets?.escrow?.walletId ?? "n/a"} (${providerResult.wallets?.escrow?.address ?? "n/a"})`);
    lines.push(`USDC token id: ${providerResult.tokenIdUsdc}`);
    if (args.registerEntitySecret) {
      lines.push(`Entity secret registered: yes (recovery dir: ${args.recoveryDir})`);
    }
    if (args.outEnv) {
      lines.push(`Wrote env file: ${args.outEnv}`);
    }
    if (providerResult.faucetEnabled) {
      const faucetSummary = providerResult.faucetResults.map((row) => `${row.wallet}=HTTP${row.status}`).join(", ");
      lines.push(`Faucet: ${faucetSummary}`);
    }
    lines.push("");
    lines.push("Shell exports:");
    lines.push(toExportText(providerResult.env));
    lines.push("");
    lines.push("Railway variables (Raw Editor):");
    lines.push(toEnvFileText(providerResult.env).trimEnd());
    stdout.write(`${lines.join("\n")}\n`);
  }

  return payload;
}

async function main(argv = process.argv.slice(2)) {
  try {
    await runCircleBootstrap({ argv });
  } catch (err) {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
