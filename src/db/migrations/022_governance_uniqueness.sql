-- v1.15: governance semantic uniqueness constraints (DB-backed).

-- Tenant governance: only one TENANT_POLICY_UPDATED per effectiveFrom per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS governance_tenant_policy_effective_from_unique
  ON events (tenant_id, (payload_json->>'effectiveFrom'))
  WHERE aggregate_type = 'month'
    AND aggregate_id = 'governance'
    AND type = 'TENANT_POLICY_UPDATED';

-- Global governance: server signer key lifecycle uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS governance_server_key_registered_unique
  ON events (tenant_id, (payload_json->>'keyId'))
  WHERE aggregate_type = 'month'
    AND aggregate_id = 'governance'
    AND type = 'SERVER_SIGNER_KEY_REGISTERED';

CREATE UNIQUE INDEX IF NOT EXISTS governance_server_key_revoked_unique
  ON events (tenant_id, (payload_json->>'keyId'))
  WHERE aggregate_type = 'month'
    AND aggregate_id = 'governance'
    AND type = 'SERVER_SIGNER_KEY_REVOKED';

CREATE UNIQUE INDEX IF NOT EXISTS governance_server_key_rotated_old_unique
  ON events (tenant_id, (payload_json->>'oldKeyId'))
  WHERE aggregate_type = 'month'
    AND aggregate_id = 'governance'
    AND type = 'SERVER_SIGNER_KEY_ROTATED';

