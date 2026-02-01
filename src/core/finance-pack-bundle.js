import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256Hex, signHashHexEd25519 } from "./crypto.js";
import { VERIFICATION_WARNING_CODE, normalizeVerificationWarnings } from "./verification-warnings.js";
import fs from "node:fs";
import path from "node:path";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertUint8Array(value, name) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
}

export const FINANCE_PACK_BUNDLE_SCHEMA_VERSION_V1 = "FinancePackBundle.v1";
export const FINANCE_PACK_BUNDLE_MANIFEST_SCHEMA_VERSION_V1 = "FinancePackBundleManifest.v1";
export const FINANCE_PACK_BUNDLE_MANIFEST_HASHING_SCHEMA_VERSION_V1 = "FinancePackBundleManifestHash.v1";

function stripUndefinedDeep(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(stripUndefinedDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefinedDeep(v);
    }
    return out;
  }
  return value;
}

function parseJsonFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonlFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) return [];
  const text = new TextDecoder().decode(bytes);
  const out = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Best-effort parsing; provenance should not break bundle generation.
      return [];
    }
  }
  return out;
}

function findSignerGovernanceEventRef({ monthProofFiles, keyId }) {
  if (!(monthProofFiles instanceof Map)) return null;
  if (typeof keyId !== "string" || !keyId.trim()) return null;
  const raw = monthProofFiles.get("governance/global/events/events.jsonl") ?? null;
  if (!(raw instanceof Uint8Array)) return null;
  const events = parseJsonlFromBytes(raw);
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const type = String(e.type ?? "");
    const p = e.payload ?? null;
    if (!p || typeof p !== "object") continue;
    if (type === "SERVER_SIGNER_KEY_REGISTERED" && String(p.keyId ?? "") === keyId) {
      return { eventId: e.id ?? null, chainHash: e.chainHash ?? null, payloadHash: e.payloadHash ?? null, type };
    }
    if (type === "SERVER_SIGNER_KEY_ROTATED" && String(p.newKeyId ?? "") === keyId) {
      return { eventId: e.id ?? null, chainHash: e.chainHash ?? null, payloadHash: e.payloadHash ?? null, type };
    }
  }
  return null;
}

function readRepoVersionBestEffort() {
  try {
    // Keep this best-effort to avoid failures in non-repo environments.
    const p = path.resolve(process.cwd(), "SETTLD_VERSION");
    const raw = fs.readFileSync(p, "utf8");
    const v = String(raw).trim();
    return v || null;
  } catch {
    return null;
  }
}

function warningsWithToolVersion({ warnings, toolVersion }) {
  const resolved = typeof toolVersion === "string" && toolVersion.trim() ? toolVersion.trim() : null;
  const out = [];
  if (warnings !== null && warnings !== undefined) {
    if (!Array.isArray(warnings)) throw new TypeError("verificationReportWarnings must be an array");
    out.push(...warnings);
  }
  if (!resolved) {
    out.push({ code: VERIFICATION_WARNING_CODE.TOOL_VERSION_UNKNOWN });
  }
  return { resolved, warnings: out };
}

function tryExtractClosePolicyFromMonthProof({ monthProofFiles, period }) {
  if (!(monthProofFiles instanceof Map)) return null;
  if (typeof period !== "string" || !period.trim()) return null;

  const candidates = [];
  for (const name of monthProofFiles.keys()) {
    if (!name.startsWith("artifacts/HeldExposureRollforward.v1/")) continue;
    if (!name.endsWith(".json")) continue;
    candidates.push(name);
  }
  candidates.sort();

  for (const name of candidates) {
    const parsed = parseJsonFromBytes(monthProofFiles.get(name) ?? null);
    const roll = parsed?.rollforward ?? null;
    if (!roll || typeof roll !== "object") continue;
    if (String(roll.period ?? "") !== period) continue;
    const closeHoldPolicy = roll.closeHoldPolicy ?? null;
    const closeHoldPolicySource = roll.closeHoldPolicySource ?? null;
    if (closeHoldPolicy === null && closeHoldPolicySource === null) continue;
    return { closeHoldPolicy, closeHoldPolicySource, sourceArtifact: { file: name, artifactHash: parsed?.artifactHash ?? null } };
  }
  return null;
}

