import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { createMetrics } from "../../../src/core/metrics.js";
import { logger } from "../../../src/core/log.js";
import { hmacSignArtifact } from "../../../src/core/artifacts.js";
import { verifyArtifactHash, verifyArtifactVersion, verifySettlementBalances } from "../../../packages/artifact-verify/src/index.js";

import { DedupeStore } from "./dedupe-store.js";
import { loadConfig, validateConfigForReady } from "./config.js";
import { S3Store } from "./s3-store.js";
import { createAckWorker } from "./ack-worker.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

async function readJsonBody(req, { maxBytes = 2_000_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error("invalid JSON"), { code: "INVALID_JSON", cause: err }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body, headers = null) {
  const data = JSON.stringify(body ?? {});
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.end(data);
}

function sendText(res, statusCode, text, headers = null) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.end(String(text ?? ""));
}

function stableError(code, message, extra = null) {
  return { ok: false, code, message, ...(extra ? { extra } : {}) };
}

function nowIso() {
  return new Date().toISOString();
}

function verifyWebhook({ secret, timestamp, signature, bodyJson }) {
  assertNonEmptyString(secret, "secret");
  assertNonEmptyString(timestamp, "timestamp");
  assertNonEmptyString(signature, "signature");
  if (!bodyJson || typeof bodyJson !== "object") throw new TypeError("bodyJson must be an object");

  const tsMs = Date.parse(timestamp);
  const nowMs = Date.parse(nowIso());
  const maxSkewMs = 5 * 60_000;
  if (Number.isFinite(tsMs) && Number.isFinite(nowMs) && Math.abs(tsMs - nowMs) > maxSkewMs) {
    return { ok: false, code: "TIMESTAMP_SKEW", message: "timestamp skew too large" };
  }

  const expected = hmacSignArtifact({ secret, timestamp, bodyJson });
  if (String(signature) !== expected) return { ok: false, code: "BAD_SIGNATURE", message: "bad signature" };
  return { ok: true };
}

function ensureDir(fp) {
  return fs.mkdir(path.dirname(fp), { recursive: true });
}

const cfg = await loadConfig();
const metrics = createMetrics();

const dedupeStore = new DedupeStore({ filePath: cfg.dedupeDbPath });
await ensureDir(cfg.dedupeDbPath);
await dedupeStore.init();

const s3 = new S3Store({
  endpoint: cfg.s3.endpoint ?? "",
  region: cfg.s3.region ?? "",
  bucket: cfg.s3.bucket ?? "",
  prefix: cfg.s3.prefix ?? "settld/",
  accessKeyId: cfg.s3.accessKeyId ?? "",
  secretAccessKey: cfg.s3.secretAccessKey ?? "",
  forcePathStyle: cfg.s3.forcePathStyle !== false
});

const ackWorker = createAckWorker({ cfg, dedupeStore, metrics, logger });
if (cfg.test?.delayAckWorkerStartMs && cfg.test.delayAckWorkerStartMs > 0) {
  setTimeout(() => ackWorker.start(), cfg.test.delayAckWorkerStartMs);
} else {
  ackWorker.start();
}

let stopped = false;
let delayedOnce = false;

function metricInc(name, labels, value = 1) {
  try {
    metrics.incCounter(name, labels, value);
  } catch {}
}

function metricGauge(name, labels, value) {
  try {
    metrics.setGauge(name, labels, value);
  } catch {}
}

