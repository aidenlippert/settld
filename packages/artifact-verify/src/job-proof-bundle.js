import fs from "node:fs/promises";
import path from "node:path";

import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256HexBytes, sha256HexUtf8, verifyHashHexEd25519 } from "./crypto.js";
import { validateVerificationWarnings } from "./verification-warnings.js";

export const PROOF_BUNDLE_MANIFEST_SCHEMA_V1 = "ProofBundleManifest.v1";
export const BUNDLE_HEAD_ATTESTATION_SCHEMA_V1 = "BundleHeadAttestation.v1";
export const MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1 = "MonthProofBundle.v1";
export const JOB_PROOF_BUNDLE_SCHEMA_VERSION_V1 = "JobProofBundle.v1";

async function readJson(filepath) {
  const raw = await fs.readFile(filepath, "utf8");
  return JSON.parse(raw);
}

async function readBytes(filepath) {
  return new Uint8Array(await fs.readFile(filepath));
}

// Optional governance streams (used to derive server key lifecycle timelines).
// Prefer the dual-scope layout:
//   governance/global/*
//   governance/tenant/*
// Fall back to legacy single-scope layout:
//   governance/*
async function tryReadGovernance({ dir, base }) {
  let e = null;
  let m = null;
  let s = null;
  let eventsPresent = false;
  let materialPresent = false;
  let snapshotPresent = false;
  try {
    e = parseJsonl(await fs.readFile(path.join(dir, base, "events", "events.jsonl"), "utf8"));
    eventsPresent = true;
  } catch {
    e = null;
  }
  try {
    m = parseJsonl(await fs.readFile(path.join(dir, base, "events", "payload_material.jsonl"), "utf8"));
    materialPresent = true;
  } catch {
    m = null;
  }
  try {
    s = await readJson(path.join(dir, base, "snapshot.json"));
    snapshotPresent = true;
  } catch {
    s = null;
  }
  if (e === null && m === null && s === null) return null;
  return {
    events: e ?? [],
    payloadMaterial: m ?? [],
    snapshot: s ?? null,
    present: { events: eventsPresent, payloadMaterial: materialPresent, snapshot: snapshotPresent },
    base
  };
}

function stripManifestHash(manifestWithHash) {
  const { manifestHash: _ignored, ...rest } = manifestWithHash ?? {};
  return rest;
}

function stripAttestationSig(attestation) {
  const { signature: _sig, attestationHash: _hash, ...rest } = attestation ?? {};
  return rest;
}

function stripVerificationReportSig(report) {
  const { reportHash: _h, signature: _sig, signerKeyId: _kid, signedAt: _signedAt, ...rest } = report ?? {};
  return rest;
}

function verifyVerificationReportV1ForProofBundle({
  report,
  expectedManifestHash,
  expectedBundleType,
  expectedBundleHeadAttestationHash,
  publicKeyByKeyId,
  keyMetaByKeyId,
  strict
}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return { ok: false, error: "invalid verification report JSON" };
  if (String(report.schemaVersion ?? "") !== "VerificationReport.v1") return { ok: false, error: "unsupported verification report schemaVersion" };
  if (String(report.profile ?? "") !== "strict") return { ok: false, error: "unsupported verification report profile", profile: report.profile ?? null };

  const warningsCheck = validateVerificationWarnings(report.warnings ?? null);
  if (!warningsCheck.ok) return { ok: false, error: `verification report warnings invalid: ${warningsCheck.error}`, detail: warningsCheck };

  const subject = report.subject ?? null;
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return { ok: false, error: "invalid verification report subject" };
  if (String(subject.type ?? "") !== String(expectedBundleType ?? "")) {
    return { ok: false, error: "verification report subject.type mismatch", expected: expectedBundleType ?? null, actual: subject.type ?? null };
  }
  if (String(subject.manifestHash ?? "") !== String(expectedManifestHash ?? "")) {
    return { ok: false, error: "verification report subject.manifestHash mismatch", expected: expectedManifestHash ?? null, actual: subject.manifestHash ?? null };
  }

  if (strict) {
    const b = report.bundleHeadAttestation ?? null;
    if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "verification report missing bundleHeadAttestation" };
    const declared = typeof b.attestationHash === "string" && b.attestationHash.trim() ? b.attestationHash : null;
    if (!declared) return { ok: false, error: "verification report bundleHeadAttestation.attestationHash missing" };
    if (typeof expectedBundleHeadAttestationHash === "string" && expectedBundleHeadAttestationHash.trim() && declared !== expectedBundleHeadAttestationHash) {
      return { ok: false, error: "verification report bundleHeadAttestation.attestationHash mismatch", expected: expectedBundleHeadAttestationHash, actual: declared };
    }
  }

  const expectedReportHash = sha256HexUtf8(canonicalJsonStringify(stripVerificationReportSig(report)));
  const actualReportHash = typeof report.reportHash === "string" ? report.reportHash : null;
  if (!actualReportHash) return { ok: false, error: "verification report missing reportHash" };
  if (expectedReportHash !== actualReportHash) return { ok: false, error: "verification report reportHash mismatch", expected: expectedReportHash, actual: actualReportHash };

  const signature = typeof report.signature === "string" && report.signature.trim() ? report.signature : null;
  const signerKeyId = typeof report.signerKeyId === "string" && report.signerKeyId.trim() ? report.signerKeyId : null;
  const signedAt = typeof report.signedAt === "string" && report.signedAt.trim() ? report.signedAt : null;
  if (strict && (!signature || !signerKeyId || !signedAt)) {
    return { ok: false, error: "verification report missing signature", signature: Boolean(signature), signerKeyId, signedAt };
  }

  const signer = report.signer ?? null;
  if (signer !== null && signer !== undefined) {
    if (!signer || typeof signer !== "object" || Array.isArray(signer)) return { ok: false, error: "verification report signer must be an object" };
    if (typeof signer.keyId !== "string" || !signer.keyId.trim()) return { ok: false, error: "verification report signer.keyId missing" };
    if (signerKeyId && signer.keyId !== signerKeyId) return { ok: false, error: "verification report signer.keyId mismatch", expected: signerKeyId, actual: signer.keyId };
    const scope = signer.scope ?? null;
    if (scope !== null && scope !== "global" && scope !== "tenant") return { ok: false, error: "verification report signer.scope invalid", scope };
  }

  if (signature && signerKeyId) {
    if (!(publicKeyByKeyId instanceof Map)) return { ok: false, error: "publicKeyByKeyId must be a Map" };
    const publicKeyPem = publicKeyByKeyId.get(signerKeyId) ?? null;
    if (!publicKeyPem) return { ok: false, error: "unknown verification report signerKeyId", signerKeyId };
    const okSig = verifyHashHexEd25519({ hashHex: expectedReportHash, signatureBase64: signature, publicKeyPem });
    if (!okSig) return { ok: false, error: "verification report signature invalid", signerKeyId };

    if (strict) {
      const meta = (keyMetaByKeyId instanceof Map ? keyMetaByKeyId.get(signerKeyId) ?? null : null) ?? null;
      const governed = Boolean(meta && typeof meta === "object" && meta.serverGoverned === true);
      if (!governed) return { ok: false, error: "verification report signer key not governed", signerKeyId };
      if (!(typeof meta?.validFrom === "string" && meta.validFrom.trim())) return { ok: false, error: "verification report signer key missing validFrom", signerKeyId };
      const usable = isServerKeyUsableAtForAttestation({ meta, atIso: signedAt });
      if (!usable.ok) return { ok: false, error: "verification report signer key not valid", signerKeyId, reason: usable.reason, boundary: usable.boundary ?? null };
    }
  }

  return { ok: true };
}

function parseJsonl(text) {
  const out = [];
  const lines = String(text ?? "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed));
  }
  return out;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}

function arrayEqual(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i += 1) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

