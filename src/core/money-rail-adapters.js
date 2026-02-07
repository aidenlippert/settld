import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";

export const MONEY_RAIL_DIRECTION = Object.freeze({
  PAYOUT: "payout",
  COLLECTION: "collection"
});

export const MONEY_RAIL_OPERATION_STATE = Object.freeze({
  INITIATED: "initiated",
  SUBMITTED: "submitted",
  CONFIRMED: "confirmed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  REVERSED: "reversed"
});

export const MONEY_RAIL_PROVIDER_EVENT_TYPE = Object.freeze({
  SUBMITTED: "submitted",
  CONFIRMED: "confirmed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  REVERSED: "reversed"
});

const ALLOWED_STATE_TRANSITIONS = new Map([
  [MONEY_RAIL_OPERATION_STATE.INITIATED, new Set([MONEY_RAIL_OPERATION_STATE.SUBMITTED, MONEY_RAIL_OPERATION_STATE.FAILED, MONEY_RAIL_OPERATION_STATE.CANCELLED])],
  [MONEY_RAIL_OPERATION_STATE.SUBMITTED, new Set([MONEY_RAIL_OPERATION_STATE.CONFIRMED, MONEY_RAIL_OPERATION_STATE.FAILED, MONEY_RAIL_OPERATION_STATE.CANCELLED])],
  [MONEY_RAIL_OPERATION_STATE.CONFIRMED, new Set([MONEY_RAIL_OPERATION_STATE.REVERSED])],
  [MONEY_RAIL_OPERATION_STATE.FAILED, new Set()],
  [MONEY_RAIL_OPERATION_STATE.CANCELLED, new Set()],
  [MONEY_RAIL_OPERATION_STATE.REVERSED, new Set()]
]);

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertNoNewlines(value, name) {
  if (String(value).includes("\n") || String(value).includes("\r")) throw new TypeError(`${name} must not contain newlines`);
}

