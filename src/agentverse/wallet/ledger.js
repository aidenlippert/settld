import {
  AGENT_RUN_SETTLEMENT_DECISION_MODE,
  AGENT_RUN_SETTLEMENT_DECISION_STATUS,
  AGENT_RUN_SETTLEMENT_DISPUTE_CHANNEL,
  AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL,
  AGENT_RUN_SETTLEMENT_DISPUTE_KIND,
  AGENT_RUN_SETTLEMENT_DISPUTE_PRIORITY,
  AGENT_RUN_SETTLEMENT_DISPUTE_RESOLUTION_OUTCOME,
  AGENT_RUN_SETTLEMENT_DISPUTE_STATUS,
  AGENT_RUN_SETTLEMENT_SCHEMA_VERSION,
  AGENT_RUN_SETTLEMENT_STATUS,
  AGENT_WALLET_SCHEMA_VERSION,
  createAgentRunSettlement,
  createAgentWallet,
  creditAgentWallet,
  ensureAgentWallet,
  lockAgentWalletEscrow,
  reconcileResolvedAgentRunSettlement,
  refundAgentWalletEscrow,
  refundReleasedAgentRunSettlement,
  releaseAgentWalletEscrowToPayee,
  resolveAgentRunSettlement,
  transferAgentWalletAvailable,
  updateAgentRunSettlementDecision,
  updateAgentRunSettlementDispute,
  validateAgentRunSettlementRequest
} from '../../core/agent-wallets.js';
import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeId,
  normalizeIsoDateTime,
  normalizeSafeInt,
  normalizeSha256Hex
} from '../protocol/utils.js';

export const AGENTVERSE_WALLET_LEDGER_SNAPSHOT_SCHEMA_VERSION = 'AgentverseWalletLedgerSnapshot.v1';

function normalizeWalletRecord(wallet, name) {
  assertPlainObject(wallet, name);
  if (wallet.schemaVersion !== AGENT_WALLET_SCHEMA_VERSION) {
    throw new TypeError(`${name}.schemaVersion must be ${AGENT_WALLET_SCHEMA_VERSION}`);
  }
  normalizeId(wallet.tenantId, `${name}.tenantId`, { min: 1, max: 128 });
  normalizeId(wallet.agentId, `${name}.agentId`, { min: 1, max: 200 });
  normalizeSafeInt(wallet.availableCents, `${name}.availableCents`, { min: 0, max: Number.MAX_SAFE_INTEGER });
  normalizeSafeInt(wallet.escrowLockedCents, `${name}.escrowLockedCents`, { min: 0, max: Number.MAX_SAFE_INTEGER });
  normalizeSafeInt(wallet.totalDebitedCents, `${name}.totalDebitedCents`, { min: 0, max: Number.MAX_SAFE_INTEGER });
  normalizeSafeInt(wallet.totalCreditedCents, `${name}.totalCreditedCents`, { min: 0, max: Number.MAX_SAFE_INTEGER });
  normalizeIsoDateTime(wallet.createdAt, `${name}.createdAt`);
  normalizeIsoDateTime(wallet.updatedAt, `${name}.updatedAt`);
  return canonicalize(wallet, { path: `$${name}` });
}

export function computeWalletLedgerSnapshotHashV1(snapshotCore) {
  assertPlainObject(snapshotCore, 'snapshotCore');
  const copy = { ...snapshotCore };
  delete copy.snapshotHash;
  return canonicalHash(copy, { path: '$.walletLedgerSnapshot' });
}

export function buildWalletLedgerSnapshotV1({
  tenantId,
  wallets = [],
  settlements = [],
  computedAt
} = {}) {
  if (!computedAt) throw new TypeError('computedAt is required to keep wallet snapshots deterministic');
  if (!Array.isArray(wallets)) throw new TypeError('wallets must be an array');
  if (!Array.isArray(settlements)) throw new TypeError('settlements must be an array');

  const normalizedTenantId = normalizeId(tenantId, 'tenantId', { min: 1, max: 128 });
  const normalizedAt = normalizeIsoDateTime(computedAt, 'computedAt');

  const normalizedWallets = wallets
    .map((wallet, index) => normalizeWalletRecord(wallet, `.wallets[${index}]`))
    .filter((wallet) => wallet.tenantId === normalizedTenantId)
    .sort((left, right) => String(left.agentId).localeCompare(String(right.agentId)));

  const settlementRows = settlements
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => canonicalize(row, { path: '$.settlement' }))
    .filter((row) => String(row.tenantId ?? '') === normalizedTenantId)
    .sort((left, right) => String(left.settlementId ?? '').localeCompare(String(right.settlementId ?? '')));

  const totals = normalizedWallets.reduce(
    (acc, wallet) => {
      acc.availableCents += Number(wallet.availableCents);
      acc.escrowLockedCents += Number(wallet.escrowLockedCents);
      acc.totalDebitedCents += Number(wallet.totalDebitedCents);
      acc.totalCreditedCents += Number(wallet.totalCreditedCents);
      return acc;
    },
    {
      availableCents: 0,
      escrowLockedCents: 0,
      totalDebitedCents: 0,
      totalCreditedCents: 0
    }
  );

  const snapshotCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_WALLET_LEDGER_SNAPSHOT_SCHEMA_VERSION,
      tenantId: normalizedTenantId,
      computedAt: normalizedAt,
      walletCount: normalizedWallets.length,
      settlementCount: settlementRows.length,
      totals,
      walletIds: normalizedWallets.map((wallet) => String(wallet.walletId)),
      settlementIds: settlementRows.map((row) => String(row.settlementId ?? '')).filter(Boolean),
      wallets: normalizedWallets,
      settlements: settlementRows
    },
    { path: '$.walletLedgerSnapshot' }
  );

  const snapshotHash = computeWalletLedgerSnapshotHashV1(snapshotCore);
  return canonicalize({ ...snapshotCore, snapshotHash }, { path: '$.walletLedgerSnapshot' });
}

