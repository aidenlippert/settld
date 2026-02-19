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

function waitForLineMatching(stream, pattern, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const recent = [];
    const onData = (chunk) => {
      buf += String(chunk);
      while (true) {
        const idx = buf.indexOf("\n");
        if (idx === -1) break;
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        recent.push(line);
        if (recent.length > 8) recent.shift();
        if (pattern.test(line)) {
          stream.off("data", onData);
          resolve(line);
          return;
        }
      }
    };
    stream.on("data", onData);
    setTimeout(() => {
      stream.off("data", onData);
      reject(new Error(`timeout waiting for line matching ${String(pattern)}; recent=${JSON.stringify(recent)}`));
    }, timeoutMs).unref?.();
  });
}

function httpJson({ method, url, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method, headers: { "content-type": "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const parsed = text ? JSON.parse(text) : null;
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("mcp http gateway: initialize -> tools/list -> tools/call (submit_evidence)", async () => {
  const requests = [];
  const api = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, bodyText });

      // Minimal endpoints used by submit_evidence.
      if (req.method === "GET" && req.url === "/agents/agt_1/runs/run_1/events") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ events: [{ chainHash: "ch_1" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/agents/agt_1/runs/run_1/events") {
        assert.equal(req.headers["x-proxy-expected-prev-chain-hash"], "ch_1");
        assert.equal(req.headers["x-settld-protocol"], "1.0");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, event: { id: "evt_1" } }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  const apiAddr = await listen(api);
  const baseUrl = `http://${apiAddr.address}:${apiAddr.port}`;

  const gateway = spawn(process.execPath, ["scripts/mcp/settld-mcp-http-gateway.mjs"], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      SETTLD_BASE_URL: baseUrl,
      SETTLD_TENANT_ID: "tenant_default",
      SETTLD_API_KEY: "sk_test_1.secret",
      SETTLD_PROTOCOL: "1.0",
      MCP_HTTP_PORT: "0"
    }
  });
  gateway.stderr.setEncoding("utf8");

  const line = await waitForLineMatching(gateway.stderr, /listening on :(\d+)/, { timeoutMs: 10_000 });
  const m = line.match(/listening on :(\d+)/);
  assert.ok(m, `expected listening line, got: ${line}`);
  const port = Number(m[1]);
  assert.ok(Number.isSafeInteger(port) && port > 0);

  const rpcUrl = `http://127.0.0.1:${port}/rpc`;

  const init = await httpJson({
    method: "POST",
    url: rpcUrl,
    body: {
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "node-test", version: "0" }, capabilities: {} }
    }
  });
  assert.equal(init.statusCode, 200);
  assert.equal(init.body?.result?.serverInfo?.name, "settld-mcp-spike");

  const list = await httpJson({ method: "POST", url: rpcUrl, body: { jsonrpc: "2.0", id: "2", method: "tools/list", params: {} } });
  assert.equal(list.statusCode, 200);
  const names = (list.body?.result?.tools || []).map((t) => t.name);
  assert.ok(names.includes("settld.submit_evidence"));

  const called = await httpJson({
    method: "POST",
    url: rpcUrl,
    body: {
      jsonrpc: "2.0",
      id: "3",
      method: "tools/call",
      params: { name: "settld.submit_evidence", arguments: { agentId: "agt_1", runId: "run_1", evidenceRef: "evidence://demo/1" } }
    }
  });
  assert.equal(called.statusCode, 200);
  assert.equal(called.body?.result?.isError, false);
  const text = called.body?.result?.content?.[0]?.text || "";
  const parsed = JSON.parse(text);
  assert.equal(parsed.tool, "settld.submit_evidence");
  assert.equal(parsed.result?.ok, true);

  gateway.kill("SIGTERM");
  api.close();

  // Sanity: we hit both upstream endpoints.
  const urls = requests.map((r) => r.url);
  assert.deepEqual(urls, ["/agents/agt_1/runs/run_1/events", "/agents/agt_1/runs/run_1/events"]);
});
