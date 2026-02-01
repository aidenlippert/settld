import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

export function jobIdFromLedgerMemo(memo) {
  if (typeof memo !== "string" || memo.trim() === "") return null;
  const m = /^job:([^\s]+)\s/.exec(memo);
  if (!m) return null;
  return String(m[1]);
}

function postingIndexFromPostingId(postingId) {
  if (typeof postingId !== "string" || postingId.trim() === "") return null;
  const m = /^p(\d+)$/.exec(String(postingId));
  if (!m) return null;
  const idx = Number(m[1]);
  return Number.isSafeInteger(idx) && idx >= 0 ? idx : null;
}

export function accountIdFromEntryPostingId({ entry, postingId }) {
  if (!entry || typeof entry !== "object") return null;
  if (!Array.isArray(entry.postings)) return null;
  const idx = postingIndexFromPostingId(postingId);
  if (idx === null) return null;
  const p = entry.postings[idx];
  const accountId = p?.accountId ?? null;
  if (typeof accountId !== "string" || accountId.trim() === "") return null;
  return String(accountId);
}

export function computeAllocationDigest({ allocations }) {
  if (!Array.isArray(allocations)) throw new TypeError("allocations must be an array");
  const rows = allocations
    .map((a) => ({
      entryId: a?.entryId ?? null,
      postingId: a?.postingId ?? null,
      accountId: a?.accountId ?? null,
      partyId: a?.partyId ?? null,
      partyRole: a?.partyRole ?? null,
      currency: a?.currency ?? null,
      amountCents: Number.isSafeInteger(a?.amountCents) ? a.amountCents : null
    }))
    .filter((r) => r.entryId && r.postingId && r.partyId && r.partyRole && r.currency && Number.isSafeInteger(r.amountCents));

  rows.sort(
    (a, b) =>
      String(a.entryId).localeCompare(String(b.entryId)) ||
      String(a.postingId).localeCompare(String(b.postingId)) ||
      String(a.partyId).localeCompare(String(b.partyId))
  );

  return sha256Hex(canonicalJsonStringify(rows));
}

export function computePartyStatement({ tenantId, partyId, partyRole, period, basis, allocations, entriesById = null, currency = "USD" } = {}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(partyId, "partyId");
  assertNonEmptyString(partyRole, "partyRole");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(basis, "basis");
  if (!Array.isArray(allocations)) throw new TypeError("allocations must be an array");
  assertNonEmptyString(currency, "currency");

  const totalsByAccountId = Object.create(null);
  let balanceDeltaCents = 0;
  let feesCents = 0;
  let payoutCents = 0;
  let creditsCents = 0;
  const includedEntryIds = new Set();
  const includedAllocations = [];

  for (const a of allocations) {
    if (!a || typeof a !== "object") continue;
    if (String(a.partyId ?? "") !== partyId) continue;
    if (String(a.partyRole ?? "") !== partyRole) continue;
    if (!Number.isSafeInteger(a.amountCents)) continue;
    if (typeof a.entryId !== "string" || a.entryId.trim() === "") continue;
    if (typeof a.postingId !== "string" || a.postingId.trim() === "") continue;
    includedEntryIds.add(String(a.entryId));
    includedAllocations.push(a);

    balanceDeltaCents += a.amountCents;

    let accountId = typeof a.accountId === "string" && a.accountId.trim() ? String(a.accountId) : null;
    if (!accountId && entriesById && typeof entriesById.get === "function") {
      const entry = entriesById.get(String(a.entryId)) ?? null;
      accountId = accountIdFromEntryPostingId({ entry, postingId: a.postingId });
    }
    if (!accountId) accountId = "acct_unknown";

    totalsByAccountId[accountId] = (Number.isSafeInteger(totalsByAccountId[accountId]) ? totalsByAccountId[accountId] : 0) + a.amountCents;

    // Party-facing rollup semantics (match SettlementStatement partyRollups):
    // - platform revenue credits are negative amounts -> feesCents increases by -amt
    // - operator payable credits are negative amounts -> payoutCents increases by -amt
    // - customer credits payable credits are negative amounts -> creditsCents increases by -amt
    const amt = a.amountCents;
    if (accountId === "acct_platform_revenue") feesCents += -amt;
    if (accountId === "acct_owner_payable" || accountId === "acct_operator_payable") payoutCents += -amt;
    if (accountId === "acct_customer_credits_payable") creditsCents += -amt;
  }

  const allocationDigest = computeAllocationDigest({ allocations: includedAllocations });
  const entryIds = Array.from(includedEntryIds).sort();

  const netCents = feesCents + payoutCents + creditsCents;
  return {
    type: "PartyStatementBody.v1",
    v: 1,
    currency,
    tenantId,
    partyId,
    partyRole,
    period,
    basis,
    allocationDigest,
    allocationCount: includedAllocations.length,
    includedEntryIds: entryIds,
    totalsByAccountId,
    balanceDeltaCents,
    feesCents,
    payoutCents,
    creditsCents,
    netCents
  };
}

export function computePayoutAmountCentsForStatement({ partyRole, statement }) {
  assertNonEmptyString(partyRole, "partyRole");
  if (!statement || typeof statement !== "object") throw new TypeError("statement is required");
  const payoutCents = Number.isSafeInteger(statement.payoutCents) ? statement.payoutCents : 0;
  if (partyRole !== "operator" && partyRole !== "subcontractor") return 0;
  return payoutCents > 0 ? payoutCents : 0;
}

export function payoutKeyFor({ tenantId, partyId, period, statementHash }) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(partyId, "partyId");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(statementHash, "statementHash");
  return `${tenantId}:party:${partyId}:period:${period}:statement:${statementHash}`;
}
