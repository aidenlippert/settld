#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../../src/core/crypto.js";
import { buildSettldPayKeysetV1 } from "../../src/core/settld-keys.js";

const SERVER_SIGNER_FILENAME = "server-signer.json";
const SETTLD_PAY_KEYSET_STORE_FILENAME = "settld-pay-keyset-store.json";

function usage() {
  return [
    "Usage:",
    "  node scripts/trust-config/rotate-settld-pay.mjs [--data-dir <path>] [--report <path>] [--keep-previous <n>] [--bootstrap]",
    "",
    "Options:",
    "  --data-dir <path>      Data directory containing signer material (default: $PROXY_DATA_DIR or ./data)",
    "  --report <path>        Optional JSON artifact path for rotation report",
    "  --keep-previous <n>    Number of previous public keys to keep published (default: 2)",
    "  --bootstrap            Allow creating an initial signer if no existing signer is found",
    "  --help                 Show this help"
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    dataDir: process.env.PROXY_DATA_DIR && String(process.env.PROXY_DATA_DIR).trim() !== "" ? String(process.env.PROXY_DATA_DIR).trim() : "data",
    reportPath: null,
    keepPrevious: 2,
    bootstrap: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] ?? "");
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--bootstrap") {
      out.bootstrap = true;
      continue;
    }
    if (a === "--data-dir") {
      const value = argv[i + 1];
      if (!value) throw new Error("--data-dir requires a value");
      out.dataDir = String(value);
      i += 1;
      continue;
    }
    if (a === "--report") {
      const value = argv[i + 1];
      if (!value) throw new Error("--report requires a value");
      out.reportPath = String(value);
      i += 1;
      continue;
    }
    if (a === "--keep-previous") {
      const value = Number(argv[i + 1]);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("--keep-previous must be a non-negative integer");
      out.keepPrevious = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function normalizeKeyRow(row, { requirePrivate = false, fieldPath = "key" } = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`${fieldPath} must be an object`);
  const publicKeyPem = typeof row.publicKeyPem === "string" && row.publicKeyPem.trim() !== "" ? row.publicKeyPem : null;
  if (!publicKeyPem) throw new Error(`${fieldPath}.publicKeyPem is required`);
  const privateKeyPem = typeof row.privateKeyPem === "string" && row.privateKeyPem.trim() !== "" ? row.privateKeyPem : null;
  if (requirePrivate && !privateKeyPem) throw new Error(`${fieldPath}.privateKeyPem is required`);
  const derivedKeyId = keyIdFromPublicKeyPem(publicKeyPem);
  const keyId = typeof row.keyId === "string" && row.keyId.trim() !== "" ? row.keyId.trim() : derivedKeyId;
  if (keyId !== derivedKeyId) throw new Error(`${fieldPath}.keyId does not match publicKeyPem`);
  return {
    keyId,
    publicKeyPem,
    privateKeyPem,
    rotatedAt: typeof row.rotatedAt === "string" && row.rotatedAt.trim() !== "" ? row.rotatedAt : null
  };
}

function dedupePrevious(rows, { max = 2 } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const normalized = normalizeKeyRow(row, { requirePrivate: false, fieldPath: "previous[]" });
    if (seen.has(normalized.keyId)) continue;
    seen.add(normalized.keyId);
    out.push({
      keyId: normalized.keyId,
      publicKeyPem: normalized.publicKeyPem,
      rotatedAt: normalized.rotatedAt
    });
    if (out.length >= max) break;
  }
  return out;
}

async function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function loadSignerMaterial({ dataDir }) {
  const keysetStorePath = path.join(dataDir, SETTLD_PAY_KEYSET_STORE_FILENAME);
  const signerPath = path.join(dataDir, SERVER_SIGNER_FILENAME);
  const keysetStore = await readJsonFileSafe(keysetStorePath);
  if (keysetStore) {
    const active = normalizeKeyRow(keysetStore.active, { requirePrivate: true, fieldPath: "active" });
    const previous = Array.isArray(keysetStore.previous)
      ? keysetStore.previous.map((row, idx) => normalizeKeyRow(row, { requirePrivate: false, fieldPath: `previous[${idx}]` }))
      : [];
    return {
      source: "keyset-store",
      active,
      previous
    };
  }

  const signer = await readJsonFileSafe(signerPath);
  if (signer) {
    const active = normalizeKeyRow(signer, { requirePrivate: true, fieldPath: "server-signer" });
    return { source: "legacy-signer", active, previous: [] };
  }

  return null;
}

