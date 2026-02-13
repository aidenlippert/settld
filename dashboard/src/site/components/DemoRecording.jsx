const timeline = [
  "[00:00] start local stack + mint ops token",
  "[00:18] run kernel conformance pack",
  "[00:47] inspect replay + deterministic comparison",
  "[01:06] export closepack + offline verify",
  "[01:29] verdict: deterministic pass"
];

export default function DemoRecording() {
  return (
    <section className="section-shell split-section">
      <article className="panel panel-strong">
        <p className="eyebrow">Recorded Walkthrough</p>
        <h2>See the full run before you integrate.</h2>
        <p>
          This condensed recording mirrors the exact operator flow: conformance, replay, closepack export, and offline
          verification.
        </p>
        <div className="mini-code" role="region" aria-label="Recorded run timeline">
          {timeline.map((line) => (
            <code key={line}>{line}</code>
          ))}
        </div>
        <div className="hero-actions">
          <a className="btn btn-solid" href="/demo">
            Open interactive demo
          </a>
          <a className="btn btn-ghost" href="#quickstart">
            Reproduce commands
          </a>
        </div>
      </article>
      <article className="panel">
        <p className="eyebrow">Command Snapshot</p>
        <h3>Kernel conformance command</h3>
        <div className="mini-code">
          <code>$ npx settld conformance kernel --ops-token tok_ops</code>
          <code>✓ deterministic critical suite</code>
          <code>✓ replay match</code>
          <code>✓ closepack verified</code>
        </div>
        <p className="hero-note">Best viewed side-by-side with the Kernel Explorer workspace.</p>
      </article>
    </section>
  );
}
