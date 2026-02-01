import { checkUrlSafetySync } from "./url-safety.js";

export const EVIDENCE_KIND = Object.freeze({
  VIDEO_CLIP: "VIDEO_CLIP",
  STILL_IMAGE: "STILL_IMAGE",
  SENSOR_SNAPSHOT: "SENSOR_SNAPSHOT"
});

const EVIDENCE_KINDS = new Set(Object.values(EVIDENCE_KIND));
const REDACTION_STATES = new Set(["NONE", "REQUESTED", "APPLIED"]);

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertSafePositiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
}

function assertEvidenceRef(ref) {
  assertNonEmptyString(ref, "payload.evidenceRef");
  if (ref.length > 2048) throw new TypeError("payload.evidenceRef is too long");
  if (ref.startsWith("data:")) throw new TypeError("payload.evidenceRef must not be a data: URI");
  if (ref.includes("base64")) throw new TypeError("payload.evidenceRef must not include base64 data");
  const safety = checkUrlSafetySync(ref, { allowPrivate: false, allowLoopback: false });
  if (!safety.ok) {
    throw new TypeError(`payload.evidenceRef is unsafe (${safety.code})`);
  }
}

export function validateEvidenceCapturedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set([
    "jobId",
    "incidentId",
    "evidenceId",
    "evidenceRef",
    "kind",
    "durationSeconds",
    "sizeBytes",
    "contentType",
    "redaction"
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.incidentId, "payload.incidentId");
  assertNonEmptyString(payload.evidenceId, "payload.evidenceId");
  assertEvidenceRef(payload.evidenceRef);
  assertNonEmptyString(payload.kind, "payload.kind");
  if (!EVIDENCE_KINDS.has(payload.kind)) throw new TypeError("payload.kind is not supported");

  if (payload.durationSeconds !== undefined) assertSafePositiveInt(payload.durationSeconds, "payload.durationSeconds");
  if (payload.sizeBytes !== undefined) assertSafePositiveInt(payload.sizeBytes, "payload.sizeBytes");
  if (payload.contentType !== undefined) assertNonEmptyString(payload.contentType, "payload.contentType");

  if (payload.redaction !== undefined) {
    assertPlainObject(payload.redaction, "payload.redaction");
    const redactionAllowed = new Set(["state", "notes"]);
    for (const key of Object.keys(payload.redaction)) {
      if (!redactionAllowed.has(key)) throw new TypeError(`payload.redaction contains unknown field: ${key}`);
    }
    assertNonEmptyString(payload.redaction.state, "payload.redaction.state");
    if (!REDACTION_STATES.has(payload.redaction.state)) throw new TypeError("payload.redaction.state is not supported");
    if (payload.redaction.notes !== undefined) assertNonEmptyString(payload.redaction.notes, "payload.redaction.notes");
  }

  return payload;
}

export function validateEvidenceViewedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "evidenceId", "evidenceRef", "viewedAt"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.evidenceId, "payload.evidenceId");
  assertEvidenceRef(payload.evidenceRef);
  assertNonEmptyString(payload.viewedAt, "payload.viewedAt");
  const t = Date.parse(payload.viewedAt);
  if (!Number.isFinite(t)) throw new TypeError("payload.viewedAt must be an ISO date string");
  return payload;
}

export function validateEvidenceExpiredPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "evidenceId", "evidenceRef", "expiredAt", "retentionDays", "policyHash"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.evidenceId, "payload.evidenceId");
  assertEvidenceRef(payload.evidenceRef);
  assertNonEmptyString(payload.expiredAt, "payload.expiredAt");
  const t = Date.parse(payload.expiredAt);
  if (!Number.isFinite(t)) throw new TypeError("payload.expiredAt must be an ISO date string");

  if (!Number.isSafeInteger(payload.retentionDays) || payload.retentionDays < 0) {
    throw new TypeError("payload.retentionDays must be a non-negative safe integer");
  }

  if (payload.policyHash !== undefined && payload.policyHash !== null) {
    assertNonEmptyString(payload.policyHash, "payload.policyHash");
  }

  return payload;
}
