#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { canonicalJsonStringify } from "../../src/core/canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex, signHashHexEd25519 } from "../../src/core/crypto.js";

const CIRCLE_TX_OK_STATES = new Set(["INITIATED", "QUEUED", "SENT", "CONFIRMED", "COMPLETE", "CLEARED"]);
const CIRCLE_TX_FAIL_STATES = new Set(["DENIED", "FAILED", "CANCELLED", "STUCK"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/settlement/x402-batch-worker.mjs [options]",
    "",
    "Options:",
    "  --artifact-root <dir>      Source artifact root (default: artifacts/mcp-paid-exa)",
    "  --registry <file>          Provider payout registry file (required)",
    "  --state <file>             Worker state file (default: artifacts/settlement/x402-batch-state.json)",
    "  --out-dir <dir>            Output run directory (default: artifacts/settlement/x402-batches/<timestamp>)",
    "  --dry-run                  Compute without mutating state",
    "  --execute-circle           Submit pending batches to Circle payout rails",
    "  --circle-mode <mode>       Circle mode: stub|sandbox|production (default: env X402_BATCH_CIRCLE_MODE or stub)",
    "  --max-payout-attempts <n>  Max retries for failed payouts (default: 3)",
    "  --help                     Show this help",
    "",
    "Circle env when --execute-circle and mode!=stub:",
    "  CIRCLE_API_KEY",
    "  CIRCLE_WALLET_ID_SPEND",
    "  CIRCLE_TOKEN_ID_USDC",
    "  CIRCLE_ENTITY_SECRET_CIPHERTEXT_TEMPLATE (recommended) or",
    "  CIRCLE_ENTITY_SECRET_CIPHERTEXT + CIRCLE_ALLOW_STATIC_ENTITY_SECRET=1",
    "Optional:",
    "  CIRCLE_BASE_URL",
    "  CIRCLE_BLOCKCHAIN",
    "  CIRCLE_TIMEOUT_MS"
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    artifactRoot: "artifacts/mcp-paid-exa",
    registryPath: null,
    statePath: "artifacts/settlement/x402-batch-state.json",
    outDir: null,
    dryRun: false,
    executeCircle: false,
    circleMode: null,
    maxPayoutAttempts: 3,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "").trim();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--execute-circle") {
      out.executeCircle = true;
      continue;
    }
    if (arg === "--artifact-root") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--artifact-root requires a value");
      out.artifactRoot = value;
      i += 1;
      continue;
    }
    if (arg === "--registry") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--registry requires a value");
      out.registryPath = value;
      i += 1;
      continue;
    }
    if (arg === "--state") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--state requires a value");
      out.statePath = value;
      i += 1;
      continue;
    }
    if (arg === "--out-dir") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--out-dir requires a value");
      out.outDir = value;
      i += 1;
      continue;
    }
    if (arg === "--circle-mode") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--circle-mode requires a value");
      out.circleMode = value;
      i += 1;
      continue;
    }
    if (arg === "--max-payout-attempts") {
      const value = Number(argv[i + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--max-payout-attempts must be a positive integer");
      out.maxPayoutAttempts = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.registryPath && !out.help) throw new Error("--registry is required");
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeIso(value, fallback = null) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return fallback;
  return new Date(t).toISOString();
}

function normalizeNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return fallback;
  return n;
}

function normalizeCurrency(value, fallback = "USD") {
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : fallback;
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(raw)) return fallback;
  return raw;
}

function normalizeCircleMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "stub" || raw === "test") return "stub";
  if (raw === "sandbox") return "sandbox";
  if (raw === "production" || raw === "prod") return "production";
  throw new Error("circle mode must be stub|sandbox|production");
}

function readEnv(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return String(raw).trim();
}

function readBoolEnv(name, fallback = false) {
  const raw = readEnv(name, null);
  if (raw === null) return fallback;
  const value = raw.toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return fallback;
}

function normalizeCircleState(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return String(value).trim().toUpperCase();
}

