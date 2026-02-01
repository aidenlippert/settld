import { hmacSignArtifact } from "../../../src/core/artifacts.js";
import { SETTLD_PROTOCOL_CURRENT } from "../../../src/core/protocol.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function computeBackoffMs({ attempts, baseMs = 1000, maxMs = 60_000, random = Math.random }) {
  if (!Number.isInteger(attempts) || attempts <= 0) return baseMs;
  const exp = Math.min(16, attempts);
  const raw = Math.min(maxMs, baseMs * 2 ** exp);
  const jitter = 0.8 + random() * 0.4;
  return Math.max(baseMs, Math.floor(raw * jitter));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return await fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  try {
    return await fetch(url, { ...(options ?? {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createAckWorker({ cfg, dedupeStore, metrics, logger }) {
  if (!cfg || typeof cfg !== "object") throw new TypeError("cfg is required");
  if (!dedupeStore) throw new TypeError("dedupeStore is required");

  const ackUrl = cfg.ackUrl;
  const tenantId = cfg.tenantId;
  const destinationId = cfg.destinationId;
  const secret = cfg.hmacSecret;
  const timeoutMs = cfg.ack?.timeoutMs ?? 5000;
  const maxInflight = cfg.ack?.maxInflight ?? 10;
  const retryMax = cfg.ack?.retryMax ?? 50;

  assertNonEmptyString(ackUrl, "FINANCE_SINK_ACK_URL");
  assertNonEmptyString(tenantId, "FINANCE_SINK_TENANT_ID");
  assertNonEmptyString(destinationId, "FINANCE_SINK_DESTINATION_ID");
  assertNonEmptyString(secret, "FINANCE_SINK_HMAC_SECRET");

  const inflight = new Set(); // dedupeKey
  let stopped = false;

  function metricInc(name, labels, value = 1) {
    try {
      metrics?.incCounter?.(name, labels, value);
    } catch {}
  }

  function metricGauge(name, labels, value) {
    try {
      metrics?.setGauge?.(name, labels, value);
    } catch {}
  }

  async function attemptAck({ record }) {
    const dedupeKey = String(record.dedupeKey ?? "");
    const artifactHash = String(record.artifactHash ?? "");
    const deliveryId = record.deliveryId ?? null;
    if (!deliveryId) throw new Error("missing deliveryId for ack");

    const bodyJson = { deliveryId, artifactHash, receivedAt: new Date().toISOString() };
    const timestamp = new Date().toISOString();
    const signature = hmacSignArtifact({ secret, timestamp, bodyJson });

    const res = await fetchWithTimeout(
      ackUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-settld-protocol": SETTLD_PROTOCOL_CURRENT,
          "x-proxy-tenant-id": tenantId,
          "x-proxy-destination-id": destinationId,
          "x-proxy-timestamp": timestamp,
          "x-proxy-signature": signature,
          "x-proxy-dedupe-key": dedupeKey
        },
        body: JSON.stringify(bodyJson)
      },
      timeoutMs
    );

    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text ? `http ${res.status}: ${text.slice(0, 200)}` : `http ${res.status}`);
    }
  }

  async function tick() {
    if (stopped) return;
    metricGauge("finance_sink_inflight_acks_gauge", null, inflight.size);
    if (inflight.size >= maxInflight) return;

    const capacity = maxInflight - inflight.size;
    const due = dedupeStore.listPendingAcks({ limit: capacity });
    for (const record of due) {
      const dedupeKey = String(record.dedupeKey ?? "");
      if (!dedupeKey || inflight.has(dedupeKey)) continue;
      inflight.add(dedupeKey);
      const attempts = (Number.isSafeInteger(record.ackAttempts) ? record.ackAttempts : 0) + 1;
      const artifactHash = String(record.artifactHash ?? "");
      const deliveryId = String(record.deliveryId ?? "");
      const p = (async () => {
        try {
          await attemptAck({ record });
          await dedupeStore.markAckResult({ dedupeKey, artifactHash, deliveryId, ok: true, attempts, nextAttemptAt: null, error: null });
          metricInc("finance_sink_ack_success_total", null, 1);
          if (logger) logger.info("finance_sink.ack.ok", { dedupeKey, artifactHash, attempts });
        } catch (err) {
          const errMsg = err?.message ?? String(err);
          metricInc("finance_sink_ack_failed_total", null, 1);
          const permanent = attempts >= retryMax;
          const delayMs = permanent ? 0 : computeBackoffMs({ attempts, baseMs: 1000, maxMs: 60_000 });
          const nextAttemptAt = permanent ? null : new Date(Date.now() + delayMs).toISOString();
          await dedupeStore.markAckResult({ dedupeKey, artifactHash, deliveryId, ok: false, attempts, nextAttemptAt, error: errMsg });
          if (logger) logger.error("finance_sink.ack.failed", { dedupeKey, artifactHash, attempts, permanent, err });
        } finally {
          inflight.delete(dedupeKey);
          metricGauge("finance_sink_inflight_acks_gauge", null, inflight.size);
        }
      })();
      p.catch(() => {});
    }
  }

  async function loop() {
    while (!stopped) {
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return {
    start() {
      loop().catch((err) => {
        try {
          logger?.error?.("finance_sink.ack_worker.crashed", { err });
        } catch {}
      });
    },
    stop() {
      stopped = true;
    }
  };
}