export function validateWalletLedgerSnapshotV1(snapshot) {
  assertPlainObject(snapshot, 'snapshot');
  if (snapshot.schemaVersion !== AGENTVERSE_WALLET_LEDGER_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError(`snapshot.schemaVersion must be ${AGENTVERSE_WALLET_LEDGER_SNAPSHOT_SCHEMA_VERSION}`);
  }
  normalizeId(snapshot.tenantId, 'snapshot.tenantId', { min: 1, max: 128 });
  normalizeIsoDateTime(snapshot.computedAt, 'snapshot.computedAt');
  normalizeSafeInt(snapshot.walletCount, 'snapshot.walletCount', { min: 0, max: Number.MAX_SAFE_INTEGER });
  normalizeSafeInt(snapshot.settlementCount, 'snapshot.settlementCount', { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (!Array.isArray(snapshot.wallets)) throw new TypeError('snapshot.wallets must be an array');
  for (let i = 0; i < snapshot.wallets.length; i += 1) {
    normalizeWalletRecord(snapshot.wallets[i], `.snapshot.wallets[${i}]`);
  }
  if (!Array.isArray(snapshot.settlements)) throw new TypeError('snapshot.settlements must be an array');
  for (let i = 0; i < snapshot.settlements.length; i += 1) {
    const row = snapshot.settlements[i];
    assertPlainObject(row, `snapshot.settlements[${i}]`);
    if (row.schemaVersion && row.schemaVersion !== AGENT_RUN_SETTLEMENT_SCHEMA_VERSION) {
      throw new TypeError(`snapshot.settlements[${i}].schemaVersion must be ${AGENT_RUN_SETTLEMENT_SCHEMA_VERSION}`);
    }
  }
  const expectedHash = computeWalletLedgerSnapshotHashV1(snapshot);
  const actualHash = normalizeSha256Hex(snapshot.snapshotHash, 'snapshot.snapshotHash');
  if (expectedHash !== actualHash) throw new TypeError('snapshotHash mismatch');
  return true;
}

export function executeWalletSettlementReleaseV1({
  payerWallet,
  payeeWallet,
  amountCents,
  at
} = {}) {
  const normalizedAt = normalizeIsoDateTime(at, 'at');
  return releaseAgentWalletEscrowToPayee({ payerWallet, payeeWallet, amountCents, at: normalizedAt });
}

export function executeWalletSettlementRefundV1({ wallet, amountCents, at } = {}) {
  const normalizedAt = normalizeIsoDateTime(at, 'at');
  return refundAgentWalletEscrow({ wallet, amountCents, at: normalizedAt });
}

export {
  AGENT_WALLET_SCHEMA_VERSION,
  AGENT_RUN_SETTLEMENT_SCHEMA_VERSION,
  AGENT_RUN_SETTLEMENT_STATUS,
  AGENT_RUN_SETTLEMENT_DISPUTE_STATUS,
  AGENT_RUN_SETTLEMENT_DISPUTE_KIND,
  AGENT_RUN_SETTLEMENT_DISPUTE_PRIORITY,
  AGENT_RUN_SETTLEMENT_DISPUTE_CHANNEL,
  AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL,
  AGENT_RUN_SETTLEMENT_DISPUTE_RESOLUTION_OUTCOME,
  AGENT_RUN_SETTLEMENT_DECISION_STATUS,
  AGENT_RUN_SETTLEMENT_DECISION_MODE,
  createAgentWallet,
  ensureAgentWallet,
  creditAgentWallet,
  lockAgentWalletEscrow,
  releaseAgentWalletEscrowToPayee,
  refundAgentWalletEscrow,
  transferAgentWalletAvailable,
  validateAgentRunSettlementRequest,
  createAgentRunSettlement,
  resolveAgentRunSettlement,
  refundReleasedAgentRunSettlement,
  reconcileResolvedAgentRunSettlement,
  updateAgentRunSettlementDecision,
  updateAgentRunSettlementDispute
};
