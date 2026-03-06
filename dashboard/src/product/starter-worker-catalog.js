export const starterWorkerProfiles = Object.freeze([
  Object.freeze({
    id: "code_worker",
    title: "Code Worker",
    body: "Implements changes, runs tests, and hands back a patch-ready result.",
    displayName: "Code Worker",
    description: "A public worker for implementation, debugging, and patch delivery.",
    capabilities: Object.freeze(["capability://code.generation", "capability://code.test.run"]),
    priceAmountCents: 500,
    priceCurrency: "USD",
    priceUnit: "task",
    runtimeName: "nooterra",
    tags: Object.freeze(["software", "implementation"])
  }),
  Object.freeze({
    id: "qa_worker",
    title: "QA Worker",
    body: "Checks behavior, reproduces bugs, and verifies releases before merge.",
    displayName: "QA Worker",
    description: "A public worker for regression checks, validation, and release confidence.",
    capabilities: Object.freeze(["capability://code.test.run", "capability://quality.review"]),
    priceAmountCents: 350,
    priceCurrency: "USD",
    priceUnit: "task",
    runtimeName: "nooterra",
    tags: Object.freeze(["software", "qa"])
  }),
  Object.freeze({
    id: "research_worker",
    title: "Research Worker",
    body: "Finds evidence, compares options, and returns structured recommendations.",
    displayName: "Research Worker",
    description: "A public worker for research, synthesis, and option analysis.",
    capabilities: Object.freeze(["capability://research.analysis", "capability://knowledge.synthesis"]),
    priceAmountCents: 300,
    priceCurrency: "USD",
    priceUnit: "task",
    runtimeName: "nooterra",
    tags: Object.freeze(["research", "analysis"])
  }),
  Object.freeze({
    id: "docs_worker",
    title: "Docs Worker",
    body: "Turns product and engineering work into clear guides, changelogs, and rollout notes.",
    displayName: "Docs Worker",
    description: "A public worker for documentation, release notes, and onboarding copy.",
    capabilities: Object.freeze(["capability://docs.write", "capability://knowledge.synthesis"]),
    priceAmountCents: 280,
    priceCurrency: "USD",
    priceUnit: "task",
    runtimeName: "nooterra",
    tags: Object.freeze(["docs", "enablement"])
  }),
  Object.freeze({
    id: "ops_worker",
    title: "Ops Worker",
    body: "Owns intake, runbooks, and operational follow-through for launch or incident workflows.",
    displayName: "Ops Worker",
    description: "A public worker for intake, runbooks, and operational coordination.",
    capabilities: Object.freeze(["capability://workflow.intake", "capability://ops.runbook.execute"]),
    priceAmountCents: 420,
    priceCurrency: "USD",
    priceUnit: "task",
    runtimeName: "nooterra",
    tags: Object.freeze(["operations", "routing"])
  })
]);

export const starterWorkerSetPresets = Object.freeze([
  Object.freeze({
    id: "launch_supply",
    title: "Launch Supply",
    body: "Seed the first three public workers most teams need: implementation, QA, and research.",
    profileIds: Object.freeze(["code_worker", "qa_worker", "research_worker"])
  }),
  Object.freeze({
    id: "shipping_lane",
    title: "Shipping Lane",
    body: "Cover release execution with code, QA, and docs workers that can ship together.",
    profileIds: Object.freeze(["code_worker", "qa_worker", "docs_worker"])
  }),
  Object.freeze({
    id: "ops_front_door",
    title: "Ops Front Door",
    body: "Stand up intake, research, and documentation workers for operational workflows.",
    profileIds: Object.freeze(["ops_worker", "research_worker", "docs_worker"])
  })
]);

export function toStarterWorkerSlug(value, fallback = "tenant") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-z0-9_]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

export function formatStarterWorkerCapabilities(profile) {
  return Array.isArray(profile?.capabilities) ? profile.capabilities.join("\n") : "";
}

export function formatStarterWorkerTags(profile) {
  return Array.isArray(profile?.tags) ? profile.tags.join(", ") : "";
}

function normalizeEndpointBaseUrl(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  return normalized.replace(/\/+$/, "");
}

export function deriveStarterWorkerDraft(profile, { tenantId, endpointBaseUrl = "" } = {}) {
  if (!profile || typeof profile !== "object") throw new TypeError("profile is required");
  const tenantSlug = toStarterWorkerSlug(tenantId, "tenant");
  const normalizedEndpointBaseUrl = normalizeEndpointBaseUrl(endpointBaseUrl);
  const agentId = `agt_${tenantSlug}_${profile.id}`;
  return {
    agentId,
    ownerType: "service",
    ownerId: `svc_${tenantSlug}_${profile.id}`,
    displayName: String(profile.displayName ?? profile.title ?? agentId),
    description: String(profile.description ?? ""),
    capabilities: Array.isArray(profile.capabilities) ? [...profile.capabilities] : [],
    visibility: "public",
    runtimeName: String(profile.runtimeName ?? "nooterra"),
    endpoint: normalizedEndpointBaseUrl ? `${normalizedEndpointBaseUrl}/${encodeURIComponent(agentId)}` : "",
    priceAmountCents: String(profile.priceAmountCents ?? 0),
    priceCurrency: String(profile.priceCurrency ?? "USD"),
    priceUnit: String(profile.priceUnit ?? "task"),
    tags: Array.isArray(profile.tags) ? [...profile.tags] : []
  };
}
