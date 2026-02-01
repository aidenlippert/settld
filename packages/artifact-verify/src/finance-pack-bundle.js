import fs from "node:fs/promises";
import path from "node:path";

import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256HexBytes, sha256HexUtf8, verifyHashHexEd25519 } from "./crypto.js";
import { verifyMonthProofBundleDir } from "./job-proof-bundle.js";
import { reconcileGlBatchAgainstPartyStatements } from "./reconcile.js";
import { validateVerificationWarnings } from "./verification-warnings.js";

export const FINANCE_PACK_BUNDLE_TYPE_V1 = "FinancePackBundle.v1";
export const FINANCE_PACK_BUNDLE_MANIFEST_SCHEMA_V1 = "FinancePackBundleManifest.v1";

async function readJson(filepath) {
  const raw = await fs.readFile(filepath, "utf8");
  return JSON.parse(raw);
}

async function readBytes(filepath) {
  return new Uint8Array(await fs.readFile(filepath));
}

function stripManifestHash(manifestWithHash) {
  const { manifestHash: _ignored, ...rest } = manifestWithHash ?? {};
  return rest;
}

function verifyArtifactTypeAndHash({ artifact, expectedType }) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return { ok: false, error: "invalid artifact JSON" };
  const artifactType = typeof artifact.artifactType === "string" ? artifact.artifactType : null;
  const schemaVersion = typeof artifact.schemaVersion === "string" ? artifact.schemaVersion : null;
  const artifactHash = typeof artifact.artifactHash === "string" ? artifact.artifactHash : null;
  if (artifactType !== expectedType) return { ok: false, error: "artifactType mismatch", expected: expectedType, actual: artifactType };
  if (schemaVersion && schemaVersion !== expectedType) return { ok: false, error: "schemaVersion mismatch", expected: expectedType, actual: schemaVersion };
  if (!artifactHash) return { ok: false, error: "missing artifactHash" };
  const { artifactHash: _ignored, ...core } = artifact;
  const expectedHash = sha256HexUtf8(canonicalJsonStringify(core));
  if (expectedHash !== artifactHash) return { ok: false, error: "artifactHash mismatch", expected: expectedHash, actual: artifactHash };
  return { ok: true, artifactType, artifactHash };
}

function stripVerificationReportSig(report) {
  const { reportHash: _h, signature: _sig, signerKeyId: _kid, signedAt: _signedAt, ...rest } = report ?? {};
  return rest;
}

function parsePublicKeysV1(keysJson) {
  const publicKeyByKeyId = new Map();
  const keyMetaByKeyId = new Map();
  const schemaVersion = typeof keysJson?.schemaVersion === "string" ? keysJson.schemaVersion : null;
  if (schemaVersion !== "PublicKeys.v1") return { ok: false, error: "unsupported keys schemaVersion", schemaVersion };
  const keys = Array.isArray(keysJson?.keys) ? keysJson.keys : [];
  for (const k of keys) {
    if (!k || typeof k !== "object") continue;
    const keyId = typeof k.keyId === "string" && k.keyId.trim() ? k.keyId : null;
    const publicKeyPem = typeof k.publicKeyPem === "string" && k.publicKeyPem.trim() ? k.publicKeyPem : null;
    if (!keyId || !publicKeyPem) continue;
    publicKeyByKeyId.set(keyId, publicKeyPem);
    keyMetaByKeyId.set(keyId, k);
  }
  return { ok: true, publicKeyByKeyId, keyMetaByKeyId };
}

