#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ARTIFACT_PATH = path.resolve(process.cwd(), "artifacts/gates/x402-circle-sandbox-smoke.json");

function nowIso() {
  return new Date().toISOString();
}

function readEnv(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return String(raw).trim();
}

function hasTruthyEnv(name) {
  const value = readEnv(name, "");
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeArtifact(value) {
  ensureDir(ARTIFACT_PATH);
  fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertRequiredEnv() {
  const required = ["CIRCLE_API_KEY", "CIRCLE_WALLET_ID_SPEND", "CIRCLE_WALLET_ID_ESCROW", "CIRCLE_TOKEN_ID_USDC"];
  const missing = required.filter((name) => !readEnv(name));
  if (missing.length > 0) {
    throw new Error(`missing required env: ${missing.join(", ")}`);
  }
  const hasEntityProvider =
    Boolean(readEnv("ENTITY_SECRET")) ||
    Boolean(readEnv("CIRCLE_ENTITY_SECRET_HEX")) ||
    Boolean(readEnv("CIRCLE_ENTITY_SECRET_CIPHERTEXT_TEMPLATE")) ||
    (Boolean(readEnv("CIRCLE_ENTITY_SECRET_CIPHERTEXT")) && hasTruthyEnv("CIRCLE_ALLOW_STATIC_ENTITY_SECRET"));
  if (!hasEntityProvider) {
    throw new Error(
      "missing entity secret provider: set ENTITY_SECRET/CIRCLE_ENTITY_SECRET_HEX, CIRCLE_ENTITY_SECRET_CIPHERTEXT_TEMPLATE, or CIRCLE_ENTITY_SECRET_CIPHERTEXT + CIRCLE_ALLOW_STATIC_ENTITY_SECRET=1"
    );
  }
}

async function callCircle({ method, endpoint, body = null }) {
  const baseUrl = readEnv("CIRCLE_BASE_URL", "https://api.circle.com").replace(/\/+$/, "");
  const apiKey = readEnv("CIRCLE_API_KEY", "");
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json; charset=utf-8" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const json = parseJsonSafe(text);
  return { status: response.status, text, json };
}

async function requestFaucetTopup({ walletAddress, blockchain, native, usdc }) {
  const out = await callCircle({
    method: "POST",
    endpoint: "/v1/faucet/drips",
    body: {
      address: walletAddress,
      blockchain,
      native: Boolean(native),
      usdc: Boolean(usdc),
      eurc: false
    }
  });
  const accepted = out.status === 204 || out.status === 409 || out.status === 429 || out.status === 400;
  return {
    ok: accepted,
    status: out.status,
    body: out.json ?? out.text ?? null
  };
}

async function resolveWalletAddress(walletId) {
  const out = await callCircle({
    method: "GET",
    endpoint: `/v1/w3s/wallets/${encodeURIComponent(walletId)}`
  });
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`wallet lookup failed (${walletId}): HTTP ${out.status}`);
  }
  const payload = out.json ?? {};
  const candidates = [payload, payload.wallet, payload.data, payload.data?.wallet];
  if (Array.isArray(payload?.data?.wallets)) {
    for (const row of payload.data.wallets) candidates.push(row);
  }
  for (const row of candidates) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (typeof row.address === "string" && row.address.trim() !== "") return row.address.trim();
    if (typeof row.blockchainAddress === "string" && row.blockchainAddress.trim() !== "") return row.blockchainAddress.trim();
  }
  throw new Error(`wallet lookup did not include address (${walletId})`);
}

function runNodeTest({ label, testFile, env }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--test", testFile], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
    child.once("close", (code, signal) => {
      resolve({
        label,
        testFile,
        code,
        signal,
        ok: code === 0,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

async function main() {
  const startedAt = nowIso();
  const report = {
    schemaVersion: "X402CircleSandboxSmoke.v1",
    ok: false,
    startedAt,
    completedAt: null,
    steps: [],
    errors: []
  };

  try {
    assertRequiredEnv();

    const circleMode = readEnv("X402_CIRCLE_RESERVE_MODE", readEnv("SETTLD_DEMO_CIRCLE_MODE", "sandbox"));
    if (String(circleMode).toLowerCase() !== "sandbox") {
      throw new Error(`expected sandbox mode, got ${circleMode}`);
    }

    const blockchain = readEnv("CIRCLE_BLOCKCHAIN", "BASE-SEPOLIA");
    const spendWalletId = readEnv("CIRCLE_WALLET_ID_SPEND", "");
    const escrowWalletId = readEnv("CIRCLE_WALLET_ID_ESCROW", "");
    const spendAddress = await resolveWalletAddress(spendWalletId);
    const escrowAddress = await resolveWalletAddress(escrowWalletId);

    const shouldTopup = !hasTruthyEnv("CIRCLE_SKIP_TOPUP");
    if (shouldTopup) {
      const spendTopup = await requestFaucetTopup({
        walletAddress: spendAddress,
        blockchain,
        native: true,
        usdc: true
      });
      report.steps.push({ step: "faucet_topup_spend", ...spendTopup });

      const escrowTopup = await requestFaucetTopup({
        walletAddress: escrowAddress,
        blockchain,
        native: true,
        usdc: false
      });
      report.steps.push({ step: "faucet_topup_escrow", ...escrowTopup });
    } else {
      report.steps.push({ step: "faucet_topup", skipped: true, reason: "CIRCLE_SKIP_TOPUP=1" });
    }

    const testEnv = {
      CIRCLE_E2E: "1",
      CIRCLE_BATCH_E2E: "1",
      CIRCLE_E2E_AMOUNT_CENTS: readEnv("CIRCLE_E2E_AMOUNT_CENTS", "100"),
      CIRCLE_BATCH_E2E_AMOUNT_CENTS: readEnv("CIRCLE_BATCH_E2E_AMOUNT_CENTS", "100")
    };

    const reserve = await runNodeTest({
      label: "reserve_e2e",
      testFile: "test/circle-sandbox-reserve-e2e.test.js",
      env: testEnv
    });
    report.steps.push(reserve);
    if (!reserve.ok) throw new Error("reserve e2e failed");

    const batch = await runNodeTest({
      label: "batch_settlement_e2e",
      testFile: "test/circle-sandbox-batch-settlement-e2e.test.js",
      env: testEnv
    });
    report.steps.push(batch);
    if (!batch.ok) throw new Error("batch settlement e2e failed");

    report.ok = true;
  } catch (err) {
    report.errors.push({
      message: err?.message ?? String(err ?? "")
    });
    report.ok = false;
  } finally {
    report.completedAt = nowIso();
    writeArtifact(report);
    process.stdout.write(`wrote circle sandbox smoke report: ${ARTIFACT_PATH}\n`);
  }

  if (!report.ok) process.exitCode = 1;
}

main().catch((err) => {
  const fallback = {
    schemaVersion: "X402CircleSandboxSmoke.v1",
    ok: false,
    startedAt: nowIso(),
    completedAt: nowIso(),
    steps: [],
    errors: [{ message: err?.message ?? String(err ?? "") }]
  };
  writeArtifact(fallback);
  process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
  process.exitCode = 1;
});
