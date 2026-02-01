import { useMemo, useState } from "react";

import InspectDrawer from "./InspectDrawer.jsx";

function fmtMoney(cents) {
  if (!Number.isSafeInteger(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function checkChain(events) {
  if (!Array.isArray(events) || events.length === 0) return { ok: false, reason: "no events" };
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    if ((cur?.prevChainHash ?? null) !== (prev?.chainHash ?? null)) {
      return { ok: false, reason: `break at #${i}` };
    }
  }
  return { ok: true, reason: `${events.length} events linked` };
}

function checkLedgerBalanced(ledgerEntries) {
  if (!Array.isArray(ledgerEntries) || ledgerEntries.length === 0) return { ok: false, reason: "no entries" };
  for (const entry of ledgerEntries) {
    const sum = (entry?.postings ?? []).reduce((acc, p) => acc + (Number(p?.amountCents) || 0), 0);
    if (sum !== 0) return { ok: false, reason: `entry ${entry?.id ?? "?"} not net-zero` };
  }
  return { ok: true, reason: `${ledgerEntries.length} entries net-zero` };
}

export default function JobReplay({ timeline, money }) {
  const [selected, setSelected] = useState(null);

  const events = timeline?.events ?? [];
  const job = timeline?.job ?? null;

  const chain = useMemo(() => checkChain(events), [events]);
  const ledger = useMemo(() => checkLedgerBalanced(timeline?.ledgerEntries ?? []), [timeline]);

  const summary = useMemo(() => {
    const breachCount = job?.slaBreaches?.length ?? 0;
    const creditCount = job?.slaCredits?.length ?? 0;
    return {
      jobId: job?.id ?? "job",
      robotId: job?.execution?.robotId ?? job?.reservation?.robotId ?? job?.match?.robotId ?? "robot",
      status: job?.status ?? "unknown",
      breaches: breachCount,
      credits: creditCount
    };
  }, [job]);

  return (
    <div className="bg-settld-card border border-settld-border rounded-xl p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-semibold">Job Replay</h2>
          <div className="text-sm text-gray-400 mt-1">
            <span className="font-mono">{summary.jobId}</span> · robot <span className="font-mono">{summary.robotId}</span> · status{" "}
            <span className="font-mono">{summary.status}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-gray-400">Gross / Credit / Net</div>
          <div className="font-mono text-lg">
            {fmtMoney(money?.grossCents)} / <span className="text-settld-warning">{fmtMoney(money?.creditCents)}</span> /{" "}
            <span className="text-settld-success">{fmtMoney(money?.netCents)}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            chain: {chain.ok ? "OK" : "broken"} · ledger: {ledger.ok ? "OK" : "broken"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-lg border border-settld-border bg-black/20">
          <div className="text-xs text-gray-500">SLA</div>
          <div className="text-sm font-semibold mt-1">{summary.breaches ? "Breach detected" : "No breach"}</div>
          <div className="text-xs text-gray-400 mt-2">Credits issued: {summary.credits}</div>
        </div>
        <div className="p-4 rounded-lg border border-settld-border bg-black/20">
          <div className="text-xs text-gray-500">Integrity</div>
          <div className="text-sm font-semibold mt-1">{chain.ok ? "Hash-chained event log" : "Chain broken"}</div>
          <div className="text-xs text-gray-400 mt-2">{chain.reason}</div>
        </div>
        <div className="p-4 rounded-lg border border-settld-border bg-black/20">
          <div className="text-xs text-gray-500">Accounting</div>
          <div className="text-sm font-semibold mt-1">{ledger.ok ? "Ledger net-zero" : "Ledger mismatch"}</div>
          <div className="text-xs text-gray-400 mt-2">{ledger.reason}</div>
        </div>
      </div>

      <div className="mt-6">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold">Append-only event stream</div>
          <div className="text-xs text-gray-500">click any row to inspect</div>
        </div>
        <div className="border border-settld-border rounded-lg overflow-hidden">
          <div className="grid grid-cols-12 bg-black/20 text-xs text-gray-400 px-3 py-2">
            <div className="col-span-2">at</div>
            <div className="col-span-3">type</div>
            <div className="col-span-3">actor</div>
            <div className="col-span-2">chainHash</div>
            <div className="col-span-2">signer</div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {events.map((e) => (
              <button
                key={e.id}
                onClick={() => setSelected(e)}
                className="w-full text-left grid grid-cols-12 px-3 py-2 border-t border-settld-border/40 hover:bg-white/5 text-xs font-mono"
              >
                <div className="col-span-2 text-gray-400">{(e.at ?? "").slice(11, 19)}</div>
                <div className="col-span-3 text-gray-200">{e.type}</div>
                <div className="col-span-3 text-gray-400">
                  {e.actor?.type}:{e.actor?.id}
                </div>
                <div className="col-span-2 text-gray-500">{String(e.chainHash ?? "").slice(0, 10)}…</div>
                <div className="col-span-2 text-gray-500">{String(e.signerKeyId ?? "").slice(0, 10)}…</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <InspectDrawer
        open={!!selected}
        title={`Event: ${selected?.type ?? ""}`}
        subtitle={`${selected?.at ?? ""} · actor ${selected?.actor?.type ?? ""}:${selected?.actor?.id ?? ""}`}
        data={selected}
        onClose={() => setSelected(null)}
      >
        <div className="text-sm">
          <div className="text-gray-400">Why this matters</div>
          <div className="mt-2 text-gray-200">
            Each event is hash-chained (`prevChainHash` → `chainHash`) and signed (`signerKeyId`). This is the immutable source of truth used to generate
            finance-grade artifacts.
          </div>
        </div>
      </InspectDrawer>
    </div>
  );
}

