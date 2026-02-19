# Planning Directory Guide

This repo has multiple planning artifacts because we use different formats for different jobs.

If you're asking **"what's still open?"**, start with `planning/STATUS.md` and then go to GitHub Issues.

## Source Of Truth (What To Read First)

- `planning/STATUS.md`
  - Pointer to the single live backlog: GitHub Issues (milestones + labels).

## Evidence Trackers (What Was Actually Shipped)

- `planning/sprints/s14-s19-implementation-tracker.md`
  - Evidence-based tracker for S14-S19 (code paths + tests + runbooks).
  - Use this to answer "is S14/S15 actually done?"

- `planning/sprints/self-serve-icp-v1-30-day.md`
  - 30-day self-serve launch board for ICP v1 (tickets STLD-T183..STLD-T199).

## Backlog Exports (Inputs, Not Status)

- `planning/jira/s14-s19-backlog.json`
  - Backlog export / intended scope for S14-S19.
  - Not automatically updated when work ships; status lives in the implementation tracker.

- `planning/jira/self-serve-icp-v1-backlog.json`
  - Backlog export / intended scope for self-serve launch.

## Historical Plans

- `planning/sprints/sprint-plan.md`
  - Multi-sprint plan (S1-S12) and earlier strategic assumptions.
  - Useful for context, but not a live status tracker.

- `planning/sprints/agent-economy-roadmap.md`
  - Long-horizon "agent economy" vision and sequencing (workstreams), not a live execution tracker.

- `planning/sprints/agent-economy-operating-plan.md`
  - Deep technical program architecture (Programs A-F), dependency graph, invariants, and acceptance gates.
  - Sequence-based (no date constraints), intended as execution design input.

- `planning/jira/agent-economy-backlog.json`
  - Jira-shaped epic/ticket backlog for Programs A-F with dependencies and gate criteria.
  - Input artifact; live open/closed state still belongs in GitHub Issues.

- `planning/jira/agent-economy-epics.csv` + `planning/jira/agent-economy-tickets.csv`
  - CSV exports of the same Program A-F backlog for quick Jira import.
