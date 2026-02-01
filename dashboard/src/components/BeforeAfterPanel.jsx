export default function BeforeAfterPanel() {
  return (
    <div className="bg-settld-card border border-settld-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Why this matters</h2>
        <span className="text-xs text-gray-500">Before vs After</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 rounded-lg border border-settld-border bg-black/20">
          <div className="text-sm font-semibold text-gray-200 mb-2">Without Settld</div>
          <ul className="text-sm text-gray-400 space-y-2">
            <li>Customer disputes: “it was late”</li>
            <li>Ops pulls logs and screenshots</li>
            <li>Weeks of back-and-forth to issue a credit</li>
            <li>No immutable proof of policy-at-time-of-job</li>
          </ul>
        </div>
        <div className="p-4 rounded-lg border border-settld-border bg-black/20">
          <div className="text-sm font-semibold text-gray-200 mb-2">With Settld</div>
          <ul className="text-sm text-gray-400 space-y-2">
            <li>Breach detected automatically</li>
            <li>Credit computed deterministically</li>
            <li>Finance-grade artifacts generated instantly</li>
            <li>Signed, hash-chained proof for disputes</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

