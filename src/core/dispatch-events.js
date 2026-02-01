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

const DISPATCH_FAILURE_REASONS = new Set(["NO_SUPPLY", "NO_ROBOTS", "NO_OPERATORS", "CONFLICT", "INVALID_STATE"]);

export function validateDispatchRequestedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "requestedAt", "trigger"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertIsoDate(payload.requestedAt, "payload.requestedAt");
  if (payload.trigger !== undefined && payload.trigger !== null) assertNonEmptyString(payload.trigger, "payload.trigger");
  return payload;
}

export function validateDispatchEvaluatedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "evaluatedAt", "window", "zoneId", "requiresOperatorCoverage", "candidates", "selected"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertIsoDate(payload.evaluatedAt, "payload.evaluatedAt");

  assertPlainObject(payload.window, "payload.window");
  const winAllowed = new Set(["startAt", "endAt"]);
  for (const key of Object.keys(payload.window)) {
    if (!winAllowed.has(key)) throw new TypeError(`payload.window contains unknown field: ${key}`);
  }
  assertIsoDate(payload.window.startAt, "payload.window.startAt");
  assertIsoDate(payload.window.endAt, "payload.window.endAt");
  if (Date.parse(payload.window.startAt) >= Date.parse(payload.window.endAt)) throw new TypeError("payload.window.startAt must be before endAt");

  if (payload.zoneId !== undefined && payload.zoneId !== null) assertNonEmptyString(payload.zoneId, "payload.zoneId");
  if (payload.requiresOperatorCoverage !== undefined && typeof payload.requiresOperatorCoverage !== "boolean") {
    throw new TypeError("payload.requiresOperatorCoverage must be a boolean");
  }

  if (payload.candidates !== undefined && payload.candidates !== null) {
    if (!Array.isArray(payload.candidates)) throw new TypeError("payload.candidates must be an array");
    for (let i = 0; i < payload.candidates.length; i += 1) {
      const item = payload.candidates[i];
      assertPlainObject(item, `payload.candidates[${i}]`);
      const itemAllowed = new Set(["robotId", "score", "reasons", "rejected"]);
      for (const key of Object.keys(item)) {
        if (!itemAllowed.has(key)) throw new TypeError(`payload.candidates[${i}] contains unknown field: ${key}`);
      }
      assertNonEmptyString(item.robotId, `payload.candidates[${i}].robotId`);
      if (typeof item.score !== "number" || !Number.isFinite(item.score)) throw new TypeError(`payload.candidates[${i}].score must be a finite number`);
      if (item.rejected !== undefined && typeof item.rejected !== "boolean") throw new TypeError(`payload.candidates[${i}].rejected must be a boolean`);
      if (item.reasons !== undefined && item.reasons !== null) {
        if (!Array.isArray(item.reasons)) throw new TypeError(`payload.candidates[${i}].reasons must be an array`);
        for (const r of item.reasons) assertNonEmptyString(r, `payload.candidates[${i}].reasons[]`);
      }
    }
  }

  if (payload.selected !== undefined && payload.selected !== null) {
    assertPlainObject(payload.selected, "payload.selected");
    const selAllowed = new Set(["robotId", "operatorId"]);
    for (const key of Object.keys(payload.selected)) {
      if (!selAllowed.has(key)) throw new TypeError(`payload.selected contains unknown field: ${key}`);
    }
    assertNonEmptyString(payload.selected.robotId, "payload.selected.robotId");
    if (payload.selected.operatorId !== undefined && payload.selected.operatorId !== null) assertNonEmptyString(payload.selected.operatorId, "payload.selected.operatorId");
  }

  return payload;
}

export function validateDispatchConfirmedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "confirmedAt"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertIsoDate(payload.confirmedAt, "payload.confirmedAt");
  return payload;
}

export function validateDispatchFailedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "failedAt", "reason", "details"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertIsoDate(payload.failedAt, "payload.failedAt");
  assertNonEmptyString(payload.reason, "payload.reason");
  if (!DISPATCH_FAILURE_REASONS.has(payload.reason)) throw new TypeError("payload.reason is not supported");
  if (payload.details !== undefined && payload.details !== null) {
    assertPlainObject(payload.details, "payload.details");
  }
  return payload;
}

