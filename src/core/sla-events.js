export const SLA_BREACH_TYPE = Object.freeze({
  START_LATE: "START_LATE",
  COMPLETE_LATE: "COMPLETE_LATE",
  EXCESS_STALL: "EXCESS_STALL",
  ABORTED: "ABORTED"
});

export const SLA_CREDIT_REASON = Object.freeze({
  SLA_BREACH: "SLA_BREACH"
});

export const SLA_CREDIT_TRIGGER_TYPE = Object.freeze({
  SLA_BREACH: "SLA_BREACH"
});

const BREACH_TYPES = new Set(Object.values(SLA_BREACH_TYPE));
const CREDIT_REASONS = new Set(Object.values(SLA_CREDIT_REASON));
const TRIGGER_TYPES = new Set(Object.values(SLA_CREDIT_TRIGGER_TYPE));

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

function assertSlaSnapshot(sla, name) {
  assertPlainObject(sla, name);
  const allowed = new Set(["slaVersion", "mustStartWithinWindow", "maxStallMs", "maxExecutionMs"]);
  for (const key of Object.keys(sla)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field: ${key}`);
  }
  assertSafeInt(sla.slaVersion, `${name}.slaVersion`);
  if (typeof sla.mustStartWithinWindow !== "boolean") throw new TypeError(`${name}.mustStartWithinWindow must be a boolean`);
  assertSafeInt(sla.maxStallMs, `${name}.maxStallMs`);
  if (sla.maxStallMs <= 0) throw new TypeError(`${name}.maxStallMs must be > 0`);
  assertSafeInt(sla.maxExecutionMs, `${name}.maxExecutionMs`);
  if (sla.maxExecutionMs <= 0) throw new TypeError(`${name}.maxExecutionMs must be > 0`);
}

export function validateSlaBreachDetectedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "detectedAt", "settledEventId", "policyHash", "window", "policy", "breaches"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertIsoDate(payload.detectedAt, "payload.detectedAt");
  if (payload.settledEventId !== undefined && payload.settledEventId !== null) assertNonEmptyString(payload.settledEventId, "payload.settledEventId");
  if (payload.policyHash !== undefined && payload.policyHash !== null) assertNonEmptyString(payload.policyHash, "payload.policyHash");

  assertPlainObject(payload.window, "payload.window");
  const winAllowed = new Set(["startAt", "endAt"]);
  for (const key of Object.keys(payload.window)) {
    if (!winAllowed.has(key)) throw new TypeError(`payload.window contains unknown field: ${key}`);
  }
  assertIsoDate(payload.window.startAt, "payload.window.startAt");
  assertIsoDate(payload.window.endAt, "payload.window.endAt");
  if (Date.parse(payload.window.startAt) >= Date.parse(payload.window.endAt)) throw new TypeError("payload.window.startAt must be before endAt");

  assertSlaSnapshot(payload.policy, "payload.policy");

  if (!Array.isArray(payload.breaches) || payload.breaches.length === 0) {
    throw new TypeError("payload.breaches must be a non-empty array");
  }
  for (let i = 0; i < payload.breaches.length; i += 1) {
    const b = payload.breaches[i];
    assertPlainObject(b, `payload.breaches[${i}]`);
    const bAllowed = new Set([
      "type",
      "startedAt",
      "completedAt",
      "abortedAt",
      "windowStartAt",
      "windowEndAt",
      "latenessMs",
      "totalStallMs",
      "maxStallMs"
    ]);
    for (const key of Object.keys(b)) {
      if (!bAllowed.has(key)) throw new TypeError(`payload.breaches[${i}] contains unknown field: ${key}`);
    }
    assertNonEmptyString(b.type, `payload.breaches[${i}].type`);
    if (!BREACH_TYPES.has(b.type)) throw new TypeError(`payload.breaches[${i}].type is not supported`);

    if (b.type === SLA_BREACH_TYPE.START_LATE) {
      assertIsoDate(b.startedAt, `payload.breaches[${i}].startedAt`);
      assertIsoDate(b.windowStartAt, `payload.breaches[${i}].windowStartAt`);
      assertSafeInt(b.latenessMs, `payload.breaches[${i}].latenessMs`);
      if (b.latenessMs < 0) throw new TypeError("latenessMs must be >= 0");
    }
    if (b.type === SLA_BREACH_TYPE.COMPLETE_LATE) {
      assertIsoDate(b.completedAt, `payload.breaches[${i}].completedAt`);
      assertIsoDate(b.windowEndAt, `payload.breaches[${i}].windowEndAt`);
      assertSafeInt(b.latenessMs, `payload.breaches[${i}].latenessMs`);
      if (b.latenessMs < 0) throw new TypeError("latenessMs must be >= 0");
    }
    if (b.type === SLA_BREACH_TYPE.EXCESS_STALL) {
      assertSafeInt(b.totalStallMs, `payload.breaches[${i}].totalStallMs`);
      assertSafeInt(b.maxStallMs, `payload.breaches[${i}].maxStallMs`);
      if (b.totalStallMs < 0) throw new TypeError("totalStallMs must be >= 0");
      if (b.maxStallMs <= 0) throw new TypeError("maxStallMs must be > 0");
    }
    if (b.type === SLA_BREACH_TYPE.ABORTED) {
      assertIsoDate(b.abortedAt, `payload.breaches[${i}].abortedAt`);
    }
  }

  return payload;
}

export function validateSlaCreditIssuedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set([
    "jobId",
    "creditId",
    "issuedAt",
    "amountCents",
    "currency",
    "reason",
    "settledEventId",
    "policyHash",
    "trigger"
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.creditId, "payload.creditId");
  assertIsoDate(payload.issuedAt, "payload.issuedAt");
  assertSafeInt(payload.amountCents, "payload.amountCents");
  if (payload.amountCents <= 0) throw new TypeError("payload.amountCents must be positive");
  assertNonEmptyString(payload.currency, "payload.currency");
  if (payload.currency !== "USD") throw new TypeError("payload.currency is not supported");
  assertNonEmptyString(payload.reason, "payload.reason");
  if (!CREDIT_REASONS.has(payload.reason)) throw new TypeError("payload.reason is not supported");
  if (payload.settledEventId !== undefined && payload.settledEventId !== null) assertNonEmptyString(payload.settledEventId, "payload.settledEventId");
  if (payload.policyHash !== undefined && payload.policyHash !== null) assertNonEmptyString(payload.policyHash, "payload.policyHash");

  if (payload.trigger !== undefined && payload.trigger !== null) {
    assertPlainObject(payload.trigger, "payload.trigger");
    const trigAllowed = new Set(["type", "breachEventId", "detectedAt", "window", "policy", "breaches"]);
    for (const key of Object.keys(payload.trigger)) {
      if (!trigAllowed.has(key)) throw new TypeError(`payload.trigger contains unknown field: ${key}`);
    }

    assertNonEmptyString(payload.trigger.type, "payload.trigger.type");
    if (!TRIGGER_TYPES.has(payload.trigger.type)) throw new TypeError("payload.trigger.type is not supported");
    assertNonEmptyString(payload.trigger.breachEventId, "payload.trigger.breachEventId");
    assertIsoDate(payload.trigger.detectedAt, "payload.trigger.detectedAt");

    assertPlainObject(payload.trigger.window, "payload.trigger.window");
    const winAllowed = new Set(["startAt", "endAt"]);
    for (const key of Object.keys(payload.trigger.window)) {
      if (!winAllowed.has(key)) throw new TypeError(`payload.trigger.window contains unknown field: ${key}`);
    }
    assertIsoDate(payload.trigger.window.startAt, "payload.trigger.window.startAt");
    assertIsoDate(payload.trigger.window.endAt, "payload.trigger.window.endAt");
    if (Date.parse(payload.trigger.window.startAt) >= Date.parse(payload.trigger.window.endAt)) {
      throw new TypeError("payload.trigger.window.startAt must be before endAt");
    }

    assertSlaSnapshot(payload.trigger.policy, "payload.trigger.policy");

    if (!Array.isArray(payload.trigger.breaches) || payload.trigger.breaches.length === 0) {
      throw new TypeError("payload.trigger.breaches must be a non-empty array");
    }
    for (let i = 0; i < payload.trigger.breaches.length; i += 1) {
      const b = payload.trigger.breaches[i];
      assertPlainObject(b, `payload.trigger.breaches[${i}]`);
      const bAllowed = new Set([
        "type",
        "startedAt",
        "completedAt",
        "abortedAt",
        "windowStartAt",
        "windowEndAt",
        "latenessMs",
        "totalStallMs",
        "maxStallMs"
      ]);
      for (const key of Object.keys(b)) {
        if (!bAllowed.has(key)) throw new TypeError(`payload.trigger.breaches[${i}] contains unknown field: ${key}`);
      }
      assertNonEmptyString(b.type, `payload.trigger.breaches[${i}].type`);
      if (!BREACH_TYPES.has(b.type)) throw new TypeError(`payload.trigger.breaches[${i}].type is not supported`);

      if (b.type === SLA_BREACH_TYPE.START_LATE) {
        assertIsoDate(b.startedAt, `payload.trigger.breaches[${i}].startedAt`);
        assertIsoDate(b.windowStartAt, `payload.trigger.breaches[${i}].windowStartAt`);
        assertSafeInt(b.latenessMs, `payload.trigger.breaches[${i}].latenessMs`);
        if (b.latenessMs < 0) throw new TypeError("latenessMs must be >= 0");
      }
      if (b.type === SLA_BREACH_TYPE.COMPLETE_LATE) {
        assertIsoDate(b.completedAt, `payload.trigger.breaches[${i}].completedAt`);
        assertIsoDate(b.windowEndAt, `payload.trigger.breaches[${i}].windowEndAt`);
        assertSafeInt(b.latenessMs, `payload.trigger.breaches[${i}].latenessMs`);
        if (b.latenessMs < 0) throw new TypeError("latenessMs must be >= 0");
      }
      if (b.type === SLA_BREACH_TYPE.EXCESS_STALL) {
        assertSafeInt(b.totalStallMs, `payload.trigger.breaches[${i}].totalStallMs`);
        assertSafeInt(b.maxStallMs, `payload.trigger.breaches[${i}].maxStallMs`);
        if (b.totalStallMs < 0) throw new TypeError("totalStallMs must be >= 0");
        if (b.maxStallMs <= 0) throw new TypeError("maxStallMs must be > 0");
      }
      if (b.type === SLA_BREACH_TYPE.ABORTED) {
        assertIsoDate(b.abortedAt, `payload.trigger.breaches[${i}].abortedAt`);
      }
    }
  }

  return payload;
}
