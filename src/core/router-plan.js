import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";
import { normalizeCapabilityIdentifier } from "./capability-attestation.js";

export const ROUTER_PLAN_SCHEMA_VERSION = "RouterPlan.v1";
export const ROUTER_REQUEST_SCHEMA_VERSION = "RouterRequest.v1";
export const ROUTER_INTENT_SCHEMA_VERSION = "RouterIntent.v1";
export const ROUTER_PLAN_TASK_SCHEMA_VERSION = "RouterPlanTask.v1";
export const ROUTER_PLAN_ISSUE_SCHEMA_VERSION = "RouterPlanIssue.v1";
export const ROUTER_PLAN_CANDIDATE_SCHEMA_VERSION = "RouterPlanCandidate.v1";

export const ROUTER_PLAN_SCOPE = Object.freeze({
  TENANT: "tenant",
  PUBLIC: "public"
});
const ROUTER_PLAN_SCOPES = new Set(Object.values(ROUTER_PLAN_SCOPE));

export const ROUTER_PLAN_ISSUE_SEVERITY = Object.freeze({
  BLOCKING: "blocking",
  WARNING: "warning"
});
const ROUTER_PLAN_ISSUE_SEVERITIES = new Set(Object.values(ROUTER_PLAN_ISSUE_SEVERITY));

export const ROUTER_PLAN_ISSUE_CODE = Object.freeze({
  INTENT_NO_MATCH: "ROUTER_INTENT_NO_MATCH",
  INTENT_AMBIGUOUS: "ROUTER_INTENT_AMBIGUOUS",
  CAPABILITY_NO_CANDIDATES: "ROUTER_CAPABILITY_NO_CANDIDATES",
  CAPABILITY_EXPLICIT_INVALID: "ROUTER_CAPABILITY_EXPLICIT_INVALID"
});

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name, { max = 5000 } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return normalized;
}