const server = http.createServer(async (req, res) => {
  const method = String(req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  metricInc("receiver_requests_total", { route: pathname, method }, 1);

  if (method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/metrics") {
    metricGauge("receiver_inflight_acks_gauge", null, metrics.getGauge("receiver_inflight_acks_gauge", null));
    return sendText(res, 200, metrics.renderPrometheusText(), { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  }

  if (method === "GET" && pathname === "/ready") {
    try {
      validateConfigForReady(cfg);
    } catch (err) {
      return sendJson(res, 503, stableError("CONFIG_INVALID", err?.message ?? "invalid config"));
    }
    try {
      const check = await s3.checkConnectivity({ timeoutMs: 2000 });
      if (!check.ok) return sendJson(res, 503, stableError("S3_UNAVAILABLE", `s3 check failed (${check.status ?? "unknown"})`));
    } catch (err) {
      return sendJson(res, 503, stableError("S3_UNAVAILABLE", err?.message ?? "s3 check failed"));
    }
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/deliveries/settld") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err?.code === "BODY_TOO_LARGE" ? 413 : 400, stableError(err?.code ?? "INVALID_REQUEST", err?.message ?? "invalid request"));
    }
    if (!body || typeof body !== "object") return sendJson(res, 400, stableError("SCHEMA_INVALID", "json body is required"));

    const dedupeKey = req.headers["x-proxy-dedupe-key"] ? String(req.headers["x-proxy-dedupe-key"]) : null;
    const deliveryId = req.headers["x-proxy-delivery-id"] ? String(req.headers["x-proxy-delivery-id"]) : null;
    const artifactType = req.headers["x-proxy-artifact-type"] ? String(req.headers["x-proxy-artifact-type"]) : (body.artifactType ?? null);
    const artifactHash = body?.artifactHash ?? null;
    const timestamp = req.headers["x-proxy-timestamp"] ? String(req.headers["x-proxy-timestamp"]) : null;
    const signature = req.headers["x-proxy-signature"] ? String(req.headers["x-proxy-signature"]) : null;

    if (!dedupeKey || !deliveryId || !timestamp || !signature) {
      return sendJson(res, 400, stableError("MISSING_HEADERS", "x-proxy-dedupe-key, x-proxy-delivery-id, x-proxy-timestamp, x-proxy-signature are required"));
    }
    if (!artifactHash || typeof artifactHash !== "string" || !artifactHash.trim()) {
      return sendJson(res, 400, stableError("SCHEMA_INVALID", "artifactHash is required"));
    }

    try {
      if (!cfg.hmacSecret) throw new Error("receiver not configured with hmac secret");
      const sigOk = verifyWebhook({ secret: cfg.hmacSecret, timestamp, signature, bodyJson: body });
      if (!sigOk.ok) {
        metricInc("receiver_verify_failed_total", { stage: "hmac", code: sigOk.code }, 1);
        return sendJson(res, 401, stableError(sigOk.code, sigOk.message));
      }
    } catch (err) {
      metricInc("receiver_verify_failed_total", { stage: "hmac", code: "EXCEPTION" }, 1);
      return sendJson(res, 401, stableError("BAD_SIGNATURE", "bad signature"));
    }

    // Dedupe mismatch check early.
    const existing = dedupeStore.get(dedupeKey);
    if (existing && String(existing.artifactHash ?? "") && String(existing.artifactHash) !== String(artifactHash)) {
      metricInc("receiver_dedupe_hit_total", { result: "mismatch" }, 1);
      return sendJson(res, 409, stableError("DEDUPE_MISMATCH", "dedupeKey already used for a different artifactHash"));
    }
    if (existing && existing.deliveryId && String(existing.deliveryId) !== String(deliveryId)) {
      metricInc("receiver_dedupe_hit_total", { result: "delivery_id_mismatch" }, 1);
      return sendJson(res, 409, stableError("DELIVERY_ID_MISMATCH", "dedupeKey already used for a different deliveryId"));
    }
    if (existing && existing.storedAt) {
      // Idempotent success, but ensure ACK is queued if it never succeeded.
      metricInc("receiver_dedupe_hit_total", { result: "hit" }, 1);
      if (!existing.ackedAt) {
        await dedupeStore.touchDeliveryId({ dedupeKey, artifactHash, deliveryId });
        const delayMs = cfg.test?.ackInitialDelayMs && cfg.test.ackInitialDelayMs > 0 ? cfg.test.ackInitialDelayMs : 0;
        const nextAttemptAt = delayMs ? new Date(Date.now() + delayMs).toISOString() : null;
        await dedupeStore.markAckQueued({ dedupeKey, artifactHash, deliveryId, nextAttemptAt });
        metricInc("receiver_ack_queued_total", null, 1);
      }
      return sendJson(res, 200, { ok: true, dedupe: "hit", dedupeKey, artifactHash });
    }

    // Verify artifact integrity.
    const verCheck = verifyArtifactVersion(body);
    if (!verCheck.ok) {
      metricInc("receiver_verify_failed_total", { stage: "artifact_version" }, 1);
      return sendJson(res, 422, stableError("ARTIFACT_VERIFY_FAILED", verCheck.error ?? "artifact version unsupported"));
    }
    const hashCheck = verifyArtifactHash(body);
    if (!hashCheck.ok) {
      metricInc("receiver_verify_failed_total", { stage: "artifact_hash" }, 1);
      return sendJson(res, 422, stableError("ARTIFACT_VERIFY_FAILED", hashCheck.error ?? "artifact verify failed"));
    }
    const balCheck = verifySettlementBalances(body);
    if (!balCheck.ok) {
      metricInc("receiver_verify_failed_total", { stage: "settlement_balances" }, 1);
      return sendJson(res, 422, stableError("ARTIFACT_VERIFY_FAILED", balCheck.error ?? "artifact verify failed"));
    }
    metricInc("receiver_verified_total", null, 1);

    // Persist a received record (restart-safe).
    await dedupeStore.ensureReceived({ dedupeKey, artifactHash });
    await dedupeStore.touchDeliveryId({ dedupeKey, artifactHash, deliveryId });

    // Store artifact to S3/MinIO by hash.
    const key = s3.objectKeyForArtifact({ artifactHash, artifactType });
    let storeResult;
    try {
      storeResult = await s3.putJsonIfAbsent({ key, json: body, timeoutMs: 10_000 });
      if (!storeResult.ok) throw new Error(storeResult.error ?? "store failed");
      await dedupeStore.markStored({ dedupeKey, artifactHash, deliveryId });
      metricInc("receiver_stored_total", { existed: storeResult.alreadyExisted ? "true" : "false" }, 1);
    } catch (err) {
      metricInc("receiver_store_failed_total", null, 1);
      logger.error("receiver.store.failed", { dedupeKey, artifactHash, key, err });
      return sendJson(res, 502, stableError("STORE_FAILED", "failed to store artifact"));
    }

    // Queue ACK (async).
    {
      const delayMs = cfg.test?.ackInitialDelayMs && cfg.test.ackInitialDelayMs > 0 ? cfg.test.ackInitialDelayMs : 0;
      const nextAttemptAt = delayMs ? new Date(Date.now() + delayMs).toISOString() : null;
      await dedupeStore.markAckQueued({ dedupeKey, artifactHash, deliveryId, nextAttemptAt });
    }
    metricInc("receiver_ack_queued_total", null, 1);

    if (!delayedOnce && cfg.test?.delayFirstResponseMs && cfg.test.delayFirstResponseMs > 0) {
      delayedOnce = true;
      await new Promise((resolve) => setTimeout(resolve, cfg.test.delayFirstResponseMs));
    }

    return sendJson(res, 200, { ok: true, dedupeKey, artifactHash });
  }

  return sendJson(res, 404, stableError("NOT_FOUND", "not found"));
});

server.on("clientError", (err, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {}
  try {
    logger.warn("receiver.client_error", { err });
  } catch {}
});

async function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  try {
    ackWorker.stop();
  } catch {}
  logger.info("receiver.shutdown", { signal });
  await new Promise((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(cfg.port, () => {
  logger.info("receiver.listen", { port: cfg.port });
});
