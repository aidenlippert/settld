import { useCallback, useEffect, useMemo, useState } from "react";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function msBetween(a, b) {
  const t1 = Date.parse(a ?? "");
  const t2 = Date.parse(b ?? "");
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return t2 - t1;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  return await res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  return await res.text();
}

function deriveFromSettldJson({ run, timeline, workCert, creditMemo, settlementStatement }) {
  const jobId = run?.jobId ?? workCert?.jobId ?? timeline?.job?.id ?? "job_unknown";
  const robotId =
    timeline?.job?.execution?.robotId ??
    timeline?.job?.reservation?.robotId ??
    timeline?.job?.match?.robotId ??
    timeline?.events?.find?.((e) => e?.actor?.type === "robot")?.actor?.id ??
    "robot";

  const bookingStartAt = timeline?.job?.booking?.startAt ?? null;
  const bookingEndAt = timeline?.job?.booking?.endAt ?? null;
  const execStartedAt = timeline?.job?.execution?.startedAt ?? null;
  const execCompletedAt = timeline?.job?.execution?.completedAt ?? null;

  const slaWindowMs = msBetween(bookingStartAt, bookingEndAt) ?? 15 * 60_000;
  const slaMinutes = Math.max(1, Math.round(slaWindowMs / 60_000));

  // Demo animation uses “elapsed since booking start”, not “execution duration”, so it matches the SLA story.
  const elapsedMs = msBetween(bookingStartAt, execCompletedAt) ?? 0;
  const actualDurationSec = Math.max(0, Math.floor(elapsedMs / 1000));

  const lateMs = msBetween(bookingEndAt, execCompletedAt);
  const breached = Number.isFinite(lateMs) ? lateMs > 0 : false;
  const breachAmount = breached ? formatDuration(lateMs) : "0s";

  const quoteAmountCents = settlementStatement?.settlement?.quoteAmountCents ?? 0;
  const creditsCents =
    settlementStatement?.settlement?.slaCreditsCents ??
    creditMemo?.credit?.amountCents ??
    creditMemo?.amountCents ??
    0;
  const netCents = Number.isSafeInteger(quoteAmountCents) && Number.isSafeInteger(creditsCents) ? quoteAmountCents - creditsCents : 0;

  const simStepSec = Math.max(1, Math.ceil(actualDurationSec / 80));

  return {
    telemetry: {
      jobId,
      robotId,
      task: "Deliver to room 412",
      slaMinutes,
      actualDurationSec,
      breachAmount,
      simStepSec
    },
    sla: {
      breached,
      breachAmount,
      policyHash: timeline?.job?.booking?.policyHash ?? run?.bookedPolicyHash ?? "policyHash_unknown",
      clause: "Delivery must complete within the booking window; if late, a deterministic credit is issued."
    },
    money: {
      grossCents: Number.isSafeInteger(quoteAmountCents) ? quoteAmountCents : 0,
      creditCents: Number.isSafeInteger(creditsCents) ? creditsCents : 0,
      netCents: Number.isSafeInteger(netCents) ? netCents : 0
    },
    outputs: { workCertificate: workCert ?? null, settlementStatement: settlementStatement ?? null, creditMemo: creditMemo ?? null },
    timeline: timeline ?? null
  };
}

function deriveFinance({ run, workCert, creditMemo, settlementStatement, glBatchJson, journalCsvText, reconcileJson, steps }) {
  const base = deriveFromSettldJson({ run, timeline: null, workCert, creditMemo, settlementStatement });
  const period = reconcileJson?.period ?? glBatchJson?.period ?? run?.month ?? "2026-01";
  return {
    ...base,
    finance: {
      period,
      glBatchJson: glBatchJson ?? null,
      journalCsvText: journalCsvText ?? null,
      reconcileJson: reconcileJson ?? null,
      steps: steps ?? null,
      jobProofBundleZipUrl: "/demo/finance/latest/JobProofBundle.v1.zip",
      monthProofBundleZipUrl: "/demo/finance/latest/MonthProofBundle.v1.zip",
      financePackZipUrl: "/demo/finance/latest/FinancePackBundle.v1.zip"
    }
  };
}

const FALLBACK = Object.freeze({
  telemetry: {
    jobId: "job_demo",
    robotId: "rob_demo",
    task: "Deliver to room 412",
    slaMinutes: 15,
    actualDurationSec: 18 * 60 + 32
  },
  sla: {
    breached: true,
    breachAmount: "3m 32s",
    policyHash: "policyHash_demo",
    clause: "Start within booking window; if late, credit is issued deterministically."
  },
  outputs: {
    workCertificate: { artifactType: "WorkCertificate.v1" },
    settlementStatement: { artifactType: "SettlementStatement.v1" },
    creditMemo: { artifactType: "CreditMemo.v1" }
  }
});

