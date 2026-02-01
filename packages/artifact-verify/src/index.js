import { canonicalJsonStringify } from "./canonical-json.js";
import { hmacSha256Hex, sha256HexUtf8 } from "./crypto.js";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

export const SUPPORTED_ARTIFACT_TYPES = Object.freeze([
  "WorkCertificate.v1",
  "ProofReceipt.v1",
  "IncidentPacket.v1",
  "CreditMemo.v1",
  "SettlementStatement.v1",
  "MonthlyStatement.v1",
  "HeldExposureRollforward.v1",
  "PartyStatement.v1",
  "PayoutInstruction.v1",
  "GLBatch.v1",
  "JournalCsv.v1",
  "FinancePackBundle.v1",
  "CoverageCertificate.v1"
]);

const SUPPORTED_ARTIFACT_TYPE_SET = new Set(SUPPORTED_ARTIFACT_TYPES);

export function verifyArtifactVersion(artifact) {
  assertPlainObject(artifact, "artifact");
  const artifactTypeRaw = artifact?.artifactType ?? artifact?.schemaVersion ?? null;
  const artifactType = typeof artifactTypeRaw === "string" ? artifactTypeRaw : null;
  if (!artifactType || !artifactType.trim()) return { ok: false, error: "missing artifactType" };
  if (!SUPPORTED_ARTIFACT_TYPE_SET.has(artifactType)) return { ok: false, error: "unsupported artifactType", artifactType };

  const schemaVersionRaw = artifact?.schemaVersion ?? null;
  if (schemaVersionRaw === null || schemaVersionRaw === undefined) return { ok: true, artifactType, assumed: "missing schemaVersion" };
  const schemaVersion = typeof schemaVersionRaw === "string" ? schemaVersionRaw : null;
  if (!schemaVersion || !schemaVersion.trim()) return { ok: false, error: "invalid schemaVersion" };
  if (schemaVersion !== artifactType) return { ok: false, error: "schemaVersion mismatch", expected: artifactType, actual: schemaVersion };
  return { ok: true, artifactType };
}

export function computeArtifactHash(artifactJson) {
  assertPlainObject(artifactJson, "artifactJson");
  if (artifactJson.artifactHash !== undefined) throw new TypeError("artifactJson must not include artifactHash when hashing");
  return sha256HexUtf8(canonicalJsonStringify(artifactJson));
}

export function verifyArtifactHash(artifact) {
  assertPlainObject(artifact, "artifact");
  const actual = artifact.artifactHash ?? null;
  if (typeof actual !== "string" || actual.trim() === "") return { ok: false, error: "missing artifactHash" };
  const { artifactHash: _ignored, ...core } = artifact;
  let expected;
  try {
    expected = computeArtifactHash(core);
  } catch (err) {
    return { ok: false, error: err?.message ?? "failed to hash artifact" };
  }
  if (expected !== actual) return { ok: false, error: "artifactHash mismatch", expected, actual };
  return { ok: true, expected, actual };
}

export function verifyWebhookSignature({ secret, timestamp, bodyJson, signatureHex }) {
  assertNonEmptyString(secret, "secret");
  assertNonEmptyString(timestamp, "timestamp");
  assertPlainObject(bodyJson, "bodyJson");
  assertNonEmptyString(signatureHex, "signatureHex");

  const body = canonicalJsonStringify(bodyJson);
  const data = `${timestamp}.${body}`;
  const expected = hmacSha256Hex({ secret, value: data });
  if (expected !== signatureHex) return { ok: false, error: "bad signature", expected, actual: signatureHex };
  return { ok: true };
}

export function verifySettlementBalances(artifact) {
  assertPlainObject(artifact, "artifact");
  const totals = artifact?.settlement?.totalsByAccountId ?? null;
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) return { ok: true, skipped: "no totalsByAccountId" };
  let sum = 0;
  for (const v of Object.values(totals)) {
    if (!Number.isFinite(v)) return { ok: false, error: "non-numeric posting total" };
    sum += v;
  }
  if (sum !== 0) return { ok: false, error: "postings do not balance", sum };
  return { ok: true };
}

export { reconcileGlBatchAgainstPartyStatements } from "./reconcile.js";
export { verifyFinancePackBundleDir } from "./finance-pack-bundle.js";
export { verifyJobProofBundleDir, verifyMonthProofBundleDir } from "./job-proof-bundle.js";