function buildProviderNotificationSnippet({
  keysetUrl = "https://<your-settld-host>/.well-known/settld-keys.json",
  newKeyId,
  previousKeyIds,
  overlapRecommendation
} = {}) {
  const previous = Array.isArray(previousKeyIds) && previousKeyIds.length > 0 ? previousKeyIds.join(", ") : "none";
  return [
    "Subject: SettldPay signing key rotation notice",
    "",
    `Settld has rotated its SettldPay signing key.`,
    `- New active kid: ${newKeyId}`,
    `- Previous kids still published: ${previous}`,
    `- Keyset URL: ${keysetUrl}`,
    "",
    "Action requested:",
    "1. Keep verifying tokens by resolving kid from the keyset URL.",
    "2. Refresh cached keyset according to Cache-Control (or immediately if pinned).",
    `3. Do not remove previously cached keys before overlap window ends (${overlapRecommendation}).`
  ].join("\n");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err?.message ?? String(err)}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    process.stdout.write(usage() + "\n");
    return;
  }

  const dataDir = path.resolve(process.cwd(), args.dataDir);
  await mkdir(dataDir, { recursive: true });

  const existing = await loadSignerMaterial({ dataDir });
  if (!existing && !args.bootstrap) {
    throw new Error(
      `no existing signer found in ${dataDir}; rerun with --bootstrap to create the initial signer and keyset store`
    );
  }

  const nowIso = new Date().toISOString();
  const newKeypair = createEd25519Keypair();
  const newKeyId = keyIdFromPublicKeyPem(newKeypair.publicKeyPem);
  const oldActive = existing?.active ?? null;

  const previousRows = dedupePrevious(
    [
      ...(oldActive
        ? [
            {
              keyId: oldActive.keyId,
              publicKeyPem: oldActive.publicKeyPem,
              rotatedAt: nowIso
            }
          ]
        : []),
      ...(existing?.previous ?? [])
    ],
    { max: args.keepPrevious }
  );

  const keysetStore = {
    schemaVersion: "SettldPayKeysetStore.v1",
    updatedAt: nowIso,
    active: {
      keyId: newKeyId,
      publicKeyPem: newKeypair.publicKeyPem,
      privateKeyPem: newKeypair.privateKeyPem,
      rotatedFromKeyId: oldActive?.keyId ?? null
    },
    previous: previousRows
  };

  const signerCompat = {
    publicKeyPem: newKeypair.publicKeyPem,
    privateKeyPem: newKeypair.privateKeyPem
  };

  const keysetStorePath = path.join(dataDir, SETTLD_PAY_KEYSET_STORE_FILENAME);
  const signerPath = path.join(dataDir, SERVER_SIGNER_FILENAME);
  await writeFile(keysetStorePath, JSON.stringify(keysetStore, null, 2) + "\n", "utf8");
  await writeFile(signerPath, JSON.stringify(signerCompat, null, 2) + "\n", "utf8");

  const servedKeyset = buildSettldPayKeysetV1({
    activeKey: { keyId: newKeyId, publicKeyPem: newKeypair.publicKeyPem },
    fallbackKeys: previousRows.map((row) => ({ keyId: row.keyId, publicKeyPem: row.publicKeyPem })),
    refreshedAt: nowIso
  });
  const activeJwksEntry = Array.isArray(servedKeyset.keys) ? servedKeyset.keys.find((row) => row.kid === newKeyId) : null;
  const notification = buildProviderNotificationSnippet({
    newKeyId,
    previousKeyIds: previousRows.map((row) => row.keyId),
    overlapRecommendation: "token TTL + cache max-age safety margin"
  });

  const report = {
    schemaVersion: "SettldPayKeyRotationReport.v1",
    rotatedAt: nowIso,
    dataDir,
    source: existing?.source ?? "bootstrap",
    oldActiveKeyId: oldActive?.keyId ?? null,
    newActiveKeyId: newKeyId,
    previousKeyIds: previousRows.map((row) => row.keyId),
    files: {
      keysetStorePath,
      signerCompatPath: signerPath
    },
    servedKeyset
  };

  if (args.reportPath) {
    const reportPath = path.resolve(process.cwd(), args.reportPath);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    report.reportPath = reportPath;
  }

  process.stdout.write(`rotated_at=${nowIso}\n`);
  process.stdout.write(`data_dir=${dataDir}\n`);
  process.stdout.write(`old_active_kid=${oldActive?.keyId ?? "none"}\n`);
  process.stdout.write(`new_active_kid=${newKeyId}\n`);
  process.stdout.write(`previous_kids=${previousRows.map((row) => row.keyId).join(",") || "none"}\n`);
  process.stdout.write("\nJWKS active entry:\n");
  process.stdout.write(JSON.stringify(activeJwksEntry ?? null, null, 2) + "\n");
  process.stdout.write("\nProvider notification snippet:\n");
  process.stdout.write(notification + "\n");
  if (report.reportPath) {
    process.stdout.write(`\nrotation_report=${report.reportPath}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
  process.exitCode = 1;
});
