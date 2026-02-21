#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

function usage() {
  const text = [
    "usage:",
    "  node scripts/register-entity-secret.mjs [--api-key <key>] [--entity-secret-hex <hex64>] [--recovery-dir <path>]",
    "",
    "env fallbacks:",
    "  CIRCLE_API_KEY",
    "  CIRCLE_ENTITY_SECRET_HEX (or ENTITY_SECRET)",
    "  CIRCLE_RECOVERY_DIR (default: ./artifacts/circle-recovery)"
  ].join("\n");
  process.stderr.write(`${text}\n`);
}

function readArgValue(argv, index, arg) {
  const raw = String(arg ?? "");
  const eq = raw.indexOf("=");
  if (eq >= 0) return { value: raw.slice(eq + 1), nextIndex: index };
  return { value: String(argv[index + 1] ?? ""), nextIndex: index + 1 };
}

function parseArgs(argv) {
  const out = {
    apiKey: null,
    entitySecretHex: null,
    recoveryDir: null,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      const parsed = readArgValue(argv, i, arg);
      out.apiKey = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--entity-secret-hex" || arg.startsWith("--entity-secret-hex=")) {
      const parsed = readArgValue(argv, i, arg);
      out.entitySecretHex = parsed.value;
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
  return out;
}

function normalizeHex64(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new Error("entity secret must be a 64-char hex string");
  }
  return raw;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }

  const apiKey = String(args.apiKey ?? process.env.CIRCLE_API_KEY ?? "").trim();
  const entitySecret = normalizeHex64(args.entitySecretHex ?? process.env.CIRCLE_ENTITY_SECRET_HEX ?? process.env.ENTITY_SECRET ?? "");
  const recoveryFileDownloadPath = path.resolve(
    process.cwd(),
    String(args.recoveryDir ?? process.env.CIRCLE_RECOVERY_DIR ?? "./artifacts/circle-recovery")
  );

  if (!apiKey) throw new Error("CIRCLE_API_KEY missing (or pass --api-key)");
  if (!entitySecret) throw new Error("CIRCLE_ENTITY_SECRET_HEX missing (or pass --entity-secret-hex)");

  const res = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath
  });

  process.stdout.write(`${JSON.stringify(res?.data ?? res, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err?.message ?? String(err)}\n`);
  process.exit(1);
});
