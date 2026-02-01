import { reduceJob } from "../../core/job-reducer.js";
import { ledgerEntriesForJobEvent } from "../../core/ledger-postings.js";
import { allocateEntry } from "../../core/allocations.js";
import { hashSplitPlanV1 } from "../../core/contract-document.js";
import {
  ARTIFACT_TYPE,
  buildCoverageCertificateV1,
  buildCreditMemoV1,
  buildIncidentPacketV1,
  buildProofReceiptV1,
  buildSettlementStatementV1,
  buildWorkCertificateV1,
  computeArtifactHash,
  sliceEventsThroughChainHash
} from "../../core/artifacts.js";
import { normalizeTenantId, DEFAULT_TENANT_ID } from "../../core/tenancy.js";
import { failpoint } from "../../core/failpoints.js";
import { logger } from "../../core/log.js";
import { clampQuota, isQuotaExceeded } from "../../core/quotas.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function outboxMaxAttemptsFromEnv({ fallbackAttempts = 25 } = {}) {
  const raw = typeof process !== "undefined" ? (process.env.PROXY_OUTBOX_MAX_ATTEMPTS ?? null) : null;
  if (raw === null || raw === undefined) return fallbackAttempts;
  const text = String(raw).trim();
  if (!text) return fallbackAttempts;
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) throw new TypeError("PROXY_OUTBOX_MAX_ATTEMPTS must be a positive integer");
  return n;
}

function parsePositiveIntEnv(name, fallback) {
  if (typeof process === "undefined" || !process.env) return fallback;
  const raw = process.env[name] ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

const outboxMaxAttempts = outboxMaxAttemptsFromEnv({ fallbackAttempts: 25 });

function computeJobLedgerEntries(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const entries = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event || typeof event !== "object") continue;
    if (event.type === "JOB_CREATED") continue;
    const eventsBefore = events.slice(0, i);
    const jobBefore = reduceJob(eventsBefore);
    if (!jobBefore) continue;
    try {
      const next = ledgerEntriesForJobEvent({ jobBefore, event, eventsBefore });
      if (Array.isArray(next) && next.length) entries.push(...next);
    } catch {
      // Ignore: not all events post to ledger; artifacts should be buildable even if a posting is rejected.
    }
  }

  return entries;
}

function summarizeLedger(entries) {
  const totalsByAccountId = {};
  const entryIds = [];
  for (const entry of entries) {
    if (!entry?.id) continue;
    entryIds.push(entry.id);
    for (const p of entry.postings ?? []) {
      if (!p?.accountId || !Number.isSafeInteger(p.amountCents)) continue;
      totalsByAccountId[p.accountId] = (totalsByAccountId[p.accountId] ?? 0) + p.amountCents;
    }
  }
  entryIds.sort();
  return { entryIds, totalsByAccountId };
}

function makeArtifactId({ artifactType, jobId, events, sourceEvent }) {
  const prefix =
    artifactType === ARTIFACT_TYPE.WORK_CERTIFICATE_V1
      ? "cert"
      : artifactType === ARTIFACT_TYPE.PROOF_RECEIPT_V1
        ? "proof"
      : artifactType === ARTIFACT_TYPE.COVERAGE_CERTIFICATE_V1
        ? "coverage"
      : artifactType === ARTIFACT_TYPE.INCIDENT_PACKET_V1
        ? "incident"
        : artifactType === ARTIFACT_TYPE.CREDIT_MEMO_V1
          ? "credit"
        : artifactType === ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1
            ? "settlement"
            : "artifact";

  // Artifact IDs must be stable even if new non-business events are appended later.
  // Prefer the triggering source event id, falling back to the head chain hash.
  const stableSuffix =
    typeof sourceEvent?.id === "string" && sourceEvent.id.trim() !== ""
      ? sourceEvent.id
      : typeof sourceEvent?.chainHash === "string" && sourceEvent.chainHash.trim() !== ""
        ? sourceEvent.chainHash
        : Array.isArray(events) && events.length
          ? events[events.length - 1].chainHash
          : "unknown";

  if (artifactType === ARTIFACT_TYPE.CREDIT_MEMO_V1) {
    const creditId = sourceEvent?.payload?.creditId ?? null;
    if (typeof creditId === "string" && creditId.trim() !== "") return `${prefix}_${jobId}_${creditId}`;
  }
  return `${prefix}_${jobId}_${stableSuffix}`;
}

