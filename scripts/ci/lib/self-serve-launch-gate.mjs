import { readFile } from "node:fs/promises";

export const DEFAULT_SELF_SERVE_REQUIRED_METRICS = Object.freeze([
  "mvsvUsd",
  "signups",
  "teamsFirstLiveSettlement",
  "payingCustomers",
  "medianTimeToFirstSettlementMinutes",
  "arbitrationMedianResolutionHours"
]);

function asFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function evaluateMetric({ key, definition }) {
  const row = definition && typeof definition === "object" && !Array.isArray(definition) ? definition : {};
  const value = asFiniteNumber(row.value);
  const targetMin = row.targetMin === undefined || row.targetMin === null ? null : asFiniteNumber(row.targetMin);
  const targetMax = row.targetMax === undefined || row.targetMax === null ? null : asFiniteNumber(row.targetMax);
  const targetMaxExclusive =
    row.targetMaxExclusive === undefined || row.targetMaxExclusive === null ? null : asFiniteNumber(row.targetMaxExclusive);
  const errors = [];

  if (value === null) errors.push("value_missing_or_invalid");
  if (row.targetMin !== undefined && row.targetMin !== null && targetMin === null) errors.push("targetMin_invalid");
  if (row.targetMax !== undefined && row.targetMax !== null && targetMax === null) errors.push("targetMax_invalid");
  if (row.targetMaxExclusive !== undefined && row.targetMaxExclusive !== null && targetMaxExclusive === null) errors.push("targetMaxExclusive_invalid");
  if (targetMax !== null && targetMaxExclusive !== null) errors.push("targetMax_and_targetMaxExclusive_conflict");

  let ok = errors.length === 0;
  if (ok && targetMin !== null && value < targetMin) ok = false;
  if (ok && targetMax !== null && value > targetMax) ok = false;
  if (ok && targetMaxExclusive !== null && value >= targetMaxExclusive) ok = false;

  return {
    key,
    label: typeof row.label === "string" && row.label.trim() !== "" ? row.label.trim() : key,
    value,
    targetMin,
    targetMax,
    targetMaxExclusive,
    unit: typeof row.unit === "string" && row.unit.trim() !== "" ? row.unit.trim() : null,
    ok,
    errors
  };
}

export function evaluateSelfServeLaunchTracker(parsed) {
  const tracker = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const metrics = tracker.metrics && typeof tracker.metrics === "object" && !Array.isArray(tracker.metrics) ? tracker.metrics : {};
  const requiredRaw = Array.isArray(tracker.requiredMetrics) ? tracker.requiredMetrics : DEFAULT_SELF_SERVE_REQUIRED_METRICS;
  const requiredMetrics = Array.from(
    new Set(
      requiredRaw
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    )
  );

  const metricResults = requiredMetrics.map((key) => evaluateMetric({ key, definition: metrics[key] ?? null }));
  const missingMetrics = metricResults.filter((metric) => metric.value === null).map((metric) => metric.key);
  const failedMetrics = metricResults.filter((metric) => metric.ok !== true).map((metric) => metric.key);
  const ok = failedMetrics.length === 0;

  return {
    ok,
    evaluatedAt: new Date().toISOString(),
    schemaVersion: "SelfServeLaunchGateEvaluation.v1",
    trackerSchemaVersion: typeof tracker.schemaVersion === "string" ? tracker.schemaVersion : null,
    window: tracker.window && typeof tracker.window === "object" && !Array.isArray(tracker.window) ? tracker.window : null,
    requiredMetrics,
    missingMetrics,
    failedMetrics,
    metrics: metricResults,
    summary: {
      requiredCount: requiredMetrics.length,
      passedCount: metricResults.filter((metric) => metric.ok).length,
      failedCount: failedMetrics.length
    }
  };
}

export async function loadSelfServeLaunchTrackerFromPath(pathname) {
  const raw = await readFile(pathname, "utf8");
  const parsed = JSON.parse(raw);
  return evaluateSelfServeLaunchTracker(parsed);
}