function verifyVerificationReportV1({ report, expectedManifestHash, monthPublicKeys, strict }) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return { ok: false, error: "invalid verification report JSON" };
  if (String(report.schemaVersion ?? "") !== "VerificationReport.v1") return { ok: false, error: "unsupported verification report schemaVersion" };
  if (String(report.profile ?? "") !== "strict") return { ok: false, error: "unsupported verification report profile", profile: report.profile ?? null };
  const warningsCheck = validateVerificationWarnings(report.warnings ?? null);
  if (!warningsCheck.ok) return { ok: false, error: `verification report warnings invalid: ${warningsCheck.error}`, detail: warningsCheck };

  const subject = report.subject ?? null;
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return { ok: false, error: "invalid verification report subject" };
  if (String(subject.type ?? "") !== FINANCE_PACK_BUNDLE_TYPE_V1) return { ok: false, error: "verification report subject.type mismatch", expected: FINANCE_PACK_BUNDLE_TYPE_V1, actual: subject.type ?? null };
  if (String(subject.manifestHash ?? "") !== String(expectedManifestHash ?? "")) {
    return { ok: false, error: "verification report subject.manifestHash mismatch", expected: expectedManifestHash ?? null, actual: subject.manifestHash ?? null };
  }

  const expectedReportHash = sha256HexUtf8(canonicalJsonStringify(stripVerificationReportSig(report)));
  const actualReportHash = typeof report.reportHash === "string" ? report.reportHash : null;
  if (!actualReportHash) return { ok: false, error: "verification report missing reportHash" };
  if (expectedReportHash !== actualReportHash) {
    return { ok: false, error: "verification report reportHash mismatch", expected: expectedReportHash, actual: actualReportHash };
  }

  const signature = typeof report.signature === "string" && report.signature.trim() ? report.signature : null;
  const signerKeyId = typeof report.signerKeyId === "string" && report.signerKeyId.trim() ? report.signerKeyId : null;
  const signedAt = typeof report.signedAt === "string" && report.signedAt.trim() ? report.signedAt : null;
  if (strict && (!signature || !signerKeyId || !signedAt)) {
    return { ok: false, error: "verification report missing signature", signature: Boolean(signature), signerKeyId, signedAt };
  }

  // Optional signer provenance object must be internally consistent when present.
  const signer = report.signer ?? null;
  if (signer !== null && signer !== undefined) {
    if (!signer || typeof signer !== "object" || Array.isArray(signer)) return { ok: false, error: "verification report signer must be an object" };
    if (typeof signer.keyId !== "string" || !signer.keyId.trim()) return { ok: false, error: "verification report signer.keyId missing" };
    if (signerKeyId && signer.keyId !== signerKeyId) return { ok: false, error: "verification report signer.keyId mismatch", expected: signerKeyId, actual: signer.keyId };
    if (signer.scope !== undefined && signer.scope !== null) {
      const scope = String(signer.scope);
      if (scope !== "global" && scope !== "tenant") return { ok: false, error: "verification report signer.scope invalid", scope };
    }
  }

  if (signature && signerKeyId) {
    const publicKeyPem = monthPublicKeys?.publicKeyByKeyId?.get?.(signerKeyId) ?? null;
    if (!publicKeyPem) return { ok: false, error: "verification report signerKeyId not found in month keys", signerKeyId };
    const ok = verifyHashHexEd25519({ hashHex: actualReportHash, signatureBase64: signature, publicKeyPem });
    if (!ok) return { ok: false, error: "verification report signature invalid", signerKeyId };
  }

  return { ok: true, reportHash: actualReportHash, signerKeyId: signerKeyId ?? null };
}

