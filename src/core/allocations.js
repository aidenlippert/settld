import { normalizeTenantId, DEFAULT_TENANT_ID } from "./tenancy.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function isHexSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export const PARTY_ROLE = Object.freeze({
  PLATFORM: "platform",
  OPERATOR: "operator",
  CUSTOMER: "customer",
  SUBCONTRACTOR: "subcontractor",
  INSURER: "insurer"
});

function defaultPartyRoleForAccountId(accountId) {
  const id = String(accountId ?? "");

  if (id.startsWith("acct_customer_")) return PARTY_ROLE.CUSTOMER;
  if (id.includes("insurer_")) return PARTY_ROLE.INSURER;
  if (id.includes("coverage_reserve")) return PARTY_ROLE.INSURER;
  if (id.includes("developer_")) return PARTY_ROLE.SUBCONTRACTOR;
  if (id.includes("operator_") || id.includes("owner_payable") || id.includes("operator_payable")) return PARTY_ROLE.OPERATOR;
  if (id.includes("owner_") || id.includes("operator_")) return PARTY_ROLE.OPERATOR;
  return PARTY_ROLE.PLATFORM;
}

function partyIdFromContractDoc({ role, contractDoc }) {
  if (!contractDoc || typeof contractDoc !== "object") return null;
  const parties = contractDoc.parties ?? null;
  if (!parties || typeof parties !== "object") return null;
  const p = parties[role] ?? null;
  if (!p || typeof p !== "object") return null;
  const id = p.partyId ?? null;
  if (typeof id !== "string" || id.trim() === "") return null;
  return String(id);
}

function defaultPartyIdForRole({ role, job }) {
  if (role === PARTY_ROLE.PLATFORM) return "pty_platform";
  if (role === PARTY_ROLE.OPERATOR) {
    const operatorId = job?.operatorCoverage?.operatorId ?? job?.assist?.operatorId ?? null;
    if (typeof operatorId === "string" && operatorId.trim() !== "") return `pty_operator:${operatorId}`;
    return "pty_operator";
  }
  if (role === PARTY_ROLE.CUSTOMER) {
    const customerId = job?.customerId ?? job?.booking?.customerId ?? null;
    if (typeof customerId === "string" && customerId.trim() !== "") return `pty_customer:${customerId}`;
    return "pty_customer";
  }
  if (role === PARTY_ROLE.INSURER) {
    const insurerId =
      job?.booking?.policySnapshot?.coveragePolicy?.insurerId ??
      job?.booking?.coveragePolicy?.insurerId ??
      null;
    if (typeof insurerId === "string" && insurerId.trim() !== "") return `pty_insurer:${insurerId}`;
    return "pty_insurer";
  }
  if (role === PARTY_ROLE.SUBCONTRACTOR) return "pty_subcontractor";
  return "pty_unknown";
}

function resolvePartyId({ role, job, contractDoc }) {
  const fromDoc = partyIdFromContractDoc({ role, contractDoc });
  if (fromDoc) return fromDoc;
  return defaultPartyIdForRole({ role, job });
}

export function allocateEntry({ tenantId = DEFAULT_TENANT_ID, entry, job, operatorContractDoc = null, currency = "USD" } = {}) {
  tenantId = normalizeTenantId(tenantId);
  assertPlainObject(entry, "entry");
  assertNonEmptyString(entry.id, "entry.id");
  if (!Array.isArray(entry.postings) || entry.postings.length < 2) throw new TypeError("entry.postings must be an array of at least 2 items");
  if (!job || typeof job !== "object") throw new TypeError("job is required");

  const allocations = [];

  for (let i = 0; i < entry.postings.length; i += 1) {
    const posting = entry.postings[i];
    if (!posting || typeof posting !== "object") throw new TypeError("posting must be an object");
    assertNonEmptyString(posting.accountId, "posting.accountId");
    if (!Number.isSafeInteger(posting.amountCents)) throw new TypeError("posting.amountCents must be a safe integer");
    if (posting.amountCents === 0) throw new TypeError("posting.amountCents must be non-zero");

    const role = defaultPartyRoleForAccountId(posting.accountId);

    // Coverage reserve postings can be attributed to the insurer only when an insurer is configured.
    let effectiveRole = role;
    if (role === PARTY_ROLE.INSURER) {
      const insurerId =
        job?.booking?.policySnapshot?.coveragePolicy?.insurerId ??
        job?.booking?.coveragePolicy?.insurerId ??
        null;
      if (insurerId === null || insurerId === undefined || String(insurerId).trim() === "") {
        effectiveRole = PARTY_ROLE.PLATFORM;
      }
    }

    const partyId = resolvePartyId({ role: effectiveRole, job, contractDoc: operatorContractDoc });
    allocations.push({
      tenantId,
      entryId: entry.id,
      postingId: `p${i}`,
      accountId: posting.accountId,
      partyId,
      partyRole: effectiveRole,
      currency,
      amountCents: posting.amountCents
    });
  }

  verifyAllocationInvariants({ entry, allocations });
  return allocations;
}

export function verifyAllocationInvariants({ entry, allocations }) {
  assertPlainObject(entry, "entry");
  if (!Array.isArray(entry.postings)) throw new TypeError("entry.postings is required");
  if (!Array.isArray(allocations)) throw new TypeError("allocations must be an array");

  const byPostingId = new Map();
  for (const a of allocations) {
    if (!a || typeof a !== "object") throw new TypeError("allocation must be an object");
    assertNonEmptyString(a.postingId, "allocation.postingId");
    if (!Number.isSafeInteger(a.amountCents)) throw new TypeError("allocation.amountCents must be a safe integer");
    const list = byPostingId.get(a.postingId) ?? [];
    list.push(a);
    byPostingId.set(a.postingId, list);
  }

  for (let i = 0; i < entry.postings.length; i += 1) {
    const postingId = `p${i}`;
    const posting = entry.postings[i];
    const list = byPostingId.get(postingId) ?? [];
    const sum = list.reduce((acc, a) => acc + a.amountCents, 0);
    if (sum !== posting.amountCents) {
      throw new Error(`allocation sum ${sum} !== posting amount ${posting.amountCents} for ${postingId}`);
    }
  }

  // Overall entry invariants: if each posting's allocations sum correctly, the entry still nets to zero.
  return true;
}

export function assertOperatorPinShape({ operatorContractHash, operatorPolicyHash, operatorCompilerId }) {
  if (operatorContractHash === null && operatorPolicyHash === null && operatorCompilerId === null) return;
  if (!isHexSha256(operatorContractHash)) throw new TypeError("operatorContractHash must be a 64-byte hex sha256");
  if (!isHexSha256(operatorPolicyHash)) throw new TypeError("operatorPolicyHash must be a 64-byte hex sha256");
  if (operatorCompilerId !== null && operatorCompilerId !== undefined) assertNonEmptyString(operatorCompilerId, "operatorCompilerId");
}
