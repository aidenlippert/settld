import { requireNonEmptyString, resolveApiClient } from './api-client.js';

function encodePath(value) {
  return encodeURIComponent(requireNonEmptyString(value, 'path value'));
}

function withIdempotency(options = {}) {
  return options.idempotencyKey ? { ...options, write: true, idempotencyKey: options.idempotencyKey } : { ...options, write: true };
}

export function createPolicyApi(clientOrOptions = {}) {
  const client = resolveApiClient(clientOrOptions);
  return {
    client,
    listMarketplaceSettlementPolicies(params = {}, options = {}) {
      return client.request('/marketplace/settlement-policies', { ...options, query: params });
    },
    getMarketplaceSettlementPolicy(policyId, policyVersion, options = {}) {
      const safePolicyVersion = Number(policyVersion);
      if (!Number.isSafeInteger(safePolicyVersion) || safePolicyVersion <= 0) {
        throw new TypeError('policyVersion must be a positive safe integer');
      }
      return client.request(`/marketplace/settlement-policies/${encodePath(policyId)}/${encodePath(String(safePolicyVersion))}`, options);
    },
    upsertMarketplaceSettlementPolicy(body, options = {}) {
      return client.request('/marketplace/settlement-policies', {
        ...withIdempotency(options),
        method: 'POST',
        body
      });
    },
    getRunSettlementPolicyReplay(runId, options = {}) {
      return client.request(`/runs/${encodePath(runId)}/settlement/policy-replay`, options);
    },
    listOpsX402WalletPolicies(params = {}, options = {}) {
      return client.request('/ops/x402/wallet-policies', { ...options, query: params });
    },
    getOpsX402WalletPolicy(sponsorWalletRef, policyRef, policyVersion, options = {}) {
      const safePolicyVersion = Number(policyVersion);
      if (!Number.isSafeInteger(safePolicyVersion) || safePolicyVersion <= 0) {
        throw new TypeError('policyVersion must be a positive safe integer');
      }
      return client.request(
        `/ops/x402/wallet-policies/${encodePath(sponsorWalletRef)}/${encodePath(policyRef)}/${encodePath(String(safePolicyVersion))}`,
        options
      );
    },
    upsertOpsX402WalletPolicy(body, options = {}) {
      return client.request('/ops/x402/wallet-policies', {
        ...withIdempotency(options),
        method: 'POST',
        body
      });
    }
  };
}
