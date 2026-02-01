import { useEffect, useMemo, useState } from "react";

import DemoPicker from "./DemoPicker.jsx";
import InspectDrawer from "./InspectDrawer.jsx";
import useCommandCenterData from "../hooks/useCommandCenterData.js";
import VerdictCard from "./VerdictCard.jsx";

function money(n) {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pillClass(ok) {
  return ok ? "bg-settld-success/10 text-settld-success border-settld-success/20" : "bg-settld-warning/10 text-settld-warning border-settld-warning/20";
}

export default function CommandCenter({ scenarioId, setScenarioId, scenarios, onExit }) {
  const [paused, setPaused] = useState(false);
  const [playbackMs, setPlaybackMs] = useState(800);
  const { loading, error, jobs, logs, totals } = useCommandCenterData({ scenarioId, paused, playbackMs });
  const [selectedJob, setSelectedJob] = useState(null);
  const [selectedLog, setSelectedLog] = useState(null);
  const [spotlightJobId, setSpotlightJobId] = useState(null);
  const [spotlightArmed, setSpotlightArmed] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onExit?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  const headerTitle = useMemo(() => {
    if (scenarioId === "finance") return "SETTLD_NET // FINANCE_PACK";
    return "SETTLD_NET // LIVE_SHADOW";
  }, [scenarioId]);

  // Arm spotlight after initial load to guarantee the “killer moment”.
  useEffect(() => {
    setSpotlightJobId(null);
    setSpotlightArmed(false);
    if (scenarioId !== "delivery") return;
    const t = setTimeout(() => setSpotlightArmed(true), 5000);
    return () => clearTimeout(t);
  }, [scenarioId]);

  useEffect(() => {
    if (scenarioId !== "delivery") return;
    if (!spotlightArmed) return;
    if (spotlightJobId) return;
    const candidate =
      jobs.find((j) => (j?.timeline?.job?.slaBreaches?.length ?? 0) > 0) ??
      jobs.find((j) => (j?.timeline?.job?.slaCredits?.length ?? 0) > 0) ??
      jobs[0] ??
      null;
    if (!candidate) return;
    setSpotlightJobId(candidate.id);
  }, [scenarioId, spotlightArmed, spotlightJobId, jobs]);

  // Freeze/slow playback when SLA breach appears, and open the verdict card.
  useEffect(() => {
    if (scenarioId !== "delivery") return;
    if (spotlightJobId) return;
    const top = logs[0];
    if (!top) return;
    const isBreach = String(top.type ?? "").includes("SLA_BREACH");
    if (!isBreach) return;
    const j = jobs.find((x) => x.timeline?.job?.id === top.raw?.streamId || x.id === top.raw?.streamId) ?? jobs[0] ?? null;
    if (!j) return;
    setSpotlightJobId(j.id);
  }, [scenarioId, logs, jobs, spotlightJobId]);

  useEffect(() => {
    if (!spotlightJobId) return;
    setPaused(true);
    const t1 = setTimeout(() => {
      setPaused(false);
      setPlaybackMs(2400);
    }, 1400);
    return () => clearTimeout(t1);
  }, [spotlightJobId]);

  const spotlightJob = useMemo(() => jobs.find((j) => j.id === spotlightJobId) ?? null, [jobs, spotlightJobId]);

  return (
    <div className="h-screen w-screen overflow-hidden text-xs select-none bg-[color:var(--background)] text-slate-50">
      {/* Top bar */}
      <header className="h-10 border-b border-slate-800 bg-[color:var(--background)] flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-6">
          <span className="font-bold text-emerald-500 tracking-wider">{headerTitle}</span>
          <div className="text-slate-500">
            FLEET_JOBS: <span className="text-slate-200">{jobs.length}</span>
          </div>
          <div className="text-slate-500">
            PENDING_DISPUTES: <span className="text-slate-200">{totals.disputes}</span>
          </div>
          <div className="text-slate-500">
            AGG_NET: <span className="text-slate-200">{money(totals.net)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onExit}
            className="px-2 py-1 border border-slate-700 rounded hover:bg-slate-800 transition text-[10px] text-slate-300"
          >
            EXIT (ESC)
          </button>
        </div>
      </header>

      <main className="grid grid-cols-12 h-[calc(100vh-40px)] overflow-hidden">
        {/* Left panel: stream */}
        <div className="col-span-5 border-r border-slate-800 bg-[#02040a] flex flex-col min-h-0">
          <div className="h-9 p-2 border-b border-slate-800 flex justify-between items-center text-slate-400 bg-slate-900/50 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-slate-300">INCOMING_FACT_STREAM</span>
            </div>
            <span className="text-[10px] bg-emerald-500/10 text-emerald-500 px-1 rounded">LIVE</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 font-mono space-y-1 min-h-0">
            {logs.map((log) => (
              <div
                key={log.id}
                onClick={() => setSelectedLog(log)}
                className={`flex gap-3 text-slate-500 hover:bg-slate-900 cursor-pointer p-1 rounded transition-colors group ${
                  String(log.type ?? "").includes("SLA_BREACH") ? "bg-red-950/20 border border-red-900/40" : ""
                }`}
              >
                <span className="text-slate-600 w-14">{log.time}</span>
                <span className={`${log.severity === "error" ? "text-red-500" : log.severity === "warn" ? "text-amber-500" : "text-emerald-500"} w-24`}>
                  {log.type}
                </span>
                <span className="text-slate-300 group-hover:text-white truncate flex-1">{log.payload || log.robotId}</span>
                <span className="text-slate-700 w-14 text-right opacity-50">{log.hash}</span>
              </div>
            ))}
            {loading && <div className="text-slate-600 p-2">loading…</div>}
            {error && <div className="text-red-400 p-2">{String(error?.message ?? error)}</div>}
          </div>
        </div>

        {/* Right panel: ledger */}
        <div className="col-span-7 bg-slate-950 flex flex-col overflow-hidden min-h-0">
          <div className="h-9 p-2 border-b border-slate-800 flex justify-between items-center text-slate-400 bg-slate-900/50 shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-slate-300">{scenarioId === "finance" ? "AUTONOMOUS_CLOSE_LEDGER" : "AUTONOMOUS_SETTLEMENT_LEDGER"}</span>
              <span className="text-[10px] text-slate-500">
                VALUE {money(totals.value)} · CREDIT {money(totals.credit)} · NET {money(totals.net)}
              </span>
            </div>
            <div className="flex gap-2 text-[10px]">
              <span className="px-2 py-0.5 border border-slate-700 rounded text-slate-300">PLAYBACK</span>
              <span className="px-2 py-0.5 bg-emerald-900/30 text-emerald-400 border border-emerald-900/50 rounded">AUTO_CLOSE: ON</span>
            </div>
          </div>

          {scenarioId === "delivery" && spotlightJob ? (
            <VerdictCard
              job={spotlightJob}
              onPrimaryAction={() => {
                setScenarioId("finance");
              }}
            />
          ) : null}

          <div className="p-3 border-b border-slate-800 bg-slate-950/50 shrink-0">
            <DemoPicker scenarioId={scenarioId} setScenarioId={setScenarioId} scenarios={scenarios} />
          </div>

          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse font-mono">
              <thead className="bg-slate-900/50 text-slate-500 sticky top-0 z-10">
                <tr>
                  <th className="p-3 font-normal border-b border-slate-800">ID</th>
                  <th className="p-3 font-normal border-b border-slate-800">CUSTOMER</th>
                  <th className="p-3 font-normal border-b border-slate-800">VERIFICATION</th>
                  <th className="p-3 font-normal border-b border-slate-800 text-right">VALUE</th>
                  <th className="p-3 font-normal border-b border-slate-800 text-right">CREDIT</th>
                  <th className="p-3 font-normal border-b border-slate-800 text-right">NET</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    onClick={() => setSelectedJob(job)}
                    className="hover:bg-slate-900/60 transition-colors cursor-pointer group"
                  >
                    <td className="p-3 text-slate-300 font-medium group-hover:text-white">{job.id}</td>
                    <td className="p-3 text-slate-400">{job.customer}</td>
                    <td className="p-3">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] ${pillClass(job.verified)}`}>
                        {job.verified ? "VERIFIED" : "ATTN"}
                      </span>
                    </td>
                    <td className="p-3 text-right text-slate-400">{money(job.valueUsd)}</td>
                    <td className={`p-3 text-right ${job.creditUsd < 0 ? "text-red-400" : "text-slate-600"}`}>{job.creditUsd ? money(job.creditUsd) : "-"}</td>
                    <td className="p-3 text-right text-white font-medium">{money(job.netUsd)}</td>
                  </tr>
                ))}
                {!jobs.length && !loading && (
                  <tr>
                    <td className="p-6 text-slate-500" colSpan={6}>
                      No fixtures found. Run <span className="text-slate-200">npm run demo:delivery</span> and{" "}
                      <span className="text-slate-200">npm run pilot:finance-pack</span>, then{" "}
                      <span className="text-slate-200">npm run demo:ui:prep</span>.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <InspectDrawer
        open={!!selectedJob}
        title={selectedJob ? `JOB_INSPECT // ${selectedJob.id}` : ""}
        subtitle={selectedJob ? `policy ${String(selectedJob.policyHash ?? "").slice(0, 16)}… · run ${selectedJob.runId}` : ""}
        data={selectedJob}
        onClose={() => setSelectedJob(null)}
      >
        <div className="text-sm text-slate-200">
          <div className="text-slate-400">Summary</div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div className="p-3 rounded border border-slate-800 bg-black/20">
              <div className="text-slate-500 text-xs">VALUE</div>
              <div className="text-slate-100 font-mono text-sm">{money(selectedJob?.valueUsd)}</div>
            </div>
            <div className="p-3 rounded border border-slate-800 bg-black/20">
              <div className="text-slate-500 text-xs">NET</div>
              <div className="text-slate-100 font-mono text-sm">{money(selectedJob?.netUsd)}</div>
            </div>
          </div>
          <div className="mt-3 text-slate-400 text-xs">
            This is a playback view over captured demo runs. Each job has a hash-chained event log and deterministic settlement artifacts.
          </div>
        </div>
      </InspectDrawer>

      <InspectDrawer
        open={!!selectedLog}
        title={selectedLog ? `FACT // ${selectedLog.type}` : ""}
        subtitle={selectedLog ? `${selectedLog.time} · ${selectedLog.robotId} · ${selectedLog.hash}` : ""}
        data={selectedLog?.raw ?? selectedLog}
        onClose={() => setSelectedLog(null)}
      >
        <div className="text-sm text-slate-200">
          <div className="text-slate-400">Interpretation</div>
          <div className="mt-2 text-slate-200">
            This is a signed fact in the append-only stream. It anchors downstream artifacts and finance exports.
          </div>
        </div>
      </InspectDrawer>
    </div>
  );
}
