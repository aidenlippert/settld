import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";
import { validateContract } from "./contracts.js";

export const CONTRACT_DOCUMENT_TYPE_V1 = "ContractDocument.v1";
export const SPLIT_PLAN_TYPE_V1 = "SplitPlan.v1";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNullableNonEmptyString(value, name) {
  if (value === null || value === undefined) return;
  assertNonEmptyString(value, name);
}

function assertOptionalIsoDate(value, name) {
  if (value === null || value === undefined) return;
  assertNonEmptyString(value, name);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new TypeError(`${name} must be an ISO date string`);
}

export function validateContractDocumentV1(doc) {
  assertPlainObject(doc, "contractDoc");
  const allowed = new Set([
    "type",
    "v",
    "contractId",
    "contractVersion",
    "name",
    "parties",
    "scope",
    "policies",
    "effective",
    "connect"
  ]);
  for (const k of Object.keys(doc)) {
    if (!allowed.has(k)) throw new TypeError(`contractDoc contains unknown field: ${k}`);
  }

  if (doc.type !== CONTRACT_DOCUMENT_TYPE_V1) throw new TypeError("contractDoc.type is not supported");
  if (doc.v !== 1) throw new TypeError("contractDoc.v is not supported");

  assertNonEmptyString(doc.contractId, "contractDoc.contractId");
  if (!Number.isSafeInteger(doc.contractVersion) || doc.contractVersion <= 0) throw new TypeError("contractDoc.contractVersion must be > 0");
  assertNonEmptyString(doc.name, "contractDoc.name");

  if (doc.parties !== undefined) {
    assertPlainObject(doc.parties, "contractDoc.parties");
    const allowedRoles = new Set(["platform", "operator", "customer"]);
    for (const [role, party] of Object.entries(doc.parties)) {
      if (!allowedRoles.has(role)) throw new TypeError(`contractDoc.parties contains unknown role: ${role}`);
      assertPlainObject(party, `contractDoc.parties.${role}`);
      const allowedParty = new Set(["partyId", "requiresSignature"]);
      for (const k of Object.keys(party)) {
        if (!allowedParty.has(k)) throw new TypeError(`contractDoc.parties.${role} contains unknown field: ${k}`);
      }
      assertNonEmptyString(party.partyId, `contractDoc.parties.${role}.partyId`);
      if (typeof party.requiresSignature !== "boolean") throw new TypeError(`contractDoc.parties.${role}.requiresSignature must be boolean`);
    }
  }

  if (doc.effective !== undefined) {
    assertPlainObject(doc.effective, "contractDoc.effective");
    const allowedEff = new Set(["from", "to"]);
    for (const k of Object.keys(doc.effective)) {
      if (!allowedEff.has(k)) throw new TypeError(`contractDoc.effective contains unknown field: ${k}`);
    }
    assertOptionalIsoDate(doc.effective.from, "contractDoc.effective.from");
    assertOptionalIsoDate(doc.effective.to, "contractDoc.effective.to");
  }

  if (doc.scope !== undefined) {
    assertPlainObject(doc.scope, "contractDoc.scope");
    const allowedScope = new Set(["customerId", "siteId", "templateId", "zoneId", "skillId", "isDefault"]);
    for (const k of Object.keys(doc.scope)) {
      if (!allowedScope.has(k)) throw new TypeError(`contractDoc.scope contains unknown field: ${k}`);
    }
    assertNullableNonEmptyString(doc.scope.customerId, "contractDoc.scope.customerId");
    assertNullableNonEmptyString(doc.scope.siteId, "contractDoc.scope.siteId");
    assertNullableNonEmptyString(doc.scope.templateId, "contractDoc.scope.templateId");
    assertNullableNonEmptyString(doc.scope.zoneId, "contractDoc.scope.zoneId");
    assertNullableNonEmptyString(doc.scope.skillId, "contractDoc.scope.skillId");
    if (doc.scope.isDefault !== undefined && typeof doc.scope.isDefault !== "boolean") throw new TypeError("contractDoc.scope.isDefault must be boolean");
  }

  assertPlainObject(doc.policies, "contractDoc.policies");

  if (doc.connect !== undefined) {
    assertPlainObject(doc.connect, "contractDoc.connect");
    const allowedConnect = new Set(["enabled", "splitPlan"]);
    for (const k of Object.keys(doc.connect)) {
      if (!allowedConnect.has(k)) throw new TypeError(`contractDoc.connect contains unknown field: ${k}`);
    }
    if (typeof doc.connect.enabled !== "boolean") throw new TypeError("contractDoc.connect.enabled must be boolean");
    if (doc.connect.splitPlan !== undefined && doc.connect.splitPlan !== null) {
      validateSplitPlanV1(doc.connect.splitPlan);
    }
  }

  // Reuse the legacy contract validator to ensure policies are structurally sane.
  // (We intentionally exclude timestamps from the hashed document.)
  validateContract({
    tenantId: "tenant_default",
    contractId: doc.contractId,
    contractVersion: doc.contractVersion,
    name: doc.name,
    customerId: doc.scope?.customerId ?? null,
    siteId: doc.scope?.siteId ?? null,
    templateId: doc.scope?.templateId ?? null,
    isDefault: doc.scope?.isDefault === true,
    policies: doc.policies,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  return doc;
}

export function validateSplitPlanV1(splitPlan) {
  assertPlainObject(splitPlan, "splitPlan");
  const allowed = new Set(["type", "v", "currency", "rules"]);
  for (const k of Object.keys(splitPlan)) {
    if (!allowed.has(k)) throw new TypeError(`splitPlan contains unknown field: ${k}`);
  }
  if (splitPlan.type !== SPLIT_PLAN_TYPE_V1) throw new TypeError("splitPlan.type is not supported");
  if (splitPlan.v !== 1) throw new TypeError("splitPlan.v is not supported");
  assertNonEmptyString(splitPlan.currency, "splitPlan.currency");
  if (splitPlan.currency !== "USD") throw new TypeError("splitPlan.currency is not supported");
  if (!Array.isArray(splitPlan.rules)) throw new TypeError("splitPlan.rules must be an array");

  const allowedRoles = new Set(["platform", "operator", "customer", "subcontractor", "insurer"]);
  const allowedShareTypes = new Set(["percentage", "fixed", "remainder"]);
  const allowedAppliesTo = new Set(["gross", "net_after_credits", "credits"]);

  for (let i = 0; i < splitPlan.rules.length; i += 1) {
    const rule = splitPlan.rules[i];
    assertPlainObject(rule, `splitPlan.rules[${i}]`);
    const allowedRule = new Set(["partyRole", "partyId", "share", "appliesTo"]);
    for (const k of Object.keys(rule)) {
      if (!allowedRule.has(k)) throw new TypeError(`splitPlan.rules[${i}] contains unknown field: ${k}`);
    }
    assertNonEmptyString(rule.partyRole, `splitPlan.rules[${i}].partyRole`);
    if (!allowedRoles.has(rule.partyRole)) throw new TypeError(`splitPlan.rules[${i}].partyRole is not supported`);
    if (rule.partyId !== undefined && rule.partyId !== null) assertNonEmptyString(rule.partyId, `splitPlan.rules[${i}].partyId`);
    assertPlainObject(rule.share, `splitPlan.rules[${i}].share`);
    const allowedShare = new Set(["type", "valueBasisPoints", "valueCents"]);
    for (const k of Object.keys(rule.share)) {
      if (!allowedShare.has(k)) throw new TypeError(`splitPlan.rules[${i}].share contains unknown field: ${k}`);
    }
    assertNonEmptyString(rule.share.type, `splitPlan.rules[${i}].share.type`);
    if (!allowedShareTypes.has(rule.share.type)) throw new TypeError(`splitPlan.rules[${i}].share.type is not supported`);
    if (rule.share.type === "percentage") {
      if (!Number.isSafeInteger(rule.share.valueBasisPoints)) throw new TypeError(`splitPlan.rules[${i}].share.valueBasisPoints is required`);
      if (rule.share.valueBasisPoints < 0 || rule.share.valueBasisPoints > 10000) throw new TypeError("splitPlan share basis points must be 0..10000");
    }
    if (rule.share.type === "fixed") {
      if (!Number.isSafeInteger(rule.share.valueCents)) throw new TypeError(`splitPlan.rules[${i}].share.valueCents is required`);
    }
    if (rule.share.type === "remainder") {
      // no additional fields
    }
    if (rule.appliesTo !== undefined && rule.appliesTo !== null) {
      assertNonEmptyString(rule.appliesTo, `splitPlan.rules[${i}].appliesTo`);
      if (!allowedAppliesTo.has(rule.appliesTo)) throw new TypeError(`splitPlan.rules[${i}].appliesTo is not supported`);
    }
  }

  return splitPlan;
}

export function hashSplitPlanV1(splitPlan) {
  const normalized = normalizeForCanonicalJson(validateSplitPlanV1(splitPlan), { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function normalizeContractDocumentV1(doc) {
  validateContractDocumentV1(doc);
  return normalizeForCanonicalJson(doc, { path: "$" });
}

export function hashContractDocumentV1(doc) {
  const normalized = normalizeContractDocumentV1(doc);
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function contractDocumentV1FromLegacyContract(contract) {
  if (!contract || typeof contract !== "object") throw new TypeError("contract is required");
  const contractId = contract.contractId ?? contract.id ?? null;
  const contractVersion = contract.contractVersion ?? contract.version ?? null;
  const name = contract.name ?? contractId ?? null;
  if (typeof contractId !== "string" || !contractId.trim()) throw new TypeError("contract.contractId is required");
  if (!Number.isSafeInteger(contractVersion) || contractVersion <= 0) throw new TypeError("contract.contractVersion must be > 0");
  if (typeof name !== "string" || !name.trim()) throw new TypeError("contract.name is required");

  const doc = {
    type: CONTRACT_DOCUMENT_TYPE_V1,
    v: 1,
    contractId: String(contractId),
    contractVersion: Number(contractVersion),
    name: String(name),
    parties: {
      platform: { partyId: "pty_platform", requiresSignature: false },
      operator: { partyId: "pty_operator", requiresSignature: false },
      customer: { partyId: "pty_customer", requiresSignature: false }
    },
    scope: {
      customerId: contract.customerId ?? null,
      siteId: contract.siteId ?? null,
      templateId: contract.templateId ?? null,
      zoneId: null,
      skillId: null,
      isDefault: contract.isDefault === true
    },
    policies: contract.policies ?? {}
  };
  return normalizeContractDocumentV1(doc);
}
