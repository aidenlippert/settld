import { requireNonEmptyString, resolveApiClient } from './api-client.js';

function encodePath(value) {
  return encodeURIComponent(requireNonEmptyString(value, 'path value'));
}

export function createRegistryApi(clientOrOptions = {}) {
  const client = resolveApiClient(clientOrOptions);
  return {
    client,
    resolveAgent(agentRef, options = {}) {
      return client.request('/v1/public/agents/resolve', {
        ...options,
        query: { ...(options.query ?? {}), agent: requireNonEmptyString(agentRef, 'agentRef') }
      });
    },
    listAgents(params = {}, options = {}) {
      return client.request('/agents', { ...options, query: params });
    },
    getAgent(agentId, options = {}) {
      return client.request(`/agents/${encodePath(agentId)}`, options);
    },
    listAgentCards(params = {}, options = {}) {
      return client.request('/agent-cards', { ...options, query: params });
    },
    getAgentCard(agentId, options = {}) {
      return client.request(`/agent-cards/${encodePath(agentId)}`, options);
    },
    discoverAgentCards(params = {}, options = {}) {
      return client.request('/agent-cards/discover', { ...options, query: params });
    },
    discoverPublicAgentCards(params = {}, options = {}) {
      return client.request('/public/agent-cards/discover', { ...options, query: params });
    }
  };
}
