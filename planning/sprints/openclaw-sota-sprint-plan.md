# OpenClaw SOTA Onboarding Sprint Plan

## Objective
Build the most advanced but simplest onboarding path: one command to connect OpenClaw + wallet + Settld trust layer, with deterministic proof and enterprise controls.

## Milestones
- M1: Contracts and readiness baseline complete (end of S1)
- M2: One-command onboarding with Circle path complete (end of S2)
- M3: Multi-wallet + pilot activation complete (end of S3)
- M4: Marketplace + hardening complete (end of S4)
- M5: Release gates + pilot proof complete (end of S5)
- M6: Staged launch packet approved (end of S6)

## Critical Path
`STLD-T3101 -> STLD-T3108 -> STLD-T3109 -> STLD-T3117 -> STLD-T3104 -> STLD-T3124 -> STLD-T3129 -> STLD-T3130 -> STLD-T3157 -> STLD-T3159 -> STLD-T3169 -> STLD-T3170`

## Sprint Breakdown
### S1: Foundation Contracts and Readiness
Goal: Lock architecture contracts, security baseline, and host compatibility prerequisites for one-command onboarding.
Tickets: STLD-T3101, STLD-T3102, STLD-T3108, STLD-T3116, STLD-T3123, STLD-T3141, STLD-T3149, STLD-T3155, STLD-T3160, STLD-T3165
Delivery metrics:
- Host certification pass rate >= 95% on CI matrix
- Quickstart completion time <= 5 minutes for clean machine path

### S2: Core Onboarding and Wallet Runtime
Goal: Ship one-command orchestrator and first production-grade wallet path with policy runtime binding.
Tickets: STLD-T3103, STLD-T3104, STLD-T3105, STLD-T3109, STLD-T3112, STLD-T3113, STLD-T3117, STLD-T3119, STLD-T3124, STLD-T3125, STLD-T3129, STLD-T3130, STLD-T3156, STLD-T3161
Delivery metrics:
- Onboarding success rate >= 80% in internal cohort
- Authorization decision determinism mismatch rate = 0

### S3: Provider Expansion and Pilot Activation
Goal: Expand provider options, strengthen UX/recovery, and operationalize pilot activation analytics.
Tickets: STLD-T3106, STLD-T3107, STLD-T3110, STLD-T3111, STLD-T3114, STLD-T3115, STLD-T3118, STLD-T3120, STLD-T3126, STLD-T3127, STLD-T3131, STLD-T3132, STLD-T3142, STLD-T3143, STLD-T3157, STLD-T3162, STLD-T3163, STLD-T3166, STLD-T3167
Delivery metrics:
- First verified receipt median time <= 15 minutes
- Pilot setup SLA attainment >= 90%

### S4: Marketplace and Security Hardening
Goal: Launch trusted package pipeline, evidence exports, and advanced security controls.
Tickets: STLD-T3121, STLD-T3122, STLD-T3128, STLD-T3133, STLD-T3134, STLD-T3135, STLD-T3136, STLD-T3144, STLD-T3145, STLD-T3150, STLD-T3151, STLD-T3158, STLD-T3164, STLD-T3168
Delivery metrics:
- Package publish->install success rate >= 95%
- Trace coverage across onboarding critical path >= 90%

### S5: Release Gates and Pilot Proof
Goal: Close release-critical security/QA gates and prove repeatable pilot outcomes.
Tickets: STLD-T3137, STLD-T3138, STLD-T3139, STLD-T3140, STLD-T3146, STLD-T3147, STLD-T3148, STLD-T3152, STLD-T3153, STLD-T3159, STLD-T3169
Delivery metrics:
- Production-cutover and evidence parity gates pass 100%
- At least 5 pilots complete with >70% weekly active usage

### S6: Launch Rollout Control
Goal: Execute staged rollout with auto-rollback safety and complete launch readiness sign-off.
Tickets: STLD-T3154, STLD-T3170
Delivery metrics:
- Rollback drill success <= 5 minutes mean time to rollback
- Launch packet approved by PM+Tech+Security gates

## Governance Rules
1. No onboarding step can silently skip failures; all failures must emit stable reason codes.
2. Wallet adapter launches require conformance suite pass and signature verification enabled.
3. Release requires production-cutover-gate pass plus evidence parity gate pass.
4. Pilot launch decision requires measurable adoption and reliability thresholds in scorecards.
