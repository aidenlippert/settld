const shippingNow = [
  "Kernel v0 artifact chain and settlement loop",
  "Conformance, replay, and offline closepacks",
  "Self-serve pricing, SDKs, and onboarding surfaces",
];

const nextLayers = [
  "Hosted baseline hardening and operational controls",
  "Real-money settlement adapters with reconciliation",
  "Live customer dashboard over production API",
];

export default function Vision() {
  return (
    <section className="section-shell section-highlight">
      <div className="section-heading">
        <p className="eyebrow">Roadmap</p>
        <h2>Shipping now vs next layers.</h2>
      </div>
      <div className="future-grid">
        <article className="future-card">
          <h3>Shipping now</h3>
          <ul className="tight-list">
            {shippingNow.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
        <article className="future-card">
          <h3>Next layers</h3>
          <ul className="tight-list">
            {nextLayers.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  );
}
