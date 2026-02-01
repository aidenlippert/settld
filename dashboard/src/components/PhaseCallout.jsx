export default function PhaseCallout({ phase, telemetry, money, scenarioId }) {
  if (!phase || phase === "idle") return null;

  const base = "bg-black/20 border border-settld-border rounded-xl p-4";

  if (phase === "before") {
    if (scenarioId === "finance") {
      return (
        <div className={base}>
          <div className="text-gray-200 font-semibold">Problem</div>
          <div className="text-gray-400 text-sm mt-1">Month close is manual: reconcile, journal entry prep, disputes, and audit requests.</div>
        </div>
      );
    }
    return (
      <div className={base}>
        <div className="text-gray-200 font-semibold">Problem</div>
        <div className="text-gray-400 text-sm mt-1">A late delivery becomes a dispute, then a manual credit weeks later.</div>
      </div>
    );
  }

  if (phase === "telemetry") {
    return (
      <div className={base}>
        <div className="text-gray-200 font-semibold">Live execution</div>
        <div className="text-gray-400 text-sm mt-1">Facts stream in. The clock is running against the SLA window.</div>
      </div>
    );
  }

  if (phase === "breach") {
    return (
      <div className="bg-settld-warning/10 border border-settld-warning/30 rounded-xl p-4">
        <div className="text-settld-warning font-semibold">SLA breach detected</div>
        <div className="text-gray-300 text-sm mt-1">Late by {telemetry.breachAmount}. Policy-triggered credit is now deterministic.</div>
      </div>
    );
  }

  if (phase === "sla") {
    const creditUsd = Number.isSafeInteger(money.creditCents) ? (money.creditCents / 100).toFixed(2) : "—";
    return (
      <div className="bg-settld-accent/10 border border-settld-border rounded-xl p-4">
        <div className="text-gray-200 font-semibold">Resolution</div>
        <div className="text-gray-400 text-sm mt-1">Credit computed: ${creditUsd}. Settlement artifacts are generated next.</div>
      </div>
    );
  }

  if (phase === "outputs") {
    if (scenarioId === "finance") {
      return (
        <div className={base}>
          <div className="text-gray-200 font-semibold">Finance Pack</div>
          <div className="text-gray-400 text-sm mt-1">Statements roll up deterministically into GLBatch + JournalCsv + verifiable bundles.</div>
        </div>
      );
    }
    return (
      <div className={base}>
        <div className="text-gray-200 font-semibold">Artifacts</div>
        <div className="text-gray-400 text-sm mt-1">Work certificate, credit memo, and settlement statement are produced and verifiable.</div>
      </div>
    );
  }

  if (phase === "complete") {
    if (scenarioId === "finance") {
      return (
        <div className="bg-settld-success/10 border border-settld-border rounded-xl p-4">
          <div className="text-gray-200 font-semibold">Close package ready</div>
          <div className="text-gray-400 text-sm mt-1">Download one bundle, verify offline, import the journal CSV, archive for audit.</div>
        </div>
      );
    }
    return (
      <div className="bg-settld-success/10 border border-settld-border rounded-xl p-4">
        <div className="text-gray-200 font-semibold">Settlement complete</div>
        <div className="text-gray-400 text-sm mt-1">No emails. No dispute loop. Finance-grade outputs ready.</div>
      </div>
    );
  }

  return null;
}
