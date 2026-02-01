import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";
import { signHashHexEd25519 } from "./crypto.js";
import { verifyChainedEvents } from "./event-chain.js";
import { computeArtifactHash } from "./artifacts.js";
import { compileContractPolicyTemplate } from "./contract-compiler.js";
import { DEFAULT_TENANT_ID } from "./tenancy.js";
import { VERIFICATION_WARNING_CODE, normalizeVerificationWarnings } from "./verification-warnings.js";
import fs from "node:fs";
import path from "node:path";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function normalizeIsoOrNull(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const s = String(value).trim();
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? s : null;
}

function buildPublicKeysFileV1({ tenantId, generatedAt, publicKeyByKeyId, signerKeys = [], keyIds = null } = {}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(generatedAt, "generatedAt");
  if (!(publicKeyByKeyId instanceof Map)) throw new TypeError("publicKeyByKeyId must be a Map");
  if (!Array.isArray(signerKeys)) throw new TypeError("signerKeys must be an array");

  const metaByKeyId = new Map();
  for (const r of signerKeys) {
    if (!r || typeof r !== "object") continue;
    const recTenantId = String(r.tenantId ?? "");
    // Server signer keys can be global (stored under DEFAULT_TENANT_ID) but used across tenants.
    if (recTenantId !== tenantId && recTenantId !== DEFAULT_TENANT_ID) continue;
    const kid = typeof r.keyId === "string" && r.keyId.trim() ? r.keyId : null;
    if (!kid) continue;
    metaByKeyId.set(kid, r);
  }

  const needed = new Set(Array.isArray(keyIds) ? keyIds.filter((k) => typeof k === "string" && k.trim()) : Array.from(publicKeyByKeyId.keys()));
  const keys = [];
  for (const keyId of Array.from(needed).sort()) {
    const publicKeyPem = publicKeyByKeyId.get(keyId) ?? null;
    if (!publicKeyPem) continue;
    const meta = metaByKeyId.get(keyId) ?? null;
    keys.push({
      keyId,
      publicKeyPem: String(publicKeyPem),
      tenantId: meta?.tenantId ?? tenantId,
      purpose: meta?.purpose ?? null,
      status: meta?.status ?? null,
      description: meta?.description ?? null,
      validFrom: normalizeIsoOrNull(meta?.validFrom ?? null),
      validTo: normalizeIsoOrNull(meta?.validTo ?? null),
      createdAt: normalizeIsoOrNull(meta?.createdAt ?? null),
      rotatedAt: normalizeIsoOrNull(meta?.rotatedAt ?? null),
      revokedAt: normalizeIsoOrNull(meta?.revokedAt ?? null)
    });
  }

  keys.sort((a, b) => String(a.keyId).localeCompare(String(b.keyId)));

  return {
    schemaVersion: "PublicKeys.v1",
    tenantId,
    generatedAt,
    order: "keyId_asc",
    keys
  };
}

export const JOB_PROOF_BUNDLE_SCHEMA_VERSION_V1 = "JobProofBundle.v1";
export const MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1 = "MonthProofBundle.v1";
export const BUNDLE_HEAD_ATTESTATION_SCHEMA_V1 = "BundleHeadAttestation.v1";
export const PROOF_BUNDLE_MANIFEST_HASHING_SCHEMA_VERSION_V1 = "ProofBundleManifestHash.v1";

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

function computeBundleHeads({ jobSnapshot, tenantGovernanceSnapshot, governanceSnapshot } = {}) {
  return {
    job: {
      lastEventId: jobSnapshot?.lastEventId ?? jobSnapshot?.lastEvent?.id ?? null,
      lastChainHash: jobSnapshot?.lastChainHash ?? jobSnapshot?.lastEvent?.chainHash ?? null
    },
    governance: {
      tenant: tenantGovernanceSnapshot ? { lastEventId: tenantGovernanceSnapshot.lastEventId ?? null, lastChainHash: tenantGovernanceSnapshot.lastChainHash ?? null } : null,
      global: governanceSnapshot ? { lastEventId: governanceSnapshot.lastEventId ?? null, lastChainHash: governanceSnapshot.lastChainHash ?? null } : null
    }
  };
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
      return [];
    }
  }
  return out;
}

function readRepoVersionBestEffort() {
  try {
    const p = path.resolve(process.cwd(), "SETTLD_VERSION");
    const raw = fs.readFileSync(p, "utf8");
    const v = String(raw).trim();
    return v || null;
  } catch {
    return null;
  }
}

