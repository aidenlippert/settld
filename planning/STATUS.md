# Status (Single Source Of Truth)

Snapshot date: 2026-02-13

From now on, **planning lives in GitHub Issues** (milestones + labels). This file is just the pointer.

## Where To Look

- Open work: GitHub Issues (filter by milestone, labels `prio:*` + `stream:*`)
- Sprint boundary: GitHub Milestone (e.g. `S20`)
- What shipped: PRs merged to `main` (each PR must close/link an Issue)
- S23-S32 readiness bridge: `planning/sprints/s23-s32-readiness-plan.md`

Handy commands:

- List S20 issues: `gh issue list --milestone S20 --label prio:p0 --repo aidenlippert/settld`
- List S23 issues: `gh issue list --milestone S23 --repo aidenlippert/settld`
- List S32 issues: `gh issue list --milestone S32 --repo aidenlippert/settld`
- List all open: `gh issue list --repo aidenlippert/settld`

## What Stays In-Repo

- Evidence trackers remain as immutable evidence records (runbooks, gate outputs, tests).
- We do not maintain a second in-repo “open/closed” backlog anymore.
