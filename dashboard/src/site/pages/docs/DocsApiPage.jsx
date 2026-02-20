import DocsShell from "./DocsShell.jsx";
import { docsEndpointGroups } from "./docsContent.js";

export default function DocsApiPage() {
  return (
    <DocsShell
      title="API Reference"
      subtitle="Core control-plane and settlement endpoints used in production autonomous spend flows."
    >
      {docsEndpointGroups.map((group) => (
        <article key={group.title} className="docs-section-card">
          <h2>{group.title}</h2>
          <div className="docs-endpoint-grid">
            {group.rows.map((row) => (
              <div key={`${row.method}-${row.path}`} className="docs-endpoint-row">
                <code className="docs-method">{row.method}</code>
                <code className="docs-path">{row.path}</code>
                <span>{row.purpose}</span>
              </div>
            ))}
          </div>
        </article>
      ))}

      <article className="docs-section-card">
        <h2>Request Contract Patterns</h2>
        <ul className="tight-list">
          <li>Always pass tenant context and deterministic idempotency keys.</li>
          <li>Treat quote hash + request hash as first-class settlement inputs.</li>
          <li>Return structured reason codes for every non-success path.</li>
        </ul>
      </article>

      <article className="docs-section-card">
        <h2>API Integration Guardrails</h2>
        <ul className="tight-list">
          <li>Use idempotency keys for all authorize/execute paths.</li>
          <li>Treat receipt snapshots as immutable facts; append events only.</li>
          <li>Use cursor pagination for reads/exports to avoid reconciliation drift.</li>
          <li>Verify signatures and key identifiers before settlement progression.</li>
        </ul>
      </article>
    </DocsShell>
  );
}
