-- ReputationEvent.v1 index table for fast `(tenant, agent, tool?, occurredAt)` queries.
-- Keeps immutable artifact payload in `artifacts`, while indexing query-critical keys.

CREATE TABLE IF NOT EXISTS reputation_event_index (
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  subject_agent_id TEXT NOT NULL,
  subject_tool_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  event_kind TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, artifact_id) REFERENCES artifacts (tenant_id, artifact_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reputation_event_index_by_subject_tool_time
  ON reputation_event_index (tenant_id, subject_agent_id, subject_tool_id, occurred_at DESC, artifact_id DESC);

CREATE INDEX IF NOT EXISTS reputation_event_index_by_subject_time
  ON reputation_event_index (tenant_id, subject_agent_id, occurred_at DESC, artifact_id DESC);

CREATE INDEX IF NOT EXISTS reputation_event_index_by_tenant_time
  ON reputation_event_index (tenant_id, occurred_at DESC, artifact_id DESC);

-- Backfill index rows from already-persisted ReputationEvent artifacts.
INSERT INTO reputation_event_index (
  tenant_id,
  artifact_id,
  artifact_hash,
  subject_agent_id,
  subject_tool_id,
  occurred_at,
  event_kind,
  source_kind,
  source_hash
)
SELECT
  a.tenant_id,
  a.artifact_id,
  a.artifact_hash,
  a.artifact_json->'subject'->>'agentId' AS subject_agent_id,
  NULLIF(a.artifact_json->'subject'->>'toolId', '') AS subject_tool_id,
  a.created_at AS occurred_at,
  lower(COALESCE(a.artifact_json->>'eventKind', 'unknown')) AS event_kind,
  lower(COALESCE(a.artifact_json->'sourceRef'->>'kind', 'unknown')) AS source_kind,
  NULLIF(lower(a.artifact_json->'sourceRef'->>'hash'), '') AS source_hash
FROM artifacts a
WHERE a.artifact_type = 'ReputationEvent.v1'
  AND jsonb_typeof(a.artifact_json) = 'object'
  AND COALESCE(a.artifact_json->'subject'->>'agentId', '') <> ''
ON CONFLICT (tenant_id, artifact_id) DO NOTHING;
