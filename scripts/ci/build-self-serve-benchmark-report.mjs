#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function readJsonBestEffort(pathname) {
  try {
    return JSON.parse(await readFile(pathname, "utf8"));
  } catch (err) {
    return { _error: err?.message ?? "unable to read json" };
  }
}

function pickGateMetric(summary, key) {
  const rows = Array.isArray(summary?.metrics) ? summary.metrics : [];
  const found = rows.find((row) => row?.key === key);
  return found && Number.isFinite(Number(found.value)) ? Number(found.value) : null;
}

function pickTrackerMetric(tracker, key) {
  const row = tracker?.metrics?.[key];
  return row && Number.isFinite(Number(row.value)) ? Number(row.value) : null;
}

async function main() {
  const launchGatePath = resolve(
    process.cwd(),
    process.env.SELF_SERVE_LAUNCH_GATE_REPORT_PATH || "artifacts/gates/self-serve-launch-gate.json"
  );
  const throughputPath = resolve(
    process.cwd(),
    process.env.THROUGHPUT_REPORT_PATH || "artifacts/throughput/10x-drill-summary.json"
  );
  const incidentPath = resolve(
    process.cwd(),
    process.env.THROUGHPUT_INCIDENT_REHEARSAL_REPORT_PATH || "artifacts/throughput/10x-incident-rehearsal-summary.json"
  );
  const outPath = resolve(
    process.cwd(),
    process.env.SELF_SERVE_BENCHMARK_REPORT_PATH || "artifacts/launch/self-serve-benchmark-report.json"
  );
  await mkdir(dirname(outPath), { recursive: true });

  const launchGate = await readJsonBestEffort(launchGatePath);
  const throughput = await readJsonBestEffort(throughputPath);
  const incident = await readJsonBestEffort(incidentPath);

  const launchSummary = launchGate?.checks?.[0]?.summary ?? null;
  const launchGateOk = launchGate?.verdict?.ok === true;
  const throughputOk = throughput?.verdict?.ok === true;
  const incidentOk = incident?.verdict?.ok === true;
  const trackerPath =
    typeof launchGate?.checks?.[0]?.trackerPath === "string" && launchGate.checks[0].trackerPath.trim() !== ""
      ? launchGate.checks[0].trackerPath
      : null;
  const tracker = trackerPath ? await readJsonBestEffort(trackerPath) : null;

  const referralLinkShares = pickGateMetric(launchSummary, "referralLinkShares") ?? pickTrackerMetric(tracker, "referralLinkShares");
  const referralSignups = pickGateMetric(launchSummary, "referralSignups") ?? pickTrackerMetric(tracker, "referralSignups");
  const referralConversionRatePct =
    pickGateMetric(launchSummary, "referralConversionRatePct") ?? pickTrackerMetric(tracker, "referralConversionRatePct");

  const report = {
    schemaVersion: "SelfServeBenchmarkReport.v1",
    generatedAt: new Date().toISOString(),
    sources: {
      launchGatePath,
      throughputPath,
      incidentPath
    },
    benchmark: {
      launchKpis: {
        gateOk: launchGateOk,
        mvsvUsd: pickGateMetric(launchSummary, "mvsvUsd"),
        signups: pickGateMetric(launchSummary, "signups"),
        teamsFirstLiveSettlement: pickGateMetric(launchSummary, "teamsFirstLiveSettlement"),
        payingCustomers: pickGateMetric(launchSummary, "payingCustomers"),
        medianTimeToFirstSettlementMinutes: pickGateMetric(launchSummary, "medianTimeToFirstSettlementMinutes"),
        arbitrationMedianResolutionHours: pickGateMetric(launchSummary, "arbitrationMedianResolutionHours")
      },
      throughput10x: {
        ok: throughputOk,
        httpReqDurationP95Ms: Number.isFinite(Number(throughput?.metrics?.httpReqDurationP95Ms))
          ? Number(throughput.metrics.httpReqDurationP95Ms)
          : null,
        httpReqFailedRate: Number.isFinite(Number(throughput?.metrics?.httpReqFailedRate))
          ? Number(throughput.metrics.httpReqFailedRate)
          : null,
        ingestRejectedPerMin: Number.isFinite(Number(throughput?.metrics?.ingestRejectedPerMin))
          ? Number(throughput.metrics.ingestRejectedPerMin)
          : null
      },
      incidentRehearsal: {
        ok: incidentOk,
        durationMs: Number.isFinite(Number(incident?.durationMs)) ? Number(incident.durationMs) : null,
        failedChecks: Array.isArray(incident?.checks) ? incident.checks.filter((row) => row?.ok !== true).map((row) => row?.id).filter(Boolean) : []
      },
      referral: {
        linkShares: referralLinkShares,
        signups: referralSignups,
        conversionRatePct: referralConversionRatePct
      }
    }
  };

  report.verdict = {
    ok: Boolean(launchGateOk && throughputOk && incidentOk),
    checks: {
      launchGateOk,
      throughputOk,
      incidentOk
    }
  };

  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote self-serve benchmark report: ${outPath}\n`);
  if (!report.verdict.ok) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
