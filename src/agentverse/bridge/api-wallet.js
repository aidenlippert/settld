import { requireNonEmptyString, resolveApiClient } from './api-client.js';

function encodePath(value) {
  return encodeURIComponent(requireNonEmptyString(value, 'path value'));
}

function withIdempotency(options = {}) {
  return options.idempotencyKey ? { ...options, write: true, idempotencyKey: options.idempotencyKey } : { ...options, write: true };
}

export function createWalletApi(clientOrOptions = {}) {
  const client = resolveApiClient(clientOrOptions);
  return {
    client,
    getAgentWallet(agentId, options = {}) {
      return client.request(`/agents/${encodePath(agentId)}/wallet`, options);
    },
    creditAgentWallet(agentId, body, options = {}) {
      return client.request(`/agents/${encodePath(agentId)}/wallet/credit`, {
        ...withIdempotency(options),
        method: 'POST',
        body
      });
    },
    bootstrapTenantWallet(tenantId, body, options = {}) {
      return client.request(`/v1/tenants/${encodePath(tenantId)}/onboarding/wallet-bootstrap`, {
        ...withIdempotency(options),
        method: 'POST',
        body
      });
    },
    requestTenantWalletFunding(tenantId, body, options = {}) {
      return client.request(`/v1/tenants/${encodePath(tenantId)}/onboarding/wallet-funding`, {
        ...withIdempotency(options),
        method: 'POST',
        body
      });
    },
    createX402Wallet(body, options = {}) {
      return client.request('/x402/wallets', {
        ...withIdempotency(options),
        method: 'POST',
        body
      });
    },
    getX402WalletPolicy(sponsorWalletRef, params = {}, options = {}) {
      return client.request(`/x402/wallets/${encodePath(sponsorWalletRef)}/policy`, {
        ...options,
        query: params
      });
    },
    putX402WalletPolicy(sponsorWalletRef, body, options = {}) {
      return client.request(`/x402/wallets/${encodePath(sponsorWalletRef)}/policy`, {
        ...withIdempotency(options),
        method: 'PUT',
        body
      });
    }
  };
}
