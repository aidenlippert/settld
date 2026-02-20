import DocsShell from "./DocsShell.jsx";

const surfaces = [
  {
    title: "MCP Surface",
    copy: "Expose Settld primitives as MCP tools so agent hosts can call quote, authorize, verify, and receipt workflows directly.",
    commands: ["npx settld init capability my-capability", "scripts/mcp/settld-mcp-server.mjs"]
  },
  {
    title: "SDK Surface",
    copy: "Use first-run and SDK clients to drive deterministic paid flows from app servers or workers.",
    commands: ["npx settld dev:sdk:key --print-only", "npx settld sdk:first-run"]
  },
  {
    title: "Webhook Surface",
    copy: "Route escalations and lifecycle events into operator systems with signed payloads and rotation-safe secrets.",
    commands: ["POST /x402/webhooks/endpoints", "POST /x402/webhooks/endpoints/:id/rotate-secret"]
  },
  {
    title: "Operator Surface",
    copy: "Give humans a controlled inbox for approvals, denials, and one-time override decisions when policy blocks execution.",
    commands: ["GET /x402/gate/escalations", "POST /x402/gate/escalations/:id/resolve"]
  }
];

const rollout = [
  "Start with one provider + one wallet policy + one operator tenant.",
  "Enable signed webhooks and verify signatures before processing events.",
  "Run conformance and closepack verification as release gates.",
  "Add additional providers and policy classes after baseline reliability is stable.",
  "Introduce lifecycle automation (insolvency sweep + unwind + reversal) before scale-up."
];

export default function DocsIntegrationsPage() {
  return (
    <DocsShell
      title="Integrations"
      subtitle="Reference integration patterns for MCP hosts, app backends, and operator systems."
    >
      {surfaces.map((surface) => (
        <article key={surface.title} className="docs-section-card">
          <h2>{surface.title}</h2>
          <p>{surface.copy}</p>
          <div className="mini-code">
            {surface.commands.map((command) => (
              <code key={command}>{command}</code>
            ))}
          </div>
        </article>
      ))}

      <article className="docs-section-card">
        <h2>Production Rollout Sequence</h2>
        <ul className="tight-list">
          {rollout.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </article>
    </DocsShell>
  );
}
