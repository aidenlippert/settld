import { blendedMonthlyCost, pricingPlans, valueEventPricing } from "./pricingData.js";

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2
  }).format(value);
}

export default function PricingPage() {
  const growthExample = blendedMonthlyCost({
    monthlyBaseUsd: 599,
    settledVolumeUsd: 500000,
    settledFeePercent: 0.45
  });

  return (
    <div className="site-root">
      <div className="site-bg-grid" aria-hidden="true" />
      <div className="site-bg-glow" aria-hidden="true" />
      <main className="section-shell">
        <section className="section-highlight pricing-hero">
          <p className="eyebrow">Pricing</p>
          <h1>Pricing that scales with settled value.</h1>
          <p className="hero-sub">
            Subscription covers platform access. Revenue scales with settled volume, so pricing aligns with money
            movement and dispute exposure.
          </p>
          <div className="hero-actions">
            <a className="btn btn-solid" href="/#quickstart">
              Start building
            </a>
            <a className="btn btn-ghost" href="/">
              Back to homepage
            </a>
          </div>
        </section>

        <section className="section-shell">
          <div className="price-grid">
            {pricingPlans.map((plan) => (
              <article key={plan.id} className={`price-card ${plan.recommended ? "price-card-recommended" : ""}`}>
                <p className="eyebrow">{plan.recommended ? "Most common" : "Plan"}</p>
                <h2>{plan.name}</h2>
                <p className="price-note">
                  {plan.monthlyUsd === null ? "Custom annual contract" : `${money(plan.monthlyUsd)} / month`}
                </p>
                <p>
                  {plan.settledFeePercent === null
                    ? "Negotiated settled-volume fee."
                    : `${plan.settledFeePercent}% settled-volume fee.`}
                </p>
                <ul className="tight-list">
                  {plan.includes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="section-shell split-section">
          <article className="panel panel-strong">
            <p className="eyebrow">Worked Example</p>
            <h2>Growth at $500k settled volume/month</h2>
            <p>
              {money(599)} base + {money(2250)} volume fee = <strong>{growthExample ? money(growthExample) : "n/a"}</strong>{" "}
              blended monthly.
            </p>
            <p className="hero-note">This matches the economics in your planning docs for growth-stage accounts.</p>
          </article>
          <article className="panel">
            <p className="eyebrow">Value Event Pricing</p>
            <h3>Metered line items</h3>
            <ul className="tight-list">
              {valueEventPricing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="hero-note">Invoices expose these as explicit line items for audit and reconciliation.</p>
          </article>
        </section>
      </main>
    </div>
  );
}
