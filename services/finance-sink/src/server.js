import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { createMetrics } from "../../../src/core/metrics.js";
import { logger } from "../../../src/core/log.js";
import { sha256Hex } from "../../../src/core/crypto.js";
import { hmacSignArtifact } from "../../../src/core/artifacts.js";
import { verifyArtifactHash, verifyArtifactVersion } from "../../../packages/artifact-verify/src/index.js";

import { DedupeStore } from "./dedupe-store.js";
import { loadConfig, validateConfigForReady } from "./config.js";
import { S3Store } from "./s3-store.js";
import { createAckWorker } from "./ack-worker.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

async function readJsonBody(req, { maxBytes = 5_000_000 } = {}) {
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

function safePathSegment(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replaceAll("\0", "");
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
  prefix: cfg.s3.prefix ?? "finance/",
  accessKeyId: cfg.s3.accessKeyId ?? "",
  secretAccessKey: cfg.s3.secretAccessKey ?? "",
  forcePathStyle: cfg.s3.forcePathStyle !== false
});

const ackWorker = createAckWorker({ cfg, dedupeStore, metrics, logger });
ackWorker.start();

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

async function handleJournalCsv({ artifact, tenantId }) {
  const period = String(artifact?.period ?? "");
  const csv = artifact?.csv ?? null;
  const csvSha256 = String(artifact?.csvSha256 ?? "");
  if (!period || !period.trim()) throw Object.assign(new Error("missing period"), { code: "SCHEMA_INVALID" });
  if (typeof csv !== "string" || !csv.trim()) throw Object.assign(new Error("missing csv"), { code: "SCHEMA_INVALID" });
  assertNonEmptyString(csvSha256, "csvSha256");
  const computed = sha256Hex(csv);
  if (computed !== csvSha256) throw Object.assign(new Error("csvSha256 mismatch"), { code: "CSV_SHA_MISMATCH", expected: csvSha256, actual: computed });

  const periodSeg = safePathSegment(period);
  const tenantSeg = safePathSegment(tenantId);
  const base = `tenants/${tenantSeg}/periods/${periodSeg}`;

  const csvKey = `${base}/journal.csv`;
  const metaKey = `${base}/journal.meta.json`;
  const readyKey = `${base}/_READY_JOURNAL.json`;

  const csvBytes = new TextEncoder().encode(csv);
  const putCsv = await s3.putBytesIfAbsent({ key: csvKey, bytes: csvBytes, contentType: "text/csv; charset=utf-8" });
  if (!putCsv.ok) throw Object.assign(new Error(`s3 put failed (${putCsv.status ?? "unknown"})`), { code: "S3_PUT_FAILED", detail: putCsv });

  const meta = {
    type: "JournalCsvSink.v1",
    tenantId,
    period,
    artifactId: artifact.artifactId ?? null,
    artifactHash: artifact.artifactHash ?? null,
    csvSha256,
    storedAt: nowIso()
  };
  const putMeta = await s3.putJsonIfAbsent({ key: metaKey, json: meta });
  if (!putMeta.ok) throw Object.assign(new Error(`s3 put meta failed (${putMeta.status ?? "unknown"})`), { code: "S3_PUT_FAILED", detail: putMeta });

  const ready = { ok: true, kind: "journal", ...meta };
  const putReady = await s3.putJsonIfAbsent({ key: readyKey, json: ready });
  if (!putReady.ok) throw Object.assign(new Error(`s3 put ready failed (${putReady.status ?? "unknown"})`), { code: "S3_PUT_FAILED", detail: putReady });

  return { ok: true, keys: { csvKey, metaKey, readyKey }, alreadyExisted: Boolean(putCsv.alreadyExisted) };
}

