import {
  buildDelegationGrantV1,
  computeDelegationGrantHashV1,
  DELEGATION_GRANT_TRUST_OPERATION,
  evaluateDelegationGrantTrustV1,
  revokeDelegationGrantV1,
  validateDelegationGrantV1
} from '../../core/delegation-grant.js';
import {
  AGREEMENT_DELEGATION_STATUS,
  buildAgreementDelegationV1,
  cascadeSettlementCheck,
  cascadeSettlementExecute,
  cascadeUnwindExecute,
  computeAgreementDelegationHashV1,
  refundUnwindCheck,
  refundUnwindExecute,
  summarizeAgreementDelegationLedgerV1,
  validateAgreementDelegationV1
} from '../../core/agreement-delegation.js';
import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeEnum,
  normalizeIsoDateTime,
  normalizeSha256Hex
} from '../protocol/utils.js';

export const AGENTVERSE_DELEGATION_LINEAGE_SNAPSHOT_SCHEMA_VERSION = 'AgentverseDelegationLineageSnapshot.v1';

export function buildDelegationLineageSnapshotV1({
  grant,
  agreementDelegations = [],
  operation = DELEGATION_GRANT_TRUST_OPERATION.WRITE,
  evaluatedAt,
  includeCascadeChecks = true
} = {}) {
  if (!evaluatedAt) {
    throw new TypeError('evaluatedAt is required to keep lineage snapshots deterministic');
  }
  const at = normalizeIsoDateTime(evaluatedAt, 'evaluatedAt');

  validateDelegationGrantV1(grant);
  const trust = evaluateDelegationGrantTrustV1({ grant, at, operation });

  if (!Array.isArray(agreementDelegations)) throw new TypeError('agreementDelegations must be an array');
  for (let i = 0; i < agreementDelegations.length; i += 1) {
    validateAgreementDelegationV1(agreementDelegations[i]);
  }

  const ledgerSummary = summarizeAgreementDelegationLedgerV1({ delegations: agreementDelegations });

  const cascadeSettle = includeCascadeChecks
    ? cascadeSettlementCheck({ delegations: agreementDelegations, fromChildHash: ledgerSummary?.roots?.[0] ?? null })
    : null;
  const cascadeRefund = includeCascadeChecks
    ? refundUnwindCheck({ delegations: agreementDelegations, fromParentHash: ledgerSummary?.roots?.[0] ?? null })
    : null;

  const snapshotCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_DELEGATION_LINEAGE_SNAPSHOT_SCHEMA_VERSION,
      evaluatedAt: at,
      operation: normalizeEnum(operation, 'operation', Object.values(DELEGATION_GRANT_TRUST_OPERATION), {
        defaultValue: DELEGATION_GRANT_TRUST_OPERATION.WRITE
      }),
      grantId: grant.grantId,
      grantHash: grant.grantHash,
      rootGrantHash: grant?.chainBinding?.rootGrantHash ?? null,
      trust,
      ledgerSummary,
      checks: {
        cascadeSettlement: cascadeSettle,
        refundUnwind: cascadeRefund
      }
    },
    { path: '$.delegationSnapshot' }
  );

  const snapshotHash = canonicalHash(snapshotCore, { path: '$.delegationSnapshot' });
  return canonicalize({ ...snapshotCore, snapshotHash }, { path: '$.delegationSnapshot' });
}

export function validateDelegationLineageSnapshotV1(snapshot) {
  assertPlainObject(snapshot, 'snapshot');
  if (snapshot.schemaVersion !== AGENTVERSE_DELEGATION_LINEAGE_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError(`snapshot.schemaVersion must be ${AGENTVERSE_DELEGATION_LINEAGE_SNAPSHOT_SCHEMA_VERSION}`);
  }
  normalizeIsoDateTime(snapshot.evaluatedAt, 'snapshot.evaluatedAt');
  normalizeEnum(snapshot.operation, 'snapshot.operation', Object.values(DELEGATION_GRANT_TRUST_OPERATION));
  if (!snapshot.grantId || typeof snapshot.grantId !== 'string') throw new TypeError('snapshot.grantId is required');
  normalizeSha256Hex(snapshot.grantHash, 'snapshot.grantHash');
  normalizeSha256Hex(snapshot.snapshotHash, 'snapshot.snapshotHash');
  const expectedHash = canonicalHash(
    {
      ...snapshot,
      snapshotHash: undefined
    },
    { path: '$.delegationSnapshot' }
  );
  if (expectedHash !== snapshot.snapshotHash) throw new TypeError('snapshotHash mismatch');
  return true;
}

export function isDelegationActionAllowedV1({ grant, at, operation = DELEGATION_GRANT_TRUST_OPERATION.WRITE } = {}) {
  validateDelegationGrantV1(grant);
  const evaluatedAt = normalizeIsoDateTime(at ?? grant?.validity?.issuedAt, 'at');
  const trust = evaluateDelegationGrantTrustV1({ grant, at: evaluatedAt, operation });
  return {
    allowed: trust.state === 'active' || trust.reasonCode === 'DELEGATION_GRANT_HISTORICAL_READ_ALLOWED',
    trust
  };
}

export function applyDelegationSettlementCascadeV1({
  delegations,
  fromChildHash,
  resolvedAt,
  metadata = null
} = {}) {
  if (!resolvedAt) throw new TypeError('resolvedAt is required for deterministic cascade execution');
  return cascadeSettlementExecute({
    delegations,
    fromChildHash,
    resolvedAt: normalizeIsoDateTime(resolvedAt, 'resolvedAt'),
    metadata
  });
}

export function applyDelegationUnwindCascadeV1({
  delegations,
  fromChildHash,
  fromParentHash,
  resolvedAt,
  metadata = null,
  mode = 'refund'
} = {}) {
  if (!resolvedAt) throw new TypeError('resolvedAt is required for deterministic cascade execution');
  const at = normalizeIsoDateTime(resolvedAt, 'resolvedAt');
  const normalizedMode = normalizeEnum(mode, 'mode', ['refund', 'cascade'], { defaultValue: 'refund' });
  if (normalizedMode === 'cascade') {
    return cascadeUnwindExecute({ delegations, fromChildHash, resolvedAt: at, metadata });
  }
  return refundUnwindExecute({ delegations, fromParentHash, resolvedAt: at, metadata });
}

export {
  DELEGATION_GRANT_TRUST_OPERATION,
  AGREEMENT_DELEGATION_STATUS,
  buildDelegationGrantV1,
  validateDelegationGrantV1,
  computeDelegationGrantHashV1,
  revokeDelegationGrantV1,
  evaluateDelegationGrantTrustV1,
  buildAgreementDelegationV1,
  validateAgreementDelegationV1,
  computeAgreementDelegationHashV1,
  summarizeAgreementDelegationLedgerV1,
  cascadeSettlementCheck,
  refundUnwindCheck
};
