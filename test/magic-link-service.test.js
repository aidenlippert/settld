import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildDeterministicZipStore } from "../src/core/deterministic-zip.js";
import { keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { unzipToTempSafe } from "../packages/artifact-verify/src/safe-unzip.js";
import { safeTruncate } from "../services/magic-link/src/redaction.js";
import { MAGIC_LINK_RENDER_MODEL_ALLOWLIST_V1, buildPublicInvoiceClaimFromClaimJson } from "../services/magic-link/src/render-model.js";
import { garbageCollectTenantByRetention } from "../services/magic-link/src/retention-gc.js";
import { loadTenantSettings } from "../services/magic-link/src/tenant-settings.js";
import { listenOnEphemeralLoopback } from "./lib/listen.js";

let dataDir = null;
let magicLinkHandler = null;
let oauthMockBaseUrl = null;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const oauthMockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const params = new URLSearchParams(raw);

    if (req.method === "POST" && req.url === "/slack/token") {
      const code = String(params.get("code") ?? "").trim();
      if (!code) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "code_missing" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-mock",
          incoming_webhook: { url: "https://hooks.slack.com/services/TMOCK/BMOCK/SLACKTOKEN" }
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/zapier/token") {
      const code = String(params.get("code") ?? "").trim();
      if (!code) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "code_missing" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          access_token: "zap-mock-token",
          webhookUrl: "https://hooks.zapier.com/hooks/catch/123456/abcdef/"
        })
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
});

const stripeMockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const params = new URLSearchParams(raw);

    if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
      const priceId = String(params.get("line_items[0][price]") ?? "").trim();
      const tenantId = String(params.get("metadata[tenantId]") ?? "").trim();
      const plan = String(params.get("metadata[plan]") ?? "").trim();
      if (!priceId || !tenantId || !plan) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { message: "missing required fields" } }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          id: `cs_test_${tenantId}_${plan}`,
          url: `https://checkout.stripe.test/session/${tenantId}/${plan}`
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/v1/billing_portal/sessions") {
      const customer = String(params.get("customer") ?? "").trim();
      if (!customer) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { message: "customer required" } }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          id: `bps_test_${customer}`,
          url: `https://billing.stripe.test/portal/${customer}`
        })
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { message: "not_found" } }));
  });
});

const circleWalletRows = [
  {
    id: "wid_circle_spend_test",
    state: "LIVE",
    walletSetId: "wset_circle_test",
    custodyType: "DEVELOPER",
    address: "0x0000000000000000000000000000000000000a11",
    blockchain: "BASE-SEPOLIA",
    accountType: "EOA",
    updateDate: "2026-02-21T00:00:00Z",
    createDate: "2026-02-21T00:00:00Z"
  },
  {
    id: "wid_circle_escrow_test",
    state: "LIVE",
    walletSetId: "wset_circle_test",
    custodyType: "DEVELOPER",
    address: "0x0000000000000000000000000000000000000b22",
    blockchain: "BASE-SEPOLIA",
    accountType: "EOA",
    updateDate: "2026-02-21T00:00:00Z",
    createDate: "2026-02-21T00:00:00Z"
  }
];
const circleBootstrapRequests = [];
const circleMockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = parsedUrl.pathname;
    const method = String(req.method ?? "GET").toUpperCase();
    const auth = String(req.headers.authorization ?? "").trim();
    circleBootstrapRequests.push({
      method,
      pathname,
      auth,
      body: json
    });
    if (auth !== "Bearer TEST_API_KEY:mock_circle") {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ code: 401, message: "Invalid credentials." }));
      return;
    }

    if (method === "GET" && pathname === "/v1/w3s/wallets") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ data: { wallets: circleWalletRows } }));
      return;
    }
    const walletMatch = /^\/v1\/w3s\/wallets\/([^/]+)$/.exec(pathname);
    if (method === "GET" && walletMatch) {
      const walletId = decodeURIComponent(walletMatch[1]);
      const row = circleWalletRows.find((item) => item.id === walletId);
      if (!row) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ code: 404, message: "wallet not found" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ data: { wallet: row } }));
      return;
    }
    const balancesMatch = /^\/v1\/w3s\/wallets\/([^/]+)\/balances$/.exec(pathname);
    if (method === "GET" && balancesMatch) {
      const walletId = decodeURIComponent(balancesMatch[1]);
      const row = circleWalletRows.find((item) => item.id === walletId);
      if (!row) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ code: 404, message: "wallet not found" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          data: {
            tokenBalances: [
              {
                token: {
                  id: "eth_base_sepolia_token",
                  blockchain: row.blockchain,
                  name: "Base Ethereum-Sepolia",
                  symbol: "ETH-SEPOLIA",
                  decimals: 18,
                  isNative: true
                },
                amount: "0.1"
              },
              {
                token: {
                  id: "usdc_base_sepolia_token",
                  blockchain: row.blockchain,
                  tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
                  standard: "ERC20",
                  name: "USDC",
                  symbol: "USDC",
                  decimals: 6,
                  isNative: false
                },
                amount: "100"
              }
            ]
          }
        })
      );
      return;
    }
    if (method === "POST" && pathname === "/v1/faucet/drips") {
      res.statusCode = 204;
      res.end("");
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ code: 404, message: "not_found" }));
  });
});

const settldOpsBootstrapRequests = [];
const settldOpsBootstrapState = { nextErrorStatus: null, nextErrorBody: null };
const settldOpsApiRequests = [];
const settldOpsFlowState = {
  walletBalances: new Map(),
  runs: new Map()
};
const settldOpsMockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = parsedUrl.pathname;
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, code: "INVALID_JSON", message: "invalid json" }));
      return;
    }

    const tenantId = String(req.headers["x-proxy-tenant-id"] ?? "").trim() || "tenant_unknown";
    const protocol = String(req.headers["x-settld-protocol"] ?? "").trim();
    const requestRecord = {
      method: String(req.method ?? "GET").toUpperCase(),
      pathname,
      tenantId,
      protocol,
      authorization: String(req.headers.authorization ?? "").trim() || null,
      expectedPrevChainHash: String(req.headers["x-proxy-expected-prev-chain-hash"] ?? "").trim() || null,
      idempotencyKey: String(req.headers["x-idempotency-key"] ?? "").trim() || null,
      body
    };
    settldOpsApiRequests.push(requestRecord);

    if (req.method === "POST" && pathname === "/ops/tenants/bootstrap") {
      const opsToken = String(req.headers["x-proxy-ops-token"] ?? "").trim();
      settldOpsBootstrapRequests.push({
        tenantId,
        protocol,
        opsToken,
        idempotencyKey: requestRecord.idempotencyKey,
        body
      });

      if (Number.isInteger(settldOpsBootstrapState.nextErrorStatus)) {
        const status = settldOpsBootstrapState.nextErrorStatus;
        const errBody = settldOpsBootstrapState.nextErrorBody ?? { ok: false, code: "UPSTREAM_FAILURE", message: "mock upstream failure" };
        settldOpsBootstrapState.nextErrorStatus = null;
        settldOpsBootstrapState.nextErrorBody = null;
        res.statusCode = status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(errBody));
        return;
      }

      const requestedScopes = Array.isArray(body?.apiKey?.scopes) ? body.apiKey.scopes.filter((s) => typeof s === "string" && s.trim()) : [];
      const scopes = requestedScopes.length ? requestedScopes : ["runs:write", "runs:read"];
      const keyId = typeof body?.apiKey?.keyId === "string" && body.apiKey.keyId.trim() ? body.apiKey.keyId.trim() : "ak_runtime";
      const token = `${keyId}.secret_runtime`;
      const apiBaseUrl = "https://api.mock.settld.work";
      const env = {
        SETTLD_TENANT_ID: tenantId,
        SETTLD_BASE_URL: apiBaseUrl,
        SETTLD_API_KEY: token
      };
      const exportCommands = Object.entries(env)
        .map(([name, value]) => `export ${name}=${JSON.stringify(String(value))}`)
        .join("\n");
      res.statusCode = 201;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          tenantId,
          bootstrap: {
            tenantId,
            apiBaseUrl,
            apiKey: {
              keyId,
              token,
              scopes,
              expiresAt: null,
              description: "tenant bootstrap"
            },
            env,
            exportCommands
          }
        })
      );
      return;
    }

    const authHeader = String(req.headers.authorization ?? "").trim();
    if (!authHeader || !/^Bearer\s+/.test(authHeader)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "missing bearer token" }));
      return;
    }
    if (!tenantId) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, code: "TENANT_REQUIRED", message: "x-proxy-tenant-id is required" }));
      return;
    }

    const sendJson = (status, payload) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    };

    if (req.method === "POST" && pathname === "/agents/register") {
      const agentId = typeof body?.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : `agt_${crypto.randomBytes(4).toString("hex")}`;
      sendJson(201, {
        ok: true,
        agentIdentity: { agentId },
        agent: {
          agentId,
          displayName: typeof body?.displayName === "string" ? body.displayName : null
        }
      });
      return;
    }

    const walletCreditMatch = /^\/agents\/([^/]+)\/wallet\/credit$/.exec(pathname);
    if (req.method === "POST" && walletCreditMatch) {
      const agentId = decodeURIComponent(walletCreditMatch[1]);
      const amountCents = Number.parseInt(String(body?.amountCents ?? ""), 10);
      const currency = typeof body?.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : "USD";
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        sendJson(400, { ok: false, code: "INVALID_AMOUNT", message: "amountCents must be positive" });
        return;
      }
      const key = `${tenantId}:${agentId}:${currency}`;
      const prior = Number(settldOpsFlowState.walletBalances.get(key) ?? 0);
      const next = prior + amountCents;
      settldOpsFlowState.walletBalances.set(key, next);
      sendJson(200, {
        ok: true,
        wallet: {
          agentId,
          currency,
          balanceCents: next,
          availableCents: next
        }
      });
      return;
    }

    if (req.method === "POST" && pathname === "/marketplace/rfqs") {
      const rfqId = typeof body?.rfqId === "string" && body.rfqId.trim() ? body.rfqId.trim() : `rfq_${crypto.randomBytes(4).toString("hex")}`;
      sendJson(201, {
        ok: true,
        rfq: {
          rfqId,
          title: typeof body?.title === "string" ? body.title : null,
          capability: typeof body?.capability === "string" ? body.capability : null,
          posterAgentId: typeof body?.posterAgentId === "string" ? body.posterAgentId : null,
          budgetCents: body?.budgetCents ?? null,
          currency: typeof body?.currency === "string" ? body.currency : "USD",
          status: "open"
        }
      });
      return;
    }

    const rfqBidMatch = /^\/marketplace\/rfqs\/([^/]+)\/bids$/.exec(pathname);
    if (req.method === "POST" && rfqBidMatch) {
      const rfqId = decodeURIComponent(rfqBidMatch[1]);
      const bidId = typeof body?.bidId === "string" && body.bidId.trim() ? body.bidId.trim() : `bid_${crypto.randomBytes(4).toString("hex")}`;
      sendJson(201, {
        ok: true,
        bid: {
          bidId,
          rfqId,
          bidderAgentId: typeof body?.bidderAgentId === "string" ? body.bidderAgentId : null,
          amountCents: body?.amountCents ?? null,
          currency: typeof body?.currency === "string" ? body.currency : "USD",
          etaSeconds: body?.etaSeconds ?? null,
          status: "submitted"
        }
      });
      return;
    }

    const rfqAcceptMatch = /^\/marketplace\/rfqs\/([^/]+)\/accept$/.exec(pathname);
    if (req.method === "POST" && rfqAcceptMatch) {
      const rfqId = decodeURIComponent(rfqAcceptMatch[1]);
      const runId = `run_${rfqId}_${crypto.randomBytes(3).toString("hex")}`;
      const lastChainHash = crypto.createHash("sha256").update(`${tenantId}:${runId}:0`, "utf8").digest("hex");
      settldOpsFlowState.runs.set(runId, {
        runId,
        tenantId,
        status: "running",
        verificationStatus: "amber",
        settlementStatus: "pending",
        lastChainHash
      });
      sendJson(200, {
        ok: true,
        run: {
          runId,
          status: "running",
          lastChainHash
        },
        settlement: {
          status: "pending"
        },
        acceptance: {
          rfqId,
          bidId: typeof body?.bidId === "string" ? body.bidId : null
        }
      });
      return;
    }

    const runEventMatch = /^\/agents\/([^/]+)\/runs\/([^/]+)\/events$/.exec(pathname);
    if (req.method === "POST" && runEventMatch) {
      const runId = decodeURIComponent(runEventMatch[2]);
      const runState = settldOpsFlowState.runs.get(runId);
      if (!runState) {
        sendJson(404, { ok: false, code: "RUN_NOT_FOUND", message: "run not found" });
        return;
      }
      const expectedPrev = String(req.headers["x-proxy-expected-prev-chain-hash"] ?? "").trim().toLowerCase();
      if (!expectedPrev || expectedPrev !== String(runState.lastChainHash).toLowerCase()) {
        sendJson(409, { ok: false, code: "PREV_CHAIN_HASH_MISMATCH", message: "expected previous chain hash mismatch" });
        return;
      }
      const nextChainHash = crypto.createHash("sha256").update(`${runState.lastChainHash}:${String(body?.type ?? "EVENT")}`, "utf8").digest("hex");
      runState.status = "completed";
      runState.verificationStatus = "green";
      runState.settlementStatus = "released";
      runState.lastChainHash = nextChainHash;
      settldOpsFlowState.runs.set(runId, runState);
      sendJson(200, {
        ok: true,
        event: {
          eventId: `evt_${crypto.randomBytes(4).toString("hex")}`,
          type: typeof body?.type === "string" ? body.type : "RUN_COMPLETED"
        },
        run: {
          runId,
          status: runState.status,
          lastChainHash: runState.lastChainHash
        },
        settlement: {
          status: runState.settlementStatus
        }
      });
      return;
    }

    const runVerificationMatch = /^\/runs\/([^/]+)\/verification$/.exec(pathname);
    if (req.method === "GET" && runVerificationMatch) {
      const runId = decodeURIComponent(runVerificationMatch[1]);
      const runState = settldOpsFlowState.runs.get(runId);
      if (!runState) {
        sendJson(404, { ok: false, code: "RUN_NOT_FOUND", message: "run not found" });
        return;
      }
      sendJson(200, {
        ok: true,
        runId,
        verification: {
          verificationStatus: runState.verificationStatus,
          warnings: [],
          errors: []
        }
      });
      return;
    }

    const runSettlementMatch = /^\/runs\/([^/]+)\/settlement$/.exec(pathname);
    if (req.method === "GET" && runSettlementMatch) {
      const runId = decodeURIComponent(runSettlementMatch[1]);
      const runState = settldOpsFlowState.runs.get(runId);
      if (!runState) {
        sendJson(404, { ok: false, code: "RUN_NOT_FOUND", message: "run not found" });
        return;
      }
      sendJson(200, {
        ok: true,
        runId,
        settlement: {
          status: runState.settlementStatus
        }
      });
      return;
    }

    sendJson(404, { ok: false, error: "not_found" });
  });
});

function applyEnv(envPatch) {
  const prev = {};
  for (const [key, value] of Object.entries(envPatch ?? {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(cur) {
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(cur, e.name);
      if (e.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(fp);
      } else if (e.isFile()) {
        out.push(fp);
      }
    }
  }
  await walk(dir);
  out.sort();
  return out;
}

async function zipDir(dir) {
  const files = new Map();
  const fps = await listFilesRecursive(dir);
  for (const fp of fps) {
    const rel = path.relative(dir, fp).split(path.sep).join("/");
    // eslint-disable-next-line no-await-in-loop
    const bytes = await fs.readFile(fp);
    files.set(rel, bytes);
  }
  const zip = buildDeterministicZipStore({ files, mtime: new Date("2000-01-01T00:00:00.000Z") });
  return Buffer.from(zip);
}

function makeMockRes() {
  const headers = new Map();
  const chunks = [];
  return {
    statusCode: 200,
    setHeader(k, v) {
      headers.set(String(k).toLowerCase(), String(v));
    },
    getHeader(k) {
      return headers.get(String(k).toLowerCase()) ?? null;
    },
    end(data) {
      if (data !== undefined && data !== null) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      this.ended = true;
    },
    ended: false,
    _headers: headers,
    _body() {
      return Buffer.concat(chunks);
    }
  };
}

async function runReq({ method, url, headers, bodyChunks }) {
  assert.equal(typeof magicLinkHandler, "function", "magicLinkHandler not initialized");
  const req = Readable.from(bodyChunks ?? []);
  req.method = method;
  req.url = url;
  req.headers = headers ?? {};

  const res = makeMockRes();
  await magicLinkHandler(req, res);
  return res;
}

async function uploadZip({ zipBuf, mode, tenantId, runId = null }) {
  const u = new URL("/v1/upload", "http://localhost");
  if (mode) u.searchParams.set("mode", mode);
  if (runId) u.searchParams.set("runId", String(runId));
  const res = await runReq({
    method: "POST",
    url: u.pathname + (u.search ? u.search : ""),
    headers: {
      "x-api-key": "test_key",
      "x-tenant-id": tenantId,
      "content-type": "application/zip",
      "content-length": String(zipBuf.length)
    },
    bodyChunks: [zipBuf]
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  assert.match(String(json.token), /^ml_[0-9a-f]{48}$/);
  assert.match(String(json.url), /^\/r\/ml_[0-9a-f]{48}$/);
  return json;
}

async function putTenantSettings({ tenantId, patch }) {
  const buf = Buffer.from(JSON.stringify(patch ?? {}), "utf8");
  const res = await runReq({
    method: "PUT",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/settings`,
    headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(buf.length) },
    bodyChunks: [buf]
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

async function createTenant({ name, contactEmail, billingEmail, tenantId = null } = {}) {
  const payload = {
    name: String(name ?? "").trim(),
    contactEmail: String(contactEmail ?? "").trim(),
    billingEmail: String(billingEmail ?? "").trim()
  };
  if (tenantId) payload.tenantId = String(tenantId).trim();
  const buf = Buffer.from(JSON.stringify(payload), "utf8");
  const res = await runReq({
    method: "POST",
    url: "/v1/tenants",
    headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(buf.length) },
    bodyChunks: [buf]
  });
  assert.equal(res.statusCode, 201, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

function monthKeyUtcNow() {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

async function getTenantUsage({ tenantId, month = null }) {
  const url = month ? `/v1/tenants/${encodeURIComponent(tenantId)}/usage?month=${encodeURIComponent(month)}` : `/v1/tenants/${encodeURIComponent(tenantId)}/usage`;
  const res = await runReq({ method: "GET", url, headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  return JSON.parse(res._body().toString("utf8"));
}

async function getTenantEntitlements({ tenantId }) {
  const res = await runReq({
    method: "GET",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/entitlements`,
    headers: { "x-api-key": "test_key" },
    bodyChunks: []
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

async function setTenantPlan({ tenantId, plan }) {
  const buf = Buffer.from(JSON.stringify({ plan }), "utf8");
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/plan`,
    headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(buf.length) },
    bodyChunks: [buf]
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

async function postTenantRuntimeBootstrap({ tenantId, body = {}, headers = {} } = {}) {
  const buf = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  const mergedHeaders = {
    "x-api-key": "test_key",
    "content-type": "application/json",
    "content-length": String(buf.length),
    ...headers
  };
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/runtime-bootstrap`,
    headers: mergedHeaders,
    bodyChunks: [buf]
  });
  return {
    statusCode: res.statusCode,
    json: res._body().length ? JSON.parse(res._body().toString("utf8")) : null
  };
}

async function postTenantWalletBootstrap({ tenantId, body = {}, headers = {} } = {}) {
  const buf = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  const mergedHeaders = {
    "x-api-key": "test_key",
    "content-type": "application/json",
    "content-length": String(buf.length),
    ...headers
  };
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/wallet-bootstrap`,
    headers: mergedHeaders,
    bodyChunks: [buf]
  });
  return {
    statusCode: res.statusCode,
    json: res._body().length ? JSON.parse(res._body().toString("utf8")) : null
  };
}

async function postTenantRuntimeBootstrapSmokeTest({ tenantId, body = {}, headers = {} } = {}) {
  const buf = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  const mergedHeaders = {
    "x-api-key": "test_key",
    "content-type": "application/json",
    "content-length": String(buf.length),
    ...headers
  };
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/runtime-bootstrap/smoke-test`,
    headers: mergedHeaders,
    bodyChunks: [buf]
  });
  return {
    statusCode: res.statusCode,
    json: res._body().length ? JSON.parse(res._body().toString("utf8")) : null
  };
}

async function postTenantFirstPaidCall({ tenantId, body = {}, headers = {} } = {}) {
  const buf = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  const mergedHeaders = {
    "x-api-key": "test_key",
    "content-type": "application/json",
    "content-length": String(buf.length),
    ...headers
  };
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/first-paid-call`,
    headers: mergedHeaders,
    bodyChunks: [buf]
  });
  return {
    statusCode: res.statusCode,
    json: res._body().length ? JSON.parse(res._body().toString("utf8")) : null
  };
}

async function getTenantFirstPaidCallHistory({ tenantId, headers = {} } = {}) {
  const mergedHeaders = {
    "x-api-key": "test_key",
    ...headers
  };
  const res = await runReq({
    method: "GET",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/first-paid-call/history`,
    headers: mergedHeaders,
    bodyChunks: []
  });
  return {
    statusCode: res.statusCode,
    json: res._body().length ? JSON.parse(res._body().toString("utf8")) : null
  };
}

async function postTenantRuntimeConformanceMatrix({ tenantId, body = {}, headers = {} } = {}) {
  const buf = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  const mergedHeaders = {
    "x-api-key": "test_key",
    "content-type": "application/json",
    "content-length": String(buf.length),
    ...headers
  };
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/conformance-matrix`,
    headers: mergedHeaders,
    bodyChunks: [buf]
  });
  return {
    statusCode: res.statusCode,
    json: res._body().length ? JSON.parse(res._body().toString("utf8")) : null
  };
}

async function getTenantBillingInvoiceRes({ tenantId, month = null, format = null } = {}) {
  const u = new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/billing-invoice`, "http://localhost");
  if (month) u.searchParams.set("month", month);
  if (format) u.searchParams.set("format", format);
  return await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
}

async function getTenantBillingUsage({ tenantId, month = null }) {
  const u = new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/billing/usage`, "http://localhost");
  if (month) u.searchParams.set("month", month);
  const res = await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  return JSON.parse(res._body().toString("utf8"));
}

async function getTenantBillingInvoiceDraftRes({ tenantId, month = null, format = null } = {}) {
  const u = new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/billing/invoice-draft`, "http://localhost");
  if (month) u.searchParams.set("month", month);
  if (format) u.searchParams.set("format", format);
  return await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
}

