export const PROOF_STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE"
});

export const PROOF_REASON_CODE = Object.freeze({
  REQUIRED_ZONES_MISSING: "REQUIRED_ZONES_MISSING",
  MISSING_ZONE_COVERAGE: "MISSING_ZONE_COVERAGE",
  ZONE_BELOW_THRESHOLD: "ZONE_BELOW_THRESHOLD",
  ZONE_EXCUSED_BY_INCIDENT: "ZONE_EXCUSED_BY_INCIDENT"
});

// This is a requirements taxonomy (what evidence class is missing), not an outcome taxonomy.
// It should be treated as a closed set: stable, searchable, and safe for downstream automation.
export const MISSING_EVIDENCE = Object.freeze({
  REQUIRED_ZONES: "REQUIRED_ZONES",
  ZONE_COVERAGE: "ZONE_COVERAGE",
  WITNESS: "WITNESS"
});

export const MISSING_EVIDENCE_SET = new Set(Object.values(MISSING_EVIDENCE));

export function canonicalizeMissingEvidenceToken(token) {
  if (typeof token !== "string") throw new TypeError("missingEvidence token must be a string");
  const raw = token.trim();
  if (!raw) throw new TypeError("missingEvidence token must be non-empty");
  const colon = raw.indexOf(":");
  const kindRaw = colon === -1 ? raw : raw.slice(0, colon);
  const detailRaw = colon === -1 ? null : raw.slice(colon + 1);
  const kind = kindRaw.toUpperCase();
  if (!MISSING_EVIDENCE_SET.has(kind)) throw new TypeError("missingEvidence kind is not supported");
  if (detailRaw === null) return kind;
  if (detailRaw.includes(":")) throw new TypeError("missingEvidence detail must not include ':'");
  const detail = detailRaw.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(detail)) throw new TypeError("missingEvidence detail has invalid characters");
  return `${kind}:${detail}`;
}

export function canonicalizeMissingEvidenceList(list) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new TypeError("missingEvidence must be an array");
  const out = [];
  for (const t of list) out.push(canonicalizeMissingEvidenceToken(t));
  return Array.from(new Set(out.values())).sort();
}