function findSignerGovernanceEventRef({ bundleFiles, keyId }) {
  if (!(bundleFiles instanceof Map)) return null;
  if (typeof keyId !== "string" || !keyId.trim()) return null;
  const raw = bundleFiles.get("governance/global/events/events.jsonl") ?? null;
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

function warningsWithToolVersion({ warnings, toolVersion }) {
  const resolved = typeof toolVersion === "string" && toolVersion.trim() ? toolVersion.trim() : null;
  const out = [];
  if (warnings !== null && warnings !== undefined) {
    if (!Array.isArray(warnings)) throw new TypeError("warnings must be an array");
    out.push(...warnings);
  }
  if (!resolved) out.push({ code: VERIFICATION_WARNING_CODE.TOOL_VERSION_UNKNOWN });
  return { resolved, warnings: out };
}

function buildVerificationReportV1ForProofBundle({
  kind,
  tenantId,
  scope,
  generatedAt,
  manifestHash,
  bundleHeadAttestation,
  signer,
  bundleFiles,
  warnings,
  toolVersion
} = {}) {
  assertNonEmptyString(kind, "kind");
  assertNonEmptyString(tenantId, "tenantId");
  if (!isPlainObject(scope)) throw new TypeError("scope must be an object");
  assertNonEmptyString(generatedAt, "generatedAt");
  assertNonEmptyString(manifestHash, "manifestHash");

  const signerKeyId = signer?.keyId && typeof signer.keyId === "string" && signer.keyId.trim() ? signer.keyId : null;
  const signerScope = signerKeyId ? (signer?.scope ?? "global") : null;
  const signerGovernanceEventRef = signerKeyId ? findSignerGovernanceEventRef({ bundleFiles, keyId: signerKeyId }) : null;
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
    bundleHeadAttestation:
      bundleHeadAttestation && typeof bundleHeadAttestation === "object"
        ? {
            schemaVersion: bundleHeadAttestation.schemaVersion ?? null,
            attestationHash: bundleHeadAttestation.attestationHash ?? null,
            signerKeyId: bundleHeadAttestation.signerKeyId ?? null,
            signedAt: bundleHeadAttestation.signedAt ?? null,
            manifestHash: bundleHeadAttestation.manifestHash ?? null
          }
        : null,
    subject: {
      type: kind,
      tenantId,
      createdAt: generatedAt,
      manifestHash,
      scope
    }
  });

  const reportHash = sha256Hex(canonicalJsonStringify(core));
  let signature = null;
  let signedAt = null;
  if (signer?.privateKeyPem && signerKeyId) {
    signature = signHashHexEd25519(reportHash, signer.privateKeyPem);
    signedAt = generatedAt;
  }
  return stripUndefinedDeep({ ...core, reportHash, signature, signerKeyId, signedAt });
}

function buildBundleHeadAttestationV1({ kind, tenantId, scope, generatedAt, manifestHash, heads, signer } = {}) {
  assertNonEmptyString(kind, "kind");
  assertNonEmptyString(tenantId, "tenantId");
  if (!isPlainObject(scope)) throw new TypeError("scope must be an object");
  assertNonEmptyString(generatedAt, "generatedAt");
  assertNonEmptyString(manifestHash, "manifestHash");
  if (!isPlainObject(heads)) throw new TypeError("heads must be an object");
  if (!signer || typeof signer !== "object") throw new TypeError("signer is required");
  assertNonEmptyString(signer.keyId, "signer.keyId");
  assertNonEmptyString(signer.privateKeyPem, "signer.privateKeyPem");

  const signedAt = generatedAt;
  const core = stripUndefinedDeep({
    schemaVersion: BUNDLE_HEAD_ATTESTATION_SCHEMA_V1,
    kind,
    tenantId,
    scope,
    generatedAt,
    manifestHash,
    heads,
    signedAt,
    signerKeyId: signer.keyId
  });
  const attestationHash = sha256Hex(canonicalJsonStringify(core));
  const signature = signHashHexEd25519(attestationHash, signer.privateKeyPem);
  return { ...core, attestationHash, signature };
}

export function canonicalJsonlLines(values) {
  if (!Array.isArray(values)) throw new TypeError("values must be an array");
  return values.map((v) => `${canonicalJsonStringify(v)}\n`).join("");
}

