# Pilot Package + Success Scorecard (x402 Wedge)

This defines the default pilot offer and measurable success gates for Settld x402 deployments.

## 1. Pilot Package

- Scope: 1 paid tool workflow, 1 buyer, 1 provider, 1 tenant.
- Duration: 4-6 weeks.
- Success proof: deterministic receipts + offline verification + export for finance.
- Out of scope: broad marketplace rollout, unrestricted side-effect tools.

## 2. Delivery Timeline

1. Week 0: scope lock, baseline capture, env + keys provisioned.
2. Week 1: first paid call in production-like flow (`402 -> retry -> verify`).
3. Week 2-3: volume ramp + policy tuning (caps, allowlists, dispute windows).
4. Week 4-6: KPI review, case-study artifacts, expansion decision.

## 3. Scorecard (Baseline + Target)

| Metric | Baseline (before Settld) | Target (pilot) | Measurement |
|---|---:|---:|---|
| Integration time to first paid call | > 2 days | < 1 afternoon | Start-to-first successful settled paid call |
| Auto-resolve rate (%) | < 40% | >= 80% | `released / total verified` for in-scope runs |
| Dispute rate (%) | > 10% | <= 5% | `disputed / settled` over pilot window |
| Time-to-settle (p95) | > 24h | < 15m | verification-to-settlement latency |

## 4. Required Evidence Artifacts

- x402 gate trace (`gateId`, authorization ref, reserve id where applicable)
- Decision + settlement binding hashes
- Receipt export for pilot window
- Offline verifier output sample on exported receipts
- Weekly reliability report (`reserveFailRate`, `providerSigFailRate`, `settlementSuccessRate`)

## 5. Expansion Triggers

- Two or more teams request onboarding.
- Finance requests recurring automated exports.
- Scorecard targets met for two consecutive weekly checkpoints.

## 6. No-Go / Re-scope Conditions

- Integration time target misses twice.
- Dispute rate trend worsens versus baseline.
- Settlement reliability below threshold for two consecutive checkpoints.
