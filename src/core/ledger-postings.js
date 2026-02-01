import { createJournalEntry } from "./ledger.js";
import { JOB_STATUS } from "./job-state-machine.js";
import { computeClaimTotalCents } from "./claims.js";
import { sumSkillLicenseFeesCents } from "./skills.js";
import { CREDIT_FUNDING_MODEL } from "./contracts.js";
import { computeSettlementSplitsV1 } from "./settlement-splits.js";

function assertSafeInteger(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

function computeJobAmountCents(job) {
  const amountCents = job?.quote?.amountCents;
  assertSafeInteger(amountCents, "job.quote.amountCents");
  return amountCents;
}

function computeCoverageFeeCents(job) {
  const fee = job?.quote?.breakdown?.coverageFeeCents ?? 0;
  if (!Number.isSafeInteger(fee) || fee < 0) return 0;
  return fee;
}

function computeReserveFundPercent(job) {
  const raw = job?.booking?.policySnapshot?.coveragePolicy?.reserveFundPercent ?? null;
  if (!Number.isSafeInteger(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return raw;
}

function computeRecoverablePercent(job) {
  const raw = job?.booking?.policySnapshot?.coveragePolicy?.recoverablePercent ?? null;
  if (!Number.isSafeInteger(raw)) return 100;
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return raw;
}

function computeRefundReversalSplits({ refundCents, settlementSplits }) {
  assertSafeInteger(refundCents, "refundCents");
  if (refundCents <= 0) throw new TypeError("refundCents must be positive");
  const amountCents = settlementSplits?.amountCents;
  assertSafeInteger(amountCents, "settlementSplits.amountCents");
  if (refundCents > amountCents) throw new TypeError("refundCents exceeds original amount");

  const platformFeeCents = Math.floor((settlementSplits.platformFeeCents * refundCents) / amountCents);
  const operatorFeeCents = Math.floor((settlementSplits.operatorFeeCents * refundCents) / amountCents);
  const developerRoyaltiesCents = Math.floor((settlementSplits.developerRoyaltiesCents * refundCents) / amountCents);
  const insuranceReserveCents = Math.floor((settlementSplits.insuranceReserveCents * refundCents) / amountCents);
  const coverageFeeCents = Math.floor(((settlementSplits.coverageFeeCents ?? 0) * refundCents) / amountCents);

  const subtotal = platformFeeCents + operatorFeeCents + developerRoyaltiesCents + insuranceReserveCents + coverageFeeCents;
  const ownerPayoutCents = refundCents - subtotal;
  if (ownerPayoutCents < 0) throw new TypeError("refund reversal splits invalid: owner reversal would be negative");

  return {
    refundCents,
    platformFeeCents,
    ownerPayoutCents,
    operatorFeeCents,
    developerRoyaltiesCents,
    insuranceReserveCents,
    coverageFeeCents
  };
}

function getGateMode(job) {
  const raw = job?.booking?.policySnapshot?.proofPolicy?.gateMode ?? null;
  const v = typeof raw === "string" ? raw : "warn";
  return v === "strict" || v === "holdback" ? v : "warn";
}

function findLatestCompletionChainHash(eventsBefore) {
  if (!Array.isArray(eventsBefore)) return null;
  for (let i = eventsBefore.length - 1; i >= 0; i -= 1) {
    const e = eventsBefore[i];
    if (e?.type !== "EXECUTION_COMPLETED" && e?.type !== "JOB_EXECUTION_COMPLETED") continue;
    const ch = typeof e?.chainHash === "string" ? e.chainHash.trim() : "";
    if (ch) return ch;
  }
  return null;
}

function findLatestProofStatusForAnchor(eventsBefore, evaluatedAtChainHash) {
  if (!Array.isArray(eventsBefore)) return null;
  if (typeof evaluatedAtChainHash !== "string" || !evaluatedAtChainHash.trim()) return null;
  for (let i = eventsBefore.length - 1; i >= 0; i -= 1) {
    const e = eventsBefore[i];
    if (e?.type !== "PROOF_EVALUATED") continue;
    if (e?.payload?.evaluatedAtChainHash !== evaluatedAtChainHash) continue;
    const status = typeof e?.payload?.status === "string" ? e.payload.status : null;
    if (status) return status;
  }
  return null;
}

export function ledgerEntriesForJobEvent({ jobBefore, event, eventsBefore }) {
  const entries = [];

  if (event.type === "BOOKED") {
    const amountCents = computeJobAmountCents(jobBefore);
    entries.push(
      createJournalEntry({
        id: `jnl_${event.id}`,
        at: event.at,
        memo: `job:${jobBefore.id} BOOKED`,
        postings: [
          { accountId: "acct_cash", amountCents },
          { accountId: "acct_customer_escrow", amountCents: -amountCents }
        ]
      })
    );

    const coverageFeeCents = computeCoverageFeeCents(jobBefore);
    if (coverageFeeCents) {
      entries.push(
        createJournalEntry({
          id: `jnl_${event.id}_coverage_fee`,
          at: event.at,
          memo: `job:${jobBefore.id} BOOKED coverage fee`,
          postings: [
            { accountId: "acct_customer_escrow", amountCents: coverageFeeCents },
            { accountId: "acct_coverage_unearned", amountCents: -coverageFeeCents }
          ]
        })
      );
    }

    return entries;
  }

  if (event.type === "SETTLED") {
    const amountCents = computeJobAmountCents(jobBefore);
    const coverageFeeCents = computeCoverageFeeCents(jobBefore);

    if (jobBefore.status === JOB_STATUS.ABORTED) {
      if (coverageFeeCents) {
        const serviceAmountCents = amountCents - coverageFeeCents;
        entries.push(
          createJournalEntry({
            id: `jnl_${event.id}`,
            at: event.at,
            memo: `job:${jobBefore.id} SETTLED (refund)`,
            postings: [
              { accountId: "acct_customer_escrow", amountCents: serviceAmountCents },
              { accountId: "acct_coverage_unearned", amountCents: coverageFeeCents },
              { accountId: "acct_cash", amountCents: -amountCents }
            ]
          })
        );
        return entries;
      }

      entries.push(
        createJournalEntry({
          id: `jnl_${event.id}`,
          at: event.at,
          memo: `job:${jobBefore.id} SETTLED (refund)`,
          postings: [
            { accountId: "acct_customer_escrow", amountCents },
            { accountId: "acct_cash", amountCents: -amountCents }
          ]
        })
      );
      return entries;
    }

    if (jobBefore.status !== JOB_STATUS.COMPLETED) {
      throw new TypeError("SETTLED ledger entry requires job to be COMPLETED or ABORTED");
    }

    const gateMode = getGateMode(jobBefore);
    if (gateMode !== "warn") {
      const proofStatusFromRef = event?.payload?.settlementProofRef?.status ?? null;
      const proofStatus = typeof proofStatusFromRef === "string" && proofStatusFromRef.trim() ? proofStatusFromRef : null;
      if (!proofStatus) {
        const completionChainHash = findLatestCompletionChainHash(eventsBefore);
        const fallback = completionChainHash ? findLatestProofStatusForAnchor(eventsBefore, completionChainHash) : null;
        if (!fallback) throw new TypeError("SETTLED requires settlementProofRef (or PROOF_EVALUATED) in strict/holdback mode");
        if (fallback === "INSUFFICIENT_EVIDENCE") throw new TypeError("SETTLED cannot proceed with INSUFFICIENT_EVIDENCE in strict/holdback mode");
        if (fallback === "FAIL") {
          // Finance-grade "no charge": close the job financially, but do not recognize revenue/payables.
          // (Customer escrow is returned; coverage is unearned and returned too.)
          if (coverageFeeCents) {
            const serviceAmountCents = amountCents - coverageFeeCents;
            entries.push(
              createJournalEntry({
                id: `jnl_${event.id}`,
                at: event.at,
                memo: `job:${jobBefore.id} SETTLED (no-charge)`,
                postings: [
                  { accountId: "acct_customer_escrow", amountCents: serviceAmountCents },
                  { accountId: "acct_coverage_unearned", amountCents: coverageFeeCents },
                  { accountId: "acct_cash", amountCents: -amountCents }
                ]
              })
            );
            return entries;
          }

          entries.push(
            createJournalEntry({
              id: `jnl_${event.id}`,
              at: event.at,
              memo: `job:${jobBefore.id} SETTLED (no-charge)`,
              postings: [
                { accountId: "acct_customer_escrow", amountCents },
                { accountId: "acct_cash", amountCents: -amountCents }
              ]
            })
          );
          return entries;
        }
      }

      if (proofStatus === "INSUFFICIENT_EVIDENCE") throw new TypeError("SETTLED cannot proceed with INSUFFICIENT_EVIDENCE in strict/holdback mode");
      if (proofStatus === "FAIL") {
        // Finance-grade "no charge": close the job financially, but do not recognize revenue/payables.
        // (Customer escrow is returned; coverage is unearned and returned too.)
        if (coverageFeeCents) {
          const serviceAmountCents = amountCents - coverageFeeCents;
          entries.push(
            createJournalEntry({
              id: `jnl_${event.id}`,
              at: event.at,
              memo: `job:${jobBefore.id} SETTLED (no-charge)`,
              postings: [
                { accountId: "acct_customer_escrow", amountCents: serviceAmountCents },
                { accountId: "acct_coverage_unearned", amountCents: coverageFeeCents },
                { accountId: "acct_cash", amountCents: -amountCents }
              ]
            })
          );
          return entries;
        }

        entries.push(
          createJournalEntry({
            id: `jnl_${event.id}`,
            at: event.at,
            memo: `job:${jobBefore.id} SETTLED (no-charge)`,
            postings: [
              { accountId: "acct_customer_escrow", amountCents },
              { accountId: "acct_cash", amountCents: -amountCents }
            ]
          })
        );
        return entries;
      }
    }

    const hadAssist = eventsBefore.some((e) => e.type === "ASSIST_STARTED");
    const developerRoyaltiesCents = sumSkillLicenseFeesCents(jobBefore.skillLicenses);
    const splits = computeSettlementSplitsV1({ amountCents, coverageFeeCents, hadAssist, developerRoyaltiesCents });

    const postings = [
      { accountId: "acct_customer_escrow", amountCents: splits.serviceAmountCents },
      { accountId: "acct_platform_revenue", amountCents: -splits.platformFeeCents },
      { accountId: "acct_owner_payable", amountCents: -splits.ownerPayoutCents },
      { accountId: "acct_insurance_reserve", amountCents: -splits.insuranceReserveCents }
    ];
    if (splits.operatorFeeCents) postings.push({ accountId: "acct_operator_payable", amountCents: -splits.operatorFeeCents });
    if (splits.developerRoyaltiesCents) {
      postings.push({ accountId: "acct_developer_royalty_payable", amountCents: -splits.developerRoyaltiesCents });
    }

    entries.push(
      createJournalEntry({
        id: `jnl_${event.id}`,
        at: event.at,
        memo: `job:${jobBefore.id} SETTLED`,
        postings
      })
    );

    if (splits.coverageFeeCents) {
      entries.push(
        createJournalEntry({
          id: `jnl_${event.id}_coverage_recognize`,
          at: event.at,
          memo: `job:${jobBefore.id} SETTLED coverage recognize`,
          postings: [
            { accountId: "acct_coverage_unearned", amountCents: splits.coverageFeeCents },
            { accountId: "acct_coverage_revenue", amountCents: -splits.coverageFeeCents }
          ]
        })
      );

      const reserveFundPercent = computeReserveFundPercent(jobBefore);
      const reserveFundCents = Math.floor((splits.coverageFeeCents * reserveFundPercent) / 100);
      if (reserveFundCents > 0) {
        entries.push(
          createJournalEntry({
            id: `jnl_${event.id}_coverage_reserve_fund`,
            at: event.at,
            memo: `job:${jobBefore.id} SETTLED coverage reserve fund`,
            postings: [
              { accountId: "acct_coverage_payout_expense", amountCents: reserveFundCents },
              { accountId: "acct_coverage_reserve", amountCents: -reserveFundCents }
            ]
          })
        );
      }
    }

    return entries;
  }

  if (event.type === "JOB_ADJUSTED") {
    if (jobBefore.status !== JOB_STATUS.SETTLED) throw new TypeError("JOB_ADJUSTED requires job to be SETTLED");
    const claimId = event.payload?.claimId;
    if (typeof claimId !== "string" || claimId.trim() === "") throw new TypeError("payload.claimId is required");

    const claim = Array.isArray(jobBefore.claims) ? jobBefore.claims.find((c) => c.claimId === claimId) : null;
    if (!claim) throw new TypeError("claim not found on job");
    if (claim.status !== "APPROVED") throw new TypeError("JOB_ADJUSTED requires claim status APPROVED");

    const approvedAmounts = claim.approved?.amounts ?? null;
    const payoutCents = approvedAmounts?.payoutCents ?? 0;
    const refundCents = approvedAmounts?.refundCents ?? 0;
    assertSafeInteger(payoutCents, "claim.payoutCents");
    assertSafeInteger(refundCents, "claim.refundCents");
    if (payoutCents < 0 || refundCents < 0) throw new TypeError("claim amounts must be non-negative");

    const totalCents = computeClaimTotalCents({ payoutCents, refundCents });
    if (totalCents <= 0) throw new TypeError("JOB_ADJUSTED requires non-zero claim amounts");

    const postings = [];

    if (payoutCents) postings.push({ accountId: "acct_claims_expense", amountCents: payoutCents });

    if (refundCents) {
      const amountCents = computeJobAmountCents(jobBefore);
      const completed = eventsBefore.some((e) => e.type === "EXECUTION_COMPLETED");
      const aborted = eventsBefore.some((e) => e.type === "EXECUTION_ABORTED");
      if (!completed || aborted) throw new TypeError("refund adjustments are only supported for settled, completed jobs");

      const hadAssist = eventsBefore.some((e) => e.type === "ASSIST_STARTED");
      const developerRoyaltiesCents = sumSkillLicenseFeesCents(jobBefore.skillLicenses);
      const coverageFeeCents = computeCoverageFeeCents(jobBefore);
      const settlementSplits = computeSettlementSplitsV1({ amountCents, coverageFeeCents, hadAssist, developerRoyaltiesCents });
      const reversal = computeRefundReversalSplits({ refundCents, settlementSplits });

      if (reversal.platformFeeCents) postings.push({ accountId: "acct_platform_revenue", amountCents: reversal.platformFeeCents });
      if (reversal.ownerPayoutCents) postings.push({ accountId: "acct_owner_payable", amountCents: reversal.ownerPayoutCents });
      if (reversal.insuranceReserveCents) postings.push({ accountId: "acct_insurance_reserve", amountCents: reversal.insuranceReserveCents });
      if (reversal.coverageFeeCents) postings.push({ accountId: "acct_coverage_revenue", amountCents: reversal.coverageFeeCents });
      if (reversal.operatorFeeCents) postings.push({ accountId: "acct_operator_payable", amountCents: reversal.operatorFeeCents });
      if (reversal.developerRoyaltiesCents) {
        postings.push({ accountId: "acct_developer_royalty_payable", amountCents: reversal.developerRoyaltiesCents });
      }

      // Reverse reserve funding proportionally to the refunded coverage fee.
      if (reversal.coverageFeeCents && coverageFeeCents) {
        const reserveFundPercent = computeReserveFundPercent(jobBefore);
        const fundedCents = Math.floor((coverageFeeCents * reserveFundPercent) / 100);
        const reverseFundedCents = Math.floor((fundedCents * reversal.coverageFeeCents) / coverageFeeCents);
        if (reverseFundedCents > 0) {
          postings.push({ accountId: "acct_coverage_reserve", amountCents: reverseFundedCents });
          postings.push({ accountId: "acct_coverage_payout_expense", amountCents: -reverseFundedCents });
        }
      }
    }

    postings.push({ accountId: "acct_claims_payable", amountCents: -totalCents });
    entries.push(
      createJournalEntry({
        id: `jnl_${event.id}`,
        at: event.at,
        memo: `job:${jobBefore.id} claim:${claimId} ADJUSTED`,
        postings
      })
    );
    return entries;
  }

  if (event.type === "CLAIM_PAID") {
    const claimId = event.payload?.claimId;
    if (typeof claimId !== "string" || claimId.trim() === "") throw new TypeError("payload.claimId is required");
    const amountCents = event.payload?.amountCents;
    assertSafeInteger(amountCents, "payload.amountCents");
    if (amountCents <= 0) throw new TypeError("payload.amountCents must be positive");

    entries.push(
      createJournalEntry({
        id: `jnl_${event.id}`,
        at: event.at,
        memo: `job:${jobBefore.id} claim:${claimId} PAID`,
        postings: [
          { accountId: "acct_claims_payable", amountCents },
          { accountId: "acct_cash", amountCents: -amountCents }
        ]
      })
    );
    return entries;
  }

  if (event.type === "OPERATOR_COST_RECORDED") {
    if (jobBefore.status !== JOB_STATUS.SETTLED) throw new TypeError("OPERATOR_COST_RECORDED requires job to be SETTLED");
    const costCents = event.payload?.costCents ?? null;
    assertSafeInteger(costCents, "payload.costCents");
    if (costCents < 0) throw new TypeError("payload.costCents must be >= 0");
    if (costCents === 0) return entries;

    entries.push(
      createJournalEntry({
        id: `jnl_${event.id}`,
        at: event.at,
        memo: `job:${jobBefore.id} OPERATOR_COST_RECORDED`,
        postings: [
          { accountId: "acct_operator_labor_expense", amountCents: costCents },
          { accountId: "acct_operator_cost_accrued", amountCents: -costCents }
        ]
      })
    );
    return entries;
  }

  if (event.type === "SLA_CREDIT_ISSUED") {
    if (jobBefore.status !== JOB_STATUS.SETTLED) throw new TypeError("SLA_CREDIT_ISSUED requires job to be SETTLED");
    const amountCents = event.payload?.amountCents ?? null;
    assertSafeInteger(amountCents, "payload.amountCents");
    if (amountCents <= 0) throw new TypeError("payload.amountCents must be positive");

    const coveragePolicy = jobBefore.booking?.policySnapshot?.coveragePolicy ?? null;
    const fundingModel = coveragePolicy?.creditFundingModel ?? null;

    // Default: platform eats the credit (expense).
    let debitPostings = [{ accountId: "acct_sla_credits_expense", amountCents }];

    if (fundingModel === CREDIT_FUNDING_MODEL.COVERAGE_RESERVE) {
      debitPostings = [{ accountId: "acct_coverage_reserve", amountCents }];
    } else if (fundingModel === CREDIT_FUNDING_MODEL.OPERATOR_CHARGEBACK) {
      // Prefer reducing operator payable (if any), with overflow to a receivable.
      const jobAmountCents = computeJobAmountCents(jobBefore);
      const coverageFeeCents = computeCoverageFeeCents(jobBefore);
      const hadAssist = eventsBefore.some((e) => e.type === "ASSIST_STARTED");
      const developerRoyaltiesCents = sumSkillLicenseFeesCents(jobBefore.skillLicenses);
      const splits = computeSettlementSplitsV1({ amountCents: jobAmountCents, coverageFeeCents, hadAssist, developerRoyaltiesCents });
      const operatorFeeCents = splits.operatorFeeCents ?? 0;

      const fromPayable = Math.max(0, Math.min(amountCents, operatorFeeCents));
      const overflow = amountCents - fromPayable;
      debitPostings = [];
      if (fromPayable > 0) debitPostings.push({ accountId: "acct_operator_payable", amountCents: fromPayable });
      if (overflow > 0) debitPostings.push({ accountId: "acct_operator_chargeback_receivable", amountCents: overflow });
      if (debitPostings.length === 0) debitPostings.push({ accountId: "acct_operator_chargeback_receivable", amountCents });
    } else if (fundingModel === CREDIT_FUNDING_MODEL.INSURER_RECOVERABLE) {
      const recoverablePercent = computeRecoverablePercent(jobBefore);
      const receivableCents = Math.floor((amountCents * recoverablePercent) / 100);
      const remainder = amountCents - receivableCents;
      debitPostings = [];
      if (receivableCents > 0) debitPostings.push({ accountId: "acct_insurer_receivable", amountCents: receivableCents });
      if (remainder > 0) debitPostings.push({ accountId: "acct_sla_credits_expense", amountCents: remainder });
      if (debitPostings.length === 0) debitPostings.push({ accountId: "acct_sla_credits_expense", amountCents });
    }

    entries.push(
      createJournalEntry({
        id: `jnl_${event.id}`,
        at: event.at,
        memo: `job:${jobBefore.id} SLA_CREDIT_ISSUED`,
        postings: [...debitPostings, { accountId: "acct_customer_credits_payable", amountCents: -amountCents }]
      })
    );
    return entries;
  }

  return entries;
}

export function ledgerEntryForJobEvent({ jobBefore, event, eventsBefore }) {
  const entries = ledgerEntriesForJobEvent({ jobBefore, event, eventsBefore });
  return entries.length ? entries[0] : null;
}
