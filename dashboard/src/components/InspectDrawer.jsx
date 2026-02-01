import JSONViewer from "./JSONViewer.jsx";

export default function InspectDrawer({ open, title, subtitle, data, children, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full sm:w-[680px] bg-settld-dark border-l border-settld-border shadow-2xl">
        <div className="p-4 border-b border-settld-border flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-semibold">{title}</div>
            {subtitle ? <div className="text-sm text-gray-400 mt-1">{subtitle}</div> : null}
          </div>
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-lg border border-settld-border bg-black/20 hover:bg-white/5 text-sm"
            aria-label="Close"
          >
            Esc
          </button>
        </div>

        <div className="p-4 overflow-y-auto h-[calc(100%-64px)] space-y-4">
          {children ? <div className="bg-settld-card border border-settld-border rounded-xl p-4">{children}</div> : null}
          {data ? <JSONViewer title="Raw JSON" data={data} /> : null}
        </div>
      </div>
    </div>
  );
}

