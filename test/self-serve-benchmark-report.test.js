import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

async function runNodeScript(scriptPath, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("self-serve benchmark report builder: composes launch + throughput + incident artifacts", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-benchmark-report-"));
  const gatePath = path.join(tmpRoot, "self-serve-gate.json");
  const throughputPath = path.join(tmpRoot, "throughput.json");
  const incidentPath = path.join(tmpRoot, "incident.json");
  const outPath = path.join(tmpRoot, "out", "benchmark.json");

  await fs.writeFile(
    gatePath,
    JSON.stringify(
      {
        schemaVersion: "SelfServeLaunchGateReport.v1",
        verdict: { ok: true },
        checks: [
          {
            id: "self_serve_kpi_thresholds",
            ok: true,
            summary: {
              metrics: [
                { key: "mvsvUsd", value: 200000 },
                { key: "signups", value: 30 },
                { key: "teamsFirstLiveSettlement", value: 12 },
                { key: "payingCustomers", value: 6 },
                { key: "medianTimeToFirstSettlementMinutes", value: 12.5 },
                { key: "arbitrationMedianResolutionHours", value: 8.2 },
                { key: "referralLinkShares", value: 41 },
                { key: "referralSignups", value: 11 },
                { key: "referralConversionRatePct", value: 26.8 }
              ]
            }
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await fs.writeFile(
    throughputPath,
    JSON.stringify(
      {
        schemaVersion: "ThroughputDrill10xReport.v1",
        verdict: { ok: true },
        metrics: {
          httpReqDurationP95Ms: 930.5,
          httpReqFailedRate: 0,
          ingestRejectedPerMin: 4.1
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await fs.writeFile(
    incidentPath,
    JSON.stringify(
      {
        schemaVersion: "ThroughputIncidentRehearsalReport.v1",
        verdict: { ok: true },
        durationMs: 250,
        checks: [{ id: "rollback_restores_stable_policy", ok: true }]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const run = await runNodeScript("scripts/ci/build-self-serve-benchmark-report.mjs", {
    ...process.env,
    SELF_SERVE_LAUNCH_GATE_REPORT_PATH: gatePath,
    THROUGHPUT_REPORT_PATH: throughputPath,
    THROUGHPUT_INCIDENT_REHEARSAL_REPORT_PATH: incidentPath,
    SELF_SERVE_BENCHMARK_REPORT_PATH: outPath
  });
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);

  const report = JSON.parse(await fs.readFile(outPath, "utf8"));
  assert.equal(report.schemaVersion, "SelfServeBenchmarkReport.v1");
  assert.equal(report.verdict?.ok, true);
  assert.equal(report.benchmark?.launchKpis?.mvsvUsd, 200000);
  assert.equal(report.benchmark?.throughput10x?.ok, true);
  assert.equal(report.benchmark?.incidentRehearsal?.ok, true);
  assert.equal(report.benchmark?.referral?.linkShares, 41);
  assert.equal(report.benchmark?.referral?.signups, 11);
});
