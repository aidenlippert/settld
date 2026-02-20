import PageFrame from "../../components/PageFrame.jsx";
import { docsSections } from "./docsContent.js";

export default function DocsShell({ title, subtitle, children }) {
  return (
    <PageFrame>
      <section className="section-shell page-hero docs-hero">
        <p className="eyebrow">Documentation</p>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </section>

      <section className="section-shell docs-layout">
        <aside className="docs-toc">
          <p className="eyebrow">Sections</p>
          <ul>
            <li>
              <a href="/docs">Overview</a>
            </li>
            {docsSections.map((section) => (
              <li key={section.slug}>
                <a href={section.href}>{section.title}</a>
              </li>
            ))}
          </ul>
        </aside>
        <div className="docs-content">{children}</div>
      </section>
    </PageFrame>
  );
}

