import { useMemo, useState } from "react";

import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Input } from "../components/ui/input.jsx";
import DocsShell from "./docs/DocsShell.jsx";
import { docsEndpointGroups, docsSections } from "./docs/docsContent.js";

const rolePaths = [
  {
    title: "I want to plug into an agent host",
    copy: "Use MCP and host-specific integration guidance for Codex, Claude, Cursor, and OpenClaw.",
    href: "/docs/integrations",
    badge: "MCP"
  },
  {
    title: "I want to run the first verified flow",
    copy: "Bring up runtime, execute first bounded action, and verify evidence offline.",
    href: "/docs/quickstart",
    badge: "Quickstart"
  },
  {
    title: "I need security and operations controls",
    copy: "Review trust boundaries, key rotation, incident modes, and production runbooks.",
    href: "/docs/security",
    badge: "Security"
  }
];

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
    return all.filter((row) => `${row.method} ${row.path} ${row.purpose} ${row.groupTitle}`.toLowerCase().includes(q));
  }, [q]);

  return (
    <DocsShell
      title="Documentation that gets teams to production."
      subtitle="Pick a path, run the integration, and harden controls with deterministic verification."
    >
      <article className="docs-section-card">
        <h2>Start by Goal</h2>
        <p>Choose the exact path you need instead of reading docs linearly.</p>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {rolePaths.map((path) => (
            <Card key={path.title}>
              <CardHeader>
                <Badge variant="accent" className="w-fit">{path.badge}</Badge>
                <CardTitle className="text-xl leading-snug">{path.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed text-[#354152]">{path.copy}</p>
                <a className="mt-4 inline-block font-semibold text-[#7f2f1f]" href={path.href}>Open path</a>
              </CardContent>
            </Card>
          ))}
        </div>
      </article>

      <article className="docs-section-card">
        <h2>Docs Search</h2>
        <p>Search guides, endpoint surfaces, and runbook content.</p>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search docs, endpoints, commands..."
          className="docs-search-input"
        />
      </article>

      <article className="docs-section-card">
        <h2>Guides</h2>
        <p>Structured references across architecture, integrations, API, security, and operations.</p>
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
