import { ENV_TIER } from "./booking.js";

export const RISK_BASIS = Object.freeze({
  QUOTE: "QUOTE",
  BOOK: "BOOK"
});

const BASES = new Set(Object.values(RISK_BASIS));
const ENV_TIERS = new Set(Object.values(ENV_TIER));

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertSafeInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

function assertNullableNonEmptyString(value, name) {
  if (value === null || value === undefined) return;
  assertNonEmptyString(value, name);
}

function clampInt(value, { min, max }) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampBps(value) {
  return clampInt(value, { min: 0, max: 10_000 });
}

function envBaseRiskScore(environmentTier) {
  if (environmentTier === ENV_TIER.ENV_IN_HOME) return 70;
  if (environmentTier === ENV_TIER.ENV_HOSPITALITY) return 45;
  if (environmentTier === ENV_TIER.ENV_OFFICE_AFTER_HOURS) return 35;
  return 20;
}

function envBaseIncidentProbabilityBps(environmentTier) {
  if (environmentTier === ENV_TIER.ENV_IN_HOME) return 1200;
  if (environmentTier === ENV_TIER.ENV_HOSPITALITY) return 800;
  if (environmentTier === ENV_TIER.ENV_OFFICE_AFTER_HOURS) return 500;
  return 200;
}

function envBaseAssistSeconds(environmentTier) {
  if (environmentTier === ENV_TIER.ENV_IN_HOME) return 240;
  if (environmentTier === ENV_TIER.ENV_HOSPITALITY) return 150;
  if (environmentTier === ENV_TIER.ENV_OFFICE_AFTER_HOURS) return 120;
  return 90;
}

