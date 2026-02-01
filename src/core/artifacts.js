import crypto from "node:crypto";

import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";
import { reduceJob } from "./job-reducer.js";
import { verifyZoneCoverageProofV1 } from "./proof-verifier.js";

export const ARTIFACT_TYPE = Object.freeze({
  WORK_CERTIFICATE_V1: "WorkCertificate.v1",
  PROOF_RECEIPT_V1: "ProofReceipt.v1",
  INCIDENT_PACKET_V1: "IncidentPacket.v1",
  CREDIT_MEMO_V1: "CreditMemo.v1",
  SETTLEMENT_STATEMENT_V1: "SettlementStatement.v1",
  MONTHLY_STATEMENT_V1: "MonthlyStatement.v1",
  HELD_EXPOSURE_ROLLFORWARD_V1: "HeldExposureRollforward.v1",
  PARTY_STATEMENT_V1: "PartyStatement.v1",
  PAYOUT_INSTRUCTION_V1: "PayoutInstruction.v1",
  GL_BATCH_V1: "GLBatch.v1",
  JOURNAL_CSV_V1: "JournalCsv.v1",
  FINANCE_PACK_BUNDLE_V1: "FinancePackBundle.v1",
  COVERAGE_CERTIFICATE_V1: "CoverageCertificate.v1"
});

const KNOWN_ARTIFACT_TYPES = new Set(Object.values(ARTIFACT_TYPE));

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertArtifactType(type) {
  assertNonEmptyString(type, "artifactType");
  if (!KNOWN_ARTIFACT_TYPES.has(type)) throw new TypeError(`unsupported artifactType: ${type}`);
  return type;
}

function evidenceRefHash(evidenceRef) {
  if (typeof evidenceRef !== "string" || evidenceRef.trim() === "") return null;
  return sha256Hex(evidenceRef);
}

function summarizeSignatures(events) {
  if (!Array.isArray(events)) return { signedEventCount: 0, signerKeyIds: [] };
  let signed = 0;
  const keyIds = new Set();
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (typeof e.signature === "string" && e.signature.trim()) signed += 1;
    if (typeof e.signerKeyId === "string" && e.signerKeyId.trim()) keyIds.add(e.signerKeyId);
  }
  return { signedEventCount: signed, signerKeyIds: Array.from(keyIds).sort() };
}

export function sliceEventsThroughChainHash(events, atChainHash) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  assertNonEmptyString(atChainHash, "atChainHash");
  const idx = events.findIndex((e) => e?.chainHash === atChainHash);
  if (idx === -1) throw new TypeError("atChainHash not found in stream");
  return events.slice(0, idx + 1);
}

export function computeArtifactHash(artifactJson) {
  assertPlainObject(artifactJson, "artifactJson");
  if (artifactJson.artifactHash !== undefined) throw new TypeError("artifactJson must not include artifactHash when hashing");
  return sha256Hex(canonicalJsonStringify(artifactJson));
}

export function hmacSignArtifact({ secret, timestamp, bodyJson }) {
  assertNonEmptyString(secret, "secret");
  assertNonEmptyString(timestamp, "timestamp");
  assertPlainObject(bodyJson, "bodyJson");
  const body = canonicalJsonStringify(bodyJson);
  const data = `${timestamp}.${body}`;
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

function jobProofFromEvents(events) {
  const head = Array.isArray(events) && events.length ? events[events.length - 1] : null;
  return {
    lastChainHash: head?.chainHash ?? null,
    eventCount: Array.isArray(events) ? events.length : 0,
    signatures: summarizeSignatures(events)
  };
}

function policyHashFromBooking(booking) {
  if (!booking || typeof booking !== "object") return null;
  if (typeof booking.policyHash === "string" && booking.policyHash.trim() !== "") return booking.policyHash;
  if (booking.policySnapshot && typeof booking.policySnapshot === "object") {
    try {
      return sha256Hex(canonicalJsonStringify(booking.policySnapshot));
    } catch {
      // fall through
    }
  }
  const snapshot = {
    sla: booking.sla ?? null,
    creditPolicy: booking.creditPolicy ?? null,
    evidencePolicy: booking.evidencePolicy ?? null,
    requiresOperatorCoverage: booking.requiresOperatorCoverage ?? null,
    environmentTier: booking.environmentTier ?? null,
    startAt: booking.startAt ?? null,
    endAt: booking.endAt ?? null
  };
  return sha256Hex(canonicalJsonStringify(snapshot));
}

function latestProofFromEvents(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== "PROOF_EVALUATED") continue;
    const p = e.payload ?? null;
    if (!p || typeof p !== "object") continue;
    return {
      status: p.status ?? null,
      reasonCodes: Array.isArray(p.reasonCodes) ? p.reasonCodes : [],
      evaluatedAt: p.evaluatedAt ?? e.at ?? null,
      evaluatedAtChainHash: p.evaluatedAtChainHash ?? null,
      evaluationId: p.evaluationId ?? null,
      requiredZonesHash: p.requiredZonesHash ?? null,
      customerPolicyHash: p.customerPolicyHash ?? null,
      operatorPolicyHash: p.operatorPolicyHash ?? null,
      factsHash: p.factsHash ?? null,
      metrics: p.metrics ?? null
    };
  }
  return null;
}