function artifactPriority(artifactType) {
  if (artifactType === ARTIFACT_TYPE.WORK_CERTIFICATE_V1) return 10;
  if (artifactType === ARTIFACT_TYPE.PROOF_RECEIPT_V1) return 12;
  if (artifactType === ARTIFACT_TYPE.COVERAGE_CERTIFICATE_V1) return 15;
  if (artifactType === ARTIFACT_TYPE.INCIDENT_PACKET_V1) return 20;
  if (artifactType === ARTIFACT_TYPE.CREDIT_MEMO_V1) return 30;
  if (artifactType === ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1) return 40;
  return 100;
}

export function deriveArtifactEnqueuesFromJobEvents({ tenantId, jobId, events }) {
  tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(jobId, "jobId");
  if (!Array.isArray(events)) throw new TypeError("events must be an array");

  const triggerMap = new Map([
    ["SETTLED", [ARTIFACT_TYPE.WORK_CERTIFICATE_V1, ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1]],
    ["BOOKED", [ARTIFACT_TYPE.COVERAGE_CERTIFICATE_V1]],
    // If proof is evaluated after settlement (race), regenerate artifacts at the proof anchor
    // so downstream consumers see the acceptance status.
    ["PROOF_EVALUATED", [ARTIFACT_TYPE.PROOF_RECEIPT_V1, ARTIFACT_TYPE.WORK_CERTIFICATE_V1, ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1]],
    ["INCIDENT_REPORTED", [ARTIFACT_TYPE.INCIDENT_PACKET_V1]],
    ["INCIDENT_DETECTED", [ARTIFACT_TYPE.INCIDENT_PACKET_V1]],
    ["CLAIM_OPENED", [ARTIFACT_TYPE.INCIDENT_PACKET_V1]],
    ["CLAIM_TRIAGED", [ARTIFACT_TYPE.INCIDENT_PACKET_V1]],
    ["CLAIM_APPROVED", [ARTIFACT_TYPE.INCIDENT_PACKET_V1, ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1]],
    ["CLAIM_DENIED", [ARTIFACT_TYPE.INCIDENT_PACKET_V1]],
    ["CLAIM_PAID", [ARTIFACT_TYPE.INCIDENT_PACKET_V1, ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1]],
    ["JOB_ADJUSTED", [ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1]],
    ["SLA_CREDIT_ISSUED", [ARTIFACT_TYPE.CREDIT_MEMO_V1, ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1]]
  ]);

  const outbox = [];
  for (const e of events) {
    const artifactTypes = triggerMap.get(e?.type) ?? null;
    if (!artifactTypes || artifactTypes.length === 0) continue;
    if (e.type === "BOOKED") {
      const coveragePolicy = e?.payload?.policySnapshot?.coveragePolicy ?? null;
      const required = coveragePolicy?.required === true;
      const tierId = typeof coveragePolicy?.coverageTierId === "string" ? coveragePolicy.coverageTierId.trim() : "";
      const feeCents = coveragePolicy?.feeCentsPerJob ?? 0;
      const hasFee = Number.isSafeInteger(feeCents) && feeCents > 0;
      if (!required && !hasFee && !tierId) continue;
    }
    if (!e?.id || !e?.chainHash) continue;

    // CoverageCertificate should ideally include the booking-time risk score if it was appended in the same batch.
    let sourceChainHash = e.chainHash;
    if (e.type === "BOOKED") {
      const bookingEventId = e.id;
      const risk = events.find((x) => x?.type === "RISK_SCORED" && x?.payload?.sourceEventId === bookingEventId && x?.chainHash);
      if (risk?.chainHash) sourceChainHash = risk.chainHash;
    }

    outbox.push({
      type: "ARTIFACT_ENQUEUE",
      tenantId,
      jobId,
      sourceEventId: e.id,
      sourceEventType: e.type,
      sourceChainHash,
      sourceAt: e.at ?? null,
      artifactTypes
    });
  }

  // Dedupe (jobId + sourceEventId + artifactType).
  const seen = new Set();
  const deduped = [];
  for (const msg of outbox) {
    for (const t of msg.artifactTypes ?? []) {
      const key = `${tenantId}\n${jobId}\n${msg.sourceEventId}\n${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...msg, artifactTypes: [t] });
    }
  }
  return deduped;
}

export function createArtifactWorker({ store, nowIso, getJobEvents, listDestinationsForTenant }) {
  if (!store) throw new TypeError("store is required");
  if (typeof nowIso !== "function") throw new TypeError("nowIso is required");
  if (typeof getJobEvents !== "function") throw new TypeError("getJobEvents is required");
  if (typeof listDestinationsForTenant !== "function") throw new TypeError("listDestinationsForTenant is required");

  const artifactWorkerConcurrency = Math.min(50, parsePositiveIntEnv("PROXY_WORKER_CONCURRENCY_ARTIFACTS", 1));

  async function runGroupsWithConcurrency({ groups, maxConcurrency, handler }) {
    const inFlight = new Set();
    for (const group of groups) {
      const p = (async () => handler(group))().finally(() => inFlight.delete(p));
      inFlight.add(p);
      if (inFlight.size >= maxConcurrency) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
  }

  async function buildAndPersistArtifacts({
    tenantId,
    jobId,
    sourceEventId,
    sourceEventType = null,
    sourceChainHash,
    artifactType,
    requestId = null
  }) {
    const allEvents = getJobEvents(tenantId, jobId);
    if (!allEvents.length) return null;

    const sliced = sourceChainHash ? sliceEventsThroughChainHash(allEvents, sourceChainHash) : allEvents;
    const job = reduceJob(sliced);
    if (!job) return null;

    const sourceEvent = sliced.find((e) => e?.id === sourceEventId) ?? null;
    const effectiveSourceEventType = sourceEvent?.type ?? sourceEventType ?? null;
    const effectiveSourceEventChainHash = sourceChainHash ?? (typeof sourceEvent?.chainHash === "string" ? sourceEvent.chainHash : null);
    const artifactId = makeArtifactId({ artifactType, jobId, events: sliced, sourceEvent });

    // Idempotency: if we already persisted this artifactId, reuse it (generatedAt is part of the artifactHash).
    const existing = await store.getArtifact({ tenantId, artifactId });
    if (existing) {
      if (existing.artifactId && String(existing.artifactId) !== String(artifactId)) {
        throw new Error("artifactId lookup returned a different artifactId");
      }
      if (existing.artifactType && String(existing.artifactType) !== String(artifactType)) {
        throw new Error("artifactId already exists with a different artifactType");
      }
      if (!existing.artifactHash) throw new Error("existing artifact is missing artifactHash");
      if (sourceChainHash && existing.atChainHash && String(existing.atChainHash) !== String(sourceChainHash)) {
        throw new Error("artifactId already exists with a different atChainHash");
      }

      const destinations = listDestinationsForTenant(tenantId).filter((d) => {
        const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
        return !allowed || allowed.includes(artifactType);
      });

      for (const dest of destinations) {
        const dedupeKey = `${tenantId}:${dest.destinationId}:${artifactType}:${existing.artifactId ?? artifactId}:${existing.artifactHash}`;
        const scopeKey = String(jobId);
        const orderSeq = Number.isSafeInteger(existing.jobVersion) ? existing.jobVersion : 0;
        const priority = artifactPriority(artifactType);
        const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${existing.artifactId ?? artifactId}`;
        await store.createDelivery({
          tenantId,
          delivery: {
            destinationId: dest.destinationId,
            artifactType,
            artifactId: existing.artifactId ?? artifactId,
            artifactHash: existing.artifactHash,
            dedupeKey,
            scopeKey,
            orderSeq,
            priority,
            orderKey
          }
        });
      }

      logger.info("artifact.reuse", {
        tenantId,
        requestId,
        jobId,
        artifactType,
        artifactId: existing.artifactId ?? artifactId,
        artifactHash: existing.artifactHash,
        atChainHash: existing.atChainHash ?? null,
        deliveriesCreated: destinations.length
      });
      return { artifactId: existing.artifactId ?? artifactId, artifactType, deliveriesCreated: destinations.length };
    }

    const cfg = typeof store.getConfig === "function" ? store.getConfig(tenantId) : store.config;
    const requestedMax = cfg?.quotas?.maxArtifactsPerJobType ?? 0;
    const maxPerType = clampQuota({ tenantLimit: Number.isSafeInteger(requestedMax) ? requestedMax : 0, defaultLimit: 0, maxLimit: 0 });
    if (maxPerType > 0) {
      let existingCount = 0;
      try {
        const list = typeof store.listArtifacts === "function" ? await store.listArtifacts({ tenantId, jobId, limit: maxPerType, offset: 0 }) : [];
        for (const art of list ?? []) {
          if (!art || typeof art !== "object") continue;
          if (String(art.artifactType ?? art.schemaVersion ?? "") !== String(artifactType)) continue;
          existingCount += 1;
          if (existingCount >= maxPerType) break;
        }
      } catch {
        existingCount = 0;
      }
      if (isQuotaExceeded({ current: existingCount, limit: maxPerType })) {
        const err = new Error("tenant quota exceeded");
        err.code = "TENANT_QUOTA_EXCEEDED";
        err.quota = { kind: "artifacts_per_job_type", limit: maxPerType, current: existingCount };
        throw err;
      }
    }

    const generatedAt = nowIso();
    let body;
    if (artifactType === ARTIFACT_TYPE.WORK_CERTIFICATE_V1) {
      body = buildWorkCertificateV1({ tenantId, job, events: sliced, artifactId, generatedAt });
    } else if (artifactType === ARTIFACT_TYPE.PROOF_RECEIPT_V1) {
      body = buildProofReceiptV1({ tenantId, job, events: sliced, artifactId, generatedAt });
    } else if (artifactType === ARTIFACT_TYPE.COVERAGE_CERTIFICATE_V1) {
      body = buildCoverageCertificateV1({ tenantId, job, events: sliced, artifactId, generatedAt });
    } else if (artifactType === ARTIFACT_TYPE.INCIDENT_PACKET_V1) {
      body = buildIncidentPacketV1({ tenantId, job, events: sliced, artifactId, generatedAt });
    } else if (artifactType === ARTIFACT_TYPE.CREDIT_MEMO_V1) {
      body = buildCreditMemoV1({ tenantId, job, events: sliced, creditEvent: sourceEvent, artifactId, generatedAt });
    } else if (artifactType === ARTIFACT_TYPE.SETTLEMENT_STATEMENT_V1) {
      let operatorContractDoc = null;
      let splitPlanHash = null;
      if (job?.operatorContractHash && typeof store.getContractV2ByHash === "function") {
        try {
          const contract = await store.getContractV2ByHash({ tenantId, contractHash: job.operatorContractHash });
          operatorContractDoc = contract?.doc ?? null;
          if (operatorContractDoc?.connect?.enabled === true && operatorContractDoc?.connect?.splitPlan) {
            splitPlanHash = hashSplitPlanV1(operatorContractDoc.connect.splitPlan);
          }
        } catch {
          operatorContractDoc = null;
          splitPlanHash = null;
        }
      }

      const entries = computeJobLedgerEntries(sliced);
      const ledger = summarizeLedger(entries);

      const allocations = [];
      for (const entry of entries) {
        if (!entry?.id) continue;
        try {
          allocations.push(...allocateEntry({ tenantId, entry, job, operatorContractDoc, currency: "USD" }));
        } catch {
          // Ignore: allocations are best-effort and must not block statement generation.
        }
      }

      const rollupByParty = new Map(); // `${partyRole}\n${partyId}` -> rollup
      for (const a of allocations) {
        const partyRole = a.partyRole ?? null;
        const partyId = a.partyId ?? null;
        if (!partyRole || !partyId) continue;
        const key = `${partyRole}\n${partyId}`;
        const prev =
          rollupByParty.get(key) ??
          ({
            partyRole,
            partyId,
            feesCents: 0,
            payoutCents: 0,
            creditsCents: 0,
            netCents: 0,
            balanceDeltaCents: 0
          });

        const next = { ...prev, balanceDeltaCents: prev.balanceDeltaCents + (Number.isSafeInteger(a.amountCents) ? a.amountCents : 0) };
        const accountId = a.accountId ?? null;
        const amt = Number.isSafeInteger(a.amountCents) ? a.amountCents : 0;

        if (accountId === "acct_platform_revenue") next.feesCents += -amt;
        if (accountId === "acct_owner_payable" || accountId === "acct_operator_payable") next.payoutCents += -amt;
        if (accountId === "acct_customer_credits_payable") next.creditsCents += -amt;

        next.netCents = next.feesCents + next.payoutCents + next.creditsCents;
        rollupByParty.set(key, next);
      }

      const partyRollups = Array.from(rollupByParty.values()).sort(
        (a, b) => String(a.partyRole ?? "").localeCompare(String(b.partyRole ?? "")) || String(a.partyId ?? "").localeCompare(String(b.partyId ?? ""))
      );

      const settlement = {
        currency: "USD",
        quoteAmountCents: Number.isSafeInteger(job.quote?.amountCents) ? job.quote.amountCents : 0,
        operatorCostCents: (job.operatorCosts ?? []).reduce((sum, c) => sum + (Number.isSafeInteger(c?.payload?.costCents) ? c.payload.costCents : 0), 0),
        slaCreditsCents: (job.slaCredits ?? []).reduce((sum, c) => sum + (Number.isSafeInteger(c?.payload?.amountCents) ? c.payload.amountCents : 0), 0),
        claimsPaidCents: (job.claims ?? [])
          .filter((c) => c?.status === "PAID")
          .reduce((sum, c) => sum + (Number.isSafeInteger(c?.paid?.amountCents) ? c.paid.amountCents : 0), 0),
        splitPlanHash,
        partyRollups,
        ledgerEntryIds: ledger.entryIds,
        totalsByAccountId: ledger.totalsByAccountId
      };
      body = buildSettlementStatementV1({ tenantId, job, events: sliced, settlement, artifactId, generatedAt });
    } else {
      return null;
    }

    const artifactCore = {
      ...body,
      sourceEventId,
      sourceEventType: effectiveSourceEventType,
      sourceEventChainHash: effectiveSourceEventChainHash,
      atChainHash: sourceChainHash ?? body?.eventProof?.lastChainHash ?? null
    };
    const artifactHash = computeArtifactHash(artifactCore);
    const artifact = { ...artifactCore, artifactHash };

    failpoint("artifact.after_build_before_persist");

    await store.putArtifact({ tenantId, artifact });

    failpoint("artifact.after_persist_before_enqueue");

    const destinations = listDestinationsForTenant(tenantId).filter((d) => {
      const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
      return !allowed || allowed.includes(artifactType);
    });

    for (const dest of destinations) {
      const dedupeKey = `${tenantId}:${dest.destinationId}:${artifactType}:${artifact.artifactId}:${artifact.artifactHash}`;
      const scopeKey = String(jobId);
      const orderSeq = Number.isSafeInteger(artifact.jobVersion) ? artifact.jobVersion : 0;
      const priority = artifactPriority(artifactType);
      const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${artifact.artifactId}`;
      await store.createDelivery({
        tenantId,
        delivery: {
          destinationId: dest.destinationId,
          artifactType,
          artifactId: artifact.artifactId,
          artifactHash: artifact.artifactHash,
          dedupeKey,
          scopeKey,
          orderSeq,
          priority,
          orderKey
        }
      });
    }

    try {
      store.metrics?.incCounter?.("artifacts_built_total", { type: artifactType }, 1);
    } catch {}
    logger.info("artifact.built", {
      tenantId,
      requestId,
      jobId,
      artifactType,
      artifactId: artifact.artifactId,
      artifactHash: artifact.artifactHash,
      atChainHash: artifact.atChainHash ?? null,
      deliveriesCreated: destinations.length
    });
    return { artifactId: artifact.artifactId, artifactType, deliveriesCreated: destinations.length };
  }

  async function tickArtifacts({ maxMessages = 100 } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new TypeError("maxMessages must be a positive safe integer");

    const processed = [];

    if (
      store.kind === "pg" &&
      typeof store.claimOutbox === "function" &&
      typeof store.markOutboxProcessed === "function" &&
      typeof store.markOutboxFailed === "function"
    ) {
      const claimed = await store.claimOutbox({ topic: "ARTIFACT_ENQUEUE", maxMessages, worker: "artifacts_v1" });
      const byJob = new Map();
      for (const row of claimed) {
        const msg = row?.message ?? null;
        const tenantId = normalizeTenantId(msg?.tenantId ?? DEFAULT_TENANT_ID);
        const jobId = msg?.jobId ? String(msg.jobId) : "";
        const key = `${tenantId}\n${jobId || "unknown"}`;
        const list = byJob.get(key) ?? [];
        list.push(row);
        byJob.set(key, list);
      }

      const groups = Array.from(byJob.values());
      await runGroupsWithConcurrency({
        groups,
        maxConcurrency: artifactWorkerConcurrency,
        handler: async (rows) => {
          for (const row of rows) {
            try {
              const msg = row.message ?? null;
              const tenantId = normalizeTenantId(msg?.tenantId ?? DEFAULT_TENANT_ID);
              const jobId = msg?.jobId;
              const artifactType = Array.isArray(msg?.artifactTypes) ? msg.artifactTypes[0] : null;
              assertNonEmptyString(jobId, "jobId");
              assertNonEmptyString(artifactType, "artifactType");

              const result = await buildAndPersistArtifacts({
                tenantId,
                jobId,
                sourceEventId: msg?.sourceEventId ?? null,
                sourceEventType: msg?.sourceEventType ?? null,
                sourceChainHash: msg?.sourceChainHash ?? null,
                artifactType,
                requestId: msg?.requestId ?? null
              });
              const lastError = result ? null : "skipped";
              await store.markOutboxProcessed({ ids: [row.id], lastError });
              if (result) processed.push({ outboxId: row.id, ...result });
            } catch (err) {
              const lastError = typeof err?.message === "string" && err.message.trim() ? err.message : String(err ?? "artifact build failed");
              try {
                store.metrics?.incCounter?.("artifact_build_fail_total", { type: String(row?.message?.artifactTypes?.[0] ?? "unknown") }, 1);
                store.metrics?.incCounter?.("outbox_fail_total", { kind: "ARTIFACT_ENQUEUE" }, 1);
              } catch {}
              logger.error("artifact.build.failed", {
                tenantId: normalizeTenantId(row?.message?.tenantId ?? DEFAULT_TENANT_ID),
                requestId: row?.message?.requestId ?? null,
                jobId: row?.message?.jobId ?? null,
                artifactType: Array.isArray(row?.message?.artifactTypes) ? row.message.artifactTypes[0] : null,
                outboxId: row.id,
                err
              });
              if (Number.isSafeInteger(row.attempts) && row.attempts >= outboxMaxAttempts) {
                await store.markOutboxProcessed({ ids: [row.id], lastError: `DLQ:${lastError}` });
              } else {
                await store.markOutboxFailed({ ids: [row.id], lastError });
              }
            }
          }
        }
      });
      return { processed };
    }

    // In-memory outbox scan.
    if (!Number.isSafeInteger(store.artifactCursor) || store.artifactCursor < 0) store.artifactCursor = 0;
	    while (store.artifactCursor < store.outbox.length && processed.length < maxMessages) {
	      const msg = store.outbox[store.artifactCursor];
	      store.artifactCursor += 1;
	      if (!msg || typeof msg !== "object") continue;
	      if (msg.type !== "ARTIFACT_ENQUEUE") continue;

      try {
	        const tenantId = normalizeTenantId(msg.tenantId ?? DEFAULT_TENANT_ID);
	        const jobId = msg.jobId;
	        const artifactTypes = Array.isArray(msg.artifactTypes) ? msg.artifactTypes : [];
		        for (const artifactType of artifactTypes) {
		          const result = await buildAndPersistArtifacts({
		            tenantId,
		            jobId,
		            sourceEventId: msg.sourceEventId ?? null,
		            sourceEventType: msg.sourceEventType ?? null,
		            sourceChainHash: msg.sourceChainHash ?? null,
		            artifactType,
		            requestId: msg.requestId ?? null
		          });
		          if (result) processed.push(result);
		        }
	      } catch {
	        // Ignore bad messages.
	      }
	    }

    return { processed, cursor: store.artifactCursor };
  }

  return { tickArtifacts };
}
