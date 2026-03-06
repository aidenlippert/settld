import { requireNonEmptyString, resolveApiClient } from './api-client.js';

function encodePath(value) {
  return encodeURIComponent(requireNonEmptyString(value, 'path value'));
}

export function createReputationApi(clientOrOptions = {}) {
  const client = resolveApiClient(clientOrOptions);
  return {
    client,
    getPublicSummary(agentId, params = {}, options = {}) {
      return client.request(`/public/agents/${encodePath(agentId)}/reputation-summary`, {
        ...options,
        query: params
      });
    },
    listRelationships(params = {}, options = {}) {
      return client.request('/relationships', { ...options, query: params });
    },
    getInteractionGraphPack(agentId, params = {}, options = {}) {
      return client.request(`/agents/${encodePath(agentId)}/interaction-graph-pack`, {
        ...options,
        query: params
      });
    },
    getReputationFacts(params = {}, options = {}) {
      return client.request('/ops/reputation/facts', { ...options, query: params });
    }
  };
}
