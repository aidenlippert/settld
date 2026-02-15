import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const AGREEMENT_DELEGATION_SCHEMA_VERSION = "AgreementDelegation.v1";

export const AGREEMENT_DELEGATION_STATUS = Object.freeze({
  ACTIVE: "active",
  SETTLED: "settled",
  REVOKED: "revoked"
});

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertIsoDate(value, name, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined)) return;
  assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO date string`);
}

function normalizeId(value, name, { min = 1, max = 200 } = {}) {
  assertNonEmptyString(value, name);
  const out = String(value).trim();
  if (out.length < min || out.length > max) throw new TypeError(`${name} must be length ${min}..${max}`);
  if (!/^[A-Za-z0-9:_-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:_-]+$`);
  return out;
}

function normalizeHexHash(value, name) {
  assertNonEmptyString(value, name);
  const out = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be a 64-hex sha256`);
  return out;
}

function normalizeCurrency(value, name) {
  const raw = typeof value === "string" && value.trim() !== "" ? value : "USD";
  const out = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(out)) throw new TypeError(`${name} must match ^[A-Z][A-Z0-9_]{2,11}$`);
  return out;
}

function assertPositiveSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function assertNonNegativeSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

function normalizeStatus(value, name) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!Object.values(AGREEMENT_DELEGATION_STATUS).includes(normalized)) {
    throw new TypeError(`${name} must be one of: ${Object.values(AGREEMENT_DELEGATION_STATUS).join("|")}`);
  }
  return normalized;
}

function normalizeAncestorChain(value, { name = "ancestorChain", requiredDepth = null, expectedParentHash = null } = {}) {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const h = normalizeHexHash(value[i], `${name}[${i}]`);
    if (seen.has(h)) throw new TypeError(`${name} must not contain duplicates`);
    seen.add(h);
    out.push(h);
  }
  if (requiredDepth !== null && out.length !== requiredDepth) {
    throw new TypeError(`${name} length must equal delegationDepth`);
  }
  if (expectedParentHash && out.length && out[out.length - 1] !== expectedParentHash) {
    throw new TypeError(`${name} last element must equal parentAgreementHash`);
  }
  return out;
}

export function computeAgreementDelegationHashV1(delegationCore) {
  assertPlainObject(delegationCore, "delegationCore");
  const copy = { ...delegationCore };
  delete copy.delegationHash;
  delete copy.status;
  delete copy.resolvedAt;
  delete copy.updatedAt;
  delete copy.revision;
  delete copy.metadata;
  const normalized = normalizeForCanonicalJson(copy, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function buildAgreementDelegationV1({
  delegationId,
  tenantId,
  parentAgreementHash,
  childAgreementHash,
  delegatorAgentId,
  delegateeAgentId,
  budgetCapCents,
  currency,
  delegationDepth,
  maxDelegationDepth,
  ancestorChain,
  createdAt
} = {}) {
  const at = createdAt ?? new Date().toISOString();
  assertIsoDate(at, "createdAt");

  const parentHash = normalizeHexHash(parentAgreementHash, "parentAgreementHash");
  const depth = assertNonNegativeSafeInt(delegationDepth, "delegationDepth");
  const normalizedAncestorChain = normalizeAncestorChain(ancestorChain, {
    name: "ancestorChain",
    requiredDepth: ancestorChain === undefined || ancestorChain === null ? null : depth,
    expectedParentHash: parentHash
  });

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: AGREEMENT_DELEGATION_SCHEMA_VERSION,
      delegationId: normalizeId(delegationId, "delegationId", { min: 3, max: 240 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      parentAgreementHash: parentHash,
      childAgreementHash: normalizeHexHash(childAgreementHash, "childAgreementHash"),
      delegatorAgentId: normalizeId(delegatorAgentId, "delegatorAgentId", { min: 3, max: 128 }),
      delegateeAgentId: normalizeId(delegateeAgentId, "delegateeAgentId", { min: 3, max: 128 }),
      budgetCapCents: assertPositiveSafeInt(budgetCapCents, "budgetCapCents"),
      currency: normalizeCurrency(currency, "currency"),
      delegationDepth: depth,
      maxDelegationDepth: assertNonNegativeSafeInt(maxDelegationDepth, "maxDelegationDepth"),
      createdAt: at,
      ...(normalizedAncestorChain ? { ancestorChain: normalizedAncestorChain } : {})
    },
    { path: "$" }
  );

  if (normalized.delegationDepth > normalized.maxDelegationDepth) {
    throw new TypeError("delegationDepth must be <= maxDelegationDepth");
  }
  if (normalized.parentAgreementHash === normalized.childAgreementHash) {
    throw new TypeError("parentAgreementHash must differ from childAgreementHash");
  }

  const delegationHash = computeAgreementDelegationHashV1(normalized);
  return normalizeForCanonicalJson(
    {
      ...normalized,
      delegationHash,
      status: AGREEMENT_DELEGATION_STATUS.ACTIVE,
      revision: 0,
      updatedAt: at
    },
    { path: "$" }
  );
}

export function validateAgreementDelegationV1(delegation) {
  assertPlainObject(delegation, "delegation");
  if (delegation.schemaVersion !== AGREEMENT_DELEGATION_SCHEMA_VERSION) {
    throw new TypeError(`delegation.schemaVersion must be ${AGREEMENT_DELEGATION_SCHEMA_VERSION}`);
  }
  normalizeId(delegation.delegationId, "delegation.delegationId", { min: 3, max: 240 });
  normalizeId(delegation.tenantId, "delegation.tenantId", { min: 1, max: 128 });
  const parentHash = normalizeHexHash(delegation.parentAgreementHash, "delegation.parentAgreementHash");
  const childHash = normalizeHexHash(delegation.childAgreementHash, "delegation.childAgreementHash");
  if (parentHash === childHash) throw new TypeError("delegation.parentAgreementHash must differ from delegation.childAgreementHash");
  normalizeId(delegation.delegatorAgentId, "delegation.delegatorAgentId", { min: 3, max: 128 });
  normalizeId(delegation.delegateeAgentId, "delegation.delegateeAgentId", { min: 3, max: 128 });
  assertPositiveSafeInt(delegation.budgetCapCents, "delegation.budgetCapCents");
  normalizeCurrency(delegation.currency, "delegation.currency");
  const depth = assertNonNegativeSafeInt(delegation.delegationDepth, "delegation.delegationDepth");
  const maxDepth = assertNonNegativeSafeInt(delegation.maxDelegationDepth, "delegation.maxDelegationDepth");
  if (depth > maxDepth) throw new TypeError("delegation.delegationDepth must be <= delegation.maxDelegationDepth");
  assertIsoDate(delegation.createdAt, "delegation.createdAt");
  if (Object.prototype.hasOwnProperty.call(delegation, "ancestorChain")) {
    normalizeAncestorChain(delegation.ancestorChain ?? null, {
      name: "delegation.ancestorChain",
      requiredDepth: delegation.ancestorChain === null ? null : depth,
      expectedParentHash: parentHash
    });
  }
  normalizeHexHash(delegation.delegationHash, "delegation.delegationHash");
  normalizeStatus(delegation.status, "delegation.status");
  const revision = Number(delegation.revision ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError("delegation.revision must be a non-negative safe integer");
  assertIsoDate(delegation.updatedAt, "delegation.updatedAt");
  if (Object.prototype.hasOwnProperty.call(delegation, "resolvedAt")) {
    assertIsoDate(delegation.resolvedAt ?? null, "delegation.resolvedAt", { allowNull: true });
  }

  const computed = computeAgreementDelegationHashV1(delegation);
  if (computed !== String(delegation.delegationHash).toLowerCase()) throw new TypeError("delegationHash mismatch");
  return true;
}

export function resolveAgreementDelegationV1({ delegation, status, resolvedAt = null, metadata = null } = {}) {
  validateAgreementDelegationV1(delegation);
  const nextStatus = normalizeStatus(status, "status");
  const at = resolvedAt ?? new Date().toISOString();
  assertIsoDate(at, "resolvedAt");
  if (nextStatus === AGREEMENT_DELEGATION_STATUS.ACTIVE) throw new TypeError("cannot resolve delegation to active");
  const currentStatus = String(delegation.status ?? "").toLowerCase();
  if (currentStatus !== AGREEMENT_DELEGATION_STATUS.ACTIVE) return delegation;

  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : null;
  const next = {
    ...delegation,
    status: nextStatus,
    resolvedAt: at,
    revision: Number(delegation.revision ?? 0) + 1,
    updatedAt: at
  };
  if (meta) next.metadata = normalizeForCanonicalJson(meta, { path: "$.metadata" });
  return normalizeForCanonicalJson(next, { path: "$" });
}

function indexDelegations(delegations) {
  const byChild = new Map();
  const childrenByParent = new Map();
  for (const d of Array.isArray(delegations) ? delegations : []) {
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    const status = String(d.status ?? "").toLowerCase();
    if (status === AGREEMENT_DELEGATION_STATUS.REVOKED) continue;
    const parent = typeof d.parentAgreementHash === "string" ? d.parentAgreementHash.toLowerCase() : null;
    const child = typeof d.childAgreementHash === "string" ? d.childAgreementHash.toLowerCase() : null;
    if (!parent || !child) continue;

    if (byChild.has(child) && byChild.get(child)?.parentAgreementHash !== parent) {
      const err = new Error("multiple parents found for childAgreementHash");
      err.code = "AGREEMENT_DELEGATION_MULTIPLE_PARENTS";
      err.childAgreementHash = child;
      throw err;
    }
    byChild.set(child, { delegationId: d.delegationId ?? null, parentAgreementHash: parent, childAgreementHash: child });

    const list = childrenByParent.get(parent) ?? [];
    list.push({ delegationId: d.delegationId ?? null, parentAgreementHash: parent, childAgreementHash: child });
    childrenByParent.set(parent, list);
  }
  for (const [p, list] of childrenByParent.entries()) {
    list.sort((a, b) => String(a.childAgreementHash).localeCompare(String(b.childAgreementHash)));
    childrenByParent.set(p, list);
  }
  return { byChild, childrenByParent };
}

// Read-only: returns a deterministic "plan" for the caller to execute.
export function cascadeSettlementCheck({ delegations, fromChildHash } = {}) {
  const start = normalizeHexHash(fromChildHash, "fromChildHash");
  const { byChild } = indexDelegations(delegations);
  const parents = [];
  const edges = [];
  const seen = new Set([start]);
  let cursor = start;
  while (true) {
    const link = byChild.get(cursor) ?? null;
    if (!link) break;
    const parent = link.parentAgreementHash;
    if (seen.has(parent)) {
      const err = new Error("cycle detected in delegation graph");
      err.code = "AGREEMENT_DELEGATION_CYCLE";
      err.agreementHash = parent;
      throw err;
    }
    seen.add(parent);
    edges.push({ delegationId: link.delegationId ?? null, childAgreementHash: cursor, parentAgreementHash: parent });
    parents.push(parent);
    cursor = parent;
  }
  return normalizeForCanonicalJson(
    {
      ok: true,
      kind: "cascade_settlement_check_v1",
      fromChildHash: start,
      parentAgreementHashes: parents,
      edges
    },
    { path: "$" }
  );
}

// Read-only: returns a deterministic "plan" for the caller to execute.
export function refundUnwindCheck({ delegations, fromParentHash } = {}) {
  const start = normalizeHexHash(fromParentHash, "fromParentHash");
  const { childrenByParent } = indexDelegations(delegations);
  const orderedChildren = [];
  const edges = [];
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const parent = queue.shift();
    const children = childrenByParent.get(parent) ?? [];
    for (const link of children) {
      const child = link.childAgreementHash;
      edges.push({ delegationId: link.delegationId ?? null, parentAgreementHash: parent, childAgreementHash: child });
      if (seen.has(child)) continue;
      seen.add(child);
      orderedChildren.push(child);
      queue.push(child);
    }
  }
  return normalizeForCanonicalJson(
    {
      ok: true,
      kind: "refund_unwind_check_v1",
      fromParentHash: start,
      childAgreementHashes: orderedChildren,
      edges
    },
    { path: "$" }
  );
}

