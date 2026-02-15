import { canonicalJsonStringify } from "../../core/canonical-json.js";
import { hmacSignArtifact } from "../../core/artifacts.js";
import { presignS3Url } from "../../core/s3-presign.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "../../core/tenancy.js";
import { failpoint } from "../../core/failpoints.js";
import { logger } from "../../core/log.js";
import { clampRetentionDays, computeExpiresAtIso } from "../../core/retention.js";

function parseNonNegativeIntEnv(name, fallback) {
  if (typeof process === "undefined" || !process.env) return fallback;
  const raw = process.env[name] ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

function parsePositiveIntEnv(name, fallback) {
  if (typeof process === "undefined" || !process.env) return fallback;
  const raw = process.env[name] ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

const deliveriesRetentionMaxDays = parseNonNegativeIntEnv("PROXY_RETENTION_DELIVERIES_MAX_DAYS", 0);
const deliveryDlqRetentionMaxDays = parseNonNegativeIntEnv("PROXY_RETENTION_DELIVERY_DLQ_MAX_DAYS", deliveriesRetentionMaxDays);

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function computeBackoffMs({ attempts, baseMs = 1000, maxMs = 60_000, random = Math.random }) {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) return baseMs;
  const exp = Math.min(16, attempts);
  const raw = Math.min(maxMs, baseMs * 2 ** exp);
  // Add jitter [0.8, 1.2]
  const jitter = 0.8 + random() * 0.4;
  return Math.max(baseMs, Math.floor(raw * jitter));
}

function headerSafeValue(value) {
  // Prevent fetch/undici from throwing on invalid header values (CTL chars, newlines).
  // `orderKey` is allowed to include newlines internally; for transport we normalize it.
  const s = String(value ?? "");
  return s.replaceAll(/[\u0000-\u001F\u007F]/g, " ").trim();
}

async function fetchWithTimeout(fetchFn, url, options, timeoutMs) {
  if (typeof fetchFn !== "function") throw new TypeError("fetchFn must be a function");
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return await fetchFn(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  try {
    return await fetchFn(url, { ...(options ?? {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createDeliveryWorker({
  store,
  nowIso,
  listDestinationsForTenant,
  maxAttempts = 10,
  backoffBaseMs = 1000,
  backoffMaxMs = 60_000,
  random = Math.random,
  fetchFn = null
}) {
  if (!store) throw new TypeError("store is required");
  if (typeof nowIso !== "function") throw new TypeError("nowIso is required");
  if (typeof listDestinationsForTenant !== "function") throw new TypeError("listDestinationsForTenant is required");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) throw new TypeError("maxAttempts must be a positive integer");
  if (!Number.isSafeInteger(backoffBaseMs) || backoffBaseMs <= 0) throw new TypeError("backoffBaseMs must be a positive integer");
  if (!Number.isSafeInteger(backoffMaxMs) || backoffMaxMs <= 0) throw new TypeError("backoffMaxMs must be a positive integer");
  if (typeof random !== "function") throw new TypeError("random must be a function");
  if (fetchFn !== null && typeof fetchFn !== "function") throw new TypeError("fetchFn must be a function or null");

  const fetchImpl = fetchFn ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is not available (pass fetchFn)");

  const deliveryHttpTimeoutMs = parseNonNegativeIntEnv("PROXY_DELIVERY_HTTP_TIMEOUT_MS", 0);
  const deliveryWorkerConcurrency = Math.min(50, parsePositiveIntEnv("PROXY_WORKER_CONCURRENCY_DELIVERIES", 1));

  function retentionForTenant(tenantId) {
    const cfg = typeof store.getConfig === "function" ? store.getConfig(tenantId) : store.config;
    const retention = cfg?.retention ?? {};
    const deliveriesDays = Number.isSafeInteger(retention?.deliveriesDays) ? retention.deliveriesDays : 0;
    const deliveryDlqDays =
      Number.isSafeInteger(retention?.deliveryDlqDays) ? retention.deliveryDlqDays : Number.isSafeInteger(retention?.deliveriesDays) ? retention.deliveriesDays : 0;
    return { deliveriesDays, deliveryDlqDays };
  }

  function expiresAtForState({ tenantId, state, at }) {
    const { deliveriesDays, deliveryDlqDays } = retentionForTenant(tenantId);
    if (state === "delivered") {
      const days = clampRetentionDays({ tenantDays: deliveriesDays, defaultDays: 0, maxDays: deliveriesRetentionMaxDays });
      return computeExpiresAtIso({ at, retentionDays: days });
    }
    if (state === "failed") {
      const days = clampRetentionDays({ tenantDays: deliveryDlqDays, defaultDays: 0, maxDays: deliveryDlqRetentionMaxDays });
      return computeExpiresAtIso({ at, retentionDays: days });
    }
    return null;
  }

  function findDestination({ tenantId, destinationId }) {
    const list = listDestinationsForTenant(tenantId);
    return list.find((d) => d.destinationId === destinationId) ?? null;
  }

  function safeKeySegment(value) {
    return String(value ?? "")
      .trim()
      .replaceAll("/", "_")
      .replaceAll("\\", "_")
      .replaceAll("\0", "");
  }

  function artifactObjectKey({ tenantId, destination, delivery, artifact }) {
    const prefix = typeof destination?.prefix === "string" && destination.prefix.trim() ? destination.prefix.trim().replaceAll(/\/+$/g, "") : "";
    const tenantSeg = safeKeySegment(tenantId);
    const typeSeg = safeKeySegment(delivery.artifactType ?? artifact.artifactType ?? artifact.schemaVersion ?? "Artifact");
    const idSeg = safeKeySegment(delivery.artifactId ?? artifact.artifactId ?? artifact.id ?? "artifact");
    const hashSeg = safeKeySegment(delivery.artifactHash ?? artifact.artifactHash ?? "hash");
    const base = `tenants/${tenantSeg}/artifacts/${typeSeg}/${idSeg}_${hashSeg}.json`;
    return prefix ? `${prefix}/${base}` : base;
  }

  function failureReasonForSecretError(err) {
    const code = typeof err?.code === "string" ? err.code : null;
    if (!code) return "secret_error";
    if (code === "SECRET_REF_INVALID") return "secret_ref_invalid";
    if (code === "SECRET_PROVIDER_FORBIDDEN") return "secret_provider_forbidden";
    if (code === "SECRET_PROVIDER_UNAVAILABLE") return "secret_provider_unavailable";
    if (code === "SECRET_NOT_FOUND") return "secret_not_found";
    if (code === "SECRET_READ_FAILED") return "secret_read_failed";
    return "secret_error";
  }

  async function resolveSecretValue({ tenantId, inlineValue, ref, fieldName }) {
    if (typeof inlineValue === "string" && inlineValue.trim() !== "") return inlineValue;
    if (typeof ref === "string" && ref.trim() !== "") {
      if (!store?.secrets || typeof store.secrets.getSecret !== "function") throw new Error("secrets provider not configured");
      const s = await store.secrets.getSecret({ tenantId, ref });
      const value = s?.value ?? null;
      if (typeof value !== "string" || value.trim() === "") throw new Error("secret value is empty");
      return value;
    }
    throw new Error(`${fieldName} is required`);
  }

  async function attemptOne({ tenantId, delivery }) {
    const dest = findDestination({ tenantId, destinationId: delivery.destinationId });
    if (!dest) {
      return { ok: false, status: null, error: "unknown destinationId", destinationType: "unknown", failureReason: "unknown_destination" };
    }

    const artifact = await store.getArtifact({ tenantId, artifactId: delivery.artifactId });
    if (!artifact) return { ok: false, status: null, error: "artifact not found", destinationType: dest.kind ?? "webhook", failureReason: "missing_artifact" };

    const kind = dest.kind ?? "webhook";
    if (kind === "s3") {
      assertNonEmptyString(dest.endpoint, "destination.endpoint");
      assertNonEmptyString(dest.region, "destination.region");
      assertNonEmptyString(dest.bucket, "destination.bucket");
      let accessKeyId;
      let secretAccessKey;
      try {
        accessKeyId = await resolveSecretValue({
          tenantId,
          inlineValue: dest.accessKeyId,
          ref: dest.accessKeyIdRef,
          fieldName: "destination.accessKeyId"
        });
        secretAccessKey = await resolveSecretValue({
          tenantId,
          inlineValue: dest.secretAccessKey,
          ref: dest.secretAccessKeyRef,
          fieldName: "destination.secretAccessKey"
        });
      } catch (err) {
        return {
          ok: false,
          status: null,
          error: "destination credentials unavailable",
          destinationType: "s3",
          failureReason: failureReasonForSecretError(err)
        };
      }

      const key = artifactObjectKey({ tenantId, destination: dest, delivery, artifact });
      const now = new Date(Date.parse(nowIso()));
      const url = presignS3Url({
        endpoint: dest.endpoint,
        region: dest.region,
        bucket: dest.bucket,
        key,
        method: "PUT",
        accessKeyId,
        secretAccessKey,
        forcePathStyle: dest.forcePathStyle !== false,
        expiresInSeconds: 300,
        now: Number.isFinite(now.getTime()) ? now : new Date()
      });

      const body = canonicalJsonStringify(artifact);
      let res;
      try {
        res = await fetchWithTimeout(
          fetchImpl,
          url,
          {
            method: "PUT",
            headers: { "content-type": "application/json; charset=utf-8" },
            body
          },
          deliveryHttpTimeoutMs
        );
      } catch (err) {
        const isTimeout = err?.name === "AbortError" || String(err?.message ?? "").toLowerCase().includes("timeout");
        return { ok: false, status: null, error: isTimeout ? "timeout" : "network error", destinationType: "s3", failureReason: isTimeout ? "timeout" : "network_error" };
      }
      const ok = res.status >= 200 && res.status < 300;
      if (ok) failpoint("delivery.s3.after_put_before_mark");
      return { ok, status: res.status, error: ok ? null : `http ${res.status}`, destinationType: "s3", failureReason: ok ? null : "non_2xx" };
    }

    // Default: webhook
    assertNonEmptyString(dest.url, "destination.url");
    let secret;
    try {
      secret = await resolveSecretValue({ tenantId, inlineValue: dest.secret, ref: dest.secretRef, fieldName: "destination.secret" });
    } catch (err) {
      return {
        ok: false,
        status: null,
        error: "destination secret unavailable",
        destinationType: "webhook",
        failureReason: failureReasonForSecretError(err)
      };
    }

    const timestamp = nowIso();
    const signature = hmacSignArtifact({ secret, timestamp, bodyJson: artifact });
    const body = canonicalJsonStringify(artifact);

    let res;
    try {
      res = await fetchWithTimeout(
        fetchImpl,
        dest.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-proxy-dedupe-key": String(delivery.dedupeKey ?? ""),
            "x-proxy-delivery-id": String(delivery.id ?? delivery.deliveryId ?? ""),
            "x-proxy-artifact-type": String(delivery.artifactType ?? ""),
            "x-proxy-artifact-id": String(delivery.artifactId ?? ""),
            "x-proxy-artifact-hash": String(delivery.artifactHash ?? ""),
            "x-proxy-order-key": headerSafeValue(delivery.orderKey ?? ""),
            "x-proxy-timestamp": timestamp,
            "x-proxy-signature": signature
          },
          body
        },
        deliveryHttpTimeoutMs
      );
    } catch (err) {
      const isTimeout = err?.name === "AbortError" || String(err?.message ?? "").toLowerCase().includes("timeout");
      const code = typeof err?.cause?.code === "string" ? err.cause.code : typeof err?.code === "string" ? err.code : null;
      const msg = typeof err?.message === "string" && err.message.trim() ? err.message.trim() : String(err ?? "");
      const detail = code ? `${code}: ${msg || "fetch failed"}` : msg || "fetch failed";
      return {
        ok: false,
        status: null,
        error: isTimeout ? "timeout" : `network error: ${detail}`,
        destinationType: "webhook",
        failureReason: isTimeout ? "timeout" : "network_error"
      };
    }

    const ok = res.status >= 200 && res.status < 300;
    if (ok) failpoint("delivery.webhook.after_post_before_mark");
    return { ok, status: res.status, error: ok ? null : `http ${res.status}`, destinationType: "webhook", failureReason: ok ? null : "non_2xx" };
  }

  async function runGroupsWithConcurrency({ groups, maxConcurrency, handler }) {
    const inFlight = new Set();
    for (const group of groups) {
      const p = (async () => handler(group))().finally(() => inFlight.delete(p));
      inFlight.add(p);
      if (inFlight.size >= maxConcurrency) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
  }

  async function tickDeliveries({ tenantId = null, maxMessages = 100 } = {}) {
    if (tenantId !== null) tenantId = normalizeTenantId(tenantId);
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new TypeError("maxMessages must be a positive safe integer");

    const processed = [];

    if (store.kind === "pg" && typeof store.claimDueDeliveries === "function" && typeof store.updateDeliveryAttempt === "function") {
      const t = tenantId ?? DEFAULT_TENANT_ID;
      const claimed = await store.claimDueDeliveries({ tenantId: t, maxMessages, worker: "delivery_v1" });
      const byScope = new Map();
      for (const row of claimed) {
        const scopeKey = typeof row?.scopeKey === "string" && row.scopeKey ? row.scopeKey : `delivery:${String(row?.id ?? "")}`;
        const list = byScope.get(scopeKey) ?? [];
        list.push(row);
        byScope.set(scopeKey, list);
      }

      const groups = Array.from(byScope.values());
      await runGroupsWithConcurrency({
        groups,
        maxConcurrency: deliveryWorkerConcurrency,
        handler: async (rows) => {
          for (const row of rows) {
            const delivery = row;
            const attempts = delivery.attempts ?? 1;
            try {
              const result = await attemptOne({ tenantId: t, delivery });
              try {
                store.metrics?.incCounter?.("delivery_attempt_total", { destinationType: result.destinationType ?? "unknown" }, 1);
              } catch {}
              logger.info("delivery.attempt", {
                tenantId: t,
                deliveryId: delivery.id,
                destinationId: delivery.destinationId,
                destinationType: result.destinationType ?? "unknown",
                dedupeKey: delivery.dedupeKey,
                artifactType: delivery.artifactType,
                artifactId: delivery.artifactId,
                artifactHash: delivery.artifactHash,
                attempts
              });
              if (result.ok) {
                const expiresAt = expiresAtForState({ tenantId: t, state: "delivered", at: nowIso() });
                await store.updateDeliveryAttempt({
                  tenantId: t,
                  id: delivery.id,
                  delivered: true,
                  state: "delivered",
                  nextAttemptAt: null,
                  lastStatus: result.status,
                  lastError: null,
                  expiresAt
                });
                try {
                  store.metrics?.incCounter?.("delivery_success_total", { destinationType: result.destinationType ?? "unknown" }, 1);
                } catch {}
                logger.info("delivery.delivered", {
                  tenantId: t,
                  deliveryId: delivery.id,
                  destinationType: result.destinationType ?? "unknown",
                  dedupeKey: delivery.dedupeKey,
                  status: result.status
                });
                processed.push({ id: delivery.id, status: "delivered" });
                continue;
              }

              if (attempts >= maxAttempts) {
                const expiresAt = expiresAtForState({ tenantId: t, state: "failed", at: nowIso() });
                await store.updateDeliveryAttempt({
                  tenantId: t,
                  id: delivery.id,
                  delivered: false,
                  state: "failed",
                  nextAttemptAt: null,
                  lastStatus: result.status,
                  lastError: result.error ?? "failed",
                  expiresAt
                });
                try {
                  store.metrics?.incCounter?.(
                    "delivery_fail_total",
                    { destinationType: result.destinationType ?? "unknown", reason: result.failureReason ?? "failed" },
                    1
                  );
                  store.metrics?.incCounter?.("delivery_dlq_total", { destinationType: result.destinationType ?? "unknown" }, 1);
                } catch {}
                logger.error("delivery.failed", {
                  tenantId: t,
                  deliveryId: delivery.id,
                  destinationType: result.destinationType ?? "unknown",
                  dedupeKey: delivery.dedupeKey,
                  status: result.status,
                  error: result.error ?? "failed"
                });
                processed.push({ id: delivery.id, status: "failed" });
                continue;
              }

              const delayMs = computeBackoffMs({ attempts, baseMs: backoffBaseMs, maxMs: backoffMaxMs, random });
              const nextAttemptAt = new Date(Date.parse(nowIso()) + delayMs).toISOString();
              await store.updateDeliveryAttempt({
                tenantId: t,
                id: delivery.id,
                delivered: false,
                state: "pending",
                nextAttemptAt,
                lastStatus: result.status,
                lastError: result.error ?? "failed",
                expiresAt: null
              });
              try {
                store.metrics?.incCounter?.(
                  "delivery_fail_total",
                  { destinationType: result.destinationType ?? "unknown", reason: result.failureReason ?? "failed" },
                  1
                );
              } catch {}
              logger.warn("delivery.retrying", {
                tenantId: t,
                deliveryId: delivery.id,
                destinationType: result.destinationType ?? "unknown",
                dedupeKey: delivery.dedupeKey,
                status: result.status,
                error: result.error ?? "failed",
                nextAttemptAt
              });
              processed.push({ id: delivery.id, status: "retrying", nextAttemptAt });
            } catch (err) {
              const lastError = typeof err?.message === "string" && err.message.trim() ? err.message : String(err ?? "delivery failed");
              try {
                store.metrics?.incCounter?.("delivery_attempt_total", { destinationType: "unknown" }, 1);
              } catch {}
              logger.error("delivery.attempt.failed", { tenantId: t, deliveryId: delivery.id, dedupeKey: delivery.dedupeKey, err });
              if (attempts >= maxAttempts) {
                const expiresAt = expiresAtForState({ tenantId: t, state: "failed", at: nowIso() });
                await store.updateDeliveryAttempt({
                  tenantId: t,
                  id: delivery.id,
                  delivered: false,
                  state: "failed",
                  nextAttemptAt: null,
                  lastStatus: null,
                  lastError,
                  expiresAt
                });
                try {
                  store.metrics?.incCounter?.("delivery_fail_total", { destinationType: "unknown", reason: "exception" }, 1);
                  store.metrics?.incCounter?.("delivery_dlq_total", { destinationType: "unknown" }, 1);
                } catch {}
                processed.push({ id: delivery.id, status: "failed" });
              } else {
                const delayMs = computeBackoffMs({ attempts, baseMs: backoffBaseMs, maxMs: backoffMaxMs, random });
                const nextAttemptAt = new Date(Date.parse(nowIso()) + delayMs).toISOString();
                await store.updateDeliveryAttempt({
                  tenantId: t,
                  id: delivery.id,
                  delivered: false,
                  state: "pending",
                  nextAttemptAt,
                  lastStatus: null,
                  lastError,
                  expiresAt: null
                });
                try {
                  store.metrics?.incCounter?.("delivery_fail_total", { destinationType: "unknown", reason: "exception" }, 1);
                } catch {}
                logger.warn("delivery.retrying", { tenantId: t, deliveryId: delivery.id, dedupeKey: delivery.dedupeKey, error: lastError, nextAttemptAt });
                processed.push({ id: delivery.id, status: "retrying", nextAttemptAt });
              }
            }
          }
        }
      });

      return { processed };
    }

    // In-memory deliveries scan.
    const t = tenantId ?? DEFAULT_TENANT_ID;
    const nowAt = nowIso();
    const nowMs = Date.parse(nowAt);
    const reclaimAfterMs = 60_000;

    const due = [];
    for (const d of store.deliveries?.values?.() ?? []) {
      if (!d || typeof d !== "object") continue;
      if (normalizeTenantId(d.tenantId ?? DEFAULT_TENANT_ID) !== t) continue;
      if (d.state !== "pending") continue;
      const dueMs = Date.parse(d.nextAttemptAt ?? 0);
      if (Number.isFinite(nowMs) && Number.isFinite(dueMs) && dueMs > nowMs) continue;
      const claimedMs = Date.parse(d.claimedAt ?? 0);
      if (Number.isFinite(nowMs) && Number.isFinite(claimedMs) && claimedMs > nowMs - reclaimAfterMs) continue;
      due.push(d);
    }
    const cmp = (a, b) => {
      const ax = String(a.scopeKey ?? "");
      const bx = String(b.scopeKey ?? "");
      if (ax !== bx) return ax.localeCompare(bx);
      const ao = Number.isSafeInteger(a.orderSeq) ? a.orderSeq : 0;
      const bo = Number.isSafeInteger(b.orderSeq) ? b.orderSeq : 0;
      if (ao !== bo) return ao - bo;
      const ap = Number.isSafeInteger(a.priority) ? a.priority : 0;
      const bp = Number.isSafeInteger(b.priority) ? b.priority : 0;
      if (ap !== bp) return ap - bp;
      const an = Date.parse(a.nextAttemptAt ?? 0);
      const bn = Date.parse(b.nextAttemptAt ?? 0);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      return String(a.deliveryId ?? a.id ?? "").localeCompare(String(b.deliveryId ?? b.id ?? ""));
    };
    due.sort(cmp);

	    for (const d of due.slice(0, maxMessages)) {
	      const attempts = (Number.isSafeInteger(d.attempts) ? d.attempts : 0) + 1;
	      const key = `${t}\n${d.deliveryId}`;
	      d.attempts = attempts;
      d.claimedAt = nowAt;
      d.worker = "delivery_v1";
      d.orderKey = `${String(d.scopeKey ?? "")}\n${String(d.orderSeq ?? "")}\n${String(d.priority ?? "")}\n${String(d.deliveryId ?? "")}`;
	      store.deliveries.set(key, d);

	      try {
	        const result = await attemptOne({ tenantId: t, delivery: d });
	        try {
	          store.metrics?.incCounter?.("delivery_attempt_total", { destinationType: result.destinationType ?? "unknown" }, 1);
	        } catch {}
	        logger.info("delivery.attempt", {
	          tenantId: t,
	          deliveryId: d.deliveryId ?? d.id ?? null,
	          destinationId: d.destinationId,
	          destinationType: result.destinationType ?? "unknown",
	          dedupeKey: d.dedupeKey,
	          artifactType: d.artifactType,
	          artifactId: d.artifactId,
	          artifactHash: d.artifactHash,
	          attempts
	        });
	        if (result.ok) {
	          d.state = "delivered";
	          d.deliveredAt = nowIso();
          d.expiresAt = expiresAtForState({ tenantId: t, state: "delivered", at: d.deliveredAt });
	          d.lastStatus = result.status;
	          d.lastError = null;
	          try {
	            store.metrics?.incCounter?.("delivery_success_total", { destinationType: result.destinationType ?? "unknown" }, 1);
	          } catch {}
	          logger.info("delivery.delivered", {
	            tenantId: t,
	            deliveryId: d.deliveryId ?? d.id ?? null,
	            destinationType: result.destinationType ?? "unknown",
	            dedupeKey: d.dedupeKey,
	            status: result.status
	          });
	          processed.push({ deliveryId: d.deliveryId, status: "delivered" });
	          store.deliveries.set(key, d);
	          continue;
	        }

	        d.lastStatus = result.status;
	        d.lastError = result.error;
	        if (attempts >= maxAttempts) {
	          d.state = "failed";
            d.expiresAt = expiresAtForState({ tenantId: t, state: "failed", at: nowIso() });
	          try {
	            store.metrics?.incCounter?.(
	              "delivery_fail_total",
	              { destinationType: result.destinationType ?? "unknown", reason: result.failureReason ?? "failed" },
	              1
	            );
	            store.metrics?.incCounter?.("delivery_dlq_total", { destinationType: result.destinationType ?? "unknown" }, 1);
	          } catch {}
	          logger.error("delivery.failed", {
	            tenantId: t,
	            deliveryId: d.deliveryId ?? d.id ?? null,
	            destinationType: result.destinationType ?? "unknown",
	            dedupeKey: d.dedupeKey,
	            status: result.status,
	            error: result.error ?? "failed"
	          });
	          processed.push({ deliveryId: d.deliveryId, status: "failed" });
	          store.deliveries.set(key, d);
	          continue;
	        }

	        const delayMs = computeBackoffMs({ attempts, baseMs: backoffBaseMs, maxMs: backoffMaxMs, random });
	        d.nextAttemptAt = new Date(Date.parse(nowIso()) + delayMs).toISOString();
	        d.claimedAt = null;
	        d.worker = null;
          d.expiresAt = null;
	        try {
	          store.metrics?.incCounter?.(
	            "delivery_fail_total",
	            { destinationType: result.destinationType ?? "unknown", reason: result.failureReason ?? "failed" },
	            1
	          );
	        } catch {}
	        logger.warn("delivery.retrying", {
	          tenantId: t,
	          deliveryId: d.deliveryId ?? d.id ?? null,
	          destinationType: result.destinationType ?? "unknown",
	          dedupeKey: d.dedupeKey,
	          status: result.status,
	          error: result.error ?? "failed",
	          nextAttemptAt: d.nextAttemptAt
	        });
	        processed.push({ deliveryId: d.deliveryId, status: "retrying", nextAttemptAt: d.nextAttemptAt });
	        store.deliveries.set(key, d);
	      } catch (err) {
	        d.lastError = typeof err?.message === "string" ? err.message : String(err);
	        try {
	          store.metrics?.incCounter?.("delivery_attempt_total", { destinationType: "unknown" }, 1);
	        } catch {}
	        logger.error("delivery.attempt.failed", { tenantId: t, deliveryId: d.deliveryId ?? d.id ?? null, dedupeKey: d.dedupeKey, err });
	        if (attempts >= maxAttempts) {
	          d.state = "failed";
            d.expiresAt = expiresAtForState({ tenantId: t, state: "failed", at: nowIso() });
	          try {
	            store.metrics?.incCounter?.("delivery_fail_total", { destinationType: "unknown", reason: "exception" }, 1);
	            store.metrics?.incCounter?.("delivery_dlq_total", { destinationType: "unknown" }, 1);
	          } catch {}
	          processed.push({ deliveryId: d.deliveryId, status: "failed" });
	          store.deliveries.set(key, d);
	        } else {
	          const delayMs = computeBackoffMs({ attempts, baseMs: backoffBaseMs, maxMs: backoffMaxMs, random });
	          d.nextAttemptAt = new Date(Date.parse(nowIso()) + delayMs).toISOString();
	          d.claimedAt = null;
	          d.worker = null;
            d.expiresAt = null;
	          try {
	            store.metrics?.incCounter?.("delivery_fail_total", { destinationType: "unknown", reason: "exception" }, 1);
	          } catch {}
	          logger.warn("delivery.retrying", { tenantId: t, deliveryId: d.deliveryId ?? d.id ?? null, dedupeKey: d.dedupeKey, error: d.lastError, nextAttemptAt: d.nextAttemptAt });
	          processed.push({ deliveryId: d.deliveryId, status: "retrying", nextAttemptAt: d.nextAttemptAt });
	          store.deliveries.set(key, d);
	        }
	      }
	    }

    return { processed };
  }

  return { tickDeliveries };
}
