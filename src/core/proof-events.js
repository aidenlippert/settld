import { canonicalizeMissingEvidenceList, canonicalizeMissingEvidenceToken, PROOF_STATUS } from "./proof.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function validateProofEvaluatedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set([
    "jobId",
    "evaluatedAt",
    "evaluatedAtChainHash",
    "evaluationId",
    "customerPolicyHash",
    "operatorPolicyHash",
    "requiredZonesHash",
    "factsHash",
    "status",
    "reasonCodes",
    "missingEvidence",
    "triggeredFacts",
    "metrics"
  ]);
  for (const k of Object.keys(payload)) {
    if (!allowed.has(k)) throw new TypeError(`payload contains unknown field: ${k}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.evaluatedAt, "payload.evaluatedAt");
  assertNonEmptyString(payload.evaluatedAtChainHash, "payload.evaluatedAtChainHash");

  if (payload.evaluationId !== undefined && payload.evaluationId !== null) {
    assertNonEmptyString(payload.evaluationId, "payload.evaluationId");
    const hex = String(payload.evaluationId).trim();
    if (!/^[a-f0-9]{64}$/i.test(hex)) throw new TypeError("payload.evaluationId must be 64-hex");
  }
  if (payload.customerPolicyHash !== undefined && payload.customerPolicyHash !== null) assertNonEmptyString(payload.customerPolicyHash, "payload.customerPolicyHash");
  if (payload.operatorPolicyHash !== undefined && payload.operatorPolicyHash !== null) assertNonEmptyString(payload.operatorPolicyHash, "payload.operatorPolicyHash");
  if (payload.requiredZonesHash !== undefined && payload.requiredZonesHash !== null) assertNonEmptyString(payload.requiredZonesHash, "payload.requiredZonesHash");
  if (payload.factsHash !== undefined && payload.factsHash !== null) {
    assertNonEmptyString(payload.factsHash, "payload.factsHash");
    const hex = String(payload.factsHash).trim();
    if (!/^[a-f0-9]{64}$/i.test(hex)) throw new TypeError("payload.factsHash must be 64-hex");
  }

  assertNonEmptyString(payload.status, "payload.status");
  if (!new Set(Object.values(PROOF_STATUS)).has(payload.status)) throw new TypeError("payload.status is not supported");

  if (!Array.isArray(payload.reasonCodes)) throw new TypeError("payload.reasonCodes must be an array");
  for (const c of payload.reasonCodes) assertNonEmptyString(c, "payload.reasonCodes[]");

  if (payload.missingEvidence !== undefined && payload.missingEvidence !== null) {
    if (!Array.isArray(payload.missingEvidence)) throw new TypeError("payload.missingEvidence must be an array");
    for (const e of payload.missingEvidence) {
      assertNonEmptyString(e, "payload.missingEvidence[]");
      const canonical = canonicalizeMissingEvidenceToken(e);
      if (canonical !== e) throw new TypeError("payload.missingEvidence must be canonical");
    }
    const canonicalList = canonicalizeMissingEvidenceList(payload.missingEvidence);
    if (payload.missingEvidence.length !== canonicalList.length) throw new TypeError("payload.missingEvidence must be deduped");
    for (let i = 0; i < canonicalList.length; i += 1) {
      if (payload.missingEvidence[i] !== canonicalList[i]) throw new TypeError("payload.missingEvidence must be sorted");
    }
  }

  if (!Array.isArray(payload.triggeredFacts)) throw new TypeError("payload.triggeredFacts must be an array");
  for (const f of payload.triggeredFacts) {
    assertPlainObject(f, "payload.triggeredFacts[]");
    const allowedFact = new Set(["eventId", "type", "zoneId"]);
    for (const k of Object.keys(f)) {
      if (!allowedFact.has(k)) throw new TypeError("payload.triggeredFacts contains unknown field");
    }
    if (f.eventId !== null && f.eventId !== undefined) assertNonEmptyString(f.eventId, "triggeredFacts[].eventId");
    assertNonEmptyString(f.type, "triggeredFacts[].type");
    if (f.zoneId !== null && f.zoneId !== undefined) assertNonEmptyString(f.zoneId, "triggeredFacts[].zoneId");
  }

  assertPlainObject(payload.metrics ?? {}, "payload.metrics");

  return payload;
}
