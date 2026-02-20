# MCP Compatibility Matrix

Track real host compatibility evidence here. Update on every major host release or Settld MCP change.

## Status legend

- `green`: passes required flow end-to-end
- `yellow`: partially working; known gaps
- `red`: blocked

## Required flow (all hosts)

1. Host discovers `settld.*` tools.
2. `settld.about` succeeds.
3. One paid tool call succeeds (`settld.exa_search_paid` or `settld.weather_current_paid`).
4. `x-settld-*` settlement/verification headers are present.
5. Artifact output exists and verifies.

## Matrix

| Host | Host Version | Transport | Status | Last Verified (UTC) | Evidence Link | Notes |
|---|---|---|---|---|---|---|
| Claude | TBD | stdio | TBD | TBD | TBD | |
| Cursor | TBD | stdio | TBD | TBD | TBD | |
| Codex | TBD | stdio | TBD | TBD | TBD | |
| OpenClaw | TBD | stdio | TBD | TBD | TBD | |
| Generic MCP HTTP client | TBD | HTTP bridge | TBD | TBD | TBD | |
