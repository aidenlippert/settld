import { sumSkillLicenseFeesCents } from "./skills.js";

function assertSafeInteger(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

export function computeSettlementSplitsV1({ amountCents, coverageFeeCents, hadAssist, developerRoyaltiesCents }) {
  assertSafeInteger(amountCents, "amountCents");
  assertSafeInteger(coverageFeeCents, "coverageFeeCents");
  if (coverageFeeCents < 0) throw new TypeError("coverageFeeCents must be >= 0");
  if (coverageFeeCents > amountCents) throw new TypeError("coverageFeeCents exceeds amountCents");
  assertSafeInteger(developerRoyaltiesCents, "developerRoyaltiesCents");

  const serviceAmountCents = amountCents - coverageFeeCents;

  const platformFeeCents = Math.floor(serviceAmountCents * 0.2);
  const insuranceReserveCents = Math.floor(serviceAmountCents * 0.02);
  const operatorFeeCents = hadAssist ? Math.floor(serviceAmountCents * 0.05) : 0;
  const ownerPayoutCents = serviceAmountCents - platformFeeCents - operatorFeeCents - developerRoyaltiesCents - insuranceReserveCents;
  if (ownerPayoutCents < 0) {
    throw new TypeError("settlement splits invalid: owner payout would be negative");
  }

  return {
    amountCents,
    serviceAmountCents,
    coverageFeeCents,
    platformFeeCents,
    ownerPayoutCents,
    operatorFeeCents,
    developerRoyaltiesCents,
    insuranceReserveCents
  };
}

export function computeExpectedSettlementSplitsV1({ job, eventsBefore = [] } = {}) {
  if (!job || typeof job !== "object") throw new TypeError("job is required");
  const amountCents = job?.quote?.amountCents ?? null;
  if (!Number.isSafeInteger(amountCents)) return null;
  const currency = typeof job?.quote?.currency === "string" && job.quote.currency.trim() ? job.quote.currency : "USD";
  const coverageFeeCentsRaw = job?.quote?.breakdown?.coverageFeeCents ?? 0;
  const coverageFeeCents = Number.isSafeInteger(coverageFeeCentsRaw) && coverageFeeCentsRaw >= 0 ? coverageFeeCentsRaw : 0;
  const hadAssist = Array.isArray(eventsBefore) && eventsBefore.some((e) => e?.type === "ASSIST_STARTED");
  const developerRoyaltiesCents = sumSkillLicenseFeesCents(job?.skillLicenses ?? []);
  return { currency, ...computeSettlementSplitsV1({ amountCents, coverageFeeCents, hadAssist, developerRoyaltiesCents }) };
}
