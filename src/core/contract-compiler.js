import { buildPolicySnapshot, computePolicyHash } from "./policy.js";
import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";
import { hashSplitPlanV1 } from "./contract-document.js";

export const CONTRACT_COMPILER_ID = "contract_compiler.v1";
export const CONTRACT_POLICY_TEMPLATE_VERSION = "ContractPolicyTemplate.v1";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function compileBookingPolicySnapshot({
  contractDoc,
  environmentTier,
  requiresOperatorCoverage,
  sla,
  proofPolicy,
  creditPolicy,
  evidencePolicy,
  claimPolicy,
  coveragePolicy
} = {}) {
  assertPlainObject(contractDoc, "contractDoc");

  const policySnapshot = buildPolicySnapshot({
    contractId: contractDoc.contractId ?? null,
    contractVersion: contractDoc.contractVersion ?? null,
    environmentTier,
    requiresOperatorCoverage,
    sla,
    proofPolicy: proofPolicy ?? contractDoc?.policies?.proofPolicy ?? null,
    creditPolicy,
    evidencePolicy,
    claimPolicy: claimPolicy ?? null,
    coveragePolicy: coveragePolicy ?? null
  });

  const policyHash = computePolicyHash(policySnapshot);
  return { policySnapshot, policyHash, compilerId: CONTRACT_COMPILER_ID, diagnostics: [] };
}

export function compileContractPolicyTemplate({ contractDoc } = {}) {
  assertPlainObject(contractDoc, "contractDoc");
  const connectEnabled = contractDoc?.connect?.enabled === true;
  const splitPlanHash =
    connectEnabled && contractDoc?.connect?.splitPlan
      ? hashSplitPlanV1(contractDoc.connect.splitPlan)
      : null;
  const template = normalizeForCanonicalJson(
    {
      schemaVersion: CONTRACT_POLICY_TEMPLATE_VERSION,
      contractId: contractDoc.contractId ?? null,
      contractVersion: contractDoc.contractVersion ?? null,
      policies: contractDoc.policies ?? null,
      connect: {
        enabled: connectEnabled,
        splitPlanHash
      }
    },
    { path: "$" }
  );
  const policyHash = sha256Hex(canonicalJsonStringify(template));
  return { policyTemplate: template, policyHash, compilerId: CONTRACT_COMPILER_ID, diagnostics: [] };
}
