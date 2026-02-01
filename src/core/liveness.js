import { ENV_TIER } from "./booking.js";

export const EXECUTION_STAGE = Object.freeze({
  ARRIVED: "ARRIVED",
  ACCESS: "ACCESS",
  TASK: "TASK",
  EXIT: "EXIT"
});

const EXECUTION_STAGES = new Set(Object.values(EXECUTION_STAGE));
const STALL_REASONS = new Set(["NO_HEARTBEAT", "ROBOT_ERROR", "OPERATOR_QUEUE_TIMEOUT"]);

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new TypeError(`${name} must be an ISO date string`);
}

function assertSafeInt(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

function assertStage(value, name) {
  assertNonEmptyString(value, name);
  if (!EXECUTION_STAGES.has(value)) throw new TypeError(`${name} is not a supported execution stage`);
}

export function computeLivenessPolicy({ environmentTier } = {}) {
  const heartbeatIntervalMs =
    environmentTier === ENV_TIER.ENV_IN_HOME
      ? 30_000
      : environmentTier === ENV_TIER.ENV_HOSPITALITY
        ? 60_000
        : environmentTier === ENV_TIER.ENV_OFFICE_AFTER_HOURS
          ? 60_000
          : 60_000;

  const stallAfterMs = heartbeatIntervalMs * 3;
  return { heartbeatIntervalMs, stallAfterMs };
}

export function validateJobExecutionStartedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "robotId", "startedAt", "stage"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.startedAt, "payload.startedAt");
  if (payload.stage !== undefined && payload.stage !== null) assertStage(payload.stage, "payload.stage");
  return payload;
}

export function validateJobHeartbeatPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "robotId", "t", "stage", "progress", "assistRequested"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.t, "payload.t");
  assertStage(payload.stage, "payload.stage");

  if (payload.progress !== undefined && payload.progress !== null) {
    if (Number.isSafeInteger(payload.progress)) {
      if (payload.progress < 0) throw new TypeError("payload.progress must be >= 0");
    } else if (typeof payload.progress === "number" && Number.isFinite(payload.progress)) {
      if (payload.progress < 0 || payload.progress > 1) throw new TypeError("payload.progress must be within 0..1");
    } else {
      throw new TypeError("payload.progress must be a safe integer step or a finite number within 0..1");
    }
  }

  if (payload.assistRequested !== undefined && typeof payload.assistRequested !== "boolean") {
    throw new TypeError("payload.assistRequested must be a boolean");
  }
  return payload;
}

export function validateJobExecutionStalledPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "robotId", "detectedAt", "reason", "lastHeartbeatAt", "policy"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.detectedAt, "payload.detectedAt");
  assertNonEmptyString(payload.reason, "payload.reason");
  if (!STALL_REASONS.has(payload.reason)) throw new TypeError("payload.reason is not supported");
  assertIsoDate(payload.lastHeartbeatAt, "payload.lastHeartbeatAt");

  assertPlainObject(payload.policy, "payload.policy");
  const policyAllowed = new Set(["heartbeatIntervalMs", "stallAfterMs"]);
  for (const key of Object.keys(payload.policy)) {
    if (!policyAllowed.has(key)) throw new TypeError(`payload.policy contains unknown field: ${key}`);
  }
  assertSafeInt(payload.policy.heartbeatIntervalMs, "payload.policy.heartbeatIntervalMs");
  assertSafeInt(payload.policy.stallAfterMs, "payload.policy.stallAfterMs");
  if (payload.policy.heartbeatIntervalMs <= 0) throw new TypeError("payload.policy.heartbeatIntervalMs must be > 0");
  if (payload.policy.stallAfterMs <= 0) throw new TypeError("payload.policy.stallAfterMs must be > 0");
  return payload;
}

export function validateJobExecutionResumedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "robotId", "resumedAt"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.resumedAt, "payload.resumedAt");
  return payload;
}

export function validateJobExecutionAbortedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "robotId", "abortedAt", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.abortedAt, "payload.abortedAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  return payload;
}

export function validateJobExecutionCompletedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "robotId", "completedAt"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.completedAt, "payload.completedAt");
  return payload;
}

