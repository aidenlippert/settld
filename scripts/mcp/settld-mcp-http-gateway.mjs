#!/usr/bin/env node
/**
 * Sprint 23 MCP spike: HTTP -> stdio gateway.
 *
 * Why:
 * - Some environments can call HTTP endpoints but cannot spawn a local MCP process.
 * - This gateway runs the stdio MCP server as a single child process and forwards JSON-RPC requests.
 *
 * Transport:
 * - HTTP POST /rpc with a JSON-RPC 2.0 request object.
 *
 * Notes:
 * - This gateway is intentionally minimal and only supports single-request (non-batch) JSON-RPC.
 * - Production hardening (auth, SSE, rate limits, multi-tenant routing) belongs in later sprints.
 */

import http from "node:http";
import { spawn } from "node:child_process";

function assertNonEmptyString(v, name) {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err?.message ?? err}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function main() {
  // Pass-through: the child MCP server reads these.
  const baseUrl = process.env.SETTLD_BASE_URL ?? "";
  const tenantId = process.env.SETTLD_TENANT_ID ?? "";
  const apiKey = process.env.SETTLD_API_KEY ?? "";
  assertNonEmptyString(baseUrl, "SETTLD_BASE_URL");
  assertNonEmptyString(tenantId, "SETTLD_TENANT_ID");
  assertNonEmptyString(apiKey, "SETTLD_API_KEY");

  const port = Number(process.env.MCP_HTTP_PORT ?? process.env.PORT ?? 8787);
  // Allow 0 for ephemeral ports in tests.
  if (!Number.isSafeInteger(port) || port < 0) throw new TypeError("PORT must be a non-negative integer");

  const child = spawn(process.execPath, ["scripts/mcp/settld-mcp-server.mjs"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env }
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  // Never write child stderr to stdout.
  child.stderr.on("data", (chunk) => {
    process.stderr.write(String(chunk));
  });

  let buf = "";
  const pending = new Map(); // id -> { resolve, timeout }

  function onLine(line) {
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const id = msg?.id;
    if (id === undefined || id === null) return;
    const key = String(id);
    const item = pending.get(key);
    if (!item) return;
    pending.delete(key);
    clearTimeout(item.timeout);
    item.resolve(msg);
  }

  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf("\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      onLine(line);
    }
  });

  function forwardRpc(payload) {
    const id = payload?.id;
    if (id === undefined || id === null) {
      // Notifications: no response expected.
      child.stdin.write(JSON.stringify(payload) + "\n");
      return Promise.resolve(null);
    }
    const key = String(id);
    if (pending.has(key)) {
      return Promise.resolve({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "duplicate id in-flight" }
      });
    }
    child.stdin.write(JSON.stringify(payload) + "\n");
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(key);
        resolve({ jsonrpc: "2.0", id, error: { code: -32001, message: "gateway timeout waiting for response" } });
      }, 10_000).unref?.();
      pending.set(key, { resolve, timeout });
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        return sendJson(res, 200, { ok: true, transport: "http->stdio", server: "settld-mcp-http-gateway", version: "s23" });
      }

      if (req.method === "POST" && (req.url === "/rpc" || req.url === "/mcp")) {
        const body = await readJson(req);
        if (Array.isArray(body)) return sendJson(res, 400, { error: "batch JSON-RPC not supported (spike)" });
        if (!body || typeof body !== "object") return sendJson(res, 400, { error: "JSON-RPC body must be an object" });
        if (body.jsonrpc !== "2.0") return sendJson(res, 400, { error: "jsonrpc must be 2.0" });
        const out = await forwardRpc(body);
        if (out === null) return sendJson(res, 204, null);
        return sendJson(res, 200, out);
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      return sendJson(res, 500, { error: err?.message ?? String(err) });
    }
  });

  // Default to loopback to avoid exposing the spike gateway on the LAN by accident.
  // Override with MCP_HTTP_HOST=0.0.0.0 if you intentionally want a non-loopback bind.
  const host = String(process.env.MCP_HTTP_HOST ?? "127.0.0.1").trim() || "127.0.0.1";

  server.listen(port, host, () => {
    const addr = server.address();
    const effectivePort = addr && typeof addr === "object" ? addr.port : port;
    process.stderr.write(`[mcp-http] listening on :${effectivePort} (POST /rpc)\n`);
  });

  function shutdown() {
    try {
      server.close();
    } catch {
      // ignore
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