function normalizeIsoDate(value, name) {
  assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO date-time`);
  return value;
}

function normalizeCurrency(value) {
  assertNonEmptyString(value, "currency");
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(normalized)) throw new TypeError("currency must match ^[A-Z][A-Z0-9_]{2,11}$");
  return normalized;
}

function normalizeDirection(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!Object.values(MONEY_RAIL_DIRECTION).includes(normalized)) {
    throw new TypeError(`direction must be one of: ${Object.values(MONEY_RAIL_DIRECTION).join("|")}`);
  }
  return normalized;
}

function normalizeState(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!Object.values(MONEY_RAIL_OPERATION_STATE).includes(normalized)) {
    throw new TypeError(`state must be one of: ${Object.values(MONEY_RAIL_OPERATION_STATE).join("|")}`);
  }
  return normalized;
}

function normalizeProviderEventType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!Object.values(MONEY_RAIL_PROVIDER_EVENT_TYPE).includes(normalized)) {
    throw new TypeError(`eventType must be one of: ${Object.values(MONEY_RAIL_PROVIDER_EVENT_TYPE).join("|")}`);
  }
  return normalized;
}

function normalizeAmountCents(value) {
  const amountCents = Number(value);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
  return amountCents;
}

function normalizeIdempotencyKey(value) {
  assertNonEmptyString(value, "idempotencyKey");
  assertNoNewlines(value, "idempotencyKey");
  const normalized = value.trim();
  if (normalized.length > 500) throw new TypeError("idempotencyKey is too long");
  return normalized;
}

function normalizeRequestMetadata(value) {
  if (value === null || value === undefined) return null;
  assertPlainObject(value, "metadata");
  return normalizeForCanonicalJson(value, { path: "$" });
}

function buildOperationRequestHash(input) {
  const normalized = normalizeForCanonicalJson(
    {
      tenantId: input.tenantId,
      operationId: input.operationId,
      direction: input.direction,
      idempotencyKey: input.idempotencyKey,
      amountCents: input.amountCents,
      currency: input.currency,
      counterpartyRef: input.counterpartyRef,
      metadata: input.metadata ?? null
    },
    { path: "$" }
  );
  return canonicalJsonStringify(normalized);
}

function deriveRequestHashFromOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
  try {
    return buildOperationRequestHash({
      tenantId: operation.tenantId,
      operationId: operation.operationId,
      direction: operation.direction,
      idempotencyKey: operation.idempotencyKey,
      amountCents: operation.amountCents,
      currency: operation.currency,
      counterpartyRef: operation.counterpartyRef,
      metadata: operation.metadata ?? null
    });
  } catch {
    return null;
  }
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function stripInternalOperationFields(operation) {
  const next = clone(operation);
  if (next && typeof next === "object" && !Array.isArray(next)) {
    delete next.requestHash;
  }
  return next;
}

function createConflictError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertStateTransitionAllowed({ from, to }) {
  const fromState = normalizeState(from);
  const toState = normalizeState(to);
  if (fromState === toState) return;
  const allowed = ALLOWED_STATE_TRANSITIONS.get(fromState);
  if (!allowed || !allowed.has(toState)) {
    throw createConflictError("MONEY_RAIL_INVALID_TRANSITION", `invalid state transition: ${fromState} -> ${toState}`);
  }
}

function applyStateTransition({ operation, nextState, at, providerRef = null, reasonCode = null }) {
  assertPlainObject(operation, "operation");
  const fromState = normalizeState(operation.state);
  const toState = normalizeState(nextState);
  assertStateTransitionAllowed({ from: fromState, to: toState });

  if (fromState === toState) return clone(operation);

  const timestamp = normalizeIsoDate(at, "at");
  const next = {
    ...operation,
    state: toState,
    updatedAt: timestamp,
    providerRef: providerRef === null || providerRef === undefined ? operation.providerRef ?? null : String(providerRef),
    reasonCode: reasonCode === null || reasonCode === undefined ? operation.reasonCode ?? null : String(reasonCode)
  };
  if (toState === MONEY_RAIL_OPERATION_STATE.SUBMITTED) next.submittedAt = timestamp;
  if (toState === MONEY_RAIL_OPERATION_STATE.CONFIRMED) next.confirmedAt = timestamp;
  if (toState === MONEY_RAIL_OPERATION_STATE.FAILED) next.failedAt = timestamp;
  if (toState === MONEY_RAIL_OPERATION_STATE.CANCELLED) next.cancelledAt = timestamp;
  if (toState === MONEY_RAIL_OPERATION_STATE.REVERSED) next.reversedAt = timestamp;
  return next;
}

function normalizeCreateInput(input, { now }) {
  assertPlainObject(input, "input");
  const tenantId = String(input.tenantId ?? "").trim();
  const operationId = String(input.operationId ?? "").trim();
  const counterpartyRef = String(input.counterpartyRef ?? "").trim();
  if (!tenantId) throw new TypeError("tenantId is required");
  if (!operationId) throw new TypeError("operationId is required");
  if (!counterpartyRef) throw new TypeError("counterpartyRef is required");
  const direction = normalizeDirection(input.direction);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const amountCents = normalizeAmountCents(input.amountCents);
  const currency = normalizeCurrency(input.currency ?? "USD");
  const metadata = normalizeRequestMetadata(input.metadata);
  const at = normalizeIsoDate(input.at ?? now(), "at");
  return {
    tenantId,
    operationId,
    direction,
    idempotencyKey,
    amountCents,
    currency,
    counterpartyRef,
    metadata,
    at
  };
}

function buildOperationRecord({ providerId, input }) {
  return {
    schemaVersion: "MoneyRailOperation.v1",
    providerId,
    operationId: input.operationId,
    tenantId: input.tenantId,
    direction: input.direction,
    idempotencyKey: input.idempotencyKey,
    amountCents: input.amountCents,
    currency: input.currency,
    counterpartyRef: input.counterpartyRef,
    metadata: input.metadata,
    state: MONEY_RAIL_OPERATION_STATE.INITIATED,
    providerRef: null,
    reasonCode: null,
    initiatedAt: input.at,
    submittedAt: null,
    confirmedAt: null,
    failedAt: null,
    cancelledAt: null,
    reversedAt: null,
    createdAt: input.at,
    updatedAt: input.at
  };
}

function operationStoreKey({ tenantId, operationId }) {
  return `${tenantId}\n${operationId}`;
}

function idempotencyStoreKey({ tenantId, direction, idempotencyKey }) {
  return `${tenantId}\n${direction}\n${idempotencyKey}`;
}

export function assertMoneyRailAdapter(adapter, { name = "adapter" } = {}) {
  if (!adapter || typeof adapter !== "object") throw new TypeError(`${name} must be an object`);
  if (typeof adapter.create !== "function") throw new TypeError(`${name}.create must be a function`);
  if (typeof adapter.status !== "function") throw new TypeError(`${name}.status must be a function`);
  if (typeof adapter.cancel !== "function") throw new TypeError(`${name}.cancel must be a function`);
  if ("listOperations" in adapter && typeof adapter.listOperations !== "function") {
    throw new TypeError(`${name}.listOperations must be a function when provided`);
  }
  if ("ingestProviderEvent" in adapter && typeof adapter.ingestProviderEvent !== "function") {
    throw new TypeError(`${name}.ingestProviderEvent must be a function when provided`);
  }
}

export function createInMemoryMoneyRailAdapter({ providerId = "stub_memory", now = () => new Date().toISOString() } = {}) {
  assertNonEmptyString(providerId, "providerId");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const operationsByKey = new Map();
  const idempotencyByKey = new Map();
  const providerEventsByKey = new Map();

  async function create(input) {
    const normalized = normalizeCreateInput(input, { now });
    const opKey = operationStoreKey({ tenantId: normalized.tenantId, operationId: normalized.operationId });
    const idemKey = idempotencyStoreKey({
      tenantId: normalized.tenantId,
      direction: normalized.direction,
      idempotencyKey: normalized.idempotencyKey
    });
    const requestHash = buildOperationRequestHash(normalized);

    const existingByIdempotency = idempotencyByKey.get(idemKey) ?? null;
    if (existingByIdempotency) {
      if (existingByIdempotency.requestHash !== requestHash) {
        throw createConflictError("MONEY_RAIL_IDEMPOTENCY_CONFLICT", "idempotency key was already used with a different request");
      }
      const existing = operationsByKey.get(existingByIdempotency.operationKey) ?? null;
      if (!existing) {
        throw createConflictError("MONEY_RAIL_STORE_CORRUPT", "idempotency index references missing operation");
      }
      return { operation: clone(existing), idempotentReplay: true };
    }

    const existingByOperationId = operationsByKey.get(opKey) ?? null;
    if (existingByOperationId) {
      const existingHash = buildOperationRequestHash({
        tenantId: existingByOperationId.tenantId,
        operationId: existingByOperationId.operationId,
        direction: existingByOperationId.direction,
        idempotencyKey: existingByOperationId.idempotencyKey,
        amountCents: existingByOperationId.amountCents,
        currency: existingByOperationId.currency,
        counterpartyRef: existingByOperationId.counterpartyRef,
        metadata: existingByOperationId.metadata
      });
      if (existingHash !== requestHash) {
        throw createConflictError("MONEY_RAIL_OPERATION_CONFLICT", "operationId already exists with a different request");
      }
      idempotencyByKey.set(idemKey, { requestHash, operationKey: opKey });
      return { operation: clone(existingByOperationId), idempotentReplay: true };
    }

    const operation = buildOperationRecord({ providerId, input: normalized });
    operationsByKey.set(opKey, operation);
    idempotencyByKey.set(idemKey, { requestHash, operationKey: opKey });
    return { operation: clone(operation), idempotentReplay: false };
  }

  async function status({ tenantId, operationId } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    assertNonEmptyString(operationId, "operationId");
    const op = operationsByKey.get(operationStoreKey({ tenantId: tenantId.trim(), operationId: operationId.trim() })) ?? null;
    return op ? clone(op) : null;
  }

  async function listOperations({ tenantId } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    const normalizedTenantId = tenantId.trim();
    const rows = [];
    for (const op of operationsByKey.values()) {
      if (!op || typeof op !== "object") continue;
      if (String(op.tenantId ?? "") !== normalizedTenantId) continue;
      rows.push(clone(op));
    }
    rows.sort((a, b) => String(a.operationId ?? "").localeCompare(String(b.operationId ?? "")));
    return rows;
  }

  async function cancel({ tenantId, operationId, reasonCode = "cancelled_by_caller", at = now() } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    assertNonEmptyString(operationId, "operationId");
    const opKey = operationStoreKey({ tenantId: tenantId.trim(), operationId: operationId.trim() });
    const current = operationsByKey.get(opKey) ?? null;
    if (!current) throw createConflictError("MONEY_RAIL_OPERATION_NOT_FOUND", "operation not found");

    if (
      current.state === MONEY_RAIL_OPERATION_STATE.CANCELLED ||
      current.state === MONEY_RAIL_OPERATION_STATE.CONFIRMED ||
      current.state === MONEY_RAIL_OPERATION_STATE.FAILED ||
      current.state === MONEY_RAIL_OPERATION_STATE.REVERSED
    ) {
      return { operation: clone(current), applied: false };
    }

    const next = applyStateTransition({
      operation: current,
      nextState: MONEY_RAIL_OPERATION_STATE.CANCELLED,
      at,
      reasonCode
    });
    operationsByKey.set(opKey, next);
    return { operation: clone(next), applied: true };
  }

  async function transition({ tenantId, operationId, state, providerRef = null, reasonCode = null, at = now() } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    assertNonEmptyString(operationId, "operationId");
    const opKey = operationStoreKey({ tenantId: tenantId.trim(), operationId: operationId.trim() });
    const current = operationsByKey.get(opKey) ?? null;
    if (!current) throw createConflictError("MONEY_RAIL_OPERATION_NOT_FOUND", "operation not found");

    const next = applyStateTransition({
      operation: current,
      nextState: normalizeState(state),
      at,
      providerRef,
      reasonCode
    });
    operationsByKey.set(opKey, next);
    return clone(next);
  }

  async function ingestProviderEvent({
    tenantId,
    operationId,
    eventType,
    providerRef = null,
    reasonCode = null,
    at = now(),
    eventId = null,
    payload = null
  } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    assertNonEmptyString(operationId, "operationId");
    const opKey = operationStoreKey({ tenantId: tenantId.trim(), operationId: operationId.trim() });
    const current = operationsByKey.get(opKey) ?? null;
    if (!current) throw createConflictError("MONEY_RAIL_OPERATION_NOT_FOUND", "operation not found");

    const normalizedEventType = normalizeProviderEventType(eventType);
    const normalizedAt = normalizeIsoDate(at, "at");
    const normalizedEventId = eventId === null || eventId === undefined ? null : String(eventId).trim();
    const eventStoreKey = `${opKey}\n${normalizedEventType}\n${normalizedEventId ?? normalizedAt}`;
    if (providerEventsByKey.has(eventStoreKey)) {
      const existing = providerEventsByKey.get(eventStoreKey);
      return { operation: clone(existing.operation), applied: false, event: clone(existing.event) };
    }

    const nextState = normalizedEventType;
    let next = null;
    try {
      next = applyStateTransition({
        operation: current,
        nextState,
        at: normalizedAt,
        providerRef,
        reasonCode
      });
    } catch (err) {
      if (err?.code !== "MONEY_RAIL_INVALID_TRANSITION") throw err;
      const fromState = normalizeState(current.state);
      if (fromState === nextState) {
        const event = {
          schemaVersion: "MoneyRailProviderEvent.v1",
          providerId,
          tenantId: tenantId.trim(),
          operationId: operationId.trim(),
          eventType: normalizedEventType,
          eventId: normalizedEventId,
          at: normalizedAt,
          payload: clone(payload)
        };
        providerEventsByKey.set(eventStoreKey, { event, operation: current });
        return { operation: clone(current), applied: false, event: clone(event) };
      }
      throw err;
    }

    operationsByKey.set(opKey, next);
    const event = {
      schemaVersion: "MoneyRailProviderEvent.v1",
      providerId,
      tenantId: tenantId.trim(),
      operationId: operationId.trim(),
      eventType: normalizedEventType,
      eventId: normalizedEventId,
      at: normalizedAt,
      payload: clone(payload)
    };
    providerEventsByKey.set(eventStoreKey, { event, operation: next });
    return { operation: clone(next), applied: true, event: clone(event) };
  }

  return {
    providerId,
    create,
    status,
    listOperations,
    cancel,
    transition,
    ingestProviderEvent
  };
}

export function createStoreBackedMoneyRailAdapter({ providerId = "stub_memory", store = null, now = () => new Date().toISOString() } = {}) {
  assertNonEmptyString(providerId, "providerId");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const supportsStorePersistence =
    store &&
    typeof store === "object" &&
    typeof store.getMoneyRailOperation === "function" &&
    typeof store.findMoneyRailOperationByIdempotency === "function" &&
    typeof store.listMoneyRailOperations === "function" &&
    typeof store.putMoneyRailOperation === "function" &&
    typeof store.getMoneyRailProviderEvent === "function" &&
    typeof store.putMoneyRailProviderEvent === "function";

  if (!supportsStorePersistence) {
    return createInMemoryMoneyRailAdapter({ providerId, now });
  }

  async function loadOperation({ tenantId, operationId }) {
    const loaded = await store.getMoneyRailOperation({ tenantId, providerId, operationId });
    return loaded && typeof loaded === "object" && !Array.isArray(loaded) ? clone(loaded) : null;
  }

  async function create(input) {
    const normalized = normalizeCreateInput(input, { now });
    const requestHash = buildOperationRequestHash(normalized);
    const existingByIdempotency = await store.findMoneyRailOperationByIdempotency({
      tenantId: normalized.tenantId,
      providerId,
      direction: normalized.direction,
      idempotencyKey: normalized.idempotencyKey
    });
    if (existingByIdempotency) {
      const existingHash = existingByIdempotency.requestHash ?? deriveRequestHashFromOperation(existingByIdempotency);
      if (existingHash && existingHash !== requestHash) {
        throw createConflictError("MONEY_RAIL_IDEMPOTENCY_CONFLICT", "idempotency key was already used with a different request");
      }
      return { operation: stripInternalOperationFields(existingByIdempotency), idempotentReplay: true };
    }

    const existingByOperationId = await loadOperation({ tenantId: normalized.tenantId, operationId: normalized.operationId });
    if (existingByOperationId) {
      const existingHash = existingByOperationId.requestHash ?? deriveRequestHashFromOperation(existingByOperationId);
      if (existingHash && existingHash !== requestHash) {
        throw createConflictError("MONEY_RAIL_OPERATION_CONFLICT", "operationId already exists with a different request");
      }
      return { operation: stripInternalOperationFields(existingByOperationId), idempotentReplay: true };
    }

    const operation = { ...buildOperationRecord({ providerId, input: normalized }), requestHash };
    const persisted = await store.putMoneyRailOperation({
      tenantId: normalized.tenantId,
      providerId,
      operation,
      requestHash
    });
    const savedOperation = persisted?.operation && typeof persisted.operation === "object" ? persisted.operation : operation;
    const created = persisted?.created !== false;
    return { operation: stripInternalOperationFields(savedOperation), idempotentReplay: !created };
  }

  async function status({ tenantId, operationId } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    assertNonEmptyString(operationId, "operationId");
    const operation = await loadOperation({ tenantId: tenantId.trim(), operationId: operationId.trim() });
    return operation ? stripInternalOperationFields(operation) : null;
  }

  async function listOperations({ tenantId } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    const rows = await store.listMoneyRailOperations({ tenantId: tenantId.trim(), providerId });
    const out = Array.isArray(rows) ? rows : [];
    out.sort((a, b) => String(a?.operationId ?? "").localeCompare(String(b?.operationId ?? "")));
    return out.map((row) => stripInternalOperationFields(row));
  }

  async function cancel({ tenantId, operationId, reasonCode = "cancelled_by_caller", at = now() } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    assertNonEmptyString(operationId, "operationId");
    const current = await loadOperation({ tenantId: tenantId.trim(), operationId: operationId.trim() });
    if (!current) throw createConflictError("MONEY_RAIL_OPERATION_NOT_FOUND", "operation not found");

    if (
      current.state === MONEY_RAIL_OPERATION_STATE.CANCELLED ||
      current.state === MONEY_RAIL_OPERATION_STATE.CONFIRMED ||
      current.state === MONEY_RAIL_OPERATION_STATE.FAILED ||
      current.state === MONEY_RAIL_OPERATION_STATE.REVERSED
    ) {
      return { operation: stripInternalOperationFields(current), applied: false };
    }

    const next = applyStateTransition({
      operation: current,
      nextState: MONEY_RAIL_OPERATION_STATE.CANCELLED,
      at,
      reasonCode
    });
    const persisted = await store.putMoneyRailOperation({
      tenantId: tenantId.trim(),
      providerId,
      operation: next,
      requestHash: current.requestHash ?? null
    });
    const operation = persisted?.operation && typeof persisted.operation === "object" ? persisted.operation : next;
    return { operation: stripInternalOperationFields(operation), applied: true };
  }

  async function transition({ tenantId, operationId, state, providerRef = null, reasonCode = null, at = now() } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    assertNonEmptyString(operationId, "operationId");
    const current = await loadOperation({ tenantId: tenantId.trim(), operationId: operationId.trim() });
    if (!current) throw createConflictError("MONEY_RAIL_OPERATION_NOT_FOUND", "operation not found");

    const next = applyStateTransition({
      operation: current,
      nextState: normalizeState(state),
      at,
      providerRef,
      reasonCode
    });
    const persisted = await store.putMoneyRailOperation({
      tenantId: tenantId.trim(),
      providerId,
      operation: next,
      requestHash: current.requestHash ?? null
    });
    const operation = persisted?.operation && typeof persisted.operation === "object" ? persisted.operation : next;
    return stripInternalOperationFields(operation);
  }

  async function ingestProviderEvent({
    tenantId,
    operationId,
    eventType,
    providerRef = null,
    reasonCode = null,
    at = now(),
    eventId = null,
    payload = null
  } = {}) {
    assertNonEmptyString(tenantId, "tenantId");
    assertNonEmptyString(operationId, "operationId");
    const normalizedTenantId = tenantId.trim();
    const normalizedOperationId = operationId.trim();
    const current = await loadOperation({ tenantId: normalizedTenantId, operationId: normalizedOperationId });
    if (!current) throw createConflictError("MONEY_RAIL_OPERATION_NOT_FOUND", "operation not found");

    const normalizedEventType = normalizeProviderEventType(eventType);
    const normalizedAt = normalizeIsoDate(at, "at");
    const normalizedEventId = eventId === null || eventId === undefined ? null : String(eventId).trim();
    const eventDedupeKey = `${normalizedEventType}\n${normalizedEventId ?? normalizedAt}`;
    const existingEvent = await store.getMoneyRailProviderEvent({
      tenantId: normalizedTenantId,
      providerId,
      operationId: normalizedOperationId,
      eventType: normalizedEventType,
      eventDedupeKey
    });
    if (existingEvent) {
      const currentOperation = await loadOperation({ tenantId: normalizedTenantId, operationId: normalizedOperationId });
      return {
        operation: stripInternalOperationFields(currentOperation ?? current),
        applied: false,
        event: clone(existingEvent)
      };
    }

    const nextState = normalizedEventType;
    let next = null;
    let applied = true;
    try {
      next = applyStateTransition({
        operation: current,
        nextState,
        at: normalizedAt,
        providerRef,
        reasonCode
      });
    } catch (err) {
      if (err?.code !== "MONEY_RAIL_INVALID_TRANSITION") throw err;
      const fromState = normalizeState(current.state);
      if (fromState === nextState) {
        next = current;
        applied = false;
      } else {
        throw err;
      }
    }

    if (applied) {
      const persisted = await store.putMoneyRailOperation({
        tenantId: normalizedTenantId,
        providerId,
        operation: next,
        requestHash: current.requestHash ?? null
      });
      next = persisted?.operation && typeof persisted.operation === "object" ? persisted.operation : next;
    }

    const event = {
      schemaVersion: "MoneyRailProviderEvent.v1",
      providerId,
      tenantId: normalizedTenantId,
      operationId: normalizedOperationId,
      eventType: normalizedEventType,
      eventId: normalizedEventId,
      eventDedupeKey,
      at: normalizedAt,
      payload: clone(payload)
    };
    const persistedEvent = await store.putMoneyRailProviderEvent({
      tenantId: normalizedTenantId,
      providerId,
      operationId: normalizedOperationId,
      event
    });
    if (persistedEvent?.created === false) {
      const currentOperation = await loadOperation({ tenantId: normalizedTenantId, operationId: normalizedOperationId });
      return {
        operation: stripInternalOperationFields(currentOperation ?? next),
        applied: false,
        event: clone(persistedEvent?.event ?? event)
      };
    }
    return { operation: stripInternalOperationFields(next), applied, event: clone(persistedEvent?.event ?? event) };
  }

  return {
    providerId,
    create,
    status,
    listOperations,
    cancel,
    transition,
    ingestProviderEvent
  };
}

export function createMoneyRailAdapterRegistry({ adapters = [] } = {}) {
  if (!Array.isArray(adapters)) throw new TypeError("adapters must be an array");
  const byProviderId = new Map();

  function register(adapter) {
    assertMoneyRailAdapter(adapter);
    const providerId = String(adapter.providerId ?? "").trim();
    if (!providerId) throw new TypeError("adapter.providerId must be a non-empty string");
    if (byProviderId.has(providerId)) throw new TypeError(`adapter already registered: ${providerId}`);
    byProviderId.set(providerId, adapter);
    return adapter;
  }

  function get(providerId) {
    assertNonEmptyString(providerId, "providerId");
    return byProviderId.get(providerId.trim()) ?? null;
  }

  function list() {
    return Array.from(byProviderId.keys()).sort();
  }

  for (const adapter of adapters) register(adapter);

  return {
    register,
    get,
    list
  };
}