function safeIsoToMs(value) {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

export const EVENT_ENVELOPE_VERSION = 1;

export const SIGNER_KIND = Object.freeze({
  SERVER: "server",
  ROBOT: "robot",
  OPERATOR: "operator",
  ROBOT_OR_OPERATOR: "robot_or_operator",
  SERVER_OR_OPERATOR: "server_or_operator",
  SERVER_OR_ROBOT: "server_or_robot",
  NONE: "none"
});

// Keep in sync with src/core/event-policy.js for "must be signed" semantics.
const ROBOT_SIGNED_TYPES = new Set([
  "TELEMETRY_HEARTBEAT",
  "CHECKPOINT_REACHED",
  "EN_ROUTE",
  "ASSIST_REQUESTED",
  "EXECUTION_STARTED",
  "JOB_EXECUTION_STARTED",
  "JOB_HEARTBEAT",
  "EXECUTION_COMPLETED",
  "JOB_EXECUTION_COMPLETED",
  "EXECUTION_ABORTED",
  "INCIDENT_DETECTED",
  "SKILL_METER_REPORTED",
  "ROBOT_HEARTBEAT"
]);

const OPERATOR_SIGNED_TYPES = new Set(["ASSIST_STARTED", "ASSIST_ENDED", "ASSIST_ACCEPTED", "ASSIST_DECLINED", "OPERATOR_SHIFT_OPENED", "OPERATOR_SHIFT_CLOSED"]);

const ROBOT_OR_OPERATOR_SIGNED_TYPES = new Set(["ACCESS_GRANTED", "ACCESS_DENIED", "SKILL_USED", "ZONE_COVERAGE_REPORTED"]);

const SERVER_OR_OPERATOR_SIGNED_TYPES = new Set(["INCIDENT_REPORTED", "CLAIM_TRIAGED"]);

const SERVER_OR_ROBOT_SIGNED_TYPES = new Set(["EVIDENCE_CAPTURED", "JOB_EXECUTION_ABORTED", "JOB_EXECUTION_RESUMED", "ROBOT_UNHEALTHY"]);

const SERVER_SIGNED_TYPES = new Set([
  "JOB_CREATED",
  "QUOTE_PROPOSED",
  "RISK_SCORED",
  "BOOKED",
  "DISPATCH_REQUESTED",
  "DISPATCH_EVALUATED",
  "DISPATCH_CONFIRMED",
  "DISPATCH_FAILED",
  "OPERATOR_COVERAGE_RESERVED",
  "OPERATOR_COVERAGE_RELEASED",
  "ASSIST_QUEUED",
  "ASSIST_ASSIGNED",
  "ASSIST_TIMEOUT",
  "MATCHED",
  "RESERVED",
  "SETTLED",
  "JOB_EXECUTION_STALLED",
  "JOB_RESCHEDULED",
  "JOB_CANCELLED",
  "ACCESS_PLAN_ISSUED",
  "ACCESS_REVOKED",
  "ACCESS_EXPIRED",
  "SKILL_LICENSED",
  "CLAIM_OPENED",
  "CLAIM_APPROVED",
  "CLAIM_DENIED",
  "CLAIM_PAID",
  "JOB_ADJUSTED",
  "ROBOT_REGISTERED",
  "ROBOT_AVAILABILITY_SET",
  "ROBOT_QUARANTINED",
  "ROBOT_QUARANTINE_CLEARED",
  "MAINTENANCE_REQUESTED",
  "MAINTENANCE_COMPLETED",
  "ROBOT_STATUS_CHANGED",
  "OPERATOR_REGISTERED",
  "OPERATOR_COST_RECORDED",
  "SLA_BREACH_DETECTED",
  "SLA_CREDIT_ISSUED",
  "PROOF_EVALUATED",
  "PROOF_OVERRIDDEN",
  "SETTLEMENT_HELD",
  "SETTLEMENT_RELEASED",
  "SETTLEMENT_FORFEITED",
  "DISPUTE_OPENED",
  "DISPUTE_CLOSED",
  "EVIDENCE_VIEWED",
  "EVIDENCE_EXPIRED",
  "CORRELATION_LINKED",
  "CORRELATION_RELINKED",
  "MONTH_CLOSE_REQUESTED",
  "MONTH_CLOSED",
  "MONTH_CLOSE_REOPENED",
  "INSURER_REIMBURSEMENT_RECORDED",
  "DECISION_RECORDED"
]);

function requiredSignerKindForEventType(eventType) {
  if (ROBOT_SIGNED_TYPES.has(eventType)) return SIGNER_KIND.ROBOT;
  if (OPERATOR_SIGNED_TYPES.has(eventType)) return SIGNER_KIND.OPERATOR;
  if (ROBOT_OR_OPERATOR_SIGNED_TYPES.has(eventType)) return SIGNER_KIND.ROBOT_OR_OPERATOR;
  if (SERVER_OR_OPERATOR_SIGNED_TYPES.has(eventType)) return SIGNER_KIND.SERVER_OR_OPERATOR;
  if (SERVER_OR_ROBOT_SIGNED_TYPES.has(eventType)) return SIGNER_KIND.SERVER_OR_ROBOT;
  if (SERVER_SIGNED_TYPES.has(eventType)) return SIGNER_KIND.SERVER;
  return SIGNER_KIND.NONE;
}

function findLatestBookedPayload(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== "BOOKED") continue;
    const p = e?.payload ?? null;
    if (p && typeof p === "object" && !Array.isArray(p)) return p;
  }
  return null;
}

function sliceThroughChainHash(events, chainHash) {
  assertNonEmptyString(chainHash, "evaluatedAtChainHash");
  const idx = events.findIndex((e) => e?.chainHash === chainHash);
  if (idx === -1) throw new Error("evaluatedAtChainHash not found in stream");
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
    const prev = byZoneId.get(zoneId) ?? null;
    const prevEndMs = prev ? safeIsoToMs(prev?.payload?.window?.endAt) : NaN;
    if (!prev) {
      byZoneId.set(zoneId, e);
      continue;
    }
    if (Number.isFinite(endMs) && (!Number.isFinite(prevEndMs) || endMs > prevEndMs)) {
      byZoneId.set(zoneId, e);
      continue;
    }
    if (endMs === prevEndMs) {
      const prevId = String(prev?.id ?? "");
      const nextId = String(e?.id ?? "");
      if (nextId && (!prevId || nextId > prevId)) byZoneId.set(zoneId, e);
    }
  }
  return byZoneId;
}

function excusedZonesFromIncidents(events, { excuseIncidentTypes }) {
  const excuseTypes = new Set(Array.isArray(excuseIncidentTypes) ? excuseIncidentTypes.map((t) => String(t)) : []);
  const excused = new Set();
  for (const e of events) {
    if (e?.type !== "INCIDENT_REPORTED" && e?.type !== "INCIDENT_DETECTED") continue;
    const p = e.payload ?? null;
    const type = typeof p?.type === "string" ? p.type : null;
    if (!type || !excuseTypes.has(type)) continue;
    const zoneId = typeof p?.zoneId === "string" ? p.zoneId.trim() : "";
    if (!zoneId) continue;
    excused.add(zoneId);
  }
  return excused;
}

function computeZoneCoverageFactsHashV1({ events, evaluatedAtChainHash }) {
  if (!Array.isArray(events)) throw new Error("events must be an array");
  assertNonEmptyString(evaluatedAtChainHash, "evaluatedAtChainHash");

  // Anchor must exist, but evidence can arrive after completion within the same history prefix.
  const anchorSlice = sliceThroughChainHash(events, evaluatedAtChainHash);

  const booked = findLatestBookedPayload(anchorSlice);
  const requiredZones = booked?.requiredZones ?? null;
  const requiredZonesHash = booked?.requiredZonesHash ?? null;

  const proofPolicy = booked?.policySnapshot?.proofPolicy ?? booked?.policySnapshot?.proof ?? null;
  const zc = proofPolicy?.zoneCoverage ?? {};
  const thresholdPct = Number.isSafeInteger(zc?.thresholdPct) ? zc.thresholdPct : 95;
  const excuseIncidentTypes = Array.isArray(zc?.excuseIncidentTypes) ? zc.excuseIncidentTypes : ["BLOCKED_ZONE"];

  const requiredZoneIdsRaw =
    requiredZones && typeof requiredZones === "object" && Array.isArray(requiredZones.zones)
      ? requiredZones.zones.map((z) => String(z?.zoneId ?? "")).filter(Boolean)
      : [];
  const requiredZoneIds = Array.from(new Set(requiredZoneIdsRaw)).sort();

  const coverageByZone = latestCoverageByZone(events);
  const excused = excusedZonesFromIncidents(events, { excuseIncidentTypes });

  const facts = {
    schemaVersion: "ZoneCoverageFacts.v1",
    evaluatedAtChainHash,
    requiredZonesHash: typeof requiredZonesHash === "string" && requiredZonesHash.trim() ? requiredZonesHash : null,
    thresholdPct,
    requiredZoneIds,
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
    excusedZones: Array.from(excused.values()).sort(),
    excuseIncidentTypes: Array.from(new Set(excuseIncidentTypes.map((t) => String(t)))).sort()
  };
  return sha256HexUtf8(canonicalJsonStringify(facts));
}

function payloadHashForMaterial(mat) {
  return sha256HexUtf8(
    canonicalJsonStringify({
      v: mat?.v ?? null,
      id: mat?.id ?? null,
      at: mat?.at ?? null,
      streamId: mat?.streamId ?? null,
      type: mat?.type ?? null,
      actor: mat?.actor ?? null,
      payload: mat?.payload ?? null
    })
  );
}

function chainHashForEvent({ prevChainHash, payloadHash }) {
  return sha256HexUtf8(
    canonicalJsonStringify({
      v: EVENT_ENVELOPE_VERSION,
      prevChainHash: prevChainHash ?? null,
      payloadHash: payloadHash ?? null
    })
  );
}

function eventMaterialMatches({ material, event }) {
  if (!material || typeof material !== "object") return false;
  if (!event || typeof event !== "object") return false;
  const keys = ["v", "id", "at", "streamId", "type"];
  for (const k of keys) {
    if ((material?.[k] ?? null) !== (event?.[k] ?? null)) return false;
  }
  // actor/payload are plain JSON; compare canonical encodings for stability.
  try {
    if (canonicalJsonStringify(material?.actor ?? null) !== canonicalJsonStringify(event?.actor ?? null)) return false;
    if (canonicalJsonStringify(material?.payload ?? null) !== canonicalJsonStringify(event?.payload ?? null)) return false;
  } catch {
    return false;
  }
  return true;
}

function normalizeIsoOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) return null;
  const s = String(value).trim();
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? s : null;
}

function parsePublicKeysFile(keysJson) {
  if (!keysJson || typeof keysJson !== "object" || Array.isArray(keysJson)) throw new Error("keys/public_keys.json must be an object");

  // Back-compat: legacy format is { [keyId]: publicKeyPem }.
  if (!("schemaVersion" in keysJson)) {
    const publicKeyByKeyId = new Map();
    const keyMetaByKeyId = new Map();
    for (const [keyId, publicKeyPem] of Object.entries(keysJson)) {
      if (typeof keyId !== "string" || !keyId.trim()) continue;
      if (typeof publicKeyPem !== "string" || !publicKeyPem.trim()) continue;
      publicKeyByKeyId.set(keyId, publicKeyPem);
      keyMetaByKeyId.set(keyId, {
        keyId,
        publicKeyPem,
        purpose: null,
        status: null,
        validFrom: null,
        validTo: null,
        createdAt: null,
        rotatedAt: null,
        revokedAt: null
      });
    }
    return { publicKeyByKeyId, keyMetaByKeyId };
  }

  if (String(keysJson.schemaVersion ?? "") !== "PublicKeys.v1") throw new Error("keys/public_keys.json schemaVersion must be PublicKeys.v1");
  if (!Array.isArray(keysJson.keys)) throw new Error("keys/public_keys.json keys[] is required");

  const publicKeyByKeyId = new Map();
  const keyMetaByKeyId = new Map();

  for (const row of keysJson.keys) {
    if (!row || typeof row !== "object") continue;
    const keyId = typeof row.keyId === "string" && row.keyId.trim() ? row.keyId : null;
    const publicKeyPem = typeof row.publicKeyPem === "string" && row.publicKeyPem.trim() ? row.publicKeyPem : null;
    if (!keyId || !publicKeyPem) continue;
    publicKeyByKeyId.set(keyId, publicKeyPem);
    keyMetaByKeyId.set(keyId, {
      keyId,
      publicKeyPem,
      purpose: typeof row.purpose === "string" && row.purpose.trim() ? row.purpose : null,
      status: typeof row.status === "string" && row.status.trim() ? row.status : null,
      validFrom: normalizeIsoOrNull(row.validFrom ?? null),
      validTo: normalizeIsoOrNull(row.validTo ?? null),
      createdAt: normalizeIsoOrNull(row.createdAt ?? null),
      rotatedAt: normalizeIsoOrNull(row.rotatedAt ?? null),
      revokedAt: normalizeIsoOrNull(row.revokedAt ?? null)
    });
  }

  return { publicKeyByKeyId, keyMetaByKeyId };
}

