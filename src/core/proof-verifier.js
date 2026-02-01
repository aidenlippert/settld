import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";
import { canonicalizeMissingEvidenceList, MISSING_EVIDENCE, PROOF_REASON_CODE, PROOF_STATUS } from "./proof.js";
import { validateZoneSetV1 } from "./zoneset.js";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function safeIsoToMs(value) {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

function sliceThroughChainHash(events, atChainHash) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  assertNonEmptyString(atChainHash, "atChainHash");
  const idx = events.findIndex((e) => e?.chainHash === atChainHash);
  if (idx === -1) throw new TypeError("evaluatedAtChainHash not found in stream");
  return events.slice(0, idx + 1);
}

function latestCoverageByZone(events) {
  const byZoneId = new Map();
  for (const e of events) {
    if (e?.type !== "ZONE_COVERAGE_REPORTED") continue;
    const p = e.payload ?? null;
    const zoneId = typeof p?.zoneId === "string" ? p.zoneId.trim() : "";
    if (!zoneId) continue;
    const endMs = safeIsoToMs(p?.window?.endAt);
    const key = zoneId;
    const prev = byZoneId.get(key) ?? null;
    const prevEndMs = prev ? safeIsoToMs(prev?.payload?.window?.endAt) : NaN;
    if (!prev) {
      byZoneId.set(key, e);
      continue;
    }
    // Prefer higher endAt, tie-break by event id to ensure deterministic selection.
    if (Number.isFinite(endMs) && (!Number.isFinite(prevEndMs) || endMs > prevEndMs)) {
      byZoneId.set(key, e);
      continue;
    }
    if (endMs === prevEndMs) {
      const prevId = String(prev?.id ?? "");
      const nextId = String(e?.id ?? "");
      if (nextId && (!prevId || nextId > prevId)) byZoneId.set(key, e);
    }
  }
  return byZoneId;
}

function excusedZonesFromIncidents(events, { excuseIncidentTypes }) {
  const excuseTypes = new Set(Array.isArray(excuseIncidentTypes) ? excuseIncidentTypes.map((t) => String(t)) : []);
  const excused = new Set();
  const triggeredFacts = [];
  for (const e of events) {
    if (e?.type !== "INCIDENT_REPORTED" && e?.type !== "INCIDENT_DETECTED") continue;
    const p = e.payload ?? null;
    const type = typeof p?.type === "string" ? p.type : null;
    if (!type || !excuseTypes.has(type)) continue;
    const zoneId = typeof p?.zoneId === "string" ? p.zoneId.trim() : "";
    if (!zoneId) continue;
    excused.add(zoneId);
    triggeredFacts.push({ eventId: e.id ?? null, type: e.type, zoneId });
  }
  return { excused, triggeredFacts };
}

function missingEvidenceDetailFromZoneId(zoneId) {
  const raw = typeof zoneId === "string" ? zoneId : String(zoneId ?? "");
  const base = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const hash8 = sha256Hex(raw).slice(0, 8);
  const prefix = base ? base.slice(0, 32) : "zone";
  const detail = `${prefix}_${hash8}`.slice(0, 48);
  return detail || `zone_${hash8}`;
}