async function getTenantBillingState({ tenantId }) {
  const res = await runReq({
    method: "GET",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/billing/state`,
    headers: { "x-api-key": "test_key" },
    bodyChunks: []
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

async function createTenantBillingCheckout({ tenantId, plan, successUrl = null, cancelUrl = null } = {}) {
  const payload = { plan };
  if (successUrl) payload.successUrl = successUrl;
  if (cancelUrl) payload.cancelUrl = cancelUrl;
  const buf = Buffer.from(JSON.stringify(payload), "utf8");
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/billing/checkout`,
    headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(buf.length) },
    bodyChunks: [buf]
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

async function createTenantBillingPortal({ tenantId, returnUrl = null } = {}) {
  const payload = returnUrl ? { returnUrl } : {};
  const buf = Buffer.from(JSON.stringify(payload), "utf8");
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/billing/portal`,
    headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(buf.length) },
    bodyChunks: [buf]
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

async function postStripeWebhookEvent(event) {
  const payload = Buffer.from(JSON.stringify(event), "utf8");
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", process.env.MAGIC_LINK_BILLING_STRIPE_WEBHOOK_SECRET ?? "")
    .update(`${timestamp}.${payload.toString("utf8")}`, "utf8")
    .digest("hex");
  const res = await runReq({
    method: "POST",
    url: "/v1/billing/stripe/webhook",
    headers: { "content-type": "application/json", "content-length": String(payload.length), "stripe-signature": `t=${timestamp},v1=${sig}` },
    bodyChunks: [payload]
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

async function readDecisionOtpOutboxCode({ token, email }) {
  const dir = path.join(dataDir, "decision-otp-outbox");
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    names = [];
  }
  const targetEmail = String(email ?? "").trim().toLowerCase();
  for (const name of names) {
    if (!name.startsWith(`${token}_`)) continue;
    const fp = path.join(dir, name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const j = JSON.parse(await fs.readFile(fp, "utf8"));
      if (j && typeof j === "object" && !Array.isArray(j) && j.token === token && String(j.email ?? "").toLowerCase() === targetEmail) {
        const code = String(j.code ?? "");
        if (/^[0-9]{6}$/.test(code)) return code;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function readBuyerOtpOutboxCode({ tenantId, email }) {
  const dir = path.join(dataDir, "buyer-otp-outbox");
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    names = [];
  }
  const tenant = String(tenantId ?? "").trim();
  const targetEmail = String(email ?? "").trim().toLowerCase();
  for (const name of names) {
    if (!name.startsWith(`${tenant}_`)) continue;
    const fp = path.join(dir, name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const j = JSON.parse(await fs.readFile(fp, "utf8"));
      if (j && typeof j === "object" && !Array.isArray(j) && j.tenantId === tenant && String(j.email ?? "").toLowerCase() === targetEmail) {
        const code = String(j.code ?? "");
        if (/^[0-9]{6}$/.test(code)) return code;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function uploadZipRaw({ zipBuf, mode, tenantId, runId = null }) {
  const u = new URL("/v1/upload", "http://localhost");
  if (mode) u.searchParams.set("mode", mode);
  if (runId) u.searchParams.set("runId", String(runId));
  const res = await runReq({
    method: "POST",
    url: u.pathname + (u.search ? u.search : ""),
    headers: {
      "x-api-key": "test_key",
      "x-tenant-id": tenantId,
      "content-type": "application/zip",
      "content-length": String(zipBuf.length)
    },
    bodyChunks: [zipBuf]
  });
  return { statusCode: res.statusCode, json: res._body().length ? JSON.parse(res._body().toString("utf8")) : null, raw: res._body() };
}

async function createIngestKey({ tenantId, vendorId, vendorName = null } = {}) {
  const payload = { vendorName };
  const buf = Buffer.from(JSON.stringify(payload), "utf8");
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${encodeURIComponent(tenantId)}/vendors/${encodeURIComponent(vendorId)}/ingest-keys`,
    headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(buf.length) },
    bodyChunks: [buf]
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  assert.ok(String(json.ingestKey).startsWith("igk_"));
  assert.match(String(json.keyHash), /^[0-9a-f]{64}$/);
  return json;
}

async function ingestZip({ zipBuf, mode, tenantId, ingestKey, contractId = null } = {}) {
  const u = new URL(`/v1/ingest/${tenantId}`, "http://localhost");
  if (mode) u.searchParams.set("mode", mode);
  if (contractId) u.searchParams.set("contractId", contractId);
  const res = await runReq({
    method: "POST",
    url: u.pathname + (u.search ? u.search : ""),
    headers: {
      authorization: `Bearer ${ingestKey}`,
      "content-type": "application/zip",
      "content-length": String(zipBuf.length)
    },
    bodyChunks: [zipBuf]
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

async function getInbox({ tenantId, query = {} } = {}) {
  const u = new URL("/v1/inbox", "http://localhost");
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  const res = await runReq({
    method: "GET",
    url: u.pathname + (u.search ? u.search : ""),
    headers: { "x-api-key": "test_key", "x-tenant-id": tenantId },
    bodyChunks: []
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  return JSON.parse(res._body().toString("utf8"));
}

async function getTenantCsvExport({ tenantId, month }) {
  const u = new URL(`/v1/tenants/${tenantId}/export.csv`, "http://localhost");
  if (month) u.searchParams.set("month", month);
  const res = await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200);
  return res._body().toString("utf8");
}

async function getTenantAuditPacket({ tenantId, month, includeBundles = true }) {
  const u = new URL(`/v1/tenants/${tenantId}/audit-packet`, "http://localhost");
  if (month) u.searchParams.set("month", month);
  if (!includeBundles) u.searchParams.set("includeBundles", "0");
  const res = await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200);
  return res._body();
}

async function getTenantSecurityControlsPacket({ tenantId, month }) {
  const u = new URL(`/v1/tenants/${tenantId}/security-controls-packet`, "http://localhost");
  if (month) u.searchParams.set("month", month);
  const res = await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200);
  return res._body();
}

async function getTenantSupportBundle({ tenantId, from, to, includeBundles = false }) {
  const u = new URL(`/v1/tenants/${tenantId}/support-bundle`, "http://localhost");
  if (from) u.searchParams.set("from", from);
  if (to) u.searchParams.set("to", to);
  if (includeBundles) u.searchParams.set("includeBundles", "1");
  const res = await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200);
  return res._body();
}

async function getTenantAnalyticsReport({ tenantId, month = null, bucket = null, limit = null } = {}) {
  const u = new URL(`/v1/tenants/${tenantId}/analytics`, "http://localhost");
  if (month) u.searchParams.set("month", month);
  if (bucket) u.searchParams.set("bucket", bucket);
  if (limit !== null && limit !== undefined) u.searchParams.set("limit", String(limit));
  const res = await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json.report;
}

async function getTenantTrustGraph({ tenantId, month = null, minRuns = null, maxEdges = null } = {}) {
  const u = new URL(`/v1/tenants/${tenantId}/trust-graph`, "http://localhost");
  if (month) u.searchParams.set("month", month);
  if (minRuns !== null && minRuns !== undefined) u.searchParams.set("minRuns", String(minRuns));
  if (maxEdges !== null && maxEdges !== undefined) u.searchParams.set("maxEdges", String(maxEdges));
  const res = await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json.graph;
}

async function createTrustGraphSnapshot({ tenantId, month = null, minRuns = null, maxEdges = null } = {}) {
  const body = {};
  if (month) body.month = month;
  if (minRuns !== null && minRuns !== undefined) body.minRuns = minRuns;
  if (maxEdges !== null && maxEdges !== undefined) body.maxEdges = maxEdges;
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  const res = await runReq({
    method: "POST",
    url: `/v1/tenants/${tenantId}/trust-graph/snapshots`,
    headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(buf.length) },
    bodyChunks: [buf]
  });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json.snapshot;
}

async function listTrustGraphSnapshots({ tenantId, limit = null } = {}) {
  const u = new URL(`/v1/tenants/${tenantId}/trust-graph/snapshots`, "http://localhost");
  if (limit !== null && limit !== undefined) u.searchParams.set("limit", String(limit));
  const res = await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json;
}

async function getTrustGraphDiff({ tenantId, baseMonth = null, compareMonth = null, limit = null } = {}) {
  const u = new URL(`/v1/tenants/${tenantId}/trust-graph/diff`, "http://localhost");
  if (baseMonth) u.searchParams.set("baseMonth", baseMonth);
  if (compareMonth) u.searchParams.set("compareMonth", compareMonth);
  if (limit !== null && limit !== undefined) u.searchParams.set("limit", String(limit));
  const res = await runReq({ method: "GET", url: u.pathname + (u.search ? u.search : ""), headers: { "x-api-key": "test_key" }, bodyChunks: [] });
  assert.equal(res.statusCode, 200, res._body().toString("utf8"));
  const json = JSON.parse(res._body().toString("utf8"));
  assert.equal(json.ok, true);
  return json.diff;
}

test("magic-link app (no listen): strict/auto, idempotency, downloads, revoke", async (t) => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-magic-link-service-test-"));

  const defaultRelayServer = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end("");
  });
  const deadLetterAlertServer = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end("");
  });

  let oauthPort = null;
  let stripePort = null;
  let relayPort = null;
  let alertPort = null;
  let settldOpsPort = null;
  let circlePort = null;
  settldOpsBootstrapRequests.length = 0;
  settldOpsBootstrapState.nextErrorStatus = null;
  settldOpsBootstrapState.nextErrorBody = null;
  settldOpsApiRequests.length = 0;
  settldOpsFlowState.walletBalances.clear();
  settldOpsFlowState.runs.clear();
  circleBootstrapRequests.length = 0;
  try {
    ({ port: oauthPort } = await listenOnEphemeralLoopback(oauthMockServer, { hosts: ["127.0.0.1"] }));
    ({ port: stripePort } = await listenOnEphemeralLoopback(stripeMockServer, { hosts: ["127.0.0.1"] }));
    ({ port: relayPort } = await listenOnEphemeralLoopback(defaultRelayServer, { hosts: ["127.0.0.1"] }));
    ({ port: alertPort } = await listenOnEphemeralLoopback(deadLetterAlertServer, { hosts: ["127.0.0.1"] }));
    ({ port: settldOpsPort } = await listenOnEphemeralLoopback(settldOpsMockServer, { hosts: ["127.0.0.1"] }));
    ({ port: circlePort } = await listenOnEphemeralLoopback(circleMockServer, { hosts: ["127.0.0.1"] }));
  } catch (err) {
    const cause = err?.cause ?? err;
    if (cause?.code === "EPERM" || cause?.code === "EACCES") {
      t.skip(`loopback listen not permitted (${cause.code})`);
      const closeIfListening = async (server) => {
        if (!server?.listening) return;
        await new Promise((resolve) => server.close(() => resolve()));
      };
      try {
        await closeIfListening(oauthMockServer);
        await closeIfListening(stripeMockServer);
        await closeIfListening(defaultRelayServer);
        await closeIfListening(deadLetterAlertServer);
        await closeIfListening(settldOpsMockServer);
        await closeIfListening(circleMockServer);
      } catch {
        // ignore
      }
      try {
        await fs.rm(dataDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      dataDir = null;
      return;
    }
    throw err;
  }
  oauthMockBaseUrl = `http://127.0.0.1:${oauthPort}`;

  const restoreEnv = applyEnv({
    MAGIC_LINK_DISABLE_LISTEN: "1",
    MAGIC_LINK_PORT: "0",
    MAGIC_LINK_HOST: "127.0.0.1",
    MAGIC_LINK_API_KEY: "test_key",
    MAGIC_LINK_DATA_DIR: dataDir,
    MAGIC_LINK_VERIFY_TIMEOUT_MS: "60000",
    MAGIC_LINK_RATE_LIMIT_UPLOADS_PER_MINUTE: "120",
    MAGIC_LINK_MAX_UPLOAD_BYTES: String(50 * 1024 * 1024),

    MAGIC_LINK_SETTINGS_KEY_HEX: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",

    // Avoid real network calls in integration tests (Slack/Zapier URLs are https://hooks.slack.com/...).
    MAGIC_LINK_WEBHOOK_DELIVERY_MODE: "record",
    MAGIC_LINK_WEBHOOK_TIMEOUT_MS: "1000",
    MAGIC_LINK_WEBHOOK_RETRY_INTERVAL_MS: "600000",
    MAGIC_LINK_WEBHOOK_RETRY_BACKOFF_MS: "0",

    // Workers should not race deterministic tests; we drive run-once ops explicitly in-test.
    MAGIC_LINK_PAYMENT_TRIGGER_RETRY_INTERVAL_MS: "600000",
    MAGIC_LINK_PAYMENT_TRIGGER_RETRY_BACKOFF_MS: "0",
    MAGIC_LINK_PAYMENT_TRIGGER_MAX_ATTEMPTS: "2",
    MAGIC_LINK_ARCHIVE_EXPORT_ENABLED: "0",

    MAGIC_LINK_DEFAULT_EVENT_RELAY_URL: `http://127.0.0.1:${relayPort}/event-relay`,
    MAGIC_LINK_DEFAULT_EVENT_RELAY_SECRET: "relay_secret",

    // Internal dead-letter alerts are delivered over HTTP in tests.
    MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_THRESHOLD: "1",
    MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_TARGETS: "internal",
    MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_URL: `http://127.0.0.1:${alertPort}/dead-letter-alert`,
    MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_SECRET: "alert_secret",

    // OAuth mocks for integrations UI.
    MAGIC_LINK_SLACK_OAUTH_CLIENT_ID: "slack_client_id",
    MAGIC_LINK_SLACK_OAUTH_CLIENT_SECRET: "slack_client_secret",
    MAGIC_LINK_SLACK_OAUTH_AUTHORIZE_URL: `http://127.0.0.1:${oauthPort}/slack/authorize`,
    MAGIC_LINK_SLACK_OAUTH_TOKEN_URL: `http://127.0.0.1:${oauthPort}/slack/token`,

    MAGIC_LINK_ZAPIER_OAUTH_CLIENT_ID: "zapier_client_id",
    MAGIC_LINK_ZAPIER_OAUTH_CLIENT_SECRET: "zapier_client_secret",
    MAGIC_LINK_ZAPIER_OAUTH_AUTHORIZE_URL: `http://127.0.0.1:${oauthPort}/zapier/authorize`,
    MAGIC_LINK_ZAPIER_OAUTH_TOKEN_URL: `http://127.0.0.1:${oauthPort}/zapier/token`,

    // Stripe billing mocks.
    MAGIC_LINK_BILLING_PROVIDER: "stripe",
    MAGIC_LINK_BILLING_STRIPE_API_BASE_URL: `http://127.0.0.1:${stripePort}`,
    MAGIC_LINK_BILLING_STRIPE_SECRET_KEY: "sk_test_mock",
    MAGIC_LINK_BILLING_STRIPE_WEBHOOK_SECRET: "whsec_mock",
    MAGIC_LINK_BILLING_STRIPE_PRICE_ID_GROWTH: "price_growth_mock",
    MAGIC_LINK_BILLING_STRIPE_PRICE_ID_SCALE: "price_scale_mock",
    MAGIC_LINK_PUBLIC_SIGNUP_ENABLED: "1",
    MAGIC_LINK_SETTLD_API_BASE_URL: `http://127.0.0.1:${settldOpsPort}`,
    MAGIC_LINK_SETTLD_OPS_TOKEN: "ops_token_magic_link",
    MAGIC_LINK_SETTLD_PROTOCOL: "1.0",

    CIRCLE_API_KEY: "TEST_API_KEY:mock_circle",
    CIRCLE_BASE_URL: `http://127.0.0.1:${circlePort}`,
    CIRCLE_BLOCKCHAIN: "BASE-SEPOLIA",
    X402_CIRCLE_RESERVE_MODE: "sandbox"
  });

  await t.after(async () => {
    restoreEnv();
    const closeIfListening = async (server) => {
      if (!server?.listening) return;
      await new Promise((resolve) => server.close(() => resolve()));
    };
    await closeIfListening(oauthMockServer);
    await closeIfListening(stripeMockServer);
    await closeIfListening(defaultRelayServer);
    await closeIfListening(deadLetterAlertServer);
    await closeIfListening(settldOpsMockServer);
    await closeIfListening(circleMockServer);
    await fs.rm(dataDir, { recursive: true, force: true });
    dataDir = null;
    magicLinkHandler = null;
    oauthMockBaseUrl = null;
  });

  // Import after env is configured; bust ESM cache to avoid cross-test contamination.
  ({ magicLinkHandler } = await import(`../services/magic-link/src/server.js?magic-link-service-test=${Date.now()}`));

  // Storage format marker should be initialized on startup (or migration).
  {
    const raw = await fs.readFile(path.join(dataDir, "format.json"), "utf8");
    const j = JSON.parse(raw);
    assert.equal(j?.schemaVersion, "MagicLinkDataFormat.v1");
    assert.equal(j?.version, 1);
  }

  {
    const res = await runReq({ method: "GET", url: "/healthz", headers: {}, bodyChunks: [] });
    assert.equal(res.statusCode, 200, res._body().toString("utf8"));
    const j = JSON.parse(res._body().toString("utf8"));
    assert.equal(j.ok, true);
  }
  {
    const res = await runReq({ method: "GET", url: "/metrics", headers: {}, bodyChunks: [] });
    assert.equal(res.statusCode, 200);
    const text = res._body().toString("utf8");
    assert.match(text, /magic_link_data_dir_writable_gauge/);
  }

  await t.test("public pricing page: renders current plan catalog and value-event pricing notes", async () => {
    const page = await runReq({ method: "GET", url: "/pricing", headers: {}, bodyChunks: [] });
    assert.equal(page.statusCode, 200, page._body().toString("utf8"));
    assert.match(String(page.getHeader("content-type") ?? ""), /text\/html/);
    const html = page._body().toString("utf8");
    assert.match(html, /Settld Pricing/);
    assert.match(html, /Free/);
    assert.match(html, /Builder/);
    assert.match(html, /Growth/);
    assert.match(html, /Enterprise/);
    assert.match(html, /VERIFIED_RUN/);
    assert.match(html, /SETTLED_VOLUME/);
    assert.match(html, /ARBITRATION_USAGE/);
    assert.match(html, /\$99\.00/);
    assert.match(html, /\$599\.00/);
    assert.match(html, /\$0\.007/);
  });

  await t.test("tenant create: default event relay auto-attaches and integrations URL is returned", async () => {
    const tenantId = "tenant_default_relay_create";
    const created = await createTenant({
      tenantId,
      name: "Default Relay Tenant",
      contactEmail: "ops@example.com",
      billingEmail: "billing@example.com"
    });
    assert.equal(created.tenantId, tenantId);
    assert.equal(created.onboardingUrl, `/v1/tenants/${tenantId}/onboarding`);
    assert.equal(created.runtimeBootstrapUrl, `/v1/tenants/${tenantId}/onboarding/runtime-bootstrap`);
    assert.equal(created.integrationsUrl, `/v1/tenants/${tenantId}/integrations`);
    assert.equal(created.settlementPoliciesUrl, `/v1/tenants/${tenantId}/settlement-policies`);
    assert.equal(created.metricsUrl, `/v1/tenants/${tenantId}/onboarding-metrics`);

    const settings = await loadTenantSettings({ dataDir, tenantId });
    const relay = Array.isArray(settings.webhooks)
      ? settings.webhooks.find((row) => row && typeof row === "object" && !Array.isArray(row) && row.url === process.env.MAGIC_LINK_DEFAULT_EVENT_RELAY_URL)
      : null;
    assert.ok(relay);
    assert.equal(relay.enabled, true);
    assert.deepEqual([...(relay.events ?? [])].sort(), ["decision.approved", "decision.held", "verification.completed", "verification.failed"]);
    assert.ok(typeof relay.secret === "string" && relay.secret.startsWith("enc:v1:"));
  });

  await t.test("tenant onboarding runtime bootstrap: returns MCP config and forwards bootstrap request", async () => {
    const tenantId = "tenant_runtime_bootstrap";
    await createTenant({
      tenantId,
      name: "Runtime Bootstrap Tenant",
      contactEmail: "ops+runtime@example.com",
      billingEmail: "billing+runtime@example.com"
    });

    const out = await postTenantRuntimeBootstrap({
      tenantId,
      headers: { "x-idempotency-key": "idem_runtime_bootstrap" },
      body: {
        apiKey: {
          keyId: "ak_runtime_test",
          scopes: ["runs:write", "runs:read", "inbox:read"]
        },
        paidToolsBaseUrl: "https://paid.tools.settld.work"
      }
    });
    assert.equal(out.statusCode, 201, JSON.stringify(out.json));
    assert.equal(out.json?.ok, true);
    assert.equal(out.json?.schemaVersion, "MagicLinkRuntimeBootstrap.v1");
    assert.equal(out.json?.tenantId, tenantId);
    assert.equal(out.json?.bootstrap?.apiKey?.keyId, "ak_runtime_test");
    assert.equal(out.json?.bootstrap?.apiKey?.token, "ak_runtime_test.secret_runtime");
    assert.equal(out.json?.mcp?.command, "npx");
    assert.deepEqual(out.json?.mcp?.args, ["-y", "settld-mcp"]);
    assert.equal(out.json?.mcp?.env?.SETTLD_TENANT_ID, tenantId);
    assert.equal(out.json?.mcp?.env?.SETTLD_API_KEY, "ak_runtime_test.secret_runtime");
    assert.equal(out.json?.mcp?.env?.SETTLD_BASE_URL, "https://api.mock.settld.work");
    assert.equal(out.json?.mcp?.env?.SETTLD_PAID_TOOLS_BASE_URL, "https://paid.tools.settld.work/");
    assert.equal(out.json?.mcpConfigJson?.mcpServers?.settld?.command, "npx");

    const reqRecord = settldOpsBootstrapRequests[settldOpsBootstrapRequests.length - 1];
    assert.ok(reqRecord);
    assert.equal(reqRecord.tenantId, tenantId);
    assert.equal(reqRecord.protocol, "1.0");
    assert.equal(reqRecord.opsToken, "ops_token_magic_link");
    assert.equal(reqRecord.idempotencyKey, "idem_runtime_bootstrap");
    assert.equal(reqRecord.body?.apiKey?.keyId, "ak_runtime_test");
    assert.equal(reqRecord.body?.paidToolsBaseUrl, undefined);

    const auditFp = path.join(dataDir, "audit", tenantId, `${monthKeyUtcNow()}.jsonl`);
    const auditRaw = await fs.readFile(auditFp, "utf8");
    assert.match(auditRaw, /TENANT_RUNTIME_BOOTSTRAP_ISSUED/);
  });

  await t.test("tenant onboarding wallet bootstrap: returns provider env and does not expose circle api key", async () => {
    const tenantId = "tenant_wallet_bootstrap";
    await createTenant({
      tenantId,
      name: "Wallet Bootstrap Tenant",
      contactEmail: "ops+wallet-bootstrap@example.com",
      billingEmail: "billing+wallet-bootstrap@example.com"
    });

    const out = await postTenantWalletBootstrap({
      tenantId,
      body: {
        provider: "circle",
        circle: {
          mode: "sandbox"
        }
      }
    });
    assert.equal(out.statusCode, 201, JSON.stringify(out.json));
    assert.equal(out.json?.ok, true);
    assert.equal(out.json?.schemaVersion, "MagicLinkWalletBootstrap.v1");
    assert.equal(out.json?.tenantId, tenantId);
    assert.equal(out.json?.walletBootstrap?.provider, "circle");
    assert.equal(out.json?.walletBootstrap?.mode, "sandbox");
    assert.equal(out.json?.walletBootstrap?.baseUrl, `http://127.0.0.1:${circlePort}`);
    assert.equal(out.json?.walletBootstrap?.blockchain, "BASE-SEPOLIA");
    assert.equal(out.json?.walletBootstrap?.wallets?.spend?.walletId, "wid_circle_spend_test");
    assert.equal(out.json?.walletBootstrap?.wallets?.escrow?.walletId, "wid_circle_escrow_test");
    assert.equal(out.json?.walletBootstrap?.tokenIdUsdc, "usdc_base_sepolia_token");
    assert.equal(out.json?.walletBootstrap?.faucetEnabled, true);
    assert.equal(out.json?.walletBootstrap?.env?.CIRCLE_BASE_URL, `http://127.0.0.1:${circlePort}`);
    assert.equal(out.json?.walletBootstrap?.env?.CIRCLE_TOKEN_ID_USDC, "usdc_base_sepolia_token");
    assert.equal(out.json?.walletBootstrap?.env?.CIRCLE_API_KEY, undefined);
    assert.equal(String(out.json?.walletBootstrap?.env?.CIRCLE_ENTITY_SECRET_HEX ?? "").length, 64);

    assert.ok(circleBootstrapRequests.some((row) => row.method === "GET" && row.pathname === "/v1/w3s/wallets"));

    const auditFp = path.join(dataDir, "audit", tenantId, `${monthKeyUtcNow()}.jsonl`);
    const auditRaw = await fs.readFile(auditFp, "utf8");
    assert.match(auditRaw, /TENANT_WALLET_BOOTSTRAP_ISSUED/);
  });

  await t.test("tenant onboarding wallet bootstrap: rejects unsupported provider", async () => {
    const tenantId = "tenant_wallet_bootstrap_bad_provider";
    await createTenant({
      tenantId,
      name: "Wallet Bootstrap Bad Provider Tenant",
      contactEmail: "ops+wallet-bootstrap-bad-provider@example.com",
      billingEmail: "billing+wallet-bootstrap-bad-provider@example.com"
    });

    const out = await postTenantWalletBootstrap({
      tenantId,
      body: {
        provider: "unknown-provider"
      }
    });
    assert.equal(out.statusCode, 400, JSON.stringify(out.json));
    assert.equal(out.json?.ok, false);
    assert.equal(out.json?.code, "UNSUPPORTED_WALLET_PROVIDER");
  });

  await t.test("tenant onboarding runtime bootstrap smoke-test: initialize + tools/list", async () => {
    const tenantId = "tenant_runtime_bootstrap_smoke";
    await createTenant({
      tenantId,
      name: "Runtime Bootstrap Smoke Tenant",
      contactEmail: "ops+runtime-smoke@example.com",
      billingEmail: "billing+runtime-smoke@example.com"
    });
    const bootstrapOut = await postTenantRuntimeBootstrap({
      tenantId,
      body: {
        apiKey: {
          keyId: "ak_runtime_smoke",
          scopes: ["runs:write", "runs:read"]
        }
      }
    });
    assert.equal(bootstrapOut.statusCode, 201, JSON.stringify(bootstrapOut.json));
    const env = bootstrapOut.json?.mcp?.env;
    assert.ok(env && typeof env === "object");

    const smoke = await postTenantRuntimeBootstrapSmokeTest({ tenantId, body: { env } });
    assert.equal(smoke.statusCode, 200, JSON.stringify(smoke.json));
    assert.equal(smoke.json?.ok, true);
    assert.equal(smoke.json?.schemaVersion, "MagicLinkRuntimeBootstrapSmokeTest.v1");
    assert.equal(smoke.json?.tenantId, tenantId);
    assert.equal(smoke.json?.smoke?.initialized, true);
    assert.equal(smoke.json?.smoke?.serverInfo?.name, "settld-mcp-spike");
    assert.ok(Number.isFinite(Number(smoke.json?.smoke?.toolsCount)));
    assert.ok(Number(smoke.json?.smoke?.toolsCount) > 0);
    assert.ok(Array.isArray(smoke.json?.smoke?.sampleTools));
  });

  await t.test("tenant onboarding first paid call: executes full paid flow and returns green/released statuses", async () => {
    const tenantId = "tenant_runtime_first_paid_call";
    await createTenant({
      tenantId,
      name: "Runtime First Paid Call Tenant",
      contactEmail: "ops+runtime-first-paid@example.com",
      billingEmail: "billing+runtime-first-paid@example.com"
    });

    const out = await postTenantFirstPaidCall({ tenantId });
    assert.equal(out.statusCode, 200, JSON.stringify(out.json));
    assert.equal(out.json?.ok, true);
    assert.equal(out.json?.schemaVersion, "MagicLinkFirstPaidCall.v1");
    assert.equal(out.json?.tenantId, tenantId);
    assert.match(String(out.json?.ids?.posterAgentId ?? ""), /^agt_ml_poster_/);
    assert.match(String(out.json?.ids?.bidderAgentId ?? ""), /^agt_ml_bidder_/);
    assert.match(String(out.json?.ids?.rfqId ?? ""), /^rfq_ml_/);
    assert.match(String(out.json?.ids?.bidId ?? ""), /^bid_ml_/);
    assert.match(String(out.json?.ids?.runId ?? ""), /^run_/);
    assert.ok(typeof out.json?.attemptId === "string" && out.json.attemptId.length > 0);
    assert.equal(out.json?.verificationStatus, "green");
    assert.equal(out.json?.settlementStatus, "released");

    const history = await getTenantFirstPaidCallHistory({ tenantId });
    assert.equal(history.statusCode, 200, JSON.stringify(history.json));
    assert.equal(history.json?.ok, true);
    assert.equal(history.json?.schemaVersion, "MagicLinkFirstPaidCallHistory.v1");
    assert.equal(history.json?.tenantId, tenantId);
    assert.ok(Array.isArray(history.json?.attempts));
    assert.ok(history.json.attempts.length >= 1);
    const latestAttempt = history.json.attempts[history.json.attempts.length - 1];
    assert.equal(latestAttempt?.attemptId, out.json?.attemptId);
    assert.equal(latestAttempt?.status, "passed");
    assert.equal(latestAttempt?.verificationStatus, "green");
    assert.equal(latestAttempt?.settlementStatus, "released");

    const replay = await postTenantFirstPaidCall({
      tenantId,
      body: { replayAttemptId: out.json?.attemptId }
    });
    assert.equal(replay.statusCode, 200, JSON.stringify(replay.json));
    assert.equal(replay.json?.ok, true);
    assert.equal(replay.json?.replayed, true);
    assert.equal(replay.json?.attemptId, out.json?.attemptId);
    assert.equal(replay.json?.verificationStatus, "green");
    assert.equal(replay.json?.settlementStatus, "released");

    const metricsRes = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding-metrics`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(metricsRes.statusCode, 200, metricsRes._body().toString("utf8"));
    const metrics = JSON.parse(metricsRes._body().toString("utf8"));
    assert.ok(typeof metrics?.firstUploadAt === "string" && metrics.firstUploadAt.length > 0);
    assert.ok(typeof metrics?.firstVerifiedAt === "string" && metrics.firstVerifiedAt.length > 0);
    const firstVerifiedStage = Array.isArray(metrics?.funnel?.stages)
      ? metrics.funnel.stages.find((row) => row?.stageKey === "first_verified")
      : null;
    assert.equal(Boolean(firstVerifiedStage?.reached), true);

    const runCompletedReq = [...settldOpsApiRequests].reverse().find((row) => row.pathname.includes("/events"));
    assert.ok(runCompletedReq, "expected run-completed event request");
    assert.ok(typeof runCompletedReq?.expectedPrevChainHash === "string" && runCompletedReq.expectedPrevChainHash.length > 0);

    const auditFp = path.join(dataDir, "audit", tenantId, `${monthKeyUtcNow()}.jsonl`);
    const auditRaw = await fs.readFile(auditFp, "utf8");
    assert.match(auditRaw, /TENANT_RUNTIME_FIRST_PAID_CALL_COMPLETED/);
  });

  await t.test("tenant runtime conformance matrix: bootstrap + smoke + first paid flow for runtime targets", async () => {
    const tenantId = "tenant_runtime_conformance";
    await createTenant({
      tenantId,
      name: "Runtime Conformance Tenant",
      contactEmail: "ops+runtime-conformance@example.com",
      billingEmail: "billing+runtime-conformance@example.com"
    });

    const out = await postTenantRuntimeConformanceMatrix({
      tenantId,
      body: { targets: ["codex", "claude", "cursor", "openclaw"] }
    });
    assert.equal(out.statusCode, 200, JSON.stringify(out.json));
    assert.equal(out.json?.ok, true);
    assert.equal(out.json?.matrix?.schemaVersion, "MagicLinkRuntimeConformanceMatrix.v1");
    assert.equal(out.json?.matrix?.tenantId, tenantId);
    assert.equal(out.json?.matrix?.ready, true);
    assert.ok(Array.isArray(out.json?.matrix?.checks));
    assert.ok(out.json.matrix.checks.some((row) => row?.checkId === "runtime_bootstrap" && row?.status === "pass"));
    assert.ok(out.json.matrix.checks.some((row) => row?.checkId === "mcp_smoke" && row?.status === "pass"));
    assert.ok(out.json.matrix.checks.some((row) => row?.checkId === "first_paid_call" && row?.status === "pass"));
    assert.ok(Array.isArray(out.json?.matrix?.targets));
    assert.ok(out.json.matrix.targets.length >= 3);
    const targetNames = out.json.matrix.targets.map((row) => row?.target).filter(Boolean);
    assert.ok(targetNames.includes("cursor"));
    assert.ok(targetNames.includes("openclaw"));
    assert.equal(out.json?.idempotency?.reused, false);

    const history = await getTenantFirstPaidCallHistory({ tenantId });
    assert.equal(history.statusCode, 200, JSON.stringify(history.json));
    assert.ok(Array.isArray(history.json?.attempts));
    assert.ok(history.json.attempts.some((row) => row?.attemptId === out.json?.matrix?.runId));

    const idem = await postTenantRuntimeConformanceMatrix({
      tenantId,
      headers: { "x-idempotency-key": "matrix_idem_1" },
      body: { targets: ["codex"] }
    });
    assert.equal(idem.statusCode, 200, JSON.stringify(idem.json));
    assert.equal(idem.json?.ok, true);
    assert.equal(idem.json?.idempotency?.reused, false);
    const idemRunId = idem.json?.matrix?.runId;
    assert.ok(typeof idemRunId === "string" && idemRunId.length > 0);

    const idemReplay = await postTenantRuntimeConformanceMatrix({
      tenantId,
      headers: { "x-idempotency-key": "matrix_idem_1" },
      body: { targets: ["codex"] }
    });
    assert.equal(idemReplay.statusCode, 200, JSON.stringify(idemReplay.json));
    assert.equal(idemReplay.json?.ok, true);
    assert.equal(idemReplay.json?.idempotency?.reused, true);
    assert.equal(idemReplay.json?.matrix?.runId, idemRunId);

    const auditFp = path.join(dataDir, "audit", tenantId, `${monthKeyUtcNow()}.jsonl`);
    const auditRaw = await fs.readFile(auditFp, "utf8");
    assert.match(auditRaw, /TENANT_RUNTIME_CONFORMANCE_MATRIX_RUN/);
  });

  await t.test("tenant runtime conformance matrix: rate limit guard returns 429 after limit", async () => {
    const tenantId = "tenant_runtime_conformance_rl";
    await createTenant({
      tenantId,
      name: "Runtime Conformance RL Tenant",
      contactEmail: "ops+runtime-conformance-rl@example.com",
      billingEmail: "billing+runtime-conformance-rl@example.com"
    });
    await putTenantSettings({
      tenantId,
      patch: { rateLimits: { conformanceRunsPerHour: 1 } }
    });

    const first = await postTenantRuntimeConformanceMatrix({
      tenantId,
      body: { targets: ["codex"] }
    });
    assert.equal(first.statusCode, 200, JSON.stringify(first.json));
    assert.equal(first.json?.ok, true);

    const second = await postTenantRuntimeConformanceMatrix({
      tenantId,
      body: { targets: ["codex"] }
    });
    assert.equal(second.statusCode, 429, JSON.stringify(second.json));
    assert.equal(second.json?.ok, false);
    assert.equal(second.json?.code, "RATE_LIMITED");
    assert.ok(Number(second.json?.retryAfterSeconds) > 0);
  });

  await t.test("tenant onboarding runtime bootstrap: propagates upstream failure", async () => {
    const tenantId = "tenant_runtime_bootstrap_fail";
    await createTenant({
      tenantId,
      name: "Runtime Bootstrap Failure Tenant",
      contactEmail: "ops+runtime-fail@example.com",
      billingEmail: "billing+runtime-fail@example.com"
    });

    settldOpsBootstrapState.nextErrorStatus = 502;
    settldOpsBootstrapState.nextErrorBody = {
      ok: false,
      code: "BOOTSTRAP_DOWN",
      message: "ops unavailable"
    };
    const out = await postTenantRuntimeBootstrap({ tenantId, body: {} });
    assert.equal(out.statusCode, 502, JSON.stringify(out.json));
    assert.equal(out.json?.ok, false);
    assert.equal(out.json?.code, "BOOTSTRAP_DOWN");
    assert.match(String(out.json?.message ?? ""), /ops unavailable/);
  });

  await t.test("integrations UI: connect/disconnect Slack + Zapier with test-send and delivery health", async () => {
    const tenantId = "tenant_integrations_ui";
    await createTenant({
      tenantId,
      name: "Integrations Tenant",
      contactEmail: "ops+integrations@example.com",
      billingEmail: "billing+integrations@example.com"
    });

    const page = await runReq({ method: "GET", url: `/v1/tenants/${tenantId}/integrations`, headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(page.statusCode, 200);
    assert.match(page._body().toString("utf8"), /Connect Slack/);
    assert.match(page._body().toString("utf8"), /Connect Zapier/);
    assert.match(page._body().toString("utf8"), /Plan & Limits/);
    assert.match(page._body().toString("utf8"), /upgradeHintApi/);
    assert.doesNotMatch(page._body().toString("utf8"), /alert\(/);
    assert.match(page._body().toString("utf8"), /Webhook Retry Queue/);

    const stateInitialRes = await runReq({ method: "GET", url: `/v1/tenants/${tenantId}/integrations/state`, headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(stateInitialRes.statusCode, 200, stateInitialRes._body().toString("utf8"));
    const stateInitial = JSON.parse(stateInitialRes._body().toString("utf8"));
    assert.equal(stateInitial.ok, true);
    assert.equal(stateInitial.integrations?.defaultRelay?.connected, true);
    assert.equal(stateInitial.integrations?.slack?.connected, false);
    assert.equal(stateInitial.integrations?.zapier?.connected, false);
    assert.equal(stateInitial.quota?.maxIntegrations?.limit, 5);
    assert.equal(stateInitial.quota?.maxIntegrations?.used, 0);
    assert.equal(stateInitial.quota?.maxIntegrations?.remaining, 5);
    assert.ok(typeof stateInitial.retryQueue === "object" && stateInitial.retryQueue !== null);
    assert.equal(Number(stateInitial.retryQueue.pendingCount ?? 0), 0);

    const slackUrl = "https://hooks.slack.com/services/T00000000/B00000000/SLACKTOKEN";
    const connectSlackBody = Buffer.from(JSON.stringify({ webhookUrl: slackUrl }), "utf8");
    const connectSlack = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/integrations/slack/connect`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(connectSlackBody.length) },
      bodyChunks: [connectSlackBody]
    });
    assert.equal(connectSlack.statusCode, 200, connectSlack._body().toString("utf8"));
    const connectSlackJson = JSON.parse(connectSlack._body().toString("utf8"));
    assert.equal(connectSlackJson.ok, true);
    assert.equal(connectSlackJson.integration?.connected, true);
    assert.equal(connectSlackJson.integration?.webhookUrl, slackUrl);

    const beforeTestFiles = await listFilesRecursive(path.join(dataDir, "webhooks", "record")).catch(() => []);
    const testSlackBody = Buffer.from(JSON.stringify({ event: "verification.completed" }), "utf8");
    const testSlack = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/integrations/slack/test-send`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(testSlackBody.length) },
      bodyChunks: [testSlackBody]
    });
    assert.equal(testSlack.statusCode, 200, testSlack._body().toString("utf8"));
    const testSlackJson = JSON.parse(testSlack._body().toString("utf8"));
    assert.equal(testSlackJson.ok, true);
    assert.equal(testSlackJson.delivery?.ok, true);

    const afterTestFiles = await listFilesRecursive(path.join(dataDir, "webhooks", "record")).catch(() => []);
    const newFiles = afterTestFiles.filter((fp) => !beforeTestFiles.includes(fp));
    assert.ok(newFiles.length >= 1);
    const newRows = await Promise.all(newFiles.map(async (fp) => JSON.parse(await fs.readFile(fp, "utf8"))));
    const slackDelivery = newRows.find((row) => row?.tenantId === tenantId && row?.url === slackUrl && row?.event === "verification.completed");
    assert.ok(slackDelivery);
    assert.equal(slackDelivery.headers?.["x-settld-event"], "verification.completed");

    const stateAfterSlackRes = await runReq({ method: "GET", url: `/v1/tenants/${tenantId}/integrations/state`, headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(stateAfterSlackRes.statusCode, 200);
    const stateAfterSlack = JSON.parse(stateAfterSlackRes._body().toString("utf8"));
    assert.equal(stateAfterSlack.integrations?.slack?.connected, true);
    assert.ok(Number(stateAfterSlack.integrations?.slack?.deliveryHealth?.attempts24h ?? 0) >= 1);
    assert.ok(Number(stateAfterSlack.integrations?.slack?.deliveryHealth?.successes24h ?? 0) >= 1);

    const zapierUrl = "https://hooks.zapier.com/hooks/catch/123456/abcdef/";
    const connectZapierBody = Buffer.from(JSON.stringify({ webhookUrl: zapierUrl }), "utf8");
    const connectZapier = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/integrations/zapier/connect`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(connectZapierBody.length) },
      bodyChunks: [connectZapierBody]
    });
    assert.equal(connectZapier.statusCode, 200, connectZapier._body().toString("utf8"));
    const connectZapierJson = JSON.parse(connectZapier._body().toString("utf8"));
    assert.equal(connectZapierJson.integration?.connected, true);
    assert.equal(connectZapierJson.integration?.webhookUrl, zapierUrl);

    const stateAfterBothRes = await runReq({ method: "GET", url: `/v1/tenants/${tenantId}/integrations/state`, headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(stateAfterBothRes.statusCode, 200);
    const stateAfterBoth = JSON.parse(stateAfterBothRes._body().toString("utf8"));
    assert.equal(stateAfterBoth.quota?.maxIntegrations?.used, 2);
    assert.equal(stateAfterBoth.quota?.maxIntegrations?.remaining, 3);
    assert.equal(stateAfterBoth.quota?.maxIntegrations?.atLimit, false);
    assert.equal(stateAfterBoth.quota?.maxIntegrations?.canCreate, true);

    const disconnectSlack = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/integrations/slack/disconnect`,
      headers: { "x-api-key": "test_key", "content-type": "application/json" },
      bodyChunks: [Buffer.from("{}", "utf8")]
    });
    assert.equal(disconnectSlack.statusCode, 200, disconnectSlack._body().toString("utf8"));
    const disconnectSlackJson = JSON.parse(disconnectSlack._body().toString("utf8"));
    assert.equal(disconnectSlackJson.integration?.connected, false);

    const stateFinalRes = await runReq({ method: "GET", url: `/v1/tenants/${tenantId}/integrations/state`, headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(stateFinalRes.statusCode, 200);
    const stateFinal = JSON.parse(stateFinalRes._body().toString("utf8"));
    assert.equal(stateFinal.integrations?.slack?.connected, false);
    assert.equal(stateFinal.integrations?.zapier?.connected, true);
    assert.equal(stateFinal.quota?.maxIntegrations?.used, 1);
    assert.equal(stateFinal.quota?.maxIntegrations?.remaining, 4);
    assert.equal(stateFinal.quota?.maxIntegrations?.atLimit, false);
    assert.equal(stateFinal.quota?.maxIntegrations?.canCreate, true);
  });

  await t.test("integrations: maxIntegrations entitlement gate returns upgrade hint", async () => {
    const tenantId = "tenant_integrations_limit";
    await createTenant({
      tenantId,
      name: "Integration Limit Tenant",
      contactEmail: "ops+int-limit@example.com",
      billingEmail: "billing+int-limit@example.com"
    });

    await putTenantSettings({
      tenantId,
      patch: {
        webhooks: [
          { url: "https://example.invalid/integration-a", events: ["verification.completed"], enabled: true, secret: "whsec_a" },
          { url: "https://example.invalid/integration-b", events: ["verification.completed"], enabled: true, secret: "whsec_b" },
          { url: "https://example.invalid/integration-c", events: ["verification.completed"], enabled: true, secret: "whsec_c" },
          { url: "https://example.invalid/integration-d", events: ["verification.completed"], enabled: true, secret: "whsec_d" },
          { url: "https://example.invalid/integration-e", events: ["verification.completed"], enabled: true, secret: "whsec_e" }
        ]
      }
    });

    const stateRes = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/state`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(stateRes.statusCode, 200, stateRes._body().toString("utf8"));
    const state = JSON.parse(stateRes._body().toString("utf8"));
    assert.equal(state.quota?.maxIntegrations?.limit, 5);
    assert.equal(state.quota?.maxIntegrations?.used, 5);
    assert.equal(state.quota?.maxIntegrations?.atLimit, true);

    const connectSlackBody = Buffer.from(
      JSON.stringify({ webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/LIMITTOKEN" }),
      "utf8"
    );
    const blocked = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/integrations/slack/connect`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(connectSlackBody.length) },
      bodyChunks: [connectSlackBody]
    });
    assert.equal(blocked.statusCode, 403, blocked._body().toString("utf8"));
    const blockedJson = JSON.parse(blocked._body().toString("utf8"));
    assert.equal(blockedJson.ok, false);
    assert.equal(blockedJson.code, "ENTITLEMENT_LIMIT_EXCEEDED");
    assert.equal(blockedJson.detail?.feature, "maxIntegrations");
    assert.equal(blockedJson.detail?.limit, 5);
    assert.equal(blockedJson.detail?.used, 5);
    assert.ok(Array.isArray(blockedJson.upgradeHint?.suggestedPlans));
    assert.ok(blockedJson.upgradeHint.suggestedPlans.includes("builder"));
  });

  await t.test("tenant settings PUT: cannot bypass maxIntegrations by writing oversized webhook list", async () => {
    const tenantId = "tenant_settings_integrations_limit";
    await createTenant({
      tenantId,
      name: "Settings Integration Limit Tenant",
      contactEmail: "ops+settings-int-limit@example.com",
      billingEmail: "billing+settings-int-limit@example.com"
    });

    await putTenantSettings({
      tenantId,
      patch: {
        webhooks: [
          { url: "https://example.invalid/settings-integration-a", events: ["verification.completed"], enabled: true, secret: "whsec_a" },
          { url: "https://example.invalid/settings-integration-b", events: ["verification.completed"], enabled: true, secret: "whsec_b" },
          { url: "https://example.invalid/settings-integration-c", events: ["verification.completed"], enabled: true, secret: "whsec_c" },
          { url: "https://example.invalid/settings-integration-d", events: ["verification.completed"], enabled: true, secret: "whsec_d" },
          { url: "https://example.invalid/settings-integration-e", events: ["verification.completed"], enabled: true, secret: "whsec_e" }
        ]
      }
    });

    const blockedPatch = {
      webhooks: [
        { url: "https://example.invalid/settings-integration-a", events: ["verification.completed"], enabled: true, secret: "whsec_a" },
        { url: "https://example.invalid/settings-integration-b", events: ["verification.completed"], enabled: true, secret: "whsec_b" },
        { url: "https://example.invalid/settings-integration-c", events: ["verification.completed"], enabled: true, secret: "whsec_c" },
        { url: "https://example.invalid/settings-integration-d", events: ["verification.completed"], enabled: true, secret: "whsec_d" },
        { url: "https://example.invalid/settings-integration-e", events: ["verification.completed"], enabled: true, secret: "whsec_e" },
        { url: "https://example.invalid/settings-integration-f", events: ["verification.completed"], enabled: true, secret: "whsec_f" }
      ]
    };
    const blockedBody = Buffer.from(JSON.stringify(blockedPatch), "utf8");
    const blocked = await runReq({
      method: "PUT",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/settings`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(blockedBody.length) },
      bodyChunks: [blockedBody]
    });
    assert.equal(blocked.statusCode, 403, blocked._body().toString("utf8"));
    const blockedJson = JSON.parse(blocked._body().toString("utf8"));
    assert.equal(blockedJson.ok, false);
    assert.equal(blockedJson.code, "ENTITLEMENT_LIMIT_EXCEEDED");
    assert.equal(blockedJson.detail?.feature, "maxIntegrations");
    assert.equal(blockedJson.detail?.limit, 5);
    assert.equal(blockedJson.detail?.used, 6);
    assert.ok(Array.isArray(blockedJson.upgradeHint?.suggestedPlans));
    assert.ok(blockedJson.upgradeHint.suggestedPlans.includes("builder"));

    const unchanged = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/state`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(unchanged.statusCode, 200, unchanged._body().toString("utf8"));
    const unchangedJson = JSON.parse(unchanged._body().toString("utf8"));
    assert.equal(unchangedJson.quota?.maxIntegrations?.used, 5);
    assert.equal(unchangedJson.quota?.maxIntegrations?.remaining, 0);
  });

  await t.test("settlement policy control plane: page, registry upsert/default, replay", async () => {
    const tenantId = "tenant_settlement_policy_ui";
    await createTenant({
      tenantId,
      name: "Settlement Policy Tenant",
      contactEmail: "ops+policy@example.com",
      billingEmail: "billing+policy@example.com"
    });

    const page = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/settlement-policies`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(page.statusCode, 200, page._body().toString("utf8"));
    assert.match(page._body().toString("utf8"), /Settlement Policy Control Plane/);
    assert.match(page._body().toString("utf8"), /Plan & Limits/);
    assert.match(page._body().toString("utf8"), /policyUpgradeHint/);
    assert.match(page._body().toString("utf8"), /Rollout Stages/);
    assert.match(page._body().toString("utf8"), /Preset Packs/);
    assert.match(page._body().toString("utf8"), /Policy Diff/);

    const stateEmpty = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/settlement-policies/state`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(stateEmpty.statusCode, 200, stateEmpty._body().toString("utf8"));
    const stateEmptyJson = JSON.parse(stateEmpty._body().toString("utf8"));
    assert.equal(stateEmptyJson.ok, true);
    assert.equal(Array.isArray(stateEmptyJson.policies), true);
    assert.equal(stateEmptyJson.policies.length, 0);
    assert.equal(stateEmptyJson.quota?.maxPolicyVersions?.limit, 10);
    assert.equal(stateEmptyJson.quota?.maxPolicyVersions?.used, 0);
    assert.equal(stateEmptyJson.rollout?.stages?.active, null);
    assert.equal(stateEmptyJson.rollout?.stages?.draft, null);
    assert.equal(stateEmptyJson.rollout?.stages?.canary?.policyRef, null);

    const upsertPayload = {
      policyId: "market.default.auto-v1",
      setAsDefault: true,
      description: "default deterministic policy",
      verificationMethod: {
        mode: "deterministic"
      },
      policy: {
        mode: "automatic",
        rules: {
          requireDeterministicVerification: true,
          autoReleaseOnGreen: true,
          autoReleaseOnAmber: false,
          autoReleaseOnRed: false,
          greenReleaseRatePct: 100,
          amberReleaseRatePct: 0,
          redReleaseRatePct: 0
        }
      }
    };
    const upsertBody = Buffer.from(JSON.stringify(upsertPayload), "utf8");
    const upsert = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/upsert`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(upsertBody.length) },
      bodyChunks: [upsertBody]
    });
    assert.equal(upsert.statusCode, 201, upsert._body().toString("utf8"));
    const upsertJson = JSON.parse(upsert._body().toString("utf8"));
    assert.equal(upsertJson.ok, true);
    assert.equal(upsertJson.policy?.policyId, "market.default.auto-v1");
    assert.equal(upsertJson.policy?.policyVersion, 1);
    assert.equal(upsertJson.policy?.policy?.rules?.requireDeterministicVerification, true);
    assert.equal(upsertJson.defaultPolicyRef?.policyId, "market.default.auto-v1");
    assert.equal(upsertJson.defaultPolicyRef?.policyVersion, 1);

    const replayBody = Buffer.from(
      JSON.stringify({
        policyId: "market.default.auto-v1",
        policyVersion: 1,
        amountCents: 2500,
        verificationStatus: "green",
        runStatus: "completed"
      }),
      "utf8"
    );
    const replay = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/test-replay`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(replayBody.length) },
      bodyChunks: [replayBody]
    });
    assert.equal(replay.statusCode, 200, replay._body().toString("utf8"));
    const replayJson = JSON.parse(replay._body().toString("utf8"));
    assert.equal(replayJson.ok, true);
    assert.equal(replayJson.replay?.shouldAutoResolve, true);
    assert.equal(replayJson.replay?.releaseAmountCents, 2500);
    assert.equal(replayJson.replay?.refundAmountCents, 0);

    const setDefaultBody = Buffer.from(JSON.stringify({ policyId: "market.default.auto-v1", policyVersion: 1 }), "utf8");
    const setDefault = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/default`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(setDefaultBody.length) },
      bodyChunks: [setDefaultBody]
    });
    assert.equal(setDefault.statusCode, 200, setDefault._body().toString("utf8"));
    const setDefaultJson = JSON.parse(setDefault._body().toString("utf8"));
    assert.equal(setDefaultJson.ok, true);
    assert.equal(setDefaultJson.defaultPolicyRef?.policyId, "market.default.auto-v1");
    assert.equal(setDefaultJson.defaultPolicyRef?.policyVersion, 1);

    const upsertSameBody = Buffer.from(JSON.stringify({ ...upsertPayload, policyVersion: 1 }), "utf8");
    const upsertSame = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/upsert`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(upsertSameBody.length) },
      bodyChunks: [upsertSameBody]
    });
    assert.equal(upsertSame.statusCode, 200, upsertSame._body().toString("utf8"));

    const conflictBody = Buffer.from(
      JSON.stringify({
        ...upsertPayload,
        policyVersion: 1,
        policy: {
          ...upsertPayload.policy,
          rules: {
            ...upsertPayload.policy.rules,
            autoReleaseOnAmber: true
          }
        }
      }),
      "utf8"
    );
    const conflict = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/upsert`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(conflictBody.length) },
      bodyChunks: [conflictBody]
    });
    assert.equal(conflict.statusCode, 409, conflict._body().toString("utf8"));
    const conflictJson = JSON.parse(conflict._body().toString("utf8"));
    assert.equal(conflictJson.ok, false);
    assert.equal(conflictJson.code, "POLICY_VERSION_CONFLICT");

    const v2Body = Buffer.from(
      JSON.stringify({
        ...upsertPayload,
        policyVersion: 2,
        setAsDefault: false,
        policy: {
          ...upsertPayload.policy,
          rules: {
            ...upsertPayload.policy.rules,
            autoReleaseOnAmber: true,
            amberReleaseRatePct: 25
          }
        }
      }),
      "utf8"
    );
    const v2 = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/upsert`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(v2Body.length) },
      bodyChunks: [v2Body]
    });
    assert.equal(v2.statusCode, 201, v2._body().toString("utf8"));
    const v2Json = JSON.parse(v2._body().toString("utf8"));
    assert.equal(v2Json.ok, true);
    assert.equal(v2Json.policy?.policyVersion, 2);
    assert.equal(v2Json.defaultPolicyRef?.policyVersion, 1);

    const canaryBody = Buffer.from(
      JSON.stringify({
        stage: "canary",
        policyId: "market.default.auto-v1",
        policyVersion: 2,
        rolloutPercent: 20
      }),
      "utf8"
    );
    const canary = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/rollout`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(canaryBody.length) },
      bodyChunks: [canaryBody]
    });
    assert.equal(canary.statusCode, 200, canary._body().toString("utf8"));
    const canaryJson = JSON.parse(canary._body().toString("utf8"));
    assert.equal(canaryJson.ok, true);
    assert.equal(canaryJson.rollout?.stages?.canary?.policyRef?.policyVersion, 2);
    assert.equal(canaryJson.rollout?.stages?.canary?.rolloutPercent, 20);

    const promoteBody = Buffer.from(
      JSON.stringify({
        stage: "active",
        policyId: "market.default.auto-v1",
        policyVersion: 2,
        note: "promote v2"
      }),
      "utf8"
    );
    const promote = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/rollout`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(promoteBody.length) },
      bodyChunks: [promoteBody]
    });
    assert.equal(promote.statusCode, 200, promote._body().toString("utf8"));
    const promoteJson = JSON.parse(promote._body().toString("utf8"));
    assert.equal(promoteJson.ok, true);
    assert.equal(promoteJson.defaultPolicyRef?.policyVersion, 2);
    assert.equal(promoteJson.rollout?.stages?.active?.policyVersion, 2);

    const rollbackBody = Buffer.from(JSON.stringify({ note: "rollback to previous" }), "utf8");
    const rollback = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/rollback`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(rollbackBody.length) },
      bodyChunks: [rollbackBody]
    });
    assert.equal(rollback.statusCode, 200, rollback._body().toString("utf8"));
    const rollbackJson = JSON.parse(rollback._body().toString("utf8"));
    assert.equal(rollbackJson.ok, true);
    assert.equal(rollbackJson.rollbackTargetRef?.policyVersion, 1);
    assert.equal(rollbackJson.defaultPolicyRef?.policyVersion, 1);
    assert.equal(rollbackJson.rollout?.stages?.active?.policyVersion, 1);

    const diff = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/settlement-policies/diff?fromPolicyId=market.default.auto-v1&fromPolicyVersion=1&toPolicyId=market.default.auto-v1&toPolicyVersion=2`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(diff.statusCode, 200, diff._body().toString("utf8"));
    const diffJson = JSON.parse(diff._body().toString("utf8"));
    assert.equal(diffJson.ok, true);
    assert.equal(diffJson.fromPolicyRef?.policyVersion, 1);
    assert.equal(diffJson.toPolicyRef?.policyVersion, 2);
    assert.equal(Array.isArray(diffJson.changes), true);
    assert.ok(diffJson.changes.some((row) => row.path === "policy.rules.autoReleaseOnAmber"));
  });

  await t.test("settlement policy preset packs: list + apply + rollback", async () => {
    const tenantId = "tenant_policy_presets";
    await createTenant({
      tenantId,
      name: "Policy Preset Tenant",
      contactEmail: "ops+policy-presets@example.com",
      billingEmail: "billing+policy-presets@example.com"
    });

    const presetsRes = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/settlement-policies/presets`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(presetsRes.statusCode, 200, presetsRes._body().toString("utf8"));
    const presetsJson = JSON.parse(presetsRes._body().toString("utf8"));
    assert.equal(presetsJson.ok, true);
    assert.equal(presetsJson.schemaVersion, "TenantSettlementPolicyPresetCatalog.v1");
    assert.ok(Array.isArray(presetsJson.presets));
    assert.ok(presetsJson.presets.length >= 3);
    assert.ok(presetsJson.presets.some((row) => row?.presetId === "balanced_guardrails_v1"));

    const applyBalancedBody = Buffer.from(
      JSON.stringify({
        presetId: "balanced_guardrails_v1",
        setAsDefault: true
      }),
      "utf8"
    );
    const applyBalanced = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/presets/apply`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(applyBalancedBody.length) },
      bodyChunks: [applyBalancedBody]
    });
    assert.equal(applyBalanced.statusCode, 201, applyBalanced._body().toString("utf8"));
    const applyBalancedJson = JSON.parse(applyBalanced._body().toString("utf8"));
    assert.equal(applyBalancedJson.ok, true);
    assert.equal(applyBalancedJson.preset?.presetId, "balanced_guardrails_v1");
    assert.equal(applyBalancedJson.policy?.metadata?.presetId, "balanced_guardrails_v1");
    assert.equal(applyBalancedJson.policy?.policy?.rules?.maxAutoReleaseAmountCents, 150000);
    assert.equal(applyBalancedJson.policy?.policy?.rules?.disputeWindowHours, 72);
    assert.equal(applyBalancedJson.defaultPolicyRef?.policyId, "market.preset.balanced-v1");
    assert.equal(applyBalancedJson.defaultPolicyRef?.policyVersion, 1);

    const applyManualBody = Buffer.from(
      JSON.stringify({
        presetId: "manual_review_high_risk_v1",
        setAsDefault: true
      }),
      "utf8"
    );
    const applyManual = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/presets/apply`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(applyManualBody.length) },
      bodyChunks: [applyManualBody]
    });
    assert.equal(applyManual.statusCode, 201, applyManual._body().toString("utf8"));
    const applyManualJson = JSON.parse(applyManual._body().toString("utf8"));
    assert.equal(applyManualJson.ok, true);
    assert.equal(applyManualJson.preset?.presetId, "manual_review_high_risk_v1");
    assert.equal(applyManualJson.policy?.metadata?.presetId, "manual_review_high_risk_v1");
    assert.equal(applyManualJson.policy?.policy?.mode, "manual-review");
    assert.equal(applyManualJson.policy?.policy?.rules?.disputeWindowHours, 168);
    assert.equal(applyManualJson.defaultPolicyRef?.policyId, "market.preset.manual-review-v1");
    assert.equal(applyManualJson.defaultPolicyRef?.policyVersion, 1);

    const rollbackBody = Buffer.from(JSON.stringify({ note: "rollback after preset apply" }), "utf8");
    const rollback = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/settlement-policies/rollback`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(rollbackBody.length) },
      bodyChunks: [rollbackBody]
    });
    assert.equal(rollback.statusCode, 200, rollback._body().toString("utf8"));
    const rollbackJson = JSON.parse(rollback._body().toString("utf8"));
    assert.equal(rollbackJson.ok, true);
    assert.equal(rollbackJson.rollbackTargetRef?.policyId, "market.preset.balanced-v1");
    assert.equal(rollbackJson.rollbackTargetRef?.policyVersion, 1);
    assert.equal(rollbackJson.defaultPolicyRef?.policyId, "market.preset.balanced-v1");
    assert.equal(rollbackJson.defaultPolicyRef?.policyVersion, 1);
  });

  await t.test("settlement policy control plane: maxPolicyVersions entitlement gate returns upgrade hint", async () => {
    const tenantId = "tenant_policy_limit";
    await createTenant({
      tenantId,
      name: "Policy Limit Tenant",
      contactEmail: "ops+policy-limit@example.com",
      billingEmail: "billing+policy-limit@example.com"
    });

    async function upsertVersion(policyVersion) {
      const body = Buffer.from(
        JSON.stringify({
          policyId: "market.policy.limit-v1",
          policyVersion,
          verificationMethod: { mode: "deterministic" },
          policy: {
            mode: "automatic",
            rules: {
              requireDeterministicVerification: true,
              autoReleaseOnGreen: true,
              autoReleaseOnAmber: false,
              autoReleaseOnRed: false,
              greenReleaseRatePct: 100,
              amberReleaseRatePct: 0,
              redReleaseRatePct: 0
            }
          }
        }),
        "utf8"
      );
      return await runReq({
        method: "POST",
        url: `/v1/tenants/${tenantId}/settlement-policies/upsert`,
        headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(body.length) },
        bodyChunks: [body]
      });
    }

    for (let version = 1; version <= 10; version += 1) {
      const saved = await upsertVersion(version);
      assert.equal(saved.statusCode, 201, saved._body().toString("utf8"));
    }

    const stateAtLimit = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/settlement-policies/state`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(stateAtLimit.statusCode, 200, stateAtLimit._body().toString("utf8"));
    const stateAtLimitJson = JSON.parse(stateAtLimit._body().toString("utf8"));
    assert.equal(stateAtLimitJson.quota?.maxPolicyVersions?.limit, 10);
    assert.equal(stateAtLimitJson.quota?.maxPolicyVersions?.used, 10);
    assert.equal(stateAtLimitJson.quota?.maxPolicyVersions?.atLimit, true);

    const blocked = await upsertVersion(11);
    assert.equal(blocked.statusCode, 403, blocked._body().toString("utf8"));
    const blockedJson = JSON.parse(blocked._body().toString("utf8"));
    assert.equal(blockedJson.ok, false);
    assert.equal(blockedJson.code, "ENTITLEMENT_LIMIT_EXCEEDED");
    assert.equal(blockedJson.detail?.feature, "maxPolicyVersions");
    assert.equal(blockedJson.detail?.limit, 10);
    assert.equal(blockedJson.detail?.used, 10);
    assert.ok(Array.isArray(blockedJson.upgradeHint?.suggestedPlans));
    assert.ok(blockedJson.upgradeHint.suggestedPlans.includes("growth"));
  });

  await t.test("integrations OAuth: click-connect Slack + Zapier without manual webhook paste", async () => {
    const tenantId = "tenant_integrations_oauth";
    await createTenant({
      tenantId,
      name: "OAuth Integrations Tenant",
      contactEmail: "ops+oauth@example.com",
      billingEmail: "billing+oauth@example.com"
    });

    const slackStart = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/slack/oauth/start`,
      headers: { "x-api-key": "test_key", host: "app.localhost" },
      bodyChunks: []
    });
    assert.equal(slackStart.statusCode, 302, slackStart._body().toString("utf8"));
    const slackAuthUrl = new URL(String(slackStart.getHeader("location") ?? ""));
    assert.equal(slackAuthUrl.origin, oauthMockBaseUrl);
    assert.equal(slackAuthUrl.pathname, "/slack/authorize");
    const slackState = String(slackAuthUrl.searchParams.get("state") ?? "");
    assert.ok(slackState.length >= 16);
    assert.equal(slackAuthUrl.searchParams.get("client_id"), "slack_client_id");
    assert.equal(slackAuthUrl.searchParams.get("scope"), "incoming-webhook");
    assert.equal(slackAuthUrl.searchParams.get("redirect_uri"), "http://app.localhost/v1/integrations/slack/oauth/callback");

    const slackCallback = await runReq({
      method: "GET",
      url: `/v1/integrations/slack/oauth/callback?state=${encodeURIComponent(slackState)}&code=slack_code_ok`,
      headers: {},
      bodyChunks: []
    });
    assert.equal(slackCallback.statusCode, 303, slackCallback._body().toString("utf8"));
    assert.match(String(slackCallback.getHeader("location") ?? ""), new RegExp(`/v1/tenants/${tenantId}/integrations\\?`));
    assert.match(String(slackCallback.getHeader("location") ?? ""), /oauth=success/);

    const stateAfterSlackRes = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/state`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(stateAfterSlackRes.statusCode, 200, stateAfterSlackRes._body().toString("utf8"));
    const stateAfterSlack = JSON.parse(stateAfterSlackRes._body().toString("utf8"));
    assert.equal(stateAfterSlack.integrations?.slack?.connected, true);
    assert.equal(stateAfterSlack.integrations?.slack?.webhookUrl, "https://hooks.slack.com/services/TMOCK/BMOCK/SLACKTOKEN");
    assert.equal(stateAfterSlack.oauth?.slack?.enabled, true);

    const zapierStart = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/zapier/oauth/start`,
      headers: { "x-api-key": "test_key", host: "app.localhost" },
      bodyChunks: []
    });
    assert.equal(zapierStart.statusCode, 302, zapierStart._body().toString("utf8"));
    const zapierAuthUrl = new URL(String(zapierStart.getHeader("location") ?? ""));
    assert.equal(zapierAuthUrl.origin, oauthMockBaseUrl);
    assert.equal(zapierAuthUrl.pathname, "/zapier/authorize");
    const zapierState = String(zapierAuthUrl.searchParams.get("state") ?? "");
    assert.ok(zapierState.length >= 16);
    assert.equal(zapierAuthUrl.searchParams.get("client_id"), "zapier_client_id");
    assert.equal(zapierAuthUrl.searchParams.get("redirect_uri"), "http://app.localhost/v1/integrations/zapier/oauth/callback");

    const zapierCallback = await runReq({
      method: "GET",
      url: `/v1/integrations/zapier/oauth/callback?state=${encodeURIComponent(zapierState)}&code=zapier_code_ok`,
      headers: {},
      bodyChunks: []
    });
    assert.equal(zapierCallback.statusCode, 303, zapierCallback._body().toString("utf8"));
    assert.match(String(zapierCallback.getHeader("location") ?? ""), /oauth=success/);

    const stateAfterZapierRes = await runReq({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/state`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(stateAfterZapierRes.statusCode, 200, stateAfterZapierRes._body().toString("utf8"));
    const stateAfterZapier = JSON.parse(stateAfterZapierRes._body().toString("utf8"));
    assert.equal(stateAfterZapier.integrations?.zapier?.connected, true);
    assert.equal(stateAfterZapier.integrations?.zapier?.webhookUrl, "https://hooks.zapier.com/hooks/catch/123456/abcdef/");
    assert.equal(stateAfterZapier.oauth?.zapier?.enabled, true);
  });

  await t.test("onboarding: demo trust + sample upload", async () => {
    const page = await runReq({ method: "GET", url: "/v1/tenants/tenant_a/onboarding", headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(page.statusCode, 200);
    const pageBody = page._body().toString("utf8");
    assert.match(pageBody, /Verify Cloud Onboarding/);
    assert.match(pageBody, /Step 5\. First settlement checklist/);
    assert.match(pageBody, /Step 6\. Runtime bootstrap \(MCP\)/);
    assert.match(pageBody, /Step 7\. First live paid call/);
    assert.match(pageBody, /id="checklistSummary"/);
    assert.match(pageBody, /id="firstSettlementChecklist"/);
    assert.match(pageBody, /id="refreshChecklistBtn"/);
    assert.match(pageBody, /id="runtimeBootstrapBtn"/);
    assert.match(pageBody, /id="runtimeSmokeBtn"/);
    assert.match(pageBody, /id="runtimeMcpConfig"/);
    assert.match(pageBody, /id="runtimeEnvExports"/);
    assert.match(pageBody, /id="firstPaidCallBtn"/);
    assert.match(pageBody, /id="firstPaidCallHistoryBtn"/);
    assert.match(pageBody, /id="firstPaidCallReplayBtn"/);
    assert.match(pageBody, /id="firstPaidCallHistorySelect"/);
    assert.match(pageBody, /id="firstPaidCallStatus"/);
    assert.match(pageBody, /id="firstPaidCallOutput"/);
    assert.match(pageBody, /id="runtimeConformanceBtn"/);
    assert.match(pageBody, /id="runtimeConformanceStatus"/);
    assert.match(pageBody, /id="runtimeConformanceOutput"/);

    const templates = await runReq({ method: "GET", url: "/v1/tenants/tenant_a/sla-templates", headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(templates.statusCode, 200, templates._body().toString("utf8"));
    const templatesJson = JSON.parse(templates._body().toString("utf8"));
    assert.equal(templatesJson.ok, true);
    assert.equal(templatesJson.schemaVersion, "MagicLinkSlaTemplateCatalog.v1");
    assert.ok(Array.isArray(templatesJson.templates));
    assert.ok(templatesJson.templates.length >= 1);

    const renderBody = Buffer.from(
      JSON.stringify({ templateId: "delivery_standard_v1", overrides: { metrics: { targetCompletionMinutes: 45 } } }),
      "utf8"
    );
    const rendered = await runReq({
      method: "POST",
      url: "/v1/tenants/tenant_a/sla-templates/render",
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(renderBody.length) },
      bodyChunks: [renderBody]
    });
    assert.equal(rendered.statusCode, 200, rendered._body().toString("utf8"));
    const renderedJson = JSON.parse(rendered._body().toString("utf8"));
    assert.equal(renderedJson.ok, true);
    assert.equal(renderedJson.template?.templateId, "delivery_standard_v1");

    const enable = await runReq({
      method: "POST",
      url: "/v1/tenants/tenant_a/onboarding/demo-trust",
      headers: { "x-api-key": "test_key", "content-type": "application/json" },
      bodyChunks: [Buffer.from("{}", "utf8")]
    });
    assert.equal(enable.statusCode, 200, enable._body().toString("utf8"));
    const enableJson = JSON.parse(enable._body().toString("utf8"));
    assert.equal(enableJson.ok, true);

    const up = await runReq({
      method: "POST",
      url: "/v1/tenants/tenant_a/samples/closepack/known-good/upload",
      headers: { "x-api-key": "test_key", "content-type": "application/json" },
      bodyChunks: [
        Buffer.from(
          JSON.stringify({
            mode: "auto",
            vendorId: "vendor_xss",
            vendorName: "<img src=x onerror=alert(1)>",
            contractId: "contract_1",
            templateId: "delivery_standard_v1",
            templateConfig: { metrics: { targetCompletionMinutes: 30 } }
          }),
          "utf8"
        )
      ]
    });
    assert.equal(up.statusCode, 200, up._body().toString("utf8"));
    const upJson = JSON.parse(up._body().toString("utf8"));
    assert.equal(upJson.ok, true);
    assert.match(String(upJson.token), /^ml_[0-9a-f]{48}$/);

    const html = await runReq({ method: "GET", url: `/r/${upJson.token}`, headers: {}, bodyChunks: [] });
    assert.equal(html.statusCode, 200);
    const body = html._body().toString("utf8");
    assert.ok(!body.includes("<img"), "vendorName must be HTML-escaped");
    assert.match(body, /&lt;img/);

    const meta = JSON.parse(await fs.readFile(path.join(dataDir, "meta", `${upJson.token}.json`), "utf8"));
    assert.equal(meta.templateId, "delivery_standard_v1");
    assert.equal(typeof meta.templateConfigHash, "string");
    assert.ok(meta.templateConfigHash.length >= 32);
  });

  await t.test("redaction: deterministic truncation + explicit allowlist", async () => {
    assert.equal(safeTruncate("abc", { max: 3 }), "abc");
    assert.equal(safeTruncate("abcd", { max: 3 }), "ab…");
    assert.equal(safeTruncate("", { max: 1 }), "");

    assert.equal(MAGIC_LINK_RENDER_MODEL_ALLOWLIST_V1.schemaVersion, "MagicLinkRenderModelAllowlist.v1");
    assert.ok(MAGIC_LINK_RENDER_MODEL_ALLOWLIST_V1.invoiceClaim?.lineItems?.maxItems >= 1);

    const claim = buildPublicInvoiceClaimFromClaimJson({
      schemaVersion: "InvoiceClaim.v1",
      tenantId: "t",
      invoiceId: "i",
      createdAt: "2026-02-05T00:00:00.000Z",
      currency: "USD",
      subtotalCents: "1",
      totalCents: "1",
      lineItems: [{ code: "X", quantity: "1", unitPriceCents: "1", amountCents: "1" }],
      // Not allowlisted (should not leak into render model)
      buyerEmail: "pii@example.com",
      billingAddress: "<script>alert(1)</script>"
    });
    assert.equal(typeof claim, "object");
    assert.equal(claim?.buyerEmail, undefined);
    assert.equal(claim?.billingAddress, undefined);
  });

  await t.test("public receipt summary + badge expose non-sensitive verification proof", async () => {
    const tenantId = "tenant_public_receipt";
    await createTenant({
      tenantId,
      name: "Public Receipt Tenant",
      contactEmail: "ops+public-receipt@example.com",
      billingEmail: "billing+public-receipt@example.com"
    });

    const upload = await runReq({
      method: "POST",
      url: `/v1/tenants/${tenantId}/samples/closepack/known-good/upload`,
      headers: { "x-api-key": "test_key", "content-type": "application/json" },
      bodyChunks: [Buffer.from(JSON.stringify({ mode: "auto" }), "utf8")]
    });
    assert.equal(upload.statusCode, 200, upload._body().toString("utf8"));
    const uploadJson = JSON.parse(upload._body().toString("utf8"));
    assert.equal(uploadJson.ok, true);
    const token = String(uploadJson.token);
    assert.match(token, /^ml_[0-9a-f]{48}$/);

    const summaryRes = await runReq({ method: "GET", url: `/v1/public/receipts/${token}`, headers: {}, bodyChunks: [] });
    assert.equal(summaryRes.statusCode, 200, summaryRes._body().toString("utf8"));
    const summaryJson = JSON.parse(summaryRes._body().toString("utf8"));
    assert.equal(summaryJson.ok, true);
    assert.equal(summaryJson.schemaVersion, "MagicLinkPublicReceiptSummary.v1");
    assert.equal(summaryJson.token, token);
    assert.ok(["green", "amber", "red", "processing"].includes(String(summaryJson.verification?.status)));
    assert.match(String(summaryJson.summaryHash ?? ""), /^[0-9a-f]{64}$/);
    assert.equal(summaryJson.vendorId, undefined);
    assert.equal(summaryJson.vendorName, undefined);
    assert.equal(summaryJson.contractId, undefined);
    assert.match(String(summaryJson.artifacts?.verifyJsonSha256 ?? ""), /^[0-9a-f]{64}$/);
    assert.match(String(summaryJson.artifacts?.receiptSha256 ?? ""), /^[0-9a-f]{64}$/);
    assert.equal(summaryJson.signature?.schemaVersion, "PublicReceiptSignature.v1");
    assert.equal(summaryJson.signature?.algorithm, "hmac-sha256");
    assert.match(String(summaryJson.signature?.signatureHex ?? ""), /^[0-9a-f]{64}$/);
    assert.match(String(summaryJson.badge?.badgeSvgUrl ?? ""), new RegExp(`^/v1/public/receipts/${token}/badge\\.svg\\?receiptHash=`));
    assert.match(String(summaryJson.badge?.embedHtml ?? ""), /<img\s/i);

    const badgeRes = await runReq({ method: "GET", url: String(summaryJson.badge.badgeSvgUrl), headers: {}, bodyChunks: [] });
    assert.equal(badgeRes.statusCode, 200, badgeRes._body().toString("utf8"));
    assert.match(String(badgeRes.getHeader("content-type") ?? ""), /image\/svg\+xml/);
    const badgeSvg = badgeRes._body().toString("utf8");
    assert.match(badgeSvg, /SETTLD VERIFIED/);
    assert.match(badgeSvg, /settlement/i);

    const mismatch = await runReq({
      method: "GET",
      url: `/v1/public/receipts/${token}/badge.svg?receiptHash=${"0".repeat(64)}`,
      headers: {},
      bodyChunks: []
    });
    assert.equal(mismatch.statusCode, 409, mismatch._body().toString("utf8"));
    const mismatchJson = JSON.parse(mismatch._body().toString("utf8"));
    assert.equal(mismatchJson.ok, false);
    assert.equal(mismatchJson.code, "RECEIPT_HASH_MISMATCH");
  });

  const trust = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "trust.json"), "utf8"));
  const buyerSigner = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "test", "fixtures", "keys", "ed25519_test_keypair.json"), "utf8"));
  const buyerDecisionKeyId = keyIdFromPublicKeyPem(buyerSigner.publicKeyPem);
  const fxDir = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "invoicebundle", "strict-pass");
  const zip = await zipDir(fxDir);
  const fxCloseDir = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "closepack", "strict-pass");
  const zipClose = await zipDir(fxCloseDir);
  const fxCloseFailDir = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "closepack", "strict-fail-evidence-index-mismatch");
  const zipCloseFail = await zipDir(fxCloseFailDir);

  await t.test("tenant onboarding self-service: signup, sample flow, activation metrics", async () => {
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const createBody = Buffer.from(
      JSON.stringify({
        tenantId: "tenant_self_service",
        name: "Self Service Logistics",
        contactEmail: "ops@self.example",
        billingEmail: "billing@self.example"
      }),
      "utf8"
    );
    const created = await runReq({
      method: "POST",
      url: "/v1/tenants",
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(createBody.length) },
      bodyChunks: [createBody]
    });
    assert.equal(created.statusCode, 201, created._body().toString("utf8"));
    const createdJson = JSON.parse(created._body().toString("utf8"));
    assert.equal(createdJson.ok, true);
    assert.equal(createdJson.tenantId, "tenant_self_service");
    assert.equal(createdJson.profile?.status, "pending");
    assert.match(String(createdJson.onboardingUrl), /\/v1\/tenants\/tenant_self_service\/onboarding$/);
    assert.equal(createdJson.onboardingEmailSequence?.enabled, true);
    assert.equal(createdJson.onboardingEmailSequence?.deliveryMode, "record");
    assert.ok(typeof createdJson.onboardingEmailSequence?.steps?.find((s) => s.stepKey === "welcome")?.sentAt === "string");

    const onboardingPage = await runReq({ method: "GET", url: createdJson.onboardingUrl, headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(onboardingPage.statusCode, 200);
    const onboardingHtml = onboardingPage._body().toString("utf8");
    assert.match(onboardingHtml, /Verify Cloud Onboarding/);
    assert.match(onboardingHtml, /Step 5\. First settlement checklist/);
    assert.match(onboardingHtml, /Step 6\. Runtime bootstrap \(MCP\)/);
    assert.match(onboardingHtml, /Step 7\. First live paid call/);
    assert.match(onboardingHtml, /id="checklistSummary"/);
    assert.match(onboardingHtml, /id="firstSettlementChecklist"/);
    assert.match(onboardingHtml, /id="refreshChecklistBtn"/);
    assert.match(onboardingHtml, /id="firstPaidCallHistorySelect"/);
    assert.match(onboardingHtml, /id="runtimeConformanceBtn"/);

    async function postOnboardingEvent(eventType, metadata = null) {
      const body = Buffer.from(JSON.stringify({ eventType, metadata }), "utf8");
      const res = await runReq({
        method: "POST",
        url: "/v1/tenants/tenant_self_service/onboarding/events",
        headers: {
          "x-api-key": "test_key",
          "content-type": "application/json",
          "content-length": String(body.length)
        },
        bodyChunks: [body]
      });
      assert.equal(res.statusCode, 200, res._body().toString("utf8"));
      return JSON.parse(res._body().toString("utf8"));
    }

    const wizardEvent = await postOnboardingEvent("wizard_viewed", { path: createdJson.onboardingUrl });
    assert.equal(wizardEvent.metrics?.funnel?.stages?.find((s) => s.stageKey === "wizard_viewed")?.reached, true);
    await postOnboardingEvent("template_selected", { templateId: "delivery_priority_v1" });
    await postOnboardingEvent("template_rendered", { templateId: "delivery_priority_v1" });
    const invalidEventBody = Buffer.from(JSON.stringify({ eventType: "totally_invalid_event" }), "utf8");
    const invalidEvent = await runReq({
      method: "POST",
      url: "/v1/tenants/tenant_self_service/onboarding/events",
      headers: {
        "x-api-key": "test_key",
        "content-type": "application/json",
        "content-length": String(invalidEventBody.length)
      },
      bodyChunks: [invalidEventBody]
    });
    assert.equal(invalidEvent.statusCode, 400, invalidEvent._body().toString("utf8"));

    const metricsBefore = await runReq({
      method: "GET",
      url: "/v1/tenants/tenant_self_service/onboarding-metrics",
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(metricsBefore.statusCode, 200, metricsBefore._body().toString("utf8"));
    const metricsBeforeJson = JSON.parse(metricsBefore._body().toString("utf8"));
    assert.equal(metricsBeforeJson.status, "pending");
    assert.equal(metricsBeforeJson.firstUploadAt, null);
    assert.equal(metricsBeforeJson.firstVerifiedAt, null);
    assert.equal(metricsBeforeJson.funnel?.stages?.find((s) => s.stageKey === "wizard_viewed")?.reached, true);
    assert.equal(metricsBeforeJson.funnel?.stages?.find((s) => s.stageKey === "template_selected")?.reached, true);
    assert.equal(metricsBeforeJson.funnel?.stages?.find((s) => s.stageKey === "template_validated")?.reached, true);
    assert.ok(Array.isArray(metricsBeforeJson.cohort?.rows));
    assert.ok(metricsBeforeJson.cohort?.rows?.length >= 1);
    assert.equal(metricsBeforeJson.onboardingEmailSequence?.enabled, true);
    assert.equal(metricsBeforeJson.onboardingEmailSequence?.sentSteps, 1);
    assert.equal(metricsBeforeJson.onboardingEmailSequence?.nextStepKey, null);

    const sample = await runReq({
      method: "POST",
      url: "/v1/tenants/tenant_self_service/samples/closepack/known-good/upload",
      headers: { "x-api-key": "test_key", "content-type": "application/json" },
      bodyChunks: [Buffer.from(JSON.stringify({ mode: "strict", vendorId: "vendor_sample", contractId: "contract_sample" }), "utf8")]
    });
    assert.equal(sample.statusCode, 200, sample._body().toString("utf8"));

    const metricsAfterSample = await runReq({
      method: "GET",
      url: "/v1/tenants/tenant_self_service/onboarding-metrics",
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    const metricsAfterSampleJson = JSON.parse(metricsAfterSample._body().toString("utf8"));
    assert.equal(metricsAfterSampleJson.status, "pending");
    assert.equal(metricsAfterSampleJson.firstUploadAt, null);
    assert.equal(metricsAfterSampleJson.firstVerifiedAt, null);
    assert.ok(typeof metricsAfterSampleJson.firstSampleUploadAt === "string" && metricsAfterSampleJson.firstSampleUploadAt.length > 10);
    assert.equal(metricsAfterSampleJson.funnel?.stages?.find((s) => s.stageKey === "artifact_generated")?.reached, true);
    assert.equal(metricsAfterSampleJson.funnel?.stages?.find((s) => s.stageKey === "real_upload_generated")?.reached, false);
    assert.equal(metricsAfterSampleJson.onboardingEmailSequence?.sentSteps, 2);
    assert.equal(metricsAfterSampleJson.onboardingEmailSequence?.nextStepKey, null);

    const real = await runReq({
      method: "POST",
      url: "/v1/tenants/tenant_self_service/upload?mode=strict&vendorId=vendor_real&vendorName=Vendor%20Real&contractId=contract_real",
      headers: { "x-api-key": "test_key", "content-type": "application/zip", "content-length": String(zip.length) },
      bodyChunks: [zip]
    });
    assert.equal(real.statusCode, 200, real._body().toString("utf8"));

    const metricsAfterReal = await runReq({
      method: "GET",
      url: "/v1/tenants/tenant_self_service/onboarding-metrics",
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(metricsAfterReal.statusCode, 200, metricsAfterReal._body().toString("utf8"));
    const metricsAfterRealJson = JSON.parse(metricsAfterReal._body().toString("utf8"));
    assert.equal(metricsAfterRealJson.status, "active");
    assert.ok(typeof metricsAfterRealJson.firstUploadAt === "string" && metricsAfterRealJson.firstUploadAt.length > 10);
    assert.ok(typeof metricsAfterRealJson.firstVerifiedAt === "string" && metricsAfterRealJson.firstVerifiedAt.length > 10);
    assert.ok(Number.isInteger(metricsAfterRealJson.timeToFirstVerifiedMs));
    assert.ok(metricsAfterRealJson.timeToFirstVerifiedMs >= 0);
    assert.ok(Array.isArray(metricsAfterRealJson.cohort?.rows));
    assert.equal(metricsAfterRealJson.cohort?.current?.cohortMonth, metricsAfterRealJson.cohort?.cohortMonth);
    assert.equal(metricsAfterRealJson.onboardingEmailSequence?.sentSteps, 3);
    assert.equal(metricsAfterRealJson.onboardingEmailSequence?.completionPct, 100);
    const sequenceStatePath = path.join(dataDir, "tenants", "tenant_self_service", "onboarding_email_sequence.json");
    const sequenceState = JSON.parse(await fs.readFile(sequenceStatePath, "utf8"));
    assert.ok(typeof sequenceState?.steps?.welcome?.sentAt === "string");
    assert.ok(typeof sequenceState?.steps?.sample_verified_nudge?.sentAt === "string");
    assert.ok(typeof sequenceState?.steps?.first_settlement_completed?.sentAt === "string");

    const realJson = JSON.parse(real._body().toString("utf8"));
    await postOnboardingEvent("buyer_link_shared", { token: realJson.token });
    await postOnboardingEvent("referral_link_shared", { channel: "email", campaign: "launch_v1" });
    await postOnboardingEvent("referral_signup", { sourceTenantId: "tenant_self_service", referredTenantId: "tenant_friend_1" });
    const metricsAfterBuyerLink = await runReq({
      method: "GET",
      url: "/v1/tenants/tenant_self_service/onboarding-metrics?cohortLimit=24",
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(metricsAfterBuyerLink.statusCode, 200, metricsAfterBuyerLink._body().toString("utf8"));
    const metricsAfterBuyerLinkJson = JSON.parse(metricsAfterBuyerLink._body().toString("utf8"));
    assert.ok(typeof metricsAfterBuyerLinkJson.firstBuyerLinkSharedAt === "string" && metricsAfterBuyerLinkJson.firstBuyerLinkSharedAt.length > 10);
    assert.equal(metricsAfterBuyerLinkJson.funnel?.stages?.find((s) => s.stageKey === "buyer_link_shared")?.reached, true);
    assert.ok(typeof metricsAfterBuyerLinkJson.firstReferralLinkSharedAt === "string");
    assert.ok(typeof metricsAfterBuyerLinkJson.firstReferralSignupAt === "string");
    assert.equal(metricsAfterBuyerLinkJson.referral?.linkSharedCount, 1);
    assert.equal(metricsAfterBuyerLinkJson.referral?.signupCount, 1);
    assert.equal(metricsAfterBuyerLinkJson.referral?.conversionRatePct, 100);
    assert.equal(metricsAfterBuyerLinkJson.funnel?.stages?.find((s) => s.stageKey === "referral_signup")?.reached, true);
    assert.ok((metricsAfterBuyerLinkJson.cohort?.current?.referralSignup ?? 0) >= 1);
  });

  await t.test("strict pass + downloads", async () => {
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId: "tenant_a" });
    assert.equal(up.modeResolved, "strict");
    assert.equal(up.deduped, false);

    const html = await runReq({ method: "GET", url: `/r/${up.token}`, headers: {}, bodyChunks: [] });
    assert.equal(html.statusCode, 200);
    assert.match(html._body().toString("utf8"), /Green/);
    assert.match(html._body().toString("utf8"), /invoice_fixture_1/);

    const verify = await runReq({ method: "GET", url: `/r/${up.token}/verify.json`, headers: {}, bodyChunks: [] });
    assert.equal(verify.statusCode, 200);
    const verifyJson = JSON.parse(verify._body().toString("utf8"));
    assert.equal(verifyJson.schemaVersion, "VerifyCliOutput.v1");
    assert.equal(verifyJson.ok, true);
    assert.equal(verifyJson.target.dir, null);

    const receipt = await runReq({ method: "GET", url: `/r/${up.token}/receipt.json`, headers: {}, bodyChunks: [] });
    assert.equal(receipt.statusCode, 200);
    const receiptJson = JSON.parse(receipt._body().toString("utf8"));
    assert.equal(receiptJson.schemaVersion, "VerificationReport.v1");

    const pdf = await runReq({ method: "GET", url: `/r/${up.token}/summary.pdf`, headers: {}, bodyChunks: [] });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf._body().slice(0, 8).toString("ascii"), "%PDF-1.4");

    const audit = await runReq({ method: "GET", url: `/r/${up.token}/audit-packet.zip`, headers: {}, bodyChunks: [] });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit._body().readUInt32LE(0), 0x04034b50); // PK\x03\x04
  });

  await t.test("strict pass (closepack) + downloads", async () => {
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const up = await uploadZip({ zipBuf: zipClose, mode: "strict", tenantId: "tenant_close" });
    assert.equal(up.modeResolved, "strict");
    assert.equal(up.deduped, false);

    const html = await runReq({ method: "GET", url: `/r/${up.token}`, headers: {}, bodyChunks: [] });
    assert.equal(html.statusCode, 200);
    assert.match(html._body().toString("utf8"), /Green/);
    assert.match(html._body().toString("utf8"), /invoice_fixture_1/);

    const verify = await runReq({ method: "GET", url: `/r/${up.token}/verify.json`, headers: {}, bodyChunks: [] });
    assert.equal(verify.statusCode, 200);
    const verifyJson = JSON.parse(verify._body().toString("utf8"));
    assert.equal(verifyJson.schemaVersion, "VerifyCliOutput.v1");
    assert.equal(verifyJson.ok, true);
    assert.equal(verifyJson.target.kind, "close-pack");
    assert.equal(verifyJson.target.dir, null);
    assert.equal(verifyJson.summary.type, "ClosePack.v1");

    const receipt = await runReq({ method: "GET", url: `/r/${up.token}/receipt.json`, headers: {}, bodyChunks: [] });
    assert.equal(receipt.statusCode, 200);
    const receiptJson = JSON.parse(receipt._body().toString("utf8"));
    assert.equal(receiptJson.schemaVersion, "VerificationReport.v1");

    const pdf = await runReq({ method: "GET", url: `/r/${up.token}/summary.pdf`, headers: {}, bodyChunks: [] });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf._body().slice(0, 8).toString("ascii"), "%PDF-1.4");

    const audit = await runReq({ method: "GET", url: `/r/${up.token}/audit-packet.zip`, headers: {}, bodyChunks: [] });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit._body().readUInt32LE(0), 0x04034b50); // PK\x03\x04
  });

  await t.test("tenant upload route: accepts template metadata and persists it", async () => {
    const tenantId = "tenant_wizard_upload";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const templateConfig = { metrics: { targetCompletionMinutes: 42, maxCheckpointGapMinutes: 9 } };
    const templateConfigEncoded = Buffer.from(JSON.stringify(templateConfig), "utf8").toString("base64url");
    const uploadUrl =
      `/v1/tenants/${encodeURIComponent(tenantId)}/upload` +
      `?mode=strict&vendorId=${encodeURIComponent("vendor_wizard")}` +
      `&vendorName=${encodeURIComponent("Wizard Vendor")}` +
      `&contractId=${encodeURIComponent("contract_wizard")}` +
      `&templateId=${encodeURIComponent("delivery_standard_v1")}` +
      `&templateConfig=${encodeURIComponent(templateConfigEncoded)}`;

    const res = await runReq({
      method: "POST",
      url: uploadUrl,
      headers: { "x-api-key": "test_key", "content-type": "application/zip", "content-length": String(zip.length) },
      bodyChunks: [zip]
    });
    assert.equal(res.statusCode, 200, res._body().toString("utf8"));
    const json = JSON.parse(res._body().toString("utf8"));
    assert.equal(json.ok, true);

    const token = json.token;
    const meta = JSON.parse(await fs.readFile(path.join(dataDir, "meta", `${token}.json`), "utf8"));
    assert.equal(meta.templateId, "delivery_standard_v1");
    assert.ok(typeof meta.templateConfigHash === "string" && meta.templateConfigHash.length > 20);
    assert.equal(meta.templateConfig?.metrics?.targetCompletionMinutes, 42);
  });

  await t.test("idempotent upload returns same token", async () => {
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const first = await uploadZip({ zipBuf: zip, mode: "strict", tenantId: "tenant_idem" });
    const second = await uploadZip({ zipBuf: zip, mode: "strict", tenantId: "tenant_idem" });
    assert.equal(second.token, first.token);
    assert.equal(second.deduped, true);
  });

  await t.test("auto mode without trust yields amber + warning code", async () => {
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = "";
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = "";

    const up = await uploadZip({ zipBuf: zip, mode: "auto", tenantId: "tenant_auto" });
    assert.equal(up.modeResolved, "compat");

    const verify = await runReq({ method: "GET", url: `/r/${up.token}/verify.json`, headers: {}, bodyChunks: [] });
    const verifyJson = JSON.parse(verify._body().toString("utf8"));
    assert.equal(verifyJson.ok, true);
    const warningCodes = Array.isArray(verifyJson.warnings) ? verifyJson.warnings.map((w) => w.code) : [];
    assert.ok(warningCodes.includes("TRUSTED_GOVERNANCE_ROOT_KEYS_MISSING_LENIENT"));

    const html = await runReq({ method: "GET", url: `/r/${up.token}`, headers: {}, bodyChunks: [] });
    assert.match(html._body().toString("utf8"), /Amber/);
    assert.match(html._body().toString("utf8"), /Governance not anchored/);
  });

  await t.test("strict mode without trust fails with clear code", async () => {
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = "";
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = "";

    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId: "tenant_strict_missing" });
    assert.equal(up.modeResolved, "strict");
    assert.equal(up.verifyOk, false);

    const verify = await runReq({ method: "GET", url: `/r/${up.token}/verify.json`, headers: {}, bodyChunks: [] });
    const verifyJson = JSON.parse(verify._body().toString("utf8"));
    const errorCodes = Array.isArray(verifyJson.errors) ? verifyJson.errors.map((e) => e.code) : [];
    assert.ok(errorCodes.includes("strict requires trusted governance root keys"));
  });

  await t.test("revoke makes link inaccessible", async () => {
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId: "tenant_revoke" });
    const body = Buffer.from(JSON.stringify({ token: up.token }));
    const revoke = await runReq({
      method: "POST",
      url: "/v1/revoke",
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(body.length) },
      bodyChunks: [body]
    });
    assert.equal(revoke.statusCode, 200);

    const html = await runReq({ method: "GET", url: `/r/${up.token}`, headers: {}, bodyChunks: [] });
    assert.equal(html.statusCode, 410);
  });

  await t.test("tenant settings: switch Amber → Strict without redeploy (auto reruns)", async () => {
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = "";
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = "";
    const tenantId = "tenant_switch";

    const first = await uploadZip({ zipBuf: zip, mode: "auto", tenantId });
    assert.equal(first.modeResolved, "compat");

    const verify1 = await runReq({ method: "GET", url: `/r/${first.token}/verify.json`, headers: {}, bodyChunks: [] });
    const verify1Json = JSON.parse(verify1._body().toString("utf8"));
    const warningCodes1 = Array.isArray(verify1Json.warnings) ? verify1Json.warnings.map((w) => w.code) : [];
    assert.ok(warningCodes1.includes("TRUSTED_GOVERNANCE_ROOT_KEYS_MISSING_LENIENT"));

    await putTenantSettings({ tenantId, patch: { governanceTrustRootsJson: trust.governanceRoots ?? {}, pricingSignerKeysJson: trust.pricingSigners ?? {} } });

    const second = await uploadZip({ zipBuf: zip, mode: "auto", tenantId });
    assert.equal(second.token, first.token);
    assert.equal(second.modeResolved, "strict");
    assert.equal(second.rerun, true);

    const verify2 = await runReq({ method: "GET", url: `/r/${second.token}/verify.json`, headers: {}, bodyChunks: [] });
    const verify2Json = JSON.parse(verify2._body().toString("utf8"));
    const warningCodes2 = Array.isArray(verify2Json.warnings) ? verify2Json.warnings.map((w) => w.code) : [];
    assert.ok(!warningCodes2.includes("TRUSTED_GOVERNANCE_ROOT_KEYS_MISSING_LENIENT"));
    assert.equal(verify2Json.ok, true);
  });

  await t.test("tenant defaultMode applies when mode is omitted", async () => {
    const tenantId = "tenant_default_mode";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({ tenantId, patch: { defaultMode: "compat" } });

    const up = await uploadZip({ zipBuf: zip, mode: null, tenantId });
    assert.equal(up.modeResolved, "compat");
  });

  await t.test("usage report: records verification runs for billing export", async () => {
    const tenantId = "tenant_usage";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });
    assert.equal(up.modeResolved, "strict");

    const report = await getTenantUsage({ tenantId });
    assert.equal(report.schemaVersion, "MagicLinkUsageReport.v1");
    assert.equal(report.tenantId, tenantId);
    assert.equal(report.entitlements.plan, "free");
    assert.ok(report.summary.verificationRuns >= 1);
    assert.ok(report.summary.uploadedBytes >= zip.length);
    assert.equal(report.quota.maxVerificationsPerMonth.limit, 100);
    assert.ok(report.quota.maxVerificationsPerMonth.remaining >= 0);
    assert.equal(report.thresholdAlerts?.schemaVersion, "MagicLinkUsageThresholdStatus.v1");
    assert.equal(report.thresholdAlerts?.limit, 100);
    assert.ok(Array.isArray(report.thresholdAlerts?.thresholds));
    const threshold80 = report.thresholdAlerts.thresholds.find((row) => row?.thresholdPct === 80);
    assert.equal(threshold80?.triggerRuns, 80);
    assert.equal(threshold80?.emittedAt, null);
  });

  await t.test("billing usage threshold alerts emit once at 80% and 100% per month", async () => {
    const tenantId = "tenant_usage_threshold_alerts";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({ tenantId, patch: { maxVerificationsPerMonth: 5 } });

    const fxInvoiceFailA = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "invoicebundle", "strict-fail-evidence-sha-mismatch");
    const fxInvoiceFailB = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "invoicebundle", "strict-fail-invalid-pricing-matrix-signature");
    const fxInvoiceFailC = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "invoicebundle", "strict-fail-pricing-altered");
    const zipInvoiceFailA = await zipDir(fxInvoiceFailA);
    const zipInvoiceFailB = await zipDir(fxInvoiceFailB);
    const zipInvoiceFailC = await zipDir(fxInvoiceFailC);

    const uploads = [zip, zipClose, zipInvoiceFailA, zipInvoiceFailB, zipInvoiceFailC];
    for (const zipBuf of uploads) {
      // eslint-disable-next-line no-await-in-loop
      await uploadZip({ zipBuf, mode: "strict", tenantId });
    }

    const report = await getTenantUsage({ tenantId });
    assert.equal(report.quota?.maxVerificationsPerMonth?.limit, 5);
    assert.equal(report.quota?.maxVerificationsPerMonth?.used, 5);
    assert.equal(report.thresholdAlerts?.schemaVersion, "MagicLinkUsageThresholdStatus.v1");
    const threshold80 = Array.isArray(report.thresholdAlerts?.thresholds) ? report.thresholdAlerts.thresholds.find((row) => row?.thresholdPct === 80) : null;
    const threshold100 = Array.isArray(report.thresholdAlerts?.thresholds) ? report.thresholdAlerts.thresholds.find((row) => row?.thresholdPct === 100) : null;
    assert.equal(threshold80?.triggerRuns, 4);
    assert.equal(threshold100?.triggerRuns, 5);
    assert.ok(typeof threshold80?.emittedAt === "string" && threshold80.emittedAt.length > 0);
    assert.ok(typeof threshold100?.emittedAt === "string" && threshold100.emittedAt.length > 0);

    const month = monthKeyUtcNow();
    const auditPath = path.join(dataDir, "audit", tenantId, `${month}.jsonl`);
    const auditRaw = await fs.readFile(auditPath, "utf8");
    const thresholdRows = auditRaw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .filter((row) => row?.action === "BILLING_USAGE_THRESHOLD_ALERT_EMITTED");
    assert.equal(thresholdRows.length, 2);
    assert.deepEqual(
      thresholdRows.map((row) => Number(row?.details?.thresholdPct)).sort((a, b) => a - b),
      [80, 100]
    );

    const reportAgain = await getTenantUsage({ tenantId });
    const thresholdAgain = Array.isArray(reportAgain.thresholdAlerts?.thresholds)
      ? reportAgain.thresholdAlerts.thresholds.filter((row) => row?.thresholdPct === 80 || row?.thresholdPct === 100)
      : [];
    assert.equal(thresholdAgain.length, 2);
    assert.ok(thresholdAgain.every((row) => typeof row?.emittedAt === "string" && row.emittedAt.length > 0));

    const auditRawAgain = await fs.readFile(auditPath, "utf8");
    const thresholdRowsAgain = auditRawAgain
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .filter((row) => row?.action === "BILLING_USAGE_THRESHOLD_ALERT_EMITTED");
    assert.equal(thresholdRowsAgain.length, 2);
  });

  await t.test("entitlements endpoint and billing usage alias expose plan-derived limits", async () => {
    const tenantId = "tenant_entitlements";
    await putTenantSettings({ tenantId, patch: { plan: "growth", maxStoredBundles: 7 } });

    const ent = await getTenantEntitlements({ tenantId });
    assert.equal(ent.entitlements.plan, "growth");
    assert.equal(ent.entitlements.limits.maxVerificationsPerMonth, 100000);
    assert.equal(ent.entitlements.limits.maxStoredBundles, 7);
    assert.equal(ent.entitlements.billing.subscriptionCents, 59900);
    assert.equal(ent.entitlements.billing.pricePerVerificationCents, 0.7);

    const usageAlias = await getTenantBillingUsage({ tenantId });
    assert.equal(usageAlias.schemaVersion, "MagicLinkUsageReport.v1");
    assert.equal(usageAlias.entitlements.plan, "growth");
    assert.equal(usageAlias.entitlements.limits.maxStoredBundles, 7);
  });

  await t.test("billing invoice export: computes totals from usage summary", async () => {
    const tenantId = "tenant_billing";
    const month = monthKeyUtcNow();
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    await uploadZip({ zipBuf: zip, mode: "strict", tenantId });

    const jsonRes = await getTenantBillingInvoiceRes({ tenantId, month, format: "json" });
    assert.equal(jsonRes.statusCode, 200, jsonRes._body().toString("utf8"));
    const invoice = JSON.parse(jsonRes._body().toString("utf8"));
    assert.equal(invoice.schemaVersion, "MagicLinkBillingInvoice.v1");
    assert.equal(invoice.tenantId, tenantId);
    assert.equal(invoice.plan, "free");
    assert.equal(invoice.month, month);
    assert.equal(invoice.currency, "USD");
    assert.equal(invoice.pricing.subscriptionCents, "0");
    assert.equal(invoice.pricing.pricePerVerificationCents, "0");
    assert.equal(invoice.lineItems[0].code, "SUBSCRIPTION");
    assert.equal(invoice.lineItems[0].amountCents, "0");
    assert.equal(invoice.lineItems[1].code, "VERIFICATIONS");
    assert.equal(invoice.lineItems[1].quantity, "1");
    assert.equal(invoice.lineItems[1].amountCents, "0");
    assert.equal(invoice.totals.totalCents, "0");

    const pdfRes = await getTenantBillingInvoiceRes({ tenantId, month, format: "pdf" });
    assert.equal(pdfRes.statusCode, 200);
    assert.equal(pdfRes.getHeader("content-type"), "application/pdf");
    assert.ok(pdfRes._body().subarray(0, 8).toString("ascii").startsWith("%PDF-"));
  });

  await t.test("tenant plan endpoint updates invoice draft pricing", async () => {
    const tenantId = "tenant_plan_invoice";
    const month = monthKeyUtcNow();
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await setTenantPlan({ tenantId, plan: "growth" });
    await uploadZip({ zipBuf: zip, mode: "strict", tenantId });

    const invoiceDraftRes = await getTenantBillingInvoiceDraftRes({ tenantId, month, format: "json" });
    assert.equal(invoiceDraftRes.statusCode, 200, invoiceDraftRes._body().toString("utf8"));
    const invoiceDraft = JSON.parse(invoiceDraftRes._body().toString("utf8"));
    assert.equal(invoiceDraft.plan, "growth");
    assert.equal(invoiceDraft.pricing.subscriptionCents, "59900");
    assert.equal(invoiceDraft.pricing.pricePerVerificationCents, "0.7");
    assert.equal(invoiceDraft.totals.totalCents, "59900.7");
  });

  await t.test("stripe billing: checkout + portal + webhook-driven plan lifecycle", async () => {
    const tenantId = "tenant_billing_stripe";
    await createTenant({
      name: "Billing Stripe Tenant",
      contactEmail: "ops+billing-stripe@example.com",
      billingEmail: "billing+stripe@example.com",
      tenantId
    });

    const checkout = await createTenantBillingCheckout({ tenantId, plan: "growth" });
    assert.equal(checkout.plan, "growth");
    assert.match(String(checkout.sessionId), /^cs_test_/);
    assert.match(String(checkout.checkoutUrl), /^https:\/\/checkout\.stripe\.test\/session\//);

    const stateAfterCheckout = await getTenantBillingState({ tenantId });
    assert.equal(stateAfterCheckout.state.lastCheckoutSessionId, checkout.sessionId);

    await postStripeWebhookEvent({
      id: "evt_checkout_completed_growth",
      type: "checkout.session.completed",
      data: {
        object: {
          id: checkout.sessionId,
          customer: "cus_growth_001",
          subscription: "sub_growth_001",
          metadata: { tenantId, plan: "growth" }
        }
      }
    });

    const entAfterGrowth = await getTenantEntitlements({ tenantId });
    assert.equal(entAfterGrowth.entitlements.plan, "growth");

    const stateAfterGrowth = await getTenantBillingState({ tenantId });
    assert.equal(stateAfterGrowth.state.customerId, "cus_growth_001");
    assert.equal(stateAfterGrowth.state.subscriptionId, "sub_growth_001");
    assert.equal(stateAfterGrowth.state.paymentDelinquent, false);
    assert.equal(stateAfterGrowth.state.suspended, false);

    const portal = await createTenantBillingPortal({ tenantId });
    assert.match(String(portal.portalUrl), /^https:\/\/billing\.stripe\.test\/portal\/cus_growth_001/);

    await postStripeWebhookEvent({
      id: "evt_invoice_payment_failed_growth",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_failed_001",
          customer: "cus_growth_001"
        }
      }
    });

    const entAfterFailedPayment = await getTenantEntitlements({ tenantId });
    assert.equal(entAfterFailedPayment.entitlements.plan, "free");

    const stateAfterFailedPayment = await getTenantBillingState({ tenantId });
    assert.equal(stateAfterFailedPayment.state.paymentDelinquent, true);
    assert.equal(stateAfterFailedPayment.state.suspended, true);
  });

  await t.test("quota: maxVerificationsPerMonth blocks new verifications but allows dedupe", async () => {
    const tenantId = "tenant_quota_month";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({ tenantId, patch: { maxVerificationsPerMonth: 1 } });

    const ok1 = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });
    const fx2 = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "invoicebundle", "strict-fail-invoice-total-mismatch");
    const zip2 = await zipDir(fx2);
    const bad = await uploadZipRaw({ zipBuf: zip2, mode: "strict", tenantId });
    assert.equal(bad.statusCode, 429);
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.code, "QUOTA_EXCEEDED");

    const ok2 = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });
    assert.equal(ok2.token, ok1.token);
    assert.equal(ok2.deduped, true);
  });

  await t.test("quota: maxStoredBundles blocks new bundles but allows dedupe", async () => {
    const tenantId = "tenant_quota_storage";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({ tenantId, patch: { maxStoredBundles: 1 } });

    const ok1 = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });
    const fx2 = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "invoicebundle", "strict-fail-pricing-code-unknown");
    const zip2 = await zipDir(fx2);
    const bad = await uploadZipRaw({ zipBuf: zip2, mode: "strict", tenantId });
    assert.equal(bad.statusCode, 429);
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.code, "QUOTA_EXCEEDED");

    const ok2 = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });
    assert.equal(ok2.token, ok1.token);
    assert.equal(ok2.deduped, true);
  });

  await t.test("rate limits: upload/view/decision routes enforce tenant settings with retry-after", async () => {
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const tenantUpload = "tenant_rate_limit_upload";
    await putTenantSettings({ tenantId: tenantUpload, patch: { rateLimits: { uploadsPerHour: 1 } } });
    await uploadZip({ zipBuf: zip, mode: "strict", tenantId: tenantUpload });
    const fx2 = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "invoicebundle", "strict-fail-pricing-code-unknown");
    const zip2 = await zipDir(fx2);
    const blockedUpload = await uploadZipRaw({ zipBuf: zip2, mode: "strict", tenantId: tenantUpload });
    assert.equal(blockedUpload.statusCode, 429);
    assert.equal(blockedUpload.json.code, "RATE_LIMITED");
    assert.ok(Number.isInteger(blockedUpload.json.retryAfterSeconds));

    const tenantView = "tenant_rate_limit_view";
    await putTenantSettings({ tenantId: tenantView, patch: { rateLimits: { verificationViewsPerHour: 1 } } });
    const viewUpload = await uploadZip({ zipBuf: zip, mode: "strict", tenantId: tenantView });
    const firstView = await runReq({ method: "GET", url: `/r/${viewUpload.token}`, headers: {}, bodyChunks: [] });
    assert.equal(firstView.statusCode, 200);
    const secondView = await runReq({ method: "GET", url: `/r/${viewUpload.token}`, headers: {}, bodyChunks: [] });
    assert.equal(secondView.statusCode, 429, secondView._body().toString("utf8"));
    const secondViewJson = JSON.parse(secondView._body().toString("utf8"));
    assert.equal(secondViewJson.code, "RATE_LIMITED");
    assert.ok(Number.isInteger(secondViewJson.retryAfterSeconds));
    assert.ok(Number.parseInt(String(secondView.getHeader("retry-after") ?? ""), 10) >= 1);

    const tenantDecision = "tenant_rate_limit_decision";
    await putTenantSettings({
      tenantId: tenantDecision,
      patch: { rateLimits: { decisionsPerHour: 1 }, settlementDecisionSigner: { signerKeyId: buyerDecisionKeyId, privateKeyPem: buyerSigner.privateKeyPem } }
    });
    const decisionUpload = await uploadZip({ zipBuf: zip, mode: "strict", tenantId: tenantDecision });
    const invalidDecisionBody = Buffer.from(JSON.stringify({ decision: "invalid", email: "buyer@example.com" }), "utf8");
    const firstDecision = await runReq({
      method: "POST",
      url: `/r/${decisionUpload.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(invalidDecisionBody.length) },
      bodyChunks: [invalidDecisionBody]
    });
    assert.equal(firstDecision.statusCode, 400, firstDecision._body().toString("utf8"));
    const secondDecision = await runReq({
      method: "POST",
      url: `/r/${decisionUpload.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(invalidDecisionBody.length) },
      bodyChunks: [invalidDecisionBody]
    });
    assert.equal(secondDecision.statusCode, 429, secondDecision._body().toString("utf8"));
    const secondDecisionJson = JSON.parse(secondDecision._body().toString("utf8"));
    assert.equal(secondDecisionJson.code, "RATE_LIMITED");
    assert.ok(Number.isInteger(secondDecisionJson.retryAfterSeconds));
    assert.ok(Number.parseInt(String(secondDecision.getHeader("retry-after") ?? ""), 10) >= 1);
  });

  await t.test("webhooks: secret encrypted-at-rest; deliveries are HMAC-signed", async () => {
    const tenantId = "tenant_webhook";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const secret = "whsec_test";
    await putTenantSettings({
      tenantId,
      patch: {
        webhooks: [{ url: "https://example.invalid/settld-webhook", events: ["verification.completed", "verification.failed"], secret, enabled: true }]
      }
    });

    const settingsPath = path.join(dataDir, "tenants", tenantId, "settings.json");
    const stored = await fs.readFile(settingsPath, "utf8");
    assert.ok(!stored.includes(secret));
    assert.ok(stored.includes("enc:v1:"));

    const before = await listFilesRecursive(path.join(dataDir, "webhooks", "record")).catch(() => []);
    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });
    assert.equal(up.modeResolved, "strict");

    const after = await listFilesRecursive(path.join(dataDir, "webhooks", "record"));
    const newFiles = after.filter((p) => !before.includes(p));
    assert.ok(newFiles.length >= 1);

    const attempts = await Promise.all(newFiles.map(async (fp) => JSON.parse(await fs.readFile(fp, "utf8"))));
    const attempt = attempts.find((row) => row?.url === "https://example.invalid/settld-webhook");
    assert.ok(attempt);
    assert.equal(attempt.schemaVersion, "MagicLinkWebhookAttempt.v1");
    assert.equal(attempt.event, "verification.completed");
    assert.equal(attempt.url, "https://example.invalid/settld-webhook");
    assert.ok(attempt.body);
    assert.ok(attempt.headers["x-settld-timestamp"]);
    assert.ok(attempt.headers["x-settld-signature"]);

    const ts = attempt.headers["x-settld-timestamp"];
    const expected = "v1=" + crypto.createHmac("sha256", secret).update(`${ts}.${attempt.body}`, "utf8").digest("hex");
    assert.equal(attempt.headers["x-settld-signature"], expected);
  });

  await t.test("buyer notifications: delivery is idempotent per run and status appears in tenant settings", async () => {
    const tenantId = "tenant_buyer_notify";
    const runId = "run_notify_1";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    await putTenantSettings({
      tenantId,
      patch: { buyerNotifications: { emails: ["buyer.notify@example.com"], deliveryMode: "record" } }
    });

    const before = await listFilesRecursive(path.join(dataDir, "buyer-notification-outbox")).catch(() => []);
    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId, runId });
    const after = await listFilesRecursive(path.join(dataDir, "buyer-notification-outbox")).catch(() => []);
    const newFiles = after.filter((fp) => !before.includes(fp));
    assert.equal(newFiles.length, 1);
    const outbox = JSON.parse(await fs.readFile(newFiles[0], "utf8"));
    assert.equal(outbox.schemaVersion, "MagicLinkBuyerNotificationOutbox.v1");
    assert.equal(outbox.token, up.token);
    assert.equal(outbox.recipient, "buyer.notify@example.com");
    assert.equal(outbox.summary?.status, "green");
    assert.match(String(outbox.summary?.magicLinkUrl ?? ""), new RegExp(`/r/${up.token}$`));

    const upAgain = await uploadZip({ zipBuf: zip, mode: "strict", tenantId, runId });
    assert.equal(upAgain.token, up.token);
    assert.equal(upAgain.deduped, true);
    const afterDedupe = await listFilesRecursive(path.join(dataDir, "buyer-notification-outbox")).catch(() => []);
    assert.equal(afterDedupe.length, after.length, "deduped upload must not enqueue a second notification");

    const upRerun = await uploadZip({ zipBuf: zip, mode: "compat", tenantId, runId });
    assert.equal(upRerun.token, up.token);
    assert.equal(upRerun.rerun, true);
    const afterRerun = await listFilesRecursive(path.join(dataDir, "buyer-notification-outbox")).catch(() => []);
    assert.equal(afterRerun.length, after.length, "rerun upload must not enqueue a second notification for an already-sent token");

    const fxRunDup = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "invoicebundle", "strict-fail-invoice-total-mismatch");
    const zipRunDup = await zipDir(fxRunDup);
    const upRunDup = await uploadZip({ zipBuf: zipRunDup, mode: "strict", tenantId, runId });
    assert.notEqual(upRunDup.token, up.token);
    assert.equal(upRunDup.buyerNotifications?.skipped, true);
    const afterRunDup = await listFilesRecursive(path.join(dataDir, "buyer-notification-outbox")).catch(() => []);
    assert.equal(afterRunDup.length, after.length, "runId duplicate across tokens must not enqueue a second notification");

    const settingsRes = await runReq({ method: "GET", url: `/v1/tenants/${encodeURIComponent(tenantId)}/settings`, headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(settingsRes.statusCode, 200, settingsRes._body().toString("utf8"));
    const settingsJson = JSON.parse(settingsRes._body().toString("utf8"));
    assert.equal(settingsJson.buyerNotifications?.latest?.token, up.token);
    assert.equal(settingsJson.buyerNotifications?.latest?.ok, true);

    const tenantFail = "tenant_buyer_notify_fail";
    await putTenantSettings({
      tenantId: tenantFail,
      patch: {
        buyerNotifications: {
          emails: ["buyer.notify@example.com"],
          deliveryMode: "webhook",
          webhookUrl: "http://127.0.0.1:1/notifications",
          webhookSecret: "notif_secret"
        }
      }
    });
    const failUpload = await uploadZip({ zipBuf: zip, mode: "strict", tenantId: tenantFail });
    const failSettingsRes = await runReq({ method: "GET", url: `/v1/tenants/${encodeURIComponent(tenantFail)}/settings`, headers: { "x-api-key": "test_key" }, bodyChunks: [] });
    assert.equal(failSettingsRes.statusCode, 200, failSettingsRes._body().toString("utf8"));
    const failSettingsJson = JSON.parse(failSettingsRes._body().toString("utf8"));
    assert.equal(failSettingsJson.buyerNotifications?.latest?.token, failUpload.token);
    assert.equal(failSettingsJson.buyerNotifications?.latest?.ok, false);
    assert.ok(Array.isArray(failSettingsJson.buyerNotifications?.latest?.failures));
    assert.ok(failSettingsJson.buyerNotifications.latest.failures.length >= 1);
  });

  await t.test("tenant settings: autoDecision/paymentTriggers normalize + webhook secret redaction", async () => {
    const tenantId = "tenant_auto_settings";
    await putTenantSettings({
      tenantId,
      patch: {
        autoDecision: {
          enabled: true,
          approveOnGreen: true,
          approveOnAmber: false,
          holdOnRed: true,
          templateIds: ["delivery_standard_v1"],
          actorName: "Auto Ops",
          actorEmail: "Auto.Ops@Example.com"
        },
        paymentTriggers: {
          enabled: true,
          deliveryMode: "webhook",
          webhookUrl: "https://example.invalid/payment",
          webhookSecret: "paysecret_test"
        }
      }
    });

    const settingsRes = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/settings`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(settingsRes.statusCode, 200, settingsRes._body().toString("utf8"));
    const settingsJson = JSON.parse(settingsRes._body().toString("utf8"));
    assert.equal(settingsJson.settings?.autoDecision?.enabled, true);
    assert.equal(settingsJson.settings?.autoDecision?.approveOnGreen, true);
    assert.equal(settingsJson.settings?.autoDecision?.holdOnRed, true);
    assert.equal(settingsJson.settings?.autoDecision?.actorEmail, "auto.ops@example.com");
    assert.equal(settingsJson.settings?.paymentTriggers?.enabled, true);
    assert.equal(settingsJson.settings?.paymentTriggers?.deliveryMode, "webhook");
    assert.equal(settingsJson.settings?.paymentTriggers?.webhookSecret, null);

    const settingsPath = path.join(dataDir, "tenants", tenantId, "settings.json");
    const storedRaw = await fs.readFile(settingsPath, "utf8");
    assert.ok(!storedRaw.includes("paysecret_test"));
    assert.ok(storedRaw.includes("enc:v1:"));
  });

  await t.test("decision capture: buyer can approve/hold and export a record", async () => {
    const tenantId = "tenant_decision";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({
      tenantId,
      patch: { settlementDecisionSigner: { signerKeyId: buyerDecisionKeyId, privateKeyPem: buyerSigner.privateKeyPem } }
    });

    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });
    const form = Buffer.from("decision=approve&name=Alice&email=alice%40example.com&note=ok", "utf8");
    const post = await runReq({
      method: "POST",
      url: `/r/${up.token}/decision`,
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(form.length) },
      bodyChunks: [form]
    });
    assert.equal(post.statusCode, 303);

    const rep = await runReq({ method: "GET", url: `/r/${up.token}/settlement_decision_report.json`, headers: {}, bodyChunks: [] });
    assert.equal(rep.statusCode, 200);
    const repJson = JSON.parse(rep._body().toString("utf8"));
    assert.equal(repJson.schemaVersion, "SettlementDecisionReport.v1");
    assert.equal(repJson.decision, "approve");
    assert.equal(repJson.signerKeyId, buyerDecisionKeyId);
    assert.equal(repJson.actor?.email, "alice@example.com");

    // Offline verification story: bundle + decision + buyer public keys.
    const bundleRes = await runReq({ method: "GET", url: `/r/${up.token}/bundle.zip`, headers: {}, bodyChunks: [] });
    assert.equal(bundleRes.statusCode, 200);
    const bundleZipPath = path.join(dataDir, `offline_${up.token}.zip`);
    await fs.writeFile(bundleZipPath, bundleRes._body());

    const decisionPath = path.join(dataDir, `offline_${up.token}_decision.json`);
    await fs.writeFile(decisionPath, rep._body());

    const keysPath = path.join(dataDir, `offline_${up.token}_buyer_keys.json`);
    await fs.writeFile(keysPath, JSON.stringify({ [buyerDecisionKeyId]: buyerSigner.publicKeyPem }, null, 2) + "\n", "utf8");

    const nodeBin = path.join(REPO_ROOT, "packages", "artifact-verify", "bin", "settld-verify.js");
    const run = spawnSync(process.execPath, [nodeBin, "--format", "json", "--invoice-bundle", bundleZipPath, "--settlement-decision", decisionPath, "--trusted-buyer-keys", keysPath], {
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C" }
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const outJson = JSON.parse(run.stdout || "null");
    assert.equal(outJson.schemaVersion, "VerifyCliOutput.v1");
    assert.equal(outJson.ok, true);
    assert.equal(outJson.target.kind, "settlement-decision");

    const html = await runReq({ method: "GET", url: `/r/${up.token}`, headers: {}, bodyChunks: [] });
    assert.match(html._body().toString("utf8"), /Approved/);
  });

  await t.test("decision webhooks + lockout + auto closepack zip on approval", async () => {
    const tenantId = "tenant_decision_webhooks";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    const secret = "whsec_decision";
    await putTenantSettings({
      tenantId,
      patch: {
        settlementDecisionSigner: { signerKeyId: buyerDecisionKeyId, privateKeyPem: buyerSigner.privateKeyPem },
        webhooks: [{ url: "https://example.invalid/decision-hook", events: ["decision.approved", "decision.held"], secret, enabled: true }]
      }
    });

    const up = await uploadZip({ zipBuf: zipClose, mode: "strict", tenantId });
    const beforeDecisionWebhookFiles = await listFilesRecursive(path.join(dataDir, "webhooks", "record")).catch(() => []);

    const approveBody = Buffer.from(JSON.stringify({ decision: "approve", name: "Buyer", email: "buyer@example.com", note: "ok" }), "utf8");
    const approve = await runReq({
      method: "POST",
      url: `/r/${up.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(approveBody.length) },
      bodyChunks: [approveBody]
    });
    assert.equal(approve.statusCode, 200, approve._body().toString("utf8"));
    const approveJson = JSON.parse(approve._body().toString("utf8"));
    assert.equal(approveJson.ok, true);
    assert.equal(approveJson.decisionReport?.decision, "approve");
    assert.equal(approveJson.closePackZipUrl, `/r/${up.token}/closepack.zip`);

    const secondBody = Buffer.from(JSON.stringify({ decision: "hold", name: "Buyer", email: "buyer@example.com", note: "retry" }), "utf8");
    const second = await runReq({
      method: "POST",
      url: `/r/${up.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(secondBody.length) },
      bodyChunks: [secondBody]
    });
    assert.equal(second.statusCode, 409, second._body().toString("utf8"));
    const secondJson = JSON.parse(second._body().toString("utf8"));
    assert.equal(secondJson.ok, false);
    assert.equal(secondJson.code, "DECISION_ALREADY_RECORDED");

    const closepackZip = await runReq({ method: "GET", url: `/r/${up.token}/closepack.zip`, headers: {}, bodyChunks: [] });
    assert.equal(closepackZip.statusCode, 200, closepackZip._body().toString("utf8"));
    assert.equal(closepackZip._body().readUInt32LE(0), 0x04034b50); // PK\x03\x04

    const html = await runReq({ method: "GET", url: `/r/${up.token}`, headers: {}, bodyChunks: [] });
    assert.equal(html.statusCode, 200);
    assert.match(html._body().toString("utf8"), /read-only/i);
    assert.match(html._body().toString("utf8"), /Download ClosePack ZIP/);
    assert.match(html._body().toString("utf8"), /Download Audit Receipt/);

    const afterDecisionWebhookFiles = await listFilesRecursive(path.join(dataDir, "webhooks", "record")).catch(() => []);
    const newWebhookFiles = afterDecisionWebhookFiles.filter((fp) => !beforeDecisionWebhookFiles.includes(fp));
    assert.ok(newWebhookFiles.length >= 1);

    const decisionAttempt = (
      await Promise.all(
        newWebhookFiles.map(async (fp) => {
          const j = JSON.parse(await fs.readFile(fp, "utf8"));
          return j?.event === "decision.approved" && j?.url === "https://example.invalid/decision-hook" ? j : null;
        })
      )
    ).find(Boolean);
    assert.ok(decisionAttempt);
    assert.equal(decisionAttempt.url, "https://example.invalid/decision-hook");
    assert.ok(decisionAttempt.body);
    const payload = JSON.parse(decisionAttempt.body);
    assert.equal(payload.event, "decision.approved");
    assert.equal(payload.decision?.decision, "approve");
    assert.equal(payload.artifacts?.closePackZipUrl, `/r/${up.token}/closepack.zip`);
  });

  await t.test("auto decision: green approve with system actor + payment trigger outbox", async () => {
    const tenantId = "tenant_auto_decide_green";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({
      tenantId,
      patch: {
        settlementDecisionSigner: { signerKeyId: buyerDecisionKeyId, privateKeyPem: buyerSigner.privateKeyPem },
        decisionAuthEmailDomains: ["example.com"],
        autoDecision: {
          enabled: true,
          approveOnGreen: true,
          approveOnAmber: false,
          holdOnRed: false,
          templateIds: null,
          actorName: "Auto Decision Bot",
          actorEmail: "auto@settld.example"
        },
        paymentTriggers: { enabled: true, deliveryMode: "record" }
      }
    });

    const beforeOutbox = await listFilesRecursive(path.join(dataDir, "payment-trigger-outbox")).catch(() => []);
    const up = await uploadZip({ zipBuf: zipClose, mode: "strict", tenantId });
    assert.equal(up.autoDecision?.ok, true);
    assert.equal(up.autoDecision?.applied, true);
    assert.equal(up.autoDecision?.decision, "approve");
    assert.equal(up.autoDecision?.status, "green");

    const rep = await runReq({ method: "GET", url: `/r/${up.token}/settlement_decision_report.json`, headers: {}, bodyChunks: [] });
    assert.equal(rep.statusCode, 200, rep._body().toString("utf8"));
    const repJson = JSON.parse(rep._body().toString("utf8"));
    assert.equal(repJson.decision, "approve");
    assert.equal(repJson.actor?.auth?.method, "system_auto_decision");
    assert.equal(repJson.actor?.email, "auto@settld.example");

    const closePackZip = await runReq({ method: "GET", url: `/r/${up.token}/closepack.zip`, headers: {}, bodyChunks: [] });
    assert.equal(closePackZip.statusCode, 200, closePackZip._body().toString("utf8"));

    const afterOutbox = await listFilesRecursive(path.join(dataDir, "payment-trigger-outbox")).catch(() => []);
    const newOutbox = afterOutbox.filter((fp) => !beforeOutbox.includes(fp));
    assert.equal(newOutbox.length, 1);
    const trigger = JSON.parse(await fs.readFile(newOutbox[0], "utf8"));
    assert.equal(trigger.schemaVersion, "MagicLinkPaymentTrigger.v1");
    assert.equal(trigger.event, "payment.approval_ready");
    assert.equal(trigger.tenantId, tenantId);
    assert.equal(trigger.token, up.token);
    assert.equal(trigger.decision?.decision, "approve");

    const secondDecisionBody = Buffer.from(JSON.stringify({ decision: "hold", email: "approver@example.com", otp: "000000" }), "utf8");
    const secondDecision = await runReq({
      method: "POST",
      url: `/r/${up.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(secondDecisionBody.length) },
      bodyChunks: [secondDecisionBody]
    });
    assert.equal(secondDecision.statusCode, 409, secondDecision._body().toString("utf8"));

    const outboxAfterSecond = await listFilesRecursive(path.join(dataDir, "payment-trigger-outbox")).catch(() => []);
    assert.equal(outboxAfterSecond.length, afterOutbox.length, "payment trigger must remain idempotent");
  });

  await t.test("auto decision: red verification auto-holds", async () => {
    const tenantId = "tenant_auto_decide_red";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({
      tenantId,
      patch: {
        settlementDecisionSigner: { signerKeyId: buyerDecisionKeyId, privateKeyPem: buyerSigner.privateKeyPem },
        autoDecision: {
          enabled: true,
          approveOnGreen: false,
          approveOnAmber: false,
          holdOnRed: true,
          actorName: "Auto Hold Bot",
          actorEmail: "auto-hold@settld.example"
        }
      }
    });

    const up = await uploadZip({ zipBuf: zipCloseFail, mode: "strict", tenantId });
    assert.equal(up.verifyOk, false);
    assert.equal(up.autoDecision?.ok, true);
    assert.equal(up.autoDecision?.applied, true);
    assert.equal(up.autoDecision?.decision, "hold");
    assert.equal(up.autoDecision?.status, "red");

    const rep = await runReq({ method: "GET", url: `/r/${up.token}/settlement_decision_report.json`, headers: {}, bodyChunks: [] });
    assert.equal(rep.statusCode, 200, rep._body().toString("utf8"));
    const repJson = JSON.parse(rep._body().toString("utf8"));
    assert.equal(repJson.decision, "hold");
    assert.equal(repJson.actor?.auth?.method, "system_auto_decision");

    const closePackZip = await runReq({ method: "GET", url: `/r/${up.token}/closepack.zip`, headers: {}, bodyChunks: [] });
    assert.equal(closePackZip.statusCode, 404);
  });

  await t.test("payment trigger retry ops: list, run-once, dead-letter replay", async () => {
    const tenantId = "tenant_payment_retry_ops";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({
      tenantId,
      patch: {
        settlementDecisionSigner: { signerKeyId: buyerDecisionKeyId, privateKeyPem: buyerSigner.privateKeyPem },
        paymentTriggers: {
          enabled: true,
          deliveryMode: "webhook",
          webhookUrl: "http://127.0.0.1:1/payment-trigger",
          webhookSecret: "retry_secret"
        }
      }
    });

    const up = await uploadZip({ zipBuf: zipClose, mode: "strict", tenantId });
    const approveBody = Buffer.from(JSON.stringify({ decision: "approve", name: "Buyer", email: "buyer@example.com", note: "ok" }), "utf8");
    const approve = await runReq({
      method: "POST",
      url: `/r/${up.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(approveBody.length) },
      bodyChunks: [approveBody]
    });
    assert.equal(approve.statusCode, 200, approve._body().toString("utf8"));
    const approveJson = JSON.parse(approve._body().toString("utf8"));
    assert.equal(approveJson.ok, true);
    assert.equal(approveJson.paymentTrigger?.queued, true);
    const idempotencyKey = String(approveJson.paymentTrigger?.idempotencyKey ?? "");
    assert.ok(idempotencyKey.length >= 8);

    const listPending = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/payment-trigger-retries?state=pending`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(listPending.statusCode, 200, listPending._body().toString("utf8"));
    const listPendingJson = JSON.parse(listPending._body().toString("utf8"));
    assert.equal(listPendingJson.ok, true);
    assert.ok(Array.isArray(listPendingJson.rows));
    assert.ok(listPendingJson.rows.some((row) => row.token === up.token && row.idempotencyKey === idempotencyKey));

    const runOnceDeadLetter = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/payment-trigger-retries/run-once`,
      headers: { "x-api-key": "test_key", "content-type": "application/json" },
      bodyChunks: [Buffer.from("{}", "utf8")]
    });
    assert.equal(runOnceDeadLetter.statusCode, 200, runOnceDeadLetter._body().toString("utf8"));
    const runOnceDeadLetterJson = JSON.parse(runOnceDeadLetter._body().toString("utf8"));
    assert.ok(Number(runOnceDeadLetterJson.stats?.deadLettered ?? 0) >= 1);

    const listDead = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/payment-trigger-retries?state=dead-letter`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(listDead.statusCode, 200, listDead._body().toString("utf8"));
    const listDeadJson = JSON.parse(listDead._body().toString("utf8"));
    assert.equal(listDeadJson.ok, true);
    assert.ok(Array.isArray(listDeadJson.rows));
    assert.ok(listDeadJson.rows.some((row) => row.token === up.token && row.idempotencyKey === idempotencyKey));

    let deliveryCalls = 0;
    const deliveryServer = http.createServer((_req, res) => {
      deliveryCalls += 1;
      res.statusCode = 204;
      res.end("");
    });
    const { port } = await listenOnEphemeralLoopback(deliveryServer);
    await t.after(async () => {
      await new Promise((resolve) => deliveryServer.close(() => resolve()));
    });
    await putTenantSettings({
      tenantId,
      patch: {
        paymentTriggers: {
          enabled: true,
          deliveryMode: "webhook",
          webhookUrl: `http://127.0.0.1:${port}/payment-trigger`,
          webhookSecret: "retry_secret"
        }
      }
    });

    const replayBody = Buffer.from(JSON.stringify({ idempotencyKey, resetAttempts: true, useCurrentSettings: true }), "utf8");
    const replay = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/payment-trigger-retries/${encodeURIComponent(up.token)}/replay`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(replayBody.length) },
      bodyChunks: [replayBody]
    });
    assert.equal(replay.statusCode, 200, replay._body().toString("utf8"));
    const replayJson = JSON.parse(replay._body().toString("utf8"));
    assert.equal(replayJson.ok, true);
    assert.equal(replayJson.replayed?.state, "pending");

    const runOnceDeliver = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/payment-trigger-retries/run-once`,
      headers: { "x-api-key": "test_key", "content-type": "application/json" },
      bodyChunks: [Buffer.from("{}", "utf8")]
    });
    assert.equal(runOnceDeliver.statusCode, 200, runOnceDeliver._body().toString("utf8"));
    const runOnceDeliverJson = JSON.parse(runOnceDeliver._body().toString("utf8"));
    assert.ok(Number(runOnceDeliverJson.stats?.delivered ?? 0) >= 1);
    assert.ok(deliveryCalls >= 1);

    const listPendingAfter = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/payment-trigger-retries?state=pending`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    const listPendingAfterJson = JSON.parse(listPendingAfter._body().toString("utf8"));
    assert.ok(!listPendingAfterJson.rows.some((row) => row.token === up.token && row.idempotencyKey === idempotencyKey));

    const listDeadAfter = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/payment-trigger-retries?state=dead-letter`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    const listDeadAfterJson = JSON.parse(listDeadAfter._body().toString("utf8"));
    assert.ok(!listDeadAfterJson.rows.some((row) => row.token === up.token && row.idempotencyKey === idempotencyKey));
  });

  await t.test("webhook retry ops: list, run-once, dead-letter replay", async () => {
    const tenantId = "tenant_webhook_retry_ops";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await createTenant({
      tenantId,
      name: "Webhook Retry Tenant",
      contactEmail: "ops+webhook-retry@example.com",
      billingEmail: "billing+webhook-retry@example.com"
    });

    let deliveryCalls = 0;
    const deliveryServer = http.createServer((_req, res) => {
      deliveryCalls += 1;
      res.statusCode = 204;
      res.end("");
    });
    const { port } = await listenOnEphemeralLoopback(deliveryServer);
    await t.after(async () => {
      await new Promise((resolve) => deliveryServer.close(() => resolve()));
    });
    const webhookUrl = `http://127.0.0.1:${port}/hook`;

    await putTenantSettings({
      tenantId,
      patch: {
        webhooks: [{ url: webhookUrl, enabled: true, events: ["verification.completed", "verification.failed"], secret: null }]
      }
    });

    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });
    const recordDir = path.join(dataDir, "webhooks", "record");
    const beforeRecordFiles = await listFilesRecursive(recordDir).catch(() => []);

    const listPending = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries?state=pending`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(listPending.statusCode, 200, listPending._body().toString("utf8"));
    const listPendingJson = JSON.parse(listPending._body().toString("utf8"));
    assert.equal(listPendingJson.ok, true);
    assert.ok(Array.isArray(listPendingJson.rows));
    const pendingRow = listPendingJson.rows.find((row) => row.token === up.token && row.event === "verification.completed");
    assert.ok(pendingRow);
    assert.equal(pendingRow.provider, "webhook");
    const idempotencyKey = String(pendingRow.idempotencyKey ?? "");
    assert.ok(idempotencyKey.length >= 8);
    const listPendingWebhook = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries?state=pending&provider=webhook`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(listPendingWebhook.statusCode, 200, listPendingWebhook._body().toString("utf8"));
    const listPendingWebhookJson = JSON.parse(listPendingWebhook._body().toString("utf8"));
    assert.equal(listPendingWebhookJson.provider, "webhook");
    assert.ok(listPendingWebhookJson.rows.every((row) => row.provider === "webhook"));

    let deadRowFound = false;
    let listDeadJson = { rows: [] };
    for (let i = 0; i < 10; i += 1) {
      const runOnce = await runReq({
        method: "POST",
        url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries/run-once`,
        headers: { "x-api-key": "test_key", "content-type": "application/json" },
        bodyChunks: [Buffer.from("{}", "utf8")]
      });
      assert.equal(runOnce.statusCode, 200, runOnce._body().toString("utf8"));
      const listDead = await runReq({
        method: "GET",
        url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries?state=dead-letter`,
        headers: { "x-api-key": "test_key" },
        bodyChunks: []
      });
      assert.equal(listDead.statusCode, 200, listDead._body().toString("utf8"));
      listDeadJson = JSON.parse(listDead._body().toString("utf8"));
      assert.equal(listDeadJson.ok, true);
      assert.ok(Array.isArray(listDeadJson.rows));
      deadRowFound = listDeadJson.rows.some((row) => row.token === up.token && row.idempotencyKey === idempotencyKey);
      if (deadRowFound) break;
      // Backoff windows are exponential in production, so polling is needed for deterministic tests.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(deadRowFound, true);
    assert.ok(listDeadJson.rows.every((row) => row.provider === "webhook"));
    const listDeadSlack = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries?state=dead-letter&provider=slack`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(listDeadSlack.statusCode, 200, listDeadSlack._body().toString("utf8"));
    const listDeadSlackJson = JSON.parse(listDeadSlack._body().toString("utf8"));
    assert.equal(listDeadSlackJson.count, 0);

    const afterRecordFiles = await listFilesRecursive(recordDir).catch(() => []);
    const newRecordFiles = afterRecordFiles.filter((fp) => !beforeRecordFiles.includes(fp));
    const newRecordRows = await Promise.all(newRecordFiles.map(async (fp) => JSON.parse(await fs.readFile(fp, "utf8"))));
    const alertRow = newRecordRows.find((row) => row?.tenantId === tenantId && row?.event === "ops.webhook_retry.dead_letter_threshold");
    assert.ok(alertRow);
    assert.equal(alertRow.url, process.env.MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_URL);
    const alertBody = JSON.parse(String(alertRow.body ?? "{}"));
    assert.equal(alertBody.provider, "webhook");
    assert.ok(Number(alertBody.deadLetterCount ?? 0) >= 1);

    const stateBeforeReplayRes = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/integrations/state`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(stateBeforeReplayRes.statusCode, 200, stateBeforeReplayRes._body().toString("utf8"));
    const stateBeforeReplay = JSON.parse(stateBeforeReplayRes._body().toString("utf8"));
    assert.ok(Number(stateBeforeReplay.retryQueue?.deadLetterCount ?? 0) >= 1);
    assert.ok(Number(stateBeforeReplay.retryQueue?.byProvider?.webhook?.deadLetterCount ?? 0) >= 1);
    assert.ok(stateBeforeReplay.retryQueue?.latestDeadLetterByProvider?.webhook);

    await putTenantSettings({
      tenantId,
      patch: {
        webhooks: [{ url: webhookUrl, enabled: true, events: ["verification.completed", "verification.failed"], secret: "retry_secret_v1" }]
      }
    });

    const replayMismatchBody = Buffer.from(JSON.stringify({ idempotencyKey, provider: "slack", resetAttempts: true, useCurrentSettings: true }), "utf8");
    const replayMismatch = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries/${encodeURIComponent(up.token)}/replay?provider=slack`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(replayMismatchBody.length) },
      bodyChunks: [replayMismatchBody]
    });
    assert.equal(replayMismatch.statusCode, 409, replayMismatch._body().toString("utf8"));
    const replayMismatchJson = JSON.parse(replayMismatch._body().toString("utf8"));
    assert.equal(replayMismatchJson.code, "PROVIDER_MISMATCH");

    const replayBody = Buffer.from(JSON.stringify({ idempotencyKey, provider: "webhook", resetAttempts: true, useCurrentSettings: true }), "utf8");
    const replay = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries/${encodeURIComponent(up.token)}/replay?provider=webhook`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(replayBody.length) },
      bodyChunks: [replayBody]
    });
    assert.equal(replay.statusCode, 200, replay._body().toString("utf8"));
    const replayJson = JSON.parse(replay._body().toString("utf8"));
    assert.equal(replayJson.ok, true);
    assert.equal(replayJson.replayed?.state, "pending");
    assert.equal(replayJson.replayed?.provider, "webhook");

    const runOnceDeliver = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries/run-once`,
      headers: { "x-api-key": "test_key", "content-type": "application/json" },
      bodyChunks: [Buffer.from("{}", "utf8")]
    });
    assert.equal(runOnceDeliver.statusCode, 200, runOnceDeliver._body().toString("utf8"));
    const runOnceDeliverJson = JSON.parse(runOnceDeliver._body().toString("utf8"));
    assert.ok(Number(runOnceDeliverJson.stats?.delivered ?? 0) >= 1);
    assert.ok(deliveryCalls >= 1);

    const listPendingAfter = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries?state=pending`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    const listPendingAfterJson = JSON.parse(listPendingAfter._body().toString("utf8"));
    assert.ok(!listPendingAfterJson.rows.some((row) => row.token === up.token && row.idempotencyKey === idempotencyKey));

    const listDeadAfter = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries?state=dead-letter`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    const listDeadAfterJson = JSON.parse(listDeadAfter._body().toString("utf8"));
    assert.ok(!listDeadAfterJson.rows.some((row) => row.token === up.token && row.idempotencyKey === idempotencyKey));

    // Create another dead-letter and replay using replay-latest endpoint.
    await putTenantSettings({
      tenantId,
      patch: {
        webhooks: [{ url: webhookUrl, enabled: true, events: ["verification.completed", "verification.failed"], secret: null }]
      }
    });
    const up2 = await uploadZip({ zipBuf: zipClose, mode: "strict", tenantId });
    let deadRow2 = null;
    for (let i = 0; i < 10; i += 1) {
      const runOnce = await runReq({
        method: "POST",
        url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries/run-once`,
        headers: { "x-api-key": "test_key", "content-type": "application/json" },
        bodyChunks: [Buffer.from("{}", "utf8")]
      });
      assert.equal(runOnce.statusCode, 200, runOnce._body().toString("utf8"));
      const listDead = await runReq({
        method: "GET",
        url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries?state=dead-letter&provider=webhook`,
        headers: { "x-api-key": "test_key" },
        bodyChunks: []
      });
      assert.equal(listDead.statusCode, 200, listDead._body().toString("utf8"));
      const listDeadJson2 = JSON.parse(listDead._body().toString("utf8"));
      deadRow2 = listDeadJson2.rows.find((row) => row.token === up2.token) ?? null;
      if (deadRow2) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.ok(deadRow2);

    await putTenantSettings({
      tenantId,
      patch: {
        webhooks: [{ url: webhookUrl, enabled: true, events: ["verification.completed", "verification.failed"], secret: "retry_secret_v1" }]
      }
    });

    const replayLatestBody = Buffer.from(JSON.stringify({ provider: "webhook", resetAttempts: true, useCurrentSettings: true }), "utf8");
    const replayLatest = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries/replay-latest?provider=webhook`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(replayLatestBody.length) },
      bodyChunks: [replayLatestBody]
    });
    assert.equal(replayLatest.statusCode, 200, replayLatest._body().toString("utf8"));
    const replayLatestJson = JSON.parse(replayLatest._body().toString("utf8"));
    assert.equal(replayLatestJson.ok, true);
    assert.equal(replayLatestJson.provider, "webhook");
    assert.equal(replayLatestJson.latest?.token, up2.token);
    assert.equal(replayLatestJson.replayed?.provider, "webhook");

    const runOnceDeliver2 = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries/run-once`,
      headers: { "x-api-key": "test_key", "content-type": "application/json" },
      bodyChunks: [Buffer.from("{}", "utf8")]
    });
    assert.equal(runOnceDeliver2.statusCode, 200, runOnceDeliver2._body().toString("utf8"));
    const runOnceDeliver2Json = JSON.parse(runOnceDeliver2._body().toString("utf8"));
    assert.ok(Number(runOnceDeliver2Json.stats?.delivered ?? 0) >= 1);
  });

  await t.test("decision auth: email OTP required when tenant allowlist is configured", async () => {
    const tenantId = "tenant_decision_otp";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({
      tenantId,
      patch: { decisionAuthEmailDomains: ["example.com"], settlementDecisionSigner: { signerKeyId: buyerDecisionKeyId, privateKeyPem: buyerSigner.privateKeyPem } }
    });

    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });

    const missingOtpBuf = Buffer.from(JSON.stringify({ decision: "approve", email: "alice@example.com", note: "ok" }), "utf8");
    const missingOtp = await runReq({
      method: "POST",
      url: `/r/${up.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(missingOtpBuf.length) },
      bodyChunks: [missingOtpBuf]
    });
    assert.equal(missingOtp.statusCode, 400);
    const missingOtpJson = JSON.parse(missingOtp._body().toString("utf8"));
    assert.equal(missingOtpJson.ok, false);
    assert.equal(missingOtpJson.code, "OTP_REQUIRED");

    const reqBuf = Buffer.from(JSON.stringify({ email: "alice@example.com" }), "utf8");
    const otpReq = await runReq({
      method: "POST",
      url: `/r/${up.token}/otp/request`,
      headers: { "content-type": "application/json", "content-length": String(reqBuf.length) },
      bodyChunks: [reqBuf]
    });
    assert.equal(otpReq.statusCode, 200, otpReq._body().toString("utf8"));

    const code = await readDecisionOtpOutboxCode({ token: up.token, email: "alice@example.com" });
    assert.ok(code && /^[0-9]{6}$/.test(code));

    const okBuf = Buffer.from(JSON.stringify({ decision: "approve", email: "alice@example.com", otp: code, note: "ok" }), "utf8");
    const ok = await runReq({
      method: "POST",
      url: `/r/${up.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(okBuf.length) },
      bodyChunks: [okBuf]
    });
    assert.equal(ok.statusCode, 200, ok._body().toString("utf8"));
    const okJson = JSON.parse(ok._body().toString("utf8"));
    assert.equal(okJson.ok, true);
    assert.equal(okJson.decisionReport?.schemaVersion, "SettlementDecisionReport.v1");
    assert.equal(okJson.decisionReport?.actor?.auth?.method, "email_otp");
    assert.equal(okJson.decisionReport?.actor?.email, "alice@example.com");

    const rep = await runReq({ method: "GET", url: `/r/${up.token}/settlement_decision_report.json`, headers: {}, bodyChunks: [] });
    assert.equal(rep.statusCode, 200);
    const repJson = JSON.parse(rep._body().toString("utf8"));
    assert.equal(repJson.schemaVersion, "SettlementDecisionReport.v1");
    assert.equal(repJson.actor?.auth?.method, "email_otp");
    assert.equal(repJson.actor?.email, "alice@example.com");
  });

  await t.test("buyer pack: ingest keys → inbox → exports", async () => {
    const tenantId = "buyer_network";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = "";
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = "";

    await putTenantSettings({
      tenantId,
      patch: {
        governanceTrustRootsJson: trust.governanceRoots ?? {},
        pricingSignerKeysJson: trust.pricingSigners ?? {},
        webhooks: [{ url: "https://example.invalid/hook", events: ["verification.completed"], secret: "whsec_demo", enabled: true }]
      }
    });

    const key = await createIngestKey({ tenantId, vendorId: "vendor_a", vendorName: "Vendor A" });
    const up = await ingestZip({ zipBuf: zip, mode: "auto", tenantId, ingestKey: key.ingestKey, contractId: "contract_1" });
    assert.equal(up.modeResolved, "strict");

    const inbox = await getInbox({ tenantId, query: { vendorId: "vendor_a" } });
    assert.equal(inbox.schemaVersion, "MagicLinkInbox.v1");
    assert.ok(Array.isArray(inbox.rows));
    assert.ok(inbox.rows.length >= 1);
    assert.equal(inbox.rows[0].vendorId, "vendor_a");
    assert.equal(inbox.rows[0].contractId, "contract_1");
    assert.equal(inbox.rows[0].status, "green");

    const month = (() => {
      const d = new Date();
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      return `${y}-${m}`;
    })();

    const csv = await getTenantCsvExport({ tenantId, month });
    assert.match(csv.split("\n")[0], /^invoiceId,vendorId,contractId,totalCents,currency,pricing_terms_signed,status,mode,/);
    assert.match(csv, /vendor_a/);

    const auditZip = await getTenantAuditPacket({ tenantId, month });
    const zipPath = path.join(dataDir, "tmp_audit.zip");
    await fs.writeFile(zipPath, auditZip);
    const unzip = await unzipToTempSafe({
      zipPath,
      budgets: { maxEntries: 5000, maxPathBytes: 512, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024, maxCompressionRatio: 50 }
    });
    assert.equal(unzip.ok, true);
    const index = JSON.parse(await fs.readFile(path.join(unzip.dir, "index.json"), "utf8"));
    assert.equal(index.schemaVersion, "MagicLinkMonthlyAuditPacketIndex.v1");
    assert.equal(index.tenantId, tenantId);
    assert.equal(index.month, month);
    assert.ok(Array.isArray(index.runs));
    assert.ok(index.runs.find((r) => r.vendorId === "vendor_a"));

    const webhookFiles = await listFilesRecursive(path.join(unzip.dir, "webhooks", "record")).catch(() => []);
    assert.ok(webhookFiles.length >= 1);
  });

  await t.test("inbox: run-record rows still load after index/meta/public files are removed", async () => {
    const tenantId = "tenant_inbox_run_record_only";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = "";
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = "";

    await putTenantSettings({
      tenantId,
      patch: {
        governanceTrustRootsJson: trust.governanceRoots ?? {},
        pricingSignerKeysJson: trust.pricingSigners ?? {}
      }
    });

    const up = await uploadZip({ zipBuf: zipClose, mode: "strict", tenantId });
    assert.equal(up.modeResolved, "strict");

    await fs.rm(path.join(dataDir, "index", tenantId), { recursive: true, force: true });
    await fs.rm(path.join(dataDir, "meta", `${up.token}.json`), { force: true });
    await fs.rm(path.join(dataDir, "public", `${up.token}.json`), { force: true });

    const inbox = await getInbox({ tenantId, query: { status: "green" } });
    const row = inbox.rows.find((r) => r && r.token === up.token);
    assert.ok(row, "inbox should return run via run record fallback");
    assert.equal(row.status, "green");
    assert.equal(row.closePack?.slaStatus, "pass");
    assert.ok(row.closePack?.acceptanceStatus === "pass" || row.closePack?.acceptanceStatus === "fail");
  });

  await t.test("security & controls packet: exports settings, budgets, and audit log", async () => {
    const tenantId = "tenant_security_controls";
    const month = monthKeyUtcNow();

    await putTenantSettings({ tenantId, patch: { decisionAuthEmailDomains: ["example.com"] } });

    const zipBuf = await getTenantSecurityControlsPacket({ tenantId, month });
    const zipPath = path.join(dataDir, "tmp_controls.zip");
    await fs.writeFile(zipPath, zipBuf);
    const unzip = await unzipToTempSafe({
      zipPath,
      budgets: { maxEntries: 5000, maxPathBytes: 512, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024, maxCompressionRatio: 50 }
    });
    assert.equal(unzip.ok, true);
    const index = JSON.parse(await fs.readFile(path.join(unzip.dir, "index.json"), "utf8"));
    assert.equal(index.schemaVersion, "MagicLinkSecurityControlsPacketIndex.v1");
    assert.equal(index.tenantId, tenantId);
    assert.equal(index.month, month);
    assert.ok(index.budgets?.unzip?.maxEntries >= 1);
    assert.ok(Array.isArray(index.settings?.decisionAuthEmailDomains));

    const auditLog = await fs.readFile(path.join(unzip.dir, "audit_log.jsonl"), "utf8");
    assert.match(auditLog, /TENANT_SETTINGS_PUT/);

    const allowlist = JSON.parse(await fs.readFile(path.join(unzip.dir, "redaction_allowlist.json"), "utf8"));
    assert.equal(allowlist.schemaVersion, "MagicLinkRenderModelAllowlist.v1");
    const retention = JSON.parse(await fs.readFile(path.join(unzip.dir, "retention_behavior.json"), "utf8"));
    assert.equal(retention.schemaVersion, "MagicLinkRetentionBehavior.v1");

    const inventory = JSON.parse(await fs.readFile(path.join(unzip.dir, "data_inventory.json"), "utf8"));
    assert.equal(inventory.schemaVersion, "MagicLinkDataInventory.v1");

    const packetIndex = JSON.parse(await fs.readFile(path.join(unzip.dir, "packet_index.json"), "utf8"));
    assert.equal(packetIndex.schemaVersion, "MagicLinkSecurityPacketIndex.v1");
    assert.ok(Array.isArray(packetIndex.files));
    assert.ok(packetIndex.files.some((f) => f && f.path === "index.json"));
    assert.ok(packetIndex.files.some((f) => f && f.path === "pilot-kit/security-qa.md"));

    const checksums = await fs.readFile(path.join(unzip.dir, "checksums.sha256"), "utf8");
    assert.match(checksums, /  index\.json\n/);
    assert.match(checksums, /  packet_index\.json\n/);
  });

  await t.test("support bundle: exports metadata + verify outputs + redacted settings", async () => {
    const tenantId = "tenant_a";
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 24 * 3600_000).toISOString();
    const zipBuf = await getTenantSupportBundle({ tenantId, from, to, includeBundles: false });

    const zipPath = path.join(dataDir, "tmp_support.zip");
    await fs.writeFile(zipPath, zipBuf);
    const unzip = await unzipToTempSafe({
      zipPath,
      budgets: { maxEntries: 10_000, maxPathBytes: 512, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024, maxCompressionRatio: 50 }
    });
    assert.equal(unzip.ok, true);
    const index = JSON.parse(await fs.readFile(path.join(unzip.dir, "index.json"), "utf8"));
    assert.equal(index.schemaVersion, "MagicLinkSupportBundle.v1");
    assert.equal(index.tenantId, tenantId);
    assert.ok(index.runsCount >= 1);

    const settings = JSON.parse(await fs.readFile(path.join(unzip.dir, "tenant_settings_redacted.json"), "utf8"));
    assert.equal(settings.schemaVersion, "TenantSettings.v2");

    // No raw bundles by default.
    const all = await listFilesRecursive(unzip.dir);
    assert.ok(!all.some((fp) => fp.endsWith(path.join("bundle.zip"))));

    // Run records should be present (metadata-only survives retention).
    assert.ok(all.some((fp) => fp.endsWith(path.join("run_record.json"))));
  });

  await t.test("archive export: dry-run writes monthly audit packet + CSV and stores marker", async () => {
    const tenantId = "tenant_a";
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    await putTenantSettings({
      tenantId,
      patch: {
        archiveExportSink: {
          type: "s3",
          enabled: true,
          endpoint: "https://s3.example.invalid",
          region: null,
          bucket: "demo-bucket",
          prefix: "settld-demo",
          pathStyle: true,
          accessKeyId: "AKIA_TEST",
          secretAccessKey: "SECRET_TEST",
          sessionToken: null,
          sse: "none",
          kmsKeyId: null
        }
      }
    });

    const res = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/archive-export?month=${encodeURIComponent(month)}&dryRun=1&force=1`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: [Buffer.from("", "utf8")]
    });
    assert.equal(res.statusCode, 200);
    const j = JSON.parse(res._body().toString("utf8"));
    assert.equal(j.ok, true);
    assert.equal(j.tenantId, tenantId);
    assert.equal(j.month, month);
    assert.equal(j.dryRun, true);

    const outDir = path.join(dataDir, "exports_outbox", tenantId, month);
    const auditZipFp = path.join(outDir, `audit_packet_${tenantId}_${month}.zip`);
    const csvFp = path.join(outDir, `export_${tenantId}_${month}.csv`);
    assert.ok((await fs.readFile(auditZipFp)).length > 0);
    assert.ok((await fs.readFile(csvFp, "utf8")).includes("invoiceId"));

    const markerFp = path.join(dataDir, "exports", "archive_export", tenantId, `${month}.json`);
    const marker = JSON.parse(await fs.readFile(markerFp, "utf8"));
    assert.equal(marker.schemaVersion, "MagicLinkArchiveExportMarker.v1");
    assert.equal(marker.ok, true);
    assert.equal(marker.month, month);
    assert.equal(Array.isArray(marker.results), true);
    assert.equal(marker.results.length, 2);
  });

  await t.test("retention GC: deletes blobs + webhook records but keeps run record", async () => {
    const tenantId = "tenant_retention";
    await putTenantSettings({ tenantId, patch: { retentionDays: 1 } });
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const up = await uploadZip({ zipBuf: zip, mode: "strict", tenantId });
    const token = up.token;

    const runRecordFp = path.join(dataDir, "runs", tenantId, `${token}.json`);
    assert.ok((await fs.readFile(runRecordFp, "utf8")).includes("MagicLinkRunRecord.v1"));

    // Seed webhook files for this token (retention should delete them).
    await fs.mkdir(path.join(dataDir, "webhooks", "record"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "webhooks", "attempts"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "webhook_retry", "pending"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "webhook_retry", "dead-letter"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "webhooks", "record", `${token}_${Date.now()}_0.json`), JSON.stringify({ tenantId, token }) + "\n", "utf8");
    await fs.writeFile(path.join(dataDir, "webhooks", "attempts", `${token}_${Date.now()}_0.json`), JSON.stringify({ tenantId, token }) + "\n", "utf8");
    await fs.writeFile(
      path.join(dataDir, "webhook_retry", "pending", `${tenantId}_${token}_seed_pending.json`),
      JSON.stringify({ tenantId, token }) + "\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(dataDir, "webhook_retry", "dead-letter", `${tenantId}_${token}_seed_dead.json`),
      JSON.stringify({ tenantId, token }) + "\n",
      "utf8"
    );

    // Force the run to be past retention by backdating meta.createdAt.
    const metaFp = path.join(dataDir, "meta", `${token}.json`);
    const meta = JSON.parse(await fs.readFile(metaFp, "utf8"));
    meta.createdAt = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    await fs.writeFile(metaFp, JSON.stringify(meta, null, 2) + "\n", "utf8");

    const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
    const swept = await garbageCollectTenantByRetention({ dataDir, tenantId, tenantSettings });
    assert.equal(swept.ok, true);

    // Heavy artifacts should be gone.
    const mustBeGone = [
      path.join(dataDir, "zips", `${token}.zip`),
      path.join(dataDir, "verify", `${token}.json`),
      path.join(dataDir, "public", `${token}.json`),
      path.join(dataDir, "pdf", `${token}.pdf`)
    ];
    for (const fp of mustBeGone) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await fs.stat(fp).then(() => true).catch(() => false);
      assert.equal(exists, false, `expected deleted: ${fp}`);
    }

    // Dedupe index should be gone so quota accounting is unblocked.
    {
      const idxFp = path.join(dataDir, "index", tenantId, `${up.zipSha256}.json`);
      const exists = await fs.stat(idxFp).then(() => true).catch(() => false);
      assert.equal(exists, false, `expected deleted: ${idxFp}`);
    }

    // Minimal run record should remain.
    {
      const exists = await fs.stat(runRecordFp).then(() => true).catch(() => false);
      assert.equal(exists, true);
    }

    // Webhook delivery records and retry queue entries should be gone.
    {
      const rec = await fs.readdir(path.join(dataDir, "webhooks", "record")).catch(() => []);
      const att = await fs.readdir(path.join(dataDir, "webhooks", "attempts")).catch(() => []);
      const retryPending = await fs.readdir(path.join(dataDir, "webhook_retry", "pending")).catch(() => []);
      const retryDead = await fs.readdir(path.join(dataDir, "webhook_retry", "dead-letter")).catch(() => []);
      assert.ok(!rec.some((n) => n.startsWith(`${token}_`)));
      assert.ok(!att.some((n) => n.startsWith(`${token}_`)));
      assert.ok(!retryPending.some((n) => n.includes(`_${token}_`)));
      assert.ok(!retryDead.some((n) => n.includes(`_${token}_`)));
    }

    // Support bundle should still include metadata-only run record.
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
    const zipBuf = await getTenantSupportBundle({ tenantId, from, to, includeBundles: false });
    const zipPath = path.join(dataDir, "tmp_support_retention.zip");
    await fs.writeFile(zipPath, zipBuf);
    const unzip = await unzipToTempSafe({
      zipPath,
      budgets: { maxEntries: 10_000, maxPathBytes: 512, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024, maxCompressionRatio: 50 }
    });
    assert.equal(unzip.ok, true);
    const all = await listFilesRecursive(unzip.dir);
    assert.ok(all.some((fp) => fp.endsWith(path.join("runs", token, "run_record.json"))));
  });

  await t.test("vendor onboarding pack: generates ingest key + includes pricing terms (optional)", async () => {
    const tenantId = "tenant_vendor_pack";
    const vendorId = "vendor_pack";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});

    const pricingMatrixJsonText = await fs.readFile(path.join(fxDir, "pricing", "pricing_matrix.json"), "utf8");
    const pricingMatrixSignaturesJsonText = await fs.readFile(path.join(fxDir, "pricing", "pricing_matrix_signatures.json"), "utf8");

    const body = Buffer.from(
      JSON.stringify({
        vendorName: "Vendor Pack",
        contractId: "contract_pack_1",
        pricingMatrixJsonText,
        pricingMatrixSignaturesJsonText
      }),
      "utf8"
    );
    const pack = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/vendors/${encodeURIComponent(vendorId)}/onboarding-pack`,
      headers: { "x-api-key": "test_key", "content-type": "application/json", "content-length": String(body.length) },
      bodyChunks: [body]
    });
    assert.equal(pack.statusCode, 200, pack._body().toString("utf8"));
    assert.equal(pack.getHeader("content-type"), "application/zip");

    const zipPath = path.join(dataDir, "tmp_pack.zip");
    await fs.writeFile(zipPath, pack._body());
    const unzip = await unzipToTempSafe({
      zipPath,
      budgets: { maxEntries: 5000, maxPathBytes: 512, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024, maxCompressionRatio: 50 }
    });
    assert.equal(unzip.ok, true);

    const ingestKey = (await fs.readFile(path.join(unzip.dir, "ingest_key.txt"), "utf8")).trim();
    assert.ok(ingestKey.startsWith("igk_"));
    const meta = JSON.parse(await fs.readFile(path.join(unzip.dir, "metadata.json"), "utf8"));
    assert.equal(meta.schemaVersion, "VendorOnboardingPack.v1");
    assert.equal(meta.tenantId, tenantId);
    assert.equal(meta.vendorId, vendorId);
    assert.equal(meta.contractId, "contract_pack_1");
    assert.equal(await fs.readFile(path.join(unzip.dir, "pricing", "pricing_matrix.json"), "utf8"), pricingMatrixJsonText);
    assert.equal(await fs.readFile(path.join(unzip.dir, "pricing", "pricing_matrix_signatures.json"), "utf8"), pricingMatrixSignaturesJsonText);

    const up = await ingestZip({ zipBuf: zip, mode: "auto", tenantId, ingestKey, contractId: "contract_pack_1" });
    assert.match(String(up.token), /^ml_[0-9a-f]{48}$/);
  });

  await t.test("vendor policy: fail-on-warnings and amber approval gating", async () => {
    const tenantId = "tenant_vendor_policy";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = "";
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = "";

    const fxWarn = path.join(REPO_ROOT, "test", "fixtures", "bundles", "v1", "invoicebundle", "nonstrict-pass-missing-verification-report");
    const zipWarn = await zipDir(fxWarn);

    const key = await createIngestKey({ tenantId, vendorId: "vendor_warn", vendorName: "Vendor Warn" });

    await putTenantSettings({
      tenantId,
      patch: {
        defaultMode: "compat",
        vendorPolicies: {
          vendor_warn: { requiredMode: "compat", allowAmberApprovals: false, failOnWarnings: false }
        }
      }
    });

    const upAmber = await ingestZip({ zipBuf: zipWarn, mode: "compat", tenantId, ingestKey: key.ingestKey });
    const verifyAmber = await runReq({ method: "GET", url: `/r/${upAmber.token}/verify.json`, headers: {}, bodyChunks: [] });
    const vAmber = JSON.parse(verifyAmber._body().toString("utf8"));
    assert.equal(vAmber.ok, true);
    assert.ok(Array.isArray(vAmber.warnings) && vAmber.warnings.length >= 1);

    const form = Buffer.from("decision=approve&name=Bob&email=bob%40example.com&note=try", "utf8");
    const post = await runReq({
      method: "POST",
      url: `/r/${upAmber.token}/decision`,
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(form.length) },
      bodyChunks: [form]
    });
    assert.equal(post.statusCode, 400);
    const postJson = JSON.parse(post._body().toString("utf8"));
    assert.equal(postJson.code, "APPROVE_FORBIDDEN");

    await putTenantSettings({
      tenantId,
      patch: {
        vendorPolicies: {
          vendor_warn: { requiredMode: "compat", failOnWarnings: true }
        }
      }
    });

    const upFail = await ingestZip({ zipBuf: zipWarn, mode: "compat", tenantId, ingestKey: key.ingestKey });
    const verifyFail = await runReq({ method: "GET", url: `/r/${upFail.token}/verify.json`, headers: {}, bodyChunks: [] });
    const vFail = JSON.parse(verifyFail._body().toString("utf8"));
    assert.equal(vFail.ok, false);
    const errCodes = Array.isArray(vFail.errors) ? vFail.errors.map((e) => e.code) : [];
    assert.ok(errCodes.includes("FAIL_ON_WARNINGS"));
  });

  await t.test("vendor policy: pricing matrix signer key allowlist", async () => {
    const tenantId = "tenant_policy_signer";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = "";
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = "";
    await putTenantSettings({ tenantId, patch: { governanceTrustRootsJson: trust.governanceRoots ?? {}, pricingSignerKeysJson: trust.pricingSigners ?? {} } });

    const key = await createIngestKey({ tenantId, vendorId: "vendor_sig", vendorName: "Vendor Sig" });
    await putTenantSettings({
      tenantId,
      patch: {
        vendorPolicies: { vendor_sig: { requiredMode: "strict", requiredPricingMatrixSignerKeyIds: ["key_not_allowed"] } }
      }
    });

    const up = await ingestZip({ zipBuf: zip, mode: "strict", tenantId, ingestKey: key.ingestKey });
    const verify = await runReq({ method: "GET", url: `/r/${up.token}/verify.json`, headers: {}, bodyChunks: [] });
    const v = JSON.parse(verify._body().toString("utf8"));
    assert.equal(v.verificationOk, true);
    assert.equal(v.ok, false);
    const errCodes = Array.isArray(v.errors) ? v.errors.map((e) => e.code) : [];
    assert.ok(errCodes.includes("HOSTED_POLICY_PRICING_MATRIX_SIGNER_KEYID_NOT_ALLOWED") || errCodes.includes("HOSTED_POLICY_PRICING_MATRIX_SIGNER_KEYID_MISSING"));
  });

  await t.test("buyer auth: OTP login establishes session and enforces roles", async () => {
    const tenantId = "tenant_buyer_rbac";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = "";
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = "";
    await putTenantSettings({
      tenantId,
      patch: {
        buyerAuthEmailDomains: ["buyer.example"],
        buyerUserRoles: {
          "admin@buyer.example": "admin",
          "approver@buyer.example": "approver"
        }
      }
    });

    async function login(email) {
      const otpReqBuf = Buffer.from(JSON.stringify({ email }), "utf8");
      const otpRes = await runReq({
        method: "POST",
        url: `/v1/tenants/${encodeURIComponent(tenantId)}/buyer/login/otp`,
        headers: { "content-type": "application/json", "content-length": String(otpReqBuf.length) },
        bodyChunks: [otpReqBuf]
      });
      assert.equal(otpRes.statusCode, 200, otpRes._body().toString("utf8"));
      const code = await readBuyerOtpOutboxCode({ tenantId, email });
      assert.match(String(code), /^[0-9]{6}$/);

      const loginBuf = Buffer.from(JSON.stringify({ email, code }), "utf8");
      const loginRes = await runReq({
        method: "POST",
        url: `/v1/tenants/${encodeURIComponent(tenantId)}/buyer/login`,
        headers: { "content-type": "application/json", "content-length": String(loginBuf.length) },
        bodyChunks: [loginBuf]
      });
      assert.equal(loginRes.statusCode, 200, loginRes._body().toString("utf8"));
      const setCookie = loginRes.getHeader("set-cookie");
      assert.ok(setCookie);
      const cookieHeader = String(setCookie).split(";")[0];
      const json = JSON.parse(loginRes._body().toString("utf8"));
      assert.equal(json.ok, true);
      return { cookieHeader, json };
    }

    // Viewer by default.
    const viewer = await login("viewer@buyer.example");
    assert.equal(viewer.json.role, "viewer");
    const inboxRes = await runReq({ method: "GET", url: "/v1/inbox", headers: { cookie: viewer.cookieHeader }, bodyChunks: [] });
    assert.equal(inboxRes.statusCode, 200, inboxRes._body().toString("utf8"));
    const inboxJson = JSON.parse(inboxRes._body().toString("utf8"));
    assert.equal(inboxJson.ok, true);

    const viewerSettingsRes = await runReq({ method: "GET", url: `/v1/tenants/${encodeURIComponent(tenantId)}/settings`, headers: { cookie: viewer.cookieHeader }, bodyChunks: [] });
    assert.equal(viewerSettingsRes.statusCode, 403);

    const viewerExportRes = await runReq({ method: "GET", url: `/v1/tenants/${encodeURIComponent(tenantId)}/export.csv`, headers: { cookie: viewer.cookieHeader }, bodyChunks: [] });
    assert.equal(viewerExportRes.statusCode, 403);

    // Approver can export but can't manage settings.
    const approver = await login("approver@buyer.example");
    assert.equal(approver.json.role, "approver");
    const exportRes = await runReq({ method: "GET", url: `/v1/tenants/${encodeURIComponent(tenantId)}/export.csv?month=${encodeURIComponent(monthKeyUtcNow())}`, headers: { cookie: approver.cookieHeader }, bodyChunks: [] });
    assert.equal(exportRes.statusCode, 200, exportRes._body().toString("utf8"));
    assert.match(String(exportRes.getHeader("content-type")), /^text\/csv/);
    const approverSettingsRes = await runReq({ method: "GET", url: `/v1/tenants/${encodeURIComponent(tenantId)}/settings`, headers: { cookie: approver.cookieHeader }, bodyChunks: [] });
    assert.equal(approverSettingsRes.statusCode, 403);

    // Admin can manage settings.
    const admin = await login("admin@buyer.example");
    assert.equal(admin.json.role, "admin");
    const meRes = await runReq({ method: "GET", url: "/v1/buyer/me", headers: { cookie: admin.cookieHeader }, bodyChunks: [] });
    assert.equal(meRes.statusCode, 200);
    const meJson = JSON.parse(meRes._body().toString("utf8"));
    assert.equal(meJson.ok, true);
    assert.equal(meJson.principal.email, "admin@buyer.example");
    assert.equal(meJson.principal.role, "admin");

    const adminSettingsRes = await runReq({ method: "GET", url: `/v1/tenants/${encodeURIComponent(tenantId)}/settings`, headers: { cookie: admin.cookieHeader }, bodyChunks: [] });
    assert.equal(adminSettingsRes.statusCode, 200, adminSettingsRes._body().toString("utf8"));
    const adminSettingsJson = JSON.parse(adminSettingsRes._body().toString("utf8"));
    assert.equal(adminSettingsJson.ok, true);

    const viewerUsersRes = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/buyer/users`,
      headers: { cookie: viewer.cookieHeader },
      bodyChunks: []
    });
    assert.equal(viewerUsersRes.statusCode, 403);

    const upsertUserBody = Buffer.from(
      JSON.stringify({
        email: "ops@buyer.example",
        role: "approver",
        fullName: "Ops Approver",
        company: "Buyer Inc"
      }),
      "utf8"
    );
    const upsertUserRes = await runReq({
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/buyer/users`,
      headers: {
        cookie: admin.cookieHeader,
        "content-type": "application/json",
        "content-length": String(upsertUserBody.length)
      },
      bodyChunks: [upsertUserBody]
    });
    assert.equal(upsertUserRes.statusCode, 200, upsertUserRes._body().toString("utf8"));
    const upsertUserJson = JSON.parse(upsertUserRes._body().toString("utf8"));
    assert.equal(upsertUserJson.ok, true);
    assert.equal(upsertUserJson.user.email, "ops@buyer.example");
    assert.equal(upsertUserJson.user.role, "approver");

    const usersRes = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/buyer/users`,
      headers: { cookie: admin.cookieHeader },
      bodyChunks: []
    });
    assert.equal(usersRes.statusCode, 200, usersRes._body().toString("utf8"));
    const usersJson = JSON.parse(usersRes._body().toString("utf8"));
    assert.equal(usersJson.ok, true);
    assert.ok(Array.isArray(usersJson.users));
    assert.ok(usersJson.users.some((row) => row.email === "admin@buyer.example" && row.role === "admin"));
    assert.ok(usersJson.users.some((row) => row.email === "ops@buyer.example" && row.role === "approver"));

    const logoutRes = await runReq({ method: "POST", url: "/v1/buyer/logout", headers: { cookie: admin.cookieHeader }, bodyChunks: [] });
    assert.equal(logoutRes.statusCode, 200, logoutRes._body().toString("utf8"));
    assert.ok(String(logoutRes.getHeader("set-cookie")).includes("Max-Age=0"));
    const meAfterLogout = await runReq({ method: "GET", url: "/v1/buyer/me", headers: {}, bodyChunks: [] });
    assert.equal(meAfterLogout.statusCode, 401);
  });

  await t.test("public signup: creates tenant, admin role, and OTP", async () => {
    const signupBody = Buffer.from(
      JSON.stringify({
        company: "Nova Robotics",
        fullName: "Founder",
        email: "founder@nova.example"
      }),
      "utf8"
    );
    const signupRes = await runReq({
      method: "POST",
      url: "/v1/public/signup",
      headers: {
        "content-type": "application/json",
        "content-length": String(signupBody.length)
      },
      bodyChunks: [signupBody]
    });
    assert.equal(signupRes.statusCode, 201, signupRes._body().toString("utf8"));
    const signupJson = JSON.parse(signupRes._body().toString("utf8"));
    assert.equal(signupJson.ok, true);
    assert.equal(signupJson.email, "founder@nova.example");
    assert.equal(signupJson.otpIssued, true);
    assert.ok(typeof signupJson.tenantId === "string" && signupJson.tenantId.length > 0);
    const tenantId = signupJson.tenantId;

    const settings = await loadTenantSettings({ dataDir, tenantId });
    assert.ok(Array.isArray(settings.buyerAuthEmailDomains));
    assert.ok(settings.buyerAuthEmailDomains.includes("nova.example"));
    assert.equal(settings.buyerUserRoles?.["founder@nova.example"], "admin");

    const code = await readBuyerOtpOutboxCode({ tenantId, email: "founder@nova.example" });
    assert.match(String(code), /^[0-9]{6}$/);
  });

  await t.test("analytics + trust graph: aggregates by vendor and contract", async () => {
    const tenantId = "tenant_analytics_graph";
    const month = monthKeyUtcNow();
    const previousMonth = (() => {
      const y = Number.parseInt(month.slice(0, 4), 10);
      const m = Number.parseInt(month.slice(5, 7), 10);
      const yy = m === 1 ? y - 1 : y;
      const mm = m === 1 ? 12 : m - 1;
      return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}`;
    })();
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = JSON.stringify(trust.governanceRoots ?? {});
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = JSON.stringify(trust.pricingSigners ?? {});
    await putTenantSettings({
      tenantId,
      patch: {
        settlementDecisionSigner: { signerKeyId: buyerDecisionKeyId, privateKeyPem: buyerSigner.privateKeyPem }
      }
    });

    async function uploadWithMeta({ zipBuf, mode, vendorId, contractId }) {
      const u = new URL("/v1/upload", "http://localhost");
      if (mode) u.searchParams.set("mode", mode);
      if (vendorId) u.searchParams.set("vendorId", vendorId);
      if (contractId) u.searchParams.set("contractId", contractId);
      const res = await runReq({
        method: "POST",
        url: u.pathname + (u.search ? u.search : ""),
        headers: {
          "x-api-key": "test_key",
          "x-tenant-id": tenantId,
          "content-type": "application/zip",
          "content-length": String(zipBuf.length)
        },
        bodyChunks: [zipBuf]
      });
      assert.equal(res.statusCode, 200, res._body().toString("utf8"));
      const json = JSON.parse(res._body().toString("utf8"));
      assert.equal(json.ok, true);
      return json;
    }

    const upGreen = await uploadWithMeta({ zipBuf: zipClose, mode: "strict", vendorId: "vendor_a", contractId: "contract_1" });
    const upRed = await uploadWithMeta({ zipBuf: zipCloseFail, mode: "strict", vendorId: "vendor_b", contractId: "contract_2" });

    const approveBody = Buffer.from(JSON.stringify({ decision: "approve", name: "Buyer", email: "buyer@example.com", note: "ok" }), "utf8");
    const approveRes = await runReq({
      method: "POST",
      url: `/r/${upGreen.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(approveBody.length) },
      bodyChunks: [approveBody]
    });
    assert.equal(approveRes.statusCode, 200, approveRes._body().toString("utf8"));

    const holdBody = Buffer.from(JSON.stringify({ decision: "hold", name: "Buyer", email: "buyer@example.com", note: "needs review" }), "utf8");
    const holdRes = await runReq({
      method: "POST",
      url: `/r/${upRed.token}/decision`,
      headers: { "content-type": "application/json", "content-length": String(holdBody.length) },
      bodyChunks: [holdBody]
    });
    assert.equal(holdRes.statusCode, 200, holdRes._body().toString("utf8"));

    const report = await getTenantAnalyticsReport({ tenantId, month, bucket: "day", limit: 20 });
    assert.equal(report.schemaVersion, "MagicLinkAnalyticsReport.v1");
    assert.equal(report.month, month);
    assert.equal(report.totals.runs, 2);
    assert.equal(report.totals.approved, 1);
    assert.equal(report.totals.held, 1);
    assert.equal(report.totals.green, 1);
    assert.equal(report.totals.red, 1);
    assert.ok(Array.isArray(report.byVendor));
    assert.ok(report.byVendor.find((row) => row.vendorId === "vendor_a"));
    assert.ok(report.byVendor.find((row) => row.vendorId === "vendor_b"));
    assert.ok(Array.isArray(report.byContract));
    assert.ok(report.byContract.find((row) => row.contractId === "contract_1"));
    assert.ok(report.byContract.find((row) => row.contractId === "contract_2"));
    assert.ok(Array.isArray(report.trends) && report.trends.length >= 1);
    assert.ok(Array.isArray(report.topErrorCodes));

    const graph = await getTenantTrustGraph({ tenantId, month, minRuns: 1, maxEdges: 50 });
    assert.equal(graph.schemaVersion, "MagicLinkTrustGraph.v1");
    assert.equal(graph.month, month);
    assert.ok(Array.isArray(graph.nodes));
    assert.ok(Array.isArray(graph.edges));
    const buyerNode = graph.nodes.find((n) => n && n.id === `buyer:${tenantId}`);
    assert.ok(buyerNode);
    const vendorNodeA = graph.nodes.find((n) => n && n.id === "vendor:vendor_a");
    const contractNodeA = graph.nodes.find((n) => n && n.id === "contract:contract_1");
    assert.ok(vendorNodeA);
    assert.ok(contractNodeA);
    const buyerToVendor = graph.edges.find((e) => e && e.source === `buyer:${tenantId}` && e.target === "vendor:vendor_a");
    const vendorToContract = graph.edges.find((e) => e && e.source === "vendor:vendor_a" && e.target === "contract:contract_1");
    assert.ok(buyerToVendor);
    assert.ok(vendorToContract);
    assert.equal(typeof buyerToVendor.score, "number");
    assert.equal(typeof vendorToContract.score, "number");

    const dashboard = await runReq({
      method: "GET",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/analytics/dashboard?month=${encodeURIComponent(month)}`,
      headers: { "x-api-key": "test_key" },
      bodyChunks: []
    });
    assert.equal(dashboard.statusCode, 200, dashboard._body().toString("utf8"));
    assert.match(dashboard._body().toString("utf8"), /Analytics Dashboard/);
    assert.match(dashboard._body().toString("utf8"), /Save trust snapshot/);
    assert.match(dashboard._body().toString("utf8"), /id="filterStatus" class="status"/);
    assert.match(dashboard._body().toString("utf8"), /setStatus\(/);

    const snapshot = await createTrustGraphSnapshot({ tenantId, month, minRuns: 1, maxEdges: 50 });
    assert.equal(snapshot.schemaVersion, "MagicLinkTrustGraphSnapshot.v1");
    assert.equal(snapshot.month, month);
    assert.equal(snapshot.graph?.schemaVersion, "MagicLinkTrustGraph.v1");

    const snapshots = await listTrustGraphSnapshots({ tenantId, limit: 20 });
    assert.equal(snapshots.schemaVersion, "MagicLinkTrustGraphSnapshotList.v1");
    assert.ok(Array.isArray(snapshots.rows));
    assert.ok(snapshots.rows.find((row) => row.month === month));

    const diff = await getTrustGraphDiff({ tenantId, baseMonth: previousMonth, compareMonth: month, limit: 50 });
    assert.equal(diff.schemaVersion, "MagicLinkTrustGraphDiff.v1");
    assert.equal(diff.baseMonth, previousMonth);
    assert.equal(diff.compareMonth, month);
    assert.ok(diff.summary.nodeChanges >= 1);
    assert.ok(diff.summary.edgeChanges >= 1);
    assert.ok(Array.isArray(diff.nodeChanges));
    assert.ok(Array.isArray(diff.edgeChanges));
  });

  await t.test("audit log: records settings changes and ingest key creation", async () => {
    const tenantId = "tenant_audit";
    process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = "";
    process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = "";
    await putTenantSettings({ tenantId, patch: { defaultMode: "compat" } });
    await createIngestKey({ tenantId, vendorId: "vendor_x", vendorName: "Vendor X" });

    const auditDir = path.join(dataDir, "audit", tenantId);
    const names = (await fs.readdir(auditDir)).filter((n) => n.endsWith(".jsonl"));
    assert.ok(names.length >= 1);
    const raw = await fs.readFile(path.join(auditDir, names[0]), "utf8");
    assert.match(raw, /TENANT_SETTINGS_PUT/);
    assert.match(raw, /INGEST_KEY_CREATED/);
  });
});