export function computeProofBundleManifestV1({ files, generatedAt, kind, tenantId, scope } = {}) {
  if (!(files instanceof Map)) throw new TypeError("files must be a Map(name -> bytes)");
  assertNonEmptyString(generatedAt, "generatedAt");
  assertNonEmptyString(kind, "kind");
  assertNonEmptyString(tenantId, "tenantId");
  if (!isPlainObject(scope)) throw new TypeError("scope must be an object");

  const entries = [];
  for (const [name, bytes] of Array.from(files.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    assertNonEmptyString(name, "file name");
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`file ${name} bytes must be a Uint8Array`);
    // `verify/*` files are derived outputs and intentionally excluded from the manifest.
    // This avoids circular hashing when a verification report wants to refer to the manifestHash.
    if (name.startsWith("verify/")) continue;
    entries.push({
      name,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength
    });
  }

  const manifest = {
    schemaVersion: "ProofBundleManifest.v1",
    kind,
    tenantId,
    scope,
    generatedAt,
    hashing: {
      schemaVersion: PROOF_BUNDLE_MANIFEST_HASHING_SCHEMA_VERSION_V1,
      fileOrder: "path_asc",
      excludes: ["verify/**"]
    },
    files: entries
  };
  const manifestHash = sha256Hex(canonicalJsonStringify(manifest));
  return { manifest, manifestHash };
}

export function verifyProofBundleManifestV1({ files, manifest }) {
  if (!(files instanceof Map)) throw new TypeError("files must be a Map");
  if (!isPlainObject(manifest)) throw new TypeError("manifest must be an object");
  if (manifest.schemaVersion !== "ProofBundleManifest.v1") return { ok: false, error: "unsupported manifest schemaVersion" };

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

function verifyArtifacts(artifacts) {
  const results = [];
  for (const a of Array.isArray(artifacts) ? artifacts : []) {
    if (!a || typeof a !== "object") continue;
    const artifactType = typeof a.artifactType === "string" ? a.artifactType : null;
    const schemaVersion = typeof a.schemaVersion === "string" ? a.schemaVersion : null;
    const artifactHash = typeof a.artifactHash === "string" ? a.artifactHash : null;
    let ok = true;
    let error = null;
    let expectedHash = null;
    try {
      if (!artifactType) throw new Error("missing artifactType");
      if (schemaVersion && schemaVersion !== artifactType) throw new Error("schemaVersion mismatch");
      if (!artifactHash) throw new Error("missing artifactHash");
      const { artifactHash: _ignored, ...core } = a;
      expectedHash = computeArtifactHash(core);
      if (expectedHash !== artifactHash) throw new Error("artifactHash mismatch");
    } catch (err) {
      ok = false;
      error = err?.message ?? "artifact verification failed";
    }
    results.push({ artifactType, artifactId: a.artifactId ?? null, artifactHash, ok, error, expectedHash });
  }
  return results;
}

function verifyEventChain(events, publicKeyByKeyId) {
  try {
    const res = verifyChainedEvents(events, { publicKeyByKeyId });
    if (!res?.ok) return { ok: false, error: res?.error ?? "event chain invalid" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? "event chain verification failed" };
  }
}

function verifySettlementProofRefs(events) {
  const result = { ok: true, checked: 0, errors: [] };
  if (!Array.isArray(events) || events.length === 0) return { ok: true, checked: 0, errors: [] };

  const byId = new Map();
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (typeof e.id === "string" && e.id.trim()) byId.set(e.id, e);
  }

  for (const settled of events) {
    if (settled?.type !== "SETTLED") continue;
    result.checked += 1;
    const ref = settled?.payload?.settlementProofRef ?? null;
    if (!ref || typeof ref !== "object") {
      result.ok = false;
      result.errors.push({ error: "missing settlementProofRef", settledEventId: settled?.id ?? null });
      continue;
    }

    const proofEventId = typeof ref.proofEventId === "string" ? ref.proofEventId : null;
    const proofEvent = proofEventId ? byId.get(proofEventId) ?? null : null;
    if (!proofEvent) {
      result.ok = false;
      result.errors.push({ error: "missing referenced proof event", settledEventId: settled?.id ?? null, proofEventId });
      continue;
    }
    if (proofEvent.type !== "PROOF_EVALUATED") {
      result.ok = false;
      result.errors.push({ error: "referenced event is not PROOF_EVALUATED", settledEventId: settled?.id ?? null, proofEventId, type: proofEvent.type ?? null });
      continue;
    }

    if (ref.proofEventChainHash && ref.proofEventChainHash !== proofEvent.chainHash) {
      result.ok = false;
      result.errors.push({ error: "proofEventChainHash mismatch", settledEventId: settled?.id ?? null, proofEventId });
    }
    if (ref.proofEventPayloadHash && ref.proofEventPayloadHash !== proofEvent.payloadHash) {
      result.ok = false;
      result.errors.push({ error: "proofEventPayloadHash mismatch", settledEventId: settled?.id ?? null, proofEventId });
    }

    const p = proofEvent.payload ?? null;
    if (!p || typeof p !== "object") {
      result.ok = false;
      result.errors.push({ error: "proof event missing payload", settledEventId: settled?.id ?? null, proofEventId });
      continue;
    }

    if (ref.factsHash && ref.factsHash !== p.factsHash) {
      result.ok = false;
      result.errors.push({ error: "factsHash mismatch", settledEventId: settled?.id ?? null, proofEventId });
    }
    if (ref.evaluatedAtChainHash && ref.evaluatedAtChainHash !== p.evaluatedAtChainHash) {
      result.ok = false;
      result.errors.push({ error: "evaluatedAtChainHash mismatch", settledEventId: settled?.id ?? null, proofEventId });
    }

    const proofStatus = p.status ?? null;
    const settlementStatus = ref.status ?? null;
    const forfeit = ref.forfeit && typeof ref.forfeit === "object" ? ref.forfeit : null;
    const statusOk =
      proofStatus === settlementStatus || (forfeit && proofStatus === "INSUFFICIENT_EVIDENCE" && settlementStatus === "FAIL");
    if (!statusOk) {
      result.ok = false;
      result.errors.push({
        error: "settlement status does not match referenced proof",
        settledEventId: settled?.id ?? null,
        proofEventId,
        proofStatus,
        settlementStatus
      });
    }

    // Forfeit settlements must reference a forfeiture event as well.
    if (forfeit) {
      const forfeitEventId = typeof forfeit.forfeitEventId === "string" ? forfeit.forfeitEventId : null;
      const forfeitEvent = forfeitEventId ? byId.get(forfeitEventId) ?? null : null;
      if (!forfeitEvent || forfeitEvent.type !== "SETTLEMENT_FORFEITED") {
        result.ok = false;
        result.errors.push({
          error: "missing referenced forfeiture event",
          settledEventId: settled?.id ?? null,
          forfeitEventId
        });
      } else {
        if (forfeit.forfeitEventChainHash && forfeit.forfeitEventChainHash !== forfeitEvent.chainHash) {
          result.ok = false;
          result.errors.push({ error: "forfeitEventChainHash mismatch", settledEventId: settled?.id ?? null, forfeitEventId });
        }
        if (forfeit.forfeitEventPayloadHash && forfeit.forfeitEventPayloadHash !== forfeitEvent.payloadHash) {
          result.ok = false;
          result.errors.push({ error: "forfeitEventPayloadHash mismatch", settledEventId: settled?.id ?? null, forfeitEventId });
        }
      }
    }
  }

  return result;
}