function stableUuidV4FromString(input) {
  const text = String(input ?? "").trim();
  if (!text) throw new Error("uuid input is required");
  const buf = Buffer.from(sha256Hex(text).slice(0, 32), "hex");
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function centsToAssetAmountString(amountCents) {
  const cents = normalizeNonNegativeInt(amountCents, -1);
  if (cents <= 0) throw new Error("amountCents must be a positive integer");
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

function loadRegistry(registryPath) {
  const resolved = path.resolve(process.cwd(), registryPath);
  const payload = readJsonFile(resolved);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("registry must be an object");
  if (payload.schemaVersion !== "X402ProviderPayoutRegistry.v1") {
    throw new Error("registry.schemaVersion must be X402ProviderPayoutRegistry.v1");
  }
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  const byProvider = new Map();
  for (const row of providers) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const providerId = typeof row.providerId === "string" && row.providerId.trim() !== "" ? row.providerId.trim() : null;
    if (!providerId) continue;
    const destination = row.destination && typeof row.destination === "object" && !Array.isArray(row.destination) ? row.destination : null;
    if (!destination) continue;
    byProvider.set(providerId, destination);
  }
  return { resolvedPath: resolved, providerDestinations: byProvider };
}

function loadWorkerState(statePath) {
  const resolved = path.resolve(process.cwd(), statePath);
  if (!fs.existsSync(resolved)) {
    return {
      resolvedPath: resolved,
      state: {
        schemaVersion: "X402BatchWorkerState.v1",
        updatedAt: null,
        processedGateIds: {},
        batches: []
      }
    };
  }
  const payload = readJsonFile(resolved);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("state must be an object");
  if (payload.schemaVersion !== "X402BatchWorkerState.v1") {
    throw new Error("state.schemaVersion must be X402BatchWorkerState.v1");
  }
  const processedGateIds =
    payload.processedGateIds && typeof payload.processedGateIds === "object" && !Array.isArray(payload.processedGateIds)
      ? payload.processedGateIds
      : {};
  const batches = Array.isArray(payload.batches) ? payload.batches : [];
  return {
    resolvedPath: resolved,
    state: {
      schemaVersion: "X402BatchWorkerState.v1",
      updatedAt: normalizeIso(payload.updatedAt, null),
      processedGateIds,
      batches
    }
  };
}

function collectArtifactRuns(artifactRoot) {
  const resolvedRoot = path.resolve(process.cwd(), artifactRoot);
  if (!fs.existsSync(resolvedRoot)) return [];
  const entries = fs
    .readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((row) => row.isDirectory())
    .map((row) => row.name)
    .sort((a, b) => a.localeCompare(b));

  const out = [];
  for (const dirName of entries) {
    const dirPath = path.join(resolvedRoot, dirName);
    const summaryPath = path.join(dirPath, "summary.json");
    const gateStatePath = path.join(dirPath, "gate-state.json");
    if (!fs.existsSync(summaryPath) || !fs.existsSync(gateStatePath)) continue;

    const summary = readJsonFile(summaryPath);
    const gateState = readJsonFile(gateStatePath);
    if (summary?.ok !== true) continue;
    const gate = gateState?.gate;
    const settlement = gateState?.settlement;
    if (!gate || typeof gate !== "object") continue;

    const gateId = typeof gate.gateId === "string" && gate.gateId.trim() !== "" ? gate.gateId.trim() : null;
    if (!gateId) continue;
    const providerId = typeof gate.payeeAgentId === "string" && gate.payeeAgentId.trim() !== "" ? gate.payeeAgentId.trim() : null;
    if (!providerId) continue;

    const releasedAmountCents = normalizeNonNegativeInt(gate?.decision?.releasedAmountCents ?? settlement?.releasedAmountCents ?? 0, 0);
    const refundedAmountCents = normalizeNonNegativeInt(gate?.decision?.refundedAmountCents ?? settlement?.refundedAmountCents ?? 0, 0);
    const currency = normalizeCurrency(gate?.terms?.currency ?? settlement?.currency ?? "USD");
    const resolvedAt = normalizeIso(gate?.resolvedAt ?? settlement?.resolvedAt ?? summary?.timestamps?.completedAt, null);
    const settlementStatus =
      typeof settlement?.status === "string" && settlement.status.trim() !== "" ? settlement.status.trim().toLowerCase() : null;
    const reserveId =
      typeof summary?.circleReserveId === "string" && summary.circleReserveId.trim() !== ""
        ? summary.circleReserveId.trim()
        : typeof gate?.authorization?.reserve?.reserveId === "string" && gate.authorization.reserve.reserveId.trim() !== ""
          ? gate.authorization.reserve.reserveId.trim()
          : null;

    out.push({
      gateId,
      runId: typeof gate.runId === "string" ? gate.runId : null,
      providerId,
      releasedAmountCents,
      refundedAmountCents,
      currency,
      settlementStatus,
      resolvedAt,
      reserveId,
      artifactDir: dirPath
    });
  }
  return out;
}

function groupByProviderAndCurrency(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.providerId}\n${row.currency}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return groups;
}

