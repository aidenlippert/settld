# Settld API SDK (Python)

Python client for Settld API endpoints, including high-level helpers:
- `first_verified_run` (register agents, run work, verify, settle)
- `first_paid_rfq` (rfq -> bid -> accept -> run -> settlement)
- tool-call kernel wrappers:
  - `create_agreement`
  - `sign_evidence`
  - `settle`
  - `create_hold`
  - `build_dispute_open_envelope`
  - `open_dispute`
  - `ops_get_tool_call_replay_evaluate`
  - `ops_get_reputation_facts`
  - `get_artifact` / `get_artifacts`
- run settlement/dispute lifecycle: `get_run_settlement_policy_replay`, `resolve_run_settlement`, `open_run_dispute`, `submit_run_dispute_evidence`, `escalate_run_dispute`, `close_run_dispute`
- `get_tenant_analytics` / `get_tenant_trust_graph`
- `list_tenant_trust_graph_snapshots` / `create_tenant_trust_graph_snapshot` / `diff_tenant_trust_graph`
- auth headers: `api_key` (Bearer), optional `x_api_key` (Magic Link), and optional `ops_token` (`x-proxy-ops-token`)

Quickstart docs live in `docs/QUICKSTART_SDK_PYTHON.md` at repo root.
