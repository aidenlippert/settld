import { blendedMonthlyCost, pricingPlans } from "../pricingData.js";

function usd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2
  }).format(value);
}

export default function PricingStrip() {
  const growthBlend = blendedMonthlyCost({
    monthlyBaseUsd: 599,
    settledVolumeUsd: 500000,
    settledFeePercent: 0.45
  });

  return (
    <section id="pricing" className="section-shell section-highlight">
      <div className="section-heading">
        <p className="eyebrow">Pricing</p>
        <h2>SaaS + settled-volume pricing.</h2>
        <p>
          Platform fees are the onramp. Revenue scales with Monthly Verified Settled Value, so incentives align with
          customer outcomes.
        </p>
      </div>
      <div className="price-grid">
        {pricingPlans.map((plan) => (
          <article className={`price-card ${plan.recommended ? "price-card-recommended" : ""}`} key={plan.id}>
            <h3>{plan.name}</h3>
            <p className="price-note">
              {plan.monthlyUsd === null ? "Custom annual" : `${usd(plan.monthlyUsd)} / month`}
            </p>
            <p>{plan.settledFeePercent === null ? "Negotiated volume fee" : `${plan.settledFeePercent}% settled volume fee`}</p>
          </article>
        ))}
      </div>
      <p className="section-linkline">
        <span>
          Growth example: {usd(599)} + 0.45% of {usd(500000)} = <strong>{growthBlend ? usd(growthBlend) : "n/a"}</strong> / month.
        </span>{" "}
        <a className="text-link" href="/pricing">
          Full pricing details
        </a>
      </p>
    </section>
  );
}