function compilePolicySnapshotForContractDoc(contractDoc) {
  if (!contractDoc || typeof contractDoc !== "object") return null;
  try {
    const { policyTemplate, policyHash, compilerId } = compileContractPolicyTemplate({ contractDoc });
    return { policySnapshot: policyTemplate, policyHash, compilerId };
  } catch {
    return null;
  }
}

export function buildJobProofBundleV1({
  tenantId,
  jobId,
  jobEvents,
  jobSnapshot,
  governanceEvents = null,
  governanceSnapshot = null,
  tenantGovernanceEvents = null,
  tenantGovernanceSnapshot = null,
  artifacts,
  contractDocsByHash = new Map(),
  publicKeyByKeyId = new Map(),
  signerKeys = [],
  manifestSigner = null,
  requireHeadAttestation = false,
  generatedAt
} = {}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(jobId, "jobId");
  if (!Array.isArray(jobEvents) || jobEvents.length === 0) throw new TypeError("jobEvents is required");
  if (!jobSnapshot || typeof jobSnapshot !== "object") throw new TypeError("jobSnapshot is required");
  if (governanceEvents !== null && !Array.isArray(governanceEvents)) throw new TypeError("governanceEvents must be null or an array");
  if (governanceSnapshot !== null && typeof governanceSnapshot !== "object") throw new TypeError("governanceSnapshot must be null or an object");
  if (tenantGovernanceEvents !== null && !Array.isArray(tenantGovernanceEvents)) throw new TypeError("tenantGovernanceEvents must be null or an array");
  if (tenantGovernanceSnapshot !== null && typeof tenantGovernanceSnapshot !== "object") {
    throw new TypeError("tenantGovernanceSnapshot must be null or an object");
  }
  if (!Array.isArray(artifacts)) throw new TypeError("artifacts must be an array");
  if (!(contractDocsByHash instanceof Map)) throw new TypeError("contractDocsByHash must be a Map");
  if (!(publicKeyByKeyId instanceof Map)) throw new TypeError("publicKeyByKeyId must be a Map");
  if (!Array.isArray(signerKeys)) throw new TypeError("signerKeys must be an array");
  if (manifestSigner !== null && typeof manifestSigner !== "object") throw new TypeError("manifestSigner must be null or an object");
  if (requireHeadAttestation !== true && requireHeadAttestation !== false) throw new TypeError("requireHeadAttestation must be a boolean");
  assertNonEmptyString(generatedAt, "generatedAt");

  if (requireHeadAttestation && !manifestSigner) {
    const err = new Error("manifestSigner is required to produce a bundle head attestation");
    err.code = "MANIFEST_SIGNER_REQUIRED";
    throw err;
  }

  const files = new Map();
  let tenantGovSnapshotUsed = null;
  let globalGovSnapshotUsed = null;

  // Event bytes used for payloadHash material (the "physics" bytes).
  const payloadMaterial = jobEvents.map((e) => ({
    v: e?.v ?? null,
    id: e?.id ?? null,
    at: e?.at ?? null,
    streamId: e?.streamId ?? null,
    type: e?.type ?? null,
    actor: e?.actor ?? null,
    payload: e?.payload ?? null
  }));
  files.set("events/payload_material.jsonl", new TextEncoder().encode(canonicalJsonlLines(payloadMaterial)));
  files.set("events/events.jsonl", new TextEncoder().encode(canonicalJsonlLines(jobEvents)));

  files.set("job/snapshot.json", new TextEncoder().encode(`${canonicalJsonStringify(jobSnapshot)}\n`));

  if (Array.isArray(tenantGovernanceEvents)) {
    const govMaterial = tenantGovernanceEvents.map((e) => ({
      v: e?.v ?? null,
      id: e?.id ?? null,
      at: e?.at ?? null,
      streamId: e?.streamId ?? null,
      type: e?.type ?? null,
      actor: e?.actor ?? null,
      payload: e?.payload ?? null
    }));
    files.set("governance/tenant/events/payload_material.jsonl", new TextEncoder().encode(canonicalJsonlLines(govMaterial)));
    files.set("governance/tenant/events/events.jsonl", new TextEncoder().encode(canonicalJsonlLines(tenantGovernanceEvents)));
    const snap =
      tenantGovernanceSnapshot ??
      ({
        streamId: "governance",
        lastChainHash: tenantGovernanceEvents.length ? tenantGovernanceEvents[tenantGovernanceEvents.length - 1]?.chainHash ?? null : null,
        lastEventId: tenantGovernanceEvents.length ? tenantGovernanceEvents[tenantGovernanceEvents.length - 1]?.id ?? null : null
      });
    tenantGovSnapshotUsed = snap;
    files.set("governance/tenant/snapshot.json", new TextEncoder().encode(`${canonicalJsonStringify(snap)}\n`));
  }

  if (Array.isArray(governanceEvents)) {
    const govMaterial = governanceEvents.map((e) => ({
      v: e?.v ?? null,
      id: e?.id ?? null,
      at: e?.at ?? null,
      streamId: e?.streamId ?? null,
      type: e?.type ?? null,
      actor: e?.actor ?? null,
      payload: e?.payload ?? null
    }));
    files.set("governance/global/events/payload_material.jsonl", new TextEncoder().encode(canonicalJsonlLines(govMaterial)));
    files.set("governance/global/events/events.jsonl", new TextEncoder().encode(canonicalJsonlLines(governanceEvents)));
    const snap =
      governanceSnapshot ??
      ({
        streamId: "governance",
        lastChainHash: governanceEvents.length ? governanceEvents[governanceEvents.length - 1]?.chainHash ?? null : null,
        lastEventId: governanceEvents.length ? governanceEvents[governanceEvents.length - 1]?.id ?? null : null
      });
    globalGovSnapshotUsed = snap;
    files.set("governance/global/snapshot.json", new TextEncoder().encode(`${canonicalJsonStringify(snap)}\n`));
  }

  // Contracts + compiled policies (reproducible from contract doc).
  const customerContractHash = jobSnapshot?.booking?.customerContractHash ?? jobSnapshot?.customerContractHash ?? null;
  const operatorContractHash = jobSnapshot?.operatorContractHash ?? null;
  const contractHashes = [customerContractHash, operatorContractHash].filter((h) => typeof h === "string" && h.trim());

  const compiledPolicies = [];
  for (const h of Array.from(new Set(contractHashes)).sort()) {
    const doc = contractDocsByHash.get(h) ?? null;
    if (!doc) continue;
    files.set(`contracts/${h}.json`, new TextEncoder().encode(`${canonicalJsonStringify(doc)}\n`));
    const compiled = compilePolicySnapshotForContractDoc(doc);
    if (compiled?.policySnapshot && compiled?.policyHash) {
      const policyHash = String(compiled.policyHash);
      files.set(`policies/${policyHash}.json`, new TextEncoder().encode(`${canonicalJsonStringify(compiled.policySnapshot)}\n`));
      compiledPolicies.push({ contractHash: h, ...compiled, policySnapshotFile: `policies/${policyHash}.json` });
    }
  }

  // Artifacts as delivered/stored (canonical JSON).
  const artifactFiles = [];
  for (const a of artifacts) {
    if (!a || typeof a !== "object") continue;
    const artifactType = typeof a.artifactType === "string" ? a.artifactType : "unknown";
    const artifactHash = typeof a.artifactHash === "string" ? a.artifactHash : "unknown";
    const name = `artifacts/${artifactType}/${artifactHash}.json`;
    files.set(name, new TextEncoder().encode(`${canonicalJsonStringify(a)}\n`));
    artifactFiles.push({ artifactType, artifactHash, name });
  }

  // Public keys (with lifecycle metadata when available) needed to verify signed events.
  const keyIds = Array.from(
    new Set(
      jobEvents
        .map((e) => (e?.signerKeyId && typeof e.signerKeyId === "string" ? e.signerKeyId : null))
        .filter((v) => typeof v === "string" && v.trim())
    )
  ).sort();
  const keysFile = buildPublicKeysFileV1({ tenantId, generatedAt, publicKeyByKeyId, signerKeys, keyIds });
  files.set("keys/public_keys.json", new TextEncoder().encode(`${canonicalJsonStringify(keysFile)}\n`));

	  const eventChain = verifyEventChain(jobEvents, publicKeyByKeyId);
	  const settlementProofRefs = verifySettlementProofRefs(jobEvents);
	  const artifactsVerify = verifyArtifacts(artifacts);

	  const report = {
	    schemaVersion: "ProofBundleVerifyReport.v1",
	    kind: JOB_PROOF_BUNDLE_SCHEMA_VERSION_V1,
	    tenantId,
	    scope: { jobId },
	    generatedAt,
	    eventChain,
	    settlementProofRefs,
	    artifacts: artifactsVerify,
	    compiledPolicies
	  };
  files.set("verify/report.json", new TextEncoder().encode(`${canonicalJsonStringify(report)}\n`));

  const { manifest, manifestHash } = computeProofBundleManifestV1({
    files,
    generatedAt,
    kind: JOB_PROOF_BUNDLE_SCHEMA_VERSION_V1,
    tenantId,
    scope: { jobId }
  });
  files.set("manifest.json", new TextEncoder().encode(`${canonicalJsonStringify({ ...manifest, manifestHash })}\n`));

  if (manifestSigner) {
    const heads = computeBundleHeads({
      jobSnapshot,
      tenantGovernanceSnapshot: tenantGovSnapshotUsed,
      governanceSnapshot: globalGovSnapshotUsed
    });
    const att = buildBundleHeadAttestationV1({
      kind: JOB_PROOF_BUNDLE_SCHEMA_VERSION_V1,
      tenantId,
      scope: { jobId },
      generatedAt,
      manifestHash,
      heads,
      signer: manifestSigner
    });
    files.set("attestation/bundle_head_attestation.json", new TextEncoder().encode(`${canonicalJsonStringify(att)}\n`));
  }

  if (manifestSigner) {
    const attestation = JSON.parse(new TextDecoder().decode(files.get("attestation/bundle_head_attestation.json")));
    const vr = buildVerificationReportV1ForProofBundle({
      kind: JOB_PROOF_BUNDLE_SCHEMA_VERSION_V1,
      tenantId,
      scope: { jobId },
      generatedAt,
      manifestHash,
      bundleHeadAttestation: attestation,
      signer: manifestSigner,
      bundleFiles: files
    });
    files.set("verify/verification_report.json", new TextEncoder().encode(`${canonicalJsonStringify(vr)}\n`));
  }

  return {
    bundle: {
      schemaVersion: JOB_PROOF_BUNDLE_SCHEMA_VERSION_V1,
      tenantId,
      jobId,
      generatedAt,
      manifestHash
    },
    files
  };
}

