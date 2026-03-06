import {
  buildEvidenceIndexV1
} from '../../core/evidence-linker.js';
import {
  EVIDENCE_KIND,
  validateEvidenceCapturedPayload,
  validateEvidenceExpiredPayload,
  validateEvidenceViewedPayload
} from '../../core/evidence.js';
import {
  buildEvidenceDownloadUrl,
  createFsEvidenceStore,
  createInMemoryEvidenceStore,
  createS3EvidenceStore,
  parseObjEvidenceRef,
  signEvidenceDownload,
  verifyEvidenceDownload
} from '../../core/evidence-store.js';
import {
  buildToolCallEvidenceV1,
  computeToolCallEvidenceHashV1,
  computeToolCallOutputHashV1,
  TOOL_CALL_EVIDENCE_SCHEMA_VERSION,
  validateToolCallEvidenceV1
} from '../../core/tool-call-evidence.js';
import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeId,
  normalizeIsoDateTime,
  normalizeStringList,
  normalizeSha256Hex
} from '../protocol/utils.js';

export const AGENTVERSE_EVIDENCE_MANIFEST_SCHEMA_VERSION = 'AgentverseEvidenceManifest.v1';

export function computeEvidenceManifestHashV1(manifestCore) {
  assertPlainObject(manifestCore, 'manifestCore');
  const copy = { ...manifestCore };
  delete copy.manifestHash;
  return canonicalHash(copy, { path: '$.evidenceManifest' });
}

export function buildEvidenceManifestV1({
  tenantId,
  sessionId,
  generatedAt,
  evidenceRefs = [],
  toolCallEvidence = [],
  metadata = null
} = {}) {
  if (!generatedAt) throw new TypeError('generatedAt is required to keep evidence manifests deterministic');
  if (!Array.isArray(toolCallEvidence)) throw new TypeError('toolCallEvidence must be an array');

  const normalizedEvidence = [];
  for (let i = 0; i < toolCallEvidence.length; i += 1) {
    const row = toolCallEvidence[i];
    validateToolCallEvidenceV1(row);
    normalizedEvidence.push(canonicalize(row, { path: `$.toolCallEvidence[${i}]` }));
  }

  const evidenceHashes = normalizedEvidence
    .map((row) => row.evidenceHash)
    .sort((left, right) => String(left).localeCompare(String(right)));

  const core = canonicalize(
    {
      schemaVersion: AGENTVERSE_EVIDENCE_MANIFEST_SCHEMA_VERSION,
      tenantId: normalizeId(tenantId ?? 'tenant_default', 'tenantId', { min: 1, max: 128 }),
      sessionId: normalizeId(sessionId, 'sessionId', { min: 1, max: 200 }),
      generatedAt: normalizeIsoDateTime(generatedAt, 'generatedAt'),
      evidenceRefs: normalizeStringList(evidenceRefs, 'evidenceRefs', { maxItems: 5000, itemMax: 4096 }),
      evidenceHashes,
      toolCallEvidence: normalizedEvidence,
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? canonicalize(metadata, { path: '$.metadata' })
        : null
    },
    { path: '$.evidenceManifest' }
  );

  const manifestHash = computeEvidenceManifestHashV1(core);
  return canonicalize({ ...core, manifestHash }, { path: '$.evidenceManifest' });
}

export function validateEvidenceManifestV1(manifest) {
  assertPlainObject(manifest, 'manifest');
  if (manifest.schemaVersion !== AGENTVERSE_EVIDENCE_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError(`manifest.schemaVersion must be ${AGENTVERSE_EVIDENCE_MANIFEST_SCHEMA_VERSION}`);
  }

  normalizeId(manifest.tenantId, 'manifest.tenantId', { min: 1, max: 128 });
  normalizeId(manifest.sessionId, 'manifest.sessionId', { min: 1, max: 200 });
  normalizeIsoDateTime(manifest.generatedAt, 'manifest.generatedAt');
  normalizeStringList(manifest.evidenceRefs, 'manifest.evidenceRefs', { maxItems: 5000, itemMax: 4096 });
  if (!Array.isArray(manifest.evidenceHashes)) throw new TypeError('manifest.evidenceHashes must be an array');
  for (let i = 0; i < manifest.evidenceHashes.length; i += 1) {
    normalizeSha256Hex(manifest.evidenceHashes[i], `manifest.evidenceHashes[${i}]`);
  }
  if (!Array.isArray(manifest.toolCallEvidence)) throw new TypeError('manifest.toolCallEvidence must be an array');
  for (let i = 0; i < manifest.toolCallEvidence.length; i += 1) {
    validateToolCallEvidenceV1(manifest.toolCallEvidence[i]);
  }

  const expectedHash = computeEvidenceManifestHashV1(manifest);
  const actualHash = normalizeSha256Hex(manifest.manifestHash, 'manifest.manifestHash');
  if (expectedHash !== actualHash) throw new TypeError('manifestHash mismatch');
  return true;
}

export function buildSessionEvidenceIndexV1({ generatedAt, jobProof, jobEvents, meteringReport } = {}) {
  return buildEvidenceIndexV1({ generatedAt, jobProof, jobEvents, meteringReport });
}

export {
  EVIDENCE_KIND,
  TOOL_CALL_EVIDENCE_SCHEMA_VERSION,
  parseObjEvidenceRef,
  buildEvidenceDownloadUrl,
  signEvidenceDownload,
  verifyEvidenceDownload,
  createFsEvidenceStore,
  createInMemoryEvidenceStore,
  createS3EvidenceStore,
  validateEvidenceCapturedPayload,
  validateEvidenceViewedPayload,
  validateEvidenceExpiredPayload,
  computeToolCallOutputHashV1,
  computeToolCallEvidenceHashV1,
  buildToolCallEvidenceV1,
  validateToolCallEvidenceV1
};
