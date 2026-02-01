import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const POLICY_SNAPSHOT_VERSION = "PolicySnapshot.v1";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertNullableNonEmptyString(value, name) {
  if (value === null || value === undefined) return;
  assertNonEmptyString(value, name);
}

function assertSafeInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

export function buildPolicySnapshot({
  contractId,
  contractVersion,
  environmentTier,
  requiresOperatorCoverage,
  sla,
  proofPolicy,
  creditPolicy,
  evidencePolicy,
  claimPolicy,
  coveragePolicy
} = {}) {
  assertNullableNonEmptyString(contractId, "contractId");
  if (contractVersion !== undefined && contractVersion !== null) {
    assertSafeInt(contractVersion, "contractVersion");
    if (contractVersion <= 0) throw new TypeError("contractVersion must be > 0");
  }

  assertNonEmptyString(environmentTier, "environmentTier");
  if (typeof requiresOperatorCoverage !== "boolean") throw new TypeError("requiresOperatorCoverage must be a boolean");

  assertPlainObject(sla, "sla");
  if (proofPolicy !== null && proofPolicy !== undefined) assertPlainObject(proofPolicy, "proofPolicy");
  assertPlainObject(creditPolicy, "creditPolicy");
  assertPlainObject(evidencePolicy, "evidencePolicy");
  if (claimPolicy !== null && claimPolicy !== undefined) assertPlainObject(claimPolicy, "claimPolicy");
  if (coveragePolicy !== null && coveragePolicy !== undefined) assertPlainObject(coveragePolicy, "coveragePolicy");

  const raw = {
    schemaVersion: POLICY_SNAPSHOT_VERSION,
    contractId: contractId ?? null,
    contractVersion: contractVersion ?? null,
    environmentTier,
    requiresOperatorCoverage,
    sla,
    proofPolicy: proofPolicy ?? null,
    creditPolicy,
    evidencePolicy,
    claimPolicy: claimPolicy ?? null,
    coveragePolicy: coveragePolicy ?? null
  };

  // Normalize (drops undefined fields) before hashing/storing.
  return normalizeForCanonicalJson(raw, { path: "$" });
}

export function computePolicyHash(policySnapshot) {
  assertPlainObject(policySnapshot, "policySnapshot");
  if (policySnapshot.schemaVersion !== POLICY_SNAPSHOT_VERSION) throw new TypeError("unsupported policySnapshot.schemaVersion");
  return sha256Hex(canonicalJsonStringify(policySnapshot));
}