function latestProofEvaluatedEventFromEvents(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== "PROOF_EVALUATED") continue;
    const p = e.payload ?? null;
    if (!p || typeof p !== "object") continue;
    return e;
  }
  return null;
}

function findLastEvent(events, type) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === type) return e;
  }
  return null;
}

function findLatestCompletionChainHash(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== "EXECUTION_COMPLETED" && e?.type !== "JOB_EXECUTION_COMPLETED") continue;
    const ch = typeof e?.chainHash === "string" ? e.chainHash.trim() : "";
    if (ch) return ch;
  }
  return null;
}

function findMatchingProofEvaluatedEvent({ events, evaluatedAtChainHash, customerPolicyHash, factsHash }) {
  if (!Array.isArray(events)) return null;
  if (typeof evaluatedAtChainHash !== "string" || !evaluatedAtChainHash.trim()) return null;
  if (typeof factsHash !== "string" || !factsHash.trim()) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== "PROOF_EVALUATED") continue;
    const p = e.payload ?? null;
    if (!p || typeof p !== "object") continue;
    if (p.evaluatedAtChainHash !== evaluatedAtChainHash) continue;
    if (p.factsHash !== factsHash) continue;
    if (customerPolicyHash && p.customerPolicyHash !== customerPolicyHash) continue;
    return e;
  }
  return null;
}

function proofSummaryFromProofEvent(proofEvent) {
  if (!proofEvent || typeof proofEvent !== "object") return null;
  const p = proofEvent.payload ?? null;
  if (!p || typeof p !== "object") return null;
  return {
    status: p.status ?? null,
    reasonCodes: Array.isArray(p.reasonCodes) ? p.reasonCodes : [],
    evaluatedAt: p.evaluatedAt ?? proofEvent.at ?? null,
    evaluatedAtChainHash: p.evaluatedAtChainHash ?? null,
    evaluationId: p.evaluationId ?? null,
    requiredZonesHash: p.requiredZonesHash ?? null,
    customerPolicyHash: p.customerPolicyHash ?? null,
    operatorPolicyHash: p.operatorPolicyHash ?? null,
    factsHash: p.factsHash ?? null,
    metrics: p.metrics ?? null
  };
}

	function proofSummaryFromSettlementProofRef(ref) {
	  if (!ref || typeof ref !== "object") return null;
	  const forfeit = ref.forfeit && typeof ref.forfeit === "object" ? ref.forfeit : null;
	  return {
	    status: ref.status ?? null,
	    reasonCodes: Array.isArray(ref.reasonCodes) ? ref.reasonCodes : [],
	    evaluatedAt: ref.proofEventAt ?? null,
	    evaluatedAtChainHash: ref.evaluatedAtChainHash ?? null,
    evaluationId: ref.evaluationId ?? null,
    requiredZonesHash: ref.requiredZonesHash ?? null,
    customerPolicyHash: ref.customerPolicyHash ?? null,
    operatorPolicyHash: ref.operatorPolicyHash ?? null,
    factsHash: ref.factsHash ?? null,
	    metrics: ref.metrics ?? null,
	    source: {
	      kind: "SETTLEMENT",
	      proofEventId: ref.proofEventId ?? null,
	      proofEventChainHash: ref.proofEventChainHash ?? null,
	      proofEventPayloadHash: ref.proofEventPayloadHash ?? null,
	      disposition: forfeit
	        ? {
	            kind: "FORFEIT",
	            holdId: forfeit.holdId ?? null,
	            forfeitureReason: forfeit.forfeitureReason ?? null,
	            forfeitEventId: forfeit.forfeitEventId ?? null,
	            forfeitEventChainHash: forfeit.forfeitEventChainHash ?? null,
	            forfeitEventPayloadHash: forfeit.forfeitEventPayloadHash ?? null
	          }
	        : null
	    }
	  };
	}

