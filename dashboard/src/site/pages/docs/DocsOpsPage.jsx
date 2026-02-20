import DocsShell from "./DocsShell.jsx";

const deployChecklist = [
  "Configure tenant-scoped auth + wallet issuance boundaries.",
  "Persist immutable receipts/events in durable database storage.",
  "Enable webhook retries and dead-letter monitoring for escalations.",
  "Ship deterministic JSONL exports into finance reconciliation sinks.",
  "Run go-live conformance and reliability checks before cutover."
];

const operations = [
  {
    title: "Daily",
    commands: ["npm run ops:x402:pilot:weekly-report", "npm run ops:x402:receipt:sample-check"]
  },
  {
    title: "Release",
    commands: ["npm run test:ops:go-live-gate", "npm run release:artifacts"]
  },
  {
    title: "Key/Policy Rotation",
    commands: ["npm run keys:rotate", "npm run trust:wizard"]
  }
];

export default function DocsOpsPage() {
  return (
    <DocsShell
      title="Operations Runbook"
      subtitle="Production operations for autonomous spend infrastructure: reliability, auditability, and incident response."
    >
      <article className="docs-section-card">
        <h2>Deployment Checklist</h2>
        <ul className="tight-list">
          {deployChecklist.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </article>

      {operations.map((block) => (
        <article key={block.title} className="docs-section-card">
          <h2>{block.title} Commands</h2>
          <div className="mini-code">
            {block.commands.map((cmd) => (
              <code key={cmd}>{cmd}</code>
            ))}
          </div>
        </article>
      ))}
    </DocsShell>
  );
}

