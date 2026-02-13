const faqs = [
  {
    q: "How does pricing work?",
    a: "Plans combine a monthly platform fee with a settled-volume fee. Builder starts at $99/month + 0.75%; Growth starts at $599/month + 0.45%."
  },
  {
    q: "Can we verify settlements without Settld infrastructure?",
    a: "Yes. Closepacks are designed for offline verification, including signatures, bindings, and deterministic replay checks."
  },
  {
    q: "How do disputes work?",
    a: "Disputes open signed envelope artifacts, freeze relevant holds, and resolve through deterministic verdict and adjustment paths."
  },
  {
    q: "What SDKs are available?",
    a: "JavaScript and Python API SDKs are available, plus CLI tooling for production, verification, conformance, and closepack workflows."
  },
  {
    q: "How long does integration take?",
    a: "Most teams can run their first verified flow in under 10 minutes using the quickstart and conformance command."
  },
  {
    q: "Is this a payment network?",
    a: "No. Settld is an enforcement and settlement control layer. Payment rails are adapters integrated behind deterministic policy and evidence checks."
  },
  {
    q: "What does replayable mean in practice?",
    a: "You can recompute decisions against stored policy and verifier references, then compare computed vs recorded outcomes with explicit mismatch codes."
  },
  {
    q: "Is Settld open?",
    a: "Protocol objects, schemas, and conformance vectors are open. Hosted control-plane features are delivered as product surfaces."
  }
];

export default function FaqSection() {
  return (
    <section className="section-shell">
      <div className="section-heading">
        <p className="eyebrow">FAQ</p>
        <h2>Direct answers for launch decisions.</h2>
      </div>
      <div className="faq-list">
        {faqs.map((item) => (
          <details key={item.q} className="faq-item">
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
