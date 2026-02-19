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
  const out = { call: null, timeoutMs: null, x402Smoke: false, x402SmokeFile: null };
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
    if (a === "--timeout-ms") {
      const raw = argv[i + 1];
      out.timeoutMs = raw;
      i += 1;
    }
    if (a === "--x402-smoke") {
      out.x402Smoke = true;
    }
    if (a === "--x402-smoke-file") {
      out.x402Smoke = true;
      out.x402SmokeFile = argv[i + 1] || "";
      i += 1;
    }
  }
  return out;
}

function assertProbeEnv() {
  const apiKey = process.env.SETTLD_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim() !== "") return;
  throw new Error(
    [
      "[mcp:probe] missing required env var: SETTLD_API_KEY",
      "Set env and retry:",
      "  export SETTLD_BASE_URL=http://127.0.0.1:3000",
      "  export SETTLD_TENANT_ID=tenant_default",
      "  export SETTLD_API_KEY='sk_live_or_sk_test_keyid.secret'",
      "Docs: docs/QUICKSTART_MCP.md"
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertProbeEnv();

  const child = spawn(process.execPath, ["scripts/mcp/settld-mcp-server.mjs"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env }
  });

  child.stdout.setEncoding("utf8");
  let buf = "";
  const pending = new Map();
  let shuttingDown = false;

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const reason = `mcp server exited before probe completed (code=${code ?? "null"} signal=${signal ?? ""})`;
    for (const { reject } of pending.values()) {
      reject(new Error(reason));
    }
    pending.clear();
  });

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

  const timeoutMsRaw =
    args.timeoutMs !== null && args.timeoutMs !== undefined
      ? Number(args.timeoutMs)
      : typeof process !== "undefined"
        ? Number(process.env.MCP_PROBE_TIMEOUT_MS ?? 30_000)
        : 30_000;
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.floor(timeoutMsRaw) : 30_000;

  function rpc(method, params) {
    if (child.exitCode !== null) {
      throw new Error(`cannot call ${method}: mcp server already exited (code=${child.exitCode})`);
    }
    const id = String(Math.random()).slice(2);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(payload + "\n");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs).unref?.();
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

  function parseToolCallResult(callResponse, fallbackName = "unknown") {
    const text = callResponse?.result?.content?.[0]?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return { tool: fallbackName, rawText: text };
    }
  }

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

  if (args.x402Smoke) {
    let smokeCfg = {};
    if (args.x402SmokeFile) {
      try {
        const raw = fs.readFileSync(String(args.x402SmokeFile), "utf8");
        smokeCfg = JSON.parse(raw);
      } catch (err) {
        throw new Error(`--x402-smoke-file must be valid JSON: ${err?.message ?? err}`);
      }
    }

    const seed = String(Date.now());
    const createArgs = {
      gateId: `x402gate_probe_${seed}`,
      payerAgentId: `agt_probe_payer_${seed}`,
      payeeAgentId: `agt_probe_payee_${seed}`,
      amountCents: 100,
      autoFundPayerCents: 1000,
      idempotencyKey: `mcp_probe_x402_gate_create_${seed}`,
      ...(smokeCfg?.create && typeof smokeCfg.create === "object" ? smokeCfg.create : {})
    };
    const createRes = await rpc("tools/call", { name: "settld.x402_gate_create", arguments: createArgs });
    process.stdout.write(JSON.stringify(createRes, null, 2) + "\n");
    const createParsed = parseToolCallResult(createRes, "settld.x402_gate_create");
    const gateId =
      createParsed?.result?.gateId ??
      createParsed?.result?.gate?.gateId ??
      createParsed?.gateId ??
      createParsed?.gate?.gateId ??
      createArgs.gateId;

    const verifyArgs = {
      gateId,
      ensureAuthorized: true,
      authorizeIdempotencyKey: `mcp_probe_x402_gate_authorize_${seed}`,
      idempotencyKey: `mcp_probe_x402_gate_verify_${seed}`,
      ...(smokeCfg?.verify && typeof smokeCfg.verify === "object" ? smokeCfg.verify : {})
    };
    const verifyRes = await rpc("tools/call", { name: "settld.x402_gate_verify", arguments: verifyArgs });
    process.stdout.write(JSON.stringify(verifyRes, null, 2) + "\n");

    const getArgs = {
      gateId,
      ...(smokeCfg?.get && typeof smokeCfg.get === "object" ? smokeCfg.get : {})
    };
    const getRes = await rpc("tools/call", { name: "settld.x402_gate_get", arguments: getArgs });
    process.stdout.write(JSON.stringify(getRes, null, 2) + "\n");
  }

  shuttingDown = true;
  child.kill("SIGTERM");
  await Promise.race([sleep(50), new Promise((r) => child.once("exit", r))]);
}

main().catch((err) => {
  const message = typeof err?.message === "string" ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