function keyEffectiveWindowMs(meta) {
  const validFromMs = meta?.validFrom ? Date.parse(meta.validFrom) : NaN;
  const validToMs = meta?.validTo ? Date.parse(meta.validTo) : NaN;
  const rotatedAtMs = meta?.rotatedAt ? Date.parse(meta.rotatedAt) : NaN;
  const revokedAtMs = meta?.revokedAt ? Date.parse(meta.revokedAt) : NaN;
  return { validFromMs, validToMs, rotatedAtMs, revokedAtMs };
}

function isKeyUsableAt(meta, atIso) {
  if (!meta || typeof meta !== "object") return { ok: true };
  if (typeof atIso !== "string" || !atIso.trim()) return { ok: true };
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) return { ok: true };
  const { validFromMs, validToMs, rotatedAtMs, revokedAtMs } = keyEffectiveWindowMs(meta);
  if (Number.isFinite(validFromMs) && atMs < validFromMs) return { ok: false, reason: "KEY_NOT_YET_VALID", boundary: meta.validFrom };
  if (Number.isFinite(validToMs) && atMs > validToMs) return { ok: false, reason: "KEY_EXPIRED", boundary: meta.validTo };
  return { ok: true };
}

function isKeyUsableAtForEvent({ meta, event }) {
  if (!event || typeof event !== "object") return { ok: true };
  const requiredKind = requiredSignerKindForEventType(String(event.type ?? ""));
  const usable = isKeyUsableAt(meta, String(event.at ?? ""));
  if (!usable.ok) return usable;

  // Rotation/revocation are prospective controls that only make sense when the timestamp used
  // for enforcement is authoritative. We enforce them for server-required signatures only.
  if (requiredKind !== SIGNER_KIND.SERVER) return { ok: true };

  const atMs = Date.parse(String(event.at ?? ""));
  if (!Number.isFinite(atMs)) return { ok: true };
  const { rotatedAtMs, revokedAtMs } = keyEffectiveWindowMs(meta);
  if (Number.isFinite(revokedAtMs) && atMs > revokedAtMs) return { ok: false, reason: "KEY_REVOKED", boundary: meta.revokedAt };
  if (Number.isFinite(rotatedAtMs) && atMs > rotatedAtMs) return { ok: false, reason: "KEY_ROTATED", boundary: meta.rotatedAt };
  return { ok: true };
}

function isServerKeyUsableAtForAttestation({ meta, atIso }) {
  const usable = isKeyUsableAt(meta, atIso);
  if (!usable.ok) return usable;
  const atMs = Date.parse(String(atIso ?? ""));
  if (!Number.isFinite(atMs)) return { ok: true };
  const { rotatedAtMs, revokedAtMs } = keyEffectiveWindowMs(meta);
  if (Number.isFinite(revokedAtMs) && atMs > revokedAtMs) return { ok: false, reason: "KEY_REVOKED", boundary: meta.revokedAt };
  if (Number.isFinite(rotatedAtMs) && atMs > rotatedAtMs) return { ok: false, reason: "KEY_ROTATED", boundary: meta.rotatedAt };
  return { ok: true };
}

function verifyEventStreamIntegrityV1({ events, payloadMaterial, publicKeyByKeyId, keyMetaByKeyId, declaredHeadChainHash, declaredHeadEventId, strict }) {
  if (!Array.isArray(events)) return { ok: false, error: "missing events" };
  if (strict !== true && strict !== false) strict = false;
  if (events.length === 0) {
    if (!Array.isArray(payloadMaterial) || payloadMaterial.length !== 0) {
      return { ok: false, error: "payload_material length mismatch", expected: 0, actual: Array.isArray(payloadMaterial) ? payloadMaterial.length : null };
    }
    if (declaredHeadChainHash) return { ok: false, error: "declared head chainHash mismatch", expected: declaredHeadChainHash, actual: null };
    if (declaredHeadEventId) return { ok: false, error: "declared head eventId mismatch", expected: declaredHeadEventId, actual: null };
    return { ok: true, head: null, eventCount: 0 };
  }
  if (!Array.isArray(payloadMaterial) || payloadMaterial.length !== events.length) {
    return { ok: false, error: "payload_material length mismatch", expected: events.length, actual: Array.isArray(payloadMaterial) ? payloadMaterial.length : null };
  }
  if (!(publicKeyByKeyId instanceof Map)) return { ok: false, error: "publicKeyByKeyId must be a Map" };
  if (!(keyMetaByKeyId instanceof Map)) return { ok: false, error: "keyMetaByKeyId must be a Map" };

  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const m = payloadMaterial[i];
    if (!e || typeof e !== "object") return { ok: false, error: `invalid event at index ${i}` };
    if (!m || typeof m !== "object") return { ok: false, error: `invalid payload material at index ${i}` };

    if (!eventMaterialMatches({ material: m, event: e })) {
      return { ok: false, error: `payload material mismatch at index ${i}`, eventId: e?.id ?? null };
    }

    const expectedPayloadHash = payloadHashForMaterial(m);
    if (e.payloadHash !== expectedPayloadHash) {
      return { ok: false, error: `payloadHash mismatch at index ${i}`, eventId: e?.id ?? null, expected: expectedPayloadHash, actual: e.payloadHash ?? null };
    }

    const expectedPrev = i === 0 ? null : events[i - 1]?.chainHash ?? null;
    if ((e.prevChainHash ?? null) !== (expectedPrev ?? null)) {
      return { ok: false, error: `prevChainHash mismatch at index ${i}`, eventId: e?.id ?? null, expected: expectedPrev, actual: e.prevChainHash ?? null };
    }

    const expectedChainHash = chainHashForEvent({ prevChainHash: expectedPrev, payloadHash: expectedPayloadHash });
    if (e.chainHash !== expectedChainHash) {
      return { ok: false, error: `chainHash mismatch at index ${i}`, eventId: e?.id ?? null, expected: expectedChainHash, actual: e.chainHash ?? null };
    }

    const requiredKind = requiredSignerKindForEventType(String(e.type ?? ""));
    const requiresSignature = requiredKind !== SIGNER_KIND.NONE;
    if (requiresSignature) {
      if (!e.signature || typeof e.signature !== "string") return { ok: false, error: `missing signature at index ${i}`, eventId: e?.id ?? null, type: e.type ?? null };
      if (!e.signerKeyId || typeof e.signerKeyId !== "string") return { ok: false, error: `missing signerKeyId at index ${i}`, eventId: e?.id ?? null, type: e.type ?? null };
    }

    if (e.signature) {
      if (!e.signerKeyId) return { ok: false, error: `missing signerKeyId at index ${i}`, eventId: e?.id ?? null };
      const publicKeyPem = publicKeyByKeyId.get(e.signerKeyId) ?? null;
      if (!publicKeyPem) return { ok: false, error: `unknown signerKeyId at index ${i}`, eventId: e?.id ?? null, signerKeyId: e.signerKeyId };
      const meta = keyMetaByKeyId.get(e.signerKeyId) ?? null;

      // Strict profile: server-required signatures must use a governed server signer key
      // (registered/rotated/revoked via governance events included in the bundle).
      if (strict && requiredKind === SIGNER_KIND.SERVER) {
        const governed = Boolean(meta && typeof meta === "object" && meta.serverGoverned === true);
        if (!governed) {
          return { ok: false, error: `server signer key not governed at index ${i}`, eventId: e?.id ?? null, signerKeyId: e.signerKeyId };
        }
        const hasValidFrom = typeof meta?.validFrom === "string" && meta.validFrom.trim();
        if (!hasValidFrom) {
          return { ok: false, error: `server signer key missing validFrom at index ${i}`, eventId: e?.id ?? null, signerKeyId: e.signerKeyId };
        }
      }

      const usable = isKeyUsableAtForEvent({ meta, event: e });
      if (!usable.ok) {
        return {
          ok: false,
          error: `signer key not valid at index ${i}`,
          reason: usable.reason,
          boundary: usable.boundary ?? null,
          eventId: e?.id ?? null,
          signerKeyId: e.signerKeyId
        };
      }
      const ok = verifyHashHexEd25519({ hashHex: expectedPayloadHash, signatureBase64: e.signature, publicKeyPem });
      if (!ok) return { ok: false, error: `signature invalid at index ${i}`, eventId: e?.id ?? null, signerKeyId: e.signerKeyId };
    }
  }

  const head = events[events.length - 1];
  if (declaredHeadChainHash && head?.chainHash !== declaredHeadChainHash) {
    return { ok: false, error: "declared head chainHash mismatch", expected: declaredHeadChainHash, actual: head?.chainHash ?? null };
  }
  if (declaredHeadEventId && head?.id !== declaredHeadEventId) {
    return { ok: false, error: "declared head eventId mismatch", expected: declaredHeadEventId, actual: head?.id ?? null };
  }

  return { ok: true, head: { eventId: head?.id ?? null, chainHash: head?.chainHash ?? null }, eventCount: events.length };
}

