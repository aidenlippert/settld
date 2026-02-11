import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const REPUTATION_EVENT_SCHEMA_VERSION = "ReputationEvent.v1";

export const REPUTATION_EVENT_KIND = Object.freeze({
  DECISION_APPROVED: "decision_approved",
  DECISION_REJECTED: "decision_rejected",
  HOLDBACK_AUTO_RELEASED: "holdback_auto_released",
  DISPUTE_OPENED: "dispute_opened",
  VERDICT_ISSUED: "verdict_issued",
  ADJUSTMENT_APPLIED: "adjustment_applied"
});

export const REPUTATION_EVENT_ROLE = Object.freeze({
  PAYEE: "payee",
  PAYER: "payer",
  ARBITER: "arbiter",
  SYSTEM: "system"
});

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO date string`);
}

function normalizeId(value, name, { min = 1, max = 200 } = {}) {
  assertNonEmptyString(value, name);
  const out = String(value).trim();
  if (out.length < min || out.length > max) throw new TypeError(`${name} must be length ${min}..${max}`);
  if (!/^[A-Za-z0-9:_-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:_-]+$`);
  return out;
}

function normalizeHexHash(value, name, { allowNull = false } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new TypeError(`${name} must be a 64-hex sha256`);
  }
  assertNonEmptyString(value, name);
  const out = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be a 64-hex sha256`);
  return out;
}

function normalizeOptionalId(value, name, options = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return normalizeId(value, name, options);
}

function normalizeKind(value, name) {
  const out = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!Object.values(REPUTATION_EVENT_KIND).includes(out)) {
    throw new TypeError(`${name} must be one of: ${Object.values(REPUTATION_EVENT_KIND).join("|")}`);
  }
  return out;
}

function normalizeRole(value, name) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const out = String(value).trim().toLowerCase();
  if (!Object.values(REPUTATION_EVENT_ROLE).includes(out)) {
    throw new TypeError(`${name} must be one of: ${Object.values(REPUTATION_EVENT_ROLE).join("|")}`);
  }
  return out;
}

function normalizeSourceRef(sourceRef) {
  assertPlainObject(sourceRef, "sourceRef");
  const kind = normalizeId(sourceRef.kind, "sourceRef.kind", { min: 2, max: 64 }).toLowerCase();
  const normalized = { kind };
  const maybe = {
    artifactId: normalizeOptionalId(sourceRef.artifactId, "sourceRef.artifactId", { min: 3, max: 240 }),
    sourceId: normalizeOptionalId(sourceRef.sourceId, "sourceRef.sourceId", { min: 3, max: 240 }),
    hash: normalizeHexHash(sourceRef.hash, "sourceRef.hash", { allowNull: true }),
    agreementHash: normalizeHexHash(sourceRef.agreementHash, "sourceRef.agreementHash", { allowNull: true }),
    receiptHash: normalizeHexHash(sourceRef.receiptHash, "sourceRef.receiptHash", { allowNull: true }),
    holdHash: normalizeHexHash(sourceRef.holdHash, "sourceRef.holdHash", { allowNull: true }),
    decisionHash: normalizeHexHash(sourceRef.decisionHash, "sourceRef.decisionHash", { allowNull: true }),
    verdictHash: normalizeHexHash(sourceRef.verdictHash, "sourceRef.verdictHash", { allowNull: true }),
    runId: normalizeOptionalId(sourceRef.runId, "sourceRef.runId", { min: 3, max: 128 }),
    settlementId: normalizeOptionalId(sourceRef.settlementId, "sourceRef.settlementId", { min: 3, max: 240 }),
    disputeId: normalizeOptionalId(sourceRef.disputeId, "sourceRef.disputeId", { min: 3, max: 240 }),
    caseId: normalizeOptionalId(sourceRef.caseId, "sourceRef.caseId", { min: 3, max: 240 }),
    adjustmentId: normalizeOptionalId(sourceRef.adjustmentId, "sourceRef.adjustmentId", { min: 3, max: 240 })
  };
  for (const [key, value] of Object.entries(maybe)) {
    if (value !== null) normalized[key] = value;
  }
  if (
    !normalized.artifactId &&
    !normalized.sourceId &&
    !normalized.hash &&
    !normalized.agreementHash &&
    !normalized.runId &&
    !normalized.settlementId &&
    !normalized.disputeId &&
    !normalized.caseId &&
    !normalized.adjustmentId &&
    !normalized.decisionHash &&
    !normalized.receiptHash &&
    !normalized.holdHash &&
    !normalized.verdictHash
  ) {
    throw new TypeError("sourceRef must include at least one stable reference field");
  }
  return normalizeForCanonicalJson(normalized, { path: "$" });
}

function normalizeSubject(subject) {
  assertPlainObject(subject, "subject");
  const normalized = { agentId: normalizeId(subject.agentId, "subject.agentId", { min: 3, max: 128 }) };
  const toolId = normalizeOptionalId(subject.toolId, "subject.toolId", { min: 1, max: 200 });
  const counterpartyAgentId = normalizeOptionalId(subject.counterpartyAgentId, "subject.counterpartyAgentId", { min: 3, max: 128 });
  const role = normalizeRole(subject.role, "subject.role");
  if (toolId !== null) normalized.toolId = toolId;
  if (counterpartyAgentId !== null) normalized.counterpartyAgentId = counterpartyAgentId;
  if (role !== null) normalized.role = role;
  return normalizeForCanonicalJson(normalized, { path: "$" });
}

export function computeReputationEventHashV1(eventCore) {
  assertPlainObject(eventCore, "eventCore");
  const copy = { ...eventCore };
  delete copy.eventHash;
  delete copy.artifactHash;
  const normalized = normalizeForCanonicalJson(copy, { path: "$" });
  return sha256Hex(canonicalJsonStringify(normalized));
}

export function buildReputationEventV1({
  eventId,
  tenantId,
  occurredAt,
  subject,
  eventKind,
  sourceRef,
  facts = {}
} = {}) {
  const at = occurredAt ?? new Date().toISOString();
  assertIsoDate(at, "occurredAt");
  const normalizedFacts = facts === null || facts === undefined ? {} : facts;
  assertPlainObject(normalizedFacts, "facts");

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: REPUTATION_EVENT_SCHEMA_VERSION,
      artifactType: REPUTATION_EVENT_SCHEMA_VERSION,
      artifactId: normalizeId(eventId, "eventId", { min: 3, max: 240 }),
      eventId: normalizeId(eventId, "eventId", { min: 3, max: 240 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      occurredAt: at,
      eventKind: normalizeKind(eventKind, "eventKind"),
      subject: normalizeSubject(subject),
      sourceRef: normalizeSourceRef(sourceRef),
      facts: normalizeForCanonicalJson(normalizedFacts, { path: "$" })
    },
    { path: "$" }
  );

  const eventHash = computeReputationEventHashV1(normalized);
  return normalizeForCanonicalJson(
    {
      ...normalized,
      eventHash
    },
    { path: "$" }
  );
}

export function validateReputationEventV1(event) {
  assertPlainObject(event, "event");
  if (event.schemaVersion !== REPUTATION_EVENT_SCHEMA_VERSION) {
    throw new TypeError(`event.schemaVersion must be ${REPUTATION_EVENT_SCHEMA_VERSION}`);
  }
  if (event.artifactType !== REPUTATION_EVENT_SCHEMA_VERSION) {
    throw new TypeError(`event.artifactType must be ${REPUTATION_EVENT_SCHEMA_VERSION}`);
  }
  const eventId = normalizeId(event.eventId, "event.eventId", { min: 3, max: 240 });
  const artifactId = normalizeId(event.artifactId, "event.artifactId", { min: 3, max: 240 });
  if (eventId !== artifactId) throw new TypeError("event.artifactId must equal event.eventId");
  normalizeId(event.tenantId, "event.tenantId", { min: 1, max: 128 });
  assertIsoDate(event.occurredAt, "event.occurredAt");
  normalizeKind(event.eventKind, "event.eventKind");
  normalizeSubject(event.subject);
  normalizeSourceRef(event.sourceRef);
  assertPlainObject(event.facts, "event.facts");
  const hash = normalizeHexHash(event.eventHash, "event.eventHash");
  const computed = computeReputationEventHashV1(event);
  if (computed !== hash) throw new TypeError("eventHash mismatch");
  return true;
}
