import { useMemo } from "react";

const DEFAULT_SCENARIOS = Object.freeze([
  {
    id: "delivery",
    title: "SLA Credit (Delivery)",
    subtitle: "Facts in → breach → CreditMemo + SettlementStatement",
    emoji: "🚚"
  },
  {
    id: "finance",
    title: "Finance Pack (Month Close)",
    subtitle: "Statements → GLBatch + JournalCsv + bundles",
    emoji: "📚"
  }
]);

export default function DemoPicker({ scenarioId, setScenarioId, scenarios }) {
  const items = useMemo(() => {
    if (Array.isArray(scenarios) && scenarios.length) return scenarios;
    return DEFAULT_SCENARIOS;
  }, [scenarios]);

  return (
    <div className="bg-settld-card border border-settld-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">Pick a demo</h2>
          <p className="text-gray-400 text-sm mt-1">Switch narratives without changing your talk track.</p>
        </div>
        <div className="text-xs text-gray-500">UI uses local fixtures</div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {items.map((s) => {
          const selected = s.id === scenarioId;
          const disabled = s.available === false;
          return (
            <button
              key={s.id}
              onClick={() => (!disabled ? setScenarioId(s.id) : null)}
              disabled={disabled}
              className={`text-left p-4 rounded-lg border-2 transition-all hover:scale-[1.01] ${
                disabled
                  ? "border-settld-border bg-black/20 opacity-50 cursor-not-allowed"
                  : selected
                    ? "border-settld-accent bg-settld-accent/10"
                    : "border-settld-border hover:border-settld-accent/50"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="text-2xl">{s.emoji ?? "🧾"}</div>
                <div>
                  <div className="font-semibold">{s.title}</div>
                  <div className="text-sm text-gray-400 mt-1">{s.subtitle}</div>
                  {disabled ? <div className="text-xs text-gray-500 mt-2">Run pilot export to enable</div> : null}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 text-xs text-gray-500">
        Prep fixtures: run <span className="font-mono">npm run demo:delivery</span> and <span className="font-mono">npm run pilot:finance-pack</span>, then{" "}
        <span className="font-mono">npm run demo:ui:prep</span>.
      </div>
    </div>
  );
}