export async function verifyFinancePackBundleDir({ dir, strict = false } = {}) {
  if (!dir) throw new Error("dir is required");
  if (strict !== true && strict !== false) throw new TypeError("strict must be a boolean");

  const settldPath = path.join(dir, "settld.json");
  const manifestPath = path.join(dir, "manifest.json");

  const header = await readJson(settldPath);
  if (header?.type !== FINANCE_PACK_BUNDLE_TYPE_V1) {
    return { ok: false, error: "unsupported bundle type", type: header?.type ?? null };
  }

  const manifestWithHash = await readJson(manifestPath);
  if (manifestWithHash?.schemaVersion !== FINANCE_PACK_BUNDLE_MANIFEST_SCHEMA_V1) {
    return { ok: false, error: "unsupported manifest schemaVersion", schemaVersion: manifestWithHash?.schemaVersion ?? null };
  }

  const expectedManifestHash = String(manifestWithHash?.manifestHash ?? "");
  if (!expectedManifestHash) return { ok: false, error: "manifest missing manifestHash" };
  const manifestCore = stripManifestHash(manifestWithHash);
  const actualManifestHash = sha256HexUtf8(canonicalJsonStringify(manifestCore));
  if (actualManifestHash !== expectedManifestHash) {
    return { ok: false, error: "manifestHash mismatch", expected: expectedManifestHash, actual: actualManifestHash };
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
    if (actual !== expectedSha) return { ok: false, error: "sha256 mismatch", name, expected: expectedSha, actual };
  }

  // Anchor checks (best-effort, but deterministic).
  const inputs = header?.inputs ?? {};

  // MonthProofBundle anchor and strict verification (if requested).
  const monthDir = path.join(dir, "month");
  let monthStrict = null;
  if (strict) {
    monthStrict = await verifyMonthProofBundleDir({ dir: monthDir, strict: true });
    if (!monthStrict.ok) return { ok: false, error: "month proof strict verification failed", detail: monthStrict };
  }

  // MonthProofBundle anchor: compare against the nested month/manifest.json manifestHash.
  const monthManifest = await readJson(path.join(monthDir, "manifest.json"));
  const monthManifestHash = String(monthManifest?.manifestHash ?? "");
  if (typeof inputs?.monthProofBundleHash === "string" && inputs.monthProofBundleHash !== monthManifestHash) {
    return { ok: false, error: "monthProofBundleHash mismatch", expected: inputs.monthProofBundleHash, actual: monthManifestHash };
  }

  // VerificationReport.v1 (strict requires it, signed).
  let verificationReport = null;
  try {
    verificationReport = await readJson(path.join(dir, "verify", "verification_report.json"));
  } catch {
    verificationReport = null;
  }
  if (strict && !verificationReport) return { ok: false, error: "missing verify/verification_report.json" };

  let verificationReportVerify = null;
  if (verificationReport) {
    let monthPublicKeys = null;
    try {
      const keysJson = await readJson(path.join(monthDir, "keys", "public_keys.json"));
      monthPublicKeys = parsePublicKeysV1(keysJson);
    } catch {
      monthPublicKeys = null;
    }
    verificationReportVerify = verifyVerificationReportV1({
      report: verificationReport,
      expectedManifestHash,
      monthPublicKeys: monthPublicKeys?.ok ? monthPublicKeys : null,
      strict
    });
    if (!verificationReportVerify.ok) return { ok: false, error: "verification report invalid", detail: verificationReportVerify };
  }

  // GLBatch artifact hash and version checks.
  const glBatch = await readJson(path.join(dir, "finance", "GLBatch.v1.json"));
  const glHash = verifyArtifactTypeAndHash({ artifact: glBatch, expectedType: "GLBatch.v1" });
  if (!glHash.ok) return { ok: false, error: `GLBatch: ${glHash.error}`, detail: glHash };
  if (typeof inputs?.glBatchHash === "string" && inputs.glBatchHash !== glBatch.artifactHash) {
    return { ok: false, error: "glBatchHash mismatch", expected: inputs.glBatchHash, actual: glBatch.artifactHash };
  }

  // JournalCsv artifact checks + csv bytes hash.
  const journalCsv = await readJson(path.join(dir, "finance", "JournalCsv.v1.json"));
  const csvBytes = await readBytes(path.join(dir, "finance", "JournalCsv.v1.csv"));
  const csvSha = sha256HexBytes(csvBytes);
  const csvHash = verifyArtifactTypeAndHash({ artifact: journalCsv, expectedType: "JournalCsv.v1" });
  if (!csvHash.ok) return { ok: false, error: `JournalCsv: ${csvHash.error}`, detail: csvHash };
  if (typeof journalCsv?.csvSha256 === "string" && journalCsv.csvSha256 !== csvSha) {
    return { ok: false, error: "journalCsv.csvSha256 mismatch", expected: journalCsv.csvSha256, actual: csvSha };
  }
  if (typeof inputs?.journalCsvHash === "string" && inputs.journalCsvHash !== csvSha) {
    return { ok: false, error: "journalCsvHash mismatch", expected: inputs.journalCsvHash, actual: csvSha };
  }
  if (typeof inputs?.journalCsvArtifactHash === "string" && inputs.journalCsvArtifactHash !== journalCsv.artifactHash) {
    return { ok: false, error: "journalCsvArtifactHash mismatch", expected: inputs.journalCsvArtifactHash, actual: journalCsv.artifactHash };
  }
  if (typeof inputs?.financeAccountMapHash === "string" && inputs.financeAccountMapHash !== journalCsv.accountMapHash) {
    return { ok: false, error: "financeAccountMapHash mismatch", expected: inputs.financeAccountMapHash, actual: journalCsv.accountMapHash };
  }

  // Reconcile: compare stored reconcile.json with recomputed result.
  const reconcileOnDisk = await readJson(path.join(dir, "finance", "reconcile.json"));
  const partyStatementsDir = path.join(dir, "month", "artifacts", "PartyStatement.v1");
  const partyStatements = [];
  try {
    const psEntries = (await fs.readdir(partyStatementsDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(partyStatementsDir, e.name))
      .sort();
    for (const fp of psEntries) {
      // eslint-disable-next-line no-await-in-loop
      partyStatements.push(await readJson(fp));
    }
  } catch {
    // If party statements aren't present, skip recompute (still have manifest + hashes).
  }

  if (partyStatements.length) {
    const reconcileComputed = reconcileGlBatchAgainstPartyStatements({ glBatch, partyStatements });
    if (!reconcileComputed.ok) return { ok: false, error: `reconcile failed: ${reconcileComputed.error}`, detail: reconcileComputed };
    if (canonicalJsonStringify(reconcileComputed) !== canonicalJsonStringify(reconcileOnDisk)) {
      return { ok: false, error: "reconcile.json mismatch", expected: reconcileComputed, actual: reconcileOnDisk };
    }
  }

  const reconcileBytes = await readBytes(path.join(dir, "finance", "reconcile.json"));
  const reconcileSha = sha256HexBytes(reconcileBytes);
  if (typeof inputs?.reconcileReportHash === "string" && inputs.reconcileReportHash !== reconcileSha) {
    return { ok: false, error: "reconcileReportHash mismatch", expected: inputs.reconcileReportHash, actual: reconcileSha };
  }

  return {
    ok: true,
    strict,
    monthStrict: monthStrict?.ok ? monthStrict : null,
    verificationReport: verificationReportVerify?.ok ? verificationReportVerify : null,
    type: header.type,
    period: header.period,
    tenantId: header.tenantId,
    manifestHash: expectedManifestHash
  };
}
