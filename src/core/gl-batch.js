import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";
import { jobIdFromLedgerMemo } from "./party-statements.js";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

export const GL_BATCH_SCHEMA_VERSION_V1 = "GLBatchBody.v1";

export function computeGlBatchBodyV1({ tenantId, period, basis, allocationRows, generatedAt, monthClose = null } = {}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(basis, "basis");
  assertNonEmptyString(generatedAt, "generatedAt");
  if (!Array.isArray(allocationRows)) throw new TypeError("allocationRows must be an array");
  if (monthClose !== null && monthClose !== undefined && !isPlainObject(monthClose)) throw new TypeError("monthClose must be an object when provided");

  const lines = [];
  const totalsByAccountId = new Map();
  const totalsByPartyId = new Map();
  let totalCents = 0;

  for (const r of allocationRows) {
    if (!r || typeof r !== "object") continue;
    const entryId = r.entryId ?? r.entry_id ?? null;
    const postingId = r.postingId ?? r.posting_id ?? null;
    const accountId = r.accountId ?? r.account_id ?? null;
    const partyId = r.partyId ?? r.party_id ?? null;
    const partyRole = r.partyRole ?? r.party_role ?? null;
    const currency = r.currency ?? "USD";
    const amountCents = r.amountCents ?? r.amount_cents ?? null;
    const memo = r.memo ?? null;
    const at = r.at ?? null;

    if (typeof entryId !== "string" || !entryId.trim()) continue;
    if (typeof postingId !== "string" || !postingId.trim()) continue;
    if (typeof accountId !== "string" || !accountId.trim()) continue;
    if (typeof partyId !== "string" || !partyId.trim()) continue;
    if (typeof partyRole !== "string" || !partyRole.trim()) continue;
    if (typeof currency !== "string" || !currency.trim()) continue;
    if (!Number.isSafeInteger(amountCents)) continue;

    const lineId = `${entryId}:${postingId}:${partyId}`;
    const jobId = typeof memo === "string" && memo.trim() ? jobIdFromLedgerMemo(memo) : null;

    lines.push({
      lineId,
      entryId,
      postingId,
      at: typeof at === "string" && at.trim() ? at : null,
      memo: typeof memo === "string" && memo.trim() ? memo : null,
      jobId: typeof jobId === "string" && jobId.trim() ? jobId : null,
      accountId,
      partyId,
      partyRole,
      currency,
      amountCents
    });

    totalCents += amountCents;
    totalsByAccountId.set(accountId, (totalsByAccountId.get(accountId) ?? 0) + amountCents);
    totalsByPartyId.set(partyId, (totalsByPartyId.get(partyId) ?? 0) + amountCents);
  }

  lines.sort((a, b) => {
    if (a.entryId !== b.entryId) return a.entryId < b.entryId ? -1 : 1;
    if (a.postingId !== b.postingId) return a.postingId < b.postingId ? -1 : 1;
    if (a.partyId !== b.partyId) return a.partyId < b.partyId ? -1 : 1;
    return 0;
  });

  const totalsByAccountIdObj = {};
  for (const k of Array.from(totalsByAccountId.keys()).sort()) totalsByAccountIdObj[k] = totalsByAccountId.get(k);
  const totalsByPartyIdObj = {};
  for (const k of Array.from(totalsByPartyId.keys()).sort()) totalsByPartyIdObj[k] = totalsByPartyId.get(k);

  if (totalCents !== 0) {
    const err = new Error(`GL batch does not balance: totalCents ${totalCents} != 0`);
    err.code = "GL_BATCH_IMBALANCED";
    err.totalCents = totalCents;
    throw err;
  }

  const body = {
    type: GL_BATCH_SCHEMA_VERSION_V1,
    tenantId,
    period,
    basis,
    generatedAt,
    monthClose: monthClose ?? null,
    totals: {
      totalCents,
      totalsByAccountId: totalsByAccountIdObj,
      totalsByPartyId: totalsByPartyIdObj
    },
    lines
  };

  const bodyHash = sha256Hex(canonicalJsonStringify(body));
  return { body, bodyHash };
}

