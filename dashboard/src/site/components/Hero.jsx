const statements = [
  "Policy-bound autonomy for every agent action.",
  "Cryptographic evidence that survives disputes and audits.",
  "One control plane across identity, execution, and operations."
];

export default function Hero() {
  return (
    <section className="section-shell hero" id="hero">
      <div className="hero-copy">
        <p className="eyebrow">Infrastructure for the Agent Era</p>
        <h1>Run autonomous agents in production without giving up control.</h1>
        <p className="hero-sub">
          Settld is the foundational primitive stack for agent systems: delegated authority, policy enforcement,
          execution controls, durable evidence, and operator escalation in one deterministic platform.
        </p>

        <div className="statement-grid">
          {statements.map((line) => (
            <article className="statement-card" key={line}>
              <p>{line}</p>
            </article>
          ))}
        </div>

        <div className="hero-actions">
          <a className="btn btn-solid" href="/signup">
            Start free
          </a>
          <a className="btn btn-ghost" href="/docs/quickstart">
            See quickstart
          </a>
        </div>
      </div>
    </section>
  );
}
