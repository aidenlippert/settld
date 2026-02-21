#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  PROFILE_TEMPLATE_CATALOG_VERSION,
  PROFILE_SCHEMA_VERSION,
  createStarterProfile,
  listProfileTemplates
} from "../../src/core/profile-templates.js";

const VALIDATION_REPORT_SCHEMA_VERSION = "SettldProfileValidationReport.v1";
const SIMULATION_REPORT_SCHEMA_VERSION = "SettldProfileSimulationReport.v1";
const APPLY_REPORT_SCHEMA_VERSION = "SettldProfileApplyReport.v1";
const DEFAULT_WIZARD_TEMPLATE_ID = "engineering-spend";

function usage() {
  const lines = [
    "usage:",
    "  settld profile list [--format json|text] [--json-out <path>]",
    "  settld profile init <profile-id> [--out <path>] [--force] [--format json|text] [--json-out <path>]",
    "  settld profile wizard [--template <profile-id>] [--non-interactive] [--profile-id <id>] [--name <text>] [--vertical <text>] [--description <text>] [--currency <code>] [--per-request-usd-cents <int>] [--monthly-usd-cents <int>] [--providers <csv>] [--tools <csv>] [--out <path>] [--force] [--format json|text] [--json-out <path>]",
    "  settld profile validate <profile.json|-> [--format json|text] [--json-out <path>]",
    "  settld profile simulate <profile.json|-> [--scenario <scenario.json|->|--scenario-json <json>] [--format json|text] [--json-out <path>]",
    "  settld profile apply <profile.json|-> [--base-url <url>] [--tenant-id <id>] [--api-key <key>] [--sponsor-ref <id>] [--sponsor-wallet-ref <id>] [--policy-ref <id>] [--policy-version <int>] [--idempotency-prefix <prefix>] [--dry-run] [--format json|text] [--json-out <path>]"
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

function fail(message) {
  throw new Error(String(message));
}

function parseArgs(argv) {
  const out = {
    command: String(argv[0] ?? "").trim() || null,
    profileId: null,
    inputPath: null,
    scenarioPath: null,
    scenarioJson: null,
    outPath: null,
    jsonOut: null,
    format: "text",
    force: false,
    help: false,
    baseUrl: null,
    tenantId: null,
    apiKey: null,
    sponsorRef: null,
    sponsorWalletRef: null,
    policyRef: null,
    policyVersion: null,
    idempotencyPrefix: null,
    dryRun: false,
    templateId: null,
    nonInteractive: false,
    wizardProfileId: null,
    metadataName: null,
    metadataVertical: null,
    metadataDescription: null,
    currency: null,
    perRequestUsdCents: null,
    monthlyUsdCents: null,
    providersCsv: null,
    toolsCsv: null
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "").trim();
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--format") {
      out.format = String(argv[i + 1] ?? "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--json-out") {
      out.jsonOut = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--out") {
      out.outPath = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--force") {
      out.force = true;
      continue;
    }
    if (arg === "--profile") {
      out.profileId = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--profile-id") {
      out.wizardProfileId = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--template") {
      out.templateId = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--non-interactive" || arg === "--yes") {
      out.nonInteractive = true;
      continue;
    }
    if (arg === "--name") {
      out.metadataName = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--vertical") {
      out.metadataVertical = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--description") {
      out.metadataDescription = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--currency") {
      out.currency = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--per-request-usd-cents") {
      out.perRequestUsdCents = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--monthly-usd-cents") {
      out.monthlyUsdCents = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--providers") {
      out.providersCsv = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--tools") {
      out.toolsCsv = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--in") {
      out.inputPath = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--scenario") {
      out.scenarioPath = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--scenario-json") {
      out.scenarioJson = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--base-url") {
      out.baseUrl = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--tenant-id") {
      out.tenantId = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--api-key") {
      out.apiKey = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--sponsor-ref") {
      out.sponsorRef = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--sponsor-wallet-ref") {
      out.sponsorWalletRef = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--policy-ref") {
      out.policyRef = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--policy-version") {
      out.policyVersion = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--idempotency-prefix") {
      out.idempotencyPrefix = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }

    if (arg !== "-" && arg.startsWith("-")) fail(`unknown argument: ${arg}`);

    if (out.command === "init" && !out.profileId) {
      out.profileId = arg;
      continue;
    }
    if ((out.command === "validate" || out.command === "simulate" || out.command === "apply") && !out.inputPath) {
      out.inputPath = arg;
      continue;
    }
    fail(`unexpected positional argument: ${arg}`);
  }

  if (!out.command || out.command === "--help" || out.command === "-h") {
    out.help = true;
    out.command = out.command && out.command.startsWith("-") ? "list" : out.command;
    return out;
  }
  if (!["list", "init", "wizard", "validate", "simulate", "apply"].includes(out.command)) fail(`unsupported command: ${out.command}`);
  if (out.format !== "json" && out.format !== "text") fail("--format must be json or text");
  if (out.command === "init" && !out.profileId) fail("profile id is required for init");
  if ((out.command === "validate" || out.command === "simulate" || out.command === "apply") && !out.inputPath) {
    fail("profile input is required");
  }
  if (out.command !== "simulate" && (out.scenarioPath || out.scenarioJson)) fail("--scenario/--scenario-json only apply to simulate");
  if (out.scenarioPath && out.scenarioJson) fail("choose one of --scenario or --scenario-json");
  const applyOptionUsed =
    out.baseUrl !== null ||
    out.tenantId !== null ||
    out.apiKey !== null ||
    out.sponsorRef !== null ||
    out.sponsorWalletRef !== null ||
    out.policyRef !== null ||
    out.policyVersion !== null ||
    out.idempotencyPrefix !== null ||
    out.dryRun;
  if (out.command !== "apply" && applyOptionUsed) {
    fail("--base-url/--tenant-id/--api-key/--sponsor-ref/--sponsor-wallet-ref/--policy-ref/--policy-version/--idempotency-prefix/--dry-run only apply to apply");
  }
  const wizardOptionUsed =
    out.templateId !== null ||
    out.nonInteractive === true ||
    out.wizardProfileId !== null ||
    out.metadataName !== null ||
    out.metadataVertical !== null ||
    out.metadataDescription !== null ||
    out.currency !== null ||
    out.perRequestUsdCents !== null ||
    out.monthlyUsdCents !== null ||
    out.providersCsv !== null ||
    out.toolsCsv !== null;
  if (out.command !== "wizard" && wizardOptionUsed) {
    fail("--template/--non-interactive/--profile-id/--name/--vertical/--description/--currency/--per-request-usd-cents/--monthly-usd-cents/--providers/--tools only apply to wizard");
  }
  if (out.command === "apply") {
    if (out.policyVersion === null || out.policyVersion === undefined || out.policyVersion === "") {
      out.policyVersion = 1;
    } else {
      const parsedVersion = Number(out.policyVersion);
      if (!Number.isSafeInteger(parsedVersion) || parsedVersion < 1) fail("--policy-version must be an integer >= 1");
      out.policyVersion = parsedVersion;
    }
  }
  return out;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function addValidationError(report, { code, path: errorPath, message }) {
  report.errors.push({ code: String(code), path: String(errorPath), message: String(message) });
}

function validateString(report, value, fieldPath) {
  if (typeof value !== "string" || !value.trim()) {
    addValidationError(report, { code: "invalid_string", path: fieldPath, message: "must be a non-empty string" });
    return false;
  }
  return true;
}

function validateSafeInt(report, value, fieldPath, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    addValidationError(report, { code: "invalid_integer", path: fieldPath, message: `must be a safe integer >= ${min}` });
    return false;
  }
  return true;
}

function validateStringArray(report, value, fieldPath) {
  if (!Array.isArray(value)) {
    addValidationError(report, { code: "invalid_array", path: fieldPath, message: "must be an array of strings" });
    return false;
  }
  let ok = true;
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    const itemPath = `${fieldPath}[${i}]`;
    if (!validateString(report, item, itemPath)) {
      ok = false;
      continue;
    }
    if (seen.has(item)) {
      addValidationError(report, { code: "duplicate_value", path: itemPath, message: "must not contain duplicates" });
      ok = false;
      continue;
    }
    seen.add(item);
  }
  return ok;
}

