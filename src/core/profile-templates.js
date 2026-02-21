export const PROFILE_SCHEMA_VERSION = "SettldProfile.v1";
export const PROFILE_TEMPLATE_CATALOG_VERSION = "SettldProfileTemplateCatalog.v1";

const STARTER_PROFILES = Object.freeze([
  Object.freeze({
    profileId: "engineering-spend",
    metadata: Object.freeze({
      name: "Engineering Spend",
      vertical: "engineering",
      description: "Policy defaults for software/tooling spend with tiered approvals."
    }),
    policyDefaults: Object.freeze({
      currency: "USD",
      limits: Object.freeze({
        perRequestUsdCents: 300_000,
        monthlyUsdCents: 1_500_000
      }),
      allowlists: Object.freeze({
        providers: Object.freeze(["anthropic", "aws", "openai"]),
        tools: Object.freeze(["ci.compute", "llm.inference", "observability.logs"])
      }),
      approvalTiers: Object.freeze([
        Object.freeze({ tierId: "auto", maxAmountUsdCents: 50_000, requiredApprovers: 0, approverRole: "none" }),
        Object.freeze({ tierId: "manager", maxAmountUsdCents: 150_000, requiredApprovers: 1, approverRole: "engineering_manager" }),
        Object.freeze({ tierId: "director", maxAmountUsdCents: 300_000, requiredApprovers: 2, approverRole: "engineering_director" })
      ]),
      disputeDefaults: Object.freeze({
        responseWindowHours: 72,
        autoOpenIfReceiptMissing: true,
        evidenceChecklist: Object.freeze(["approval_log", "policy_trace", "receipt"])
      }),
      compliance: Object.freeze({
        enforceVendorAllowlist: true,
        requireReceiptSignature: true,
        requireToolManifestHash: true,
        allowUnknownToolVersion: false
      })
    })
  }),
  Object.freeze({
    profileId: "procurement",
    metadata: Object.freeze({
      name: "Procurement",
      vertical: "procurement",
      description: "Conservative enterprise purchasing profile with stricter approvals."
    }),
    policyDefaults: Object.freeze({
      currency: "USD",
      limits: Object.freeze({
        perRequestUsdCents: 500_000,
        monthlyUsdCents: 4_000_000
      }),
      allowlists: Object.freeze({
        providers: Object.freeze(["aws", "azure", "gcp", "stripe"]),
        tools: Object.freeze(["data.warehouse", "erp.connector", "invoice.automation"])
      }),
      approvalTiers: Object.freeze([
        Object.freeze({ tierId: "analyst", maxAmountUsdCents: 100_000, requiredApprovers: 1, approverRole: "procurement_analyst" }),
        Object.freeze({ tierId: "manager", maxAmountUsdCents: 300_000, requiredApprovers: 2, approverRole: "procurement_manager" }),
        Object.freeze({ tierId: "director", maxAmountUsdCents: 500_000, requiredApprovers: 3, approverRole: "finance_director" })
      ]),
      disputeDefaults: Object.freeze({
        responseWindowHours: 96,
        autoOpenIfReceiptMissing: true,
        evidenceChecklist: Object.freeze(["approval_log", "purchase_order", "receipt", "vendor_contract"])
      }),
      compliance: Object.freeze({
        enforceVendorAllowlist: true,
        requireReceiptSignature: true,
        requireToolManifestHash: true,
        allowUnknownToolVersion: false
      })
    })
  }),
  Object.freeze({
    profileId: "data-api-buyer",
    metadata: Object.freeze({
      name: "Data API Buyer",
      vertical: "data",
      description: "Profile defaults for teams buying usage-metered data/API calls."
    }),
    policyDefaults: Object.freeze({
      currency: "USD",
      limits: Object.freeze({
        perRequestUsdCents: 120_000,
        monthlyUsdCents: 900_000
      }),
      allowlists: Object.freeze({
        providers: Object.freeze(["exa", "openai", "serpapi"]),
        tools: Object.freeze(["data.extract", "search.query", "summarize.batch"])
      }),
      approvalTiers: Object.freeze([
        Object.freeze({ tierId: "auto", maxAmountUsdCents: 25_000, requiredApprovers: 0, approverRole: "none" }),
        Object.freeze({ tierId: "owner", maxAmountUsdCents: 80_000, requiredApprovers: 1, approverRole: "data_product_owner" }),
        Object.freeze({ tierId: "exec", maxAmountUsdCents: 120_000, requiredApprovers: 2, approverRole: "business_owner" })
      ]),
      disputeDefaults: Object.freeze({
        responseWindowHours: 48,
        autoOpenIfReceiptMissing: true,
        evidenceChecklist: Object.freeze(["approval_log", "receipt", "usage_export"])
      }),
      compliance: Object.freeze({
        enforceVendorAllowlist: true,
        requireReceiptSignature: true,
        requireToolManifestHash: true,
        allowUnknownToolVersion: false
      })
    })
  })
]);

function deepClone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

export function listProfileTemplates() {
  return STARTER_PROFILES.map((profile) => deepClone(profile));
}

export function getProfileTemplate({ profileId } = {}) {
  const id = String(profileId ?? "").trim();
  if (!id) throw new TypeError("profileId is required");
  const profile = STARTER_PROFILES.find((item) => item.profileId === id) ?? null;
  return profile ? deepClone(profile) : null;
}

export function createStarterProfile({ profileId } = {}) {
  const template = getProfileTemplate({ profileId });
  if (!template) return null;
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId: template.profileId,
    metadata: template.metadata,
    policy: template.policyDefaults
  };
}
