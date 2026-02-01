function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function normalizeMetricName(name) {
  assertNonEmptyString(name, "name");
  const v = name.trim();
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(v)) throw new TypeError("metric name must match /^[a-zA-Z_:][a-zA-Z0-9_:]*$/");
  return v;
}

function normalizeLabels(labels) {
  if (labels === null || labels === undefined) return [];
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) throw new TypeError("labels must be an object");
  const out = [];
  for (const [kRaw, vRaw] of Object.entries(labels)) {
    if (vRaw === undefined) continue;
    const k = String(kRaw);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) throw new TypeError(`invalid label key: ${k}`);
    const v = String(vRaw);
    out.push([k, v]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

function escapeLabelValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"");
}

function labelsToKey(labels) {
  if (!labels.length) return "";
  return labels.map(([k, v]) => `${k}=${v}`).join("|");
}

function labelsToProm(labels) {
  if (!labels.length) return "";
  const parts = labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return `{${parts.join(",")}}`;
}

export function createMetrics() {
  const counters = new Map(); // key -> number
  const gauges = new Map(); // key -> number

  function keyFor(name, labels) {
    const metric = normalizeMetricName(name);
    const pairs = normalizeLabels(labels);
    const labelKey = labelsToKey(pairs);
    return { metric, pairs, key: labelKey ? `${metric}|${labelKey}` : metric };
  }

  function incCounter(name, labels, inc = 1) {
    const { key } = keyFor(name, labels);
    const n = Number(inc);
    if (!Number.isFinite(n) || n <= 0) throw new TypeError("inc must be a positive number");
    counters.set(key, (counters.get(key) ?? 0) + n);
  }

  function setGauge(name, labels, value) {
    const { key } = keyFor(name, labels);
    const n = Number(value);
    if (!Number.isFinite(n)) throw new TypeError("value must be a finite number");
    gauges.set(key, n);
  }

  function getCounter(name, labels) {
    const { key } = keyFor(name, labels);
    return counters.get(key) ?? 0;
  }

  function getGauge(name, labels) {
    const { key } = keyFor(name, labels);
    return gauges.get(key) ?? 0;
  }

  function snapshot() {
    const out = { counters: {}, gauges: {} };
    for (const [k, v] of counters.entries()) out.counters[k] = v;
    for (const [k, v] of gauges.entries()) out.gauges[k] = v;
    return out;
  }

  function renderPrometheusText() {
    const lines = [];

    const rows = [];
    for (const [key, value] of counters.entries()) rows.push({ key, value, type: "counter" });
    for (const [key, value] of gauges.entries()) rows.push({ key, value, type: "gauge" });
    rows.sort((a, b) => a.key.localeCompare(b.key));

    let lastMetric = null;
    for (const row of rows) {
      const [metric, ...labelParts] = row.key.split("|");
      const pairs = labelParts.length
        ? labelParts.join("|").split("|").map((kv) => {
            const idx = kv.indexOf("=");
            return idx === -1 ? [kv, ""] : [kv.slice(0, idx), kv.slice(idx + 1)];
          })
        : [];

      if (metric !== lastMetric) {
        lines.push(`# TYPE ${metric} ${row.type}`);
        lastMetric = metric;
      }

      lines.push(`${metric}${labelsToProm(pairs)} ${row.value}`);
    }

    return `${lines.join("\n")}\n`;
  }

  return {
    incCounter,
    setGauge,
    getCounter,
    getGauge,
    snapshot,
    renderPrometheusText
  };
}

