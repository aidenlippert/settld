import { normalizeForCanonicalJson } from "./canonical-json.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function normalizeBaseUrl(value) {
  assertNonEmptyString(value, "baseUrl");
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("baseUrl must use http or https");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function buildSettldAgentCard({
  baseUrl,
  version = null,
  protocols = ["SettlementKernel.v1"],
  bundleTypes = ["InvoiceBundle.v1", "ClosePack.v1", "JobProofBundle.v1", "MonthProofBundle.v1", "FinancePackBundle.v1"],
  paymentRails = ["internal_escrow", "circle_usdc"],
  disputeSupport = true,
  reputationQueries = true
} = {}) {
  const url = normalizeBaseUrl(baseUrl);
  const resolvedVersion = version === null || version === undefined || String(version).trim() === "" ? null : String(version).trim();
  const resolvedProtocols = Array.isArray(protocols) ? protocols.map((p) => String(p)).filter(Boolean) : [];
  const resolvedBundles = Array.isArray(bundleTypes) ? bundleTypes.map((b) => String(b)).filter(Boolean) : [];
  const resolvedRails = Array.isArray(paymentRails) ? paymentRails.map((r) => String(r)).filter(Boolean) : [];

  const card = {
    name: "settld-settlement-agent",
    description: "Settlement kernel for autonomous economic agreements (agreement -> evidence -> decision -> receipt -> dispute).",
    url,
    version: resolvedVersion,
    capabilities: {
      settlement: {
        protocols: resolvedProtocols,
        bundleTypes: resolvedBundles,
        paymentRails: resolvedRails,
        disputeSupport: disputeSupport === true,
        reputationQueries: reputationQueries === true
      }
    },
    skills: [
      { id: "create_agreement", description: "Create an agreement/run for a payable capability call." },
      { id: "submit_evidence", description: "Append evidence to a run event chain." },
      { id: "settle_run", description: "Mark a run completed/failed (triggers settlement evaluation)." },
      { id: "resolve_settlement", description: "Manually resolve a settlement (released/refunded)." },
      { id: "open_dispute", description: "Open a dispute within the dispute window." },
      { id: "query_reputation", description: "Query append-only reputation facts for a counterparty." }
    ],
    authentication: {
      schemes: [
        { type: "api_key", in: "header", name: "x-api-key" },
        { type: "ops_token", in: "header", name: "x-proxy-ops-token" }
      ]
    }
  };

  // Omit null version for cleaner discovery payloads.
  if (card.version === null) delete card.version;
  return normalizeForCanonicalJson(card, { path: "$" });
}
