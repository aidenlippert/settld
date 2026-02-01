import { ENV_TIER } from "./booking.js";

export const COVERAGE_FEE_MODEL = Object.freeze({
  PER_JOB: "PER_JOB"
});

export const CREDIT_FUNDING_MODEL = Object.freeze({
  PLATFORM_EXPENSE: "PLATFORM_EXPENSE",
  COVERAGE_RESERVE: "COVERAGE_RESERVE",
  OPERATOR_CHARGEBACK: "OPERATOR_CHARGEBACK",
  INSURER_RECOVERABLE: "INSURER_RECOVERABLE"
});

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertSafeInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

const ENV_TIERS = new Set(Object.values(ENV_TIER));
const COVERAGE_FEE_MODELS = new Set(Object.values(COVERAGE_FEE_MODEL));
const CREDIT_FUNDING_MODELS = new Set(Object.values(CREDIT_FUNDING_MODEL));

export function createDefaultContract({ tenantId, nowIso = () => new Date().toISOString() }) {
  assertNonEmptyString(tenantId, "tenantId");
  const now = nowIso();
  const t = Date.parse(now);
  if (!Number.isFinite(t)) throw new TypeError("nowIso() must return an ISO date string");
  return {
    tenantId,
    contractId: "contract_default",
    contractVersion: 1,
    name: "Default Contract",
    customerId: null,
    siteId: null,
    templateId: null,
    isDefault: true,
    policies: {
      slaOverridesByEnvironmentTier: {},
      proofPolicy: {
        gateMode: "warn",
        zoneCoverage: { thresholdPct: 95, allowExtraZones: false, excuseIncidentTypes: ["BLOCKED_ZONE"] },
        insufficientEvidenceBehavior: { mode: "ALLOW", holdPercent: 0 },
        disputeWindowDays: 0,
        allowReproofAfterSettlementWithinDisputeWindow: false
      },
      creditPolicy: { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" },
      evidencePolicy: { retentionDays: 0 },
      claimPolicy: { currency: "USD", autoApproveThresholdCents: 0, maxPayoutCents: 0, reservePercent: 0 },
      coveragePolicy: {
        required: false,
        coverageTierId: null,
        feeModel: COVERAGE_FEE_MODEL.PER_JOB,
        feeCentsPerJob: 0,
        creditFundingModel: CREDIT_FUNDING_MODEL.PLATFORM_EXPENSE,
        reserveFundPercent: 100,
        insurerId: null,
        recoverablePercent: 100,
        recoverableTerms: null,
        responseSlaSeconds: 0,
        includedAssistSeconds: 0,
        overageRateCentsPerMinute: 0
      }
    },
    createdAt: now,
    updatedAt: now
  };
}

export function validateContract(contract) {
  assertPlainObject(contract, "contract");
  const allowed = new Set([
    "tenantId",
    "contractId",
    "contractVersion",
    "name",
    "customerId",
    "siteId",
    "templateId",
    "isDefault",
    "policies",
    "createdAt",
    "updatedAt"
  ]);
  for (const key of Object.keys(contract)) {
    if (!allowed.has(key)) throw new TypeError(`contract contains unknown field: ${key}`);
  }

  assertNonEmptyString(contract.tenantId, "contract.tenantId");
  assertNonEmptyString(contract.contractId, "contract.contractId");
  assertSafeInt(contract.contractVersion, "contract.contractVersion");
  if (contract.contractVersion <= 0) throw new TypeError("contract.contractVersion must be > 0");
  assertNonEmptyString(contract.name, "contract.name");

  if (contract.customerId !== undefined && contract.customerId !== null) assertNonEmptyString(contract.customerId, "contract.customerId");
  if (contract.siteId !== undefined && contract.siteId !== null) assertNonEmptyString(contract.siteId, "contract.siteId");
  if (contract.templateId !== undefined && contract.templateId !== null) assertNonEmptyString(contract.templateId, "contract.templateId");
  if (contract.isDefault !== undefined && typeof contract.isDefault !== "boolean") throw new TypeError("contract.isDefault must be a boolean");

  assertPlainObject(contract.policies, "contract.policies");
  const policiesAllowed = new Set(["slaOverridesByEnvironmentTier", "proofPolicy", "creditPolicy", "evidencePolicy", "claimPolicy", "coveragePolicy"]);
  for (const key of Object.keys(contract.policies)) {
    if (!policiesAllowed.has(key)) throw new TypeError(`contract.policies contains unknown field: ${key}`);
  }

  if (contract.policies.slaOverridesByEnvironmentTier !== undefined) {
    assertPlainObject(contract.policies.slaOverridesByEnvironmentTier, "contract.policies.slaOverridesByEnvironmentTier");
    for (const [tier, override] of Object.entries(contract.policies.slaOverridesByEnvironmentTier)) {
      assertNonEmptyString(tier, "contract.policies.slaOverridesByEnvironmentTier key");
      if (!ENV_TIERS.has(tier)) throw new TypeError(`unsupported environment tier in SLA overrides: ${tier}`);
      assertPlainObject(override, `contract.policies.slaOverridesByEnvironmentTier.${tier}`);
      const overrideAllowed = new Set(["mustStartWithinWindow", "maxStallMs", "maxExecutionMs"]);
      for (const key of Object.keys(override)) {
        if (!overrideAllowed.has(key)) throw new TypeError(`SLA override contains unknown field: ${key}`);
      }
      if (override.mustStartWithinWindow !== undefined && typeof override.mustStartWithinWindow !== "boolean") {
        throw new TypeError("SLA override mustStartWithinWindow must be boolean");
      }
      if (override.maxStallMs !== undefined) {
        assertSafeInt(override.maxStallMs, "SLA override maxStallMs");
        if (override.maxStallMs <= 0) throw new TypeError("SLA override maxStallMs must be > 0");
      }
      if (override.maxExecutionMs !== undefined) {
        assertSafeInt(override.maxExecutionMs, "SLA override maxExecutionMs");
        if (override.maxExecutionMs <= 0) throw new TypeError("SLA override maxExecutionMs must be > 0");
      }
    }
  }

  assertPlainObject(contract.policies.creditPolicy, "contract.policies.creditPolicy");
  const creditAllowed = new Set(["enabled", "defaultAmountCents", "maxAmountCents", "currency", "ladder"]);
  for (const key of Object.keys(contract.policies.creditPolicy)) {
    if (!creditAllowed.has(key)) throw new TypeError(`contract.policies.creditPolicy contains unknown field: ${key}`);
  }
  if (typeof contract.policies.creditPolicy.enabled !== "boolean") throw new TypeError("creditPolicy.enabled must be a boolean");
  assertSafeInt(contract.policies.creditPolicy.defaultAmountCents, "creditPolicy.defaultAmountCents");
  if (contract.policies.creditPolicy.defaultAmountCents < 0) throw new TypeError("creditPolicy.defaultAmountCents must be >= 0");
  assertSafeInt(contract.policies.creditPolicy.maxAmountCents, "creditPolicy.maxAmountCents");
  if (contract.policies.creditPolicy.maxAmountCents < 0) throw new TypeError("creditPolicy.maxAmountCents must be >= 0");
  assertNonEmptyString(contract.policies.creditPolicy.currency, "creditPolicy.currency");
  if (contract.policies.creditPolicy.currency !== "USD") throw new TypeError("creditPolicy.currency is not supported");
  if (contract.policies.creditPolicy.maxAmountCents > 0 && contract.policies.creditPolicy.defaultAmountCents > contract.policies.creditPolicy.maxAmountCents) {
    throw new TypeError("creditPolicy.defaultAmountCents must be <= maxAmountCents when maxAmountCents > 0");
  }
  if (contract.policies.creditPolicy.ladder !== undefined && contract.policies.creditPolicy.ladder !== null) {
    if (!Array.isArray(contract.policies.creditPolicy.ladder)) throw new TypeError("creditPolicy.ladder must be an array");
    const allowedTier = new Set(["latenessMsGte", "amountCents"]);
    let last = -1;
    for (let i = 0; i < contract.policies.creditPolicy.ladder.length; i += 1) {
      const tier = contract.policies.creditPolicy.ladder[i];
      assertPlainObject(tier, `creditPolicy.ladder[${i}]`);
      for (const key of Object.keys(tier)) {
        if (!allowedTier.has(key)) throw new TypeError(`creditPolicy.ladder[${i}] contains unknown field: ${key}`);
      }
      assertSafeInt(tier.latenessMsGte, `creditPolicy.ladder[${i}].latenessMsGte`);
      if (tier.latenessMsGte < 0) throw new TypeError("creditPolicy.ladder latenessMsGte must be >= 0");
      assertSafeInt(tier.amountCents, `creditPolicy.ladder[${i}].amountCents`);
      if (tier.amountCents < 0) throw new TypeError("creditPolicy.ladder amountCents must be >= 0");
      if (tier.latenessMsGte <= last) throw new TypeError("creditPolicy.ladder must be strictly increasing by latenessMsGte");
      last = tier.latenessMsGte;
      if (contract.policies.creditPolicy.maxAmountCents > 0 && tier.amountCents > contract.policies.creditPolicy.maxAmountCents) {
        throw new TypeError("creditPolicy.ladder amountCents must be <= maxAmountCents when maxAmountCents > 0");
      }
    }
  }

  assertPlainObject(contract.policies.evidencePolicy, "contract.policies.evidencePolicy");
  const evAllowed = new Set(["retentionDays"]);
  for (const key of Object.keys(contract.policies.evidencePolicy)) {
    if (!evAllowed.has(key)) throw new TypeError(`contract.policies.evidencePolicy contains unknown field: ${key}`);
  }
  assertSafeInt(contract.policies.evidencePolicy.retentionDays, "evidencePolicy.retentionDays");
  if (contract.policies.evidencePolicy.retentionDays < 0) throw new TypeError("evidencePolicy.retentionDays must be >= 0");

  if (contract.policies.proofPolicy !== undefined && contract.policies.proofPolicy !== null) {
    assertPlainObject(contract.policies.proofPolicy, "contract.policies.proofPolicy");
    const allowedProof = new Set(["gateMode", "zoneCoverage", "insufficientEvidenceBehavior", "disputeWindowDays", "allowReproofAfterSettlementWithinDisputeWindow"]);
    for (const key of Object.keys(contract.policies.proofPolicy)) {
      if (!allowedProof.has(key)) throw new TypeError(`contract.policies.proofPolicy contains unknown field: ${key}`);
    }

    const gateMode = contract.policies.proofPolicy.gateMode ?? "warn";
    assertNonEmptyString(gateMode, "proofPolicy.gateMode");
    if (!new Set(["warn", "strict", "holdback"]).has(gateMode)) throw new TypeError("proofPolicy.gateMode is not supported");

    const zc = contract.policies.proofPolicy.zoneCoverage ?? null;
    if (zc !== null && zc !== undefined) {
      assertPlainObject(zc, "proofPolicy.zoneCoverage");
      const allowedZc = new Set(["thresholdPct", "allowExtraZones", "excuseIncidentTypes"]);
      for (const key of Object.keys(zc)) {
        if (!allowedZc.has(key)) throw new TypeError(`proofPolicy.zoneCoverage contains unknown field: ${key}`);
      }
      const thresholdPct = zc.thresholdPct ?? 95;
      if (!Number.isSafeInteger(thresholdPct) || thresholdPct < 0 || thresholdPct > 100) {
        throw new TypeError("proofPolicy.zoneCoverage.thresholdPct must be an integer in range 0..100");
      }
      if (zc.allowExtraZones !== undefined && typeof zc.allowExtraZones !== "boolean") {
        throw new TypeError("proofPolicy.zoneCoverage.allowExtraZones must be a boolean");
      }
      if (zc.excuseIncidentTypes !== undefined && zc.excuseIncidentTypes !== null) {
        if (!Array.isArray(zc.excuseIncidentTypes)) throw new TypeError("proofPolicy.zoneCoverage.excuseIncidentTypes must be an array");
        for (const t of zc.excuseIncidentTypes) assertNonEmptyString(t, "proofPolicy.zoneCoverage.excuseIncidentTypes[]");
      }
    }

    const ieb = contract.policies.proofPolicy.insufficientEvidenceBehavior ?? null;
    if (ieb !== null && ieb !== undefined) {
      assertPlainObject(ieb, "proofPolicy.insufficientEvidenceBehavior");
      const allowedIeb = new Set(["mode", "holdPercent"]);
      for (const key of Object.keys(ieb)) {
        if (!allowedIeb.has(key)) throw new TypeError(`proofPolicy.insufficientEvidenceBehavior contains unknown field: ${key}`);
      }
      const mode = ieb.mode ?? "ALLOW";
      assertNonEmptyString(mode, "proofPolicy.insufficientEvidenceBehavior.mode");
      if (!new Set(["ALLOW", "BLOCK_EXPORT", "SETTLE_ZERO", "HOLD_PERCENT"]).has(mode)) {
        throw new TypeError("proofPolicy.insufficientEvidenceBehavior.mode is not supported");
      }
      const holdPercent = ieb.holdPercent ?? 0;
      if (!Number.isSafeInteger(holdPercent) || holdPercent < 0 || holdPercent > 100) {
        throw new TypeError("proofPolicy.insufficientEvidenceBehavior.holdPercent must be an integer 0..100");
      }
    }

    const disputeWindowDays = contract.policies.proofPolicy.disputeWindowDays ?? 0;
    if (!Number.isSafeInteger(disputeWindowDays) || disputeWindowDays < 0 || disputeWindowDays > 365) {
      throw new TypeError("proofPolicy.disputeWindowDays must be an integer 0..365");
    }
    const allowReproofAfterSettlementWithinDisputeWindow = contract.policies.proofPolicy.allowReproofAfterSettlementWithinDisputeWindow ?? false;
    if (allowReproofAfterSettlementWithinDisputeWindow !== undefined && typeof allowReproofAfterSettlementWithinDisputeWindow !== "boolean") {
      throw new TypeError("proofPolicy.allowReproofAfterSettlementWithinDisputeWindow must be a boolean");
    }
  }

  if (contract.policies.claimPolicy !== undefined) {
    assertPlainObject(contract.policies.claimPolicy, "contract.policies.claimPolicy");
    const claimAllowed = new Set(["currency", "autoApproveThresholdCents", "maxPayoutCents", "reservePercent"]);
    for (const key of Object.keys(contract.policies.claimPolicy)) {
      if (!claimAllowed.has(key)) throw new TypeError(`contract.policies.claimPolicy contains unknown field: ${key}`);
    }
    assertNonEmptyString(contract.policies.claimPolicy.currency, "claimPolicy.currency");
    if (contract.policies.claimPolicy.currency !== "USD") throw new TypeError("claimPolicy.currency is not supported");
    assertSafeInt(contract.policies.claimPolicy.autoApproveThresholdCents, "claimPolicy.autoApproveThresholdCents");
    if (contract.policies.claimPolicy.autoApproveThresholdCents < 0) throw new TypeError("claimPolicy.autoApproveThresholdCents must be >= 0");
    assertSafeInt(contract.policies.claimPolicy.maxPayoutCents, "claimPolicy.maxPayoutCents");
    if (contract.policies.claimPolicy.maxPayoutCents < 0) throw new TypeError("claimPolicy.maxPayoutCents must be >= 0");
    assertSafeInt(contract.policies.claimPolicy.reservePercent, "claimPolicy.reservePercent");
    if (contract.policies.claimPolicy.reservePercent < 0 || contract.policies.claimPolicy.reservePercent > 100) {
      throw new TypeError("claimPolicy.reservePercent must be between 0 and 100");
    }
  }

  if (contract.policies.coveragePolicy !== undefined) {
    assertPlainObject(contract.policies.coveragePolicy, "contract.policies.coveragePolicy");
    const coverageAllowed = new Set([
      "required",
      "coverageTierId",
      "feeModel",
      "feeCentsPerJob",
      "creditFundingModel",
      "reserveFundPercent",
      "insurerId",
      "recoverablePercent",
      "recoverableTerms",
      "responseSlaSeconds",
      "includedAssistSeconds",
      "overageRateCentsPerMinute"
    ]);
    for (const key of Object.keys(contract.policies.coveragePolicy)) {
      if (!coverageAllowed.has(key)) throw new TypeError(`contract.policies.coveragePolicy contains unknown field: ${key}`);
    }
    if (typeof contract.policies.coveragePolicy.required !== "boolean") throw new TypeError("coveragePolicy.required must be a boolean");
    if (contract.policies.coveragePolicy.coverageTierId !== undefined && contract.policies.coveragePolicy.coverageTierId !== null) {
      assertNonEmptyString(contract.policies.coveragePolicy.coverageTierId, "coveragePolicy.coverageTierId");
    }
    if (contract.policies.coveragePolicy.feeModel !== undefined && contract.policies.coveragePolicy.feeModel !== null) {
      assertNonEmptyString(contract.policies.coveragePolicy.feeModel, "coveragePolicy.feeModel");
      if (!COVERAGE_FEE_MODELS.has(contract.policies.coveragePolicy.feeModel)) throw new TypeError("coveragePolicy.feeModel is not supported");
    }
    if (contract.policies.coveragePolicy.feeCentsPerJob !== undefined && contract.policies.coveragePolicy.feeCentsPerJob !== null) {
      assertSafeInt(contract.policies.coveragePolicy.feeCentsPerJob, "coveragePolicy.feeCentsPerJob");
      if (contract.policies.coveragePolicy.feeCentsPerJob < 0) throw new TypeError("coveragePolicy.feeCentsPerJob must be >= 0");
    }
    if (contract.policies.coveragePolicy.creditFundingModel !== undefined && contract.policies.coveragePolicy.creditFundingModel !== null) {
      assertNonEmptyString(contract.policies.coveragePolicy.creditFundingModel, "coveragePolicy.creditFundingModel");
      if (!CREDIT_FUNDING_MODELS.has(contract.policies.coveragePolicy.creditFundingModel)) {
        throw new TypeError("coveragePolicy.creditFundingModel is not supported");
      }
    }
    if (contract.policies.coveragePolicy.reserveFundPercent !== undefined && contract.policies.coveragePolicy.reserveFundPercent !== null) {
      assertSafeInt(contract.policies.coveragePolicy.reserveFundPercent, "coveragePolicy.reserveFundPercent");
      if (contract.policies.coveragePolicy.reserveFundPercent < 0 || contract.policies.coveragePolicy.reserveFundPercent > 100) {
        throw new TypeError("coveragePolicy.reserveFundPercent must be between 0 and 100");
      }
    }
    if (contract.policies.coveragePolicy.insurerId !== undefined && contract.policies.coveragePolicy.insurerId !== null) {
      assertNonEmptyString(contract.policies.coveragePolicy.insurerId, "coveragePolicy.insurerId");
    }
    if (contract.policies.coveragePolicy.recoverablePercent !== undefined && contract.policies.coveragePolicy.recoverablePercent !== null) {
      assertSafeInt(contract.policies.coveragePolicy.recoverablePercent, "coveragePolicy.recoverablePercent");
      if (contract.policies.coveragePolicy.recoverablePercent < 0 || contract.policies.coveragePolicy.recoverablePercent > 100) {
        throw new TypeError("coveragePolicy.recoverablePercent must be between 0 and 100");
      }
    }
    if (contract.policies.coveragePolicy.recoverableTerms !== undefined && contract.policies.coveragePolicy.recoverableTerms !== null) {
      assertNonEmptyString(contract.policies.coveragePolicy.recoverableTerms, "coveragePolicy.recoverableTerms");
    }

    if (contract.policies.coveragePolicy.creditFundingModel === CREDIT_FUNDING_MODEL.INSURER_RECOVERABLE) {
      if (!contract.policies.coveragePolicy.insurerId) throw new TypeError("coveragePolicy.insurerId is required for INSURER_RECOVERABLE");
    }
    assertSafeInt(contract.policies.coveragePolicy.responseSlaSeconds, "coveragePolicy.responseSlaSeconds");
    if (contract.policies.coveragePolicy.responseSlaSeconds < 0) throw new TypeError("coveragePolicy.responseSlaSeconds must be >= 0");
    assertSafeInt(contract.policies.coveragePolicy.includedAssistSeconds, "coveragePolicy.includedAssistSeconds");
    if (contract.policies.coveragePolicy.includedAssistSeconds < 0) throw new TypeError("coveragePolicy.includedAssistSeconds must be >= 0");
    assertSafeInt(contract.policies.coveragePolicy.overageRateCentsPerMinute, "coveragePolicy.overageRateCentsPerMinute");
    if (contract.policies.coveragePolicy.overageRateCentsPerMinute < 0) throw new TypeError("coveragePolicy.overageRateCentsPerMinute must be >= 0");
  }

  if (contract.createdAt !== undefined && contract.createdAt !== null) assertNonEmptyString(contract.createdAt, "contract.createdAt");
  if (contract.updatedAt !== undefined && contract.updatedAt !== null) assertNonEmptyString(contract.updatedAt, "contract.updatedAt");

  return contract;
}

export function selectBestContract(contracts, { contractId = null, customerId = null, siteId = null, templateId = null } = {}) {
  if (!Array.isArray(contracts)) throw new TypeError("contracts must be an array");
  if (contractId !== null) assertNonEmptyString(contractId, "contractId");
  if (customerId !== null) assertNonEmptyString(customerId, "customerId");
  if (siteId !== null) assertNonEmptyString(siteId, "siteId");
  if (templateId !== null) assertNonEmptyString(templateId, "templateId");

  if (contractId) {
    const byId = contracts.find((c) => c?.contractId === contractId);
    if (byId) return byId;
  }

  // Deterministic precedence (founder decision):
  // 1) site + template
  // 2) site (all templates)
  // 3) customer + template
  // 4) customer (all templates)
  // 5) tenant + template
  // 6) tenant default
  const byContractId = (a, b) => String(a?.contractId ?? "").localeCompare(String(b?.contractId ?? ""));
  const pick = (arr) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort(byContractId);
    return sorted[0] ?? null;
  };

  const matchesCustomer = (c) => {
    if (!c?.customerId) return true;
    return customerId !== null && c.customerId === customerId;
  };

  const matchesSite = (c) => {
    if (!c?.siteId) return true;
    return siteId !== null && c.siteId === siteId;
  };

  const isTenantScoped = (c) => !c?.customerId && !c?.siteId;

  // 1) site + template
  if (siteId !== null && templateId !== null) {
    const c1 = contracts.filter((c) => c?.siteId === siteId && c?.templateId === templateId && matchesCustomer(c));
    const picked = pick(c1);
    if (picked) return picked;
  }

  // 2) site (all templates)
  if (siteId !== null) {
    const c2 = contracts.filter((c) => c?.siteId === siteId && (c?.templateId === null || c?.templateId === undefined) && matchesCustomer(c));
    const picked = pick(c2);
    if (picked) return picked;
  }

  // 3) customer + template
  if (customerId !== null && templateId !== null) {
    const c3 = contracts.filter(
      (c) => c?.customerId === customerId && (c?.siteId === null || c?.siteId === undefined) && c?.templateId === templateId
    );
    const picked = pick(c3);
    if (picked) return picked;
  }

  // 4) customer (all templates)
  if (customerId !== null) {
    const c4 = contracts.filter(
      (c) =>
        c?.customerId === customerId &&
        (c?.siteId === null || c?.siteId === undefined) &&
        (c?.templateId === null || c?.templateId === undefined)
    );
    const picked = pick(c4);
    if (picked) return picked;
  }

  // 5) tenant + template
  if (templateId !== null) {
    const c5 = contracts.filter((c) => isTenantScoped(c) && c?.templateId === templateId);
    const picked = pick(c5);
    if (picked) return picked;
  }

  // 6) tenant default
  const c6 = contracts.filter((c) => isTenantScoped(c) && c?.isDefault === true);
  const pickedDefault = pick(c6);
  if (pickedDefault) return pickedDefault;

  // Fallback: best-effort return any tenant-scoped contract (deterministic).
  const anyTenant = pick(contracts.filter((c) => matchesCustomer(c) && matchesSite(c)));
  return anyTenant;
}

export function applyContractSlaOverrides({ sla, environmentTier, contract }) {
  if (!sla || typeof sla !== "object") throw new TypeError("sla is required");
  assertNonEmptyString(environmentTier, "environmentTier");
  if (!contract) return sla;

  const overridesByTier = contract.policies?.slaOverridesByEnvironmentTier ?? {};
  const override = overridesByTier?.[environmentTier] ?? null;
  if (!override) return sla;

  return {
    ...sla,
    mustStartWithinWindow: override.mustStartWithinWindow ?? sla.mustStartWithinWindow,
    maxStallMs: override.maxStallMs ?? sla.maxStallMs,
    maxExecutionMs: override.maxExecutionMs ?? sla.maxExecutionMs
  };
}