export function buildMonthProofBundleV1({
  tenantId,
  period,
  basis,
  monthEvents,
  governanceEvents = null,
  governanceSnapshot = null,
  tenantGovernanceEvents = null,
  tenantGovernanceSnapshot = null,
  artifacts,
  contractDocsByHash = new Map(),
  publicKeyByKeyId = new Map(),
  signerKeys = [],
  manifestSigner = null,
  requireHeadAttestation = false,
  generatedAt
} = {}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(period, "period");
  assertNonEmptyString(basis, "basis");
  if (!Array.isArray(monthEvents) || monthEvents.length === 0) throw new TypeError("monthEvents is required");
  if (governanceEvents !== null && !Array.isArray(governanceEvents)) throw new TypeError("governanceEvents must be null or an array");
  if (governanceSnapshot !== null && typeof governanceSnapshot !== "object") throw new TypeError("governanceSnapshot must be null or an object");
  if (tenantGovernanceEvents !== null && !Array.isArray(tenantGovernanceEvents)) throw new TypeError("tenantGovernanceEvents must be null or an array");
  if (tenantGovernanceSnapshot !== null && typeof tenantGovernanceSnapshot !== "object") {
    throw new TypeError("tenantGovernanceSnapshot must be null or an object");
  }
  if (!Array.isArray(artifacts)) throw new TypeError("artifacts must be an array");
  if (!(contractDocsByHash instanceof Map)) throw new TypeError("contractDocsByHash must be a Map");
  if (!(publicKeyByKeyId instanceof Map)) throw new TypeError("publicKeyByKeyId must be a Map");
  if (!Array.isArray(signerKeys)) throw new TypeError("signerKeys must be an array");
  if (manifestSigner !== null && typeof manifestSigner !== "object") throw new TypeError("manifestSigner must be null or an object");
  if (requireHeadAttestation !== true && requireHeadAttestation !== false) throw new TypeError("requireHeadAttestation must be a boolean");
  assertNonEmptyString(generatedAt, "generatedAt");

  if (requireHeadAttestation && !manifestSigner) {
    const err = new Error("manifestSigner is required to produce a bundle head attestation");
    err.code = "MANIFEST_SIGNER_REQUIRED";
    throw err;
  }

  const files = new Map();
  let tenantGovSnapshotUsed = null;
  let globalGovSnapshotUsed = null;

  const payloadMaterial = monthEvents.map((e) => ({
    v: e?.v ?? null,
    id: e?.id ?? null,
    at: e?.at ?? null,
    streamId: e?.streamId ?? null,
    type: e?.type ?? null,
    actor: e?.actor ?? null,
    payload: e?.payload ?? null
  }));
  files.set("events/payload_material.jsonl", new TextEncoder().encode(canonicalJsonlLines(payloadMaterial)));
  files.set("events/events.jsonl", new TextEncoder().encode(canonicalJsonlLines(monthEvents)));

  if (Array.isArray(tenantGovernanceEvents)) {
    const govMaterial = tenantGovernanceEvents.map((e) => ({
      v: e?.v ?? null,
      id: e?.id ?? null,
      at: e?.at ?? null,
      streamId: e?.streamId ?? null,
      type: e?.type ?? null,
      actor: e?.actor ?? null,
      payload: e?.payload ?? null
    }));
    files.set("governance/tenant/events/payload_material.jsonl", new TextEncoder().encode(canonicalJsonlLines(govMaterial)));
    files.set("governance/tenant/events/events.jsonl", new TextEncoder().encode(canonicalJsonlLines(tenantGovernanceEvents)));
    const snap =
      tenantGovernanceSnapshot ??
      ({
        streamId: "governance",
        lastChainHash: tenantGovernanceEvents.length ? tenantGovernanceEvents[tenantGovernanceEvents.length - 1]?.chainHash ?? null : null,
        lastEventId: tenantGovernanceEvents.length ? tenantGovernanceEvents[tenantGovernanceEvents.length - 1]?.id ?? null : null
      });
    tenantGovSnapshotUsed = snap;
    files.set("governance/tenant/snapshot.json", new TextEncoder().encode(`${canonicalJsonStringify(snap)}\n`));
  }

  if (Array.isArray(governanceEvents)) {
    const govMaterial = governanceEvents.map((e) => ({
      v: e?.v ?? null,
      id: e?.id ?? null,
      at: e?.at ?? null,
      streamId: e?.streamId ?? null,
      type: e?.type ?? null,
      actor: e?.actor ?? null,
      payload: e?.payload ?? null
    }));
    files.set("governance/global/events/payload_material.jsonl", new TextEncoder().encode(canonicalJsonlLines(govMaterial)));
    files.set("governance/global/events/events.jsonl", new TextEncoder().encode(canonicalJsonlLines(governanceEvents)));
    const snap =
      governanceSnapshot ??
      ({
        streamId: "governance",
        lastChainHash: governanceEvents.length ? governanceEvents[governanceEvents.length - 1]?.chainHash ?? null : null,
        lastEventId: governanceEvents.length ? governanceEvents[governanceEvents.length - 1]?.id ?? null : null
      });
    globalGovSnapshotUsed = snap;
    files.set("governance/global/snapshot.json", new TextEncoder().encode(`${canonicalJsonStringify(snap)}\n`));
  }

  const artifactFiles = [];
  for (const a of artifacts) {
    if (!a || typeof a !== "object") continue;
    const artifactType = typeof a.artifactType === "string" ? a.artifactType : "unknown";
    const artifactHash = typeof a.artifactHash === "string" ? a.artifactHash : "unknown";
    const name = `artifacts/${artifactType}/${artifactHash}.json`;
    files.set(name, new TextEncoder().encode(`${canonicalJsonStringify(a)}\n`));
    artifactFiles.push({ artifactType, artifactHash, name });
  }

  // Best-effort: include any contract docs referenced by artifacts (policy hashes etc).
  // If caller provides docs, include them.
  for (const [h, doc] of Array.from(contractDocsByHash.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!doc) continue;
    files.set(`contracts/${h}.json`, new TextEncoder().encode(`${canonicalJsonStringify(doc)}\n`));
    const compiled = compilePolicySnapshotForContractDoc(doc);
    if (compiled?.policySnapshot && compiled?.policyHash) {
      const policyHash = String(compiled.policyHash);
      files.set(`policies/${policyHash}.json`, new TextEncoder().encode(`${canonicalJsonStringify(compiled.policySnapshot)}\n`));
    }
  }

  const monthKeyIds = Array.from(
    new Set(
      monthEvents
        .map((e) => (e?.signerKeyId && typeof e.signerKeyId === "string" ? e.signerKeyId : null))
        .filter((v) => typeof v === "string" && v.trim())
    )
  ).sort();
  const keysFile = buildPublicKeysFileV1({ tenantId, generatedAt, publicKeyByKeyId, signerKeys, keyIds: monthKeyIds });
  files.set("keys/public_keys.json", new TextEncoder().encode(`${canonicalJsonStringify(keysFile)}\n`));

  const eventChain = verifyEventChain(monthEvents, publicKeyByKeyId);
  const artifactsVerify = verifyArtifacts(artifacts);

  const report = {
    schemaVersion: "ProofBundleVerifyReport.v1",
    kind: MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1,
    tenantId,
    scope: { period, basis },
    generatedAt,
    eventChain,
    artifacts: artifactsVerify
  };
  files.set("verify/report.json", new TextEncoder().encode(`${canonicalJsonStringify(report)}\n`));

  const { manifest, manifestHash } = computeProofBundleManifestV1({
    files,
    generatedAt,
    kind: MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1,
    tenantId,
    scope: { period, basis }
  });
  files.set("manifest.json", new TextEncoder().encode(`${canonicalJsonStringify({ ...manifest, manifestHash })}\n`));

  if (manifestSigner) {
    const heads = {
      month: {
        lastEventId: monthEvents[monthEvents.length - 1]?.id ?? null,
        lastChainHash: monthEvents[monthEvents.length - 1]?.chainHash ?? null
      },
      governance: {
        tenant: tenantGovSnapshotUsed ? { lastEventId: tenantGovSnapshotUsed.lastEventId ?? null, lastChainHash: tenantGovSnapshotUsed.lastChainHash ?? null } : null,
        global: globalGovSnapshotUsed ? { lastEventId: globalGovSnapshotUsed.lastEventId ?? null, lastChainHash: globalGovSnapshotUsed.lastChainHash ?? null } : null
      }
    };
    const att = buildBundleHeadAttestationV1({
      kind: MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1,
      tenantId,
      scope: { period, basis },
      generatedAt,
      manifestHash,
      heads,
      signer: manifestSigner
    });
    files.set("attestation/bundle_head_attestation.json", new TextEncoder().encode(`${canonicalJsonStringify(att)}\n`));
  }

  if (manifestSigner) {
    const attestation = JSON.parse(new TextDecoder().decode(files.get("attestation/bundle_head_attestation.json")));
    const vr = buildVerificationReportV1ForProofBundle({
      kind: MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1,
      tenantId,
      scope: { period, basis },
      generatedAt,
      manifestHash,
      bundleHeadAttestation: attestation,
      signer: manifestSigner,
      bundleFiles: files
    });
    files.set("verify/verification_report.json", new TextEncoder().encode(`${canonicalJsonStringify(vr)}\n`));
  }

  return {
    bundle: {
      schemaVersion: MONTH_PROOF_BUNDLE_SCHEMA_VERSION_V1,
      tenantId,
      period,
      basis,
      generatedAt,
      manifestHash
    },
    files
  };
}
