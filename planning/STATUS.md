# Status (Single Source Of Truth)

Snapshot date: 2026-02-10

From now on, **planning lives in GitHub Issues** (milestones + labels). This file is just the pointer.

## Where To Look

- Open work: GitHub Issues (filter by milestone, labels `prio:*` + `stream:*`)
- Sprint boundary: GitHub Milestone (e.g. `S20`)
- What shipped: PRs merged to `main` (each PR must close/link an Issue)

Handy commands:

- List S20 issues: `gh issue list --milestone S20 --label prio:p0 --repo aidenlippert/settld`
- List all open: `gh issue list --repo aidenlippert/settld`

## What Stays In-Repo

- Evidence trackers remain as immutable evidence records (runbooks, gate outputs, tests).
- We do not maintain a second in-repo “open/closed” backlog anymore.

## Recent Evidence Trackers

- S14-S19 shipped status is frozen in `planning/sprints/s14-s19-implementation-tracker.md` (evidence: code paths + tests + runbooks).
