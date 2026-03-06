import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const ROUTER_MARKETPLACE_LAUNCH_SCHEMA_VERSION = "RouterMarketplaceLaunch.v1";
export const ROUTER_MARKETPLACE_LAUNCH_TASK_SCHEMA_VERSION = "RouterMarketplaceLaunchTask.v1";

const ROUTER_MARKETPLACE_LAUNCH_SCOPES = new Set(["tenant", "public"]);

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${name} must be a plain object`);
}

function assertNonEmptyString(value, name, { max = 5000 } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return normalized;
}

function normalizeOptionalString(value, name, { max = 5000 } = {}) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return normalized;
}

function normalizeIsoDateTime(value, name, { allowNull = false } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new TypeError(`${name} must be an ISO date-time`);
  }
  const normalized = assertNonEmptyString(value, name, { max: 128 });
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${name} must be an ISO date-time`);
  return normalized;
}

function normalizeScope(value) {
  const normalized = value === null || value === undefined ? "tenant" : assertNonEmptyString(value, "scope", { max: 32 }).toLowerCase();
  if (!ROUTER_MARKETPLACE_LAUNCH_SCOPES.has(normalized)) throw new TypeError("scope must be tenant|public");
  return normalized;
}

function normalizePositiveSafeInt(value, name, { allowNull = false, min = 1 } = {}) {
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    throw new TypeError(`${name} is required`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new TypeError(`${name} must be a safe integer >= ${min}`);
  return parsed;
}

function normalizeCurrency(value, name, { allowNull = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    throw new TypeError(`${name} is required`);
  }
  const normalized = String(value).trim().toUpperCase();
  if (!normalized) {
    if (allowNull) return null;
    throw new TypeError(`${name} is required`);
  }
  if (!/^[A-Z0-9_]{2,8}$/.test(normalized)) throw new TypeError(`${name} must match ^[A-Z0-9_]{2,8}$`);
  return normalized;
}

function normalizeTaskIds(value, name = "dependsOnTaskIds") {
  const items = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (let index = 0; index < items.length; index += 1) {
    const id = assertNonEmptyString(items[index], `${name}[${index}]`, { max: 200 });
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

function normalizeCandidateAgentIds(value, name = "candidateAgentIds") {
  const items = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (let index = 0; index < items.length; index += 1) {
    const agentId = assertNonEmptyString(items[index], `${name}[${index}]`, { max: 200 });
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    out.push(agentId);
  }
  return out;
}

function normalizeTasks(value) {
  const tasks = Array.isArray(value) ? value : [];
  return tasks.map((task, index) => {
    assertPlainObject(task, `tasks[${index}]`);
    return normalizeForCanonicalJson(
      {
        schemaVersion: ROUTER_MARKETPLACE_LAUNCH_TASK_SCHEMA_VERSION,
        taskId: assertNonEmptyString(task.taskId, `tasks[${index}].taskId`, { max: 200 }),
        title: assertNonEmptyString(task.title, `tasks[${index}].title`, { max: 500 }),
        requiredCapability: assertNonEmptyString(task.requiredCapability, `tasks[${index}].requiredCapability`, { max: 256 }),
        rfqId: assertNonEmptyString(task.rfqId, `tasks[${index}].rfqId`, { max: 200 }),
        dependsOnTaskIds: normalizeTaskIds(task.dependsOnTaskIds, `tasks[${index}].dependsOnTaskIds`),
        budgetCents: normalizePositiveSafeInt(task.budgetCents, `tasks[${index}].budgetCents`, { allowNull: true }),
        currency: normalizeCurrency(task.currency, `tasks[${index}].currency`, { allowNull: true }),
        deadlineAt: normalizeIsoDateTime(task.deadlineAt, `tasks[${index}].deadlineAt`, { allowNull: true }),
        candidateCount: normalizePositiveSafeInt(task.candidateCount ?? 0, `tasks[${index}].candidateCount`, { min: 0 }),
        candidateAgentIds: normalizeCandidateAgentIds(task.candidateAgentIds, `tasks[${index}].candidateAgentIds`)
      },
      { path: `$.tasks[${index}]` }
    );
  });
}

export function buildRouterMarketplaceLaunchV1({
  launchId,
  tenantId,
  posterAgentId,
  scope = "tenant",
  request,
  planRef,
  tasks = [],
  metadata = null,
  createdAt = new Date().toISOString()
} = {}) {
  assertPlainObject(request, "request");
  assertPlainObject(planRef, "planRef");
  const normalizedTasks = normalizeTasks(tasks);
  const normalizedCreatedAt = normalizeIsoDateTime(createdAt, "createdAt");
  const body = normalizeForCanonicalJson(
    {
      schemaVersion: ROUTER_MARKETPLACE_LAUNCH_SCHEMA_VERSION,
      launchId: assertNonEmptyString(launchId, "launchId", { max: 200 }),
      tenantId: assertNonEmptyString(tenantId, "tenantId", { max: 128 }),
      posterAgentId: assertNonEmptyString(posterAgentId, "posterAgentId", { max: 200 }),
      scope: normalizeScope(scope),
      request: {
        text: assertNonEmptyString(request.text, "request.text", { max: 20_000 }),
        asOf: normalizeIsoDateTime(request.asOf, "request.asOf")
      },
      planRef: {
        planId: assertNonEmptyString(planRef.planId, "planRef.planId", { max: 200 }),
        planHash: assertNonEmptyString(planRef.planHash, "planRef.planHash", { max: 64 })
      },
      taskCount: normalizedTasks.length,
      tasks: normalizedTasks,
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? normalizeForCanonicalJson(metadata, { path: "$.metadata" })
        : null,
      createdAt: normalizedCreatedAt,
      launchHash: null
    },
    { path: "$" }
  );

  return normalizeForCanonicalJson(
    {
      ...body,
      launchHash: sha256Hex(canonicalJsonStringify(body))
    },
    { path: "$" }
  );
}