function deriveServerKeyTimelineFromGovernanceEvents(events) {
  const derived = new Map(); // keyId -> { validFrom, rotatedAt, revokedAt, serverGoverned }
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") continue;
    const type = String(e.type ?? "");
    const at = typeof e.at === "string" && e.at.trim() ? e.at : null;
    const p = e.payload ?? null;
    if (!p || typeof p !== "object") continue;

    if (type === "SERVER_SIGNER_KEY_REGISTERED") {
      const keyId = typeof p.keyId === "string" && p.keyId.trim() ? p.keyId : null;
      const registeredAt = typeof p.registeredAt === "string" && p.registeredAt.trim() ? p.registeredAt : at;
      if (!keyId || !registeredAt) continue;
      const row = derived.get(keyId) ?? {};
      if (!row.validFrom) row.validFrom = registeredAt;
      row.serverGoverned = true;
      derived.set(keyId, row);
    }

    if (type === "SERVER_SIGNER_KEY_ROTATED") {
      const oldKeyId = typeof p.oldKeyId === "string" && p.oldKeyId.trim() ? p.oldKeyId : null;
      const newKeyId = typeof p.newKeyId === "string" && p.newKeyId.trim() ? p.newKeyId : null;
      const rotatedAt = typeof p.rotatedAt === "string" && p.rotatedAt.trim() ? p.rotatedAt : at;
      if (!rotatedAt) continue;
      if (oldKeyId) {
        const row = derived.get(oldKeyId) ?? {};
        row.rotatedAt = rotatedAt;
        row.serverGoverned = true;
        derived.set(oldKeyId, row);
      }
      if (newKeyId) {
        const row = derived.get(newKeyId) ?? {};
        if (!row.validFrom) row.validFrom = rotatedAt;
        row.serverGoverned = true;
        derived.set(newKeyId, row);
      }
    }

    if (type === "SERVER_SIGNER_KEY_REVOKED") {
      const keyId = typeof p.keyId === "string" && p.keyId.trim() ? p.keyId : null;
      const revokedAt = typeof p.revokedAt === "string" && p.revokedAt.trim() ? p.revokedAt : at;
      if (!keyId || !revokedAt) continue;
      const row = derived.get(keyId) ?? {};
      row.revokedAt = revokedAt;
      row.serverGoverned = true;
      derived.set(keyId, row);
    }
  }
  return derived;
}

function applyDerivedServerTimeline({ keyMetaByKeyId, derived }) {
  if (!(keyMetaByKeyId instanceof Map)) throw new TypeError("keyMetaByKeyId must be a Map");
  if (!(derived instanceof Map)) throw new TypeError("derived must be a Map");
  const next = new Map(keyMetaByKeyId);
  for (const [keyId, timeline] of derived.entries()) {
    const existing = next.get(keyId) ?? null;
    if (!existing || typeof existing !== "object") continue;
    next.set(keyId, {
      ...existing,
      validFrom: timeline.validFrom ?? existing.validFrom ?? null,
      rotatedAt: timeline.rotatedAt ?? existing.rotatedAt ?? null,
      revokedAt: timeline.revokedAt ?? existing.revokedAt ?? null,
      serverGoverned: timeline.serverGoverned === true ? true : existing.serverGoverned === true
    });
  }
  return next;
}

function proofRefMatchesEvent({ ref, proofEvent, allowForfeitStatusOverride = false }) {
  if (!ref || typeof ref !== "object") return false;
  if (!proofEvent || typeof proofEvent !== "object") return false;
  const p = proofEvent.payload ?? null;
  if (!p || typeof p !== "object") return false;

  if (ref.proofEventId && ref.proofEventId !== proofEvent.id) return false;
  if (ref.proofEventChainHash && ref.proofEventChainHash !== proofEvent.chainHash) return false;
  if (ref.proofEventPayloadHash && ref.proofEventPayloadHash !== proofEvent.payloadHash) return false;
  if (ref.proofEventSignerKeyId && ref.proofEventSignerKeyId !== proofEvent.signerKeyId) return false;
  if (ref.proofEventSignature && ref.proofEventSignature !== proofEvent.signature) return false;

  if (ref.evaluationId && ref.evaluationId !== p.evaluationId) return false;
  if (ref.evaluatedAtChainHash && ref.evaluatedAtChainHash !== p.evaluatedAtChainHash) return false;
  if (ref.factsHash && ref.factsHash !== p.factsHash) return false;

  if (ref.status) {
    const ok =
      ref.status === p.status ||
      (allowForfeitStatusOverride && ref.forfeit && typeof ref.forfeit === "object" && p.status === "INSUFFICIENT_EVIDENCE" && ref.status === "FAIL");
    if (!ok) return false;
  }
  if (ref.requiredZonesHash && ref.requiredZonesHash !== p.requiredZonesHash) return false;
  if (ref.customerPolicyHash && ref.customerPolicyHash !== p.customerPolicyHash) return false;
  if (ref.operatorPolicyHash && ref.operatorPolicyHash !== p.operatorPolicyHash) return false;

  if (ref.reasonCodes && !arrayEqual(ref.reasonCodes, p.reasonCodes)) return false;

  return true;
}

function decisionRefMatchesEvent({ ref, decisionEvent }) {
  if (!ref || typeof ref !== "object") return false;
  if (!decisionEvent || typeof decisionEvent !== "object") return false;
  const p = decisionEvent.payload ?? null;
  if (!p || typeof p !== "object") return false;

  if (ref.decisionEventId && ref.decisionEventId !== decisionEvent.id) return false;
  if (ref.decisionEventChainHash && ref.decisionEventChainHash !== decisionEvent.chainHash) return false;
  if (ref.decisionEventPayloadHash && ref.decisionEventPayloadHash !== decisionEvent.payloadHash) return false;
  if (ref.decisionEventSignerKeyId && ref.decisionEventSignerKeyId !== decisionEvent.signerKeyId) return false;
  if (ref.decisionEventSignature && ref.decisionEventSignature !== decisionEvent.signature) return false;

  if (ref.decisionId && ref.decisionId !== p.decisionId) return false;
  if (ref.kind && ref.kind !== p.kind) return false;
  if (ref.holdId && ref.holdId !== p.holdId) return false;
  if (ref.forfeitureReason && ref.forfeitureReason !== p.forfeitureReason) return false;
  if (ref.policyHash && ref.policyHash !== p.policyHash) return false;

  if (ref.reasonCodes && !arrayEqual(ref.reasonCodes, Array.isArray(p.reasonCodes) ? p.reasonCodes : [])) return false;
  if (ref.evidenceRefs && !arrayEqual(ref.evidenceRefs, Array.isArray(p.evidenceRefs) ? p.evidenceRefs : [])) return false;

  return true;
}