function buildBatchId({ providerId, currency, gateIds }) {
  const material = `${providerId}\n${currency}\n${gateIds.slice().sort((a, b) => a.localeCompare(b)).join("\n")}`;
  return `pbatch_${sha256Hex(material).slice(0, 24)}`;
}

function maybeSignManifest(manifest) {
  const publicKeyPem =
    typeof process.env.SETTLD_BATCH_SIGNER_PUBLIC_KEY_PEM === "string" && process.env.SETTLD_BATCH_SIGNER_PUBLIC_KEY_PEM.trim() !== ""
      ? process.env.SETTLD_BATCH_SIGNER_PUBLIC_KEY_PEM
      : null;
  const privateKeyPem =
    typeof process.env.SETTLD_BATCH_SIGNER_PRIVATE_KEY_PEM === "string" && process.env.SETTLD_BATCH_SIGNER_PRIVATE_KEY_PEM.trim() !== ""
      ? process.env.SETTLD_BATCH_SIGNER_PRIVATE_KEY_PEM
      : null;
  if (!publicKeyPem || !privateKeyPem) return null;
  const canonical = canonicalJsonStringify(manifest);
  const payloadHash = sha256Hex(canonical);
  const signatureBase64 = signHashHexEd25519(payloadHash, privateKeyPem);
  return {
    schemaVersion: "X402BatchManifestSignature.v1",
    algorithm: "ed25519",
    keyId: keyIdFromPublicKeyPem(publicKeyPem),
    payloadHash,
    signatureBase64
  };
}

function normalizeBatchRecord(row, { defaultMaxAttempts }) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const batchId = typeof row.batchId === "string" && row.batchId.trim() !== "" ? row.batchId.trim() : null;
  if (!batchId) return null;
  const providerId = typeof row.providerId === "string" && row.providerId.trim() !== "" ? row.providerId.trim() : null;
  if (!providerId) return null;
  const currency = normalizeCurrency(row.currency ?? "USD");
  const gates = Array.isArray(row.gates) ? row.gates.filter((g) => g && typeof g === "object" && !Array.isArray(g) && typeof g.gateId === "string") : [];
  const totalAmountCents =
    Number.isSafeInteger(Number(row.totalAmountCents)) && Number(row.totalAmountCents) > 0
      ? Number(row.totalAmountCents)
      : gates.reduce((sum, gate) => sum + normalizeNonNegativeInt(gate.releasedAmountCents, 0), 0);
  const gateCount = Number.isSafeInteger(Number(row.gateCount)) ? Number(row.gateCount) : gates.length;
  const destination = row.destination && typeof row.destination === "object" && !Array.isArray(row.destination) ? row.destination : null;
  const payout = row.payout && typeof row.payout === "object" && !Array.isArray(row.payout) ? row.payout : {};
  const status =
    typeof payout.status === "string" && payout.status.trim() !== "" ? payout.status.trim().toLowerCase() : "manifest_only_pending";
  return {
    schemaVersion: "X402ProviderPayoutBatch.v1",
    batchId,
    createdAt: normalizeIso(row.createdAt, nowIso()),
    providerId,
    currency,
    totalAmountCents,
    gateCount,
    destination,
    settlementMethod: typeof row.settlementMethod === "string" && row.settlementMethod.trim() !== "" ? row.settlementMethod.trim() : "deferred_batch_manifest_only",
    gates,
    payout: {
      status,
      attempts: normalizeNonNegativeInt(payout.attempts, 0),
      maxAttempts: normalizeNonNegativeInt(payout.maxAttempts, defaultMaxAttempts),
      idempotencyKey:
        typeof payout.idempotencyKey === "string" && payout.idempotencyKey.trim() !== ""
          ? payout.idempotencyKey.trim()
          : stableUuidV4FromString(`x402-batch:${batchId}`),
      transactionId: typeof payout.transactionId === "string" && payout.transactionId.trim() !== "" ? payout.transactionId.trim() : null,
      circleState: typeof payout.circleState === "string" && payout.circleState.trim() !== "" ? payout.circleState.trim() : null,
      lastAttemptAt: normalizeIso(payout.lastAttemptAt, null),
      lastError: payout.lastError ?? null,
      submittedAt: normalizeIso(payout.submittedAt, null),
      providerResponse: payout.providerResponse ?? null
    }
  };
}

