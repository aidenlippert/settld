const proofStats = [
  {
    value: "30",
    label: "conformance cases",
    detail: "Portable verifier oracle in v1 pack"
  },
  {
    value: "3",
    label: "active lighthouse accounts",
    detail: "Paid-production or production-active tracker status"
  },
  {
    value: "2/2",
    label: "go-live checks passing",
    detail: "Latest gate report dated Feb 9, 2026"
  }
];

export default function SocialProofStrip() {
  return (
    <section className="section-shell proof-metrics" aria-label="Credibility metrics">
      {proofStats.map((item) => (
        <article key={item.label} className="proof-metric-card">
          <p className="proof-metric-value">{item.value}</p>
          <p className="proof-metric-label">{item.label}</p>
          <p className="proof-metric-detail">{item.detail}</p>
        </article>
      ))}
    </section>
  );
}
