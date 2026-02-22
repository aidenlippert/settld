import { docsLinks, ossLinks } from "./config/links.js";
import "./site.css";

const hostList = ["OpenClaw", "Codex", "Claude", "Cursor"];

const trustPillars = [
  {
    title: "Deterministic policy runtime",
    body: "Every paid or high-risk action resolves as allow, challenge, deny, or escalate with stable reason codes."
  },
  {
    title: "Execution binding",
    body: "Requests are cryptographically bound to authorization and policy state, so replay and mutation fail predictably."
  },
  {
    title: "Proof packets",
    body: "Receipts, timeline evidence, and verification outputs are exportable and replayable offline for audit and finance."
  },
  {
    title: "Operator control plane",
    body: "Challenged actions route to human review with signed decisions, kill switches, and immutable audit traces."
  }
];

const setupModes = [
  {
    title: "Managed Wallet",
    body: "Settld bootstraps a wallet path during setup and pre-wires the runtime so first paid actions are fast."
  },
  {
    title: "Bring Your Own Wallet",
    body: "Use your existing wallet IDs and secrets while still enforcing policy, evidence, and dispute controls."
  },
  {
    title: "No Wallet Yet",
    body: "Start in trust-only mode, validate host integration, then enable money rails when your team is ready."
  }
];

const steps = [
  {
    title: "Run setup",
    body: "Start with `npx settld setup`, pick host + wallet mode, and write runtime configuration in one flow."
  },
  {
    title: "Route agent actions",
    body: "Agent capability calls pass through Settld policy enforcement and return deterministic decisions."
  },
  {
    title: "Verify and reconcile",
    body: "Each completed action emits a receipt bundle your engineering, finance, and compliance teams can verify."
  }
];

const spendScopes = [
  "Paid tool and API calls",
  "Agent-to-agent delegated subtasks",
  "Procurement-style bounded workflows",
  "Service and data purchases under policy limits"
];

const quickCommands = `npx settld setup
npm run mcp:probe -- --call settld.about '{}'
npm run demo:mcp-paid-exa
settld x402 receipt verify /tmp/settld-first-receipt.json --format json`;

const proofItems = [
  "Policy fingerprint + reason codes",
  "Execution binding hashes + tamper-evident timeline",
  "Settlement receipt + offline verification report"
];

export default function SiteShell() {
  return (
    <div className="nova-site" id="top">
      <div className="nova-bg-grid" aria-hidden="true" />
      <div className="nova-bg-orb nova-bg-orb-a" aria-hidden="true" />
      <div className="nova-bg-orb nova-bg-orb-b" aria-hidden="true" />

      <header className="nova-nav-wrap">
        <nav className="nova-nav" aria-label="Primary">
          <a className="nova-brand" href="/" aria-label="Settld home">
            <span className="nova-brand-mark">S</span>
            <span className="nova-brand-copy">
              <span className="nova-brand-name">Settld</span>
              <span className="nova-brand-sub">Trust OS for Agent Commerce</span>
            </span>
          </a>
          <div className="nova-nav-links">
            <a href={docsLinks.home}>Docs</a>
            <a href={docsLinks.quickstart}>Quickstart</a>
            <a href={docsLinks.security}>Security</a>
            <a href={ossLinks.repo}>GitHub</a>
          </div>
          <div className="nova-nav-cta">
            <a className="nova-btn nova-btn-ghost" href={docsLinks.quickstart}>View docs</a>
            <a className="nova-btn nova-btn-solid" href={docsLinks.quickstart}>Start onboarding</a>
          </div>
        </nav>
      </header>

      <main className="nova-main">
        <section className="nova-hero nova-reveal">
          <div>
            <p className="nova-kicker">Deterministic Trust Infrastructure</p>
            <h1>Agents can spend money. Humans keep enforceable control.</h1>
            <p className="nova-lead">
              Settld is the control plane between autonomous agent actions and money movement.
              Policy decisions are deterministic, outcomes are challengeable, and receipts are verifiable offline.
            </p>
            <div className="nova-hero-cta">
              <a className="nova-btn nova-btn-solid" href={docsLinks.quickstart}>Run quickstart</a>
              <a className="nova-btn nova-btn-ghost" href={docsLinks.integrations}>Host integration guide</a>
            </div>
            <div className="nova-hosts" aria-label="Supported hosts">
              {hostList.map((host) => (
                <span key={host}>{host}</span>
              ))}
            </div>
          </div>
          <aside className="nova-proof-card">
            <p className="nova-proof-title">First proof packet includes</p>
            <ul>
              {proofItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div className="nova-shell">
              <span>First command</span>
              <code>npx settld setup</code>
            </div>
          </aside>
        </section>

        <section className="nova-section nova-reveal" style={{ animationDelay: "70ms" }}>
          <header className="nova-section-head">
            <p>Core Product</p>
            <h2>One trust kernel, four production primitives</h2>
          </header>
          <div className="nova-grid nova-grid-4">
            {trustPillars.map((pillar) => (
              <article key={pillar.title} className="nova-card">
                <h3>{pillar.title}</h3>
                <p>{pillar.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="nova-section nova-reveal" style={{ animationDelay: "120ms" }}>
          <header className="nova-section-head">
            <p>Workflow</p>
            <h2>How onboarding and execution work</h2>
          </header>
          <div className="nova-grid nova-grid-3">
            {steps.map((step, index) => (
              <article key={step.title} className="nova-step">
                <span>{`0${index + 1}`}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="nova-section nova-reveal" style={{ animationDelay: "160ms" }}>
          <header className="nova-section-head">
            <p>Wallet Setup Paths</p>
            <h2>Choose the payment path that matches your runtime risk posture</h2>
          </header>
          <div className="nova-grid nova-grid-3">
            {setupModes.map((mode) => (
              <article key={mode.title} className="nova-card nova-card-mode">
                <h3>{mode.title}</h3>
                <p>{mode.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="nova-section nova-reveal" style={{ animationDelay: "210ms" }}>
          <div className="nova-split">
            <article className="nova-card">
              <h3>What agents can spend on first</h3>
              <ul className="nova-list">
                {spendScopes.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
            </article>
            <article className="nova-card">
              <h3>Developer command path</h3>
              <pre><code>{quickCommands}</code></pre>
            </article>
          </div>
        </section>

        <section className="nova-section nova-reveal" style={{ animationDelay: "260ms" }}>
          <div className="nova-resource-bar">
            <a href={docsLinks.home}>Documentation</a>
            <a href={docsLinks.quickstart}>Quickstart</a>
            <a href={docsLinks.api}>API reference</a>
            <a href={docsLinks.security}>Security model</a>
            <a href={docsLinks.ops}>Runbooks</a>
            <a href={ossLinks.repo}>GitHub</a>
          </div>
        </section>

        <section className="nova-cta nova-reveal" style={{ animationDelay: "310ms" }}>
          <h2>Launch trust-first agent commerce</h2>
          <p>Install once, wire any supported host, and make every paid action auditable by design.</p>
          <div className="nova-hero-cta">
            <a className="nova-btn nova-btn-solid" href={docsLinks.quickstart}>Start onboarding</a>
            <a className="nova-btn nova-btn-ghost" href={ossLinks.repo}>View GitHub</a>
          </div>
        </section>
      </main>

      <footer className="nova-footer">
        <span>Settld</span>
        <span>Trust infrastructure for autonomous economic action.</span>
      </footer>
    </div>
  );
}
