import { createJob, applyJobEvent } from "./job-state-machine.js";
import { DEFAULT_TENANT_ID } from "./tenancy.js";

export function reduceJob(events) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  if (events.length === 0) return null;

  let job = null;
  const licensedById = new Map();
  const skillUses = [];
  const operatorCosts = [];
  const slaBreaches = [];
  const slaCredits = [];
  const riskScores = [];
  const incidentsById = new Map();
  const evidenceById = new Map();
  const claimsById = new Map();
  let latestProof = null;
  let settlement = null;
  let settlementHold = null;
  let dispute = null;

  for (const event of events) {
    if (!event || typeof event !== "object") throw new TypeError("event must be an object");

    if (event.type === "JOB_CREATED") {
      const templateId = event.payload?.templateId;
      const constraints = event.payload?.constraints ?? {};
      const tenantId = event.payload?.tenantId ?? DEFAULT_TENANT_ID;
      const customerId = event.payload?.customerId ?? null;
      const siteId = event.payload?.siteId ?? null;
      const contractId = event.payload?.contractId ?? null;
      job = createJob({ id: event.streamId, templateId, constraints, createdAt: event.at, tenantId, customerId, siteId, contractId });
      job = { ...job, revision: 0, updatedAt: event.at };
      continue;
    }

    if (!job) throw new TypeError("job stream is missing JOB_CREATED");

    job = applyJobEvent(job, event);

    if (event.type === "BOOKED") {
      const booking = event.payload ?? null;
      job = {
        ...job,
        booking,
        customerContractHash: booking?.customerContractHash ?? job.customerContractHash ?? null,
        customerPolicyHash: booking?.policyHash ?? job.customerPolicyHash ?? null,
        customerCompilerId: booking?.customerCompilerId ?? job.customerCompilerId ?? null,
        customerId: booking?.customerId ?? job.customerId ?? null,
        siteId: booking?.siteId ?? job.siteId ?? null,
        contractId: booking?.contractId ?? booking?.contract?.contractId ?? job.contractId ?? null
      };
    }

    if (event.type === "JOB_CANCELLED") {
      job = { ...job, cancellation: event.payload ?? null };
    }

    if (event.type === "JOB_RESCHEDULED") {
      const newWindow = event.payload?.newWindow ?? null;
      if (newWindow && job.booking) {
        job = { ...job, booking: { ...job.booking, startAt: newWindow.startAt ?? job.booking.startAt, endAt: newWindow.endAt ?? job.booking.endAt } };
      }

      // Rescheduling invalidates dispatch and access planning (must be re-derived/re-issued).
      job = {
        ...job,
        match: null,
        reservation: null,
        operatorContractHash: null,
        operatorPolicyHash: null,
        operatorCompilerId: null,
        operatorCoverage: {
          status: "none",
          reservationId: null,
          operatorId: null,
          startAt: null,
          endAt: null,
          reservedAt: null,
          releasedAt: null
        },
        assist: {
          status: "none",
          queueId: null,
          operatorId: null,
          queuedAt: null,
          assignedAt: null,
          acceptedAt: null,
          declinedAt: null
        },
        accessPlan: null,
        access: {
          status: "none",
          accessPlanId: null,
          grantedAt: null,
          deniedAt: null,
          revokedAt: null,
          expiredAt: null
        }
      };
    }

    if (event.type === "ACCESS_PLAN_ISSUED") {
      job = { ...job, accessPlan: event.payload ?? null };
      if (job.access?.accessPlanId !== event.payload?.accessPlanId) {
        job = {
          ...job,
          access: { ...job.access, status: "planned", accessPlanId: event.payload?.accessPlanId ?? null }
        };
      }
    }

    if (event.type === "ACCESS_GRANTED") {
      job = {
        ...job,
        access: {
          ...job.access,
          status: "granted",
          accessPlanId: event.payload?.accessPlanId ?? job.access?.accessPlanId ?? null,
          grantedAt: event.at
        }
      };
    }

    if (event.type === "ACCESS_DENIED") {
      job = {
        ...job,
        access: {
          ...job.access,
          status: "denied",
          accessPlanId: event.payload?.accessPlanId ?? job.access?.accessPlanId ?? null,
          deniedAt: event.at
        }
      };
    }

    if (event.type === "ACCESS_REVOKED") {
      job = {
        ...job,
        access: {
          ...job.access,
          status: "revoked",
          accessPlanId: event.payload?.accessPlanId ?? job.access?.accessPlanId ?? null,
          revokedAt: event.at
        }
      };
    }

    if (event.type === "ACCESS_EXPIRED") {
      job = {
        ...job,
        access: {
          ...job.access,
          status: "expired",
          accessPlanId: event.payload?.accessPlanId ?? job.access?.accessPlanId ?? null,
          expiredAt: event.at
        }
      };
    }

    if (event.type === "SKILL_LICENSED") {
      const licenseId = event.payload?.licenseId;
      if (licenseId) licensedById.set(licenseId, event.payload);
    }

    if (event.type === "RESERVED") {
      job = { ...job, reservation: event.payload ?? null };
    }

    if (event.type === "MATCHED") {
      const p = event.payload ?? {};
      const desiredOperatorContractHash = p.operatorContractHash ?? null;
      const desiredOperatorPolicyHash = p.operatorPolicyHash ?? null;
      const desiredOperatorCompilerId = p.operatorCompilerId ?? null;

      const fallbackContractHash = job.customerContractHash ?? job.booking?.customerContractHash ?? null;
      const fallbackPolicyHash = job.customerPolicyHash ?? job.booking?.policyHash ?? null;
      const fallbackCompilerId = job.customerCompilerId ?? job.booking?.customerCompilerId ?? null;

      job = {
        ...job,
        operatorContractHash: desiredOperatorContractHash ?? job.operatorContractHash ?? fallbackContractHash,
        operatorPolicyHash: desiredOperatorPolicyHash ?? job.operatorPolicyHash ?? fallbackPolicyHash,
        operatorCompilerId: desiredOperatorCompilerId ?? job.operatorCompilerId ?? fallbackCompilerId
      };
    }

    if (event.type === "OPERATOR_COVERAGE_RESERVED") {
      const p = event.payload ?? {};
      job = {
        ...job,
        operatorCoverage: {
          status: "reserved",
          reservationId: p.reservationId ?? null,
          operatorId: p.operatorId ?? null,
          startAt: p.startAt ?? null,
          endAt: p.endAt ?? null,
          reservedAt: event.at,
          releasedAt: null
        }
      };
    }

    if (event.type === "OPERATOR_COVERAGE_RELEASED") {
      const p = event.payload ?? {};
      if (job.operatorCoverage?.reservationId && p.reservationId === job.operatorCoverage.reservationId) {
        job = {
          ...job,
          operatorCoverage: { ...job.operatorCoverage, status: "released", releasedAt: event.at }
        };
      }
    }

    if (event.type === "ASSIST_REQUESTED") {
      const p = event.payload ?? {};
      job = {
        ...job,
        assist: { ...job.assist, status: "requested", requestedAt: p.requestedAt ?? event.at }
      };
    }

    if (event.type === "ASSIST_QUEUED") {
      const p = event.payload ?? {};
      job = {
        ...job,
        assist: {
          ...job.assist,
          status: "queued",
          queueId: p.queueId ?? job.assist?.queueId ?? null,
          queuedAt: p.queuedAt ?? event.at
        }
      };
    }

    if (event.type === "ASSIST_ASSIGNED") {
      const p = event.payload ?? {};
      job = {
        ...job,
        assist: {
          ...job.assist,
          status: "assigned",
          queueId: p.queueId ?? job.assist?.queueId ?? null,
          operatorId: p.operatorId ?? null,
          assignedAt: p.assignedAt ?? event.at
        }
      };
    }

    if (event.type === "ASSIST_ACCEPTED") {
      const p = event.payload ?? {};
      job = {
        ...job,
        assist: {
          ...job.assist,
          status: "accepted",
          queueId: p.queueId ?? job.assist?.queueId ?? null,
          operatorId: p.operatorId ?? job.assist?.operatorId ?? null,
          acceptedAt: p.acceptedAt ?? event.at
        }
      };
    }

    if (event.type === "ASSIST_DECLINED") {
      const p = event.payload ?? {};
      job = {
        ...job,
        assist: {
          ...job.assist,
          status: "declined",
          queueId: p.queueId ?? job.assist?.queueId ?? null,
          operatorId: p.operatorId ?? job.assist?.operatorId ?? null,
          declinedAt: p.declinedAt ?? event.at
        }
      };
    }

    if (event.type === "ASSIST_TIMEOUT") {
      const p = event.payload ?? {};
      job = {
        ...job,
        assist: {
          ...job.assist,
          status: "timeout",
          queueId: p.queueId ?? job.assist?.queueId ?? null,
          timedOutAt: p.timedOutAt ?? event.at,
          timeoutReason: p.reason ?? null
        }
      };
    }

    if (event.type === "EXECUTION_STARTED") {
      const robotId = event.actor?.type === "robot" ? event.actor.id : null;
      job = {
        ...job,
        execution: {
          ...job.execution,
          startedAt: event.at,
          robotId: robotId ?? job.execution?.robotId ?? null,
          stage: event.payload?.stage ?? job.execution?.stage ?? null
        }
      };
    }

    if (event.type === "JOB_EXECUTION_STARTED") {
      job = {
        ...job,
        execution: {
          ...job.execution,
          startedAt: event.payload?.startedAt ?? event.at,
          robotId: event.payload?.robotId ?? job.execution?.robotId ?? null,
          stage: event.payload?.stage ?? job.execution?.stage ?? null
        }
      };
    }

    if (event.type === "JOB_HEARTBEAT") {
      job = {
        ...job,
        execution: {
          ...job.execution,
          lastHeartbeatAt: event.payload?.t ?? event.at,
          lastHeartbeatStage: event.payload?.stage ?? null,
          lastHeartbeatProgress: event.payload?.progress ?? null,
          lastHeartbeatAssistRequested: event.payload?.assistRequested ?? null,
          robotId: event.payload?.robotId ?? job.execution?.robotId ?? null
        }
      };
    }

    if (event.type === "JOB_EXECUTION_STALLED") {
      job = {
        ...job,
        execution: {
          ...job.execution,
          stalledAt: event.payload?.detectedAt ?? event.at,
          stallReason: event.payload?.reason ?? null
        }
      };
    }

    if (event.type === "JOB_EXECUTION_RESUMED") {
      job = {
        ...job,
        assist: {
          status: "none",
          queueId: null,
          operatorId: null,
          queuedAt: null,
          assignedAt: null,
          acceptedAt: null,
          declinedAt: null,
          timedOutAt: null,
          timeoutReason: null
        },
        execution: {
          ...job.execution,
          resumedAt: event.payload?.resumedAt ?? event.at,
          stalledAt: null,
          stallReason: null
        }
      };
    }

    if (event.type === "EXECUTION_COMPLETED" || event.type === "JOB_EXECUTION_COMPLETED") {
      job = { ...job, execution: { ...job.execution, completedAt: event.at } };
    }

    if (event.type === "EXECUTION_ABORTED" || event.type === "JOB_EXECUTION_ABORTED") {
      job = { ...job, execution: { ...job.execution, abortedAt: event.at } };
    }

    if (event.type === "SKILL_USED" || event.type === "SKILL_METER_REPORTED") {
      skillUses.push({ at: event.at, type: event.type, payload: event.payload ?? null });
    }

    if (event.type === "OPERATOR_COST_RECORDED") {
      operatorCosts.push({ at: event.at, payload: event.payload ?? null, actor: event.actor ?? null });
    }

    if (event.type === "SLA_BREACH_DETECTED") {
      slaBreaches.push({ at: event.at, payload: event.payload ?? null, actor: event.actor ?? null });
    }

    if (event.type === "SLA_CREDIT_ISSUED") {
      slaCredits.push({ at: event.at, payload: event.payload ?? null, actor: event.actor ?? null });
    }

    if (event.type === "RISK_SCORED") {
      riskScores.push({ at: event.at, payload: event.payload ?? null, actor: event.actor ?? null });
    }

    if (event.type === "PROOF_EVALUATED") {
      const p = event.payload ?? null;
      if (p && typeof p === "object") {
	        latestProof = {
	          evaluatedAt: p.evaluatedAt ?? event.at ?? null,
	          evaluatedAtChainHash: p.evaluatedAtChainHash ?? null,
	          evaluationId: p.evaluationId ?? null,
	          status: p.status ?? null,
	          reasonCodes: Array.isArray(p.reasonCodes) ? p.reasonCodes : [],
	          requiredZonesHash: p.requiredZonesHash ?? null,
	          customerPolicyHash: p.customerPolicyHash ?? null,
	          operatorPolicyHash: p.operatorPolicyHash ?? null,
	          factsHash: p.factsHash ?? null,
	          missingEvidence: Array.isArray(p.missingEvidence) ? p.missingEvidence : null,
	          metrics: p.metrics ?? null
	        };
      }
    }

    if (event.type === "SETTLED") {
      const p = event.payload ?? null;
      settlement = {
        settledAt: event.at ?? null,
        settledEventId: event.id ?? null,
        settlementProofRef: p && typeof p === "object" ? (p.settlementProofRef ?? null) : null
      };
    }

    if (event.type === "SETTLEMENT_HELD") {
      const p = event.payload ?? null;
      const isUpdate = settlementHold?.status === "HELD" && settlementHold?.holdId && settlementHold.holdId === (p?.holdId ?? null);
      const heldAt = isUpdate ? (settlementHold?.heldAt ?? null) : (p?.heldAt ?? event.at ?? null);
      const lastUpdatedAt = p?.heldAt ?? event.at ?? null;
      const exposure = p?.exposure ?? null;
      const expected = exposure && typeof exposure === "object" ? (exposure.expected ?? null) : null;
      const held = exposure && typeof exposure === "object" ? (exposure.held ?? null) : null;
      settlementHold = {
        status: "HELD",
        holdId: p?.holdId ?? null,
        heldAt,
        lastUpdatedAt,
        factsHash: p?.factsHash ?? null,
        evaluatedAtChainHash: p?.evaluatedAtChainHash ?? null,
        reasonCodes: Array.isArray(p?.reasonCodes) ? p.reasonCodes : [],
        missingEvidence: Array.isArray(p?.missingEvidence) ? p.missingEvidence : null,
        triggeringProofRef: p?.triggeringProofRef ?? null,
        pricingAnchor: p?.pricingAnchor ?? null,
        currency: p?.currency ?? expected?.currency ?? held?.currency ?? null,
        expectedExposure: expected,
        holdPolicy: exposure && typeof exposure === "object" ? (exposure.holdPolicy ?? null) : null,
        heldExposure: held
      };
    }

    if (event.type === "SETTLEMENT_RELEASED") {
      const p = event.payload ?? null;
      settlementHold = {
        status: "RELEASED",
        holdId: p?.holdId ?? settlementHold?.holdId ?? null,
        heldAt: settlementHold?.heldAt ?? null,
        lastUpdatedAt: settlementHold?.lastUpdatedAt ?? null,
        factsHash: settlementHold?.factsHash ?? null,
        evaluatedAtChainHash: settlementHold?.evaluatedAtChainHash ?? null,
        reasonCodes: settlementHold?.reasonCodes ?? [],
        missingEvidence: settlementHold?.missingEvidence ?? null,
        triggeringProofRef: settlementHold?.triggeringProofRef ?? null,
        pricingAnchor: settlementHold?.pricingAnchor ?? null,
        currency: settlementHold?.currency ?? null,
        expectedExposure: settlementHold?.expectedExposure ?? null,
        holdPolicy: settlementHold?.holdPolicy ?? null,
        heldExposure: settlementHold?.heldExposure ?? null,
        releasedAt: p?.releasedAt ?? event.at ?? null,
        releaseReason: p?.releaseReason ?? null,
        releasingProofRef: p?.releasingProofRef ?? null
      };
    }

    if (event.type === "SETTLEMENT_FORFEITED") {
      const p = event.payload ?? null;
      settlementHold = {
        status: "FORFEITED",
        holdId: p?.holdId ?? settlementHold?.holdId ?? null,
        heldAt: settlementHold?.heldAt ?? null,
        lastUpdatedAt: settlementHold?.lastUpdatedAt ?? null,
        factsHash: p?.factsHash ?? settlementHold?.factsHash ?? null,
        evaluatedAtChainHash: p?.evaluatedAtChainHash ?? settlementHold?.evaluatedAtChainHash ?? null,
        reasonCodes: settlementHold?.reasonCodes ?? [],
        missingEvidence: settlementHold?.missingEvidence ?? null,
        triggeringProofRef: settlementHold?.triggeringProofRef ?? null,
        pricingAnchor: settlementHold?.pricingAnchor ?? null,
        currency: settlementHold?.currency ?? null,
        expectedExposure: settlementHold?.expectedExposure ?? null,
        holdPolicy: settlementHold?.holdPolicy ?? null,
        heldExposure: settlementHold?.heldExposure ?? null,
        forfeitedAt: p?.forfeitedAt ?? event.at ?? null,
        forfeitureReason: p?.forfeitureReason ?? null,
        decisionRef: p?.decisionRef ?? null,
        decisionEventRef: p?.decisionEventRef ?? null
      };
    }

    if (event.type === "DISPUTE_OPENED") {
      const p = event.payload ?? null;
      dispute = {
        status: "OPEN",
        disputeId: p?.disputeId ?? null,
        openedAt: p?.openedAt ?? event.at ?? null,
        openedBy: event.actor ?? null,
        reason: p?.reason ?? null
      };
    }

    if (event.type === "DISPUTE_CLOSED") {
      const p = event.payload ?? null;
      dispute = {
        status: "CLOSED",
        disputeId: p?.disputeId ?? null,
        closedAt: p?.closedAt ?? event.at ?? null,
        closedBy: event.actor ?? null,
        resolution: p?.resolution ?? null
      };
    }

    if (event.type === "INCIDENT_REPORTED" || event.type === "INCIDENT_DETECTED") {
      const incidentId = event.payload?.incidentId ?? null;
      if (incidentId) {
        incidentsById.set(incidentId, {
          incidentId,
          jobId: event.payload?.jobId ?? job.id,
          type: event.payload?.type ?? null,
          severity: event.payload?.severity ?? null,
          summary: event.payload?.summary ?? null,
          description: event.payload?.description ?? null,
          signals: event.payload?.signals ?? null,
          reportedBy: event.payload?.reportedBy ?? null,
          sourceEventType: event.type,
          at: event.at,
          actor: event.actor ?? null
        });
      }
    }

    if (event.type === "EVIDENCE_CAPTURED") {
      const evidenceId = event.payload?.evidenceId ?? null;
      if (evidenceId) {
          evidenceById.set(evidenceId, {
            evidenceId,
            jobId: event.payload?.jobId ?? job.id,
            incidentId: event.payload?.incidentId ?? null,
            evidenceRef: event.payload?.evidenceRef ?? null,
            kind: event.payload?.kind ?? null,
            durationSeconds: event.payload?.durationSeconds ?? null,
            sizeBytes: event.payload?.sizeBytes ?? null,
            contentType: event.payload?.contentType ?? null,
            redaction: event.payload?.redaction ?? null,
            at: event.at,
            actor: event.actor ?? null,
            expiredAt: null,
          retentionDays: null,
          expiredBy: null
        });
      }
    }

    if (event.type === "EVIDENCE_EXPIRED") {
      const evidenceId = event.payload?.evidenceId ?? null;
      if (evidenceId) {
        const current =
            evidenceById.get(evidenceId) ??
            ({
              evidenceId,
              jobId: event.payload?.jobId ?? job.id,
              incidentId: null,
              evidenceRef: event.payload?.evidenceRef ?? null,
              kind: null,
              durationSeconds: null,
              sizeBytes: null,
              contentType: null,
              redaction: null,
              at: null,
              actor: null,
              expiredAt: null,
              retentionDays: null,
              expiredBy: null
            });
        evidenceById.set(evidenceId, {
          ...current,
          evidenceRef: event.payload?.evidenceRef ?? current.evidenceRef ?? null,
          expiredAt: event.at,
          retentionDays: event.payload?.retentionDays ?? current.retentionDays ?? null,
          expiredBy: event.actor ?? null
        });
      }
    }

    if (event.type === "CLAIM_OPENED") {
      const claimId = event.payload?.claimId ?? null;
      if (claimId) {
        claimsById.set(claimId, {
          claimId,
          jobId: event.payload?.jobId ?? job.id,
          incidentId: event.payload?.incidentId ?? null,
          reasonCode: event.payload?.reasonCode ?? null,
          description: event.payload?.description ?? null,
          status: "OPEN",
          triageCode: null,
          triageNotes: null,
          approved: null,
          denied: null,
          adjustedAt: null,
          paid: null,
          openedAt: event.at,
          actor: event.actor ?? null
        });
      }
    }

    if (event.type === "CLAIM_TRIAGED") {
      const claimId = event.payload?.claimId ?? null;
      if (claimId) {
        const current = claimsById.get(claimId) ?? { claimId, jobId: job.id, incidentId: null, status: "OPEN" };
        claimsById.set(claimId, {
          ...current,
          status: current.status === "OPEN" ? "TRIAGED" : current.status,
          triageCode: event.payload?.triageCode ?? current.triageCode ?? null,
          triageNotes: event.payload?.notes ?? current.triageNotes ?? null,
          triagedAt: event.at,
          triagedBy: event.actor ?? null
        });
      }
    }

    if (event.type === "CLAIM_APPROVED") {
      const claimId = event.payload?.claimId ?? null;
      if (claimId) {
        const current = claimsById.get(claimId) ?? { claimId, jobId: job.id, incidentId: null };
        claimsById.set(claimId, {
          ...current,
          status: "APPROVED",
          approved: { amounts: event.payload?.amounts ?? null, currency: event.payload?.currency ?? null, notes: event.payload?.notes ?? null },
          approvedAt: event.at,
          approvedBy: event.actor ?? null
        });
      }
    }

    if (event.type === "CLAIM_DENIED") {
      const claimId = event.payload?.claimId ?? null;
      if (claimId) {
        const current = claimsById.get(claimId) ?? { claimId, jobId: job.id, incidentId: null };
        claimsById.set(claimId, {
          ...current,
          status: "DENIED",
          denied: { reasonCode: event.payload?.reasonCode ?? null, notes: event.payload?.notes ?? null },
          deniedAt: event.at,
          deniedBy: event.actor ?? null
        });
      }
    }

    if (event.type === "JOB_ADJUSTED") {
      const claimId = event.payload?.claimId ?? null;
      if (claimId) {
        const current = claimsById.get(claimId) ?? { claimId, jobId: job.id, incidentId: null, status: "APPROVED" };
        claimsById.set(claimId, {
          ...current,
          adjustedAt: event.at,
          adjustmentId: event.payload?.adjustmentId ?? current.adjustmentId ?? null,
          adjustedBy: event.actor ?? null
        });
      }
    }

    if (event.type === "CLAIM_PAID") {
      const claimId = event.payload?.claimId ?? null;
      if (claimId) {
        const current = claimsById.get(claimId) ?? { claimId, jobId: job.id, incidentId: null, status: "APPROVED" };
        claimsById.set(claimId, {
          ...current,
          status: "PAID",
          paid: { amountCents: event.payload?.amountCents ?? null, currency: event.payload?.currency ?? null, paymentRef: event.payload?.paymentRef ?? null },
          paidAt: event.at,
          paidBy: event.actor ?? null
        });
      }
    }
  }

  const head = events[events.length - 1];
  job = {
    ...job,
    lastChainHash: head?.chainHash ?? null,
    lastEventId: head?.id ?? null,
    proof: latestProof,
    settlement,
    settlementHold,
    dispute,
    skillLicenses: Array.from(licensedById.values()),
    skillUses,
    operatorCosts,
    slaBreaches,
    slaCredits,
    riskScores,
    incidents: Array.from(incidentsById.values()),
    evidence: Array.from(evidenceById.values()),
    claims: Array.from(claimsById.values())
  };

  return job;
}
