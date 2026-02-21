import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("unexpected server address"));
      resolve(addr);
    });
  });
}

function onceEvent(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

test("mcp paid exa tool: retries x402 via autopay and returns search payload", async () => {
  const requests = [];
  const paidGateway = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/exa/search") {
      const gateId = typeof req.headers["x-settld-gate-id"] === "string" ? req.headers["x-settld-gate-id"].trim() : "";
      requests.push({ gateId, tenantHeader: req.headers["x-proxy-tenant-id"] });
      if (!gateId) {
        res.writeHead(402, {
          "content-type": "application/json; charset=utf-8",
          "x-payment-required": "amountCents=500; currency=USD; address=mock:exa; network=mocknet",
          "x-settld-gate-id": "gate_exa_paid_1"
        });
        res.end(JSON.stringify({ ok: false, code: "PAYMENT_REQUIRED" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "x-settld-gate-id": gateId,
        "x-settld-settlement-status": "released",
        "x-settld-verification-status": "green"
      });
      res.end(
        JSON.stringify({
          ok: true,
          provider: "exa-mock",
          query: url.searchParams.get("q"),
          numResults: Number(url.searchParams.get("numResults") ?? 0),
          results: [{ title: "demo", url: "https://exa.mock/demo", snippet: "demo snippet" }]
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const paidGatewayAddr = await listen(paidGateway);
  const paidGatewayBase = `http://${paidGatewayAddr.address}:${paidGatewayAddr.port}`;

  const child = spawn(process.execPath, ["scripts/mcp/settld-mcp-server.mjs"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SETTLD_BASE_URL: "http://127.0.0.1:3000",
      SETTLD_TENANT_ID: "tenant_default",
      SETTLD_API_KEY: "sk_test_1.secret",
      SETTLD_PROTOCOL: "1.0",
      SETTLD_PAID_TOOLS_BASE_URL: paidGatewayBase
    }
  });

  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");

  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf("\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  const rpc = async (method, params = {}) => {
    const id = String(Math.random()).slice(2);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 5000).unref?.();
    });
  };

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "node-test", version: "0" },
    capabilities: {}
  });
  assert.equal(init.result?.serverInfo?.name, "settld-mcp-spike");

  const called = await rpc("tools/call", {
    name: "settld.exa_search_paid",
    arguments: { query: "dentist chicago", numResults: 3 }
  });
  assert.equal(called.result?.isError, false);
  const payload = JSON.parse(called.result?.content?.[0]?.text ?? "{}");
  assert.equal(payload.tool, "settld.exa_search_paid");
  assert.equal(payload.result?.ok, true);
  assert.equal(payload.result?.response?.provider, "exa-mock");
  assert.equal(payload.result?.response?.query, "dentist chicago");
  assert.equal(payload.result?.headers?.["x-settld-settlement-status"], "released");
  assert.equal(payload.result?.challenge?.gateId, "gate_exa_paid_1");
  assert.equal(payload.result?.challenge?.policyChallenge?.quoteRequired, null);
  assert.equal(payload.result?.challenge?.policyChallenge?.spendAuthorizationMode, null);
  assert.equal(payload.result?.challenge?.fields?.amountCents, "500");
  assert.equal(payload.result?.challenge?.fields?.currency, "USD");

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.gateId, "");
  assert.equal(requests[0]?.tenantHeader, "tenant_default");
  assert.equal(requests[1]?.gateId, "gate_exa_paid_1");

  child.kill("SIGTERM");
  await Promise.race([onceEvent(child, "exit"), new Promise((r) => setTimeout(r, 100))]);
  await new Promise((resolve) => paidGateway.close(resolve));
});
