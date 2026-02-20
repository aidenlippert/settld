import PageFrame from "../components/PageFrame.jsx";

const phases = [
  {
    title: "Phase 1: First verified transaction",
    copy: "Run local stack, issue API key, execute one paid call, verify receipt offline."
  },
  {
    title: "Phase 2: Production policy guardrails",
    copy: "Define wallet budgets, allowlists, risk classes, and escalation paths."
  },
  {
    title: "Phase 3: Provider scale",
    copy: "Onboard paid tools with wrappers/manifests and enforce conformance before listing."
  }
];

export default function DevelopersPage() {
  return (
    <PageFrame>
      <section className="section-shell page-hero">
        <p className="eyebrow">Developers</p>
        <h1>From first API call to production-grade autonomous commerce.</h1>
        <p>
          Build fast with SDK and MCP flows, then harden policy and settlement behavior with deterministic proofs,
          receipts, and replay controls.
        </p>
        <div className="hero-actions">
          <a className="btn btn-solid" href="/docs/quickstart">Start quickstart</a>
          <a className="btn btn-ghost" href="/docs/api">Browse API docs</a>
        </div>
      </section>

      <section className="section-shell">
        <div className="statement-grid">
          {phases.map((phase) => (
            <article key={phase.title} className="statement-card">
              <h3>{phase.title}</h3>
              <p>{phase.copy}</p>
            </article>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}
