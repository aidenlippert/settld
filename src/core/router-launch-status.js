import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const ROUTER_LAUNCH_STATUS_SCHEMA_VERSION = "RouterLaunchStatus.v1";
export const ROUTER_LAUNCH_STATUS_TASK_SCHEMA_VERSION = "RouterLaunchStatusTask.v1";

export const ROUTER_LAUNCH_STATUS_TASK_STATE = Object.freeze({
  OPEN_NO_BIDS: "open_no_bids",
  OPEN_READY: "open_ready",
  BLOCKED_DEPENDENCIES_PENDING: "blocked_dependencies_pending",
  BLOCKED_DEPENDENCY_CANCELLED: "blocked_dependency_cancelled",
  BLOCKED_DEPENDENCY_MISSING: "blocked_dependency_missing",
  ASSIGNED: "assigned",
  CLOSED: "closed",
  CANCELLED: "cancelled"
});

const ROUTER_LAUNCH_STATUS_TASK_STATES = new Set(Object.values(ROUTER_LAUNCH_STATUS_TASK_STATE));

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

function normalizeStringArray(value, name, { maxItems = 500, itemMax = 200 } = {}) {
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

function normalizeTaskState(value, name = "state") {
  const normalized = assertNonEmptyString(value, name, { max: 80 }).toLowerCase();
  if (!ROUTER_LAUNCH_STATUS_TASK_STATES.has(normalized)) {
    throw new TypeError(`${name} must be one of ${Array.from(ROUTER_LAUNCH_STATUS_TASK_STATES.values()).join("|")}`);
  }
  return normalized;
}

function normalizeTaskRows(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((task, index) => {
    assertPlainObject(task, `tasks[${index}]`);
    return normalizeForCanonicalJson(
      {
        schemaVersion: ROUTER_LAUNCH_STATUS_TASK_SCHEMA_VERSION,
        taskId: assertNonEmptyString(task.taskId, `tasks[${index}].taskId`, { max: 200 }),
        taskIndex: normalizePositiveSafeInt(task.taskIndex, `tasks[${index}].taskIndex`, { min: 1 }),
        rfqId: assertNonEmptyString(task.rfqId, `tasks[${index}].rfqId`, { max: 200 }),
        title: assertNonEmptyString(task.title, `tasks[${index}].title`, { max: 500 }),
        requiredCapability: assertNonEmptyString(task.requiredCapability, `tasks[${index}].requiredCapability`, { max: 256 }),
        dependsOnTaskIds: normalizeStringArray(task.dependsOnTaskIds, `tasks[${index}].dependsOnTaskIds`),
        candidateAgentIds: normalizeStringArray(task.candidateAgentIds, `tasks[${index}].candidateAgentIds`, { maxItems: 200 }),
        candidateCount: normalizePositiveSafeInt(task.candidateCount, `tasks[${index}].candidateCount`, { min: 0 }),
        state: normalizeTaskState(task.state, `tasks[${index}].state`),
        blockedByTaskIds: normalizeStringArray(task.blockedByTaskIds, `tasks[${index}].blockedByTaskIds`),
        rfqStatus: normalizeOptionalString(task.rfqStatus, `tasks[${index}].rfqStatus`, { max: 64 }),
        bidCount: normalizePositiveSafeInt(task.bidCount, `tasks[${index}].bidCount`, { min: 0 }),
        acceptedBidId: normalizeOptionalString(task.acceptedBidId, `tasks[${index}].acceptedBidId`, { max: 200 }),
        runId: normalizeOptionalString(task.runId, `tasks[${index}].runId`, { max: 200 }),
        settlementStatus: normalizeOptionalString(task.settlementStatus, `tasks[${index}].settlementStatus`, { max: 64 }),
        disputeStatus: normalizeOptionalString(task.disputeStatus, `tasks[${index}].disputeStatus`, { max: 64 }),
        rfq: task.rfq && typeof task.rfq === "object" && !Array.isArray(task.rfq)
          ? normalizeForCanonicalJson(task.rfq, { path: `tasks[${index}].rfq` })
          : null,
        bids: Array.isArray(task.bids)
          ? normalizeForCanonicalJson(task.bids, { path: `tasks[${index}].bids` })
          : [],
        acceptedBid: task.acceptedBid && typeof task.acceptedBid === "object" && !Array.isArray(task.acceptedBid)
          ? normalizeForCanonicalJson(task.acceptedBid, { path: `tasks[${index}].acceptedBid` })
          : null,
        run: task.run && typeof task.run === "object" && !Array.isArray(task.run)
          ? normalizeForCanonicalJson(task.run, { path: `tasks[${index}].run` })
          : null,
        settlement: task.settlement && typeof task.settlement === "object" && !Array.isArray(task.settlement)
          ? normalizeForCanonicalJson(task.settlement, { path: `tasks[${index}].settlement` })
          : null
      },
      { path: `$.tasks[${index}]` }
    );
  });
}

export function buildRouterLaunchStatusV1({
  launchRef,
  tenantId,
  posterAgentId,
  tasks = [],
  generatedAt = new Date().toISOString()
} = {}) {
  assertPlainObject(launchRef, "launchRef");
  const normalizedTasks = normalizeTaskRows(tasks);
  const openCount = normalizedTasks.filter((task) =>
    task.state === ROUTER_LAUNCH_STATUS_TASK_STATE.OPEN_NO_BIDS || task.state === ROUTER_LAUNCH_STATUS_TASK_STATE.OPEN_READY
  ).length;
  const readyCount = normalizedTasks.filter((task) => task.state === ROUTER_LAUNCH_STATUS_TASK_STATE.OPEN_READY).length;
  const blockedCount = normalizedTasks.filter((task) =>
    task.state === ROUTER_LAUNCH_STATUS_TASK_STATE.BLOCKED_DEPENDENCIES_PENDING ||
    task.state === ROUTER_LAUNCH_STATUS_TASK_STATE.BLOCKED_DEPENDENCY_CANCELLED ||
    task.state === ROUTER_LAUNCH_STATUS_TASK_STATE.BLOCKED_DEPENDENCY_MISSING
  ).length;
  const assignedCount = normalizedTasks.filter((task) => task.state === ROUTER_LAUNCH_STATUS_TASK_STATE.ASSIGNED).length;
  const closedCount = normalizedTasks.filter((task) => task.state === ROUTER_LAUNCH_STATUS_TASK_STATE.CLOSED).length;
  const cancelledCount = normalizedTasks.filter((task) => task.state === ROUTER_LAUNCH_STATUS_TASK_STATE.CANCELLED).length;
  const settlementLockedCount = normalizedTasks.filter((task) => task.settlementStatus === "locked").length;
  const settlementReleasedCount = normalizedTasks.filter((task) => task.settlementStatus === "released").length;
  const disputeOpenCount = normalizedTasks.filter((task) => task.disputeStatus === "open").length;
  const body = normalizeForCanonicalJson(
    {
      schemaVersion: ROUTER_LAUNCH_STATUS_SCHEMA_VERSION,
      launchRef: {
        launchId: assertNonEmptyString(launchRef.launchId, "launchRef.launchId", { max: 200 }),
        launchHash: normalizeOptionalString(launchRef.launchHash, "launchRef.launchHash", { max: 64 }),
        planId: normalizeOptionalString(launchRef.planId, "launchRef.planId", { max: 200 }),
        planHash: normalizeOptionalString(launchRef.planHash, "launchRef.planHash", { max: 64 }),
        requestTextSha256: normalizeOptionalString(launchRef.requestTextSha256, "launchRef.requestTextSha256", { max: 64 })
      },
      tenantId: assertNonEmptyString(tenantId, "tenantId", { max: 128 }),
      posterAgentId: assertNonEmptyString(posterAgentId, "posterAgentId", { max: 200 }),
      taskCount: normalizedTasks.length,
      summary: {
        openCount,
        readyCount,
        blockedCount,
        assignedCount,
        closedCount,
        cancelledCount,
        settlementLockedCount,
        settlementReleasedCount,
        disputeOpenCount
      },
      tasks: normalizedTasks,
      generatedAt: normalizeIsoDateTime(generatedAt, "generatedAt"),
      statusHash: null
    },
    { path: "$" }
  );
  return normalizeForCanonicalJson(
    {
      ...body,
      statusHash: sha256Hex(canonicalJsonStringify(body))
    },
    { path: "$" }
  );
}