async function handleFinancePackPointer({ artifact, tenantId }) {
  const period = String(artifact?.period ?? "");
  const bundleHash = String(artifact?.bundleHash ?? "");
  const objectStore = artifact?.objectStore ?? null;
  if (!period || !period.trim()) throw Object.assign(new Error("missing period"), { code: "SCHEMA_INVALID" });
  assertNonEmptyString(bundleHash, "bundleHash");
  if (!objectStore || typeof objectStore !== "object") throw Object.assign(new Error("missing objectStore"), { code: "SCHEMA_INVALID" });
  if (objectStore.kind !== "s3") throw Object.assign(new Error("unsupported objectStore kind"), { code: "UNSUPPORTED_OBJECT_STORE", kind: objectStore.kind });
  assertNonEmptyString(objectStore.bucket, "objectStore.bucket");
  assertNonEmptyString(objectStore.key, "objectStore.key");

  const bytes = await s3.getBytes({
    endpoint: objectStore.endpoint ?? null,
    region: objectStore.region ?? null,
    bucket: objectStore.bucket,
    key: objectStore.key,
    forcePathStyle: objectStore.forcePathStyle
  });
  const actual = sha256Hex(bytes);
  if (actual !== bundleHash) {
    throw Object.assign(new Error("bundleHash mismatch"), { code: "BUNDLE_HASH_MISMATCH", expected: bundleHash, actual });
  }

  const periodSeg = safePathSegment(period);
  const tenantSeg = safePathSegment(tenantId);
  const base = `tenants/${tenantSeg}/periods/${periodSeg}`;

  const zipKey = `${base}/finance_pack_bundle.${bundleHash}.zip`;
  const metaKey = `${base}/finance_pack_bundle.${bundleHash}.meta.json`;
  const readyKey = `${base}/_READY_FINANCE_PACK.${bundleHash}.json`;

  const putZip = await s3.putBytesIfAbsent({ key: zipKey, bytes, contentType: "application/zip" });
  if (!putZip.ok) throw Object.assign(new Error(`s3 put zip failed (${putZip.status ?? "unknown"})`), { code: "S3_PUT_FAILED", detail: putZip });

  const meta = {
    type: "FinancePackBundleSink.v1",
    tenantId,
    period,
    artifactId: artifact.artifactId ?? null,
    artifactHash: artifact.artifactHash ?? null,
    bundleHash,
    storedAt: nowIso(),
    inputs: artifact.inputs ?? null,
    evidenceRef: artifact.evidenceRef ?? null,
    sourceObjectStore: objectStore
  };
  const putMeta = await s3.putJsonIfAbsent({ key: metaKey, json: meta });
  if (!putMeta.ok) throw Object.assign(new Error(`s3 put meta failed (${putMeta.status ?? "unknown"})`), { code: "S3_PUT_FAILED", detail: putMeta });

  const ready = { ok: true, kind: "finance_pack", ...meta };
  const putReady = await s3.putJsonIfAbsent({ key: readyKey, json: ready });
  if (!putReady.ok) throw Object.assign(new Error(`s3 put ready failed (${putReady.status ?? "unknown"})`), { code: "S3_PUT_FAILED", detail: putReady });

  return { ok: true, keys: { zipKey, metaKey, readyKey }, alreadyExisted: Boolean(putZip.alreadyExisted) };
}

