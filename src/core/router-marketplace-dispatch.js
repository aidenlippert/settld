import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const ROUTER_MARKETPLACE_DISPATCH_SCHEMA_VERSION = "RouterMarketplaceDispatch.v1";
export const ROUTER_MARKETPLACE_DISPATCH_TASK_SCHEMA_VERSION = "RouterMarketplaceDispatchTask.v1";

export const ROUTER_MARKETPLACE_DISPATCH_STATE = Object.freeze({
  ACCEPTED: "accepted",
  ALREADY_ASSIGNED: "already_assigned",
  ALREADY_CLOSED: "already_closed",
  BLOCKED_DEPENDENCIES_PENDING: "blocked_dependencies_pending",
  BLOCKED_DEPENDENCY_CANCELLED: "blocked_dependency_cancelled",
  BLOCKED_DEPENDENCY_MISSING: "blocked_dependency_missing",
  BLOCKED_NO_PENDING_BIDS: "blocked_no_pending_bids",
  BLOCKED_AMBIGUOUS: "blocked_ambiguous",
  BLOCKED_OVER_BUDGET: "blocked_over_budget",
  BLOCKED_ACCEPT_FAILED: "blocked_accept_failed",
  BLOCKED_RFQ_CANCELLED: "blocked_rfq_cancelled",
  BLOCKED_RFQ_INVALID: "blocked_rfq_invalid"
});

const ROUTER_MARKETPLACE_DISPATCH_STATES = new Set(Object.values(ROUTER_MARKETPLACE_DISPATCH_STATE));
const ROUTER_MARKETPLACE_DISPATCH_STRATEGIES = new Set(["lowest_amount_then_eta"]);

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