function effectiveProofFromEvents({ events }) {
  const settledEvent = findLastEvent(events, "SETTLED");
  const settledRef = settledEvent?.payload?.settlementProofRef ?? null;
  if (settledEvent && settledRef) return proofSummaryFromSettlementProofRef(settledRef);

  const completionChainHash = findLatestCompletionChainHash(events);
  if (!completionChainHash) return latestProofFromEvents(events);

  try {
    const anchorIdx = events.findIndex((e) => e?.chainHash === completionChainHash);
    const anchorSlice = anchorIdx === -1 ? null : events.slice(0, anchorIdx + 1);
    const jobAtAnchor = anchorSlice ? reduceJob(anchorSlice) : null;
    if (!jobAtAnchor) return latestProofFromEvents(events);
    const current = verifyZoneCoverageProofV1({
      job: jobAtAnchor,
      events,
      evaluatedAtChainHash: completionChainHash,
      customerPolicyHash: jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null,
      operatorPolicyHash: jobAtAnchor.operatorPolicyHash ?? null
    });
    const factsHash = current?.factsHash ?? null;
    const customerPolicyHash = current?.anchors?.customerPolicyHash ?? (jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null);
    const match = factsHash ? findMatchingProofEvaluatedEvent({ events, evaluatedAtChainHash: completionChainHash, customerPolicyHash, factsHash }) : null;
    if (match) {
      const s = proofSummaryFromProofEvent(match);
      return s ? { ...s, source: { kind: "FRESH" } } : latestProofFromEvents(events);
    }
    const stale = latestProofFromEvents(events);
    return stale ? { ...stale, source: { kind: "STALE" }, expectedFactsHash: factsHash ?? null } : null;
  } catch {
    return latestProofFromEvents(events);
  }
}

function buildBase({ artifactType, artifactId, generatedAt, tenantId, jobId, jobVersion, jobProof, policyHash }) {
  assertArtifactType(artifactType);
  assertNonEmptyString(artifactId, "artifactId");
  assertNonEmptyString(generatedAt, "generatedAt");
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(jobId, "jobId");
  if (!Number.isSafeInteger(jobVersion) || jobVersion <= 0) throw new TypeError("jobVersion must be a positive integer");
  assertPlainObject(jobProof, "jobProof");

  return {
    schemaVersion: artifactType,
    artifactType,
    artifactId,
    generatedAt,
    tenantId,
    jobId,
    jobVersion,
    policyHash: policyHash ?? null,
    eventProof: jobProof
  };
}

