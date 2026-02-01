export const CLAIM_STATUS = Object.freeze({
  OPEN: "OPEN",
  TRIAGED: "TRIAGED",
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  PAID: "PAID"
});

const CLAIM_REASON_CODES = new Set([
  "DAMAGE_PROPERTY",
  "PRIVACY_VIOLATION",
  "SAFETY_NEAR_MISS",
  "FAILURE_TO_COMPLETE",
  "ACCESS_FAILURE",
  "THEFT_ALLEGATION",
  "ROBOT_STUCK",
  "UNEXPECTED_HUMAN_CONTACT",
  "OTHER"
]);

const CLAIM_TRIAGE_CODES = new Set(["AUTO", "REVIEW", "ESCALATE"]);

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertSafeNonNegativeCents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer (cents)`);
}

function assertSafePositiveCents(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer (cents)`);
}

export function computeClaimTotalCents({ payoutCents, refundCents }) {
  assertSafeNonNegativeCents(payoutCents, "payoutCents");
  assertSafeNonNegativeCents(refundCents, "refundCents");
  return payoutCents + refundCents;
}

export function validateClaimOpenedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "claimId", "incidentId", "reasonCode", "description"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.claimId, "payload.claimId");
  assertNonEmptyString(payload.incidentId, "payload.incidentId");
  assertNonEmptyString(payload.reasonCode, "payload.reasonCode");
  if (!CLAIM_REASON_CODES.has(payload.reasonCode)) throw new TypeError("payload.reasonCode is not supported");
  if (payload.description !== undefined) assertNonEmptyString(payload.description, "payload.description");

  return payload;
}

export function validateClaimTriagedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "claimId", "triageCode", "notes"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.claimId, "payload.claimId");
  assertNonEmptyString(payload.triageCode, "payload.triageCode");
  if (!CLAIM_TRIAGE_CODES.has(payload.triageCode)) throw new TypeError("payload.triageCode is not supported");
  if (payload.notes !== undefined) assertNonEmptyString(payload.notes, "payload.notes");
  return payload;
}

export function validateClaimApprovedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "claimId", "amounts", "currency", "reasonCode", "notes"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.claimId, "payload.claimId");
  assertNonEmptyString(payload.currency, "payload.currency");

  assertPlainObject(payload.amounts, "payload.amounts");
  const amountsAllowed = new Set(["payoutCents", "refundCents"]);
  for (const key of Object.keys(payload.amounts)) {
    if (!amountsAllowed.has(key)) throw new TypeError(`payload.amounts contains unknown field: ${key}`);
  }
  const payoutCents = payload.amounts.payoutCents ?? 0;
  const refundCents = payload.amounts.refundCents ?? 0;
  assertSafeNonNegativeCents(payoutCents, "payload.amounts.payoutCents");
  assertSafeNonNegativeCents(refundCents, "payload.amounts.refundCents");
  if (payoutCents === 0 && refundCents === 0) throw new TypeError("payload.amounts must include a non-zero payoutCents and/or refundCents");

  if (payload.reasonCode !== undefined) {
    assertNonEmptyString(payload.reasonCode, "payload.reasonCode");
    if (!CLAIM_REASON_CODES.has(payload.reasonCode)) throw new TypeError("payload.reasonCode is not supported");
  }
  if (payload.notes !== undefined) assertNonEmptyString(payload.notes, "payload.notes");
  return payload;
}

export function validateClaimDeniedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "claimId", "reasonCode", "notes"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.claimId, "payload.claimId");
  assertNonEmptyString(payload.reasonCode, "payload.reasonCode");
  if (!CLAIM_REASON_CODES.has(payload.reasonCode)) throw new TypeError("payload.reasonCode is not supported");
  if (payload.notes !== undefined) assertNonEmptyString(payload.notes, "payload.notes");
  return payload;
}

export function validateClaimPaidPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "claimId", "amountCents", "currency", "paymentRef"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.claimId, "payload.claimId");
  assertSafePositiveCents(payload.amountCents, "payload.amountCents");
  assertNonEmptyString(payload.currency, "payload.currency");
  assertNonEmptyString(payload.paymentRef, "payload.paymentRef");
  return payload;
}

export function validateJobAdjustedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "claimId", "adjustmentId", "notes"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.claimId, "payload.claimId");
  assertNonEmptyString(payload.adjustmentId, "payload.adjustmentId");
  if (payload.notes !== undefined) assertNonEmptyString(payload.notes, "payload.notes");
  return payload;
}