function validateProfileDocument(profile) {
  const report = {
    schemaVersion: VALIDATION_REPORT_SCHEMA_VERSION,
    ok: false,
    profileId: typeof profile?.profileId === "string" ? profile.profileId : null,
    errors: [],
    warnings: []
  };

  if (!isPlainObject(profile)) {
    addValidationError(report, { code: "invalid_profile", path: "$", message: "profile must be an object" });
    return report;
  }

  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    addValidationError(report, { code: "unsupported_schema_version", path: "$.schemaVersion", message: `must be ${PROFILE_SCHEMA_VERSION}` });
  }

  validateString(report, profile.profileId, "$.profileId");

  if (!isPlainObject(profile.metadata)) {
    addValidationError(report, { code: "invalid_metadata", path: "$.metadata", message: "metadata must be an object" });
  } else {
    validateString(report, profile.metadata.name, "$.metadata.name");
    validateString(report, profile.metadata.vertical, "$.metadata.vertical");
    validateString(report, profile.metadata.description, "$.metadata.description");
  }

  if (!isPlainObject(profile.policy)) {
    addValidationError(report, { code: "invalid_policy", path: "$.policy", message: "policy must be an object" });
    return report;
  }

  validateString(report, profile.policy.currency, "$.policy.currency");

  if (!isPlainObject(profile.policy.limits)) {
    addValidationError(report, { code: "invalid_limits", path: "$.policy.limits", message: "limits must be an object" });
  } else {
    validateSafeInt(report, profile.policy.limits.perRequestUsdCents, "$.policy.limits.perRequestUsdCents", { min: 1 });
    validateSafeInt(report, profile.policy.limits.monthlyUsdCents, "$.policy.limits.monthlyUsdCents", { min: 1 });
    if (
      Number.isSafeInteger(profile.policy.limits.perRequestUsdCents) &&
      Number.isSafeInteger(profile.policy.limits.monthlyUsdCents) &&
      profile.policy.limits.perRequestUsdCents > profile.policy.limits.monthlyUsdCents
    ) {
      addValidationError(report, {
        code: "limits_inconsistent",
        path: "$.policy.limits",
        message: "perRequestUsdCents must be <= monthlyUsdCents"
      });
    }
  }

  if (!isPlainObject(profile.policy.allowlists)) {
    addValidationError(report, { code: "invalid_allowlists", path: "$.policy.allowlists", message: "allowlists must be an object" });
  } else {
    validateStringArray(report, profile.policy.allowlists.providers, "$.policy.allowlists.providers");
    validateStringArray(report, profile.policy.allowlists.tools, "$.policy.allowlists.tools");
  }

  if (!Array.isArray(profile.policy.approvalTiers) || profile.policy.approvalTiers.length === 0) {
    addValidationError(report, {
      code: "invalid_approval_tiers",
      path: "$.policy.approvalTiers",
      message: "approvalTiers must be a non-empty array"
    });
  } else {
    let previousMax = -1;
    for (let i = 0; i < profile.policy.approvalTiers.length; i += 1) {
      const tier = profile.policy.approvalTiers[i];
      const tierPath = `$.policy.approvalTiers[${i}]`;
      if (!isPlainObject(tier)) {
        addValidationError(report, { code: "invalid_tier", path: tierPath, message: "tier must be an object" });
        continue;
      }
      validateString(report, tier.tierId, `${tierPath}.tierId`);
      validateSafeInt(report, tier.maxAmountUsdCents, `${tierPath}.maxAmountUsdCents`, { min: 0 });
      validateSafeInt(report, tier.requiredApprovers, `${tierPath}.requiredApprovers`, { min: 0 });
      validateString(report, tier.approverRole, `${tierPath}.approverRole`);
      if (Number.isSafeInteger(tier.maxAmountUsdCents) && tier.maxAmountUsdCents <= previousMax) {
        addValidationError(report, {
          code: "tier_order_invalid",
          path: `${tierPath}.maxAmountUsdCents`,
          message: "maxAmountUsdCents must increase monotonically"
        });
      }
      if (Number.isSafeInteger(tier.maxAmountUsdCents)) previousMax = tier.maxAmountUsdCents;
    }
  }

  if (!isPlainObject(profile.policy.disputeDefaults)) {
    addValidationError(report, {
      code: "invalid_dispute_defaults",
      path: "$.policy.disputeDefaults",
      message: "disputeDefaults must be an object"
    });
  } else {
    validateSafeInt(report, profile.policy.disputeDefaults.responseWindowHours, "$.policy.disputeDefaults.responseWindowHours", { min: 1 });
    if (typeof profile.policy.disputeDefaults.autoOpenIfReceiptMissing !== "boolean") {
      addValidationError(report, {
        code: "invalid_boolean",
        path: "$.policy.disputeDefaults.autoOpenIfReceiptMissing",
        message: "must be a boolean"
      });
    }
    validateStringArray(report, profile.policy.disputeDefaults.evidenceChecklist, "$.policy.disputeDefaults.evidenceChecklist");
  }

  if (!isPlainObject(profile.policy.compliance)) {
    addValidationError(report, { code: "invalid_compliance", path: "$.policy.compliance", message: "compliance must be an object" });
  } else {
    const boolKeys = ["enforceVendorAllowlist", "requireReceiptSignature", "requireToolManifestHash", "allowUnknownToolVersion"];
    for (const key of boolKeys) {
      if (typeof profile.policy.compliance[key] !== "boolean") {
        addValidationError(report, { code: "invalid_boolean", path: `$.policy.compliance.${key}`, message: "must be a boolean" });
      }
    }
  }

  report.ok = report.errors.length === 0;
  return report;
}

