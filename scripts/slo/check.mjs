import assert from "node:assert/strict";
import fs from "node:fs/promises";

const API_BASE_URL = process.env.SLO_API_BASE_URL ?? "http://127.0.0.1:3000";
const METRICS_PATH = process.env.SLO_METRICS_PATH ?? "/metrics";
const METRICS_FILE = process.env.SLO_METRICS_FILE ?? null;

const MAX_HTTP_5XX_TOTAL = Number(process.env.SLO_MAX_HTTP_5XX_TOTAL ?? "0");
const MAX_OUTBOX_PENDING = Number(process.env.SLO_MAX_OUTBOX_PENDING ?? "200");
const MAX_DELIVERY_DLQ = Number(process.env.SLO_MAX_DELIVERY_DLQ ?? "0");
const MAX_DELIVERIES_PENDING = Number(process.env.SLO_MAX_DELIVERIES_PENDING ?? "0");
const MAX_DELIVERIES_FAILED = Number(process.env.SLO_MAX_DELIVERIES_FAILED ?? "0");

function assertFiniteNumber(n, name) {
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be finite`);
}

for (const [k, v] of [
  ["SLO_MAX_HTTP_5XX_TOTAL", MAX_HTTP_5XX_TOTAL],
  ["SLO_MAX_OUTBOX_PENDING", MAX_OUTBOX_PENDING],
  ["SLO_MAX_DELIVERY_DLQ", MAX_DELIVERY_DLQ],
  ["SLO_MAX_DELIVERIES_PENDING", MAX_DELIVERIES_PENDING],
  ["SLO_MAX_DELIVERIES_FAILED", MAX_DELIVERIES_FAILED]
]) {
  assertFiniteNumber(v, k);
  if (v < 0) throw new TypeError(`${k} must be >= 0`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTextWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function unescapeLabelValue(value) {
  // Prometheus exposition escaping.
  return String(value).replaceAll("\\\\", "\\").replaceAll("\\n", "\n").replaceAll('\\"', '"');
}

function parseLabels(src) {
  const labels = {};
  let i = 0;
  while (i < src.length) {
    while (i < src.length && (src[i] === " " || src[i] === ",")) i += 1;
    if (i >= src.length) break;
    let key = "";
    while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) {
      key += src[i];
      i += 1;
    }
    while (i < src.length && src[i] === " ") i += 1;
    if (src[i] !== "=") break;
    i += 1;
    while (i < src.length && src[i] === " ") i += 1;
    if (src[i] !== '"') break;
    i += 1;
    let value = "";
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"') {
        i += 1;
        break;
      }
      if (ch === "\\") {
        const next = src[i + 1];
        if (next === "n") {
          value += "\n";
          i += 2;
          continue;
        }
        if (next === "\\" || next === '"') {
          value += next;
          i += 2;
          continue;
        }
      }
      value += ch;
      i += 1;
    }
    labels[key] = unescapeLabelValue(value);
    while (i < src.length && src[i] !== ",") i += 1;
    if (src[i] === ",") i += 1;
  }
  return labels;
}

function parsePrometheusText(text) {
  const series = [];
  const lines = String(text ?? "").split("\n");
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    // name{labels} value
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?|NaN|Inf|-Inf)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const labelsRaw = m[2] ?? "";
    const value = Number(m[3]);
    const labels = labelsRaw.startsWith("{") ? parseLabels(labelsRaw.slice(1, -1)) : {};
    series.push({ name, labels, value });
  }
  return series;
}

function sumWhere(series, { name, where = () => true } = {}) {
  let sum = 0;
  for (const s of series) {
    if (s.name !== name) continue;
    if (!where(s.labels, s.value)) continue;
    const v = Number(s.value);
    if (!Number.isFinite(v)) continue;
    sum += v;
  }
  return sum;
}

function getOne(series, { name, where = () => true } = {}) {
  for (const s of series) {
    if (s.name !== name) continue;
    if (!where(s.labels, s.value)) continue;
    return Number(s.value);
  }
  return null;
}

async function main() {
  let metricsText;
  if (METRICS_FILE) {
    metricsText = await fs.readFile(METRICS_FILE, "utf8");
  } else {
    // Give the server a moment to flush post-lifecycle gauges.
    await sleep(250);
    const r = await fetchTextWithTimeout(`${API_BASE_URL}${METRICS_PATH}`, 10_000);
    assert.equal(r.status, 200, `GET ${METRICS_PATH} failed: http ${r.status}`);
    metricsText = r.text;
  }

  const series = parsePrometheusText(metricsText);

  const http5xxTotal = sumWhere(series, {
    name: "http_requests_total",
    where: (labels) => typeof labels.status === "string" && labels.status.startsWith("5")
  });

  const outboxPending = sumWhere(series, { name: "outbox_pending_gauge" });
  const deliveryDlq = getOne(series, { name: "delivery_dlq_pending_total_gauge" }) ?? 0;
  const deliveriesPending = getOne(series, { name: "deliveries_pending_gauge", where: (l) => l.state === "pending" }) ?? 0;
  const deliveriesFailed = getOne(series, { name: "deliveries_pending_gauge", where: (l) => l.state === "failed" }) ?? 0;

  const summary = {
    http5xxTotal,
    outboxPending,
    deliveryDlq,
    deliveriesPending,
    deliveriesFailed
  };
  // Single-line JSON for CI logs.
  console.log(JSON.stringify({ slo: summary }));

  assert.ok(http5xxTotal <= MAX_HTTP_5XX_TOTAL, `SLO breach: http 5xx total ${http5xxTotal} > ${MAX_HTTP_5XX_TOTAL}`);
  assert.ok(outboxPending <= MAX_OUTBOX_PENDING, `SLO breach: outbox pending ${outboxPending} > ${MAX_OUTBOX_PENDING}`);
  assert.ok(deliveryDlq <= MAX_DELIVERY_DLQ, `SLO breach: delivery DLQ ${deliveryDlq} > ${MAX_DELIVERY_DLQ}`);
  assert.ok(deliveriesPending <= MAX_DELIVERIES_PENDING, `SLO breach: deliveries pending ${deliveriesPending} > ${MAX_DELIVERIES_PENDING}`);
  assert.ok(deliveriesFailed <= MAX_DELIVERIES_FAILED, `SLO breach: deliveries failed ${deliveriesFailed} > ${MAX_DELIVERIES_FAILED}`);
}

await main();

