#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

export const X402_PILOT_RELIABILITY_REPORT_SCHEMA_VERSION = "X402PilotReliabilityReport.v1";

function usage() {
  return [
    "usage: node scripts/ops/build-x402-pilot-reliability-report.mjs [options]",
    "",
    "Options:",
    "  --artifact-root <dir>               Source artifact root (default: artifacts/mcp-paid-exa)",
    "  --days <n>                          Rolling window in days (default: 7)",
    "  --now <iso>                         Override current time for deterministic runs",
    "  --out <file>                        Output report path (default: artifacts/ops/x402-pilot-reliability-report.json)",
    "  --max-reserve-fail-rate <0..1>      Fail if reserve fail rate is above threshold",
    "  --max-token-verify-fail-rate <0..1> Fail if token verification fail rate is above threshold",
    "  --max-provider-sig-fail-rate <0..1> Fail if provider signature fail rate is above threshold",
    "  --min-settlement-success-rate <0..1> Fail if settlement success rate is below threshold",
    "  --help                              Show this help"
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    artifactRoot: "artifacts/mcp-paid-exa",
    days: 7,
    nowIso: null,
    outPath: "artifacts/ops/x402-pilot-reliability-report.json",
    maxReserveFailRate: null,
    maxTokenVerifyFailRate: null,
    maxProviderSigFailRate: null,
    minSettlementSuccessRate: null,
    help: false
  };

  const parseRate = (name, raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} must be in [0,1]`);
    return n;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "").trim();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--artifact-root") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--artifact-root requires a value");
      out.artifactRoot = value;
      i += 1;
      continue;
    }
    if (arg === "--days") {
      const value = Number(argv[i + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--days must be a positive integer");
      out.days = value;
      i += 1;
      continue;
    }
    if (arg === "--now") {
      const value = String(argv[i + 1] ?? "").trim();
      const nowMs = Date.parse(value);
      if (!Number.isFinite(nowMs)) throw new Error("--now must be an ISO date/time");
      out.nowIso = new Date(nowMs).toISOString();
      i += 1;
      continue;
    }
    if (arg === "--out") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--out requires a value");
      out.outPath = value;
      i += 1;
      continue;
    }
    if (arg === "--max-reserve-fail-rate") {
      out.maxReserveFailRate = parseRate("--max-reserve-fail-rate", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--max-token-verify-fail-rate") {
      out.maxTokenVerifyFailRate = parseRate("--max-token-verify-fail-rate", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--max-provider-sig-fail-rate") {
      out.maxProviderSigFailRate = parseRate("--max-provider-sig-fail-rate", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--min-settlement-success-rate") {
      out.minSettlementSuccessRate = parseRate("--min-settlement-success-rate", argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return out;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeIso(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function rate(numerator, denominator) {
  if (!Number.isFinite(Number(denominator)) || Number(denominator) <= 0) return null;
  return Number(numerator) / Number(denominator);
}

function isGatewayError(summary, mcpParsed) {
  const err = String(summary?.error ?? "");
  if (String(mcpParsed?.error ?? "").trim() === "gateway_error") return true;
  if (err.includes('"error": "gateway_error"')) return true;
  if (err.includes("gateway_error")) return true;
  return false;
}

function isInfraBootFailure(summary) {
  const err = String(summary?.error ?? "");
  return err.includes("/healthz exited before becoming ready");
}

function settlementFromSummary(summary, runDirPath) {
  const summaryBatch = summary?.batchSettlement;
  if (summaryBatch && typeof summaryBatch === "object" && !Array.isArray(summaryBatch)) {
    const enabled = summaryBatch.enabled === true;
    if (!enabled) return { eligible: false, ok: null };
    const ok = summaryBatch.ok === true;
    const payoutExecution =
      summaryBatch?.result?.payoutExecution && typeof summaryBatch.result.payoutExecution === "object"
        ? summaryBatch.result.payoutExecution
        : null;
    if (payoutExecution && payoutExecution.enabled === true) {
      const failed = Number(payoutExecution.failed ?? 0);
      return { eligible: true, ok: ok && failed === 0 };
    }
    return { eligible: true, ok };
  }

  const fromFile = safeReadJson(path.join(runDirPath, "batch-settlement.json"));
  if (!fromFile || typeof fromFile !== "object") return { eligible: false, ok: null };
  const eligible = true;
  const payoutExecution =
    fromFile?.result?.payoutExecution && typeof fromFile.result.payoutExecution === "object" ? fromFile.result.payoutExecution : null;
  if (payoutExecution && payoutExecution.enabled === true) {
    const failed = Number(payoutExecution.failed ?? 0);
    return { eligible, ok: fromFile.ok === true && failed === 0 };
  }
  return { eligible, ok: fromFile.ok === true };
}

function replayFromSummary(summary, runDirPath) {
  const fromSummary =
    summary?.replayCounters && typeof summary.replayCounters === "object" && !Array.isArray(summary.replayCounters)
      ? summary.replayCounters
      : null;
  const fromFileRaw = safeReadJson(path.join(runDirPath, "provider-replay-probe.json"));
  const fromFile =
    fromFileRaw?.replayCounters && typeof fromFileRaw.replayCounters === "object" && !Array.isArray(fromFileRaw.replayCounters)
      ? fromFileRaw.replayCounters
      : null;
  const row = fromSummary ?? fromFile;
  if (!row) return { eligible: false, duplicateResponses: 0, totalRequests: 0 };
  const totalRequests = Number(row.totalRequests ?? row.denominator ?? 0);
  const duplicateResponses = Number(row.duplicateResponses ?? row.numerator ?? 0);
  if (!Number.isSafeInteger(totalRequests) || totalRequests <= 0) {
    return { eligible: false, duplicateResponses: 0, totalRequests: 0 };
  }
  if (!Number.isSafeInteger(duplicateResponses) || duplicateResponses < 0) {
    return { eligible: false, duplicateResponses: 0, totalRequests: 0 };
  }
  return {
    eligible: true,
    duplicateResponses: Math.min(duplicateResponses, totalRequests),
    totalRequests
  };
}

function classifyRun({ runDirPath, summary }) {
  const mcpParsed = safeReadJson(path.join(runDirPath, "mcp-call.parsed.json"));
  const tokenVerify = safeReadJson(path.join(runDirPath, "settld-pay-token-verification.json"));
  const providerSigVerify = safeReadJson(path.join(runDirPath, "provider-signature-verification.json"));
  const startedAt = safeIso(summary?.timestamps?.startedAt) ?? safeIso(summary?.startedAt) ?? null;
  const completedAt = safeIso(summary?.timestamps?.completedAt) ?? safeIso(summary?.completedAt) ?? null;
  const infraBootFailure = isInfraBootFailure(summary);
  const gatewayError = isGatewayError(summary, mcpParsed);
  const hasMcpAttemptSignal =
    summary?.ok === true || Boolean(mcpParsed) || String(summary?.error ?? "").includes("mcp tool call returned error");
  const toolCallAttempted = hasMcpAttemptSignal && !infraBootFailure;
  const reserveFailureLikely = toolCallAttempted && gatewayError;

  let tokenVerified = null;
  if (typeof summary?.passChecks?.tokenVerified === "boolean") tokenVerified = summary.passChecks.tokenVerified;
  else if (typeof tokenVerify?.ok === "boolean") tokenVerified = tokenVerify.ok;

  let providerSignatureVerified = null;
  if (typeof summary?.passChecks?.providerSignature === "boolean") providerSignatureVerified = summary.passChecks.providerSignature;
  else if (typeof providerSigVerify?.ok === "boolean") providerSignatureVerified = providerSigVerify.ok;

  const settlement = settlementFromSummary(summary, runDirPath);
  const replay = replayFromSummary(summary, runDirPath);

  return {
    runId: String(summary?.runId ?? path.basename(runDirPath)),
    runDirPath,
    startedAt,
    completedAt,
    ok: summary?.ok === true,
    infraBootFailure,
    toolCallAttempted,
    reserveFailureLikely,
    tokenVerified,
    providerSignatureVerified,
    settlement,
    replay
  };
}

export function buildX402PilotReliabilityReport({
  artifactRoot = "artifacts/mcp-paid-exa",
  days = 7,
  nowIso = null
} = {}) {
  const now = safeIso(nowIso) ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const daysInt = Number(days);
  if (!Number.isSafeInteger(daysInt) || daysInt <= 0) throw new Error("days must be a positive integer");
  const startMs = nowMs - daysInt * 24 * 60 * 60 * 1000;
  const startAt = new Date(startMs).toISOString();
  const artifactRootResolved = path.resolve(process.cwd(), artifactRoot);
  const runRows = [];

  if (fs.existsSync(artifactRootResolved)) {
    const entries = fs
      .readdirSync(artifactRootResolved, { withFileTypes: true })
      .filter((row) => row.isDirectory())
      .map((row) => row.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      const runDirPath = path.join(artifactRootResolved, name);
      const summaryPath = path.join(runDirPath, "summary.json");
      if (!fs.existsSync(summaryPath)) continue;
      const summary = safeReadJson(summaryPath);
      if (!summary || typeof summary !== "object") continue;
      const startedAt = safeIso(summary?.timestamps?.startedAt) ?? safeIso(summary?.startedAt);
      if (!startedAt) continue;
      const startedMs = Date.parse(startedAt);
      if (startedMs < startMs || startedMs > nowMs) continue;
      runRows.push(classifyRun({ runDirPath, summary }));
    }
  }

  runRows.sort((a, b) => Date.parse(String(a.startedAt ?? 0)) - Date.parse(String(b.startedAt ?? 0)));

  const infraBootFailures = runRows.filter((row) => row.infraBootFailure === true);
  const attempted = runRows.filter((row) => row.toolCallAttempted === true);
  const successful = attempted.filter((row) => row.ok === true);
  const reserveFailureLikely = attempted.filter((row) => row.reserveFailureLikely === true);

  const tokenEligible = attempted.filter((row) => typeof row.tokenVerified === "boolean");
  const tokenFailures = tokenEligible.filter((row) => row.tokenVerified === false);

  const providerSigEligible = attempted.filter((row) => typeof row.providerSignatureVerified === "boolean");
  const providerSigFailures = providerSigEligible.filter((row) => row.providerSignatureVerified === false);

  const settlementEligible = attempted.filter((row) => row.settlement.eligible === true && typeof row.settlement.ok === "boolean");
  const settlementSuccess = settlementEligible.filter((row) => row.settlement.ok === true);
  const settlementFailures = settlementEligible.filter((row) => row.settlement.ok !== true);
  const replayEligible = attempted.filter((row) => row.replay?.eligible === true);
  const replayTotals = replayEligible.reduce(
    (acc, row) => {
      acc.duplicateResponses += Number(row.replay?.duplicateResponses ?? 0);
      acc.totalRequests += Number(row.replay?.totalRequests ?? 0);
      return acc;
    },
    { duplicateResponses: 0, totalRequests: 0 }
  );
  const replayMissingDuplicate = replayEligible.filter(
    (row) => Number(row.replay?.duplicateResponses ?? 0) < Number(row.replay?.totalRequests ?? 0)
  );

  const firstAttempt = attempted[0] ?? null;
  const firstSuccess = successful[0] ?? null;
  const timeToFirstPaidCallMs =
    firstAttempt && firstSuccess && firstAttempt.startedAt && firstSuccess.completedAt
      ? Math.max(0, Date.parse(firstSuccess.completedAt) - Date.parse(firstAttempt.startedAt))
      : null;

  const report = {
    schemaVersion: X402_PILOT_RELIABILITY_REPORT_SCHEMA_VERSION,
    generatedAt: now,
    window: {
      days: daysInt,
      startAt,
      endAt: now
    },
    source: {
      artifactRoot: artifactRootResolved
    },
    runCounts: {
      runsInWindow: runRows.length,
      infraBootFailures: infraBootFailures.length,
      toolCallAttempts: attempted.length,
      successfulPaidCalls: successful.length
    },
    metrics: {
      timeToFirstPaidCallMs,
      reserveFailRate: {
        value: rate(reserveFailureLikely.length, attempted.length),
        numerator: reserveFailureLikely.length,
        denominator: attempted.length
      },
      tokenVerifyFailRate: {
        value: rate(tokenFailures.length, tokenEligible.length),
        numerator: tokenFailures.length,
        denominator: tokenEligible.length
      },
      providerSigFailRate: {
        value: rate(providerSigFailures.length, providerSigEligible.length),
        numerator: providerSigFailures.length,
        denominator: providerSigEligible.length
      },
      settlementSuccessRate: {
        value: rate(settlementSuccess.length, settlementEligible.length),
        numerator: settlementSuccess.length,
        denominator: settlementEligible.length
      },
      replayDuplicateRate: {
        value: rate(replayTotals.duplicateResponses, replayTotals.totalRequests),
        numerator: replayTotals.duplicateResponses,
        denominator: replayTotals.totalRequests
      }
    },
    samples: {
      reserveFailureLikelyRunIds: reserveFailureLikely.map((row) => row.runId),
      tokenVerifyFailureRunIds: tokenFailures.map((row) => row.runId),
      providerSigFailureRunIds: providerSigFailures.map((row) => row.runId),
      settlementFailureRunIds: settlementFailures.map((row) => row.runId),
      replayMissingDuplicateRunIds: replayMissingDuplicate.map((row) => row.runId)
    },
    notes: [
      "reserveFailRate is inferred from attempted runs with gateway_error.",
      "infra boot failures are excluded from economic reliability denominators.",
      "token/provider signature failure rates only include runs with explicit verification artifacts/checks.",
      "replayDuplicateRate is computed from provider replay counters emitted by paid demo artifacts."
    ]
  };

  return report;
}

function buildThresholdVerdict(report, thresholds) {
  const checks = [];
  const pushCheck = ({ id, ok, actual = null, expected = null, comparator = null }) => {
    checks.push({ id, ok: ok === true, actual, expected, comparator });
  };

  if (Number.isFinite(thresholds.maxReserveFailRate)) {
    const actual = report?.metrics?.reserveFailRate?.value;
    pushCheck({
      id: "maxReserveFailRate",
      ok: actual !== null && actual <= thresholds.maxReserveFailRate,
      actual,
      expected: thresholds.maxReserveFailRate,
      comparator: "<="
    });
  }
  if (Number.isFinite(thresholds.maxTokenVerifyFailRate)) {
    const actual = report?.metrics?.tokenVerifyFailRate?.value;
    pushCheck({
      id: "maxTokenVerifyFailRate",
      ok: actual !== null && actual <= thresholds.maxTokenVerifyFailRate,
      actual,
      expected: thresholds.maxTokenVerifyFailRate,
      comparator: "<="
    });
  }
  if (Number.isFinite(thresholds.maxProviderSigFailRate)) {
    const actual = report?.metrics?.providerSigFailRate?.value;
    pushCheck({
      id: "maxProviderSigFailRate",
      ok: actual !== null && actual <= thresholds.maxProviderSigFailRate,
      actual,
      expected: thresholds.maxProviderSigFailRate,
      comparator: "<="
    });
  }
  if (Number.isFinite(thresholds.minSettlementSuccessRate)) {
    const actual = report?.metrics?.settlementSuccessRate?.value;
    pushCheck({
      id: "minSettlementSuccessRate",
      ok: actual !== null && actual >= thresholds.minSettlementSuccessRate,
      actual,
      expected: thresholds.minSettlementSuccessRate,
      comparator: ">="
    });
  }

  return {
    ok: checks.every((row) => row.ok === true),
    checks
  };
}

function formatRate(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function writeReport(filePath, value) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return resolved;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const report = buildX402PilotReliabilityReport({
    artifactRoot: args.artifactRoot,
    days: args.days,
    nowIso: args.nowIso
  });
  const verdict = buildThresholdVerdict(report, {
    maxReserveFailRate: args.maxReserveFailRate,
    maxTokenVerifyFailRate: args.maxTokenVerifyFailRate,
    maxProviderSigFailRate: args.maxProviderSigFailRate,
    minSettlementSuccessRate: args.minSettlementSuccessRate
  });
  report.verdict = verdict;

  const outPath = writeReport(args.outPath, report);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: verdict.ok,
        outPath,
        runCounts: report.runCounts,
        metrics: {
          reserveFailRate: formatRate(report.metrics.reserveFailRate.value),
          tokenVerifyFailRate: formatRate(report.metrics.tokenVerifyFailRate.value),
          providerSigFailRate: formatRate(report.metrics.providerSigFailRate.value),
          settlementSuccessRate: formatRate(report.metrics.settlementSuccessRate.value),
          timeToFirstPaidCallMs: report.metrics.timeToFirstPaidCallMs
        }
      },
      null,
      2
    )}\n`
  );

  if (!verdict.ok) process.exitCode = 1;
}

const isDirectExecution = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    process.exit(1);
  });
}
