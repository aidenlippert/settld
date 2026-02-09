import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { evaluateSelfServeLaunchTracker, loadSelfServeLaunchTrackerFromPath } from "../scripts/ci/lib/self-serve-launch-gate.mjs";

test("self-serve launch gate evaluator: passes when all KPI thresholds are satisfied", async () => {
  const tracker = {
    schemaVersion: "SelfServeLaunchTracker.v1",
    requiredMetrics: ["signups", "payingCustomers", "medianTimeToFirstSettlementMinutes"],
    metrics: {
      signups: { value: 21, targetMin: 20 },
      payingCustomers: { value: 3, targetMin: 3 },
      medianTimeToFirstSettlementMinutes: { value: 19.9, targetMaxExclusive: 20 }
    }
  };
  const result = evaluateSelfServeLaunchTracker(tracker);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failedMetrics, []);
  assert.equal(result.summary.requiredCount, 3);
  assert.equal(result.summary.passedCount, 3);
});

test("self-serve launch gate evaluator: fails when KPI thresholds are not met", async () => {
  const tracker = {
    schemaVersion: "SelfServeLaunchTracker.v1",
    requiredMetrics: ["signups", "payingCustomers", "medianTimeToFirstSettlementMinutes"],
    metrics: {
      signups: { value: 18, targetMin: 20 },
      payingCustomers: { value: 2, targetMin: 3 },
      medianTimeToFirstSettlementMinutes: { value: 20, targetMaxExclusive: 20 }
    }
  };
  const result = evaluateSelfServeLaunchTracker(tracker);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failedMetrics.sort(), ["medianTimeToFirstSettlementMinutes", "payingCustomers", "signups"]);
  assert.equal(result.summary.failedCount, 3);
});

test("self-serve launch tracker file: default tracker validates", async () => {
  const trackerPath = "planning/launch/self-serve-launch-tracker.json";
  const raw = JSON.parse(await readFile(trackerPath, "utf8"));
  assert.equal(raw.schemaVersion, "SelfServeLaunchTracker.v1");

  const result = await loadSelfServeLaunchTrackerFromPath(trackerPath);
  assert.equal(result.ok, true);
  assert.equal(Array.isArray(result.metrics), true);
  assert.ok(result.metrics.length >= 6);
});