export function buildWorkCertificateV1({ tenantId, job, events, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  if (!job || typeof job !== "object") throw new TypeError("job is required");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  const jobVersion = proof.eventCount;
  const base = buildBase({
    artifactType: ARTIFACT_TYPE.WORK_CERTIFICATE_V1,
    artifactId,
    generatedAt,
    tenantId,
    jobId: job.id,
    jobVersion,
    jobProof: proof,
    policyHash: policyHashFromBooking(job.booking)
  });

  const evidence = Array.isArray(job.evidence)
    ? job.evidence.map((e) => ({
        evidenceId: e?.evidenceId ?? null,
        capturedAt: e?.capturedAt ?? null,
        contentType: e?.contentType ?? null,
        evidenceRefHash: evidenceRefHash(e?.evidenceRef ?? null),
        redaction: e?.redaction ?? null,
        expiredAt: e?.expiredAt ?? null
      }))
    : [];

  const latestRisk = Array.isArray(job.riskScores) && job.riskScores.length ? job.riskScores[job.riskScores.length - 1] : null;
  const riskPayload = latestRisk?.payload ?? null;
  const risk =
    riskPayload && typeof riskPayload === "object"
      ? {
          basis: riskPayload.basis ?? null,
          scoredAt: riskPayload.scoredAt ?? latestRisk?.at ?? null,
          modelVersion: riskPayload.modelVersion ?? null,
          riskScore: riskPayload.riskScore ?? null,
          expectedAssistSeconds: riskPayload.expectedAssistSeconds ?? null,
          expectedIncidentProbabilityBps: riskPayload.expectedIncidentProbabilityBps ?? null,
          expectedCreditBurnRateCents: riskPayload.expectedCreditBurnRateCents ?? null,
          currency: riskPayload.currency ?? null,
          policyHash: riskPayload.policyHash ?? null
        }
      : null;

  const proofResult = effectiveProofFromEvents({ events });

  return {
    ...base,
    proof: proofResult,
    job: {
      templateId: job.templateId ?? null,
      customerId: job.booking?.customerId ?? job.customerId ?? null,
      siteId: job.booking?.siteId ?? job.siteId ?? null,
      contractId: job.booking?.contractId ?? job.contractId ?? null,
      customerContractHash: job.booking?.customerContractHash ?? null,
      customerCompilerId: job.booking?.customerCompilerId ?? null,
      customerPolicyHash: base.policyHash ?? null,
      operatorContractHash: job.operatorContractHash ?? null,
      operatorCompilerId: job.operatorCompilerId ?? null,
      operatorPolicyHash: job.operatorPolicyHash ?? null,
      requiredZonesHash: job.booking?.requiredZonesHash ?? null,
      zoneId: job.booking?.zoneId ?? job.constraints?.zoneId ?? null,
      environmentTier: job.booking?.environmentTier ?? null,
      bookingWindow: job.booking ? { startAt: job.booking.startAt ?? null, endAt: job.booking.endAt ?? null } : null,
      access: job.access ?? null,
      execution: job.execution ?? null,
      assist: job.assist ?? null,
      operatorCoverage: job.operatorCoverage ?? null,
      risk,
      incidentsCount: Array.isArray(job.incidents) ? job.incidents.length : 0,
      claimsCount: Array.isArray(job.claims) ? job.claims.length : 0,
      slaBreachesCount: Array.isArray(job.slaBreaches) ? job.slaBreaches.length : 0,
      slaCreditsCount: Array.isArray(job.slaCredits) ? job.slaCredits.length : 0,
      status: job.status ?? null
    },
    evidence
  };
}

export function buildProofReceiptV1({ tenantId, job, events, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  if (!job || typeof job !== "object") throw new TypeError("job is required");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  const jobVersion = proof.eventCount;
  const base = buildBase({
    artifactType: ARTIFACT_TYPE.PROOF_RECEIPT_V1,
    artifactId,
    generatedAt,
    tenantId,
    jobId: job.id,
    jobVersion,
    jobProof: proof,
    policyHash: policyHashFromBooking(job.booking)
  });

  const proofEvent = latestProofEvaluatedEventFromEvents(events);
  const p = proofEvent?.payload ?? null;

  const receipt =
    p && typeof p === "object"
      ? {
          proofEventId: proofEvent?.id ?? null,
          proofEventAt: p.evaluatedAt ?? proofEvent?.at ?? null,
          proofEventChainHash: proofEvent?.chainHash ?? null,
          proofEventPayloadHash: proofEvent?.payloadHash ?? null,
          proofEventSignerKeyId: proofEvent?.signerKeyId ?? null,
          proofEventSignature: proofEvent?.signature ?? null,
          evaluatedAtChainHash: p.evaluatedAtChainHash ?? null,
          evaluationId: p.evaluationId ?? null,
	          status: p.status ?? null,
	          reasonCodes: Array.isArray(p.reasonCodes) ? p.reasonCodes : [],
	          missingEvidence: Array.isArray(p.missingEvidence) ? p.missingEvidence : [],
	          requiredZonesHash: p.requiredZonesHash ?? null,
	          customerPolicyHash: p.customerPolicyHash ?? null,
	          operatorPolicyHash: p.operatorPolicyHash ?? null,
	          factsHash: p.factsHash ?? null,
	          metrics: p.metrics ?? null
	        }
      : null;

  return {
    ...base,
    proofReceipt: receipt,
    job: {
      templateId: job.templateId ?? null,
      customerId: job.booking?.customerId ?? job.customerId ?? null,
      siteId: job.booking?.siteId ?? job.siteId ?? null,
      contractId: job.booking?.contractId ?? job.contractId ?? null,
      environmentTier: job.booking?.environmentTier ?? null,
      bookingWindow: job.booking ? { startAt: job.booking.startAt ?? null, endAt: job.booking.endAt ?? null } : null,
      status: job.status ?? null
    }
  };
}

export function buildIncidentPacketV1({ tenantId, job, events, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  if (!job || typeof job !== "object") throw new TypeError("job is required");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  const jobVersion = proof.eventCount;
  const base = buildBase({
    artifactType: ARTIFACT_TYPE.INCIDENT_PACKET_V1,
    artifactId,
    generatedAt,
    tenantId,
    jobId: job.id,
    jobVersion,
    jobProof: proof,
    policyHash: policyHashFromBooking(job.booking)
  });

  const incidents = Array.isArray(job.incidents)
    ? job.incidents.map((i) => ({
        incidentId: i?.incidentId ?? null,
        type: i?.type ?? null,
        severity: i?.severity ?? null,
        status: i?.status ?? null,
        reportedAt: i?.reportedAt ?? null,
        detectedAt: i?.detectedAt ?? null,
        description: i?.description ?? null,
        reportedBy: i?.reportedBy ?? null
      }))
    : [];

  const claims = Array.isArray(job.claims)
    ? job.claims.map((c) => ({
        claimId: c?.claimId ?? null,
        incidentId: c?.incidentId ?? null,
        status: c?.status ?? null,
        approved: c?.approved ?? null,
        paid: c?.paid ?? null,
        openedAt: c?.openedAt ?? null,
        triagedAt: c?.triagedAt ?? null,
        approvedAt: c?.approvedAt ?? null,
        deniedAt: c?.deniedAt ?? null,
        paidAt: c?.paidAt ?? null
      }))
    : [];

  const evidence = Array.isArray(job.evidence)
    ? job.evidence.map((e) => ({
        evidenceId: e?.evidenceId ?? null,
        capturedAt: e?.capturedAt ?? null,
        contentType: e?.contentType ?? null,
        evidenceRefHash: evidenceRefHash(e?.evidenceRef ?? null),
        redaction: e?.redaction ?? null,
        expiredAt: e?.expiredAt ?? null
      }))
    : [];

  return {
    ...base,
    job: {
      templateId: job.templateId ?? null,
      customerId: job.booking?.customerId ?? job.customerId ?? null,
      siteId: job.booking?.siteId ?? job.siteId ?? null,
      contractId: job.booking?.contractId ?? job.contractId ?? null,
      zoneId: job.booking?.zoneId ?? job.constraints?.zoneId ?? null,
      environmentTier: job.booking?.environmentTier ?? null
    },
    incidents,
    claims,
    evidence
  };
}

export function buildCreditMemoV1({ tenantId, job, events, creditEvent, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  if (!job || typeof job !== "object") throw new TypeError("job is required");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");
  if (!creditEvent || typeof creditEvent !== "object") throw new TypeError("creditEvent is required");

  const proof = jobProofFromEvents(events);
  const jobVersion = proof.eventCount;
  const base = buildBase({
    artifactType: ARTIFACT_TYPE.CREDIT_MEMO_V1,
    artifactId,
    generatedAt,
    tenantId,
    jobId: job.id,
    jobVersion,
    jobProof: proof,
    policyHash: policyHashFromBooking(job.booking)
  });

  const p = creditEvent.payload ?? {};
  const coveragePolicy = job.booking?.policySnapshot?.coveragePolicy ?? job.booking?.coveragePolicy ?? null;
  const creditFundingModel = coveragePolicy?.creditFundingModel ?? null;
  const insurerId = creditFundingModel === "INSURER_RECOVERABLE" ? (coveragePolicy?.insurerId ?? null) : null;
  const pctRaw = coveragePolicy?.recoverablePercent ?? 100;
  const recoverablePercent = Number.isSafeInteger(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : 100;
  const creditAmountCents = Number.isSafeInteger(p?.amountCents) ? p.amountCents : null;
  const recoverableCents =
    insurerId && Number.isSafeInteger(creditAmountCents) ? Math.floor((creditAmountCents * recoverablePercent) / 100) : null;
  const receivableRefId =
    insurerId && (typeof p.creditId === "string" && p.creditId.trim() !== "" ? p.creditId : creditEvent.id)
      ? `recv_${job.id}_${typeof p.creditId === "string" && p.creditId.trim() !== "" ? p.creditId : creditEvent.id}`
      : null;
  return {
    ...base,
    credit: {
      creditId: p.creditId ?? null,
      type: "SLA",
      amountCents: p.amountCents ?? null,
      currency: p.currency ?? null,
      issuedAt: p.issuedAt ?? creditEvent.at ?? null,
      reason: p.reason ?? null,
      trigger: p.trigger ?? null,
      settledEventId: p.settledEventId ?? null,
      funding: {
        model: creditFundingModel ?? null,
        insurerId,
        recoverablePercent: insurerId ? recoverablePercent : null,
        recoverableCents,
        receivableRefId
      }
    },
    job: {
      templateId: job.templateId ?? null,
      customerId: job.booking?.customerId ?? job.customerId ?? null,
      siteId: job.booking?.siteId ?? job.siteId ?? null,
      contractId: job.booking?.contractId ?? job.contractId ?? null,
      zoneId: job.booking?.zoneId ?? job.constraints?.zoneId ?? null,
      environmentTier: job.booking?.environmentTier ?? null
    }
  };
}

export function buildSettlementStatementV1({ tenantId, job, events, settlement, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  if (!job || typeof job !== "object") throw new TypeError("job is required");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");
  assertPlainObject(settlement, "settlement");

  const proof = jobProofFromEvents(events);
  const jobVersion = proof.eventCount;
  const base = buildBase({
    artifactType: ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1,
    artifactId,
    generatedAt,
    tenantId,
    jobId: job.id,
    jobVersion,
    jobProof: proof,
    policyHash: policyHashFromBooking(job.booking)
  });

  const proofResult = effectiveProofFromEvents({ events });

  return {
    ...base,
    proof: proofResult,
    job: {
      templateId: job.templateId ?? null,
      customerId: job.booking?.customerId ?? job.customerId ?? null,
      siteId: job.booking?.siteId ?? job.siteId ?? null,
      contractId: job.booking?.contractId ?? job.contractId ?? null,
      customerContractHash: job.booking?.customerContractHash ?? null,
      customerCompilerId: job.booking?.customerCompilerId ?? null,
      customerPolicyHash: base.policyHash ?? null,
      operatorContractHash: job.operatorContractHash ?? null,
      operatorCompilerId: job.operatorCompilerId ?? null,
      operatorPolicyHash: job.operatorPolicyHash ?? null,
      requiredZonesHash: job.booking?.requiredZonesHash ?? null,
      zoneId: job.booking?.zoneId ?? job.constraints?.zoneId ?? null,
      environmentTier: job.booking?.environmentTier ?? null
    },
    settlement
  };
}

export function buildCoverageCertificateV1({ tenantId, job, events, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  if (!job || typeof job !== "object") throw new TypeError("job is required");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  const jobVersion = proof.eventCount;
  const base = buildBase({
    artifactType: ARTIFACT_TYPE.COVERAGE_CERTIFICATE_V1,
    artifactId,
    generatedAt,
    tenantId,
    jobId: job.id,
    jobVersion,
    jobProof: proof,
    policyHash: policyHashFromBooking(job.booking)
  });

  const coveragePolicy = job.booking?.policySnapshot?.coveragePolicy ?? job.booking?.coveragePolicy ?? null;
  const creditPolicy = job.booking?.policySnapshot?.creditPolicy ?? job.booking?.creditPolicy ?? null;
  const sla = job.booking?.policySnapshot?.sla ?? job.booking?.sla ?? null;

  const latestRisk = Array.isArray(job.riskScores) && job.riskScores.length ? job.riskScores[job.riskScores.length - 1] : null;
  const riskPayload = latestRisk?.payload ?? null;
  const risk =
    riskPayload && typeof riskPayload === "object"
      ? {
          basis: riskPayload.basis ?? null,
          scoredAt: riskPayload.scoredAt ?? latestRisk?.at ?? null,
          modelVersion: riskPayload.modelVersion ?? null,
          riskScore: riskPayload.riskScore ?? null,
          expectedAssistSeconds: riskPayload.expectedAssistSeconds ?? null,
          expectedIncidentProbabilityBps: riskPayload.expectedIncidentProbabilityBps ?? null,
          expectedCreditBurnRateCents: riskPayload.expectedCreditBurnRateCents ?? null,
          currency: riskPayload.currency ?? null,
          policyHash: riskPayload.policyHash ?? null
        }
      : null;

  return {
    ...base,
    job: {
      templateId: job.templateId ?? null,
      customerId: job.booking?.customerId ?? job.customerId ?? null,
      siteId: job.booking?.siteId ?? job.siteId ?? null,
      contractId: job.booking?.contractId ?? job.contractId ?? null,
      customerContractHash: job.booking?.customerContractHash ?? null,
      customerCompilerId: job.booking?.customerCompilerId ?? null,
      customerPolicyHash: base.policyHash ?? null,
      operatorContractHash: job.operatorContractHash ?? null,
      operatorCompilerId: job.operatorCompilerId ?? null,
      operatorPolicyHash: job.operatorPolicyHash ?? null,
      zoneId: job.booking?.zoneId ?? job.constraints?.zoneId ?? null,
      environmentTier: job.booking?.environmentTier ?? null,
      bookingWindow: job.booking ? { startAt: job.booking.startAt ?? null, endAt: job.booking.endAt ?? null } : null,
      risk
    },
    coverage: {
      required: coveragePolicy?.required ?? null,
      coverageTierId: coveragePolicy?.coverageTierId ?? null,
      feeModel: coveragePolicy?.feeModel ?? null,
      feeCentsPerJob: coveragePolicy?.feeCentsPerJob ?? null,
      creditFundingModel: coveragePolicy?.creditFundingModel ?? null,
      reserveFundPercent: coveragePolicy?.reserveFundPercent ?? null,
      insurerId: coveragePolicy?.insurerId ?? null,
      recoverablePercent: coveragePolicy?.recoverablePercent ?? null,
      recoverableTerms: coveragePolicy?.recoverableTerms ?? null,
      responseSlaSeconds: coveragePolicy?.responseSlaSeconds ?? null,
      includedAssistSeconds: coveragePolicy?.includedAssistSeconds ?? null,
      overageRateCentsPerMinute: coveragePolicy?.overageRateCentsPerMinute ?? null,
      creditPolicy,
      sla
    }
  };
}

export function buildMonthlyStatementV1({ tenantId, month, basis, statement, events, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(month, "month");
  assertNonEmptyString(basis, "basis");
  assertPlainObject(statement, "statement");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  return {
    schemaVersion: ARTIFACT_TYPE.MONTHLY_STATEMENT_V1,
    artifactType: ARTIFACT_TYPE.MONTHLY_STATEMENT_V1,
    artifactId,
    generatedAt,
    tenantId,
    month,
    basis,
    eventProof: proof,
    statement
  };
}

export function buildHeldExposureRollforwardV1({ tenantId, period, basis, rollforward, holds, events, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(basis, "basis");
  assertPlainObject(rollforward, "rollforward");
  if (!Array.isArray(holds)) throw new TypeError("holds must be an array");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  return {
    schemaVersion: ARTIFACT_TYPE.HELD_EXPOSURE_ROLLFORWARD_V1,
    artifactType: ARTIFACT_TYPE.HELD_EXPOSURE_ROLLFORWARD_V1,
    artifactId,
    generatedAt,
    tenantId,
    period,
    basis,
    eventProof: proof,
    rollforward,
    holds
  };
}

export function buildPartyStatementV1({ tenantId, partyId, partyRole, period, basis, statement, events, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(partyId, "partyId");
  assertNonEmptyString(partyRole, "partyRole");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(basis, "basis");
  assertPlainObject(statement, "statement");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  return {
    schemaVersion: ARTIFACT_TYPE.PARTY_STATEMENT_V1,
    artifactType: ARTIFACT_TYPE.PARTY_STATEMENT_V1,
    artifactId,
    generatedAt,
    tenantId,
    partyId,
    partyRole,
    period,
    basis,
    eventProof: proof,
    statement
  };
}

export function buildPayoutInstructionV1({
  tenantId,
  partyId,
  partyRole,
  period,
  statementHash,
  payoutKey,
  currency = "USD",
  amountCents,
  destinationRef = null,
  events,
  artifactId,
  generatedAt
}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(partyId, "partyId");
  assertNonEmptyString(partyRole, "partyRole");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(statementHash, "statementHash");
  assertNonEmptyString(payoutKey, "payoutKey");
  assertNonEmptyString(currency, "currency");
  if (!Number.isSafeInteger(amountCents)) throw new TypeError("amountCents must be a safe integer (cents)");
  if (destinationRef !== null && destinationRef !== undefined) assertNonEmptyString(destinationRef, "destinationRef");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  return {
    schemaVersion: ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1,
    artifactType: ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1,
    artifactId,
    generatedAt,
    tenantId,
    partyId,
    partyRole,
    period,
    statementHash,
    payoutKey,
    payout: {
      currency,
      amountCents,
      destinationRef: destinationRef ?? null
    },
    eventProof: proof
  };
}

export function buildGlBatchV1({ tenantId, period, basis, batch, events, artifactId, generatedAt }) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(basis, "basis");
  assertPlainObject(batch, "batch");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  return {
    schemaVersion: ARTIFACT_TYPE.GL_BATCH_V1,
    artifactType: ARTIFACT_TYPE.GL_BATCH_V1,
    artifactId,
    generatedAt,
    tenantId,
    period,
    basis,
    eventProof: proof,
    batch
  };
}

export function buildJournalCsvV1({
  tenantId,
  period,
  basis,
  glBatchArtifactId,
  glBatchArtifactHash,
  accountMapHash,
  csv,
  csvSha256,
  events,
  artifactId,
  generatedAt
}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(basis, "basis");
  assertNonEmptyString(glBatchArtifactId, "glBatchArtifactId");
  assertNonEmptyString(glBatchArtifactHash, "glBatchArtifactHash");
  assertNonEmptyString(accountMapHash, "accountMapHash");
  assertNonEmptyString(csv, "csv");
  assertNonEmptyString(csvSha256, "csvSha256");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  return {
    schemaVersion: ARTIFACT_TYPE.JOURNAL_CSV_V1,
    artifactType: ARTIFACT_TYPE.JOURNAL_CSV_V1,
    artifactId,
    generatedAt,
    tenantId,
    period,
    basis,
    glBatchArtifactId,
    glBatchArtifactHash,
    accountMapHash,
    csv,
    csvSha256,
    eventProof: proof
  };
}

export function buildFinancePackBundlePointerV1({
  tenantId,
  period,
  basis,
  bundleHash,
  bundleManifestHash,
  monthProofBundleHash,
  glBatchHash,
  journalCsvHash,
  reconcileReportHash,
  financeAccountMapHash,
  evidenceRef,
  objectStore,
  events,
  artifactId,
  generatedAt
}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(basis, "basis");
  assertNonEmptyString(bundleHash, "bundleHash");
  assertNonEmptyString(bundleManifestHash, "bundleManifestHash");
  assertNonEmptyString(monthProofBundleHash, "monthProofBundleHash");
  assertNonEmptyString(glBatchHash, "glBatchHash");
  assertNonEmptyString(journalCsvHash, "journalCsvHash");
  assertNonEmptyString(reconcileReportHash, "reconcileReportHash");
  assertNonEmptyString(financeAccountMapHash, "financeAccountMapHash");
  assertNonEmptyString(evidenceRef, "evidenceRef");
  assertPlainObject(objectStore, "objectStore");
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("events is required");

  const proof = jobProofFromEvents(events);
  return {
    schemaVersion: ARTIFACT_TYPE.FINANCE_PACK_BUNDLE_V1,
    artifactType: ARTIFACT_TYPE.FINANCE_PACK_BUNDLE_V1,
    artifactId,
    generatedAt,
    tenantId,
    period,
    basis,
    bundleHash,
    bundleManifestHash,
    inputs: {
      monthProofBundleHash,
      glBatchHash,
      journalCsvHash,
      reconcileReportHash,
      financeAccountMapHash
    },
    objectStore,
    evidenceRef,
    eventProof: proof
  };
}
