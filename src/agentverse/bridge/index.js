import { resolveApiClient } from './api-client.js';
import { createEvidenceApi } from './api-evidence.js';
import { createMarketplaceApi } from './api-marketplace.js';
import { createPolicyApi } from './api-policy.js';
import { createRegistryApi } from './api-registry.js';
import { createReputationApi } from './api-reputation.js';
import { createRouterApi } from './api-router.js';
import { createSessionsApi } from './api-sessions.js';
import { createWalletApi } from './api-wallet.js';

export { AgentverseApiClient, createApiClient, requireNonEmptyString, resolveApiClient } from './api-client.js';
export { createRegistryApi } from './api-registry.js';
export { createEvidenceApi } from './api-evidence.js';
export { createMarketplaceApi } from './api-marketplace.js';
export { createReputationApi } from './api-reputation.js';
export { createRouterApi } from './api-router.js';
export { createSessionsApi } from './api-sessions.js';
export { createWalletApi } from './api-wallet.js';
export { createPolicyApi } from './api-policy.js';

export function createBridgeApis(clientOrOptions = {}) {
  const client = resolveApiClient(clientOrOptions);
  return {
    client,
    registry: createRegistryApi(client),
    evidence: createEvidenceApi(client),
    marketplace: createMarketplaceApi(client),
    reputation: createReputationApi(client),
    router: createRouterApi(client),
    sessions: createSessionsApi(client),
    wallet: createWalletApi(client),
    policy: createPolicyApi(client)
  };
}
