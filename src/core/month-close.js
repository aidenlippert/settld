import { parseYearMonth } from "./statements.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "./tenancy.js";

export const MONTH_CLOSE_BASIS = Object.freeze({
  SETTLED_AT: "settledAt"
});

const BASES = new Set(Object.values(MONTH_CLOSE_BASIS));

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

export function makeMonthCloseStreamId({ month, basis = MONTH_CLOSE_BASIS.SETTLED_AT } = {}) {
  assertNonEmptyString(month, "month");
  parseYearMonth(month);
  assertNonEmptyString(basis, "basis");
  if (!BASES.has(basis)) throw new TypeError("unsupported basis");
  return `month_close_${month}_${basis}`;
}

export function validateMonthCloseRequestedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["tenantId", "month", "basis", "requestedAt"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  const tenantId = normalizeTenantId(payload.tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(payload.month, "payload.month");
  parseYearMonth(payload.month);
  assertNonEmptyString(payload.basis, "payload.basis");
  if (!BASES.has(payload.basis)) throw new TypeError("payload.basis is not supported");
  assertIsoDate(payload.requestedAt, "payload.requestedAt");
  return { ...payload, tenantId };
}

export function validateMonthClosedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["tenantId", "month", "basis", "closedAt", "statementArtifactId", "statementArtifactHash"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  const tenantId = normalizeTenantId(payload.tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(payload.month, "payload.month");
  parseYearMonth(payload.month);
  assertNonEmptyString(payload.basis, "payload.basis");
  if (!BASES.has(payload.basis)) throw new TypeError("payload.basis is not supported");
  assertIsoDate(payload.closedAt, "payload.closedAt");
  assertNonEmptyString(payload.statementArtifactId, "payload.statementArtifactId");
  assertNonEmptyString(payload.statementArtifactHash, "payload.statementArtifactHash");
  return { ...payload, tenantId };
}

export function validateMonthCloseReopenedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["tenantId", "month", "basis", "reopenedAt", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  const tenantId = normalizeTenantId(payload.tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(payload.month, "payload.month");
  parseYearMonth(payload.month);
  assertNonEmptyString(payload.basis, "payload.basis");
  if (!BASES.has(payload.basis)) throw new TypeError("payload.basis is not supported");
  assertIsoDate(payload.reopenedAt, "payload.reopenedAt");
  if (payload.reason !== undefined && payload.reason !== null) assertNonEmptyString(payload.reason, "payload.reason");
  return { ...payload, tenantId };
}

export function reduceMonthClose(events) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  if (events.length === 0) return null;

  const head = events[events.length - 1];
  const streamId = head?.streamId ?? null;
  if (typeof streamId !== "string" || streamId.trim() === "") throw new TypeError("month streamId is required");

  let state = {
    id: streamId,
    tenantId: DEFAULT_TENANT_ID,
    month: null,
    basis: MONTH_CLOSE_BASIS.SETTLED_AT,
    status: "OPEN", // OPEN|CLOSED
    requestedAt: null,
    closedAt: null,
    reopenedAt: null,
    statementArtifactId: null,
    statementArtifactHash: null,
    lastChainHash: null,
    lastEventId: null,
    updatedAt: head?.at ?? null
  };

  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "MONTH_CLOSE_REQUESTED") {
      const p = e.payload ?? {};
      state = {
        ...state,
        tenantId: normalizeTenantId(p.tenantId ?? state.tenantId),
        month: p.month ?? state.month,
        basis: p.basis ?? state.basis,
        requestedAt: p.requestedAt ?? e.at ?? state.requestedAt,
        updatedAt: e.at ?? state.updatedAt
      };
    }
    if (e.type === "MONTH_CLOSED") {
      const p = e.payload ?? {};
      state = {
        ...state,
        tenantId: normalizeTenantId(p.tenantId ?? state.tenantId),
        month: p.month ?? state.month,
        basis: p.basis ?? state.basis,
        status: "CLOSED",
        closedAt: p.closedAt ?? e.at ?? state.closedAt,
        statementArtifactId: p.statementArtifactId ?? state.statementArtifactId,
        statementArtifactHash: p.statementArtifactHash ?? state.statementArtifactHash,
        updatedAt: e.at ?? state.updatedAt
      };
    }
    if (e.type === "MONTH_CLOSE_REOPENED") {
      const p = e.payload ?? {};
      state = {
        ...state,
        tenantId: normalizeTenantId(p.tenantId ?? state.tenantId),
        month: p.month ?? state.month,
        basis: p.basis ?? state.basis,
        status: "OPEN",
        reopenedAt: p.reopenedAt ?? e.at ?? state.reopenedAt,
        closedAt: null,
        statementArtifactId: null,
        statementArtifactHash: null,
        updatedAt: e.at ?? state.updatedAt
      };
    }
  }

  state = {
    ...state,
    lastChainHash: head?.chainHash ?? null,
    lastEventId: head?.id ?? null
  };

  return state;
}

