#!/usr/bin/env node
/**
 * MCP spike probe: spawns the stdio MCP server, sends initialize + tools/list, prints results, exits.
 *
 * Usage:
 *   npm run mcp:probe
 *   node scripts/mcp/probe.mjs --call settld.about '{}'
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = { call: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--call") {
      const name = argv[i + 1] || "";
      const argsRaw = argv[i + 2] || "{}";
      out.call = { name, argsRaw };
      i += 2;
    }
    if (a === "--call-file") {
      const name = argv[i + 1] || "";
      const file = argv[i + 2] || "";
      out.call = { name, argsRaw: null, file };
      i += 2;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const child = spawn(process.execPath, ["scripts/mcp/settld-mcp-server.mjs"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env }
  });

  child.stdout.setEncoding("utf8");
  let buf = "";
  const pending = new Map();

  function onLine(line) {
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const id = msg?.id;
    if (id !== undefined && pending.has(String(id))) {
      const { resolve } = pending.get(String(id));
      pending.delete(String(id));
      resolve(msg);
    } else {
      // Unexpected response; print it anyway.
      process.stdout.write(line + "\n");
    }
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

  function rpc(method, params) {
    const id = String(Math.random()).slice(2);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(payload + "\n");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 8000).unref?.();
    });
  }

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "settld-mcp-probe", version: "s23" },
    capabilities: {}
  });
  process.stdout.write(JSON.stringify(init, null, 2) + "\n");

  const list = await rpc("tools/list", {});
  process.stdout.write(JSON.stringify(list, null, 2) + "\n");

  if (args.call) {
    let callArgs = {};
    try {
      if (args.call.file) {
        const raw = fs.readFileSync(String(args.call.file), "utf8");
        callArgs = JSON.parse(raw);
      } else {
        callArgs = JSON.parse(args.call.argsRaw);
      }
    } catch (err) {
      const flag = args.call.file ? "--call-file" : "--call";
      throw new Error(`${flag} args must be JSON: ${err?.message ?? err}`);
    }
    const called = await rpc("tools/call", { name: args.call.name, arguments: callArgs });
    process.stdout.write(JSON.stringify(called, null, 2) + "\n");
  }

  child.kill("SIGTERM");
  await Promise.race([sleep(50), new Promise((r) => child.once("exit", r))]);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err?.message || err) + "\n");
  process.exitCode = 1;
});
