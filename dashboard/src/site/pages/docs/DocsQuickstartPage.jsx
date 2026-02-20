import DocsShell from "./DocsShell.jsx";

const steps = [
  {
    title: "Start services",
    copy: "Run the API and supporting workers in your target environment.",
    commands: ["npm run dev:api", "npm run dev:maintenance"]
  },
  {
    title: "Mint SDK key",
    copy: "Issue a scoped key for your tenant to run first paid flow.",
    commands: ["npx settld dev:sdk:key --print-only"]
  },
  {
    title: "Execute first paid call",
    copy: "Run the SDK first-run script to trigger quote -> authorize -> execute -> receipt.",
    commands: ["npx settld sdk:first-run"]
  },
  {
    title: "Verify offline",
    copy: "Export closepack and verify independently from runtime systems.",
    commands: ["npx settld closepack export --receipt-id rcpt_123", "npx settld closepack verify closepack.zip"]
  }
];

export default function DocsQuickstartPage() {
  return (
    <DocsShell
      title="Quickstart"
      subtitle="Go from zero to first enforceable autonomous transaction with deterministic evidence."
    >
      {steps.map((step) => (
        <article key={step.title} className="docs-section-card">
          <h2>{step.title}</h2>
          <p>{step.copy}</p>
          <div className="mini-code">
            {step.commands.map((cmd) => (
              <code key={cmd}>{cmd}</code>
            ))}
          </div>
        </article>
      ))}
      <article className="docs-section-card">
        <h2>Expected Outcome</h2>
        <ul className="tight-list">
          <li>Policy-bounded authorization token minted for the exact request.</li>
          <li>Immutable receipt snapshot + append-only event timeline persisted.</li>
          <li>Offline verification status shows enforceable lineage and signatures.</li>
        </ul>
      </article>
    </DocsShell>
  );
}

