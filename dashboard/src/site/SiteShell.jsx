import { docsLinks, ossLinks } from "./config/links.js";

export default function SiteShell() {
  return (
    <div className="simple-site" id="top">
      <header className="simple-nav">
        <a className="simple-brand" href="/" aria-label="Settld home">
          <span className="simple-brand-name">Settld</span>
          <span className="simple-brand-sub">Trust OS for agent commerce</span>
        </a>
        <div className="simple-nav-links">
          <a href={docsLinks.home}>Docs</a>
          <a href={docsLinks.quickstart}>Quickstart</a>
          <a href={ossLinks.repo}>GitHub</a>
          <a className="simple-btn" href={docsLinks.quickstart}>Start onboarding</a>
        </div>
      </header>

      <main className="simple-main">
        <section className="simple-hero">
          <p className="simple-kicker">Deterministic Trust OS for Agent Spending</p>
          <h1>Let agents spend money safely, with enforceable controls.</h1>
          <p className="simple-lead">
            Settld sits between autonomous agent actions and payment rails. Every risky action is policy-checked,
            challengeable by a human, and produces deterministic receipts for audit.
          </p>
          <div className="simple-command-wrap">
            <span>Run first setup:</span>
            <code>npx settld setup</code>
          </div>
          <div className="simple-actions">
            <a className="simple-btn" href={docsLinks.quickstart}>Open Quickstart</a>
            <a className="simple-btn simple-btn-muted" href={docsLinks.integrations}>Host Integrations</a>
          </div>
        </section>

        <section className="simple-grid" aria-label="Core product summary">
          <article>
            <h2>Policy Runtime</h2>
            <p>Allow, challenge, deny, or escalate with stable reason codes and policy fingerprints.</p>
          </article>
          <article>
            <h2>Operator Control</h2>
            <p>Human-in-the-loop approvals, emergency pause, revoke, and signed override decisions.</p>
          </article>
          <article>
            <h2>Deterministic Receipts</h2>
            <p>Proof packets can be verified offline by finance, risk, and compliance teams.</p>
          </article>
        </section>

        <section className="simple-links" aria-label="Essential links">
          <h2>Essential links</h2>
          <ul>
            <li><a href={docsLinks.home}>Documentation</a></li>
            <li><a href={docsLinks.quickstart}>Onboarding quickstart</a></li>
            <li><a href={docsLinks.security}>Security model</a></li>
            <li><a href={docsLinks.api}>API reference</a></li>
            <li><a href={ossLinks.repo}>GitHub repository</a></li>
          </ul>
        </section>
      </main>

      <footer className="simple-footer">
        <span>Settld</span>
        <span>Trust infrastructure for autonomous economic action.</span>
      </footer>
    </div>
  );
}
