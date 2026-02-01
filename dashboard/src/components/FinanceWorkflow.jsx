import { useMemo, useState } from "react";

import InspectDrawer from "./InspectDrawer.jsx";

function classifyStep(step) {
  const code = step?.code ?? null;
  const statusCode = step?.statusCode ?? null;
  if (statusCode && statusCode >= 200 && statusCode < 300) return { status: "ok", label: "OK" };
  if (code) return { status: "warn", label: code };
  if (statusCode && statusCode >= 400) return { status: "fail", label: String(statusCode) };
  return { status: "na", label: "—" };
}

function badgeClass(status) {
  switch (status) {
    case "ok":
      return "border-settld-success/40 bg-settld-success/10 text-settld-success";
    case "warn":
      return "border-settld-warning/40 bg-settld-warning/10 text-settld-warning";
    case "fail":
      return "border-settld-error/40 bg-settld-error/10 text-settld-error";
    default:
      return "border-settld-border bg-black/20 text-gray-300";
  }
}

export default function FinanceWorkflow({ steps }) {
  const [selected, setSelected] = useState(null);

  const rows = useMemo(() => {
    if (!Array.isArray(steps)) return [];
    return steps.map((s) => ({ ...s, _badge: classifyStep(s) }));
  }, [steps]);

  return (
    <div className="bg-settld-card border border-settld-border rounded-xl p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-semibold">Finance Workflow Replay</h2>
          <div className="text-sm text-gray-400 mt-1">This is the “month close pack” executed deterministically.</div>
        </div>
        <div className="text-xs text-gray-500">click steps to inspect request/response</div>
      </div>

      <div className="border border-settld-border rounded-lg overflow-hidden">
        <div className="grid grid-cols-12 bg-black/20 text-xs text-gray-400 px-3 py-2">
          <div className="col-span-7">step</div>
          <div className="col-span-2">status</div>
          <div className="col-span-3">note</div>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {rows.map((s, idx) => (
            <button
              key={`${s.name}_${idx}`}
              onClick={() => setSelected(s)}
              className="w-full text-left grid grid-cols-12 px-3 py-2 border-t border-settld-border/40 hover:bg-white/5 text-xs"
            >
              <div className="col-span-7 font-mono text-gray-200">{s.name}</div>
              <div className="col-span-2">
                <span className={`inline-flex px-2 py-1 rounded border ${badgeClass(s._badge.status)}`}>{s._badge.label}</span>
              </div>
              <div className="col-span-3 text-gray-500 truncate">
                {s.statusCode ? `HTTP ${s.statusCode}` : ""} {s.code ? `· ${s.code}` : ""}
              </div>
            </button>
          ))}
        </div>
      </div>

      <InspectDrawer
        open={!!selected}
        title={`Step: ${selected?.name ?? ""}`}
        subtitle={`${selected?.statusCode ? `HTTP ${selected.statusCode}` : ""}${selected?.code ? ` · ${selected.code}` : ""}`}
        data={selected}
        onClose={() => setSelected(null)}
      >
        <div className="text-sm">
          <div className="text-gray-400">What this proves</div>
          <div className="mt-2 text-gray-200">
            This is a deterministic close workflow: job lifecycle → month close → party statements → GLBatch → JournalCsv → proof bundles → finance pack.
          </div>
        </div>
      </InspectDrawer>
    </div>
  );
}

