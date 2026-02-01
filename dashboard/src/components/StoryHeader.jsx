function formatUsd(cents) {
  if (!Number.isSafeInteger(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export default function StoryHeader({ telemetry, money, scenarioId, period }) {
  const isFinance = scenarioId === "finance";
  return (
    <div className="bg-settld-card border border-settld-border rounded-xl p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm text-gray-400">{isFinance ? "Close package" : "Live job"}</div>
          <div className="font-mono text-lg text-gray-100">{isFinance ? `period ${period ?? "—"}` : telemetry.jobId}</div>
        </div>
        <div className="text-right">
          <div className="text-sm text-gray-400">{isFinance ? "System" : "Robot"}</div>
          <div className="font-mono text-lg text-gray-100">{isFinance ? "settld" : telemetry.robotId}</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="p-3 rounded-lg border border-settld-border bg-black/20">
          <div className="text-xs text-gray-500">Gross</div>
          <div className="text-lg font-semibold">{formatUsd(money.grossCents)}</div>
        </div>
        <div className="p-3 rounded-lg border border-settld-border bg-black/20">
          <div className="text-xs text-gray-500">Credit</div>
          <div className={`text-lg font-semibold ${money.creditCents > 0 ? "text-settld-warning" : ""}`}>
            {money.creditCents > 0 ? `-${formatUsd(money.creditCents)}` : formatUsd(0)}
          </div>
        </div>
        <div className="p-3 rounded-lg border border-settld-border bg-black/20">
          <div className="text-xs text-gray-500">Net</div>
          <div className="text-lg font-semibold">{formatUsd(money.netCents)}</div>
        </div>
      </div>

      <div className="mt-3 text-gray-500 text-sm">
        {isFinance ? (
          <>
            Output: <span className="text-gray-200 font-medium">Journal CSV + proof bundles</span>
          </>
        ) : (
          <>
            Task: <span className="text-gray-200 font-medium">{telemetry.task}</span>
          </>
        )}
      </div>
    </div>
  );
}