function buildDefaultScenario(profile) {
  const providers = Array.isArray(profile?.policy?.allowlists?.providers) ? profile.policy.allowlists.providers : [];
  const tools = Array.isArray(profile?.policy?.allowlists?.tools) ? profile.policy.allowlists.tools : [];
  return {
    providerId: providers[0] ?? "",
    toolId: tools[0] ?? "",
    amountUsdCents: 0,
    monthToDateSpendUsdCents: 0,
    approvalsProvided: 0,
    receiptSigned: true,
    toolManifestHashPresent: true
  };
}

function normalizeScenario(raw, { profile }) {
  if (!isPlainObject(raw)) fail("scenario must be a JSON object");
  const fallback = buildDefaultScenario(profile);
  const out = {
    providerId: String(raw.providerId ?? fallback.providerId).trim(),
    toolId: String(raw.toolId ?? fallback.toolId).trim(),
    amountUsdCents: Number(raw.amountUsdCents ?? fallback.amountUsdCents),
    monthToDateSpendUsdCents: Number(raw.monthToDateSpendUsdCents ?? fallback.monthToDateSpendUsdCents),
    approvalsProvided: Number(raw.approvalsProvided ?? fallback.approvalsProvided),
    receiptSigned: raw.receiptSigned === undefined ? fallback.receiptSigned : Boolean(raw.receiptSigned),
    toolManifestHashPresent: raw.toolManifestHashPresent === undefined ? fallback.toolManifestHashPresent : Boolean(raw.toolManifestHashPresent)
  };
  if (!out.providerId) fail("scenario.providerId is required");
  if (!out.toolId) fail("scenario.toolId is required");
  if (!Number.isSafeInteger(out.amountUsdCents) || out.amountUsdCents < 0) fail("scenario.amountUsdCents must be a safe integer >= 0");
  if (!Number.isSafeInteger(out.monthToDateSpendUsdCents) || out.monthToDateSpendUsdCents < 0) {
    fail("scenario.monthToDateSpendUsdCents must be a safe integer >= 0");
  }
  if (!Number.isSafeInteger(out.approvalsProvided) || out.approvalsProvided < 0) fail("scenario.approvalsProvided must be a safe integer >= 0");
  return out;
}