function verifyHoldAndSettlementProofRefs(events) {
  const out = { ok: true, checked: 0, errors: [] };
  if (!Array.isArray(events) || events.length === 0) return out;

  const byId = new Map();
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (typeof e.id === "string" && e.id.trim()) byId.set(e.id, e);
  }

  for (let idx = 0; idx < events.length; idx += 1) {
    const e = events[idx];
    if (!e || typeof e !== "object") continue;
    const eventsBeforeDecision = events.slice(0, idx);

    if (e.type === "SETTLEMENT_HELD") {
      out.checked += 1;
      const p = e.payload ?? null;
      const ref = p?.triggeringProofRef ?? null;
      const proofEventId = typeof ref?.proofEventId === "string" ? ref.proofEventId : null;
      const proofEvent = proofEventId ? byId.get(proofEventId) ?? null : null;
      if (!proofEvent || proofEvent.type !== "PROOF_EVALUATED") {
        out.ok = false;
        out.errors.push({ error: "hold missing referenced PROOF_EVALUATED", holdEventId: e.id ?? null, proofEventId });
        continue;
      }
      if (!proofRefMatchesEvent({ ref, proofEvent })) {
        out.ok = false;
        out.errors.push({ error: "hold triggeringProofRef mismatch", holdEventId: e.id ?? null, proofEventId });
      }
      const pp = proofEvent.payload ?? null;
      if (!arrayEqual(p?.missingEvidence, pp?.missingEvidence)) {
        out.ok = false;
        out.errors.push({ error: "hold missingEvidence mismatch", holdEventId: e.id ?? null, proofEventId });
      }
      if (!arrayEqual(p?.reasonCodes, pp?.reasonCodes)) {
        out.ok = false;
        out.errors.push({ error: "hold reasonCodes mismatch", holdEventId: e.id ?? null, proofEventId });
      }

      // Time-travel freshness: proof factsHash must match facts as-of the hold append point.
      try {
        const expectedFactsHash = computeZoneCoverageFactsHashV1({ events: eventsBeforeDecision, evaluatedAtChainHash: pp?.evaluatedAtChainHash ?? "" });
        if (pp?.factsHash && expectedFactsHash !== pp.factsHash) {
          out.ok = false;
          out.errors.push({ error: "hold stale at decision time", holdEventId: e.id ?? null, proofEventId, expectedFactsHash, actualFactsHash: pp.factsHash });
        }
      } catch (err) {
        out.ok = false;
        out.errors.push({ error: "hold freshness check failed", holdEventId: e.id ?? null, proofEventId, message: err?.message ?? String(err ?? "") });
      }
    }

    if (e.type === "SETTLEMENT_RELEASED") {
      out.checked += 1;
      const p = e.payload ?? null;
      const ref = p?.releasingProofRef ?? null;
      const proofEventId = typeof ref?.proofEventId === "string" ? ref.proofEventId : null;
      const proofEvent = proofEventId ? byId.get(proofEventId) ?? null : null;
      if (!proofEvent || proofEvent.type !== "PROOF_EVALUATED") {
        out.ok = false;
        out.errors.push({ error: "release missing referenced PROOF_EVALUATED", releaseEventId: e.id ?? null, proofEventId });
        continue;
      }
      if (!proofRefMatchesEvent({ ref, proofEvent })) {
        out.ok = false;
        out.errors.push({ error: "release releasingProofRef mismatch", releaseEventId: e.id ?? null, proofEventId });
      }

      // Time-travel freshness: proof factsHash must match facts as-of the release append point.
      try {
        const pp = proofEvent.payload ?? null;
        const expectedFactsHash = computeZoneCoverageFactsHashV1({ events: eventsBeforeDecision, evaluatedAtChainHash: pp?.evaluatedAtChainHash ?? "" });
        if (pp?.factsHash && expectedFactsHash !== pp.factsHash) {
          out.ok = false;
          out.errors.push({
            error: "release stale at decision time",
            releaseEventId: e.id ?? null,
            proofEventId,
            expectedFactsHash,
            actualFactsHash: pp.factsHash
          });
        }
      } catch (err) {
        out.ok = false;
        out.errors.push({ error: "release freshness check failed", releaseEventId: e.id ?? null, proofEventId, message: err?.message ?? String(err ?? "") });
      }
    }

    if (e.type === "SETTLED") {
      out.checked += 1;
      const ref = e?.payload?.settlementProofRef ?? null;
      const proofEventId = typeof ref?.proofEventId === "string" ? ref.proofEventId : null;
      const proofEvent = proofEventId ? byId.get(proofEventId) ?? null : null;
      if (!proofEvent || proofEvent.type !== "PROOF_EVALUATED") {
        out.ok = false;
        out.errors.push({ error: "settlement missing referenced PROOF_EVALUATED", settledEventId: e.id ?? null, proofEventId });
        continue;
      }
      if (!proofRefMatchesEvent({ ref, proofEvent, allowForfeitStatusOverride: true })) {
        out.ok = false;
        out.errors.push({ error: "settlement settlementProofRef mismatch", settledEventId: e.id ?? null, proofEventId });
      }

      // Time-travel freshness: proof factsHash must match facts as-of the settlement append point.
      try {
        const pp = proofEvent.payload ?? null;
        const expectedFactsHash = computeZoneCoverageFactsHashV1({ events: eventsBeforeDecision, evaluatedAtChainHash: pp?.evaluatedAtChainHash ?? "" });
        if (pp?.factsHash && expectedFactsHash !== pp.factsHash) {
          out.ok = false;
          out.errors.push({
            error: "settlement stale at decision time",
            settledEventId: e.id ?? null,
            proofEventId,
            expectedFactsHash,
            actualFactsHash: pp.factsHash
          });
        }
      } catch (err) {
        out.ok = false;
        out.errors.push({ error: "settlement freshness check failed", settledEventId: e.id ?? null, proofEventId, message: err?.message ?? String(err ?? "") });
      }

      const forfeit = ref?.forfeit && typeof ref.forfeit === "object" ? ref.forfeit : null;
      if (forfeit) {
        const forfeitEventId = typeof forfeit.forfeitEventId === "string" ? forfeit.forfeitEventId : null;
        const forfeitEvent = forfeitEventId ? byId.get(forfeitEventId) ?? null : null;
        if (!forfeitEvent || forfeitEvent.type !== "SETTLEMENT_FORFEITED") {
          out.ok = false;
          out.errors.push({ error: "settlement forfeit ref missing SETTLEMENT_FORFEITED", settledEventId: e.id ?? null, forfeitEventId });
        } else {
          if (forfeit.forfeitEventChainHash && forfeit.forfeitEventChainHash !== forfeitEvent.chainHash) {
            out.ok = false;
            out.errors.push({ error: "settlement forfeitEventChainHash mismatch", settledEventId: e.id ?? null, forfeitEventId });
          }
          if (forfeit.forfeitEventPayloadHash && forfeit.forfeitEventPayloadHash !== forfeitEvent.payloadHash) {
            out.ok = false;
            out.errors.push({ error: "settlement forfeitEventPayloadHash mismatch", settledEventId: e.id ?? null, forfeitEventId });
          }
        }
      }
    }

    if (e.type === "SETTLEMENT_FORFEITED") {
      out.checked += 1;
      const p = e.payload ?? null;
      const evaluatedAtChainHash = typeof p?.evaluatedAtChainHash === "string" ? p.evaluatedAtChainHash : "";
      const actualFactsHash = typeof p?.factsHash === "string" ? p.factsHash : null;
      try {
        const expectedFactsHash = computeZoneCoverageFactsHashV1({ events: eventsBeforeDecision, evaluatedAtChainHash });
        if (actualFactsHash && expectedFactsHash !== actualFactsHash) {
          out.ok = false;
          out.errors.push({
            error: "forfeit stale at decision time",
            forfeitEventId: e.id ?? null,
            expectedFactsHash,
            actualFactsHash
          });
        }
      } catch (err) {
        out.ok = false;
        out.errors.push({ error: "forfeit freshness check failed", forfeitEventId: e.id ?? null, message: err?.message ?? String(err ?? "") });
      }

      const decisionEventRef = p?.decisionEventRef ?? null;
      const decisionRef = p?.decisionRef ?? null;
      if (!decisionEventRef && !decisionRef) {
        out.ok = false;
        out.errors.push({ error: "forfeit missing decision provenance", forfeitEventId: e.id ?? null });
      }
      if (decisionEventRef) {
        const decisionEventId = typeof decisionEventRef?.decisionEventId === "string" ? decisionEventRef.decisionEventId : null;
        const decisionEvent = decisionEventId ? byId.get(decisionEventId) ?? null : null;
        if (!decisionEvent || decisionEvent.type !== "DECISION_RECORDED") {
          out.ok = false;
          out.errors.push({ error: "forfeit decisionEventRef missing DECISION_RECORDED", forfeitEventId: e.id ?? null, decisionEventId });
        } else if (!decisionRefMatchesEvent({ ref: decisionEventRef, decisionEvent })) {
          out.ok = false;
          out.errors.push({ error: "forfeit decisionEventRef mismatch", forfeitEventId: e.id ?? null, decisionEventId });
        }
      }
    }
  }

  return out;
}

function verifyBundleHeadAttestationV1({
  attestation,
  manifestHash,
  manifestKind,
  tenantId,
  scope,
  jobSnapshot,
  monthHead,
  governanceSnapshots,
  publicKeyByKeyId,
  keyMetaByKeyId,
  strict
}) {
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) return { ok: false, error: "invalid attestation JSON" };
  if (strict !== true && strict !== false) strict = false;
  if (String(attestation.schemaVersion ?? "") !== BUNDLE_HEAD_ATTESTATION_SCHEMA_V1) {
    return { ok: false, error: "unsupported attestation schemaVersion", schemaVersion: attestation.schemaVersion ?? null };
  }
  if (String(attestation.kind ?? "") !== String(manifestKind ?? "")) return { ok: false, error: "attestation kind mismatch", expected: manifestKind ?? null, actual: attestation.kind ?? null };
  if (String(attestation.tenantId ?? "") !== String(tenantId ?? "")) return { ok: false, error: "attestation tenantId mismatch", expected: tenantId ?? null, actual: attestation.tenantId ?? null };
  if (canonicalJsonStringify(attestation.scope ?? null) !== canonicalJsonStringify(scope ?? null)) {
    return { ok: false, error: "attestation scope mismatch", expected: scope ?? null, actual: attestation.scope ?? null };
  }
  if (String(attestation.manifestHash ?? "") !== String(manifestHash ?? "")) return { ok: false, error: "attestation manifestHash mismatch", expected: manifestHash ?? null, actual: attestation.manifestHash ?? null };

  const signerKeyId = typeof attestation.signerKeyId === "string" && attestation.signerKeyId.trim() ? attestation.signerKeyId : null;
  const signature = typeof attestation.signature === "string" && attestation.signature.trim() ? attestation.signature : null;
  const signedAt = typeof attestation.signedAt === "string" && attestation.signedAt.trim() ? attestation.signedAt : null;
  if (!signerKeyId || !signature || !signedAt) return { ok: false, error: "attestation missing signer fields" };

  const attestationCore = stripAttestationSig(attestation);
  const expectedHash = sha256HexUtf8(canonicalJsonStringify(attestationCore));
  const declaredHash = typeof attestation.attestationHash === "string" && attestation.attestationHash.trim() ? attestation.attestationHash : null;
  if (declaredHash && declaredHash !== expectedHash) return { ok: false, error: "attestationHash mismatch", expected: expectedHash, actual: declaredHash };

  const publicKeyPem = publicKeyByKeyId.get(signerKeyId) ?? null;
  if (!publicKeyPem) return { ok: false, error: "unknown attestation signerKeyId", signerKeyId };
  const okSig = verifyHashHexEd25519({ hashHex: expectedHash, signatureBase64: signature, publicKeyPem });
  if (!okSig) return { ok: false, error: "attestation signature invalid", signerKeyId };

  const meta = keyMetaByKeyId.get(signerKeyId) ?? null;
  if (strict) {
    const governed = Boolean(meta && typeof meta === "object" && meta.serverGoverned === true);
    if (!governed) return { ok: false, error: "attestation signer key not governed", signerKeyId };
    if (!(typeof meta?.validFrom === "string" && meta.validFrom.trim())) return { ok: false, error: "attestation signer key missing validFrom", signerKeyId };
  }
  const usable = isServerKeyUsableAtForAttestation({ meta, atIso: signedAt });
  if (!usable.ok) return { ok: false, error: "attestation signer key not valid", signerKeyId, reason: usable.reason, boundary: usable.boundary ?? null };

  // Heads must match what the bundle declares.
  const heads = attestation.heads ?? null;
  if (!heads || typeof heads !== "object" || Array.isArray(heads)) return { ok: false, error: "attestation missing heads" };

  if (String(attestation.kind ?? "") === JOB_PROOF_BUNDLE_SCHEMA_VERSION_V1) {
    const declaredJob = heads.job ?? null;
    const jobLastChainHash = jobSnapshot?.lastChainHash ?? null;
    const jobLastEventId = jobSnapshot?.lastEventId ?? null;
    if (!declaredJob) return { ok: false, error: "attestation missing heads.job" };
    if (jobLastChainHash && declaredJob.lastChainHash && declaredJob.lastChainHash !== jobLastChainHash) {
      return { ok: false, error: "attestation job head mismatch (chainHash)", expected: jobLastChainHash, actual: declaredJob.lastChainHash };
    }
    if (jobLastEventId && declaredJob.lastEventId && declaredJob.lastEventId !== jobLastEventId) {
      return { ok: false, error: "attestation job head mismatch (eventId)", expected: jobLastEventId, actual: declaredJob.lastEventId };
    }
  }

  if (String(attestation.kind ?? "") === MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1) {
    const declaredMonth = heads.month ?? null;
    if (!declaredMonth) return { ok: false, error: "attestation missing heads.month" };
    if (monthHead?.chainHash && declaredMonth.lastChainHash && declaredMonth.lastChainHash !== monthHead.chainHash) {
      return { ok: false, error: "attestation month head mismatch (chainHash)", expected: monthHead.chainHash, actual: declaredMonth.lastChainHash };
    }
    if (monthHead?.eventId && declaredMonth.lastEventId && declaredMonth.lastEventId !== monthHead.eventId) {
      return { ok: false, error: "attestation month head mismatch (eventId)", expected: monthHead.eventId, actual: declaredMonth.lastEventId };
    }
  }

  const gov = heads.governance ?? null;
  if (gov && typeof gov === "object" && !Array.isArray(gov)) {
    const t = gov.tenant ?? null;
    const g = gov.global ?? null;
    if (t && governanceSnapshots?.tenant) {
      if (t.lastChainHash && governanceSnapshots.tenant.lastChainHash && t.lastChainHash !== governanceSnapshots.tenant.lastChainHash) {
        return { ok: false, error: "attestation tenant governance head mismatch (chainHash)", expected: governanceSnapshots.tenant.lastChainHash, actual: t.lastChainHash };
      }
      if (t.lastEventId && governanceSnapshots.tenant.lastEventId && t.lastEventId !== governanceSnapshots.tenant.lastEventId) {
        return { ok: false, error: "attestation tenant governance head mismatch (eventId)", expected: governanceSnapshots.tenant.lastEventId, actual: t.lastEventId };
      }
    }
    if (g && governanceSnapshots?.global) {
      if (g.lastChainHash && governanceSnapshots.global.lastChainHash && g.lastChainHash !== governanceSnapshots.global.lastChainHash) {
        return { ok: false, error: "attestation global governance head mismatch (chainHash)", expected: governanceSnapshots.global.lastChainHash, actual: g.lastChainHash };
      }
      if (g.lastEventId && governanceSnapshots.global.lastEventId && g.lastEventId !== governanceSnapshots.global.lastEventId) {
        return { ok: false, error: "attestation global governance head mismatch (eventId)", expected: governanceSnapshots.global.lastEventId, actual: g.lastEventId };
      }
    }
  }

  return { ok: true, signerKeyId, signedAt, attestationHash: expectedHash };
}

