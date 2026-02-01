# Skill Certification Checklist (v0)

## Static checks

- Declares required capabilities (no undeclared API calls).
- Declares safety constraints (force/speed/contact).
- Declares privacy profile (sensors, retention).
- No forbidden syscalls / no network egress from skill runtime (policy decision).
- Deterministic policy graph passes schema validation.

## Simulation

- Passes baseline navigation/manipulation tests.
- Passes “edge” scenarios (clutter, lighting changes, occlusion).
- Timeouts and abort paths behave safely.
- Evidence triggers fire on impacts/uncertainty/assist start.

## Hardware-in-loop (lab apartment)

- Repeated runs meet completion + incident thresholds.
- Operator assist path is usable and logs actions correctly.
- Local policy enforcement clamps unsafe command attempts.

## Privacy review

- Media capture respects privacy mode and zones.
- Evidence is minimal by default; only triggered bundles retained.

## Release controls

- Tier gating: `lab_cert` → limited environments; `field_cert` → broader.
- Rollback plan and regression monitoring.

