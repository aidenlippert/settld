function fmtUsd(amount) {
  if (!Number.isFinite(amount)) return "—";
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function safeIsoMs(iso) {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : null;
}

function computeSla({ bookingStartAt, bookingEndAt, execCompletedAt }) {
  const start = safeIsoMs(bookingStartAt);
  const end = safeIsoMs(bookingEndAt);
  const done = safeIsoMs(execCompletedAt);
  if (start === null || end === null || done === null) return null;
  const limitMs = Math.max(0, end - start);
  const actualMs = Math.max(0, done - start);
  const lateMs = Math.max(0, done - end);
  return { limitMs, actualMs, lateMs };
}

function shortHash(h) {
  const s = String(h ?? "");
  if (!s) return "—";
  if (s.length <= 16) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

export default function VerdictCard({ job, onPrimaryAction }) {
  const t = job?.timeline ?? null;
  const bookingStartAt = t?.job?.booking?.startAt ?? null;
  const bookingEndAt = t?.job?.booking?.endAt ?? null;
  const execCompletedAt = t?.job?.execution?.completedAt ?? null;

  const sla = computeSla({ bookingStartAt, bookingEndAt, execCompletedAt });
  const policyHash = t?.job?.booking?.policyHash ?? t?.job?.customerPolicyHash ?? job?.policyHash ?? null;

  const value = Number(job?.valueUsd ?? 0);
  const credit = Number(job?.creditUsd ?? 0); // negative when credit applied
  const net = Number(job?.netUsd ?? 0);

  const limitLabel = sla ? formatDuration(sla.limitMs) : "—";
  const actualLabel = sla ? formatDuration(sla.actualMs) : "—";
  const lateLabel = sla ? `+${formatDuration(sla.lateMs)}` : "—";

  const redPct = sla && sla.actualMs > 0 ? Math.min(100, Math.round((sla.lateMs / sla.actualMs) * 100)) : 0;
  const greenPct = sla ? Math.max(0, 100 - redPct) : 100;

  return (
    <div className="p-4 border-b border-slate-800 bg-slate-900/30">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-slate-300 font-semibold">VERDICT_CARD // SLA_BREACH</div>
          <div className="text-slate-500 mt-1">
            POLICY <span className="text-slate-300">{shortHash(policyHash)}</span> · LIMIT{" "}
            <span className="text-slate-300">{limitLabel}</span> · ACTUAL <span className="text-slate-300">{actualLabel}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-slate-500 text-[10px]">TIME_DELTA</div>
          <div className="text-red-400 font-bold">{lateLabel}</div>
        </div>
      </div>

      <div className="mt-3">
        <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden flex">
          <div className="h-full bg-emerald-500/70" style={{ width: `${greenPct}%` }} />
          <div className="h-full bg-red-500/80" style={{ width: `${redPct}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-slate-500 mt-2">
          <span>Window: {limitLabel}</span>
          <span>Late: {lateLabel}</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="p-3 rounded border border-slate-800 bg-[#020617]">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider">Contract value</div>
          <div className="text-lg text-slate-100 font-medium">{fmtUsd(value)}</div>
        </div>
        <div className="p-3 rounded border border-red-900/30 bg-red-950/10">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider">Penalty calc</div>
          <div className="text-lg text-red-300 font-medium">{credit ? fmtUsd(credit) : "—"}</div>
          <div className="text-[10px] text-slate-600">Policy-triggered credit</div>
        </div>
        <div className="p-3 rounded border border-emerald-900/30 bg-emerald-950/10">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider">Net settlement</div>
          <div className="text-lg text-slate-100 font-medium">{fmtUsd(net)}</div>
          <button
            onClick={onPrimaryAction}
            className="mt-2 px-3 py-1.5 rounded border border-emerald-900/50 bg-emerald-900/30 text-emerald-200 text-[10px] hover:bg-emerald-900/40 transition"
          >
            OPEN_FINANCE_PACK
          </button>
        </div>
      </div>
    </div>
  );
}