function buildVerificationReportV1({ tenantId, period, createdAt, protocol, manifestHash, inputs, monthProofAttestation, signer, monthProofFiles, warnings, toolVersion }) {
  const signerKeyId = signer?.keyId && typeof signer.keyId === "string" && signer.keyId.trim() ? signer.keyId : null;
  const signerScope = signerKeyId ? (signer?.scope ?? "global") : null;
  const signerGovernanceEventRef = signerKeyId ? findSignerGovernanceEventRef({ monthProofFiles, keyId: signerKeyId }) : null;
  const closePolicyTrace = tryExtractClosePolicyFromMonthProof({ monthProofFiles, period });
  const tool = warningsWithToolVersion({ warnings, toolVersion: toolVersion ?? readRepoVersionBestEffort() });

  const core = stripUndefinedDeep({
    schemaVersion: "VerificationReport.v1",
    profile: "strict",
    tool: {
      name: "settld",
      version: tool.resolved
    },
    warnings: normalizeVerificationWarnings(tool.warnings),
    signer: signerKeyId
      ? {
          keyId: signerKeyId,
          scope: signerScope,
          governanceEventRef: signerGovernanceEventRef
        }
      : null,
    policy: closePolicyTrace
      ? {
          monthCloseHoldPolicy: closePolicyTrace.closeHoldPolicy ?? null,
          monthCloseHoldPolicySource: closePolicyTrace.closeHoldPolicySource ?? null,
          heldExposureRollforwardArtifact: closePolicyTrace.sourceArtifact ?? null
        }
      : undefined,
    subject: {
      type: FINANCE_PACK_BUNDLE_SCHEMA_VERSION_V1,
      tenantId,
      period,
      createdAt,
      protocol,
      manifestHash
    },
    inputs,
    monthProofAttestation
  });
  const reportHash = sha256Hex(canonicalJsonStringify(core));
  let signature = null;
  let signedAt = null;
  if (signer?.privateKeyPem && signerKeyId) {
    signature = signHashHexEd25519(reportHash, signer.privateKeyPem);
    signedAt = createdAt;
  }
  return stripUndefinedDeep({ ...core, reportHash, signature, signerKeyId, signedAt });
}