function assertGovernanceScopeIsolation({ globalGovernanceEvents, tenantGovernanceEvents }) {
  for (const e of Array.isArray(globalGovernanceEvents) ? globalGovernanceEvents : []) {
    const type = String(e?.type ?? "");
    if (type === "TENANT_POLICY_UPDATED") {
      return { ok: false, error: "governance/global contains tenant-scoped event", type };
    }
  }
  for (const e of Array.isArray(tenantGovernanceEvents) ? tenantGovernanceEvents : []) {
    const type = String(e?.type ?? "");
    if (type.startsWith("SERVER_SIGNER_KEY_")) {
      return { ok: false, error: "governance/tenant contains global-scoped event", type };
    }
  }
  return { ok: true };
}

export async function verifyJobProofBundleDir({ dir, strict = false } = {}) {
  if (!dir) throw new Error("dir is required");
  if (strict !== true && strict !== false) throw new TypeError("strict must be a boolean");

  const warnings = [];

  const manifestPath = path.join(dir, "manifest.json");
  const manifestWithHash = await readJson(manifestPath);
  if (manifestWithHash?.schemaVersion !== PROOF_BUNDLE_MANIFEST_SCHEMA_V1) {
    return { ok: false, error: "unsupported manifest schemaVersion", schemaVersion: manifestWithHash?.schemaVersion ?? null, warnings };
  }

  const expectedManifestHash = String(manifestWithHash?.manifestHash ?? "");
  if (!expectedManifestHash) return { ok: false, error: "manifest missing manifestHash", warnings };
  const manifestCore = stripManifestHash(manifestWithHash);
  const actualManifestHash = sha256HexUtf8(canonicalJsonStringify(manifestCore));
  if (actualManifestHash !== expectedManifestHash) {
    return { ok: false, error: "manifestHash mismatch", expected: expectedManifestHash, actual: actualManifestHash, warnings };
  }

  // Strict profile: manifest must enumerate mandatory bundle files (prevents "selective manifest" attacks).
  {
    const present = new Set();
    for (const f of manifestWithHash.files ?? []) {
      const name = typeof f?.name === "string" ? f.name : null;
      if (!name) continue;
      present.add(name);
    }

    const kind = String(manifestWithHash?.kind ?? "");
    const required = [];
    // Base: all job bundles require event stream, payload material, job snapshot, and keys.
    // `verify/*` files are derived outputs and intentionally excluded from the manifest.
    required.push("events/events.jsonl", "events/payload_material.jsonl", "job/snapshot.json", "keys/public_keys.json");
    // Dual-scope governance is mandatory in strict mode.
    if (strict) {
      required.push(
        "governance/global/events/events.jsonl",
        "governance/global/events/payload_material.jsonl",
        "governance/global/snapshot.json",
        "governance/tenant/events/events.jsonl",
        "governance/tenant/events/payload_material.jsonl",
        "governance/tenant/snapshot.json"
      );
    }
    const missing = required.filter((n) => !present.has(n));
    if (missing.length) {
      if (strict) return { ok: false, error: "manifest missing required files", kind, missing, warnings };
      warnings.push({ warning: "MANIFEST_MISSING_REQUIRED_FILES", kind, missing });
    }
  }

  // Verify every file hash listed in manifest.json.
  for (const f of manifestWithHash.files ?? []) {
    if (!f || typeof f !== "object") continue;
    const name = typeof f.name === "string" ? f.name : null;
    const expectedSha = typeof f.sha256 === "string" ? f.sha256 : null;
    if (!name || !expectedSha) continue;
    const fp = path.join(dir, name);
    const b = await readBytes(fp);
    const actual = sha256HexBytes(b);
    if (actual !== expectedSha) return { ok: false, error: "sha256 mismatch", name, expected: expectedSha, actual, warnings };
  }

  // Event stream integrity (no gaps, no selective history): validate against payload material + signatures.
  let events = null;
  let payloadMaterial = null;
  let publicKeyByKeyId = new Map();
  let keyMetaByKeyId = new Map();
  let globalGovernanceEvents = null;
  let globalGovernanceMaterial = null;
  let globalGovernanceSnapshot = null;
  let globalGovernanceInfo = null;

  let tenantGovernanceEvents = null;
  let tenantGovernanceMaterial = null;
  let tenantGovernanceSnapshot = null;
  let tenantGovernanceInfo = null;
  let jobSnapshot = null;
  try {
    const raw = await fs.readFile(path.join(dir, "events", "events.jsonl"), "utf8");
    events = parseJsonl(raw);
  } catch {
    events = null;
  }
  if (!Array.isArray(events) || events.length === 0) return { ok: false, error: "missing events/events.jsonl", warnings };

  try {
    const raw = await fs.readFile(path.join(dir, "events", "payload_material.jsonl"), "utf8");
    payloadMaterial = parseJsonl(raw);
  } catch {
    payloadMaterial = null;
  }
  if (!payloadMaterial) return { ok: false, error: "missing events/payload_material.jsonl", warnings };

  try {
    const keysJson = await readJson(path.join(dir, "keys", "public_keys.json"));
    const parsed = parsePublicKeysFile(keysJson);
    publicKeyByKeyId = parsed.publicKeyByKeyId;
    keyMetaByKeyId = parsed.keyMetaByKeyId;
  } catch (err) {
    return { ok: false, error: "missing or invalid keys/public_keys.json", message: err?.message ?? String(err ?? ""), warnings };
  }

  const tenantGov = await tryReadGovernance({ dir, base: path.join("governance", "tenant") });
  if (tenantGov) {
    tenantGovernanceInfo = tenantGov;
    tenantGovernanceEvents = tenantGov.events;
    tenantGovernanceMaterial = tenantGov.payloadMaterial;
    tenantGovernanceSnapshot = tenantGov.snapshot;
  }

  const globalGov = await tryReadGovernance({ dir, base: path.join("governance", "global") });
  if (globalGov) {
    globalGovernanceInfo = globalGov;
    globalGovernanceEvents = globalGov.events;
    globalGovernanceMaterial = globalGov.payloadMaterial;
    globalGovernanceSnapshot = globalGov.snapshot;
  } else {
    const legacyGov = await tryReadGovernance({ dir, base: "governance" });
    if (legacyGov) {
      globalGovernanceInfo = legacyGov;
      globalGovernanceEvents = legacyGov.events;
      globalGovernanceMaterial = legacyGov.payloadMaterial;
      globalGovernanceSnapshot = legacyGov.snapshot;
    }
  }

  try {
    jobSnapshot = await readJson(path.join(dir, "job", "snapshot.json"));
  } catch {
    jobSnapshot = null;
  }
  if (strict && !jobSnapshot) return { ok: false, error: "missing job/snapshot.json", warnings };

  // Optional bundle head attestation (strict requires it).
  let headAttestation = null;
  try {
    headAttestation = await readJson(path.join(dir, "attestation", "bundle_head_attestation.json"));
  } catch {
    headAttestation = null;
  }
  if (strict && !headAttestation) return { ok: false, error: "missing attestation/bundle_head_attestation.json", warnings };

  // VerificationReport.v1 (strict requires it, signed).
  let verificationReport = null;
  try {
    verificationReport = await readJson(path.join(dir, "verify", "verification_report.json"));
  } catch {
    verificationReport = null;
  }
  if (strict && !verificationReport) return { ok: false, error: "missing verify/verification_report.json", warnings };

  let governance = { global: null, tenant: null };
  let governanceStream = null;

  function declaredHeadFromSnapshot(snapshot) {
    const declaredChainHash = typeof snapshot?.lastChainHash === "string" && snapshot.lastChainHash.trim() ? snapshot.lastChainHash : null;
    const declaredEventId = typeof snapshot?.lastEventId === "string" && snapshot.lastEventId.trim() ? snapshot.lastEventId : null;
    return { declaredChainHash, declaredEventId };
  }

  // If governance streams are present, derive server key lifecycle timelines first so
  // strict verification can enforce "server keys must be governed".
  {
    const derivedFrom = [
      ...(Array.isArray(globalGovernanceEvents) ? globalGovernanceEvents : []),
      ...(Array.isArray(tenantGovernanceEvents) ? tenantGovernanceEvents : [])
    ];
    if (derivedFrom.length) {
      const derived = deriveServerKeyTimelineFromGovernanceEvents(derivedFrom);
      keyMetaByKeyId = applyDerivedServerTimeline({ keyMetaByKeyId, derived });
    }
  }

  if (strict) {
    const iso = assertGovernanceScopeIsolation({ globalGovernanceEvents, tenantGovernanceEvents });
    if (!iso.ok) return { ok: false, error: iso.error, detail: iso, warnings };
  }

  // Verify global governance stream (or legacy).
  if (Array.isArray(globalGovernanceEvents) && Array.isArray(globalGovernanceMaterial)) {
    if (strict) {
      const p = globalGovernanceInfo?.present ?? null;
      if (!p?.events || !p?.payloadMaterial || !p?.snapshot) {
        return { ok: false, error: "incomplete governance/global stream files", warnings };
      }
    }
    const { declaredChainHash, declaredEventId } = declaredHeadFromSnapshot(globalGovernanceSnapshot);
    const globalStream = verifyEventStreamIntegrityV1({
      events: globalGovernanceEvents,
      payloadMaterial: globalGovernanceMaterial,
      publicKeyByKeyId,
      keyMetaByKeyId,
      declaredHeadChainHash: declaredChainHash,
      declaredHeadEventId: declaredEventId,
      strict
    });
    governance.global = globalStream;
    governanceStream = globalStream; // backward-compat: primary governance stream
    if (!globalStream.ok) return { ok: false, error: "governance stream integrity invalid", detail: globalStream, warnings };
  } else if (strict) {
    return { ok: false, error: "missing governance/global stream", warnings };
  } else {
    warnings.push({ warning: "MISSING_GOVERNANCE_GLOBAL_STREAM" });
  }

  // Verify tenant governance stream (optional).
  if (Array.isArray(tenantGovernanceEvents) && Array.isArray(tenantGovernanceMaterial)) {
    if (strict) {
      const p = tenantGovernanceInfo?.present ?? null;
      if (!p?.events || !p?.payloadMaterial || !p?.snapshot) {
        return { ok: false, error: "incomplete governance/tenant stream files", warnings };
      }
    }
    const { declaredChainHash, declaredEventId } = declaredHeadFromSnapshot(tenantGovernanceSnapshot);
    const tenantStream = verifyEventStreamIntegrityV1({
      events: tenantGovernanceEvents,
      payloadMaterial: tenantGovernanceMaterial,
      publicKeyByKeyId,
      keyMetaByKeyId,
      declaredHeadChainHash: declaredChainHash,
      declaredHeadEventId: declaredEventId,
      strict
    });
    governance.tenant = tenantStream;
    if (!tenantStream.ok) return { ok: false, error: "tenant governance stream integrity invalid", detail: tenantStream, warnings };
  } else if (strict) {
    return { ok: false, error: "missing governance/tenant stream", warnings };
  } else {
    warnings.push({ warning: "MISSING_GOVERNANCE_TENANT_STREAM" });
  }

  const declaredHeadChainHash = typeof jobSnapshot?.lastChainHash === "string" && jobSnapshot.lastChainHash.trim() ? jobSnapshot.lastChainHash : null;
  const declaredHeadEventId = typeof jobSnapshot?.lastEventId === "string" && jobSnapshot.lastEventId.trim() ? jobSnapshot.lastEventId : null;
  const eventStream = verifyEventStreamIntegrityV1({
    events,
    payloadMaterial,
    publicKeyByKeyId,
    keyMetaByKeyId,
    declaredHeadChainHash,
    declaredHeadEventId,
    strict
  });
  if (!eventStream.ok) return { ok: false, error: "event stream integrity invalid", detail: eventStream, warnings };

  let attestationVerify = null;
  if (headAttestation) {
    const governanceSnapshots = {
      tenant: tenantGovernanceSnapshot
        ? {
            lastChainHash: typeof tenantGovernanceSnapshot?.lastChainHash === "string" ? tenantGovernanceSnapshot.lastChainHash : null,
            lastEventId: typeof tenantGovernanceSnapshot?.lastEventId === "string" ? tenantGovernanceSnapshot.lastEventId : null
          }
        : null,
      global: globalGovernanceSnapshot
        ? {
            lastChainHash: typeof globalGovernanceSnapshot?.lastChainHash === "string" ? globalGovernanceSnapshot.lastChainHash : null,
            lastEventId: typeof globalGovernanceSnapshot?.lastEventId === "string" ? globalGovernanceSnapshot.lastEventId : null
          }
        : null
    };
    attestationVerify = verifyBundleHeadAttestationV1({
      attestation: headAttestation,
      manifestHash: expectedManifestHash,
      manifestKind: manifestWithHash.kind ?? null,
      tenantId: manifestWithHash.tenantId ?? null,
      scope: manifestWithHash.scope ?? null,
      jobSnapshot,
      monthHead: null,
      governanceSnapshots,
      publicKeyByKeyId,
      keyMetaByKeyId,
      strict
    });
    if (!attestationVerify.ok) {
      if (strict) return { ok: false, error: "bundle head attestation invalid", detail: attestationVerify, warnings };
      warnings.push({ warning: "BUNDLE_HEAD_ATTESTATION_INVALID", detail: attestationVerify });
    }
  } else {
    warnings.push({ warning: "MISSING_BUNDLE_HEAD_ATTESTATION" });
  }

  // Provenance refs: settlement/hold decisions must reference real proof events and be fresh at decision time.
  const refs = verifyHoldAndSettlementProofRefs(events);
  if (!refs.ok) return { ok: false, error: "provenance refs invalid", detail: refs, warnings };

  // Signed verification report must match the bundle manifestHash.
  let verificationReportVerify = null;
  if (verificationReport) {
    verificationReportVerify = verifyVerificationReportV1ForProofBundle({
      report: verificationReport,
      expectedManifestHash,
      expectedBundleType: JOB_PROOF_BUNDLE_SCHEMA_VERSION_V1,
      expectedBundleHeadAttestationHash: attestationVerify?.attestationHash ?? null,
      publicKeyByKeyId,
      keyMetaByKeyId,
      strict
    });
    if (!verificationReportVerify.ok) return { ok: false, error: "verification report invalid", detail: verificationReportVerify, warnings };
  }

  return {
    ok: true,
    strict,
    warnings,
    headAttestation: attestationVerify,
    kind: manifestWithHash.kind ?? null,
    tenantId: manifestWithHash.tenantId ?? null,
    scope: manifestWithHash.scope ?? null,
    manifestHash: expectedManifestHash,
    governance,
    governanceStream,
    eventStream,
    provenanceRefs: refs,
    verificationReport: verificationReportVerify?.ok ? verificationReportVerify : null
  };
}

