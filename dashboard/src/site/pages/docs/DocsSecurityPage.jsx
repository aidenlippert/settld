import DocsShell from "./DocsShell.jsx";

const controls = [
  "Quote signatures verified via provider JWKS and key-id resolution.",
  "Spend authorizations are request-bound, price-bounded, time-bounded, and replay-resistant.",
  "Escalation decisions are signed, one-time, and fully auditable.",
  "Receipt snapshots are immutable; reversals and dispute changes append as events.",
  "Offline closepack verification reproduces trust decisions outside Settld runtime."
];

const runbook = [
  "Rotate signing keys with overlap windows and deterministic key-id tracking.",
  "Enable webhook signature validation with timestamp tolerance and replay checks.",
  "Fail closed when proof/signature verification requirements are unmet.",
  "Preserve historical key material needed for long-term receipt verification."
];

export default function DocsSecurityPage() {
  return (
    <DocsShell
      title="Security Model"
      subtitle="Economic autonomy is constrained by cryptographic controls, deterministic policy, and durable evidence."
    >
      <article className="docs-section-card">
        <h2>Core Trust Controls</h2>
        <ul className="tight-list">
          {controls.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </article>

      <article className="docs-section-card">
        <h2>Operational Security Runbook</h2>
        <ul className="tight-list">
          {runbook.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </article>

      <article className="docs-section-card">
        <h2>Verification Commands</h2>
        <div className="mini-code">
          <code>npx settld closepack export --receipt-id rcpt_123</code>
          <code>npx settld closepack verify closepack.zip</code>
          <code>npx settld conformance kernel --ops-token tok_ops</code>
        </div>
      </article>
    </DocsShell>
  );
}

