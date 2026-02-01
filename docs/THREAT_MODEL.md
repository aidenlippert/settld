# Threat Model (v0)

## Assets to protect

- Physical safety of people/property.
- Requester privacy (sensor data, recordings).
- Financial correctness (ledger, payouts, refunds).
- Integrity of black box logs (events/evidence).
- Integrity of skill artifacts (bundles, versions).
- Device identity (robot/agent keys).

## Primary attackers

- Compromised robot/agent device.
- Malicious skill developer (or supply-chain compromise).
- Insider misuse (operator overreach).
- Requester/owner fraud (false claims, tampered evidence).
- Network attacker (MITM, replay).

## Controls (MVP principles)

- Device identity: per-agent keypair; rotate credentials; restrict API tokens.
- Transport security: mTLS for agent; scoped auth for consoles and apps.
- Artifact integrity: signed skill bundles; allow-list certified tiers.
- Log integrity: hash-chained event logs; signatures from agent keys.
- Least privilege: capability-limited skills; scoped operator actions.
- Revocation: access plans and device certs can be revoked immediately.
- Audit: immutable operator action log and evidence bundle timeline.

## Abuse scenarios to design for

- Operator issues unsafe command → agent clamps; event logged.
- Skill tries to activate camera in privacy-off zone → denied; event logged.
- Attempt to delete/reorder events → chain verification fails.
- Chargeback/refund disputes → ledger + evidence bundle support resolution.