const server = http.createServer(async (req, res) => {
  const method = String(req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  metricInc("finance_sink_requests_total", { route: pathname, method }, 1);

  if (method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true });

  if (method === "GET" && pathname === "/metrics") {
    metricGauge("finance_sink_inflight_acks_gauge", null, metrics.getGauge("finance_sink_inflight_acks_gauge", null));
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
    if (!delayedOnce && cfg.test?.delayFirstResponseMs && cfg.test.delayFirstResponseMs > 0) {
      delayedOnce = true;
      await new Promise((resolve) => setTimeout(resolve, cfg.test.delayFirstResponseMs));
    }

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
    if (!artifactHash || typeof artifactHash !== "string" || !artifactHash.trim()) return sendJson(res, 400, stableError("SCHEMA_INVALID", "artifactHash is required"));

    try {
      if (!cfg.hmacSecret) throw new Error("finance sink not configured with hmac secret");
      const sigOk = verifyWebhook({ secret: cfg.hmacSecret, timestamp, signature, bodyJson: body });
      if (!sigOk.ok) {
        metricInc("finance_sink_verify_failed_total", { stage: "hmac", code: sigOk.code }, 1);
        return sendJson(res, 401, stableError(sigOk.code, sigOk.message));
      }
    } catch (err) {
      metricInc("finance_sink_verify_failed_total", { stage: "hmac", code: "EXCEPTION" }, 1);
      return sendJson(res, 401, stableError("BAD_SIGNATURE", "bad signature"));
    }

    try {
      const v = verifyArtifactVersion(body);
      if (!v.ok) {
        metricInc("finance_sink_verify_failed_total", { stage: "artifact_version", code: v.error }, 1);
        return sendJson(res, 422, stableError("VERIFY_FAILED", v.error, v));
      }
      const h = verifyArtifactHash(body);
      if (!h.ok) {
        metricInc("finance_sink_verify_failed_total", { stage: "artifact_hash", code: h.error }, 1);
        return sendJson(res, 422, stableError("VERIFY_FAILED", h.error, h));
      }
      if (artifactType && v.artifactType && artifactType !== v.artifactType) {
        metricInc("finance_sink_verify_failed_total", { stage: "artifact_type", code: "HEADER_MISMATCH" }, 1);
        return sendJson(res, 422, stableError("VERIFY_FAILED", "artifact type header mismatch"));
      }
    } catch (err) {
      metricInc("finance_sink_verify_failed_total", { stage: "artifact_hash", code: "EXCEPTION" }, 1);
      return sendJson(res, 422, stableError("VERIFY_FAILED", err?.message ?? "verify failed"));
    }

    const tenantId = String(body?.tenantId ?? cfg.tenantId ?? "");
    if (cfg.tenantId && tenantId && tenantId !== cfg.tenantId) {
      metricInc("finance_sink_rejected_total", { reason: "TENANT_MISMATCH" }, 1);
      return sendJson(res, 403, stableError("TENANT_MISMATCH", "tenantId mismatch"));
    }

    const existing = dedupeStore.get(dedupeKey);
    if (existing) {
      if (String(existing.artifactHash ?? "") !== String(artifactHash)) {
        metricInc("finance_sink_dedupe_mismatch_total", null, 1);
        return sendJson(res, 409, stableError("DEDUPE_MISMATCH", "dedupeKey already used for different artifactHash"));
      }
      metricInc("finance_sink_dedupe_hit_total", null, 1);
      return sendJson(res, 200, { ok: true, deduped: true });
    }

    await dedupeStore.ensureReceived({ dedupeKey, artifactHash });
    await dedupeStore.touchDeliveryId({ dedupeKey, artifactHash, deliveryId });

    try {
      let stored;
      if (artifactType === "JournalCsv.v1") {
        stored = await handleJournalCsv({ artifact: body, tenantId });
        metricInc("finance_sink_stored_total", { kind: "journal_csv" }, 1);
      } else if (artifactType === "FinancePackBundle.v1") {
        stored = await handleFinancePackPointer({ artifact: body, tenantId });
        metricInc("finance_sink_stored_total", { kind: "finance_pack_bundle" }, 1);
      } else {
        metricInc("finance_sink_rejected_total", { reason: "UNSUPPORTED_ARTIFACT" }, 1);
        return sendJson(res, 422, stableError("UNSUPPORTED_ARTIFACT", `unsupported artifactType: ${artifactType}`));
      }

      await dedupeStore.markStored({ dedupeKey, artifactHash, deliveryId });
      await dedupeStore.markAckQueued({ dedupeKey, artifactHash, deliveryId });
      metricInc("finance_sink_ack_queued_total", null, 1);
      return sendJson(res, 200, { ok: true, stored });
    } catch (err) {
      metricInc("finance_sink_store_failed_total", { code: err?.code ?? "EXCEPTION" }, 1);
      logger.error("finance_sink.store.failed", { dedupeKey, artifactType, artifactHash, err });
      return sendJson(res, 500, stableError(err?.code ?? "STORE_FAILED", err?.message ?? "store failed"));
    }
  }

  res.statusCode = 404;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(stableError("NOT_FOUND", "not found")));
});

server.listen(cfg.port, () => {
  logger.info("finance_sink.started", { port: cfg.port });
});

function shutdown() {
  if (stopped) return;
  stopped = true;
  try {
    ackWorker.stop();
  } catch {}
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

