import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function readNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
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

async function waitForJson(url, { name, timeoutMs = 30_000, proc = null } = {}) {
  const start = Date.now();
  while (true) {
    if (proc && proc.exitCode !== null) {
      throw new Error(`${name ?? url} exited before becoming ready (exitCode=${proc.exitCode})`);
    }
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) {
        const text = await res.text();
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          return null;
        }
      }
    } catch {}

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
      description: "x402 quickstart script"
    })
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`mint api key failed: HTTP ${res.status} ${text}`);
  }
  const keyId = json?.keyId;
  const secret = json?.secret;
  if (typeof keyId !== "string" || typeof secret !== "string" || !keyId || !secret) {
    throw new Error(`mint api key returned unexpected body: ${text}`);
  }
  return `${keyId}.${secret}`;
}

function headerValue(headersText, headerName) {
  const want = String(headerName).trim().toLowerCase() + ":";
  const lines = String(headersText)
    .split("\n")
    .map((l) => l.replaceAll("\r", ""));
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx + 1).trim().toLowerCase();
    if (key === want) return line.slice(idx + 1).trim();
  }
  return null;
}

async function fetchHeaders(url, { headers } = {}) {
  const res = await fetch(url, { method: "GET", headers: headers ?? {} });
  const status = res.status;
  const text = await res.text();
  const headersObj = Object.fromEntries(res.headers.entries());
  return { status, text, headers: headersObj };
}

async function runSmokeTest({ gatewayUrl, holdbackBps, disputeWindowMs }) {
  const first = await fetch(gatewayUrl);
  const firstText = await first.text();
  const firstHeaders = Object.fromEntries(first.headers.entries());
  if (first.status !== 402) {
    throw new Error(`expected first request to return 402; got ${first.status}`);
  }
  const paymentRequired = firstHeaders["x-payment-required"];
  if (!paymentRequired) throw new Error("missing x-payment-required header on 402 response");

  const gateId = firstHeaders["x-settld-gate-id"];
  if (!gateId) throw new Error("missing x-settld-gate-id header on 402 response");

  // Parse amountCents=... out of x-payment-required.
  const m = String(paymentRequired).match(/(?:^|;)\s*amountCents=([0-9]+)\b/);
  if (!m) throw new Error(`could not parse amountCents from x-payment-required: ${paymentRequired}`);
  const amountCents = Number(m[1]);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error(`invalid amountCents: ${m[1]}`);

  const second = await fetch(gatewayUrl, {
    method: "GET",
    headers: {
      "x-settld-gate-id": gateId,
      "x-payment": "paid"
    }
  });
  await second.arrayBuffer();
  const secondHeaders = Object.fromEntries(second.headers.entries());
  if (second.status !== 200) {
    throw new Error(`expected second request to return 200; got ${second.status}`);
  }

  const settlementStatus = secondHeaders["x-settld-settlement-status"];
  const releasedAmountCents = Number(secondHeaders["x-settld-released-amount-cents"] ?? "NaN");
  const refundedAmountCents = Number(secondHeaders["x-settld-refunded-amount-cents"] ?? "NaN");
  const holdbackStatus = secondHeaders["x-settld-holdback-status"];
  const holdbackAmountCents = Number(secondHeaders["x-settld-holdback-amount-cents"] ?? "NaN");

  const expectedHoldbackCents = Math.floor((amountCents * holdbackBps) / 10_000);
  const expectedReleasedCents = amountCents - expectedHoldbackCents;
  const expectedRefundedCents = expectedHoldbackCents;
  const expectedHoldbackStatus = disputeWindowMs > 0 ? "held" : "released";

  if (settlementStatus !== "released") throw new Error(`expected settlement status released; got ${settlementStatus}`);
  if (!Number.isSafeInteger(releasedAmountCents) || releasedAmountCents !== expectedReleasedCents) {
    throw new Error(`released cents mismatch: got=${releasedAmountCents} expected=${expectedReleasedCents}`);
  }
  if (!Number.isSafeInteger(refundedAmountCents) || refundedAmountCents !== expectedRefundedCents) {
    throw new Error(`refunded cents mismatch: got=${refundedAmountCents} expected=${expectedRefundedCents}`);
  }
  if (holdbackStatus !== expectedHoldbackStatus) {
    throw new Error(`holdback status mismatch: got=${holdbackStatus} expected=${expectedHoldbackStatus}`);
  }
  if (!Number.isSafeInteger(holdbackAmountCents) || holdbackAmountCents !== expectedHoldbackCents) {
    throw new Error(`holdback cents mismatch: got=${holdbackAmountCents} expected=${expectedHoldbackCents}`);
  }

  return { gateId, amountCents };
}

