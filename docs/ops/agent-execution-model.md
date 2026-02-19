# Settld Multi-Agent Execution Model

This guide defines how contributors split work across agents without conflicting edits or ambiguous ownership.

## Roles

- `Requester`: defines goal, constraints, owned paths, and acceptance criteria.
- `Coordinator`: breaks work into bounded tasks, assigns owners, and validates handoffs.
- `Implementer`: edits only assigned files, runs local checks, and produces a handoff packet.
- `Reviewer`: verifies scope, behavior, and acceptance criteria; rejects incomplete packets.

## Request Format

Use this structure for every agent task:

```md
Objective: <single outcome>
Owned paths: <explicit file or directory allowlist>
Out of scope: <explicit denylist>
Inputs: <specs, tickets, prior artifacts>
Deliverable: <what must be produced>
Acceptance criteria:
- <testable criterion 1>
- <testable criterion 2>
```

## Ownership Boundaries

- Each task must include an `Owned paths` allowlist.
- Agents must not edit outside their allowlist, even for "quick fixes."
- If a required change crosses boundaries, stop and request a new assignment.
- Ignore unrelated repository changes unless they overlap owned files.
- Never revert or rewrite work from other agents without explicit reassignment.

## Required Handoff Packet

Every completed task must include:

- `Scope`: exact files changed.
- `Change summary`: what changed and why.
- `Validation`: commands run and pass/fail outcome.
- `Risks`: known edge cases, follow-ups, or deferred work.
- `Ready-for-review statement`: explicit confirmation that acceptance criteria are met.

Recommended template:

```md
Scope:
- path/to/file-a
- path/to/file-b

Change summary:
- ...

Validation:
- <command>: pass
- <command>: fail (reason)

Risks / follow-ups:
- ...

Acceptance:
- [x] Criterion 1
- [x] Criterion 2
```

## Acceptance Criteria (Task-Level)

A task is accepted only when all are true:

- Changes are limited to owned paths.
- All listed acceptance criteria are demonstrably satisfied.
- Handoff packet is complete and accurate.
- Validation evidence is reproducible by another contributor.
- No unresolved blocker is hidden in notes.

## Common Failure Modes

- Missing or vague `Owned paths`, leading to overlapping edits.
- Requests without measurable acceptance criteria.
- Handoffs that summarize changes but omit validation evidence.
- Silent scope creep into unrelated files.
- "Works locally" claims without command output or reproducible steps.
- Reviewer approval despite incomplete packet or unchecked criteria.
