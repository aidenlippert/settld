import { useEffect, useMemo, useRef, useState } from "react";

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  return await res.json();
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function centsToUsd(cents) {
  if (!Number.isFinite(cents)) return 0;
  return Math.round(cents) / 100;
}

function checkChain(events) {
  if (!Array.isArray(events) || events.length === 0) return { ok: false };
  for (let i = 1; i < events.length; i++) {
    if ((events[i]?.prevChainHash ?? null) !== (events[i - 1]?.chainHash ?? null)) return { ok: false };
  }
  return { ok: true };
}

function summarizeLogFromEvent(e) {
  const time = String(e?.at ?? "").slice(11, 19);
  const robotId = e?.actor?.type === "robot" ? e.actor.id : e?.payload?.robotId ?? "sys";
  const type = String(e?.type ?? "EVENT");
  const severity =
    type.includes("INCIDENT") || type.includes("FAILED") ? "error" : type.includes("SLA_BREACH") || type.includes("CREDIT") ? "warn" : "ok";
  const hash = String(e?.chainHash ?? "").slice(0, 8);
  const payload = (() => {
    if (!e?.payload) return "";
    if (type === "SLA_CREDIT_ISSUED") return "SLA credit issued";
    if (type === "SLA_BREACH_DETECTED") return "SLA breach detected";
    if (type === "EXECUTION_COMPLETED") return "Execution completed";
    if (type === "EXECUTION_STARTED") return "Execution started";
    if (type === "BOOKED") return "Job booked";
    return "";
  })();
  return { id: e?.id ?? `${time}_${hash}`, time, robotId, type, severity, hash, payload, raw: e };
}

function buildJobsFromDeliveryRuns(runs) {
  const jobs = [];
  for (const r of runs) {
    const timeline = r.timeline;
    const stmt = r.settlement;
    const creditMemo = r.creditMemo;
    const jobId = timeline?.job?.id ?? r.run?.jobId ?? r.runId;
    const customer = timeline?.job?.customerId ?? "cust";
    const policyHash = timeline?.job?.booking?.policyHash ?? timeline?.job?.customerPolicyHash ?? "policy";
    const quoteCents = safeNum(stmt?.settlement?.quoteAmountCents, 0);
    const creditCents = safeNum(stmt?.settlement?.slaCreditsCents, safeNum(creditMemo?.credit?.amountCents, 0));
    const netCents = quoteCents - creditCents;
    const chainOk = checkChain(timeline?.events ?? []).ok;
    jobs.push({
      id: jobId,
      kind: "delivery",
      runId: r.runId,
      customer,
      policyHash,
      status: timeline?.job?.status ?? "SETTLED",
      verified: chainOk,
      valueUsd: centsToUsd(quoteCents),
      creditUsd: centsToUsd(creditCents) * -1,
      netUsd: centsToUsd(netCents),
      timeline,
      artifacts: { settlement: stmt, creditMemo, workCertificate: r.workCertificate }
    });
  }
  return jobs;
}

export default function useCommandCenterData({ scenarioId, paused = false, playbackMs = 800 }) {
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState([]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);

  const streamRef = useRef({ idx: 0, merged: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (scenarioId === "delivery") {
          const history = await fetchJson("/demo/delivery/history/index.json");
          const copiedRuns = Array.isArray(history?.copiedRuns) ? history.copiedRuns : [];
          const runIds = copiedRuns.map((r) => r.runId).slice(-10);

          const runs = [];
          for (const runId of runIds) {
            const base = `/demo/delivery/history/${encodeURIComponent(runId)}`;
            const [run, timeline, workCertificate, settlement, creditMemo] = await Promise.all([
              fetchJson(`${base}/run.json`),
              fetchJson(`${base}/timeline.json`),
              fetchJson(`${base}/WorkCertificate.v1.json`).catch(() => null),
              fetchJson(`${base}/SettlementStatement.v1.json`).catch(() => null),
              fetchJson(`${base}/CreditMemo.v1.json`).catch(() => null)
            ]);
            runs.push({ runId, run, timeline, workCertificate, settlement, creditMemo });
          }

          if (cancelled) return;
          const builtJobs = buildJobsFromDeliveryRuns(runs);
          setJobs(builtJobs);

          // Merge events across jobs for playback streaming.
          const merged = [];
          for (const j of builtJobs) {
            for (const e of j.timeline?.events ?? []) merged.push(e);
          }
          merged.sort((a, b) => String(a?.at ?? "").localeCompare(String(b?.at ?? "")));
          streamRef.current = { idx: 0, merged };
          setLogs([]);
          setLoading(false);
          return;
        }

        if (scenarioId === "finance") {
          const history = await fetchJson("/demo/finance/history/index.json");
          const copiedRuns = Array.isArray(history?.copiedRuns) ? history.copiedRuns : [];
          const runIds = copiedRuns.map((r) => r.runId).slice(-10);

          const jobs = [];
          for (const runId of runIds) {
            const base = `/demo/finance/history/${encodeURIComponent(runId)}`;
            const [run, stepsDoc, glBatch] = await Promise.all([
              fetchJson(`${base}/run.json`).catch(() => null),
              fetchJson(`${base}/steps.json`).catch(() => null),
              fetchJson(`${base}/GLBatch.v1.json`).catch(() => null)
            ]);
            const period = run?.month ?? glBatch?.period ?? "2026-01";
            const valueUsd = centsToUsd(safeNum(glBatch?.totals?.grossCents ?? glBatch?.grossCents, 0));
            jobs.push({
              id: `period_${period}_${runId}`,
              kind: "finance",
              runId,
              customer: "tenant_default",
              policyHash: run?.bookedPolicyHash ?? "policy",
              status: "CLOSED",
              verified: true,
              valueUsd,
              creditUsd: 0,
              netUsd: valueUsd,
              steps: Array.isArray(stepsDoc?.steps) ? stepsDoc.steps : null,
              artifacts: { glBatch }
            });
          }
          if (cancelled) return;
          setJobs(jobs);

          const merged = [];
          for (const j of jobs) {
            for (const s of j.steps ?? []) {
              merged.push({
                id: `${j.runId}_${s.name}`,
                at: new Date().toISOString(),
                type: String(s.name ?? "STEP"),
                actor: { type: "system", id: "settld" },
                chainHash: String(s.code ?? "ok"),
                prevChainHash: null,
                payload: { statusCode: s.statusCode ?? null, code: s.code ?? null }
              });
            }
          }
          streamRef.current = { idx: 0, merged };
          setLogs([]);
          setLoading(false);
          return;
        }

        setJobs([]);
        setLogs([]);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scenarioId]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (paused) return;
      const { idx, merged } = streamRef.current;
      if (!Array.isArray(merged) || merged.length === 0) return;
      const next = merged[idx % merged.length];
      streamRef.current.idx = idx + 1;
      const log = summarizeLogFromEvent(next);
      setLogs((prev) => [log, ...prev].slice(0, 50));
    }, Math.max(200, Number(playbackMs) || 800));
    return () => clearInterval(interval);
  }, [paused, playbackMs]);

  const totals = useMemo(() => {
    const value = jobs.reduce((acc, j) => acc + safeNum(j.valueUsd, 0), 0);
    const credit = jobs.reduce((acc, j) => acc + safeNum(j.creditUsd, 0), 0);
    const net = jobs.reduce((acc, j) => acc + safeNum(j.netUsd, 0), 0);
    const disputes = jobs.filter((j) => j.status === "DISPUTE").length;
    return { value, credit, net, disputes };
  }, [jobs]);

  return { loading, error, jobs, logs, totals };
}
