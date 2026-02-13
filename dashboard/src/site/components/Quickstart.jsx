const steps = [
  "npx settld dev up",
  "npx settld init capability my-capability",
  "npx settld conformance kernel --ops-token tok_ops",
];

export default function Quickstart() {
  return (
    <section id="developers" className="section-shell section-highlight">
      <div className="section-heading" id="quickstart">
        <p className="eyebrow">Quickstart</p>
        <h2>Try it now in one command.</h2>
        <p>Run the conformance pack locally, then compare to the live interactive demo.</p>
      </div>
      <div className="quickstart-grid">
        <article className="panel panel-strong">
          <h3>Commands</h3>
          <ol className="command-list">
            {steps.map((step) => (
              <li key={step}>
                <code>{step}</code>
              </li>
            ))}
          </ol>
        </article>
        <article className="panel">
          <h3>Expected output</h3>
          <ul className="tight-list">
            <li>Kernel artifact chain rendered in Explorer</li>
            <li>Replay result with deterministic comparison details</li>
            <li>Closepack verify report with explicit issue codes</li>
            <li>Conformance report that can be attached to releases</li>
          </ul>
          <div className="hero-actions">
            <a className="btn btn-solid" href="/demo">
              Open interactive demo
            </a>
            <a className="btn btn-ghost" href="/kernel-v0/">
              Protocol details
            </a>
          </div>
        </article>
      </div>
    </section>
  );
}