export async function verifyMonthProofBundleDir({ dir, strict = false } = {}) {
  if (!dir) throw new Error("dir is required");
  if (strict !== true && strict !== false) throw new TypeError("strict must be a boolean");

  const warnings = [];

  const manifestPath = path.join(dir, "manifest.json");
  const manifestWithHash = await readJson(manifestPath);
  if (manifestWithHash?.schemaVersion !== PROOF_BUNDLE_MANIFEST_SCHEMA_V1) {
    return { ok: false, error: "unsupported manifest schemaVersion", schemaVersion: manifestWithHash?.schemaVersion ?? null, warnings };
  }
  if (String(manifestWithHash?.kind ?? "") !== MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1) {
    return { ok: false, error: "unsupported bundle kind", kind: manifestWithHash?.kind ?? null, warnings };
  }

  const expectedManifestHash = String(manifestWithHash?.manifestHash ?? "");
  if (!expectedManifestHash) return { ok: false, error: "manifest missing manifestHash", warnings };
  const manifestCore = stripManifestHash(manifestWithHash);
  const actualManifestHash = sha256HexUtf8(canonicalJsonStringify(manifestCore));
  if (actualManifestHash !== expectedManifestHash) {
    return { ok: false, error: "manifestHash mismatch", expected: expectedManifestHash, actual: actualManifestHash, warnings };
  }

  // Strict profile: manifest must enumerate mandatory bundle files.
  {
    const present = new Set();
    for (const f of manifestWithHash.files ?? []) {
      const name = typeof f?.name === "string" ? f.name : null;
      if (!name) continue;
      present.add(name);
    }
    // `verify/*` files are derived outputs and intentionally excluded from the manifest.
    const required = ["events/events.jsonl", "events/payload_material.jsonl", "keys/public_keys.json"];
    if (strict) {
      required.push(
        "governance/global/events/events.jsonl",
        "governance/global/events/payload_material.jsonl",
        "governance/global/snapshot.json",
        "governance/tenant/events/events.jsonl",
        "governance/tenant/events/payload_material.jsonl",
        "governance/tenant/snapshot.json"
      );
    }
    const missing = required.filter((n) => !present.has(n));
    if (missing.length) {
      if (strict) return { ok: false, error: "manifest missing required files", missing, warnings };
      warnings.push({ warning: "MANIFEST_MISSING_REQUIRED_FILES", missing });
    }
  }

  // Verify every file hash listed in manifest.json.
  for (const f of manifestWithHash.files ?? []) {
    if (!f || typeof f !== "object") continue;
    const name = typeof f.name === "string" ? f.name : null;
    const expectedSha = typeof f.sha256 === "string" ? f.sha256 : null;
    if (!name || !expectedSha) continue;
    const fp = path.join(dir, name);
    const b = await readBytes(fp);
    const actual = sha256HexBytes(b);
    if (actual !== expectedSha) return { ok: false, error: "sha256 mismatch", name, expected: expectedSha, actual, warnings };
  }

  // Read keys.
  let publicKeyByKeyId = new Map();
  let keyMetaByKeyId = new Map();
  try {
    const keys = await readJson(path.join(dir, "keys", "public_keys.json"));
    ({ publicKeyByKeyId, keyMetaByKeyId } = parsePublicKeysFile(keys));
  } catch (err) {
    if (strict) return { ok: false, error: "missing keys/public_keys.json", warnings };
    warnings.push({ warning: "MISSING_PUBLIC_KEYS" });
  }

  // Read month events and payload material.
  let events = null;
  let payloadMaterial = null;
  try {
    const raw = await fs.readFile(path.join(dir, "events", "events.jsonl"), "utf8");
    events = parseJsonl(raw);
  } catch {
    events = null;
  }
  if (!Array.isArray(events) || events.length === 0) return { ok: false, error: "missing events/events.jsonl", warnings };

  try {
    const raw = await fs.readFile(path.join(dir, "events", "payload_material.jsonl"), "utf8");
    payloadMaterial = parseJsonl(raw);
  } catch {
    payloadMaterial = null;
  }
  if (!Array.isArray(payloadMaterial)) return { ok: false, error: "missing events/payload_material.jsonl", warnings };

  // Governance streams.
  let globalGovernanceEvents = null;
  let globalGovernanceMaterial = null;
  let globalGovernanceSnapshot = null;
  let globalGovernanceInfo = null;

  let tenantGovernanceEvents = null;
  let tenantGovernanceMaterial = null;
  let tenantGovernanceSnapshot = null;
  let tenantGovernanceInfo = null;

  const tenantGov = await tryReadGovernance({ dir, base: path.join("governance", "tenant") });
  if (tenantGov) {
    tenantGovernanceInfo = tenantGov;
    tenantGovernanceEvents = tenantGov.events;
    tenantGovernanceMaterial = tenantGov.payloadMaterial;
    tenantGovernanceSnapshot = tenantGov.snapshot;
  }
  const globalGov = await tryReadGovernance({ dir, base: path.join("governance", "global") });
  if (globalGov) {
    globalGovernanceInfo = globalGov;
    globalGovernanceEvents = globalGov.events;
    globalGovernanceMaterial = globalGov.payloadMaterial;
    globalGovernanceSnapshot = globalGov.snapshot;
  }

  // Optional bundle head attestation (strict requires it).
  let headAttestation = null;
  try {
    headAttestation = await readJson(path.join(dir, "attestation", "bundle_head_attestation.json"));
  } catch {
    headAttestation = null;
  }
  if (strict && !headAttestation) return { ok: false, error: "missing attestation/bundle_head_attestation.json", warnings };

  // VerificationReport.v1 (strict requires it, signed).
  let verificationReport = null;
  try {
    verificationReport = await readJson(path.join(dir, "verify", "verification_report.json"));
  } catch {
    verificationReport = null;
  }
  if (strict && !verificationReport) return { ok: false, error: "missing verify/verification_report.json", warnings };

  // Derive server key timelines.
  {
    const derivedFrom = [
      ...(Array.isArray(globalGovernanceEvents) ? globalGovernanceEvents : []),
      ...(Array.isArray(tenantGovernanceEvents) ? tenantGovernanceEvents : [])
    ];
    if (derivedFrom.length) {
      const derived = deriveServerKeyTimelineFromGovernanceEvents(derivedFrom);
      keyMetaByKeyId = applyDerivedServerTimeline({ keyMetaByKeyId, derived });
    }
  }

  if (strict) {
    const iso = assertGovernanceScopeIsolation({ globalGovernanceEvents, tenantGovernanceEvents });
    if (!iso.ok) return { ok: false, error: iso.error, detail: iso, warnings };
  }

  const governance = { global: null, tenant: null };

  function declaredHeadFromSnapshot(snapshot) {
    const declaredChainHash = typeof snapshot?.lastChainHash === "string" && snapshot.lastChainHash.trim() ? snapshot.lastChainHash : null;
    const declaredEventId = typeof snapshot?.lastEventId === "string" && snapshot.lastEventId.trim() ? snapshot.lastEventId : null;
    return { declaredChainHash, declaredEventId };
  }

  if (Array.isArray(globalGovernanceEvents) && Array.isArray(globalGovernanceMaterial)) {
    if (strict) {
      const p = globalGovernanceInfo?.present ?? null;
      if (!p?.events || !p?.payloadMaterial || !p?.snapshot) {
        return { ok: false, error: "incomplete governance/global stream files", warnings };
      }
    }
    const { declaredChainHash, declaredEventId } = declaredHeadFromSnapshot(globalGovernanceSnapshot);
    const globalStream = verifyEventStreamIntegrityV1({
      events: globalGovernanceEvents,
      payloadMaterial: globalGovernanceMaterial,
      publicKeyByKeyId,
      keyMetaByKeyId,
      declaredHeadChainHash: declaredChainHash,
      declaredHeadEventId: declaredEventId,
      strict
    });
    governance.global = globalStream;
    if (!globalStream.ok) return { ok: false, error: "governance stream integrity invalid", detail: globalStream, warnings };
  } else if (strict) {
    return { ok: false, error: "missing governance/global stream", warnings };
  } else {
    warnings.push({ warning: "MISSING_GOVERNANCE_GLOBAL_STREAM" });
  }

  if (Array.isArray(tenantGovernanceEvents) && Array.isArray(tenantGovernanceMaterial)) {
    if (strict) {
      const p = tenantGovernanceInfo?.present ?? null;
      if (!p?.events || !p?.payloadMaterial || !p?.snapshot) {
        return { ok: false, error: "incomplete governance/tenant stream files", warnings };
      }
    }
    const { declaredChainHash, declaredEventId } = declaredHeadFromSnapshot(tenantGovernanceSnapshot);
    const tenantStream = verifyEventStreamIntegrityV1({
      events: tenantGovernanceEvents,
      payloadMaterial: tenantGovernanceMaterial,
      publicKeyByKeyId,
      keyMetaByKeyId,
      declaredHeadChainHash: declaredChainHash,
      declaredHeadEventId: declaredEventId,
      strict
    });
    governance.tenant = tenantStream;
    if (!tenantStream.ok) return { ok: false, error: "tenant governance stream integrity invalid", detail: tenantStream, warnings };
  } else if (strict) {
    return { ok: false, error: "missing governance/tenant stream", warnings };
  } else {
    warnings.push({ warning: "MISSING_GOVERNANCE_TENANT_STREAM" });
  }

  const eventStream = verifyEventStreamIntegrityV1({
    events,
    payloadMaterial,
    publicKeyByKeyId,
    keyMetaByKeyId,
    declaredHeadChainHash: null,
    declaredHeadEventId: null,
    strict
  });
  if (!eventStream.ok) return { ok: false, error: "event stream integrity invalid", detail: eventStream, warnings };

  let attestationVerify = null;
  if (headAttestation) {
    const governanceSnapshots = {
      tenant: tenantGovernanceSnapshot
        ? { lastChainHash: tenantGovernanceSnapshot?.lastChainHash ?? null, lastEventId: tenantGovernanceSnapshot?.lastEventId ?? null }
        : null,
      global: globalGovernanceSnapshot
        ? { lastChainHash: globalGovernanceSnapshot?.lastChainHash ?? null, lastEventId: globalGovernanceSnapshot?.lastEventId ?? null }
        : null
    };
    const monthHead = eventStream.head ? { eventId: eventStream.head.eventId, chainHash: eventStream.head.chainHash } : null;
    attestationVerify = verifyBundleHeadAttestationV1({
      attestation: headAttestation,
      manifestHash: expectedManifestHash,
      manifestKind: manifestWithHash.kind ?? null,
      tenantId: manifestWithHash.tenantId ?? null,
      scope: manifestWithHash.scope ?? null,
      jobSnapshot: null,
      monthHead,
      governanceSnapshots,
      publicKeyByKeyId,
      keyMetaByKeyId,
      strict
    });
    if (!attestationVerify.ok) {
      if (strict) return { ok: false, error: "bundle head attestation invalid", detail: attestationVerify, warnings };
      warnings.push({ warning: "BUNDLE_HEAD_ATTESTATION_INVALID", detail: attestationVerify });
    }
  } else {
    warnings.push({ warning: "MISSING_BUNDLE_HEAD_ATTESTATION" });
  }

  // Signed verification report must match the bundle manifestHash.
  let verificationReportVerify = null;
  if (verificationReport) {
    verificationReportVerify = verifyVerificationReportV1ForProofBundle({
      report: verificationReport,
      expectedManifestHash,
      expectedBundleType: MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1,
      expectedBundleHeadAttestationHash: attestationVerify?.attestationHash ?? null,
      publicKeyByKeyId,
      keyMetaByKeyId,
      strict
    });
    if (!verificationReportVerify.ok) return { ok: false, error: "verification report invalid", detail: verificationReportVerify, warnings };
  }

  return {
    ok: true,
    strict,
    warnings,
    headAttestation: attestationVerify,
    kind: manifestWithHash.kind ?? null,
    tenantId: manifestWithHash.tenantId ?? null,
    scope: manifestWithHash.scope ?? null,
    manifestHash: expectedManifestHash,
    governance,
    eventStream,
    verificationReport: verificationReportVerify?.ok ? verificationReportVerify : null
  };
}
