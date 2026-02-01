import { useMemo, useState } from "react";

import JSONViewer from "./JSONViewer.jsx";

function previewCsv(csv, maxLines = 18) {
  if (typeof csv !== "string") return null;
  const lines = csv.split(/\r?\n/);
  return lines.slice(0, maxLines).join("\n");
}

export default function FinancePackCards({ finance }) {
  const [selected, setSelected] = useState(null);

  const cards = useMemo(() => {
    const out = [];
    out.push({ id: "glbatch", title: "GLBatch.v1", kind: "json", data: finance.glBatchJson ?? null, status: finance.glBatchJson ? "success" : "missing" });
    out.push({
      id: "journalcsv",
      title: "JournalCsv.v1",
      kind: "csv",
      data: finance.journalCsvText ?? null,
      status: finance.journalCsvText ? "success" : "missing"
    });
    out.push({
      id: "reconcile",
      title: "Reconcile Report",
      kind: "json",
      data: finance.reconcileJson ?? null,
      status: finance.reconcileJson ? "success" : "missing"
    });
    return out;
  }, [finance]);

  return (
    <div className="bg-settld-card border border-settld-border rounded-xl p-6">
      <div className="flex items-center gap-3 mb-6">
        <span className="text-2xl">📚</span>
        <h2 className="text-xl font-semibold">Finance Pack</h2>
        <span className="ml-auto text-xs text-gray-500">Period: {finance.period ?? "unknown"}</span>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        {cards.map((card) => (
          <button
            key={card.id}
            onClick={() => setSelected(selected === card.id ? null : card.id)}
            className={`p-4 rounded-lg border-2 transition-all hover:scale-105 ${
              selected === card.id ? "border-settld-accent bg-settld-accent/10" : "border-settld-border hover:border-settld-accent/50"
            }`}
          >
            <p className="font-medium text-sm">{card.title}</p>
            <p className={`text-xs mt-1 ${card.status === "success" ? "text-settld-success" : "text-gray-500"}`}>
              {card.status === "success" ? "Ready" : "Missing fixture"}
            </p>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        {finance.financePackZipUrl && (
          <a
            href={finance.financePackZipUrl}
            className="px-3 py-2 rounded-lg border border-settld-border bg-black/20 hover:bg-white/5 text-sm"
            download
          >
            Download FinancePackBundle.v1.zip
          </a>
        )}
        {finance.monthProofBundleZipUrl && (
          <a
            href={finance.monthProofBundleZipUrl}
            className="px-3 py-2 rounded-lg border border-settld-border bg-black/20 hover:bg-white/5 text-sm"
            download
          >
            Download MonthProofBundle.v1.zip
          </a>
        )}
        {finance.jobProofBundleZipUrl && (
          <a href={finance.jobProofBundleZipUrl} className="px-3 py-2 rounded-lg border border-settld-border bg-black/20 hover:bg-white/5 text-sm" download>
            Download JobProofBundle.v1.zip
          </a>
        )}
      </div>

      {selected && cards.find((c) => c.id === selected)?.kind === "csv" && (
        <div className="bg-settld-dark border border-settld-border rounded-lg overflow-hidden">
          <div className="px-4 py-2 bg-settld-border/50 border-b border-settld-border">
            <p className="text-sm text-gray-400">{cards.find((c) => c.id === selected)?.title}</p>
          </div>
          <pre className="p-4 text-xs text-green-400 overflow-x-auto max-h-64">{previewCsv(cards.find((c) => c.id === selected)?.data)}</pre>
        </div>
      )}

      {selected && cards.find((c) => c.id === selected)?.kind === "json" && (
        <JSONViewer title={cards.find((c) => c.id === selected)?.title} data={cards.find((c) => c.id === selected)?.data} />
      )}
    </div>
  );
}

