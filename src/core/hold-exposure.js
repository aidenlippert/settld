import { computeExpectedSettlementSplitsV1 } from "./settlement-splits.js";

function clampInt({ value, min, max }) {
  if (!Number.isFinite(value)) return min;
  const n = Math.floor(value);
  if (!Number.isSafeInteger(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeString(v) {
  return typeof v === "string" && v.trim() ? v : null;
}

export function computeHoldExposureV1({ job, eventsBefore = [] } = {}) {
  if (!job || typeof job !== "object") throw new TypeError("job is required");

  const expectedSplits = computeExpectedSettlementSplitsV1({ job, eventsBefore });
  if (!expectedSplits) return null;

  const proofPolicy = job?.booking?.policySnapshot?.proofPolicy ?? null;
  const gateModeRaw = safeString(proofPolicy?.gateMode) ?? "warn";
  const gateMode = gateModeRaw === "strict" || gateModeRaw === "holdback" ? gateModeRaw : "warn";

  const ieb = proofPolicy?.insufficientEvidenceBehavior ?? null;
  const insufficientEvidenceMode = safeString(ieb?.mode) ?? "ALLOW";
  const configuredHoldPercent = clampInt({ value: Number(ieb?.holdPercent ?? 0), min: 0, max: 100 });

  const holdPercent =
    gateMode === "holdback" && insufficientEvidenceMode === "HOLD_PERCENT" ? configuredHoldPercent : gateMode === "warn" ? 0 : 100;

  const heldServiceAmountCents = Math.floor((expectedSplits.serviceAmountCents * holdPercent) / 100);
  const heldCoverageFeeCents = Math.floor((expectedSplits.coverageFeeCents * holdPercent) / 100);
  const heldPlatformFeeCents = Math.floor((expectedSplits.platformFeeCents * holdPercent) / 100);
  const heldOperatorFeeCents = Math.floor((expectedSplits.operatorFeeCents * holdPercent) / 100);
  const heldDeveloperRoyaltiesCents = Math.floor((expectedSplits.developerRoyaltiesCents * holdPercent) / 100);
  const heldInsuranceReserveCents = Math.floor((expectedSplits.insuranceReserveCents * holdPercent) / 100);
  const heldOwnerPayoutCents =
    heldServiceAmountCents - heldPlatformFeeCents - heldOperatorFeeCents - heldDeveloperRoyaltiesCents - heldInsuranceReserveCents;

  return {
    expected: {
      currency: safeString(expectedSplits.currency) ?? "USD",
      amountGrossCents: expectedSplits.amountCents,
      amountNetCents: expectedSplits.serviceAmountCents,
      coverageFeeCents: expectedSplits.coverageFeeCents,
      splits: {
        platformFeeCents: expectedSplits.platformFeeCents,
        ownerPayoutCents: expectedSplits.ownerPayoutCents,
        operatorFeeCents: expectedSplits.operatorFeeCents,
        developerRoyaltiesCents: expectedSplits.developerRoyaltiesCents,
        insuranceReserveCents: expectedSplits.insuranceReserveCents
      }
    },
    holdPolicy: {
      gateMode,
      insufficientEvidenceMode,
      holdPercent
    },
    held: {
      currency: safeString(expectedSplits.currency) ?? "USD",
      amountGrossCents: heldServiceAmountCents + heldCoverageFeeCents,
      amountNetCents: heldServiceAmountCents,
      coverageFeeCents: heldCoverageFeeCents,
      splits: {
        platformFeeCents: heldPlatformFeeCents,
        ownerPayoutCents: heldOwnerPayoutCents,
        operatorFeeCents: heldOperatorFeeCents,
        developerRoyaltiesCents: heldDeveloperRoyaltiesCents,
        insuranceReserveCents: heldInsuranceReserveCents
      }
    }
  };
}

