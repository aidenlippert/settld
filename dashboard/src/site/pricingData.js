export const pricingPlans = [
  {
    id: "free",
    name: "Free",
    monthlyUsd: 0,
    settledFeePercent: 0,
    includes: [
      "Developer sandbox and local conformance",
      "Offline verify and closepack export",
      "Community support"
    ]
  },
  {
    id: "builder",
    name: "Builder",
    monthlyUsd: 99,
    settledFeePercent: 0.75,
    includes: [
      "Early production onboarding",
      "API and webhook integrations",
      "Email support"
    ],
    recommended: false
  },
  {
    id: "growth",
    name: "Growth",
    monthlyUsd: 599,
    settledFeePercent: 0.45,
    includes: [
      "Higher throughput and ops workflows",
      "Priority support and launch guidance",
      "Policy controls and dispute operations"
    ],
    recommended: true
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyUsd: null,
    settledFeePercent: null,
    includes: [
      "Custom annual contracts",
      "Negotiated volume pricing",
      "Security, procurement, and dedicated rollout support"
    ]
  }
];

export const valueEventPricing = [
  "Verified runs: $0.01/run (Builder), $0.007/run (Growth)",
  "Arbitration cases: $2/case (Builder), $1/case (Growth)"
];

export function blendedMonthlyCost({ monthlyBaseUsd, settledVolumeUsd, settledFeePercent }) {
  if (!Number.isFinite(monthlyBaseUsd) || !Number.isFinite(settledVolumeUsd) || !Number.isFinite(settledFeePercent)) {
    return null;
  }
  const fee = settledVolumeUsd * (settledFeePercent / 100);
  return Math.round((monthlyBaseUsd + fee) * 100) / 100;
}
