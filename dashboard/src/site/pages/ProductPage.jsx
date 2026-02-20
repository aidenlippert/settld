import PageFrame from "../components/PageFrame.jsx";

const pillars = [
  {
    title: "Delegated Spend Authority",
    copy: "Sponsors set hard budgets and policy constraints. Agents can execute autonomously, but only inside verifiable limits."
  },
  {
    title: "Cryptographic Execution Loop",
    copy: "Every paid call is quote-bound, authorization-bound, and evidence-bound. No blind spending, no unverifiable outputs."
  },
  {
    title: "Finance-Ready Settlement Record",
    copy: "Durable receipts, reversals, and exports are queryable and offline-verifiable for reconciliation and audits."
  }
];

const lanes = [
  "APIs and data providers",
  "MCP tools and paid capabilities",
  "Policy-gated SaaS actions",
  "Escalation and operator approvals"
];

export default function ProductPage() {
  return (
    <PageFrame>
      <section className="section-shell page-hero">
        <p className="eyebrow">Product</p>
        <h1>Economic infrastructure for autonomous agents.</h1>
        <p>
          Settld gives agents the ability to transact like real operators while preserving sponsor control,
          cryptographic trust, and accounting-grade evidence.
        </p>
        <div className="hero-actions">
          <a className="btn btn-solid" href="/docs">Open docs</a>
          <a className="btn btn-ghost" href="/docs/security">Security model</a>
        </div>
      </section>

      <section className="section-shell">
        <div className="statement-grid">
          {pillars.map((pillar) => (
            <article key={pillar.title} className="statement-card">
              <h3>{pillar.title}</h3>
              <p>{pillar.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-shell section-highlight">
        <div className="section-heading">
          <p className="eyebrow">Where Teams Start</p>
          <h2>Ship autonomous spend in high-signal lanes first.</h2>
        </div>
        <ul className="tight-list">
          {lanes.map((lane) => (
            <li key={lane}>{lane}</li>
          ))}
        </ul>
      </section>
    </PageFrame>
  );
}
