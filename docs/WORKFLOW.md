# Workflow (Single Source Of Truth)

Planning and execution are intentionally simple:

1. **GitHub Issues** are the only live backlog (single source of truth).
2. **PRs** are the unit of shipping. Every PR must link an Issue.
3. **CI** is fail-closed for kernel invariants (protocol, verification, settlement, determinism).

## Planning

- Create an Issue using an issue form (feature/bug/ops/ci).
- Assign labels:
  - one `prio:*`
  - one `stream:*`
  - one `type:*`
- Put the Issue in the current Milestone (e.g. `S20`).

## Shipping

- Branch naming: `issue/<number>-<slug>` (e.g. `issue/123-mcp-tool-manifests`)
- PR title: include the Issue number (e.g. `#123 ...`)
- PR description: include `Closes #123` so merge closes the Issue.

## Definition Of Done (DoD)

- Tests added/updated for behavioral changes.
- Protocol changes include docs + schema + vectors/fixtures (lockstep).
- Ops-impacting changes include runbook updates.
- CI green on all required checks.

## In-Repo Planning Files

- `planning/STATUS.md` is only a pointer to GitHub Issues.
- Implementation trackers under `planning/sprints/` are evidence records (what shipped), not a live backlog.

