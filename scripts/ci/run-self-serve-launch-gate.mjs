#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadSelfServeLaunchTrackerFromPath } from "./lib/self-serve-launch-gate.mjs";

async function main() {
  const trackerPath = resolve(
    process.cwd(),
    process.env.SELF_SERVE_LAUNCH_TRACKER_PATH || "planning/launch/self-serve-launch-tracker.json"
  );
  const reportPath = resolve(
    process.cwd(),
    process.env.SELF_SERVE_LAUNCH_GATE_REPORT_PATH || "artifacts/gates/self-serve-launch-gate.json"
  );
  await mkdir(dirname(reportPath), { recursive: true });

  let evaluation = null;
  let trackerOk = false;
  try {
    evaluation = await loadSelfServeLaunchTrackerFromPath(trackerPath);
    trackerOk = evaluation.ok === true;
  } catch (err) {
    evaluation = {
      ok: false,
      error: err?.message ?? "unable to load self-serve launch tracker"
    };
    trackerOk = false;
  }

  const report = {
    schemaVersion: "SelfServeLaunchGateReport.v1",
    generatedAt: new Date().toISOString(),
    checks: [
      {
        id: "self_serve_kpi_thresholds",
        ok: trackerOk,
        trackerPath,
        summary: evaluation
      }
    ],
    verdict: {
      ok: trackerOk,
      requiredChecks: 1,
      passedChecks: trackerOk ? 1 : 0
    }
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote self-serve launch gate report: ${reportPath}\n`);
  if (!trackerOk) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
