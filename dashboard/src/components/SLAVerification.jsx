export default function SLAVerification({ sla, phase }) {
  const getStatusDisplay = () => {
    if (phase === "sla") return { text: "VERIFYING", color: "text-settld-accent" };
    if (sla.breached) return { text: "SLA BREACHED", color: "text-settld-warning" };
    return { text: "SLA MET", color: "text-settld-success" };
  };

  const status = getStatusDisplay();

  return (
    <div className="bg-settld-card border border-settld-border rounded-xl p-6">
      <div className="flex items-center gap-3 mb-6">
        <span className="text-2xl">SLA</span>
        <h2 className="text-xl font-semibold">Verification</h2>
        <span className={`ml-auto px-3 py-1 rounded-full text-sm font-medium ${status.color} bg-white/10`}>{status.text}</span>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-gray-400 text-sm">Pinned policyHash</p>
          <p className="font-mono break-all">{sla.policyHash}</p>
        </div>
        <div>
          <p className="text-gray-400 text-sm">Rule</p>
          <p className="text-settld-accent italic">"{sla.clause}"</p>
        </div>
        {sla.breached && (
          <div className="mt-4 p-4 bg-settld-warning/10 border border-settld-warning/30 rounded-lg">
            <p className="text-settld-warning font-medium">Late by {sla.breachAmount}</p>
          </div>
        )}
      </div>
    </div>
  );
}