function buildNewBatch({ providerId, currency, rows, destination, nowAt, maxAttempts }) {
  const gateIds = rows.map((row) => row.gateId);
  const batchId = buildBatchId({ providerId, currency, gateIds });
  const totalAmountCents = rows.reduce((sum, row) => sum + row.releasedAmountCents, 0);
  return {
    schemaVersion: "X402ProviderPayoutBatch.v1",
    batchId,
    createdAt: nowAt,
    providerId,
    currency,
    totalAmountCents,
    gateCount: rows.length,
    destination,
    settlementMethod: "deferred_batch_manifest_only",
    gates: rows.map((row) => ({
      gateId: row.gateId,
      runId: row.runId,
      releasedAmountCents: row.releasedAmountCents,
      refundedAmountCents: row.refundedAmountCents,
      resolvedAt: row.resolvedAt,
      reserveId: row.reserveId,
      artifactDir: row.artifactDir
    })),
    payout: {
      status: "manifest_only_pending",
      attempts: 0,
      maxAttempts,
      idempotencyKey: stableUuidV4FromString(`x402-batch:${batchId}`),
      transactionId: null,
      circleState: null,
      lastAttemptAt: null,
      lastError: null,
      submittedAt: null,
      providerResponse: null
    }
  };
}

function normalizeEntitySecretProvider() {
  const template = readEnv("CIRCLE_ENTITY_SECRET_CIPHERTEXT_TEMPLATE", null);
  if (template) {
    return () => template.replaceAll("{{uuid}}", crypto.randomUUID());
  }
  const staticCiphertext = readEnv("CIRCLE_ENTITY_SECRET_CIPHERTEXT", null);
  if (staticCiphertext && readBoolEnv("CIRCLE_ALLOW_STATIC_ENTITY_SECRET", false)) {
    return () => staticCiphertext;
  }
  return null;
}