export function computeFinancePackBundleManifestV1({ files, period, tenantId, createdAt, protocol } = {}) {
  if (!(files instanceof Map)) throw new TypeError("files must be a Map(name -> Uint8Array)");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(createdAt, "createdAt");
  assertNonEmptyString(protocol, "protocol");

  const entries = [];
  for (const [name, bytes] of Array.from(files.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    assertNonEmptyString(name, "file name");
    assertUint8Array(bytes, `file ${name} bytes`);
    // `verify/*` files are derived outputs and intentionally excluded from the manifest.
    // This avoids circularity when a verification report wants to refer to the manifestHash.
    if (name.startsWith("verify/")) {
      continue;
    }
    entries.push({ name, sha256: sha256Hex(bytes), bytes: bytes.byteLength });
  }

  const manifest = {
    schemaVersion: FINANCE_PACK_BUNDLE_MANIFEST_SCHEMA_VERSION_V1,
    type: FINANCE_PACK_BUNDLE_SCHEMA_VERSION_V1,
    tenantId,
    period,
    createdAt,
    protocol,
    hashing: {
      schemaVersion: FINANCE_PACK_BUNDLE_MANIFEST_HASHING_SCHEMA_VERSION_V1,
      fileOrder: "path_asc",
      excludes: ["verify/**"]
    },
    files: entries
  };
  const manifestHash = sha256Hex(canonicalJsonStringify(manifest));
  return { manifest, manifestHash };
}

export function verifyFinancePackBundleManifestV1({ files, manifest }) {
  if (!(files instanceof Map)) throw new TypeError("files must be a Map");
  if (!isPlainObject(manifest)) throw new TypeError("manifest must be an object");
  if (manifest.schemaVersion !== FINANCE_PACK_BUNDLE_MANIFEST_SCHEMA_VERSION_V1) {
    return { ok: false, error: "unsupported manifest schemaVersion", schemaVersion: manifest.schemaVersion ?? null };
  }

  const expected = new Map();
  for (const f of manifest.files ?? []) {
    if (!f || typeof f !== "object") continue;
    if (typeof f.name !== "string") continue;
    expected.set(f.name, String(f.sha256 ?? ""));
  }

  for (const [name, sha] of expected.entries()) {
    const bytes = files.get(name) ?? null;
    if (!(bytes instanceof Uint8Array)) return { ok: false, error: "missing file", name };
    const actual = sha256Hex(bytes);
    if (actual !== sha) return { ok: false, error: "sha256 mismatch", name, expected: sha, actual };
  }
  return { ok: true };
}

export function buildFinancePackBundleV1({
  tenantId,
  period,
  protocol,
  createdAt,
  monthProofBundle,
  monthProofFiles,
  requireMonthProofAttestation = false,
  verificationReportSigner = null,
  verificationReportWarnings = null,
  toolVersion = null,
  glBatchArtifact,
  journalCsvArtifact,
  reconcileReport,
  reconcileReportBytes
} = {}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(protocol, "protocol");
  assertNonEmptyString(createdAt, "createdAt");
  if (!monthProofBundle || typeof monthProofBundle !== "object") throw new TypeError("monthProofBundle is required");
  if (!(monthProofFiles instanceof Map)) throw new TypeError("monthProofFiles must be a Map");
  if (requireMonthProofAttestation !== true && requireMonthProofAttestation !== false) throw new TypeError("requireMonthProofAttestation must be a boolean");
  if (verificationReportSigner !== null && typeof verificationReportSigner !== "object") throw new TypeError("verificationReportSigner must be null or an object");
  if (!glBatchArtifact || typeof glBatchArtifact !== "object") throw new TypeError("glBatchArtifact is required");
  if (!journalCsvArtifact || typeof journalCsvArtifact !== "object") throw new TypeError("journalCsvArtifact is required");
  if (!reconcileReport || typeof reconcileReport !== "object") throw new TypeError("reconcileReport is required");

  const monthProofBundleHash = monthProofBundle.manifestHash ?? null;
  assertNonEmptyString(monthProofBundleHash, "monthProofBundle.manifestHash");
  assertNonEmptyString(glBatchArtifact.artifactHash, "glBatchArtifact.artifactHash");
  assertNonEmptyString(journalCsvArtifact.artifactHash, "journalCsvArtifact.artifactHash");
  assertNonEmptyString(journalCsvArtifact.csvSha256, "journalCsvArtifact.csvSha256");
  assertNonEmptyString(journalCsvArtifact.accountMapHash, "journalCsvArtifact.accountMapHash");

  if (requireMonthProofAttestation && !monthProofFiles.has("attestation/bundle_head_attestation.json")) {
    const err = new Error("MonthProofBundle is missing attestation/bundle_head_attestation.json");
    err.code = "MONTH_PROOF_ATTESTATION_REQUIRED";
    throw err;
  }

  const files = new Map();

  // month/ contents: byte-for-byte copy of the MonthProofBundle dir structure.
  for (const [name, bytes] of Array.from(monthProofFiles.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    assertNonEmptyString(name, "month proof file name");
    assertUint8Array(bytes, `month proof file ${name}`);
    files.set(`month/${name}`, bytes);
  }

  // finance/ exports
  const encoder = new TextEncoder();
  files.set("finance/GLBatch.v1.json", encoder.encode(`${canonicalJsonStringify(glBatchArtifact)}\n`));
  files.set("finance/JournalCsv.v1.json", encoder.encode(`${canonicalJsonStringify(journalCsvArtifact)}\n`));
  files.set("finance/JournalCsv.v1.csv", encoder.encode(String(journalCsvArtifact.csv ?? "")));
  const reconcileBytes =
    reconcileReportBytes instanceof Uint8Array ? reconcileReportBytes : encoder.encode(`${canonicalJsonStringify(reconcileReport)}\n`);
  files.set("finance/reconcile.json", reconcileBytes);

  const inputs = {
    monthProofBundleHash,
    glBatchHash: String(glBatchArtifact.artifactHash),
    journalCsvHash: String(journalCsvArtifact.csvSha256),
    journalCsvArtifactHash: String(journalCsvArtifact.artifactHash),
    reconcileReportHash: sha256Hex(reconcileBytes),
    financeAccountMapHash: String(journalCsvArtifact.accountMapHash)
  };

  // settld.json header
  const header = {
    type: FINANCE_PACK_BUNDLE_SCHEMA_VERSION_V1,
    tenantId,
    period,
    createdAt,
    protocol,
    inputs
  };

  files.set("settld.json", encoder.encode(`${canonicalJsonStringify(header)}\n`));

  // VerificationReport.v1: machine-ingestible strict verification summary.
  const monthAttestation = parseJsonFromBytes(monthProofFiles.get("attestation/bundle_head_attestation.json") ?? null);
  const monthProofAttestation = monthAttestation
    ? {
        schemaVersion: String(monthAttestation.schemaVersion ?? ""),
        signerKeyId: monthAttestation.signerKeyId ?? null,
        signedAt: monthAttestation.signedAt ?? null,
        attestationHash: monthAttestation.attestationHash ?? null,
        manifestHash: monthAttestation.manifestHash ?? null,
        heads: monthAttestation.heads ?? null
      }
    : null;

  let { manifest, manifestHash } = computeFinancePackBundleManifestV1({ files, tenantId, period, createdAt, protocol });
  const verificationReportFinal = buildVerificationReportV1({
    tenantId,
    period,
    createdAt,
    protocol,
    manifestHash,
    inputs,
    monthProofAttestation,
    signer: verificationReportSigner,
    monthProofFiles,
    warnings: verificationReportWarnings,
    toolVersion
  });
  files.set("verify/verification_report.json", encoder.encode(`${canonicalJsonStringify(verificationReportFinal)}\n`));

  ({ manifest, manifestHash } = computeFinancePackBundleManifestV1({ files, tenantId, period, createdAt, protocol }));
  files.set("manifest.json", encoder.encode(`${canonicalJsonStringify({ ...manifest, manifestHash })}\n`));

  const bundle = {
    schemaVersion: FINANCE_PACK_BUNDLE_SCHEMA_VERSION_V1,
    tenantId,
    period,
    createdAt,
    protocol,
    manifestHash
  };

  return { bundle, files, manifest: { ...manifest, manifestHash } };
}
