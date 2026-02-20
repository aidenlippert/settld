import PageFrame from "../components/PageFrame.jsx";

const principles = [
  "Agents act under delegated sponsor authority",
  "Trust is evidence, not intent",
  "Settlement must be durable and independently verifiable",
  "Scale should come from standards and wrappers, not bespoke glue"
];

export default function CompanyPage() {
  return (
    <PageFrame>
      <section className="section-shell page-hero">
        <p className="eyebrow">Company</p>
        <h1>We are building the economic execution layer for AI.</h1>
        <p>
          The next decade of software will be autonomous systems spending money, buying services, and coordinating
          real work. Settld is the trust and settlement substrate behind that economy.
        </p>
        <div className="hero-actions">
          <a className="btn btn-solid" href="/docs/ops">Operations docs</a>
          <a className="btn btn-ghost" href="/pricing">Pricing</a>
        </div>
      </section>

      <section className="section-shell">
        <div className="statement-grid">
          {principles.map((principle) => (
            <article key={principle} className="statement-card">
              <p>{principle}</p>
            </article>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}
