import { useEffect, useState } from "react";

import ProgressBar from "./ProgressBar.jsx";

export default function TelemetryCard({ telemetry, phase }) {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    setElapsedSec(0);
  }, [telemetry?.jobId]);

  useEffect(() => {
    if (phase === "telemetry" || phase === "breach") {
      const interval = setInterval(() => {
        setElapsedSec((prev) => {
          const step = Number.isSafeInteger(telemetry.simStepSec) && telemetry.simStepSec > 0 ? telemetry.simStepSec : 1;
          const next = prev + step;
          if (next >= telemetry.actualDurationSec) return telemetry.actualDurationSec;
          return next;
        });
      }, 75);
      return () => clearInterval(interval);
    }
  }, [phase, telemetry?.actualDurationSec]);

  const slaSec = Math.max(1, Math.floor((telemetry.slaMinutes ?? 0) * 60));
  const progress = Math.min((elapsedSec / slaSec) * 100, 100);
  const isOverSLA = elapsedSec > slaSec;

  return (
    <div className="bg-settld-card border border-settld-border rounded-xl p-6">
      <div className="flex items-center gap-3 mb-6">
        <span className="text-2xl">Telemetry</span>
        <h2 className="text-xl font-semibold">Incoming Facts</h2>
        {(phase === "telemetry" || phase === "breach") && (
          <span className="ml-auto px-3 py-1 bg-settld-accent/20 text-settld-accent rounded-full text-sm animate-pulse">
            LIVE
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <p className="text-gray-400 text-sm">Robot</p>
          <p className="font-mono text-lg">{telemetry.robotId}</p>
        </div>
        <div>
          <p className="text-gray-400 text-sm">Task</p>
          <p className="font-mono text-lg">{telemetry.task}</p>
        </div>
        <div>
          <p className="text-gray-400 text-sm">SLA window</p>
          <p className="font-mono text-lg">{telemetry.slaMinutes} minutes</p>
        </div>
        <div>
          <p className="text-gray-400 text-sm">Elapsed</p>
          <p className={`font-mono text-lg ${isOverSLA ? "text-settld-error" : "text-white"}`}>
            {Math.floor(elapsedSec / 60)}m {String(elapsedSec % 60).padStart(2, "0")}s
          </p>
        </div>
      </div>

      <ProgressBar progress={progress} isOverSLA={isOverSLA} />
      {isOverSLA && (
        <div className="mt-3 text-settld-warning text-sm font-semibold">
          SLA breach: late by {telemetry.breachAmount}
        </div>
      )}
      <div className="mt-3 text-gray-500 text-xs font-mono">job: {telemetry.jobId}</div>
    </div>
  );
}