function normalizeIsoDateTime(value, name) {
  const normalized = assertNonEmptyString(value, name, { max: 128 });
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${name} must be an ISO date-time`);
  return normalized;
}

function normalizeScopeInput(value, { defaultScope = ROUTER_PLAN_SCOPE.TENANT } = {}) {
  const fallback = String(defaultScope ?? ROUTER_PLAN_SCOPE.TENANT).trim().toLowerCase();
  const normalized = value === null || value === undefined ? fallback : String(value).trim().toLowerCase();
  if (!ROUTER_PLAN_SCOPES.has(normalized)) throw new TypeError("scope must be tenant|public");
  return normalized;
}

function normalizeIssueSeverity(value, name = "severity") {
  const normalized = assertNonEmptyString(value, name, { max: 32 }).toLowerCase();
  if (!ROUTER_PLAN_ISSUE_SEVERITIES.has(normalized)) {
    throw new TypeError(`${name} must be one of ${Array.from(ROUTER_PLAN_ISSUE_SEVERITIES.values()).join("|")}`);
  }
  return normalized;
}

function normalizeIssues(value) {
  const issues = Array.isArray(value) ? value : [];
  return issues.map((issue, index) => {
    assertPlainObject(issue, `issues[${index}]`);
    const severity = normalizeIssueSeverity(issue.severity, `issues[${index}].severity`);
    const code = assertNonEmptyString(issue.code, `issues[${index}].code`, { max: 128 });
    const message = assertNonEmptyString(issue.message, `issues[${index}].message`, { max: 2000 });
    const details =
      issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
        ? normalizeForCanonicalJson(issue.details, { path: `$.issues[${index}].details` })
        : null;
    return normalizeForCanonicalJson(
      {
        schemaVersion: ROUTER_PLAN_ISSUE_SCHEMA_VERSION,
        severity,
        code,
        message,
        details
      },
      { path: `$.issues[${index}]` }
    );
  });
}

function normalizeTaskIds(value, name = "dependsOnTaskIds") {
  const arr = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (let index = 0; index < arr.length; index += 1) {
    const id = assertNonEmptyString(arr[index], `${name}[${index}]`, { max: 200 });
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function normalizeCandidates(value) {
  const candidates = Array.isArray(value) ? value : [];
  return candidates.map((row, index) => {
    assertPlainObject(row, `candidates[${index}]`);
    const agentId = assertNonEmptyString(row.agentId, `candidates[${index}].agentId`, { max: 200 });
    const tenantId = assertNonEmptyString(row.tenantId, `candidates[${index}].tenantId`, { max: 128 });
    const displayName =
      typeof row.displayName === "string" && row.displayName.trim() !== "" ? row.displayName.trim() : agentId;
    const rank = Number(row.rank);
    const rankingScore = Number(row.rankingScore);
    const trustScore = Number(row.trustScore);
    const riskTier = typeof row.riskTier === "string" && row.riskTier.trim() !== "" ? row.riskTier.trim().toLowerCase() : null;
    const priceHint = row.priceHint && typeof row.priceHint === "object" && !Array.isArray(row.priceHint) ? row.priceHint : null;
    const priceHintAmountCents = priceHint ? Number(priceHint.amountCents) : null;
    const priceHintCurrency = priceHint && typeof priceHint.currency === "string" && priceHint.currency.trim() !== "" ? priceHint.currency.trim() : null;
    const routingFactors =
      row.routingFactors && typeof row.routingFactors === "object" && !Array.isArray(row.routingFactors)
        ? normalizeForCanonicalJson(row.routingFactors, { path: `$.candidates[${index}].routingFactors` })
        : null;
    return normalizeForCanonicalJson(
      {
        schemaVersion: ROUTER_PLAN_CANDIDATE_SCHEMA_VERSION,
        agentId,
        tenantId,
        displayName,
        rank: Number.isSafeInteger(rank) && rank > 0 ? rank : null,
        rankingScore: Number.isFinite(rankingScore) ? Number(Number(rankingScore).toFixed(6)) : null,
        trustScore: Number.isFinite(trustScore) ? Math.max(0, Math.min(100, Math.round(trustScore))) : null,
        riskTier,
        priceHint: priceHintAmountCents !== null && Number.isSafeInteger(priceHintAmountCents) && priceHintAmountCents >= 0
          ? { amountCents: priceHintAmountCents, currency: priceHintCurrency ?? null }
          : null,
        routingFactors
      },
      { path: `$.candidates[${index}]` }
    );
  });
}

function normalizeTasks(value) {
  const tasks = Array.isArray(value) ? value : [];
  return tasks.map((task, index) => {
    assertPlainObject(task, `tasks[${index}]`);
    const taskId = assertNonEmptyString(task.taskId, `tasks[${index}].taskId`, { max: 200 });
    const title = assertNonEmptyString(task.title, `tasks[${index}].title`, { max: 500 });
    const requiredCapability = normalizeCapabilityIdentifier(task.requiredCapability, { name: `tasks[${index}].requiredCapability` });
    const dependsOnTaskIds = normalizeTaskIds(task.dependsOnTaskIds, `tasks[${index}].dependsOnTaskIds`);
    const candidates = normalizeCandidates(task.candidates);
    return normalizeForCanonicalJson(
      {
        schemaVersion: ROUTER_PLAN_TASK_SCHEMA_VERSION,
        taskId,
        title,
        requiredCapability,
        dependsOnTaskIds,
        candidates
      },
      { path: `$.tasks[${index}]` }
    );
  });
}

function extractExplicitCapabilities(text) {
  const matches = String(text).match(/capability:\/\/[a-z0-9._-]+(?:@v[0-9]+)?/g);
  const dedupe = new Set();
  for (const raw of matches ?? []) {
    const candidate = String(raw ?? "").trim();
    if (!candidate) continue;
    dedupe.add(candidate);
  }
  const out = Array.from(dedupe.values());
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function computeIntentScores(textLower) {
  const scored = [];

  let codeScore = 0;
  if (/\bpull request\b/.test(textLower)) codeScore += 5;
  if (/\bpr\b/.test(textLower)) codeScore += 3;
  if (/\bgithub\b/.test(textLower)) codeScore += 4;
  if (/\brepo\b/.test(textLower) || /\brepository\b/.test(textLower)) codeScore += 2;
  if (/\bfeature\b/.test(textLower)) codeScore += 2;
  if (/\bbug\b/.test(textLower)) codeScore += 2;
  if (/\bfix\b/.test(textLower)) codeScore += 2;
  if (/\bimplement\w*\b/.test(textLower)) codeScore += 3;
  if (/\btest\w*\b/.test(textLower) || /\bci\b/.test(textLower)) codeScore += 2;
  scored.push({
    intentId: "intent.code.change",
    label: "Code change → PR",
    score: codeScore
  });

  let travelScore = 0;
  if (/\bbook\w*\b/.test(textLower)) travelScore += 3;
  if (/\bflight\w*\b/.test(textLower)) travelScore += 4;
  if (/\bhotel\w*\b/.test(textLower)) travelScore += 4;
  if (/\btravel\w*\b/.test(textLower)) travelScore += 2;
  if (/\bairbnb\b/.test(textLower)) travelScore += 4;
  scored.push({
    intentId: "intent.travel.booking",
    label: "Travel booking",
    score: travelScore
  });

  scored.sort((a, b) => b.score - a.score || a.intentId.localeCompare(b.intentId));
  return scored;
}

function deriveTasksForIntent({ intentId, textLower }) {
  if (intentId === "intent.code.change") {
    const tasks = [
      {
        taskId: "t_implement",
        title: "Implement changes",
        requiredCapability: "capability://code.generation",
        dependsOnTaskIds: []
      }
    ];
    const wantsTests = /\btest\w*\b/.test(textLower) || /\bci\b/.test(textLower) || /\bpass\w*\b/.test(textLower);
    if (wantsTests) {
      tasks.push({
        taskId: "t_test",
        title: "Run/repair tests",
        requiredCapability: "capability://code.test.run",
        dependsOnTaskIds: ["t_implement"]
      });
    }
    const wantsReview = /\breview\w*\b/.test(textLower) || /\bsecurity\b/.test(textLower) || /\baudit\w*\b/.test(textLower);
    if (wantsReview) {
      tasks.push({
        taskId: "t_review",
        title: "Review for safety/style",
        requiredCapability: "capability://code.review",
        dependsOnTaskIds: wantsTests ? ["t_test"] : ["t_implement"]
      });
    }
    return tasks;
  }

  if (intentId === "intent.travel.booking") {
    return [
      {
        taskId: "t_book",
        title: "Book travel",
        requiredCapability: "capability://travel.booking@v2",
        dependsOnTaskIds: []
      }
    ];
  }

  return [];
}

export function deriveRouterDraftFromText({ text } = {}) {
  const requestText = assertNonEmptyString(text, "text", { max: 20_000 });
  const textLower = requestText.toLowerCase();

  const issues = [];
  const explicitCapabilities = extractExplicitCapabilities(requestText);
  if (explicitCapabilities.length > 0) {
    const tasks = [];
    for (let index = 0; index < explicitCapabilities.length; index += 1) {
      const cap = explicitCapabilities[index];
      try {
        normalizeCapabilityIdentifier(cap, { name: `capability[${index}]` });
      } catch (err) {
        issues.push({
          severity: ROUTER_PLAN_ISSUE_SEVERITY.BLOCKING,
          code: ROUTER_PLAN_ISSUE_CODE.CAPABILITY_EXPLICIT_INVALID,
          message: "explicit capability identifier is invalid",
          details: { capability: cap, message: err?.message ?? null, code: err?.code ?? null }
        });
        continue;
      }
      tasks.push({
        taskId: `t_${String(index + 1).padStart(2, "0")}`,
        title: `Execute ${cap}`,
        requiredCapability: cap,
        dependsOnTaskIds: []
      });
    }
    return {
      schemaVersion: "RouterDraft.v1",
      requestText,
      intent: {
        schemaVersion: ROUTER_INTENT_SCHEMA_VERSION,
        intentId: "intent.explicit.capabilities",
        label: "Explicit capabilities",
        score: 1
      },
      tasks,
      issues
    };
  }

  const scored = computeIntentScores(textLower);
  const best = scored[0] ?? null;
  const second = scored[1] ?? null;
  const bestScore = Number(best?.score ?? 0);
  const secondScore = Number(second?.score ?? 0);

  if (!best || bestScore <= 0) {
    issues.push({
      severity: ROUTER_PLAN_ISSUE_SEVERITY.BLOCKING,
      code: ROUTER_PLAN_ISSUE_CODE.INTENT_NO_MATCH,
      message: "router could not map request text to a known intent",
      details: { supportedIntents: scored.map((row) => ({ intentId: row.intentId, label: row.label })) }
    });
    return {
      schemaVersion: "RouterDraft.v1",
      requestText,
      intent: {
        schemaVersion: ROUTER_INTENT_SCHEMA_VERSION,
        intentId: "intent.unknown",
        label: "Unknown",
        score: 0
      },
      tasks: [],
      issues
    };
  }

  if (second && secondScore === bestScore) {
    issues.push({
      severity: ROUTER_PLAN_ISSUE_SEVERITY.WARNING,
      code: ROUTER_PLAN_ISSUE_CODE.INTENT_AMBIGUOUS,
      message: "router intent match is ambiguous",
      details: { candidates: [best, second].map((row) => ({ intentId: row.intentId, label: row.label, score: row.score })) }
    });
  }

  const tasks = deriveTasksForIntent({ intentId: best.intentId, textLower });

  return {
    schemaVersion: "RouterDraft.v1",
    requestText,
    intent: {
      schemaVersion: ROUTER_INTENT_SCHEMA_VERSION,
      intentId: best.intentId,
      label: best.label,
      score: bestScore
    },
    tasks,
    issues
  };
}

export function buildRouterPlanV1({
  planId,
  tenantId,
  scope = ROUTER_PLAN_SCOPE.TENANT,
  request,
  intent,
  tasks,
  issues = [],
  generatedAt = new Date().toISOString()
} = {}) {
  const normalizedPlanId = assertNonEmptyString(planId, "planId", { max: 200 });
  const normalizedTenantId = assertNonEmptyString(tenantId, "tenantId", { max: 128 });
  const normalizedScope = normalizeScopeInput(scope, { defaultScope: ROUTER_PLAN_SCOPE.TENANT });

  assertPlainObject(request, "request");
  const requestText = assertNonEmptyString(request.text, "request.text", { max: 20_000 });
  const asOf = request.asOf ? normalizeIsoDateTime(request.asOf, "request.asOf") : null;
  const normalizedRequest = normalizeForCanonicalJson(
    {
      schemaVersion: ROUTER_REQUEST_SCHEMA_VERSION,
      text: requestText,
      asOf
    },
    { path: "$.request" }
  );

  assertPlainObject(intent, "intent");
  const normalizedIntent = normalizeForCanonicalJson(
    {
      schemaVersion: ROUTER_INTENT_SCHEMA_VERSION,
      intentId: assertNonEmptyString(intent.intentId, "intent.intentId", { max: 200 }),
      label: assertNonEmptyString(intent.label, "intent.label", { max: 500 }),
      score: Number.isFinite(Number(intent.score)) ? Number(intent.score) : 0
    },
    { path: "$.intent" }
  );

  const normalizedTasks = normalizeTasks(tasks);
  const normalizedIssues = normalizeIssues(issues);
  const normalizedGeneratedAt = normalizeIsoDateTime(generatedAt, "generatedAt");

  const planBase = normalizeForCanonicalJson(
    {
      schemaVersion: ROUTER_PLAN_SCHEMA_VERSION,
      planId: normalizedPlanId,
      tenantId: normalizedTenantId,
      scope: normalizedScope,
      generatedAt: normalizedGeneratedAt,
      request: normalizedRequest,
      intent: normalizedIntent,
      taskCount: normalizedTasks.length,
      tasks: normalizedTasks,
      issues: normalizedIssues,
      planHash: null
    },
    { path: "$" }
  );

  const planHash = sha256Hex(canonicalJsonStringify(planBase));
  return normalizeForCanonicalJson({ ...planBase, planHash }, { path: "$" });
}
