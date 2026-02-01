import { ENV_TIER } from "./booking.js";

const BASE_PRICE_CENTS_BY_TEMPLATE = new Map([
  ["reset_lite", 6500],
  ["reset_standard", 9500]
]);

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertSafeInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

function computeRiskPremiumCents(environmentTier) {
  if (environmentTier === ENV_TIER.ENV_IN_HOME) return 1200;
  if (environmentTier === ENV_TIER.ENV_HOSPITALITY) return 400;
  if (environmentTier === ENV_TIER.ENV_OFFICE_AFTER_HOURS) return 200;
  return 0;
}

function computeSurgeCents({ baseCents, availableRobots }) {
  assertSafeInt(baseCents, "baseCents");
  assertSafeInt(availableRobots, "availableRobots");
  if (availableRobots <= 0) return 0;
  if (availableRobots === 1) return Math.floor(baseCents * 0.1);
  return 0;
}

export function computeQuote({
  templateId,
  currency = "USD",
  environmentTier,
  requiresOperatorCoverage = false,
  coverageFeeCents = 0,
  availableRobots,
  activeOperators
}) {
  assertNonEmptyString(templateId, "templateId");
  assertNonEmptyString(currency, "currency");
  assertSafeInt(coverageFeeCents, "coverageFeeCents");
  if (coverageFeeCents < 0) throw new TypeError("coverageFeeCents must be >= 0");
  assertSafeInt(availableRobots, "availableRobots");
  assertSafeInt(activeOperators, "activeOperators");

  const baseCents = BASE_PRICE_CENTS_BY_TEMPLATE.get(templateId) ?? 5000;
  const riskPremiumCents = computeRiskPremiumCents(environmentTier);
  const operatorCoverageCents = requiresOperatorCoverage ? 500 : 0;
  const surgeCents = computeSurgeCents({ baseCents, availableRobots });

  const amountCents = baseCents + riskPremiumCents + operatorCoverageCents + surgeCents + coverageFeeCents;

  return {
    pricingVersion: 1,
    currency,
    amountCents,
    breakdown: {
      baseCents,
      riskPremiumCents,
      operatorCoverageCents,
      surgeCents,
      coverageFeeCents,
      totalCents: amountCents
    },
    supplySnapshot: {
      availableRobots,
      activeOperators
    }
  };
}