function createCirclePayoutRuntime({ mode }) {
  const normalizedMode = normalizeCircleMode(mode);
  if (normalizedMode === "stub") {
    return {
      mode: "stub"
    };
  }

  const apiKey = readEnv("CIRCLE_API_KEY", null);
  const sourceWalletId = readEnv("CIRCLE_WALLET_ID_SPEND", null);
  const tokenId = readEnv("CIRCLE_TOKEN_ID_USDC", null);
  const baseUrl = readEnv("CIRCLE_BASE_URL", normalizedMode === "production" ? "https://api.circle.com" : "https://api-sandbox.circle.com");
  const blockchain = readEnv("CIRCLE_BLOCKCHAIN", normalizedMode === "production" ? "BASE" : "BASE-SEPOLIA");
  const timeoutMs = Number(readEnv("CIRCLE_TIMEOUT_MS", "20000"));
  const entitySecretProvider = normalizeEntitySecretProvider();

  const missing = [];
  if (!apiKey) missing.push("CIRCLE_API_KEY");
  if (!sourceWalletId) missing.push("CIRCLE_WALLET_ID_SPEND");
  if (!tokenId) missing.push("CIRCLE_TOKEN_ID_USDC");
  if (!entitySecretProvider) {
    missing.push("CIRCLE_ENTITY_SECRET_CIPHERTEXT_TEMPLATE (or CIRCLE_ENTITY_SECRET_CIPHERTEXT + CIRCLE_ALLOW_STATIC_ENTITY_SECRET=1)");
  }
  if (missing.length > 0) {
    throw new Error(`circle payout execution requires env: ${missing.join(", ")}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("CIRCLE_TIMEOUT_MS must be a positive number");

  return {
    mode: normalizedMode,
    apiKey,
    sourceWalletId,
    tokenId,
    baseUrl: String(baseUrl).replace(/\/+$/, ""),
    blockchain,
    timeoutMs,
    getEntitySecretCiphertext: entitySecretProvider
  };
}

function extractCircleTransaction(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { id: null, state: null };
  const candidates = [payload];
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) candidates.push(payload.data);
  if (payload.transaction && typeof payload.transaction === "object" && !Array.isArray(payload.transaction)) candidates.push(payload.transaction);
  if (Array.isArray(payload.transactions) && payload.transactions.length > 0 && payload.transactions[0] && typeof payload.transactions[0] === "object") {
    candidates.push(payload.transactions[0]);
  }
  for (const row of candidates) {
    const id =
      (typeof row.id === "string" && row.id.trim() !== "" ? row.id.trim() : null) ??
      (typeof row.transactionId === "string" && row.transactionId.trim() !== "" ? row.transactionId.trim() : null);
    const state = normalizeCircleState(row.state ?? row.status ?? null);
    if (id || state) return { id, state };
  }
  return { id: null, state: null };
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return { text: "", json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

async function fetchWithTimeout(fetchFn, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCircleJson({ runtime, method, endpoint, body = null }) {
  const fetchFn = typeof fetch === "function" ? fetch : null;
  if (!fetchFn) throw new Error("global fetch is unavailable");
  const url = new URL(endpoint, runtime.baseUrl).toString();
  const res = await fetchWithTimeout(
    fetchFn,
    url,
    {
      method,
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        "content-type": "application/json; charset=utf-8",
        "x-request-id": crypto.randomUUID()
      },
      body: body === null ? undefined : JSON.stringify(body)
    },
    runtime.timeoutMs
  );
  const parsed = await parseResponseBody(res);
  if (!res.ok) {
    const detail = parsed.json?.message ?? parsed.json?.error ?? parsed.text ?? `HTTP ${res.status}`;
    throw new Error(`Circle ${method} ${endpoint} failed: ${detail}`);
  }
  return parsed.json;
}

async function resolveWalletAddress({ runtime, walletId, cache }) {
  const key = String(walletId ?? "").trim();
  if (!key) throw new Error("walletId is required");
  if (cache.has(key)) return cache.get(key);
  const payload = await fetchCircleJson({
    runtime,
    method: "GET",
    endpoint: `/v1/w3s/wallets/${encodeURIComponent(key)}`
  });
  const candidates = [payload, payload?.data].filter((row) => row && typeof row === "object" && !Array.isArray(row));
  let address = null;
  for (const row of candidates) {
    if (typeof row.address === "string" && row.address.trim() !== "") {
      address = row.address.trim();
      break;
    }
    if (typeof row.blockchainAddress === "string" && row.blockchainAddress.trim() !== "") {
      address = row.blockchainAddress.trim();
      break;
    }
    if (Array.isArray(row.addresses) && row.addresses.length > 0) {
      const first = row.addresses[0];
      if (first && typeof first === "object" && !Array.isArray(first) && typeof first.address === "string" && first.address.trim() !== "") {
        address = first.address.trim();
        break;
      }
    }
  }
  if (!address) throw new Error(`unable to resolve wallet address for ${walletId}`);
  cache.set(key, address);
  return address;
}

function classifyCircleTransferState(state) {
  if (!state) return "unknown";
  if (CIRCLE_TX_OK_STATES.has(state)) return "submitted";
  if (CIRCLE_TX_FAIL_STATES.has(state)) return "failed";
  return "unknown";
}

async function fetchCircleTransactionById({ runtime, transactionId }) {
  const txId = String(transactionId ?? "").trim();
  if (!txId) throw new Error("transactionId is required");
  const endpoints = [`/v1/w3s/transactions/${encodeURIComponent(txId)}`, `/v1/w3s/developer/transactions/${encodeURIComponent(txId)}`];
  let lastErr = null;
  for (const endpoint of endpoints) {
    try {
      const payload = await fetchCircleJson({ runtime, method: "GET", endpoint });
      return extractCircleTransaction(payload);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`unable to fetch Circle transaction ${txId}`);
}

async function executeCirclePayoutBatch({ runtime, batch, walletAddressCache }) {
  if (runtime.mode === "stub") {
    const fakeTxId = `circle_tx_${sha256Hex(`stub:${batch.batchId}`).slice(0, 24)}`;
    return {
      ok: true,
      transactionId: fakeTxId,
      circleState: "COMPLETE",
      response: {
        mode: "stub",
        destinationType: batch.destination?.type ?? null
      }
    };
  }

  const destination = batch.destination;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    return { ok: false, error: "batch destination is missing" };
  }

  let destinationAddress = null;
  let destinationWalletId = null;
  let blockchain = runtime.blockchain;

  const destinationType = typeof destination.type === "string" ? destination.type.trim().toLowerCase() : "";
  if (destinationType === "circle_wallet") {
    destinationWalletId = typeof destination.walletId === "string" && destination.walletId.trim() !== "" ? destination.walletId.trim() : null;
    if (!destinationWalletId) return { ok: false, error: "circle_wallet destination requires walletId" };
    destinationAddress = await resolveWalletAddress({ runtime, walletId: destinationWalletId, cache: walletAddressCache });
    if (typeof destination.blockchain === "string" && destination.blockchain.trim() !== "") blockchain = destination.blockchain.trim();
  } else if (destinationType === "onchain_address") {
    destinationAddress = typeof destination.address === "string" && destination.address.trim() !== "" ? destination.address.trim() : null;
    if (!destinationAddress) return { ok: false, error: "onchain_address destination requires address" };
    if (typeof destination.blockchain === "string" && destination.blockchain.trim() !== "") blockchain = destination.blockchain.trim();
  } else {
    return { ok: false, error: `unsupported destination.type: ${String(destination.type ?? "unknown")}` };
  }

  const body = {
    idempotencyKey: batch.payout.idempotencyKey,
    walletId: runtime.sourceWalletId,
    destinationAddress,
    tokenId: runtime.tokenId,
    blockchain,
    entitySecretCiphertext: runtime.getEntitySecretCiphertext(),
    amounts: [centsToAssetAmountString(batch.totalAmountCents)]
  };
  if (destinationWalletId) body.destinationWalletId = destinationWalletId;

  const payload = await fetchCircleJson({
    runtime,
    method: "POST",
    endpoint: "/v1/w3s/developer/transactions/transfer",
    body
  });
  const extracted = extractCircleTransaction(payload);
  const transactionId = extracted.id;
  let circleState = normalizeCircleState(extracted.state);

  if (!transactionId) return { ok: false, error: "circle response missing transaction id" };
  if (!circleState) {
    const fetched = await fetchCircleTransactionById({ runtime, transactionId });
    circleState = normalizeCircleState(fetched.state);
  }

  const classification = classifyCircleTransferState(circleState);
  if (classification === "submitted") {
    return {
      ok: true,
      transactionId,
      circleState,
      response: payload
    };
  }
  return {
    ok: false,
    transactionId,
    circleState,
    error: `circle transfer not safe to mark submitted (state=${circleState ?? "unknown"})`
  };
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
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const circleMode = normalizeCircleMode(args.circleMode ?? readEnv("X402_BATCH_CIRCLE_MODE", "stub"));
  const registry = loadRegistry(args.registryPath);
  const workerState = loadWorkerState(args.statePath);
  const discovered = collectArtifactRuns(args.artifactRoot);
  const nowAt = nowIso();

  const existingByBatchId = new Map();
  for (const row of workerState.state.batches) {
    const normalized = normalizeBatchRecord(row, { defaultMaxAttempts: args.maxPayoutAttempts });
    if (!normalized) continue;
    existingByBatchId.set(normalized.batchId, normalized);
  }

  const alreadyProcessed = workerState.state.processedGateIds;
  const eligible = discovered.filter((row) => {
    if (!row.gateId) return false;
    if (alreadyProcessed[row.gateId]) return false;
    if (row.releasedAmountCents <= 0) return false;
    if (row.settlementStatus !== "released") return false;
    return true;
  });

  const groups = groupByProviderAndCurrency(eligible);
  const skipped = [];
  const newBatches = [];
  for (const groupRows of groups.values()) {
    const sortedRows = groupRows
      .slice()
      .sort((a, b) => `${a.resolvedAt ?? ""}\n${a.gateId}`.localeCompare(`${b.resolvedAt ?? ""}\n${b.gateId}`));
    const providerId = sortedRows[0].providerId;
    const currency = sortedRows[0].currency;
    const destination = registry.providerDestinations.get(providerId) ?? null;
    if (!destination) {
      skipped.push({
        providerId,
        currency,
        reason: "missing_provider_destination",
        gateIds: sortedRows.map((row) => row.gateId)
      });
      continue;
    }

    const batch = buildNewBatch({
      providerId,
      currency,
      rows: sortedRows,
      destination,
      nowAt,
      maxAttempts: args.maxPayoutAttempts
    });
    const existing = existingByBatchId.get(batch.batchId) ?? null;
    if (existing) continue;
    existingByBatchId.set(batch.batchId, batch);
    newBatches.push(batch);
    for (const gate of batch.gates) {
      alreadyProcessed[gate.gateId] = {
        batchId: batch.batchId,
        providerId: batch.providerId,
        processedAt: nowAt
      };
    }
  }

  const payoutExecution = {
    enabled: args.executeCircle === true,
    mode: circleMode,
    attempted: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
    results: []
  };

  if (args.executeCircle && args.dryRun) {
    const batchesSorted = Array.from(existingByBatchId.values()).sort((a, b) => String(a.batchId).localeCompare(String(b.batchId)));
    payoutExecution.skipped = batchesSorted.length;
    payoutExecution.results = batchesSorted.map((batch) => ({
      batchId: batch.batchId,
      status: "skipped_dry_run"
    }));
  } else if (args.executeCircle) {
    const runtime = createCirclePayoutRuntime({ mode: circleMode });
    const walletAddressCache = new Map();
    const batchesSorted = Array.from(existingByBatchId.values()).sort((a, b) => String(a.batchId).localeCompare(String(b.batchId)));
    for (const batch of batchesSorted) {
      const payout = batch.payout ?? {};
      const status = String(payout.status ?? "").toLowerCase();
      const attempts = normalizeNonNegativeInt(payout.attempts, 0);
      const maxAttempts = normalizeNonNegativeInt(payout.maxAttempts, args.maxPayoutAttempts) || args.maxPayoutAttempts;
      batch.payout.maxAttempts = maxAttempts;
      batch.payout.idempotencyKey =
        typeof payout.idempotencyKey === "string" && payout.idempotencyKey.trim() !== ""
          ? payout.idempotencyKey.trim()
          : stableUuidV4FromString(`x402-batch:${batch.batchId}`);

      if (status === "submitted" || status === "confirmed") {
        payoutExecution.skipped += 1;
        payoutExecution.results.push({
          batchId: batch.batchId,
          status: "skipped_already_submitted",
          transactionId: batch.payout.transactionId ?? null
        });
        continue;
      }
      if (status === "failed" && attempts >= maxAttempts) {
        payoutExecution.skipped += 1;
        payoutExecution.results.push({
          batchId: batch.batchId,
          status: "skipped_retry_exhausted",
          attempts,
          maxAttempts
        });
        continue;
      }

      payoutExecution.attempted += 1;
      batch.payout.lastAttemptAt = nowAt;
      batch.payout.attempts = attempts + 1;
      batch.payout.maxAttempts = maxAttempts;
      try {
        const executed = await executeCirclePayoutBatch({ runtime, batch, walletAddressCache });
        if (!executed.ok) {
          batch.payout.status = "failed";
          batch.payout.lastError = {
            message: executed.error ?? "unknown error",
            circleState: executed.circleState ?? null
          };
          batch.payout.circleState = executed.circleState ?? null;
          if (executed.transactionId) batch.payout.transactionId = executed.transactionId;
          payoutExecution.failed += 1;
          payoutExecution.results.push({
            batchId: batch.batchId,
            status: "failed",
            transactionId: executed.transactionId ?? null,
            circleState: executed.circleState ?? null,
            error: executed.error ?? null
          });
          continue;
        }

        batch.payout.status = "submitted";
        batch.payout.transactionId = executed.transactionId ?? batch.payout.transactionId ?? null;
        batch.payout.circleState = executed.circleState ?? null;
        batch.payout.lastError = null;
        batch.payout.submittedAt = nowAt;
        batch.payout.providerResponse = executed.response ?? null;
        batch.settlementMethod = "circle_transfer";
        payoutExecution.submitted += 1;
        payoutExecution.results.push({
          batchId: batch.batchId,
          status: "submitted",
          transactionId: batch.payout.transactionId,
          circleState: batch.payout.circleState
        });
      } catch (err) {
        batch.payout.status = "failed";
        batch.payout.lastError = { message: err?.message ?? String(err ?? "") };
        payoutExecution.failed += 1;
        payoutExecution.results.push({
          batchId: batch.batchId,
          status: "failed",
          error: err?.message ?? String(err ?? "")
        });
      }
    }
  }

  const batchesSorted = Array.from(existingByBatchId.values()).sort((a, b) => String(a.batchId).localeCompare(String(b.batchId)));

  const manifest = {
    schemaVersion: "X402PayoutManifest.v1",
    createdAt: nowAt,
    artifactRoot: path.resolve(process.cwd(), args.artifactRoot),
    registryPath: registry.resolvedPath,
    statePath: workerState.resolvedPath,
    dryRun: args.dryRun === true,
    executeCircle: args.executeCircle === true,
    circleMode,
    discoveredGateCount: discovered.length,
    eligibleGateCount: eligible.length,
    skipped,
    newBatches,
    trackedBatchCount: batchesSorted.length,
    payoutExecution
  };
  const manifestHash = sha256Hex(canonicalJsonStringify(manifest));
  const signature = maybeSignManifest(manifest);

  const outDir =
    args.outDir && String(args.outDir).trim() !== ""
      ? path.resolve(process.cwd(), args.outDir)
      : path.resolve(process.cwd(), "artifacts", "settlement", "x402-batches", nowAt.replaceAll(":", "").replaceAll(".", ""));
  fs.mkdirSync(outDir, { recursive: true });

  writeJsonFile(path.join(outDir, "payout-manifest.json"), manifest);
  writeJsonFile(path.join(outDir, "payout-manifest.meta.json"), {
    schemaVersion: "X402PayoutManifestMeta.v1",
    manifestHash,
    signature
  });
  for (const batch of newBatches) {
    writeJsonFile(path.join(outDir, "batches", `${batch.batchId}.json`), batch);
  }

  if (!args.dryRun) {
    workerState.state.updatedAt = nowAt;
    workerState.state.processedGateIds = alreadyProcessed;
    workerState.state.batches = batchesSorted;
    writeJsonFile(workerState.resolvedPath, workerState.state);
  }

  const result = {
    ok: true,
    outDir,
    manifestHash,
    batchCount: newBatches.length,
    trackedBatchCount: batchesSorted.length,
    skippedProviderCount: skipped.length,
    processedGateCount: newBatches.reduce((sum, batch) => sum + batch.gateCount, 0),
    dryRun: args.dryRun === true,
    executeCircle: args.executeCircle === true,
    payoutExecution
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
  process.exitCode = 1;
});
