import pg from "pg";

import { logger } from "../core/log.js";

const { Pool } = pg;

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = typeof process !== "undefined" ? process.env?.[name] : null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

export function quoteIdent(identifier) {
  assertNonEmptyString(identifier, "identifier");
  return `"${identifier.replaceAll('"', '""')}"`;
}

const PG_LOG_SLOW_MS = (() => {
  try {
    return parseNonNegativeIntEnv("PROXY_PG_LOG_SLOW_MS", 0);
  } catch {
    return 0;
  }
})();

function deriveQueryLabel(text) {
  const q = typeof text === "string" ? text : "";
  const compact = q.replaceAll(/\s+/g, " ").trim();
  if (!compact) return "unknown";
  const upper = compact.toUpperCase();
  const op = upper.startsWith("WITH ") ? "WITH" : upper.split(" ", 1)[0] ?? "unknown";

  const tableMatch =
    op === "INSERT"
      ? compact.match(/\bINTO\s+([a-zA-Z0-9_".]+)/i)
      : op === "UPDATE"
        ? compact.match(/\bUPDATE\s+([a-zA-Z0-9_".]+)/i)
        : compact.match(/\bFROM\s+([a-zA-Z0-9_".]+)/i);
  const rawTable = tableMatch?.[1] ?? null;
  const table = rawTable ? rawTable.replaceAll('"', "") : null;
  return table ? `${op} ${table}` : op;
}

function queryLabelFromArgs(args) {
  const q = args?.[0] ?? null;
  if (q && typeof q === "object" && typeof q.name === "string" && q.name.trim() !== "") return q.name.trim();
  if (typeof q === "string") return deriveQueryLabel(q);
  if (q && typeof q === "object" && typeof q.text === "string") return deriveQueryLabel(q.text);
  return "unknown";
}

function instrumentClient(client) {
  if (!PG_LOG_SLOW_MS) return;
  if (!client || typeof client !== "object") return;
  if (client.__settldSlowLogWrapped) return;
  client.__settldSlowLogWrapped = true;

  const originalQuery = client.query.bind(client);
  client.query = function queryWrapper(...args) {
    const hasCallback = typeof args[args.length - 1] === "function";
    if (hasCallback) return originalQuery(...args);

    const label = queryLabelFromArgs(args);
    const started = Date.now();
    return originalQuery(...args)
      .then((res) => {
        const durationMs = Date.now() - started;
        if (durationMs >= PG_LOG_SLOW_MS) {
          logger.warn("pg.query.slow", { durationMs, query: label, rowCount: res?.rowCount ?? null });
        }
        return res;
      })
      .catch((err) => {
        const durationMs = Date.now() - started;
        if (durationMs >= PG_LOG_SLOW_MS) {
          logger.warn("pg.query.slow", { durationMs, query: label, err });
        }
        throw err;
      });
  };
}

export async function createPgPool({ databaseUrl, schema = "public" } = {}) {
  assertNonEmptyString(databaseUrl, "databaseUrl");
  assertNonEmptyString(schema, "schema");

  const pool = new Pool({ connectionString: databaseUrl });

  if (schema !== "public") {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  }

  pool.on("connect", (client) => {
    const searchPath = schema === "public" ? `${quoteIdent(schema)}` : `${quoteIdent(schema)}, public`;
    try {
      instrumentClient(client);
    } catch {}
    client.query(`SET search_path TO ${searchPath}`).catch(() => {});
  });

  const searchPath = schema === "public" ? `${quoteIdent(schema)}` : `${quoteIdent(schema)}, public`;
  await pool.query(`SET search_path TO ${searchPath}`);

  // Also instrument pool.query() for non-transactional calls.
  try {
    instrumentClient(pool);
  } catch {}

  return pool;
}