function normalizeIsoDateTime(value, name) {
  const normalized = assertNonEmptyString(value, name, { max: 128 });
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${name} must be an ISO date-time`);
  return normalized;
}

function normalizePositiveSafeInt(value, name, { allowNull = false, min = 0 } = {}) {
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    throw new TypeError(`${name} is required`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new TypeError(`${name} must be a safe integer >= ${min}`);
  return parsed;
}

function normalizeStrategy(value) {
  const normalized =
    value === null || value === undefined || String(value).trim() === ""
      ? "lowest_amount_then_eta"
      : String(value).trim().toLowerCase();
  if (!ROUTER_MARKETPLACE_DISPATCH_STRATEGIES.has(normalized)) {
    throw new TypeError(`selectionStrategy must be one of ${Array.from(ROUTER_MARKETPLACE_DISPATCH_STRATEGIES.values()).join("|")}`);
  }
  return normalized;
}

function normalizeStringArray(value, name, { maxItems = 200, itemMax = 200 } = {}) {
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > maxItems) throw new TypeError(`${name} must have <= ${maxItems} items`);
  const seen = new Set();
  const out = [];
  for (let index = 0; index < rows.length; index += 1) {
    const item = assertNonEmptyString(rows[index], `${name}[${index}]`, { max: itemMax });
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

function normalizeDispatchState(value, name = "state") {
  const normalized = assertNonEmptyString(value, name, { max: 80 }).toLowerCase();
  if (!ROUTER_MARKETPLACE_DISPATCH_STATES.has(normalized)) {
    throw new TypeError(`${name} must be one of ${Array.from(ROUTER_MARKETPLACE_DISPATCH_STATES.values()).join("|")}`);
  }
  return normalized;
}

function normalizeTasks(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((task, index) => {
    assertPlainObject(task, `tasks[${index}]`);
    return normalizeForCanonicalJson(
      {
        schemaVersion: ROUTER_MARKETPLACE_DISPATCH_TASK_SCHEMA_VERSION,
        taskId: assertNonEmptyString(task.taskId, `tasks[${index}].taskId`, { max: 200 }),
        taskIndex: normalizePositiveSafeInt(task.taskIndex, `tasks[${index}].taskIndex`, { min: 1 }),
        rfqId: assertNonEmptyString(task.rfqId, `tasks[${index}].rfqId`, { max: 200 }),
        dependsOnTaskIds: normalizeStringArray(task.dependsOnTaskIds, `tasks[${index}].dependsOnTaskIds`),
        state: normalizeDispatchState(task.state, `tasks[${index}].state`),
        reasonCode: normalizeOptionalString(task.reasonCode, `tasks[${index}].reasonCode`, { max: 160 }),
        rfqStatus: normalizeOptionalString(task.rfqStatus, `tasks[${index}].rfqStatus`, { max: 64 }),
        acceptedBidId: normalizeOptionalString(task.acceptedBidId, `tasks[${index}].acceptedBidId`, { max: 200 }),
        runId: normalizeOptionalString(task.runId, `tasks[${index}].runId`, { max: 200 }),
        decisionHash: normalizeOptionalString(task.decisionHash, `tasks[${index}].decisionHash`, { max: 64 }),
        blockingTaskIds: normalizeStringArray(task.blockingTaskIds, `tasks[${index}].blockingTaskIds`)
      },
      { path: `$.tasks[${index}]` }
    );
  });
}

export function buildRouterMarketplaceDispatchV1({
  dispatchId,
  launchRef,
  tenantId,
  posterAgentId,
  selectionStrategy = "lowest_amount_then_eta",
  allowOverBudget = false,
  tasks = [],
  metadata = null,
  dispatchedAt = new Date().toISOString()
} = {}) {
  assertPlainObject(launchRef, "launchRef");
  const normalizedTasks = normalizeTasks(tasks);
  const acceptedCount = normalizedTasks.filter((task) => task.state === ROUTER_MARKETPLACE_DISPATCH_STATE.ACCEPTED).length;
  const noopCount = normalizedTasks.filter(
    (task) =>
      task.state === ROUTER_MARKETPLACE_DISPATCH_STATE.ALREADY_ASSIGNED ||
      task.state === ROUTER_MARKETPLACE_DISPATCH_STATE.ALREADY_CLOSED
  ).length;
  const blockedCount = normalizedTasks.length - acceptedCount - noopCount;
  const body = normalizeForCanonicalJson(
    {
      schemaVersion: ROUTER_MARKETPLACE_DISPATCH_SCHEMA_VERSION,
      dispatchId: assertNonEmptyString(dispatchId, "dispatchId", { max: 200 }),
      launchRef: {
        launchId: assertNonEmptyString(launchRef.launchId, "launchRef.launchId", { max: 200 }),
        launchHash: normalizeOptionalString(launchRef.launchHash, "launchRef.launchHash", { max: 64 }),
        planId: normalizeOptionalString(launchRef.planId, "launchRef.planId", { max: 200 }),
        planHash: normalizeOptionalString(launchRef.planHash, "launchRef.planHash", { max: 64 }),
        requestTextSha256: normalizeOptionalString(launchRef.requestTextSha256, "launchRef.requestTextSha256", { max: 64 })
      },
      tenantId: assertNonEmptyString(tenantId, "tenantId", { max: 128 }),
      posterAgentId: assertNonEmptyString(posterAgentId, "posterAgentId", { max: 200 }),
      selectionStrategy: normalizeStrategy(selectionStrategy),
      allowOverBudget: allowOverBudget === true,
      taskCount: normalizedTasks.length,
      acceptedCount,
      noopCount,
      blockedCount,
      tasks: normalizedTasks,
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? normalizeForCanonicalJson(metadata, { path: "$.metadata" })
          : null,
      dispatchedAt: normalizeIsoDateTime(dispatchedAt, "dispatchedAt"),
      dispatchHash: null
    },
    { path: "$" }
  );
  return normalizeForCanonicalJson(
    {
      ...body,
      dispatchHash: sha256Hex(canonicalJsonStringify(body))
    },
    { path: "$" }
  );
}

