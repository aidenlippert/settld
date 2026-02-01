import { createChainedEvent, appendChainedEvent } from "../../core/event-chain.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "../../core/tenancy.js";
import { reduceJob } from "../../core/job-reducer.js";
import { verifyZoneCoverageProofV1 } from "../../core/proof-verifier.js";
import { canonicalizeMissingEvidenceList } from "../../core/proof.js";
import { computeHoldExposureV1 } from "../../core/hold-exposure.js";
import { sha256Hex } from "../../core/crypto.js";
import { failpoint } from "../../core/failpoints.js";
import { logger } from "../../core/log.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

export function deriveProofEvalEnqueuesFromJobEvents({ tenantId, jobId, events }) {
  tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(jobId, "jobId");
  if (!Array.isArray(events)) throw new TypeError("events must be an array");

  const triggerTypes = new Set(["EXECUTION_COMPLETED", "JOB_EXECUTION_COMPLETED"]);
  const outbox = [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (!triggerTypes.has(e.type)) continue;
    if (!e.id || !e.chainHash) continue;
    outbox.push({
      type: "PROOF_EVAL_ENQUEUE",
      tenantId,
      jobId,
      sourceEventId: e.id,
      evaluatedAtChainHash: e.chainHash,
      sourceAt: e.at ?? null
    });
  }

  // Dedupe: (tenantId, jobId, evaluatedAtChainHash).
  const seen = new Set();
  const deduped = [];
  for (const msg of outbox) {
    const key = `${tenantId}\n${jobId}\n${msg.evaluatedAtChainHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(msg);
  }
  return deduped;
}

export function createProofWorker({ store, nowIso, getJobEvents, serverSigner, validateDomainEvent, commitTx }) {
  if (!store) throw new TypeError("store is required");
  if (typeof nowIso !== "function") throw new TypeError("nowIso is required");
  if (typeof getJobEvents !== "function") throw new TypeError("getJobEvents is required");
  if (!serverSigner) throw new TypeError("serverSigner is required");
  if (typeof validateDomainEvent !== "function") throw new TypeError("validateDomainEvent is required");
  if (typeof commitTx !== "function") throw new TypeError("commitTx is required");

  async function appendProofEvaluated({ tenantId, jobId, evaluatedAtChainHash, requestId = null }) {
    const existing = getJobEvents(tenantId, jobId);
    if (!existing.length) return null;

    const jobBeforeAppend = reduceJob(existing);
    if (!jobBeforeAppend) return null;

    // Evaluate against the job state at the requested anchor, but incorporate any evidence that arrived later.
    const idx = existing.findIndex((e) => e?.chainHash === evaluatedAtChainHash);
    if (idx === -1) return null;
    const sliced = existing.slice(0, idx + 1);
    const jobAtAnchor = reduceJob(sliced);
    if (!jobAtAnchor) return null;

    if (jobBeforeAppend.status === "SETTLED") {
      const disputeOpen = jobBeforeAppend?.dispute?.status === "OPEN";
      const settledAtRaw = jobBeforeAppend?.settlement?.settledAt ?? null;
      const settledAtMs = settledAtRaw ? Date.parse(String(settledAtRaw)) : NaN;

      const proofPolicy = jobAtAnchor.booking?.policySnapshot?.proofPolicy ?? null;
      const disputeWindowDays = Number.isSafeInteger(proofPolicy?.disputeWindowDays) ? proofPolicy.disputeWindowDays : 0;
      const allowWindow = proofPolicy?.allowReproofAfterSettlementWithinDisputeWindow === true && disputeWindowDays > 0;
      const nowMs = Date.parse(nowIso());
      const withinWindow = allowWindow && Number.isFinite(settledAtMs) && Number.isFinite(nowMs) && nowMs <= settledAtMs + disputeWindowDays * 24 * 60 * 60_000;

      if (!disputeOpen && !withinWindow) {
        try {
          store.metrics?.incCounter?.("proof_reeval_skipped_total", { reason: "job_settled" }, 1);
        } catch {}
        return null;
      }
    }

    const proof = verifyZoneCoverageProofV1({
      job: jobAtAnchor,
      events: existing,
      evaluatedAtChainHash,
      customerPolicyHash: jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null,
      operatorPolicyHash: jobAtAnchor.operatorPolicyHash ?? null
    });

    const customerPolicyHash = proof.anchors.customerPolicyHash ?? (jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null);
    const factsHash = proof.factsHash ?? null;
    const evaluationId =
      typeof evaluatedAtChainHash === "string" &&
      evaluatedAtChainHash.trim() &&
      typeof customerPolicyHash === "string" &&
      customerPolicyHash.trim() &&
      typeof factsHash === "string" &&
      factsHash.trim()
        ? sha256Hex(`${evaluatedAtChainHash}\n${customerPolicyHash}\n${factsHash}`)
        : null;

    // Idempotency: allow re-evaluation for the same completion anchor if evidence or policy changes,
    // but never append duplicates for the same (anchor + policyHash + factsHash).
    const existsExact = existing.some((e) => {
      if (e?.type !== "PROOF_EVALUATED") return false;
      const p = e.payload ?? null;
      if (!p || typeof p !== "object") return false;
      if (p.evaluatedAtChainHash !== evaluatedAtChainHash) return false;
      if (p.customerPolicyHash !== customerPolicyHash) return false;
      if (p.factsHash !== factsHash) return false;
      return true;
    });
    if (existsExact) return null;

    const evaluatedAt = nowIso();
    const canonicalMissingEvidence = (() => {
      try {
        return canonicalizeMissingEvidenceList(Array.isArray(proof.missingEvidence) ? proof.missingEvidence : []);
      } catch {
        return [];
      }
    })();

    const payload = {
      jobId,
      evaluatedAt,
      evaluatedAtChainHash,
      evaluationId,
      customerPolicyHash,
      operatorPolicyHash: proof.anchors.operatorPolicyHash,
      requiredZonesHash: proof.anchors.requiredZonesHash,
      factsHash,
      status: proof.status,
      reasonCodes: proof.reasonCodes,
      missingEvidence: canonicalMissingEvidence,
      triggeredFacts: proof.triggeredFacts,
      metrics: proof.metrics
    };

    const draft = createChainedEvent({
      streamId: jobId,
      type: "PROOF_EVALUATED",
      at: evaluatedAt,
      actor: { type: "proof", id: "proof_verifier_v1" },
      payload
    });
    let nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
    const proofEvent = nextEvents[nextEvents.length - 1];

    try {
      validateDomainEvent({ jobBefore: jobBeforeAppend, event: proofEvent, eventsBefore: existing });
    } catch (err) {
      const msg = typeof err?.message === "string" ? err.message : String(err ?? "proof event rejected");
      const e = new Error(msg);
      e.code = err?.code ?? "PROOF_EVENT_REJECTED";
      throw e;
    }

    failpoint("proof.eval.after_append_before_commit");

    const appended = [proofEvent];

    // Strict/holdback mode: create a ledger-visible settlement hold when proof is INSUFFICIENT_EVIDENCE.
    // Hold is keyed to the canonical proof identity (anchor + policyHash + factsHash).
    const proofPolicy = jobAtAnchor.booking?.policySnapshot?.proofPolicy ?? null;
    const gateModeRaw = typeof proofPolicy?.gateMode === "string" ? proofPolicy.gateMode : "warn";
    const gateMode = gateModeRaw === "strict" || gateModeRaw === "holdback" ? gateModeRaw : "warn";

    if (jobBeforeAppend.status === "COMPLETED" && gateMode !== "warn") {
      const holdId =
        typeof evaluatedAtChainHash === "string" &&
        evaluatedAtChainHash.trim() &&
        typeof customerPolicyHash === "string" &&
        customerPolicyHash.trim()
          ? `hold_${sha256Hex(`${evaluatedAtChainHash}\n${customerPolicyHash}`)}`
          : null;
      if (proof.status === "INSUFFICIENT_EVIDENCE" && holdId) {
        const proofReasonCodes = Array.isArray(proof.reasonCodes) ? proof.reasonCodes : [];
        // Hold checklists must be derived directly from the canonical verifier output (missingEvidence),
        // not reverse-mapped from reason codes (which will rot as the taxonomy evolves).
        const canonicalHoldMissingEvidence = canonicalMissingEvidence;
        const quoteEvent =
          [...sliced].reverse().find((e) => e?.type === "QUOTE_PROPOSED" && typeof e?.id === "string" && e.id.trim()) ?? null;
        const pricingAnchor = {
          quoteEventId: quoteEvent?.id ?? null,
          quoteEventChainHash: quoteEvent?.chainHash ?? null,
          quoteEventPayloadHash: quoteEvent?.payloadHash ?? null,
          customerPolicyHash: customerPolicyHash ?? null,
          operatorPolicyHash: proof.anchors.operatorPolicyHash ?? null,
          evaluatedAtChainHash
        };
        const exposure = (() => {
          try {
            return computeHoldExposureV1({ job: jobAtAnchor, eventsBefore: sliced });
          } catch {
            return null;
          }
        })();

        const triggeringProofRef = {
          proofEventId: proofEvent.id ?? null,
          proofEventAt: payload.evaluatedAt ?? proofEvent.at ?? null,
          proofEventChainHash: proofEvent.chainHash ?? null,
          proofEventPayloadHash: proofEvent.payloadHash ?? null,
          proofEventSignerKeyId: proofEvent.signerKeyId ?? null,
          proofEventSignature: proofEvent.signature ?? null,
          evaluationId: payload.evaluationId ?? null,
          evaluatedAtChainHash: payload.evaluatedAtChainHash ?? null,
          status: payload.status ?? null,
          reasonCodes: Array.isArray(payload.reasonCodes) ? payload.reasonCodes : [],
          requiredZonesHash: payload.requiredZonesHash ?? null,
          customerPolicyHash: payload.customerPolicyHash ?? null,
          operatorPolicyHash: payload.operatorPolicyHash ?? null,
          factsHash: payload.factsHash ?? null
        };

        const holdPayload = {
          jobId,
          holdId,
          heldAt: evaluatedAt,
          evaluatedAtChainHash,
          customerPolicyHash,
          operatorPolicyHash: proof.anchors.operatorPolicyHash ?? null,
          factsHash,
          proofEventId: proofEvent.id ?? null,
          proofEventChainHash: proofEvent.chainHash ?? null,
          proofEventPayloadHash: proofEvent.payloadHash ?? null,
          proofEventSignerKeyId: proofEvent.signerKeyId ?? null,
          proofEventSignature: proofEvent.signature ?? null,
          triggeringProofRef,
          status: proof.status,
          reasonCodes: proofReasonCodes,
          missingEvidence: canonicalHoldMissingEvidence,
          pricingAnchor,
          exposure,
          metrics: proof.metrics ?? null
        };
        const holdDraft = createChainedEvent({
          streamId: jobId,
          type: "SETTLEMENT_HELD",
          at: evaluatedAt,
          actor: { type: "proof", id: "proof_verifier_v1" },
          payload: holdPayload
        });
        nextEvents = appendChainedEvent({ events: nextEvents, event: holdDraft, signer: serverSigner });
        const holdEvent = nextEvents[nextEvents.length - 1];
        try {
          const jobBeforeHold = reduceJob(nextEvents.slice(0, -1));
          validateDomainEvent({ jobBefore: jobBeforeHold, event: holdEvent, eventsBefore: nextEvents.slice(0, -1) });
          appended.push(holdEvent);
        } catch {
          // best-effort: do not fail proof evaluation if hold append is rejected
        }
      }

      // If a previously-held job now has PASS/FAIL proof for the current facts, release the hold.
      if ((proof.status === "PASS" || proof.status === "FAIL") && holdId) {
        const hasActiveHold =
          existing.some((e) => e?.type === "SETTLEMENT_HELD" && e?.payload?.holdId === holdId) &&
          !existing.some((e) => (e?.type === "SETTLEMENT_RELEASED" || e?.type === "SETTLEMENT_FORFEITED") && e?.payload?.holdId === holdId);
        if (hasActiveHold) {
          const releasePayload = {
            jobId,
            holdId,
            releasedAt: evaluatedAt,
            releaseReason: "PROOF_FINAL",
            proofEventId: proofEvent.id ?? null,
            proofEventChainHash: proofEvent.chainHash ?? null,
            proofEventPayloadHash: proofEvent.payloadHash ?? null,
            evaluationId,
            releasingProofRef: {
              proofEventId: proofEvent.id ?? null,
              proofEventAt: payload.evaluatedAt ?? proofEvent.at ?? null,
              proofEventChainHash: proofEvent.chainHash ?? null,
              proofEventPayloadHash: proofEvent.payloadHash ?? null,
              proofEventSignerKeyId: proofEvent.signerKeyId ?? null,
              proofEventSignature: proofEvent.signature ?? null,
              evaluationId: payload.evaluationId ?? null,
              evaluatedAtChainHash: payload.evaluatedAtChainHash ?? null,
              status: payload.status ?? null,
              reasonCodes: Array.isArray(payload.reasonCodes) ? payload.reasonCodes : [],
              requiredZonesHash: payload.requiredZonesHash ?? null,
              customerPolicyHash: payload.customerPolicyHash ?? null,
              operatorPolicyHash: payload.operatorPolicyHash ?? null,
              factsHash: payload.factsHash ?? null
            }
          };
          const releaseDraft = createChainedEvent({
            streamId: jobId,
            type: "SETTLEMENT_RELEASED",
            at: evaluatedAt,
            actor: { type: "proof", id: "proof_verifier_v1" },
            payload: releasePayload
          });
          nextEvents = appendChainedEvent({ events: nextEvents, event: releaseDraft, signer: serverSigner });
          const releaseEvent = nextEvents[nextEvents.length - 1];
          try {
            const jobBeforeRelease = reduceJob(nextEvents.slice(0, -1));
            validateDomainEvent({ jobBefore: jobBeforeRelease, event: releaseEvent, eventsBefore: nextEvents.slice(0, -1) });
            appended.push(releaseEvent);
          } catch {
            // ignore
          }
        }
      }
    }

    await commitTx([{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: appended }]);
    return { eventId: proofEvent.id, status: proof.status, appendedEvents: appended.map((e) => e.id) };
  }

  async function tickProof({ maxMessages = 100 } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new TypeError("maxMessages must be a positive safe integer");

    const processed = [];

    if (
      store.kind === "pg" &&
      typeof store.claimOutbox === "function" &&
      typeof store.markOutboxProcessed === "function" &&
      typeof store.markOutboxFailed === "function"
    ) {
      const claimed = await store.claimOutbox({ topic: "PROOF_EVAL_ENQUEUE", maxMessages, worker: "proof_v1" });
      for (const row of claimed) {
        try {
          const msg = row?.message ?? null;
          const tenantId = normalizeTenantId(msg?.tenantId ?? DEFAULT_TENANT_ID);
          const jobId = msg?.jobId ? String(msg.jobId) : "";
          const evaluatedAtChainHash = msg?.evaluatedAtChainHash ? String(msg.evaluatedAtChainHash) : "";
          assertNonEmptyString(jobId, "jobId");
          assertNonEmptyString(evaluatedAtChainHash, "evaluatedAtChainHash");

          const result = await appendProofEvaluated({ tenantId, jobId, evaluatedAtChainHash, requestId: msg?.requestId ?? null });
          await store.markOutboxProcessed({ ids: [row.id], lastError: result ? null : "skipped" });
          if (result) processed.push({ outboxId: row.id, tenantId, jobId, ...result });
        } catch (err) {
          const lastError = typeof err?.message === "string" && err.message.trim() ? err.message : String(err ?? "proof failed");
          logger.error("proof.evaluate.failed", { tenantId: row?.message?.tenantId ?? null, jobId: row?.message?.jobId ?? null, outboxId: row.id, err });
          await store.markOutboxFailed({ ids: [row.id], lastError });
        }
      }
      return { processed };
    }

    // In-memory outbox scan.
    if (!Number.isSafeInteger(store.proofCursor) || store.proofCursor < 0) store.proofCursor = 0;
    while (store.proofCursor < store.outbox.length && processed.length < maxMessages) {
      const msg = store.outbox[store.proofCursor];
      store.proofCursor += 1;
      if (!msg || typeof msg !== "object") continue;
      if (msg.type !== "PROOF_EVAL_ENQUEUE") continue;
      try {
        const tenantId = normalizeTenantId(msg.tenantId ?? DEFAULT_TENANT_ID);
        const jobId = msg.jobId;
        const evaluatedAtChainHash = msg.evaluatedAtChainHash;
        const result = await appendProofEvaluated({ tenantId, jobId, evaluatedAtChainHash, requestId: msg.requestId ?? null });
        if (result) processed.push({ tenantId, jobId, ...result });
      } catch {
        // ignore bad messages
      }
    }

    return { processed, cursor: store.proofCursor };
  }

  return { tickProof };
}
