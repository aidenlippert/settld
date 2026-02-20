import DocsShell from "./DocsShell.jsx";

const layers = [
  {
    title: "Identity + Delegation",
    copy: "Every actor is explicit: sponsor, agent, provider, and operator. Delegation and lineage boundaries are enforced before spend or execution advances."
  },
  {
    title: "Policy + Authorization",
    copy: "Authorizations are request-bound, quote-bound, amount-bounded, and time-bounded with replay-resistant tokens."
  },
  {
    title: "Execution + Settlement",
    copy: "Execution can only proceed after policy checks and signature checks pass; settlement decisions are deterministic and append-only."
  },
  {
    title: "Evidence + Verification",
    copy: "Receipts, reversal decisions, and dispute outcomes are immutable artifacts exportable into offline closepacks."
  },
  {
    title: "Operations + Lifecycle",
    copy: "Escalation queues, webhook delivery, insolvency sweep, and unwind hooks keep autonomous systems safe under failure."
  }
];

const invariants = [
  "No authorization without deterministic policy evaluation.",
  "No settlement without evidence integrity checks and signature verification.",
  "No mutation of receipt history; only timeline append events.",
  "No hidden overrides; every escalation decision is signed and replay-auditable.",
  "No stranded capital after insolvency; unwind and reversal are mandatory." 
];

export default function DocsArchitecturePage() {
  return (
    <DocsShell
      title="Architecture"
      subtitle="How Settld composes identity, policy, execution, evidence, and lifecycle controls into one deterministic control plane."
    >
      <article className="docs-section-card">
        <h2>Control-Plane Layers</h2>
        <p>Each layer enforces strict boundaries, then hands forward a verifiable artifact to the next layer.</p>
        <div className="docs-card-grid">
          {layers.map((layer) => (
            <article key={layer.title} className="docs-ref-card">
              <strong>{layer.title}</strong>
              <span>{layer.copy}</span>
            </article>
          ))}
        </div>
      </article>

      <article className="docs-section-card">
        <h2>System Invariants</h2>
        <ul className="tight-list">
          {invariants.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </article>

      <article className="docs-section-card">
        <h2>Lifecycle Command Graph</h2>
        <div className="mini-code">
          <code>quote -&gt; authorize -&gt; execute -&gt; verify -&gt; receipt</code>
          <code>policy_block -&gt; escalation_created -&gt; approve_or_deny -&gt; resume_or_void</code>
          <code>insolvency_detected -&gt; freeze -&gt; unwind -&gt; reversal -&gt; archived</code>
          <code>closepack_export -&gt; offline_verify -&gt; reconcile</code>
        </div>
      </article>
    </DocsShell>
  );
}
