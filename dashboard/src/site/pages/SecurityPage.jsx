import PageFrame from "../components/PageFrame.jsx";

const controls = [
  "Quote signature verification with provider key resolution",
  "Bounded spend authorization with replay defense",
  "Append-only receipt and reversal event timeline",
  "Offline verification and exportable evidence bundles",
  "Operator escalation workflows with signed decisions"
];

export default function SecurityPage() {
  return (
    <PageFrame>
      <section className="section-shell page-hero">
        <p className="eyebrow">Security & Trust</p>
        <h1>Autonomy without blind trust.</h1>
        <p>
          Settld is designed around verifiable delegation, bounded authorization, and durable evidence. Every critical
          transition in the economic loop is testable, inspectable, and replayable.
        </p>
        <div className="hero-actions">
          <a className="btn btn-solid" href="/docs/security">Read security docs</a>
          <a className="btn btn-ghost" href="/docs/api">API controls</a>
        </div>
      </section>

      <section className="section-shell section-highlight">
        <div className="section-heading">
          <p className="eyebrow">Control Set</p>
          <h2>Core trust controls enforced in the kernel.</h2>
        </div>
        <ul className="tight-list">
          {controls.map((control) => (
            <li key={control}>{control}</li>
          ))}
        </ul>
      </section>
    </PageFrame>
  );
}
