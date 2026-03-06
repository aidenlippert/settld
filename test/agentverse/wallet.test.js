import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import {
  createAgentWallet,
  creditAgentWallet,
  lockAgentWalletEscrow,
  releaseAgentWalletEscrowToPayee,
  buildWalletLedgerSnapshotV1,
  validateWalletLedgerSnapshotV1
} from '../../src/agentverse/wallet/index.js';

test('agentverse wallet module implemented', async () => {
  await assertModuleImplemented('wallet', ['index.js', 'ledger.js']);
});

test('wallet operations and ledger snapshot validate', () => {
  let payer = createAgentWallet({ tenantId: 'tenant_default', agentId: 'agt_payer', at: '2026-03-02T00:00:00.000Z' });
  let payee = createAgentWallet({ tenantId: 'tenant_default', agentId: 'agt_payee', at: '2026-03-02T00:00:00.000Z' });
  payer = creditAgentWallet({ wallet: payer, amountCents: 1000, at: '2026-03-02T00:00:01.000Z' });

  payer = lockAgentWalletEscrow({
    wallet: payer,
    amountCents: 500,
    at: '2026-03-02T00:00:02.000Z'
  });

  const transfer = releaseAgentWalletEscrowToPayee({
    payerWallet: payer,
    payeeWallet: payee,
    amountCents: 500,
    at: '2026-03-02T00:00:03.000Z'
  });

  payer = transfer.payerWallet;
  payee = transfer.payeeWallet;

  const snap = buildWalletLedgerSnapshotV1({
    tenantId: 'tenant_default',
    wallets: [payer, payee],
    settlements: [],
    computedAt: '2026-03-02T00:00:04.000Z'
  });
  assert.equal(validateWalletLedgerSnapshotV1(snap), true);
});
