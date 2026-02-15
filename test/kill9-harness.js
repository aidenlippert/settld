import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { createPgPool, quoteIdent } from "../src/db/pg.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      server.close(() => resolve(Number(port)));
    });
  });
}

export async function waitForHealth({ baseUrl, timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { method: "GET" });
      if (res.status === 200) return;
    } catch {}
    await delay(intervalMs);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

export async function requestJson({ baseUrl, method, path: reqPath, headers = {}, body } = {}) {
  const init = { method, headers: { ...(headers ?? {}) } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${reqPath}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { statusCode: res.status, json, text, headers: res.headers };
}

export function startApiServer({
  databaseUrl,
  schema,
  port,
  env = {}
} = {}) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") throw new TypeError("databaseUrl is required");
  if (typeof schema !== "string" || schema.trim() === "") throw new TypeError("schema is required");
  if (!Number.isSafeInteger(port) || port <= 0) throw new TypeError("port must be a positive integer");

  const childEnv = {
    ...process.env,
    STORE: "pg",
    DATABASE_URL: databaseUrl,
    PROXY_PG_SCHEMA: schema,
    PORT: String(port),
    PROXY_OPS_TOKEN: process.env.PROXY_OPS_TOKEN ?? "kill9_ops",
    ...env
  };

  const child = spawn(process.execPath, ["src/api/server.js"], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (buf) => stdout.push(buf.toString("utf8")));
  child.stderr.on("data", (buf) => stderr.push(buf.toString("utf8")));

  const baseUrl = `http://127.0.0.1:${port}`;

  const defaultExitTimeoutMs = (() => {
    const raw = process.env.KILL9_EXIT_TIMEOUT_MS;
    if (raw && Number.isFinite(Number(raw)) && Number(raw) > 0) return Number(raw);
    return process.env.CI ? 60_000 : 10_000;
  })();

  async function waitForExit({ timeoutMs = defaultExitTimeoutMs } = {}) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { code: child.exitCode, signal: child.signalCode };
    }
    return await Promise.race([
      once(child, "exit").then(([code, signal]) => ({ code, signal })),
      delay(timeoutMs).then(() => {
        throw new Error(`server did not exit within ${timeoutMs}ms`);
      })
    ]);
  }

  async function stop({ timeoutMs = 5000 } = {}) {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
    child.kill("SIGTERM");
    try {
      await waitForExit({ timeoutMs });
    } catch {
      child.kill("SIGKILL");
      await waitForExit({ timeoutMs: 2000 }).catch(() => {});
    }
  }

  function output() {
    return { stdout: stdout.join(""), stderr: stderr.join("") };
  }

  return { child, baseUrl, stop, waitForExit, output };
}

export async function dropSchema({ databaseUrl, schema } = {}) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") throw new TypeError("databaseUrl is required");
  if (typeof schema !== "string" || schema.trim() === "") throw new TypeError("schema is required");
  const pool = await createPgPool({ databaseUrl, schema: "public" });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  } finally {
    await pool.end();
  }
}