export default function useDemoData() {
  const [phase, setPhase] = useState("idle");
  const [sourceLabel, setSourceLabel] = useState("loading...");
  const [data, setData] = useState(FALLBACK);
  const [scenarioId, setScenarioId] = useState(() => {
    try {
      return localStorage.getItem("settld_demo_scenario") || "delivery";
    } catch {
      return "delivery";
    }
  });
  const [scenarios, setScenarios] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const idx = await fetchJson("/demo/index.json");
        if (cancelled) return;
        if (Array.isArray(idx?.scenarios)) setScenarios(idx.scenarios);
      } catch {
        // ignore
      }

      try {
        if (scenarioId === "delivery") {
          const [run, timeline, workCert, creditMemo, settlementStatement] = await Promise.all([
            fetchJson("/demo/delivery/latest/run.json").catch(() => fetchJson("/demo/latest/run.json")),
            fetchJson("/demo/delivery/latest/timeline.json").catch(() => fetchJson("/demo/latest/timeline.json")),
            fetchJson("/demo/delivery/latest/WorkCertificate.v1.json").catch(() => fetchJson("/demo/latest/WorkCertificate.v1.json")),
            fetchJson("/demo/delivery/latest/CreditMemo.v1.json").catch(() => fetchJson("/demo/latest/CreditMemo.v1.json")),
            fetchJson("/demo/delivery/latest/SettlementStatement.v1.json").catch(() => fetchJson("/demo/latest/SettlementStatement.v1.json"))
          ]);
          if (cancelled) return;
          const derived = deriveFromSettldJson({ run, timeline, workCert, creditMemo, settlementStatement });
          setData(derived);
          setSourceLabel("demo/delivery/latest (exported from npm run demo:delivery)");
          return;
        }

        if (scenarioId === "finance") {
          const [run, stepsDoc, workCert, creditMemo, settlementStatement, glBatchJson, journalCsvText, reconcileJson] = await Promise.all([
            fetchJson("/demo/finance/latest/run.json"),
            fetchJson("/demo/finance/latest/steps.json").catch(() => null),
            fetchJson("/demo/finance/latest/WorkCertificate.v1.json"),
            fetchJson("/demo/finance/latest/CreditMemo.v1.json").catch(() => null),
            fetchJson("/demo/finance/latest/SettlementStatement.v1.json"),
            fetchJson("/demo/finance/latest/GLBatch.v1.json"),
            fetchText("/demo/finance/latest/JournalCsv.v1.csv"),
            fetchJson("/demo/finance/latest/reconcile.json").catch(() => null)
          ]);
          if (cancelled) return;
          setData(
            deriveFinance({
              run,
              workCert,
              creditMemo,
              settlementStatement,
              glBatchJson,
              journalCsvText,
              reconcileJson,
              steps: Array.isArray(stepsDoc?.steps) ? stepsDoc.steps : null
            })
          );
          setSourceLabel("demo/finance/latest (exported from npm run pilot:finance-pack)");
          return;
        }
      } catch {
        // fall through
      }

      try {
        const [workCert, creditMemo, settlementStatement] = await Promise.all([
          fetchJson("/demo/sample/WorkCertificate.v1.json"),
          fetchJson("/demo/sample/CreditMemo.v1.json"),
          fetchJson("/demo/sample/SettlementStatement.v1.json")
        ]);
        if (cancelled) return;
        setData({
          ...FALLBACK,
          money: { grossCents: 12500, creditCents: 1250, netCents: 11250 },
          outputs: { workCertificate: workCert, settlementStatement, creditMemo }
        });
        setSourceLabel("demo/sample (checked-in)");
      } catch {
        if (cancelled) return;
        setSourceLabel("embedded fallback");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scenarioId]);

  useEffect(() => {
    try {
      localStorage.setItem("settld_demo_scenario", scenarioId);
    } catch {
      // ignore
    }
  }, [scenarioId]);

  const telemetry = useMemo(() => data.telemetry ?? FALLBACK.telemetry, [data]);
  const sla = useMemo(() => data.sla ?? FALLBACK.sla, [data]);
  const outputs = useMemo(() => data.outputs ?? FALLBACK.outputs, [data]);
  const money = useMemo(() => data.money ?? { grossCents: 12500, creditCents: 1250, netCents: 11250 }, [data]);
  const finance = useMemo(() => data.finance ?? null, [data]);
  const timeline = useMemo(() => data.timeline ?? null, [data]);

  const runDemo = useCallback(async () => {
    setPhase("before");
    await sleep(900);

    if (scenarioId === "finance") {
      setPhase("outputs");
      await sleep(500);
      setPhase("complete");
      return;
    }

    setPhase("telemetry");
    await sleep(5200);

    setPhase("breach");
    await sleep(1200);

    setPhase("sla");
    await sleep(900);

    setPhase("outputs");
    await sleep(400);
    setPhase("complete");
  }, [scenarioId]);

  return { phase, telemetry, sla, outputs, money, finance, timeline, runDemo, sourceLabel, scenarioId, setScenarioId, scenarios };
}
