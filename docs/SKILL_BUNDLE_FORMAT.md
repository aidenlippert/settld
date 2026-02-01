# Skill Bundle Format (v0)

Settld skills are **signed bundles** with deterministic policies and testable constraints.

## Goals

- Portability: skill runs against a stable Capability API, not robot-specific SDKs.
- Certifiability: static checks + simulation + hardware-in-loop tests.
- Safety: constraints are explicit and enforced (agent clamps unsafe actions).
- Auditability: versioned, signed, and reproducible.

## Bundle layout (proposed)

```
skill/
  skill.json
  policy/
    graph.json
  tests/
    cases.json
  assets/
    ... optional (small models, prompts, classifiers)
  signatures/
    bundle.sig
```

### `skill.json` (metadata)

- `id`, `name`, `version`
- `developerId`
- `requiredCapabilities`
- `safetyConstraints` (speed/force envelopes, contact rules, allowed zones)
- `privacyProfile` (sensor usage, retention expectations)
- `certificationTier` (e.g., `dev`, `lab_cert`, `field_cert`)

### `policy/graph.json`

Deterministic policy representation (behavior tree or state machine) that calls Capability API primitives.

### `tests/cases.json`

- simulation cases and expected outcomes
- regression triggers (known failure modes)

### Signatures

- Signed by Settld certification key (tier-dependent).
- Agent verifies signature before installation/execution.
