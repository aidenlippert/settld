# Dispute Finance Reconciliation Packet

This runbook generates a deterministic packet for dispute-driven settlement adjustments.

## Purpose

- Produce a finance-reviewable packet for one `SettlementAdjustment.v1`.
- Include adjustment artifact + before/after wallet snapshots for payer/payee.
- Attach deterministic checksums and optional Ed25519 signature.

## Command

```bash
node scripts/ops/dispute-finance-reconciliation-packet.mjs \
  --base-url http://127.0.0.1:3000 \
  --tenant-id tenant_default \
  --ops-token tok_finw \
  --adjustment-id sadj_agmt_<agreementHash>_holdback \
  --payer-agent-id <payerAgentId> \
  --payee-agent-id <payeeAgentId> \
  --out artifacts/finance/dispute-adjustment-packet.json
```

Optional signing:

```bash
node scripts/ops/dispute-finance-reconciliation-packet.mjs \
  --base-url http://127.0.0.1:3000 \
  --tenant-id tenant_default \
  --ops-token tok_finw \
  --adjustment-id sadj_agmt_<agreementHash>_holdback \
  --payer-agent-id <payerAgentId> \
  --payee-agent-id <payeeAgentId> \
  --signing-key-file ./keys/finance-ops-ed25519.pem \
  --signature-key-id finance_ops_k1 \
  --out artifacts/finance/dispute-adjustment-packet.signed.json
```

## Packet contract

- `schemaVersion`: `DisputeFinanceReconciliationPacket.v1`
- `adjustment`: `SettlementAdjustment.v1` payload from `/ops/settlement-adjustments/{adjustmentId}`
- `balances.payer/payee.before|after`: wallet snapshots for reconciliation
- `checksums.packetHash`: canonical packet checksum (`sha256`)
- `checksums.adjustmentHash`: checksum carried by adjustment artifact
- `signature` (optional): Ed25519 signature over `checksums.packetHash`

## Finance review workflow

1. Generate the packet immediately after dispute verdict/adjustment application.
2. Verify `checksums.adjustmentHash` matches the adjustment artifact.
3. Verify `checksums.packetHash` and (if present) `signature`.
4. Reconcile `before -> after` snapshots against expected adjustment kind:
   - `holdback_release`: payer escrow decreases; payee available increases.
   - `holdback_refund`: payer escrow decreases; payer available increases.
5. Attach packet to incident/dispute record for immutable finance traceability.
