function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function deepRedact(value, { removeKeys }) {
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, { removeKeys }));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (removeKeys.has(k)) continue;
    out[k] = deepRedact(v, { removeKeys });
  }
  return out;
}

const COMMON_REMOVE_KEYS = new Set(["paymentHoldId"]);
const AUDIT_REMOVE_KEYS = new Set([...COMMON_REMOVE_KEYS, "credentialRef", "evidenceRef"]);
const EVIDENCE_REMOVE_KEYS = new Set([...COMMON_REMOVE_KEYS, "credentialRef"]);

export function buildAuditExport({ job, events }) {
  if (!job || typeof job !== "object") throw new TypeError("job is required");
  if (!Array.isArray(events)) throw new TypeError("events must be an array");

  const accessPlan = job.accessPlan ? deepRedact(job.accessPlan, { removeKeys: AUDIT_REMOVE_KEYS }) : null;
  const booking = job.booking ? deepRedact(job.booking, { removeKeys: AUDIT_REMOVE_KEYS }) : null;

  const timeline = events.map((e) => ({
    id: e?.id ?? null,
    at: e?.at ?? null,
    type: e?.type ?? null,
    actor: e?.actor ?? null,
    payload: e?.payload ? deepRedact(e.payload, { removeKeys: AUDIT_REMOVE_KEYS }) : null
  }));

  return {
    job: {
      id: job.id ?? null,
      templateId: job.templateId ?? null,
      status: job.status ?? null,
      zoneId: job.booking?.zoneId ?? job.constraints?.zoneId ?? null,
      environmentTier: job.booking?.environmentTier ?? null,
      booking,
      cancellation: job.cancellation ? deepRedact(job.cancellation, { removeKeys: AUDIT_REMOVE_KEYS }) : null,
      match: job.match ?? null,
      reservation: job.reservation ?? null,
      operatorCoverage: job.operatorCoverage ?? null,
      assist: job.assist ?? null,
      accessPlan,
      access: job.access ?? null,
      execution: job.execution ?? null,
      operatorCosts: job.operatorCosts ?? [],
      slaBreaches: job.slaBreaches ?? [],
      slaCredits: job.slaCredits ?? [],
      incidents: job.incidents ?? [],
      claims: job.claims ?? [],
      lastEventId: job.lastEventId ?? null,
      lastChainHash: job.lastChainHash ?? null
    },
    timeline
  };
}

export function buildEvidenceExport({ job }) {
  if (!job || typeof job !== "object") throw new TypeError("job is required");
  const evidence = Array.isArray(job.evidence) ? job.evidence.map((e) => deepRedact(e, { removeKeys: EVIDENCE_REMOVE_KEYS })) : [];
  return { jobId: job.id ?? null, evidence };
}

