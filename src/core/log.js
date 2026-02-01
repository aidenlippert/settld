import { AsyncLocalStorage } from "node:async_hooks";

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
});

const REDACTED = "[REDACTED]";
const SENSITIVE_KEYWORDS = Object.freeze([
  "secret",
  "token",
  "authorization",
  "cookie",
  "password",
  "privatekey",
  "accesskey",
  "credentialref"
]);

function normalizeLevel(level) {
  const raw = typeof level === "string" ? level.trim().toLowerCase() : "";
  if (!raw) return "info";
  if (raw === "warning") return "warn";
  if (!Object.hasOwn(LEVELS, raw)) return "info";
  return raw;
}

function minLevel() {
  if (typeof process === "undefined") return "info";
  return normalizeLevel(process.env.LOG_LEVEL ?? "info");
}

function shouldLog(level) {
  const lvl = normalizeLevel(level);
  return LEVELS[lvl] >= LEVELS[minLevel()];
}

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function errToJson(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack
    };
  }
  if (isPlainObject(err)) return err;
  return { message: String(err) };
}

function isSensitiveKey(key) {
  const k = typeof key === "string" ? key.trim().toLowerCase() : "";
  if (!k) return false;
  for (const needle of SENSITIVE_KEYWORDS) {
    if (k.includes(needle)) return true;
  }
  return false;
}

function redactValue(value, seen) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t !== "object") return String(value);

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED;
      continue;
    }
    out[k] = redactValue(v, seen);
  }
  return out;
}

function redactPayload(payload) {
  try {
    return redactValue(payload, new WeakSet());
  } catch {
    return payload;
  }
}

const ctx = new AsyncLocalStorage();

export function withLogContext(context, fn) {
  if (!isPlainObject(context)) throw new TypeError("context must be a plain object");
  if (typeof fn !== "function") throw new TypeError("fn must be a function");
  const existing = ctx.getStore();
  const merged = existing ? { ...existing, ...context } : { ...context };
  return ctx.run(merged, fn);
}

export function getLogContext() {
  return ctx.getStore() ?? {};
}

export function log(level, msg, fields = {}) {
  const normalizedLevel = normalizeLevel(level);
  if (!shouldLog(normalizedLevel)) return;
  if (typeof msg !== "string" || msg.trim() === "") throw new TypeError("msg must be a non-empty string");
  if (!isPlainObject(fields)) throw new TypeError("fields must be a plain object");

  const base = { ts: nowIso(), level: normalizedLevel, msg };
  const context = getLogContext();

  const payload = { ...base, ...context, ...fields };
  if (payload.err !== undefined) payload.err = errToJson(payload.err);

  // Drop undefined values to keep JSON compact and stable.
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) delete payload[k];
  }

  try {
    const safe = redactPayload(payload);
    process.stdout.write(`${JSON.stringify(safe)}\n`);
  } catch {
    // Ignore logging failures.
  }
}

export const logger = Object.freeze({
  debug(msg, fields) {
    log("debug", msg, fields);
  },
  info(msg, fields) {
    log("info", msg, fields);
  },
  warn(msg, fields) {
    log("warn", msg, fields);
  },
  error(msg, fields) {
    log("error", msg, fields);
  }
});