export function verifyZoneCoverageProofV1({
  job,
  events,
  evaluatedAtChainHash,
  customerPolicyHash,
  operatorPolicyHash
} = {}) {
  assertPlainObject(job, "job");
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  assertNonEmptyString(evaluatedAtChainHash, "evaluatedAtChainHash");

  // Ensure anchor exists (even though we may incorporate evidence appended after completion).
  // This makes "what are we proving?" stable while allowing late evidence to update the proof result.
  sliceThroughChainHash(events, evaluatedAtChainHash);

  const requiredZones = job?.booking?.requiredZones ?? null;
  const requiredZonesHash = job?.booking?.requiredZonesHash ?? null;

  const proofPolicy = job?.booking?.policySnapshot?.proofPolicy ?? job?.booking?.policySnapshot?.proof ?? null;
  const zc = proofPolicy?.zoneCoverage ?? {};
  const thresholdPct = Number.isSafeInteger(zc?.thresholdPct) ? zc.thresholdPct : 95;
  const excuseIncidentTypes = Array.isArray(zc?.excuseIncidentTypes) ? zc.excuseIncidentTypes : ["BLOCKED_ZONE"];

  if (!requiredZones || typeof requiredZones !== "object") {
    const missingEvidence = canonicalizeMissingEvidenceList([MISSING_EVIDENCE.REQUIRED_ZONES]);
    const factsHash = sha256Hex(
      canonicalJsonStringify(
        normalizeForCanonicalJson(
          {
            schemaVersion: "ZoneCoverageFacts.v1",
            evaluatedAtChainHash,
            requiredZonesHash: requiredZonesHash ?? null,
            thresholdPct,
            requiredZoneIds: [],
            coverageByZone: [],
            excusedZones: [],
              excuseIncidentTypes: Array.from(new Set(excuseIncidentTypes.map((t) => String(t)))).sort()
          },
          { path: "$" }
        )
      )
    );
    return {
      schemaVersion: "ProofResult.v1",
      status: PROOF_STATUS.INSUFFICIENT_EVIDENCE,
      reasonCodes: [PROOF_REASON_CODE.REQUIRED_ZONES_MISSING],
      missingEvidence,
      triggeredFacts: [],
      metrics: { requiredZones: 0, reportedZones: 0, excusedZones: 0, belowThresholdZones: 0, minCoveragePct: null },
      factsHash,
      anchors: { evaluatedAtChainHash, customerPolicyHash: customerPolicyHash ?? null, operatorPolicyHash: operatorPolicyHash ?? null, requiredZonesHash: requiredZonesHash ?? null }
    };
  }

  validateZoneSetV1(requiredZones);
  const requiredZoneIds = requiredZones.zones.map((z) => String(z.zoneId));

  // NOTE: Evidence may arrive after completion. We incorporate all evidence events in the stream,
  // while still anchoring the proof to a specific completion chainHash.
  const coverageByZone = latestCoverageByZone(events);
  const excuseInfo = excusedZonesFromIncidents(events, { excuseIncidentTypes });

  let minCoveragePct = null;
  let belowThresholdZones = 0;
  let missingZones = 0;
  let excusedZones = 0;
  const missingZoneIds = [];

  const reasonCodes = new Set();
  const triggeredFacts = [];

  for (const z of requiredZoneIds) {
    const excused = excuseInfo.excused.has(z);
    const coverageEvent = coverageByZone.get(z) ?? null;

    if (!coverageEvent) {
      if (excused) {
        excusedZones += 1;
        reasonCodes.add(PROOF_REASON_CODE.ZONE_EXCUSED_BY_INCIDENT);
        continue;
      }
      missingZones += 1;
      missingZoneIds.push(z);
      reasonCodes.add(PROOF_REASON_CODE.MISSING_ZONE_COVERAGE);
      continue;
    }

    triggeredFacts.push({ eventId: coverageEvent.id ?? null, type: coverageEvent.type, zoneId: z });
    const pct = Number.isSafeInteger(coverageEvent.payload?.coveragePct) ? coverageEvent.payload.coveragePct : null;
    if (Number.isSafeInteger(pct)) {
      if (minCoveragePct === null || pct < minCoveragePct) minCoveragePct = pct;
      if (!excused && pct < thresholdPct) {
        belowThresholdZones += 1;
        reasonCodes.add(PROOF_REASON_CODE.ZONE_BELOW_THRESHOLD);
      }
    }
  }

  // Decide overall status with strict precedence:
  // FAIL > INSUFFICIENT_EVIDENCE > PASS
  let status = PROOF_STATUS.PASS;
  if (belowThresholdZones > 0) status = PROOF_STATUS.FAIL;
  else if (missingZones > 0) status = PROOF_STATUS.INSUFFICIENT_EVIDENCE;

  const missingEvidence = [];
  if (missingZones > 0) {
    missingEvidence.push(MISSING_EVIDENCE.ZONE_COVERAGE);
    for (const z of missingZoneIds) {
      missingEvidence.push(`${MISSING_EVIDENCE.ZONE_COVERAGE}:${missingEvidenceDetailFromZoneId(z)}`);
    }
  }

  for (const f of excuseInfo.triggeredFacts) triggeredFacts.push(f);

  // Deterministic ordering for audit friendliness.
  triggeredFacts.sort((a, b) => {
    const at = String(a?.type ?? "");
    const bt = String(b?.type ?? "");
    if (at !== bt) return at < bt ? -1 : 1;
    const az = String(a?.zoneId ?? "");
    const bz = String(b?.zoneId ?? "");
    if (az !== bz) return az < bz ? -1 : 1;
    const ae = String(a?.eventId ?? "");
    const be = String(b?.eventId ?? "");
    if (ae !== be) return ae < be ? -1 : 1;
    return 0;
  });

  const metrics = {
    requiredZones: requiredZoneIds.length,
    reportedZones: Array.from(new Set(requiredZoneIds.filter((z) => coverageByZone.has(z)))).length,
    excusedZones,
    belowThresholdZones,
    minCoveragePct
  };

  const facts = normalizeForCanonicalJson(
    {
      schemaVersion: "ZoneCoverageFacts.v1",
      evaluatedAtChainHash,
      requiredZonesHash: requiredZonesHash ?? null,
      thresholdPct,
      requiredZoneIds: Array.from(new Set(requiredZoneIds)).sort(),
      coverageByZone: Array.from(coverageByZone.entries())
        .filter(([zoneId]) => requiredZoneIds.includes(zoneId))
        .map(([zoneId, ev]) => ({
          zoneId,
          coveragePct: Number.isSafeInteger(ev?.payload?.coveragePct) ? ev.payload.coveragePct : null,
          window: ev?.payload?.window ?? null,
          eventId: ev?.id ?? null,
          chainHash: ev?.chainHash ?? null,
          at: ev?.at ?? null
        }))
        .sort((a, b) => String(a.zoneId).localeCompare(String(b.zoneId)) || String(a.eventId ?? "").localeCompare(String(b.eventId ?? ""))),
      excusedZones: Array.from(excuseInfo.excused.values()).sort(),
      excuseIncidentTypes: Array.from(new Set(excuseIncidentTypes.map((t) => String(t)))).sort()
    },
    { path: "$" }
  );
  const factsHash = sha256Hex(canonicalJsonStringify(facts));

  return {
    schemaVersion: "ProofResult.v1",
    status,
    reasonCodes: Array.from(reasonCodes.values()).sort(),
    missingEvidence: canonicalizeMissingEvidenceList(missingEvidence),
    triggeredFacts,
    metrics,
    factsHash,
    anchors: {
      evaluatedAtChainHash,
      customerPolicyHash: customerPolicyHash ?? null,
      operatorPolicyHash: operatorPolicyHash ?? null,
      requiredZonesHash: requiredZonesHash ?? null
    }
  };
}
