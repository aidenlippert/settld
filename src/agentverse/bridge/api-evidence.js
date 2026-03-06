import { requireNonEmptyString, resolveApiClient } from './api-client.js';

function encodePath(value) {
  return encodeURIComponent(requireNonEmptyString(value, 'path value'));
}

function assertStateCheckpointBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('state checkpoint body must be an object');
  }
  requireNonEmptyString(body.ownerAgentId, 'body.ownerAgentId');
  if (!body.stateRef || typeof body.stateRef !== 'object' || Array.isArray(body.stateRef)) {
    throw new TypeError('body.stateRef is required');
  }
  requireNonEmptyString(body.stateRef.artifactId, 'body.stateRef.artifactId');
  requireNonEmptyString(body.stateRef.artifactHash, 'body.stateRef.artifactHash');
}

export function createEvidenceApi(clientOrOptions = {}) {
  const client = resolveApiClient(clientOrOptions);
  return {
    client,
    createStateCheckpoint(body, options = {}) {
      assertStateCheckpointBody(body);
      return client.request('/state-checkpoints', {
        ...options,
        method: 'POST',
        write: true,
        idempotencyKey: options.idempotencyKey ?? null,
        body
      });
    },
    listStateCheckpoints(params = {}, options = {}) {
      return client.request('/state-checkpoints', { ...options, query: params });
    },
    getStateCheckpoint(checkpointId, options = {}) {
      return client.request(`/state-checkpoints/${encodePath(checkpointId)}`, options);
    },
    getArtifact(artifactId, options = {}) {
      return client.request(`/artifacts/${encodePath(artifactId)}`, options);
    },
    listWorkOrderReceipts(params = {}, options = {}) {
      return client.request('/work-orders/receipts', { ...options, query: params });
    },
    getWorkOrderReceipt(receiptId, options = {}) {
      return client.request(`/work-orders/receipts/${encodePath(receiptId)}`, options);
    }
  };
}