async function main() {
  const apiPort = readIntEnv("SETTLD_QUICKSTART_API_PORT", 3000);
  const upstreamPort = readIntEnv("SETTLD_QUICKSTART_UPSTREAM_PORT", 9402);
  const gatewayPort = readIntEnv("SETTLD_QUICKSTART_GATEWAY_PORT", 8402);

  const opsToken = String(process.env.SETTLD_QUICKSTART_OPS_TOKEN ?? "tok_ops").trim() || "tok_ops";
  const tenantId = String(process.env.SETTLD_TENANT_ID ?? "tenant_default").trim() || "tenant_default";

  const holdbackBps = readNonNegativeIntEnv("HOLDBACK_BPS", 1000);
  if (holdbackBps > 10_000) throw new Error("HOLDBACK_BPS must be within 0..10000");
  const disputeWindowMs = readNonNegativeIntEnv("DISPUTE_WINDOW_MS", 86_400_000);
  const autoFund = readBoolEnv("X402_AUTOFUND", true);

  const keepAlive = readBoolEnv("SETTLD_QUICKSTART_KEEP_ALIVE", true);

  const apiUrl = new URL(`http://127.0.0.1:${apiPort}`);
  const upstreamUrl = new URL(`http://127.0.0.1:${upstreamPort}`);
  const gatewayUrl = new URL(`http://127.0.0.1:${gatewayPort}/resource`);

  const procs = [];
  const stopAll = () => {
    for (const p of procs) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
  };
  process.on("SIGINT", () => {
    log("quickstart", "SIGINT: shutting down...");
    stopAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    log("quickstart", "SIGTERM: shutting down...");
    stopAll();
    process.exit(143);
  });

  // 1) API
  const api = spawnProc({
    name: "api",
    cmd: "node",
    args: ["src/api/server.js"],
    env: {
      PROXY_OPS_TOKEN: opsToken,
      BIND_HOST: "127.0.0.1",
      PORT: String(apiPort)
    }
  });
  procs.push(api);
  await waitForJson(new URL("/healthz", apiUrl).toString(), { name: "api /healthz", proc: api });

  // 2) Mint API key
  const apiKey = await mintApiKey({ apiUrl, opsToken, tenantId });
  log("quickstart", "SETTLD_API_KEY minted");

  // 3) Upstream mock
  const upstream = spawnProc({
    name: "upstream",
    cmd: "node",
    args: ["services/x402-gateway/examples/upstream-mock.js"],
    env: { BIND_HOST: "127.0.0.1", PORT: String(upstreamPort) }
  });
  procs.push(upstream);
  await waitForJson(new URL("/healthz", upstreamUrl).toString(), { name: "upstream /healthz", proc: upstream });

  // 4) Gateway
  const gateway = spawnProc({
    name: "gateway",
    cmd: "node",
    args: ["services/x402-gateway/src/server.js"],
    env: {
      BIND_HOST: "127.0.0.1",
      SETTLD_API_URL: apiUrl.toString(),
      SETTLD_API_KEY: apiKey,
      UPSTREAM_URL: upstreamUrl.toString(),
      HOLDBACK_BPS: String(holdbackBps),
      DISPUTE_WINDOW_MS: String(disputeWindowMs),
      X402_AUTOFUND: autoFund ? "1" : "0",
      PORT: String(gatewayPort)
    }
  });
  procs.push(gateway);
  await waitForJson(new URL("/healthz", `http://127.0.0.1:${gatewayPort}`).toString(), { name: "gateway /healthz", proc: gateway });

  // 5) Smoke test
  const { gateId } = await runSmokeTest({ gatewayUrl: gatewayUrl.toString(), holdbackBps, disputeWindowMs });
  log("quickstart", `gateId=${gateId}`);

  // Fetch gate state (proof of receipt trail)
  const gateStateRes = await fetch(new URL(`/x402/gate/${encodeURIComponent(gateId)}`, apiUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "x-proxy-tenant-id": tenantId,
      "x-settld-protocol": "1.0"
    }
  });
  const gateStateText = await gateStateRes.text();
  if (!gateStateRes.ok) {
    throw new Error(`gate state fetch failed: HTTP ${gateStateRes.status} ${gateStateText}`);
  }
  log("quickstart", "gate state fetched (receipt trail exists)");

  process.stdout.write("OK\n");
  process.stdout.write(`gateId=${gateId}\n`);
  process.stdout.write(`gateStateUrl=${new URL(`/x402/gate/${encodeURIComponent(gateId)}`, apiUrl).toString()}\n`);

  if (!keepAlive) {
    stopAll();
    return;
  }

  log("quickstart", "Services are running. Press Ctrl+C to stop.");
  // Keep the process alive.
  // eslint-disable-next-line no-constant-condition
  while (true) await delay(1000);
}

main().catch((err) => {
  log("quickstart", `failed: ${err?.message ?? String(err ?? "")}`);
  process.exitCode = 1;
});
