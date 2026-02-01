import { ENV_TIER } from "./booking.js";

export function computeSlaPolicy({ environmentTier } = {}) {
  const maxStallMs =
    environmentTier === ENV_TIER.ENV_IN_HOME
      ? 5 * 60_000
      : environmentTier === ENV_TIER.ENV_HOSPITALITY
        ? 10 * 60_000
        : environmentTier === ENV_TIER.ENV_OFFICE_AFTER_HOURS
          ? 10 * 60_000
          : 10 * 60_000;

  const maxExecutionMs =
    environmentTier === ENV_TIER.ENV_IN_HOME
      ? 90 * 60_000
      : environmentTier === ENV_TIER.ENV_HOSPITALITY
        ? 90 * 60_000
        : environmentTier === ENV_TIER.ENV_OFFICE_AFTER_HOURS
          ? 120 * 60_000
          : 120 * 60_000;

  return {
    slaVersion: 1,
    mustStartWithinWindow: true,
    maxStallMs,
    maxExecutionMs
  };
}

