import { useMemo, useState } from "react";

import DocsShell from "./docs/DocsShell.jsx";
import { docsEndpointGroups, docsSections } from "./docs/docsContent.js";

function includesQuery(row, query) {
  const haystack = [row.title, row.summary, ...(Array.isArray(row.tags) ? row.tags : [])].join(" ").toLowerCase();
  return haystack.includes(query);
}

export default function DocsPage() {
  const [query, setQuery] = useState("");

  const q = String(query ?? "").trim().toLowerCase();
  const sectionRows = useMemo(() => {
    if (!q) return docsSections;
    return docsSections.filter((row) => includesQuery(row, q));
  }, [q]);

  const endpointRows = useMemo(() => {
    const all = docsEndpointGroups.flatMap((group) =>
      group.rows.map((row) => ({ ...row, groupTitle: group.title }))
    );
    if (!q) return all;
    return all.filter((row) =>
      `${row.method} ${row.path} ${row.purpose} ${row.groupTitle}`.toLowerCase().includes(q)
    );
  }, [q]);

  return (
    <DocsShell
      title="Build with deterministic economic primitives."
      subtitle="Everything needed to ship production-grade autonomous spend, receipts, and operator control."
    >
      <article className="docs-section-card">
        <h2>Docs Search</h2>
        <p>Search guides, endpoint surfaces, and runbook content.</p>
        <input
          className="docs-search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search docs, endpoints, commands..."
        />
      </article>

      <article className="docs-section-card">
        <h2>Guides</h2>
        <p>Use these as your implementation sequence.</p>
        <div className="docs-card-grid">
          {sectionRows.map((section) => (
            <a key={section.slug} href={section.href} className="docs-ref-card">
              <strong>{section.title}</strong>
              <span>{section.summary}</span>
            </a>
          ))}
          {!sectionRows.length ? <p className="operator-muted">No guide matches that query.</p> : null}
        </div>
      </article>

      <article className="docs-section-card">
        <h2>Endpoint Index</h2>
        <p>High-signal API surface used by production workflows.</p>
        <div className="docs-endpoint-grid">
          {endpointRows.map((row) => (
            <div key={`${row.method}-${row.path}`} className="docs-endpoint-row">
              <code className="docs-method">{row.method}</code>
              <code className="docs-path">{row.path}</code>
              <span>{row.purpose}</span>
            </div>
          ))}
          {!endpointRows.length ? <p className="operator-muted">No endpoint matches that query.</p> : null}
        </div>
      </article>
    </DocsShell>
  );
}

