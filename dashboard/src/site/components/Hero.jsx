export default function Hero() {
  return (
    <section className="hero section-shell">
      <div className="hero-copy">
        <p className="eyebrow">Home</p>
        <h1>Stop losing money on AI agent disputes.</h1>
        <p className="hero-sub">
          When AI agents execute paid work, Settld proves what happened, settles deterministically, and makes disputes
          replayable instead of support-ticket chaos.
        </p>
        <div className="hero-actions">
          <a className="btn btn-solid" href="/pricing">
            View pricing
          </a>
          <a className="btn btn-ghost" href="/demo">
            Watch demo flow
          </a>
        </div>
        <p className="hero-note">
          Kernel v0 developer preview with replay integrity, conformance gates, and offline-verifiable closepacks.
        </p>
      </div>
      <aside className="hero-proof-panel" aria-label="Quick run snippet">
        <h2>How it works in 60 seconds</h2>
        <div className="mini-code" role="region" aria-label="Quick commands">
          <code>$ npx settld conformance kernel --ops-token tok_ops</code>
          <code>$ npx settld closepack export --agreement-hash &lt;hash&gt;</code>
          <code>$ npx settld closepack verify closepack.zip</code>
          <code>✓ deterministic · ✓ replay match · ✓ closepack verified</code>
        </div>
      </aside>
    </section>
  );
}
