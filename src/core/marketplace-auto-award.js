import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const MARKETPLACE_AUTO_AWARD_DECISION_SCHEMA_VERSION = "MarketplaceAutoAwardDecision.v1";
export const MARKETPLACE_AUTO_AWARD_STRATEGY = Object.freeze({
  LOWEST_AMOUNT_THEN_ETA: "lowest_amount_then_eta"
});

const SUPPORTED_STRATEGIES = new Set(Object.values(MARKETPLACE_AUTO_AWARD_STRATEGY));

function assertNonEmptyString(value, name, { max = 200 } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return normalized;
}

function normalizeIsoDateTime(value, name) {
  const normalized = assertNonEmptyString(value, name, { max: 128 });
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${name} must be an ISO date-time`);
  return normalized;
}

function normalizeStrategy(value) {
  const normalized =
    value === null || value === undefined || String(value).trim() === ""
      ? MARKETPLACE_AUTO_AWARD_STRATEGY.LOWEST_AMOUNT_THEN_ETA
      : String(value).trim().toLowerCase();
  if (!SUPPORTED_STRATEGIES.has(normalized)) {
    throw new TypeError(`strategy must be one of ${Array.from(SUPPORTED_STRATEGIES.values()).join("|")}`);
  }
  return normalized;
}

function normalizePendingBidCandidates(bids = []) {
  const out = [];
  const rows = Array.isArray(bids) ? bids : [];
  for (const bid of rows) {
    if (!bid || typeof bid !== "object" || Array.isArray(bid)) continue;
    const status = String(bid.status ?? "pending").trim().toLowerCase();
    if (status !== "pending") continue;
    const bidId = typeof bid.bidId === "string" && bid.bidId.trim() !== "" ? bid.bidId.trim() : null;
    if (!bidId) continue;
    const amountCents = Number(bid.amountCents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) continue;
    const currency = typeof bid.currency === "string" && bid.currency.trim() !== "" ? bid.currency.trim().toUpperCase() : "USD";
    const etaSeconds =
      bid.etaSeconds === null || bid.etaSeconds === undefined || bid.etaSeconds === ""
        ? null
        : Number.isSafeInteger(Number(bid.etaSeconds)) && Number(bid.etaSeconds) > 0
          ? Number(bid.etaSeconds)
          : null;
    const createdAt =
      typeof bid.createdAt === "string" && Number.isFinite(Date.parse(bid.createdAt))
        ? new Date(Date.parse(bid.createdAt)).toISOString()
        : null;
    out.push({
      bid,
      bidId,
      bidderAgentId: typeof bid.bidderAgentId === "string" && bid.bidderAgentId.trim() !== "" ? bid.bidderAgentId.trim() : null,
      amountCents,
      currency,
      etaSeconds,
      createdAt,
      sortEtaSeconds: etaSeconds ?? Number.MAX_SAFE_INTEGER,
      sortCreatedAtMs: createdAt ? Date.parse(createdAt) : Number.MAX_SAFE_INTEGER
    });
  }
  out.sort((left, right) => {
    if (left.amountCents !== right.amountCents) return left.amountCents - right.amountCents;
    if (left.sortEtaSeconds !== right.sortEtaSeconds) return left.sortEtaSeconds - right.sortEtaSeconds;
    if (left.sortCreatedAtMs !== right.sortCreatedAtMs) return left.sortCreatedAtMs - right.sortCreatedAtMs;
    return left.bidId.localeCompare(right.bidId);
  });
  return out;
}

function buildDecision({
  rfqId,
  strategy,
  allowOverBudget,
  budgetCents,
  decidedAt,
  outcome,
  reasonCode = null,
  selectedBidId = null,
  tiedBidIds = [],
  consideredBids = []
} = {}) {
  const normalizedConsidered = consideredBids.map((candidate, index) =>
    normalizeForCanonicalJson(
      {
        rank: index + 1,
        bidId: candidate.bidId,
        bidderAgentId: candidate.bidderAgentId ?? null,
        amountCents: candidate.amountCents,
        currency: candidate.currency,
        etaSeconds: candidate.etaSeconds ?? null,
        createdAt: candidate.createdAt ?? null
      },
      { path: `$.consideredBids[${index}]` }
    )
  );
  const core = normalizeForCanonicalJson(
    {
      schemaVersion: MARKETPLACE_AUTO_AWARD_DECISION_SCHEMA_VERSION,
      rfqId: assertNonEmptyString(rfqId, "rfqId"),
      strategy: normalizeStrategy(strategy),
      allowOverBudget: allowOverBudget === true,
      budgetCents:
        Number.isSafeInteger(Number(budgetCents)) && Number(budgetCents) > 0
          ? Number(budgetCents)
          : null,
      decidedAt: normalizeIsoDateTime(decidedAt, "decidedAt"),
      outcome: assertNonEmptyString(outcome, "outcome", { max: 32 }).toLowerCase(),
      reasonCode: reasonCode ? assertNonEmptyString(reasonCode, "reasonCode", { max: 120 }) : null,
      selectedBidId: selectedBidId ? assertNonEmptyString(selectedBidId, "selectedBidId") : null,
      tiedBidIds: Array.isArray(tiedBidIds) ? [...new Set(tiedBidIds.map((row, index) => assertNonEmptyString(row, `tiedBidIds[${index}]`)))] : [],
      consideredBidCount: normalizedConsidered.length,
      consideredBids: normalizedConsidered,
      decisionHash: null
    },
    { path: "$" }
  );
  return normalizeForCanonicalJson(
    {
      ...core,
      decisionHash: sha256Hex(canonicalJsonStringify(core))
    },
    { path: "$" }
  );
}

export function selectMarketplaceAutoAwardBidV1({
  rfq,
  bids = [],
  strategy = MARKETPLACE_AUTO_AWARD_STRATEGY.LOWEST_AMOUNT_THEN_ETA,
  allowOverBudget = false,
  decidedAt = new Date().toISOString()
} = {}) {
  const rfqId = typeof rfq?.rfqId === "string" && rfq.rfqId.trim() !== "" ? rfq.rfqId.trim() : null;
  if (!rfqId) throw new TypeError("rfq.rfqId is required");
  const normalizedStrategy = normalizeStrategy(strategy);
  const normalizedDecidedAt = normalizeIsoDateTime(decidedAt, "decidedAt");
  const candidates = normalizePendingBidCandidates(bids);
  const budgetCents =
    Number.isSafeInteger(Number(rfq?.budgetCents)) && Number(rfq.budgetCents) > 0 ? Number(rfq.budgetCents) : null;

  if (!candidates.length) {
    const decision = buildDecision({
      rfqId,
      strategy: normalizedStrategy,
      allowOverBudget,
      budgetCents,
      decidedAt: normalizedDecidedAt,
      outcome: "blocked",
      reasonCode: "MARKETPLACE_AUTO_AWARD_NO_PENDING_BIDS",
      consideredBids: []
    });
    return {
      decision,
      selectedBid: null
    };
  }

  const selectedCandidate = candidates[0];
  const tiedCandidates = candidates.filter(
    (candidate) =>
      candidate.amountCents === selectedCandidate.amountCents &&
      candidate.currency === selectedCandidate.currency &&
      (candidate.etaSeconds ?? null) === (selectedCandidate.etaSeconds ?? null)
  );
  if (tiedCandidates.length > 1) {
    const decision = buildDecision({
      rfqId,
      strategy: normalizedStrategy,
      allowOverBudget,
      budgetCents,
      decidedAt: normalizedDecidedAt,
      outcome: "blocked",
      reasonCode: "MARKETPLACE_AUTO_AWARD_AMBIGUOUS",
      tiedBidIds: tiedCandidates.map((candidate) => candidate.bidId),
      consideredBids: candidates
    });
    return {
      decision,
      selectedBid: null
    };
  }

  if (!allowOverBudget && budgetCents !== null && selectedCandidate.amountCents > budgetCents) {
    const decision = buildDecision({
      rfqId,
      strategy: normalizedStrategy,
      allowOverBudget,
      budgetCents,
      decidedAt: normalizedDecidedAt,
      outcome: "blocked",
      reasonCode: "MARKETPLACE_AUTO_AWARD_OVER_BUDGET",
      selectedBidId: selectedCandidate.bidId,
      consideredBids: candidates
    });
    return {
      decision,
      selectedBid: null
    };
  }

  const decision = buildDecision({
    rfqId,
    strategy: normalizedStrategy,
    allowOverBudget,
    budgetCents,
    decidedAt: normalizedDecidedAt,
    outcome: "selected",
    selectedBidId: selectedCandidate.bidId,
    consideredBids: candidates
  });
  return {
    decision,
    selectedBid: selectedCandidate.bid
  };
}
