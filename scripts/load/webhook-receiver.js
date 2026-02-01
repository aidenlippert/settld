import http from "node:http";
import crypto from "node:crypto";

function parsePositiveInt(name, fallback) {
  const raw = process.env[name] ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function parseNonNegativeInt(name, fallback) {
  const raw = process.env[name] ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const port = parsePositiveInt("PORT", 4010);
const timeoutRatePct = parseNonNegativeInt("TIMEOUT_RATE_PCT", 5);
const errorRatePct = parseNonNegativeInt("ERROR_RATE_PCT", 5);
const timeoutDelayMs = parsePositiveInt("TIMEOUT_DELAY_MS", 10_000);

const seen = new Map(); // dedupeKey -> { count, hashes: Set }
let total = 0;
let ok = 0;
let errored = 0;
let delayed = 0;

function header(req, name) {
  const lower = name.toLowerCase();
  const v = req.headers[lower] ?? null;
  return v === null || v === undefined ? "" : String(v);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && req.url === "/stats") {
    const top = [];
    for (const [dedupeKey, v] of seen.entries()) {
      top.push({ dedupeKey, count: v.count, uniqueBodies: v.hashes.size });
    }
    top.sort((a, b) => b.count - a.count);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ total, ok, errored, delayed, top: top.slice(0, 50) }));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const body = await new Promise((resolve) => {
    let chunks = "";
    req.on("data", (d) => {
      chunks += d;
      // Avoid unbounded memory on misuse.
      if (chunks.length > 2_000_000) req.destroy();
    });
    req.on("end", () => resolve(chunks));
    req.on("error", () => resolve(""));
  });

  total += 1;

  const dedupeKey = header(req, "x-proxy-dedupe-key");
  if (dedupeKey) {
    const row = seen.get(dedupeKey) ?? { count: 0, hashes: new Set() };
    row.count += 1;
    row.hashes.add(sha256Hex(body));
    seen.set(dedupeKey, row);
  }

  const roll = Math.random() * 100;
  if (roll < timeoutRatePct) {
    delayed += 1;
    await sleep(timeoutDelayMs);
    res.statusCode = 200;
    res.end("ok");
    ok += 1;
    return;
  }

  if (roll < timeoutRatePct + errorRatePct) {
    errored += 1;
    res.statusCode = 500;
    res.end("error");
    return;
  }

  ok += 1;
  res.statusCode = 200;
  res.end("ok");
});

server.listen(port, () => {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      msg: "load.webhook_receiver.listening",
      port,
      timeoutRatePct,
      errorRatePct,
      timeoutDelayMs
    }) + "\n"
  );
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