function findApprovalTier(profile, amountUsdCents) {
  const tiers = profile.policy.approvalTiers;
  for (const tier of tiers) {
    if (amountUsdCents <= tier.maxAmountUsdCents) return tier;
  }
  return tiers[tiers.length - 1];
}

function simulateProfile({ profile, scenario }) {
  const allowlists = profile.policy.allowlists;
  const limits = profile.policy.limits;
  const compliance = profile.policy.compliance;
  const tier = findApprovalTier(profile, scenario.amountUsdCents);

  const checks = [
    { id: "provider_allowlisted", ok: compliance.enforceVendorAllowlist ? allowlists.providers.includes(scenario.providerId) : true },
    { id: "tool_allowlisted", ok: allowlists.tools.includes(scenario.toolId) },
    { id: "per_request_limit", ok: scenario.amountUsdCents <= limits.perRequestUsdCents },
    { id: "monthly_limit", ok: scenario.amountUsdCents + scenario.monthToDateSpendUsdCents <= limits.monthlyUsdCents },
    { id: "receipt_signature", ok: compliance.requireReceiptSignature ? scenario.receiptSigned : true },
    { id: "tool_manifest_hash", ok: compliance.requireToolManifestHash ? scenario.toolManifestHashPresent : true }
  ];

  const checksOk = checks.every((item) => item.ok === true);
  const requiredApprovers = tier.requiredApprovers;
  const approvalsSatisfied = scenario.approvalsProvided >= requiredApprovers;
  const reasons = [];

  for (const check of checks) {
    if (check.ok !== true) reasons.push(check.id);
  }
  if (checksOk && !approvalsSatisfied) reasons.push("approval_required");

  const decision = !checksOk ? "deny" : approvalsSatisfied ? "allow" : "challenge";

  return {
    schemaVersion: SIMULATION_REPORT_SCHEMA_VERSION,
    ok: true,
    profileId: profile.profileId,
    decision,
    requiredApprovers,
    approvalsProvided: scenario.approvalsProvided,
    selectedApprovalTier: tier.tierId,
    reasons,
    checks,
    scenario
  };
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonPath(pathLike) {
  if (pathLike === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return JSON.parse(await fs.readFile(pathLike, "utf8"));
}

async function writeOutput({ format, payload, text, jsonOut }) {
  const jsonBody = `${JSON.stringify(payload, null, 2)}\n`;
  if (jsonOut) {
    const target = path.resolve(process.cwd(), jsonOut);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, jsonBody, "utf8");
  }
  if (format === "json") {
    process.stdout.write(jsonBody);
    return;
  }
  process.stdout.write(text);
}

function renderListText(templates) {
  const lines = [];
  for (const profile of templates) {
    lines.push(`${profile.profileId}\t${profile.metadata.vertical}\t${profile.metadata.name}`);
  }
  return `${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

function renderValidationText(report) {
  if (report.ok) return "ok\n";
  return report.errors.map((row) => `${row.code}\t${row.path}\t${row.message}`).join("\n") + "\n";
}

function renderSimulationText(report) {
  const reasonText = report.reasons.length ? report.reasons.join(",") : "none";
  return [
    `decision: ${report.decision}`,
    `requiredApprovers: ${report.requiredApprovers}`,
    `approvalsProvided: ${report.approvalsProvided}`,
    `reasons: ${reasonText}`
  ].join("\n") + "\n";
}

function normalizeApplyBaseUrl(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) fail("--base-url or SETTLD_BASE_URL is required");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("--base-url must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("--base-url must use http or https");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function joinBaseUrl(baseUrl, routePath) {
  const suffix = String(routePath ?? "").trim().replace(/^\/+/, "");
  return `${baseUrl}/${suffix}`;
}

function toTrimmedOrNull(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function resolveApplyConfig(parsed, profile) {
  const profileId = toTrimmedOrNull(profile?.profileId);
  if (!profileId) fail("profile.profileId must be a non-empty string");
  const profileSchemaVersion = toTrimmedOrNull(profile?.schemaVersion);
  if (!profileSchemaVersion) fail("profile.schemaVersion must be a non-empty string");
  const baseUrl = normalizeApplyBaseUrl(
    parsed.baseUrl ??
      process.env.SETTLD_BASE_URL ??
      process.env.SETTLD_RUNTIME_BASE_URL ??
      process.env.SETTLD_RUNTIME_URL ??
      process.env.SETTLD_API_URL ??
      ""
  );
  const tenantId = toTrimmedOrNull(parsed.tenantId ?? process.env.SETTLD_TENANT_ID ?? process.env.SETTLD_RUNTIME_TENANT_ID ?? "");
  const apiKey = toTrimmedOrNull(
    parsed.apiKey ??
      process.env.SETTLD_API_KEY ??
      process.env.SETTLD_RUNTIME_BEARER_TOKEN ??
      process.env.SETTLD_BEARER_TOKEN ??
      process.env.SETTLD_TOKEN ??
      ""
  );
  const sponsorRef = toTrimmedOrNull(parsed.sponsorRef ?? process.env.SETTLD_SPONSOR_REF ?? "sponsor_default");
  const sponsorWalletRef = toTrimmedOrNull(
    parsed.sponsorWalletRef ?? process.env.SETTLD_SPONSOR_WALLET_REF ?? process.env.SETTLD_RUNTIME_WALLET_REF ?? `wallet_${profileId}`
  );
  const policyRef = toTrimmedOrNull(parsed.policyRef ?? process.env.SETTLD_POLICY_REF ?? profileId);
  const policyVersion = Number(parsed.policyVersion ?? process.env.SETTLD_POLICY_VERSION ?? 1);
  const idempotencyPrefix = toTrimmedOrNull(parsed.idempotencyPrefix ?? process.env.SETTLD_IDEMPOTENCY_PREFIX ?? "settld_profile_apply");

  if (!sponsorRef) fail("--sponsor-ref must be a non-empty string");
  if (!sponsorWalletRef) fail("--sponsor-wallet-ref must be a non-empty string");
  if (!policyRef) fail("--policy-ref must be a non-empty string");
  if (!idempotencyPrefix) fail("--idempotency-prefix must be a non-empty string");
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) fail("--policy-version must be an integer >= 1");
  if (!parsed.dryRun) {
    if (!tenantId) fail("--tenant-id or SETTLD_TENANT_ID is required");
    if (!apiKey) fail("--api-key or SETTLD_API_KEY is required");
  }

  return {
    profileId,
    profileSchemaVersion,
    baseUrl,
    tenantId,
    apiKey,
    sponsorRef,
    sponsorWalletRef,
    policyRef,
    policyVersion,
    idempotencyPrefix
  };
}

function mapProfileToX402WalletPolicy({ profile, config }) {
  const currency = String(profile.policy.currency ?? "").trim().toUpperCase();
  return {
    schemaVersion: "X402WalletPolicy.v1",
    sponsorRef: config.sponsorRef,
    sponsorWalletRef: config.sponsorWalletRef,
    policyRef: config.policyRef,
    policyVersion: config.policyVersion,
    status: "active",
    maxAmountCents: Number(profile.policy.limits.perRequestUsdCents),
    maxDailyAuthorizationCents: Number(profile.policy.limits.monthlyUsdCents),
    allowedProviderIds: Array.isArray(profile.policy.allowlists.providers) ? [...profile.policy.allowlists.providers] : [],
    allowedToolIds: Array.isArray(profile.policy.allowlists.tools) ? [...profile.policy.allowlists.tools] : [],
    allowedCurrencies: currency ? [currency] : [],
    requireQuote: true,
    requireStrictRequestBinding: true,
    requireAgentKeyMatch: profile.policy.compliance.allowUnknownToolVersion !== true,
    requiresZkProof: false,
    description: profile.metadata.description,
    metadata: {
      profileId: config.profileId,
      profileSchemaVersion: config.profileSchemaVersion
    }
  };
}

function findMaxAutoReleaseAmountCents(profile) {
  if (!Array.isArray(profile?.policy?.approvalTiers)) return null;
  let maxAmount = null;
  for (const tier of profile.policy.approvalTiers) {
    if (!isPlainObject(tier)) continue;
    if (Number(tier.requiredApprovers) !== 0) continue;
    const amount = Number(tier.maxAmountUsdCents);
    if (!Number.isSafeInteger(amount) || amount < 0) continue;
    if (maxAmount === null || amount > maxAmount) maxAmount = amount;
  }
  return maxAmount;
}

function mapProfileToSettlementPolicyUpsert({ profile, config }) {
  const maxAutoReleaseAmountCents = findMaxAutoReleaseAmountCents(profile);
  return {
    policyId: config.policyRef,
    policyVersion: config.policyVersion,
    policy: {
      schemaVersion: "SettlementPolicy.v1",
      policyVersion: config.policyVersion,
      mode: "automatic",
      rules: {
        maxAutoReleaseAmountCents,
        disputeWindowHours: Number(profile.policy.disputeDefaults.responseWindowHours),
        requireDeterministicVerification: profile.policy.compliance.requireToolManifestHash === true,
        autoReleaseOnGreen: true,
        autoReleaseOnAmber: false,
        autoReleaseOnRed: false
      }
    }
  };
}

function createApplyIdempotencyKey({ prefix, runToken, step }) {
  return `${prefix}_${runToken}_${step}`;
}

function summarizeApplyResponseBody(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body.slice(0, 500);
  if (!isPlainObject(body)) return body;
  const summary = {};
  if (typeof body.code === "string") summary.code = body.code;
  if (typeof body.message === "string") summary.message = body.message;
  if (typeof body.ok === "boolean") summary.ok = body.ok;
  if (typeof body.created === "boolean") summary.created = body.created;
  if (isPlainObject(body.policy)) {
    summary.policy = {
      policyId: body.policy.policyId ?? null,
      policyVersion: body.policy.policyVersion ?? null,
      schemaVersion: body.policy.schemaVersion ?? null
    };
  } else if (body.policyId || body.policyVersion) {
    summary.policy = {
      policyId: body.policyId ?? null,
      policyVersion: body.policyVersion ?? null
    };
  }
  if (summary.code || summary.message || summary.ok !== undefined || summary.created !== undefined || summary.policy) {
    return summary;
  }
  return { keys: Object.keys(body).slice(0, 20) };
}

async function runApplyRequest({ method, url, headers, payload }) {
  let response;
  try {
    response = await fetch(url, { method, headers, body: JSON.stringify(payload) });
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      statusText: "network_error",
      summary: { message: err?.message ?? "network request failed" },
      body: null
    };
  }

  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  const rawText = await response.text();
  let body = null;
  if (rawText) {
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = rawText;
      }
    } else {
      body = rawText;
    }
  }
  return {
    ok: response.ok,
    statusCode: response.status,
    statusText: response.statusText || null,
    summary: summarizeApplyResponseBody(body),
    body
  };
}

function renderApplyText(report) {
  const lines = [
    `ok: ${report.ok ? "true" : "false"}`,
    `dryRun: ${report.dryRun ? "true" : "false"}`,
    `profileId: ${report.profileId}`
  ];
  for (const step of report.steps ?? []) {
    const status = step.response ? `${step.response.statusCode} ${step.response.ok ? "ok" : "error"}` : "dry-run";
    lines.push(`${step.step}\t${status}\t${step.method}\t${step.url}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseCsvList(rawValue) {
  const parts = String(rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

function parseWizardInteger(rawValue, flagName, { min = 0 } = {}) {
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < min) {
    fail(`${flagName} must be an integer >= ${min}`);
  }
  return value;
}

async function promptLine(rl, label, { required = true, defaultValue = null } = {}) {
  const suffix = defaultValue !== null && defaultValue !== undefined && String(defaultValue).trim() ? ` [${String(defaultValue).trim()}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  const value = answer.trim() || (defaultValue === null || defaultValue === undefined ? "" : String(defaultValue).trim());
  if (!required || value) return value;
  throw new Error(`${label} is required`);
}

async function createPromptAdapter({ stdin = process.stdin, stdout = process.stdout } = {}) {
  if (stdin.isTTY && stdout.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    return {
      question: async (query) => await rl.question(query),
      close: () => rl.close()
    };
  }

  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
  }
  const answers = Buffer.concat(chunks).toString("utf8").split(/\r?\n/u);
  let answerIndex = 0;
  return {
    async question(query) {
      stdout.write(String(query ?? ""));
      const answer = answers[answerIndex] ?? "";
      answerIndex += 1;
      return answer;
    },
    close: () => {}
  };
}

function parseYesNo(value, { defaultValue = false } = {}) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["y", "yes", "true", "1"].includes(normalized)) return true;
  if (["n", "no", "false", "0"].includes(normalized)) return false;
  return defaultValue;
}

async function promptWizardInteger(rl, label, { defaultValue, min = 0 }) {
  // Keep prompting until we get a valid integer so interactive runs don't fail on a typo.
  while (true) {
    const raw = await promptLine(rl, label, { defaultValue: String(defaultValue) });
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= min) return value;
    process.stderr.write(`${label} must be an integer >= ${min}\n`);
  }
}

function resolveWizardTemplateId(parsed, templates) {
  const availableIds = templates.map((template) => template.profileId);
  const fallback = availableIds.includes(DEFAULT_WIZARD_TEMPLATE_ID) ? DEFAULT_WIZARD_TEMPLATE_ID : availableIds[0] ?? null;
  const templateId = String(parsed.templateId || "").trim() || fallback;
  if (!templateId) fail("no profile templates available for wizard");
  return templateId;
}

async function buildWizardProfile(parsed, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const templates = listProfileTemplates();
  const interactive = parsed.nonInteractive !== true;
  let templateId = resolveWizardTemplateId(parsed, templates);
  let prompt = null;

  try {
    if (interactive) {
      prompt = await createPromptAdapter({ stdin, stdout });
      if (!parsed.templateId) {
        const templatePrompt = templates.length
          ? `Template profile (${templates.map((template) => template.profileId).join("/")})`
          : "Template profile";
        templateId = await promptLine(prompt, templatePrompt, { defaultValue: templateId });
      }
    }

    const profile = createStarterProfile({ profileId: templateId });
    if (!profile) fail(`unknown profile template: ${templateId}`);

    let profileId = String(parsed.wizardProfileId || parsed.profileId || "").trim();
    let metadataName = String(parsed.metadataName || "").trim();
    let metadataVertical = String(parsed.metadataVertical || "").trim();
    let metadataDescription = String(parsed.metadataDescription || "").trim();
    let currency = String(parsed.currency || "").trim().toUpperCase();
    let perRequestUsdCents = parsed.perRequestUsdCents;
    let monthlyUsdCents = parsed.monthlyUsdCents;
    let providers = parsed.providersCsv !== null ? parseCsvList(parsed.providersCsv) : null;
    let tools = parsed.toolsCsv !== null ? parseCsvList(parsed.toolsCsv) : null;

    if (interactive) {
      profileId = profileId || (await promptLine(prompt, "Profile ID", { defaultValue: profile.profileId }));
      metadataName = metadataName || (await promptLine(prompt, "Policy name", { defaultValue: profile.metadata.name }));
      metadataVertical = metadataVertical || (await promptLine(prompt, "Vertical", { defaultValue: profile.metadata.vertical }));
      metadataDescription = metadataDescription || (await promptLine(prompt, "Description", { defaultValue: profile.metadata.description }));
      currency = currency || (await promptLine(prompt, "Currency", { defaultValue: profile.policy.currency })).toUpperCase();

      perRequestUsdCents =
        perRequestUsdCents !== null
          ? parseWizardInteger(perRequestUsdCents, "--per-request-usd-cents", { min: 1 })
          : await promptWizardInteger(prompt, "Per-request limit (USD cents)", {
              defaultValue: profile.policy.limits.perRequestUsdCents,
              min: 1
            });
      monthlyUsdCents =
        monthlyUsdCents !== null
          ? parseWizardInteger(monthlyUsdCents, "--monthly-usd-cents", { min: 1 })
          : await promptWizardInteger(prompt, "Monthly limit (USD cents)", {
              defaultValue: profile.policy.limits.monthlyUsdCents,
              min: 1
            });

      providers =
        providers ??
        parseCsvList(
          await promptLine(prompt, "Allowed providers CSV", {
            required: false,
            defaultValue: profile.policy.allowlists.providers.join(",")
          })
        );
      tools =
        tools ??
        parseCsvList(
          await promptLine(prompt, "Allowed tools CSV", {
            required: false,
            defaultValue: profile.policy.allowlists.tools.join(",")
          })
        );
    } else {
      profileId = profileId || profile.profileId;
      metadataName = metadataName || profile.metadata.name;
      metadataVertical = metadataVertical || profile.metadata.vertical;
      metadataDescription = metadataDescription || profile.metadata.description;
      currency = currency || String(profile.policy.currency).toUpperCase();
      perRequestUsdCents =
        perRequestUsdCents === null
          ? profile.policy.limits.perRequestUsdCents
          : parseWizardInteger(perRequestUsdCents, "--per-request-usd-cents", { min: 1 });
      monthlyUsdCents =
        monthlyUsdCents === null
          ? profile.policy.limits.monthlyUsdCents
          : parseWizardInteger(monthlyUsdCents, "--monthly-usd-cents", { min: 1 });
      providers = providers ?? [...profile.policy.allowlists.providers];
      tools = tools ?? [...profile.policy.allowlists.tools];
    }

    if (!profileId) fail("profile id is required");
    if (!metadataName) fail("metadata.name is required");
    if (!metadataVertical) fail("metadata.vertical is required");
    if (!metadataDescription) fail("metadata.description is required");
    if (!currency) fail("policy.currency is required");
    if (perRequestUsdCents > monthlyUsdCents) fail("per-request limit must be <= monthly limit");

    profile.profileId = profileId;
    profile.metadata.name = metadataName;
    profile.metadata.vertical = metadataVertical;
    profile.metadata.description = metadataDescription;
    profile.policy.currency = currency;
    profile.policy.limits.perRequestUsdCents = perRequestUsdCents;
    profile.policy.limits.monthlyUsdCents = monthlyUsdCents;
    profile.policy.allowlists.providers = providers;
    profile.policy.allowlists.tools = tools;

    const targetPathDefault = `${profile.profileId}.profile.json`;
    const outPathInput =
      parsed.outPath || (interactive ? await promptLine(prompt, "Output path", { defaultValue: targetPathDefault }) : targetPathDefault);
    const targetPath = path.resolve(process.cwd(), outPathInput);
    let forceWrite = parsed.force;
    if (!forceWrite && (await exists(targetPath))) {
      if (!interactive) fail(`output path exists: ${targetPath}`);
      const overwrite = parseYesNo(await promptLine(prompt, "Output exists. Overwrite? (y/n)", { required: false, defaultValue: "n" }), {
        defaultValue: false
      });
      if (!overwrite) fail(`output path exists: ${targetPath}`);
      forceWrite = true;
    }
    if (!forceWrite && (await exists(targetPath))) fail(`output path exists: ${targetPath}`);

    return {
      profile,
      templateId,
      targetPath,
      mode: interactive ? "interactive" : "non_interactive"
    };
  } finally {
    if (prompt) prompt.close();
  }
}

async function handleWizard(parsed) {
  const generated = await buildWizardProfile(parsed);
  const validation = validateProfileDocument(generated.profile);
  if (!validation.ok) {
    const firstError = validation.errors[0];
    fail(
      `wizard generated an invalid profile at ${firstError?.path ?? "$"}: ${firstError?.message ?? "validation failed"}`
    );
  }
  await fs.mkdir(path.dirname(generated.targetPath), { recursive: true });
  await fs.writeFile(generated.targetPath, `${JSON.stringify(generated.profile, null, 2)}\n`, "utf8");
  const payload = {
    ok: true,
    command: "wizard",
    mode: generated.mode,
    templateId: generated.templateId,
    profileId: generated.profile.profileId,
    outPath: generated.targetPath
  };
  await writeOutput({
    format: parsed.format,
    payload,
    text: `ok\t${generated.profile.profileId}\t${generated.targetPath}\n`,
    jsonOut: parsed.jsonOut
  });
  return 0;
}

async function handleList(parsed) {
  const templates = listProfileTemplates();
  const payload = {
    schemaVersion: PROFILE_TEMPLATE_CATALOG_VERSION,
    profiles: templates
  };
  await writeOutput({
    format: parsed.format,
    payload,
    text: renderListText(templates),
    jsonOut: parsed.jsonOut
  });
  return 0;
}

async function handleInit(parsed) {
  const profile = createStarterProfile({ profileId: parsed.profileId });
  if (!profile) fail(`unknown profile template: ${parsed.profileId}`);
  const targetPath = path.resolve(process.cwd(), parsed.outPath || `${parsed.profileId}.profile.json`);
  if (!parsed.force && (await exists(targetPath))) fail(`output path exists: ${targetPath}`);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

  const payload = {
    ok: true,
    command: "init",
    profileId: parsed.profileId,
    outPath: targetPath
  };
  await writeOutput({
    format: parsed.format,
    payload,
    text: `ok\t${parsed.profileId}\t${targetPath}\n`,
    jsonOut: parsed.jsonOut
  });
  return 0;
}

async function handleValidate(parsed) {
  const profile = await readJsonPath(parsed.inputPath);
  const report = validateProfileDocument(profile);
  await writeOutput({
    format: parsed.format,
    payload: report,
    text: renderValidationText(report),
    jsonOut: parsed.jsonOut
  });
  return report.ok ? 0 : 1;
}

async function loadScenario(parsed, profile) {
  if (parsed.scenarioJson) return normalizeScenario(JSON.parse(parsed.scenarioJson), { profile });
  if (parsed.scenarioPath) return normalizeScenario(await readJsonPath(parsed.scenarioPath), { profile });
  return normalizeScenario(buildDefaultScenario(profile), { profile });
}

async function handleSimulate(parsed) {
  const profile = await readJsonPath(parsed.inputPath);
  const validation = validateProfileDocument(profile);
  if (!validation.ok) {
    await writeOutput({
      format: parsed.format,
      payload: validation,
      text: renderValidationText(validation),
      jsonOut: parsed.jsonOut
    });
    return 1;
  }
  const scenario = await loadScenario(parsed, profile);
  const report = simulateProfile({ profile, scenario });
  await writeOutput({
    format: parsed.format,
    payload: report,
    text: renderSimulationText(report),
    jsonOut: parsed.jsonOut
  });
  return 0;
}

async function handleApply(parsed) {
  const profile = await readJsonPath(parsed.inputPath);
  const validation = validateProfileDocument(profile);
  if (!validation.ok) {
    await writeOutput({
      format: parsed.format,
      payload: validation,
      text: renderValidationText(validation),
      jsonOut: parsed.jsonOut
    });
    return 1;
  }

  const config = resolveApplyConfig(parsed, profile);
  const x402PolicyPayload = mapProfileToX402WalletPolicy({ profile, config });
  const settlementPolicyUpsertPayload = mapProfileToSettlementPolicyUpsert({ profile, config });
  const x402PolicyUrl = joinBaseUrl(config.baseUrl, `/x402/wallets/${encodeURIComponent(config.sponsorWalletRef)}/policy`);
  const settlementPolicyUrl = joinBaseUrl(config.baseUrl, "/marketplace/settlement-policies");
  const runToken = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const x402IdempotencyKey = createApplyIdempotencyKey({
    prefix: config.idempotencyPrefix,
    runToken,
    step: "x402_wallet_policy"
  });
  const settlementIdempotencyKey = createApplyIdempotencyKey({
    prefix: config.idempotencyPrefix,
    runToken,
    step: "settlement_policy"
  });
  const report = {
    schemaVersion: APPLY_REPORT_SCHEMA_VERSION,
    ok: true,
    dryRun: parsed.dryRun === true,
    profileId: config.profileId,
    profileSchemaVersion: config.profileSchemaVersion,
    appliedAt: new Date().toISOString(),
    target: {
      baseUrl: config.baseUrl,
      tenantId: config.tenantId,
      sponsorRef: config.sponsorRef,
      sponsorWalletRef: config.sponsorWalletRef,
      policyRef: config.policyRef,
      policyVersion: config.policyVersion
    },
    steps: [
      {
        step: "x402_wallet_policy_upsert",
        method: "PUT",
        url: x402PolicyUrl,
        idempotencyKey: x402IdempotencyKey,
        requestPayload: x402PolicyPayload,
        response: null
      },
      {
        step: "settlement_policy_upsert",
        method: "POST",
        url: settlementPolicyUrl,
        idempotencyKey: settlementIdempotencyKey,
        requestPayload: settlementPolicyUpsertPayload,
        response: null
      }
    ]
  };

  if (!parsed.dryRun) {
    const headersBase = {
      authorization: `Bearer ${config.apiKey}`,
      "x-proxy-tenant-id": config.tenantId,
      "content-type": "application/json",
      "x-settld-protocol": "1.0"
    };
    const x402Response = await runApplyRequest({
      method: "PUT",
      url: x402PolicyUrl,
      headers: {
        ...headersBase,
        "x-idempotency-key": x402IdempotencyKey
      },
      payload: x402PolicyPayload
    });
    report.steps[0].response = x402Response;
    if (x402Response.ok) {
      const settlementResponse = await runApplyRequest({
        method: "POST",
        url: settlementPolicyUrl,
        headers: {
          ...headersBase,
          "x-idempotency-key": settlementIdempotencyKey
        },
        payload: settlementPolicyUpsertPayload
      });
      report.steps[1].response = settlementResponse;
      report.ok = settlementResponse.ok;
    } else {
      report.ok = false;
    }
  }

  await writeOutput({
    format: parsed.format,
    payload: report,
    text: renderApplyText(report),
    jsonOut: parsed.jsonOut
  });
  return report.ok ? 0 : 1;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    usage();
    process.stderr.write(`${err?.message ?? "invalid arguments"}\n`);
    process.exit(2);
    return;
  }

  if (parsed.help) {
    usage();
    process.exit(0);
    return;
  }

  try {
    let code = 1;
    if (parsed.command === "list") code = await handleList(parsed);
    if (parsed.command === "init") code = await handleInit(parsed);
    if (parsed.command === "wizard") code = await handleWizard(parsed);
    if (parsed.command === "validate") code = await handleValidate(parsed);
    if (parsed.command === "simulate") code = await handleSimulate(parsed);
    if (parsed.command === "apply") code = await handleApply(parsed);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`${err?.message ?? "command failed"}\n`);
    process.exit(1);
  }
}

main();
