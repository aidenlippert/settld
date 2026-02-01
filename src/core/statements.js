import { reduceJob } from "./job-reducer.js";
import { CREDIT_FUNDING_MODEL } from "./contracts.js";
import { JOB_STATUS } from "./job-state-machine.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertNullableString(value, name) {
  if (value === null || value === undefined) return;
  assertNonEmptyString(value, name);
}

function assertSafeCents(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer (cents)`);
}

export function parseYearMonth(month) {
  assertNonEmptyString(month, "month");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError("month must be in YYYY-MM format");
  const [y, m] = month.split("-").map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) throw new TypeError("month must be a valid YYYY-MM");

  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function findLastEvent(events, type) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === type) return e;
  }
  return null;
}

function findLastEventIndex(events, type) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === type) return i;
  }
  return -1;
}

function findFirstEvent(events, type) {
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (e?.type === type) return e;
  }
  return null;
}

function sumCents(values) {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) continue;
    total += v;
  }
  return total;
}

function safeIntPercent(value, fallback = 0) {
  if (!Number.isSafeInteger(value)) return fallback;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function getProofGateMode(job) {
  const raw = job?.booking?.policySnapshot?.proofPolicy?.gateMode ?? null;
  const v = typeof raw === "string" ? raw : "warn";
  return v === "strict" || v === "holdback" ? v : "warn";
}

function findLatestCompletionChainHash(events, { beforeIndex }) {
  const end = Number.isSafeInteger(beforeIndex) ? beforeIndex : events.length;
  for (let i = Math.min(end, events.length) - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== "EXECUTION_COMPLETED" && e?.type !== "JOB_EXECUTION_COMPLETED") continue;
    const ch = typeof e?.chainHash === "string" ? e.chainHash.trim() : "";
    if (ch) return ch;
  }
  return null;
}

function findLatestProofStatusForAnchor(events, { beforeIndex, evaluatedAtChainHash }) {
  const end = Number.isSafeInteger(beforeIndex) ? beforeIndex : events.length;
  if (typeof evaluatedAtChainHash !== "string" || !evaluatedAtChainHash.trim()) return null;
  for (let i = Math.min(end, events.length) - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== "PROOF_EVALUATED") continue;
    if (e?.payload?.evaluatedAtChainHash !== evaluatedAtChainHash) continue;
    const status = typeof e?.payload?.status === "string" ? e.payload.status : null;
    if (status) return status;
  }
  return null;
}

function accountBalanceAt(ledgerEntries, { accountId, atMs }) {
  if (!Array.isArray(ledgerEntries)) return null;
  if (typeof accountId !== "string" || accountId.trim() === "") return null;
  if (!Number.isFinite(atMs)) return null;
  let sum = 0;
  for (const entry of ledgerEntries) {
    if (!entry?.postings || !entry?.at) continue;
    const t = Date.parse(entry.at);
    if (!Number.isFinite(t) || t >= atMs) continue;
    for (const p of entry.postings) {
      if (p?.accountId !== accountId) continue;
      if (!Number.isSafeInteger(p.amountCents)) continue;
      sum += p.amountCents;
    }
  }
  return sum;
}

function toCsvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export function statementToCsv(statement) {
  if (!statement || typeof statement !== "object") throw new TypeError("statement is required");
  const rows = Array.isArray(statement.jobs) ? statement.jobs : [];

  const headers = [
    "jobId",
    "customerId",
    "siteId",
    "templateId",
    "zoneId",
    "environmentTier",
    "bookedAt",
    "settledAt",
    "amountCents",
    "slaCreditsCents",
    "claimsPaidCents",
    "operatorCostCents",
    "incidentsCount",
    "slaBreachesCount",
    "ledgerEntryIds",
    "riskScore",
    "expectedIncidentProbabilityBps",
    "expectedAssistSeconds",
    "expectedCreditBurnRateCents",
    "coverageTierId",
    "coverageFeeCents",
    "creditFundingModel",
    "coverageRevenueEarnedCents",
    "coverageReserveFundedCents",
    "creditsFromCoverageReserveCents",
    "creditsFromPlatformExpenseCents",
    "creditsFromOperatorChargebackCents",
    "creditsFromInsurerRecoverableCents"
  ];

  const lines = [];
  lines.push(headers.join(","));
  for (const job of rows) {
    const entryIds = job?.ledgerEntryIds ? JSON.stringify(job.ledgerEntryIds) : "";
    const line = [
      job?.jobId ?? "",
      job?.customerId ?? "",
      job?.siteId ?? "",
      job?.templateId ?? "",
      job?.zoneId ?? "",
      job?.environmentTier ?? "",
      job?.bookedAt ?? "",
      job?.settledAt ?? "",
      job?.amountCents ?? 0,
      job?.slaCreditsCents ?? 0,
      job?.claimsPaidCents ?? 0,
      job?.operatorCostCents ?? 0,
      job?.incidentsCount ?? 0,
      job?.slaBreachesCount ?? 0,
      entryIds,
      job?.riskScore ?? 0,
      job?.expectedIncidentProbabilityBps ?? 0,
      job?.expectedAssistSeconds ?? 0,
      job?.expectedCreditBurnRateCents ?? 0,
      job?.coverageTierId ?? "",
      job?.coverageFeeCents ?? 0,
      job?.creditFundingModel ?? "",
      job?.coverageRevenueEarnedCents ?? 0,
      job?.coverageReserveFundedCents ?? 0,
      job?.creditsFromCoverageReserveCents ?? 0,
      job?.creditsFromPlatformExpenseCents ?? 0,
      job?.creditsFromOperatorChargebackCents ?? 0,
      job?.creditsFromInsurerRecoverableCents ?? 0
    ]
      .map(toCsvCell)
      .join(",");
    lines.push(line);
  }

  return lines.join("\n") + "\n";
}

export function computeMonthlyStatement({
  tenantId,
  customerId = null,
  siteId = null,
  month,
  jobs,
  getEventsForJob,
  ledgerEntries = null,
  nowIso = () => new Date().toISOString()
} = {}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNullableString(customerId, "customerId");
  assertNullableString(siteId, "siteId");
  assertNonEmptyString(month, "month");
  if (!Array.isArray(jobs)) throw new TypeError("jobs must be an array");
  if (typeof getEventsForJob !== "function") throw new TypeError("getEventsForJob must be a function");

  const period = parseYearMonth(month);
  const startMs = Date.parse(period.startAt);
  const endMs = Date.parse(period.endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new TypeError("invalid statement period");

  const included = [];

  for (const jobSnap of jobs) {
    if (!jobSnap?.id) continue;

    const effCustomerId = jobSnap.booking?.customerId ?? jobSnap.customerId ?? null;
    const effSiteId = jobSnap.booking?.siteId ?? jobSnap.siteId ?? null;
    if (customerId !== null && effCustomerId !== customerId) continue;
    if (siteId !== null && effSiteId !== siteId) continue;

    const events = getEventsForJob(jobSnap.id);
    if (!Array.isArray(events) || events.length === 0) continue;

    const settledIdx = findLastEventIndex(events, "SETTLED");
    const settledEvent = settledIdx === -1 ? null : events[settledIdx];
    if (!settledEvent?.at) continue;
    const settledMs = Date.parse(settledEvent.at);
    if (!Number.isFinite(settledMs)) continue;
    if (settledMs < startMs || settledMs >= endMs) continue;

    const job = reduceJob(events);
    if (!job) continue;

    const jobBeforeSettle = settledIdx > 0 ? reduceJob(events.slice(0, settledIdx)) : null;
    const statusBeforeSettle = jobBeforeSettle?.status ?? null;

    const bookedEvent = findFirstEvent(events, "BOOKED");
    const quoteEvent = findLastEvent(events, "QUOTE_PROPOSED");

    const quotedAmountCents = Number.isSafeInteger(job.quote?.amountCents) ? job.quote.amountCents : 0;
    const operatorCostCents = sumCents((job.operatorCosts ?? []).map((c) => c?.payload?.costCents ?? 0));
    const slaCreditsCents = sumCents((job.slaCredits ?? []).map((c) => c?.payload?.amountCents ?? 0));

    const claimsPaidCents = sumCents(
      (job.claims ?? [])
        .filter((c) => c?.status === "PAID")
        .map((c) => c?.paid?.amountCents ?? 0)
    );

    const incidentsCount = Array.isArray(job.incidents) ? job.incidents.length : 0;
    const slaBreachesCount = Array.isArray(job.slaBreaches) ? job.slaBreaches.length : 0;

    const latestRisk = Array.isArray(job.riskScores) && job.riskScores.length ? job.riskScores[job.riskScores.length - 1]?.payload ?? null : null;
    const riskScore = Number.isSafeInteger(latestRisk?.riskScore) ? latestRisk.riskScore : 0;
    const expectedIncidentProbabilityBps = Number.isSafeInteger(latestRisk?.expectedIncidentProbabilityBps) ? latestRisk.expectedIncidentProbabilityBps : 0;
    const expectedAssistSeconds = Number.isSafeInteger(latestRisk?.expectedAssistSeconds) ? latestRisk.expectedAssistSeconds : 0;
    const expectedCreditBurnRateCents = Number.isSafeInteger(latestRisk?.expectedCreditBurnRateCents) ? latestRisk.expectedCreditBurnRateCents : 0;

    const coverageTierIdRaw = job.booking?.policySnapshot?.coveragePolicy?.coverageTierId ?? null;
    const coverageTierId = typeof coverageTierIdRaw === "string" && coverageTierIdRaw.trim() !== "" ? coverageTierIdRaw : null;
    const coverageFeeCents =
      Number.isSafeInteger(job.quote?.breakdown?.coverageFeeCents) && job.quote.breakdown.coverageFeeCents > 0 ? job.quote.breakdown.coverageFeeCents : 0;
    const creditFundingModelRaw = job.booking?.policySnapshot?.coveragePolicy?.creditFundingModel ?? null;
    const creditFundingModel =
      typeof creditFundingModelRaw === "string" && creditFundingModelRaw.trim() !== "" ? creditFundingModelRaw : null;

    const reserveFundPercentRaw = job.booking?.policySnapshot?.coveragePolicy?.reserveFundPercent ?? null;
    const reserveFundPercent = safeIntPercent(reserveFundPercentRaw, 0);

    const proofGateMode = getProofGateMode(jobBeforeSettle ?? job);
    const proofStatusFromRef = settledEvent?.payload?.settlementProofRef?.status ?? null;
    const proofStatusAtSettle =
      typeof proofStatusFromRef === "string" && proofStatusFromRef.trim()
        ? proofStatusFromRef
        : (() => {
            const completionChainHash = findLatestCompletionChainHash(events, { beforeIndex: settledIdx });
            return proofGateMode !== "warn" && statusBeforeSettle === JOB_STATUS.COMPLETED && completionChainHash
              ? findLatestProofStatusForAnchor(events, { beforeIndex: settledIdx, evaluatedAtChainHash: completionChainHash })
              : null;
          })();
    const nonBillable = proofGateMode !== "warn" && statusBeforeSettle === JOB_STATUS.COMPLETED && proofStatusAtSettle === "FAIL";

    const amountCents = nonBillable ? 0 : quotedAmountCents;
    const coverageRevenueEarnedCents = statusBeforeSettle === JOB_STATUS.COMPLETED && !nonBillable ? coverageFeeCents : 0;
    const coverageReserveFundedCents =
      statusBeforeSettle === JOB_STATUS.COMPLETED && !nonBillable ? Math.floor((coverageFeeCents * reserveFundPercent) / 100) : 0;

    const recoverablePercentRaw = job.booking?.policySnapshot?.coveragePolicy?.recoverablePercent ?? 100;
    const recoverablePercent = safeIntPercent(recoverablePercentRaw, 100);

    let creditsFromCoverageReserveCents = 0;
    let creditsFromPlatformExpenseCents = 0;
    let creditsFromOperatorChargebackCents = 0;
    let creditsFromInsurerRecoverableCents = 0;
    for (const c of job.slaCredits ?? []) {
      const cents = c?.payload?.amountCents ?? 0;
      if (!Number.isSafeInteger(cents) || cents <= 0) continue;
      if (creditFundingModel === CREDIT_FUNDING_MODEL.COVERAGE_RESERVE) creditsFromCoverageReserveCents += cents;
      else if (creditFundingModel === CREDIT_FUNDING_MODEL.OPERATOR_CHARGEBACK) creditsFromOperatorChargebackCents += cents;
      else if (creditFundingModel === CREDIT_FUNDING_MODEL.INSURER_RECOVERABLE) {
        const recoverableCents = Math.floor((cents * recoverablePercent) / 100);
        creditsFromInsurerRecoverableCents += recoverableCents;
        creditsFromPlatformExpenseCents += cents - recoverableCents;
      } else creditsFromPlatformExpenseCents += cents;
    }

    const ledgerEntryIds = {};
    if (bookedEvent?.id) ledgerEntryIds.booked = `jnl_${bookedEvent.id}`;
    if (settledEvent?.id) ledgerEntryIds.settled = `jnl_${settledEvent.id}`;
    if (quoteEvent?.id) ledgerEntryIds.quoted = `jnl_${quoteEvent.id}`;

    const costEvent = findLastEvent(events, "OPERATOR_COST_RECORDED");
    if (costEvent?.id) ledgerEntryIds.operatorCost = `jnl_${costEvent.id}`;
    const creditEvent = findLastEvent(events, "SLA_CREDIT_ISSUED");
    if (creditEvent?.id) ledgerEntryIds.slaCredit = `jnl_${creditEvent.id}`;

    const claimPaidEvents = events.filter((e) => e?.type === "CLAIM_PAID" && e?.id).map((e) => `jnl_${e.id}`);
    if (claimPaidEvents.length) ledgerEntryIds.claimPaid = claimPaidEvents;

    const claimAdjustedEvents = events.filter((e) => e?.type === "JOB_ADJUSTED" && e?.id).map((e) => `jnl_${e.id}`);
    if (claimAdjustedEvents.length) ledgerEntryIds.claimAdjusted = claimAdjustedEvents;

    included.push({
      jobId: job.id,
      customerId: job.booking?.customerId ?? job.customerId ?? null,
      siteId: job.booking?.siteId ?? job.siteId ?? null,
      contractId: job.booking?.contractId ?? job.contractId ?? null,
      templateId: job.templateId ?? null,
      zoneId: job.booking?.zoneId ?? job.constraints?.zoneId ?? null,
      environmentTier: job.booking?.environmentTier ?? null,
      bookedAt: bookedEvent?.at ?? null,
      settledAt: settledEvent.at,
      amountCents,
      operatorCostCents,
      slaCreditsCents,
      claimsPaidCents,
      incidentsCount,
      slaBreachesCount,
      ledgerEntryIds,
      riskScore,
      expectedIncidentProbabilityBps,
      expectedAssistSeconds,
      expectedCreditBurnRateCents,
      coverageTierId,
      coverageFeeCents,
      creditFundingModel,
      coverageRevenueEarnedCents,
      coverageReserveFundedCents,
      creditsFromCoverageReserveCents,
      creditsFromPlatformExpenseCents,
      creditsFromOperatorChargebackCents,
      creditsFromInsurerRecoverableCents
    });
  }

  included.sort((a, b) => String(a.jobId).localeCompare(String(b.jobId)));

  const summary = {
    jobsSettled: included.length,
    grossAmountCents: sumCents(included.map((j) => j.amountCents)),
    slaCreditsCents: sumCents(included.map((j) => j.slaCreditsCents)),
    claimsPaidCents: sumCents(included.map((j) => j.claimsPaidCents)),
    operatorCostCents: sumCents(included.map((j) => j.operatorCostCents)),
    coverageFeesCents: sumCents(included.map((j) => j.coverageFeeCents)),
    coverageFeesBilledCents: sumCents(included.map((j) => j.coverageFeeCents)),
    coverageRevenueEarnedCents: sumCents(included.map((j) => j.coverageRevenueEarnedCents)),
    coverageReserveFundedCents: sumCents(included.map((j) => j.coverageReserveFundedCents)),
    creditsFromCoverageReserveCents: sumCents(included.map((j) => j.creditsFromCoverageReserveCents)),
    creditsFromPlatformExpenseCents: sumCents(included.map((j) => j.creditsFromPlatformExpenseCents)),
    creditsFromOperatorChargebackCents: sumCents(included.map((j) => j.creditsFromOperatorChargebackCents)),
    creditsFromInsurerRecoverableCents: sumCents(included.map((j) => j.creditsFromInsurerRecoverableCents)),
    incidentsCount: sumCents(included.map((j) => j.incidentsCount)),
    slaBreachesCount: sumCents(included.map((j) => j.slaBreachesCount))
  };

  const coverageReserveBalanceCents = accountBalanceAt(ledgerEntries, { accountId: "acct_coverage_reserve", atMs: endMs });
  const insurerReceivableBalanceCents = accountBalanceAt(ledgerEntries, { accountId: "acct_insurer_receivable", atMs: endMs });
  summary.coverageReserveBalanceCents = coverageReserveBalanceCents ?? 0;
  summary.insurerReceivableBalanceCents = insurerReceivableBalanceCents ?? 0;

  summary.coverageLossRatio =
    summary.coverageRevenueEarnedCents > 0 ? summary.creditsFromCoverageReserveCents / summary.coverageRevenueEarnedCents : null;

  for (const key of [
    "grossAmountCents",
    "slaCreditsCents",
    "claimsPaidCents",
    "operatorCostCents",
    "coverageFeesCents",
    "coverageFeesBilledCents",
    "coverageRevenueEarnedCents",
    "coverageReserveFundedCents",
    "creditsFromCoverageReserveCents",
    "creditsFromPlatformExpenseCents",
    "creditsFromOperatorChargebackCents",
    "creditsFromInsurerRecoverableCents",
    "coverageReserveBalanceCents",
    "insurerReceivableBalanceCents"
  ]) {
    assertSafeCents(summary[key], `summary.${key}`);
  }

  return {
    tenantId,
    customerId,
    siteId,
    month,
    period,
    generatedAt: nowIso(),
    summary,
    jobs: included
  };
}
