import TelemetryCard from "./components/TelemetryCard.jsx";
import SLAVerification from "./components/SLAVerification.jsx";
import OutputCards from "./components/OutputCards.jsx";
import FinancePackCards from "./components/FinancePackCards.jsx";
import FinanceWorkflow from "./components/FinanceWorkflow.jsx";
import BeforeAfterPanel from "./components/BeforeAfterPanel.jsx";
import PhaseCallout from "./components/PhaseCallout.jsx";
import StoryHeader from "./components/StoryHeader.jsx";
import DemoPicker from "./components/DemoPicker.jsx";
import TruthStrip from "./components/TruthStrip.jsx";
import JobReplay from "./components/JobReplay.jsx";
import CommandCenter from "./components/CommandCenter.jsx";
import useDemoData from "./hooks/useDemoData.js";
import { useEffect, useState } from "react";

export default function App() {
  const { telemetry, sla, outputs, money, finance, timeline, phase, runDemo, sourceLabel, scenarioId, setScenarioId, scenarios } = useDemoData();
  const [uiMode, setUiMode] = useState(() => {
    try {
      const u = new URL(window.location.href);
      const forcedTour = u.searchParams.get("tour") === "1" || u.hash === "#tour";
      if (forcedTour) return "story";
      return localStorage.getItem("settld_demo_ui_mode") || "console";
    } catch {
      return "console";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("settld_demo_ui_mode", uiMode);
    } catch {
      // ignore
    }
  }, [uiMode]);

  if (uiMode === "console") {
    return <CommandCenter scenarioId={scenarioId} setScenarioId={setScenarioId} scenarios={scenarios} onExit={() => setUiMode("story")} />;
  }

  const truth = (() => {
    if (scenarioId === "finance") {
      const reconcileOk = finance?.reconcileJson?.ok === true;
      return {
        chain: { status: "na", detail: "fixture" },
        proof: { status: reconcileOk ? "ok" : "warn", detail: reconcileOk ? "reconcile OK" : "reconcile missing" },
        ledger: { status: reconcileOk ? "ok" : "na", detail: reconcileOk ? `${finance?.reconcileJson?.entryCount ?? 0} entries` : "fixture" },
        exports: { status: finance?.journalCsvText ? "ok" : "warn", detail: finance?.journalCsvText ? "JournalCsv present" : "missing" },
        month: { status: reconcileOk ? "ok" : "na", detail: finance?.period ?? "period" }
      };
    }
    return {
      chain: { status: "ok", detail: "hash-chained" },
      proof: { status: "na", detail: "not implemented in this demo yet" },
      ledger: { status: "ok", detail: "net-zero" },
      exports: { status: "na", detail: "fixture" },
      month: { status: "na", detail: "fixture" }
    };
  })();

  return (
    <div className="h-screen overflow-auto bg-settld-dark p-8">
      <header className="text-center mb-10">
        <h1 className="text-4xl font-bold tracking-tight mb-2">
          <span className="text-settld-accent">S E T T L D</span>
        </h1>
        <p className="text-gray-400 text-lg">Settlement Infrastructure for Robotics</p>
        <p className="text-gray-500 text-sm mt-2">Data source: {sourceLabel}</p>
        <div className="mt-4 flex justify-center gap-2">
          <button
            onClick={() => setUiMode("console")}
            className="px-3 py-2 rounded-lg border border-settld-border bg-black/20 hover:bg-white/5 text-sm"
          >
            Open Command Center
          </button>
          <a href="#tour" className="px-3 py-2 rounded-lg border border-settld-border bg-black/10 hover:bg-white/5 text-sm">
            Tour URL
          </a>
        </div>
      </header>

      {phase === "idle" && (
        <div className="max-w-4xl mx-auto space-y-8">
          <DemoPicker scenarioId={scenarioId} setScenarioId={setScenarioId} scenarios={scenarios} />
          <TruthStrip truth={truth} />
          <BeforeAfterPanel />
          <div className="flex justify-center">
            <button
              onClick={runDemo}
              className="px-8 py-4 bg-settld-accent hover:bg-indigo-500 rounded-lg font-semibold text-lg transition-all hover:scale-105 animate-pulse-glow"
            >
              Run Demo
            </button>
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto space-y-8">
        {phase !== "idle" && (
          <div className="animate-slide-in">
            <StoryHeader telemetry={telemetry} money={money} scenarioId={scenarioId} period={finance?.period ?? null} />
          </div>
        )}

        {phase !== "idle" && (
          <div className="animate-slide-in" style={{ animationDelay: "0.05s" }}>
            <PhaseCallout phase={phase} telemetry={telemetry} money={money} scenarioId={scenarioId} />
          </div>
        )}

        {phase === "before" && (
          <div className="animate-slide-in">
            <TruthStrip truth={truth} />
            <BeforeAfterPanel />
          </div>
        )}

        {scenarioId !== "finance" && phase !== "idle" && phase !== "before" && (
          <div className="animate-slide-in">
            <TelemetryCard telemetry={telemetry} phase={phase} />
          </div>
        )}

        {scenarioId !== "finance" && phase !== "idle" && phase !== "before" && phase !== "telemetry" && phase !== "breach" && (
          <div className="flex justify-center text-settld-accent text-3xl animate-slide-in">▼</div>
        )}

        {scenarioId !== "finance" && (phase === "sla" || phase === "outputs" || phase === "complete") && (
          <div className="animate-slide-in" style={{ animationDelay: "0.2s" }}>
            <SLAVerification sla={sla} phase={phase} />
          </div>
        )}

        {scenarioId !== "finance" && (phase === "outputs" || phase === "complete") && (
          <div className="flex justify-center text-settld-accent text-3xl animate-slide-in">▼</div>
        )}

        {phase === "complete" && (
          <>
            <div className="animate-slide-in" style={{ animationDelay: "0.35s" }}>
              <TruthStrip truth={truth} />
            </div>
            <div className="animate-slide-in" style={{ animationDelay: "0.4s" }}>
              <OutputCards outputs={outputs} />
            </div>
            {scenarioId === "delivery" && (
              <div className="animate-slide-in" style={{ animationDelay: "0.43s" }}>
                <JobReplay timeline={timeline} money={money} />
              </div>
            )}
            {scenarioId === "finance" && finance && (
              <div className="animate-slide-in" style={{ animationDelay: "0.45s" }}>
                <FinancePackCards finance={finance} />
              </div>
            )}
            {scenarioId === "finance" && finance?.steps && (
              <div className="animate-slide-in" style={{ animationDelay: "0.48s" }}>
                <FinanceWorkflow steps={finance.steps} />
              </div>
            )}
            <div className="animate-slide-in" style={{ animationDelay: "0.5s" }}>
              <BeforeAfterPanel />
            </div>
            <div className="flex justify-center pt-2">
              <button
                onClick={runDemo}
                className="px-6 py-3 bg-white/10 hover:bg-white/15 border border-settld-border rounded-lg font-semibold transition-all"
              >
                Replay
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