export function validateRiskScoredPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set([
    "jobId",
    "basis",
    "scoredAt",
    "sourceEventId",
    "modelVersion",
    "riskScore",
    "expectedAssistSeconds",
    "expectedIncidentProbabilityBps",
    "expectedCreditBurnRateCents",
    "currency",
    "policyHash",
    "features"
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.basis, "payload.basis");
  if (!BASES.has(payload.basis)) throw new TypeError("payload.basis is not supported");
  assertNonEmptyString(payload.scoredAt, "payload.scoredAt");
  if (!Number.isFinite(Date.parse(payload.scoredAt))) throw new TypeError("payload.scoredAt must be an ISO date string");
  assertNonEmptyString(payload.sourceEventId, "payload.sourceEventId");

  assertSafeInt(payload.modelVersion, "payload.modelVersion");
  if (payload.modelVersion <= 0) throw new TypeError("payload.modelVersion must be > 0");

  assertSafeInt(payload.riskScore, "payload.riskScore");
  if (payload.riskScore < 0 || payload.riskScore > 100) throw new TypeError("payload.riskScore must be within 0..100");

  assertSafeInt(payload.expectedAssistSeconds, "payload.expectedAssistSeconds");
  if (payload.expectedAssistSeconds < 0) throw new TypeError("payload.expectedAssistSeconds must be >= 0");

  assertSafeInt(payload.expectedIncidentProbabilityBps, "payload.expectedIncidentProbabilityBps");
  if (payload.expectedIncidentProbabilityBps < 0 || payload.expectedIncidentProbabilityBps > 10_000) {
    throw new TypeError("payload.expectedIncidentProbabilityBps must be within 0..10000");
  }

  assertSafeInt(payload.expectedCreditBurnRateCents, "payload.expectedCreditBurnRateCents");
  if (payload.expectedCreditBurnRateCents < 0) throw new TypeError("payload.expectedCreditBurnRateCents must be >= 0");

  assertNonEmptyString(payload.currency, "payload.currency");
  if (payload.currency !== "USD") throw new TypeError("payload.currency is not supported");

  if (payload.policyHash !== undefined && payload.policyHash !== null) assertNonEmptyString(payload.policyHash, "payload.policyHash");

  assertPlainObject(payload.features, "payload.features");
  const featuresAllowed = new Set([
    "templateId",
    "environmentTier",
    "requiresOperatorCoverage",
    "zoneId",
    "siteId",
    "customerId",
    "availableRobots",
    "activeOperators",
    "avgAvailableRobotTrustScoreBps",
    "historyWindowDays",
    "historySampleJobs",
    "historyIncidentRateBps",
    "historyStallRateBps",
    "historyAvgAssistSeconds",
    "historyAvgCreditCents",
    "historyAvgClaimsPaidCents"
  ]);
  for (const key of Object.keys(payload.features)) {
    if (!featuresAllowed.has(key)) throw new TypeError(`payload.features contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.features.templateId, "payload.features.templateId");
  assertNonEmptyString(payload.features.environmentTier, "payload.features.environmentTier");
  if (!ENV_TIERS.has(payload.features.environmentTier)) throw new TypeError("payload.features.environmentTier is not supported");
  if (typeof payload.features.requiresOperatorCoverage !== "boolean") {
    throw new TypeError("payload.features.requiresOperatorCoverage must be a boolean");
  }
  assertNullableNonEmptyString(payload.features.zoneId, "payload.features.zoneId");
  assertNullableNonEmptyString(payload.features.siteId, "payload.features.siteId");
  assertNullableNonEmptyString(payload.features.customerId, "payload.features.customerId");

  assertSafeInt(payload.features.availableRobots, "payload.features.availableRobots");
  if (payload.features.availableRobots < 0) throw new TypeError("payload.features.availableRobots must be >= 0");
  assertSafeInt(payload.features.activeOperators, "payload.features.activeOperators");
  if (payload.features.activeOperators < 0) throw new TypeError("payload.features.activeOperators must be >= 0");

  assertSafeInt(payload.features.avgAvailableRobotTrustScoreBps, "payload.features.avgAvailableRobotTrustScoreBps");
  if (payload.features.avgAvailableRobotTrustScoreBps < 0 || payload.features.avgAvailableRobotTrustScoreBps > 10_000) {
    throw new TypeError("payload.features.avgAvailableRobotTrustScoreBps must be within 0..10000");
  }

  assertSafeInt(payload.features.historyWindowDays, "payload.features.historyWindowDays");
  if (payload.features.historyWindowDays <= 0) throw new TypeError("payload.features.historyWindowDays must be > 0");
  assertSafeInt(payload.features.historySampleJobs, "payload.features.historySampleJobs");
  if (payload.features.historySampleJobs < 0) throw new TypeError("payload.features.historySampleJobs must be >= 0");
  assertSafeInt(payload.features.historyIncidentRateBps, "payload.features.historyIncidentRateBps");
  if (payload.features.historyIncidentRateBps < 0 || payload.features.historyIncidentRateBps > 10_000) {
    throw new TypeError("payload.features.historyIncidentRateBps must be within 0..10000");
  }
  assertSafeInt(payload.features.historyStallRateBps, "payload.features.historyStallRateBps");
  if (payload.features.historyStallRateBps < 0 || payload.features.historyStallRateBps > 10_000) {
    throw new TypeError("payload.features.historyStallRateBps must be within 0..10000");
  }
  assertSafeInt(payload.features.historyAvgAssistSeconds, "payload.features.historyAvgAssistSeconds");
  if (payload.features.historyAvgAssistSeconds < 0) throw new TypeError("payload.features.historyAvgAssistSeconds must be >= 0");
  assertSafeInt(payload.features.historyAvgCreditCents, "payload.features.historyAvgCreditCents");
  if (payload.features.historyAvgCreditCents < 0) throw new TypeError("payload.features.historyAvgCreditCents must be >= 0");
  assertSafeInt(payload.features.historyAvgClaimsPaidCents, "payload.features.historyAvgClaimsPaidCents");
  if (payload.features.historyAvgClaimsPaidCents < 0) throw new TypeError("payload.features.historyAvgClaimsPaidCents must be >= 0");

  return payload;
}

function computeHistoryFeatures({
  jobs,
  getEventsForJob,
  templateId,
  siteId,
  zoneId,
  nowIso,
  historyWindowDays
}) {
  const nowMs = Date.parse(nowIso());
  const windowMs = historyWindowDays * 24 * 60 * 60_000;
  const sinceMs = Number.isFinite(nowMs) ? nowMs - windowMs : Date.now() - windowMs;

  let sampleJobs = 0;
  let incidents = 0;
  let stalledJobs = 0;
  let assistSecondsTotal = 0;
  let creditsCentsTotal = 0;
  let claimsPaidCentsTotal = 0;

  for (const j of jobs) {
    if (!j?.id) continue;
    if (templateId && j.templateId !== templateId) continue;
    const jSiteId = j.booking?.siteId ?? j.siteId ?? null;
    const jZoneId = j.booking?.zoneId ?? j.constraints?.zoneId ?? null;
    if (siteId !== null && siteId !== undefined) {
      if (jSiteId !== siteId) continue;
    } else if (zoneId !== null && zoneId !== undefined) {
      if (jZoneId !== zoneId) continue;
    }

    const events = getEventsForJob(j.id);
    if (!Array.isArray(events) || events.length === 0) continue;
    const settled = events.findLast?.((e) => e?.type === "SETTLED") ?? (() => {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i]?.type === "SETTLED") return events[i];
      }
      return null;
    })();
    const settledAt = settled?.at ?? null;
    const settledMs = settledAt ? Date.parse(settledAt) : NaN;
    if (!Number.isFinite(settledMs)) continue;
    if (settledMs < sinceMs) continue;

    sampleJobs += 1;

    // Incidents
    const incidentCount = events.filter((e) => e?.type === "INCIDENT_REPORTED" || e?.type === "INCIDENT_DETECTED").length;
    incidents += incidentCount;

    // Stalls (count jobs with at least one stall event)
    if (events.some((e) => e?.type === "JOB_EXECUTION_STALLED")) stalledJobs += 1;

    // Operator cost recorded (assistSeconds)
    for (const e of events) {
      if (e?.type === "OPERATOR_COST_RECORDED") {
        const s = e.payload?.assistSeconds ?? 0;
        if (Number.isSafeInteger(s) && s > 0) assistSecondsTotal += s;
      }
      if (e?.type === "SLA_CREDIT_ISSUED") {
        const cents = e.payload?.amountCents ?? 0;
        if (Number.isSafeInteger(cents) && cents > 0) creditsCentsTotal += cents;
      }
      if (e?.type === "CLAIM_PAID") {
        const cents = e.payload?.amountCents ?? 0;
        if (Number.isSafeInteger(cents) && cents > 0) claimsPaidCentsTotal += cents;
      }
    }
  }

  const incidentRateBps = sampleJobs > 0 ? clampBps((incidents / sampleJobs) * 10000) : 0;
  const stallRateBps = sampleJobs > 0 ? clampBps((stalledJobs / sampleJobs) * 10000) : 0;
  const avgAssistSeconds = sampleJobs > 0 ? clampInt(assistSecondsTotal / sampleJobs, { min: 0, max: 60 * 60 }) : 0;
  const avgCreditCents = sampleJobs > 0 ? clampInt(creditsCentsTotal / sampleJobs, { min: 0, max: 1_000_000 }) : 0;
  const avgClaimsPaidCents = sampleJobs > 0 ? clampInt(claimsPaidCentsTotal / sampleJobs, { min: 0, max: 50_000_000 }) : 0;

  return {
    historyWindowDays,
    historySampleJobs: sampleJobs,
    historyIncidentRateBps: incidentRateBps,
    historyStallRateBps: stallRateBps,
    historyAvgAssistSeconds: avgAssistSeconds,
    historyAvgCreditCents: avgCreditCents,
    historyAvgClaimsPaidCents: avgClaimsPaidCents
  };
}

export function computeRiskAssessment({
  basis,
  templateId,
  environmentTier,
  requiresOperatorCoverage,
  zoneId = null,
  siteId = null,
  customerId = null,
  availableRobots,
  activeOperators,
  avgAvailableRobotTrustScoreBps,
  creditPolicy,
  policyHash = null,
  jobs,
  getEventsForJob,
  nowIso,
  historyWindowDays = 30
} = {}) {
  assertNonEmptyString(basis, "basis");
  if (!BASES.has(basis)) throw new TypeError("unsupported risk basis");
  assertNonEmptyString(templateId, "templateId");
  assertNonEmptyString(environmentTier, "environmentTier");
  if (!ENV_TIERS.has(environmentTier)) throw new TypeError("unsupported environmentTier");
  if (typeof requiresOperatorCoverage !== "boolean") throw new TypeError("requiresOperatorCoverage must be a boolean");
  assertSafeInt(availableRobots, "availableRobots");
  assertSafeInt(activeOperators, "activeOperators");
  assertSafeInt(avgAvailableRobotTrustScoreBps, "avgAvailableRobotTrustScoreBps");
  if (avgAvailableRobotTrustScoreBps < 0 || avgAvailableRobotTrustScoreBps > 10_000) {
    throw new TypeError("avgAvailableRobotTrustScoreBps must be within 0..10000");
  }
  assertPlainObject(creditPolicy, "creditPolicy");
  assertNullableNonEmptyString(policyHash, "policyHash");
  if (!Array.isArray(jobs)) throw new TypeError("jobs must be an array");
  if (typeof getEventsForJob !== "function") throw new TypeError("getEventsForJob must be a function");
  if (typeof nowIso !== "function") throw new TypeError("nowIso must be a function");
  assertSafeInt(historyWindowDays, "historyWindowDays");
  if (historyWindowDays <= 0) throw new TypeError("historyWindowDays must be > 0");

  const history = computeHistoryFeatures({ jobs, getEventsForJob, templateId, siteId, zoneId, nowIso, historyWindowDays });

  const avgTrustPenalty = ((10_000 - avgAvailableRobotTrustScoreBps) / 10_000) * 30;
  const lowSupplyPenalty = availableRobots <= 1 ? 10 : availableRobots <= 2 ? 5 : 0;

  const historyIncidentPenalty = (history.historyIncidentRateBps / 10_000) * 40;
  const historyStallPenalty = (history.historyStallRateBps / 10_000) * 20;
  const historyAssistPenalty = (history.historyAvgAssistSeconds / 60) * 2;
  const historyClaimsPenalty = (history.historyAvgClaimsPaidCents / 10_000) * 5;

  let riskScore =
    envBaseRiskScore(environmentTier) +
    avgTrustPenalty +
    lowSupplyPenalty +
    historyIncidentPenalty +
    historyStallPenalty +
    historyAssistPenalty +
    historyClaimsPenalty;

  if (requiresOperatorCoverage) {
    // Coverage reduces service delivery risk a bit (more likely to complete), but increases cost exposure.
    riskScore -= 3;
  }

  riskScore = clampInt(riskScore, { min: 0, max: 100 });

  // Expected assist seconds (rough heuristic).
  const expectedAssistSeconds = clampInt(
    envBaseAssistSeconds(environmentTier) +
      ((10_000 - avgAvailableRobotTrustScoreBps) / 10_000) * 180 +
      history.historyAvgAssistSeconds * 0.5,
    { min: 0, max: 2 * 60 * 60 }
  );

  const expectedIncidentProbabilityBps = clampBps(
    envBaseIncidentProbabilityBps(environmentTier) +
      (history.historyIncidentRateBps * 0.5) +
      (history.historyStallRateBps * 0.2) +
      ((10_000 - avgAvailableRobotTrustScoreBps) / 10_000) * 500 +
      (availableRobots <= 1 ? 100 : 0)
  );

  const creditEnabled = creditPolicy?.enabled === true;
  const defaultCreditCents = Number.isSafeInteger(creditPolicy?.defaultAmountCents) ? creditPolicy.defaultAmountCents : 0;
  const maxCreditCents = Number.isSafeInteger(creditPolicy?.maxAmountCents) ? creditPolicy.maxAmountCents : 0;
  const boundedCreditCents =
    maxCreditCents > 0 ? Math.min(defaultCreditCents, maxCreditCents) : defaultCreditCents;

  // Expected credit burn is the expected value, not a guarantee.
  const expectedCreditProbabilityBps = clampBps(
    creditEnabled
      ? (history.historyAvgCreditCents > 0 && boundedCreditCents > 0)
          ? clampBps((history.historyAvgCreditCents / boundedCreditCents) * 10_000)
          : clampBps(expectedIncidentProbabilityBps * 0.35 + history.historyStallRateBps * 0.15)
      : 0
  );
  const expectedCreditBurnRateCents = creditEnabled && boundedCreditCents > 0 ? clampInt((boundedCreditCents * expectedCreditProbabilityBps) / 10_000, { min: 0, max: 1_000_000 }) : 0;

  const modelVersion = 1;
  const features = {
    templateId,
    environmentTier,
    requiresOperatorCoverage,
    zoneId: zoneId ?? null,
    siteId: siteId ?? null,
    customerId: customerId ?? null,
    availableRobots,
    activeOperators,
    avgAvailableRobotTrustScoreBps,
    ...history
  };

  return {
    modelVersion,
    riskScore,
    expectedAssistSeconds,
    expectedIncidentProbabilityBps,
    expectedCreditBurnRateCents,
    currency: "USD",
    policyHash: policyHash ?? null,
    features
  };
}

