import { requireNonEmptyString, resolveApiClient } from './api-client.js';

function encodePath(value) {
  return encodeURIComponent(requireNonEmptyString(value, 'path value'));
}

function withWriteOptions(options = {}) {
  return options.idempotencyKey ? { ...options, write: true, idempotencyKey: options.idempotencyKey } : { ...options, write: true };
}

export function createMarketplaceApi(clientOrOptions = {}) {
  const client = resolveApiClient(clientOrOptions);
  return {
    client,
    listRfqs(params = {}, options = {}) {
      return client.request('/marketplace/rfqs', { ...options, query: params });
    },
    createRfq(body, options = {}) {
      return client.request('/marketplace/rfqs', {
        ...withWriteOptions(options),
        method: 'POST',
        body
      });
    },
    listBids(rfqId, params = {}, options = {}) {
      return client.request(`/marketplace/rfqs/${encodePath(rfqId)}/bids`, {
        ...options,
        query: params
      });
    },
    submitBid(rfqId, body, options = {}) {
      return client.request(`/marketplace/rfqs/${encodePath(rfqId)}/bids`, {
        ...withWriteOptions(options),
        method: 'POST',
        body
      });
    },
    counterOfferBid(rfqId, bidId, body, options = {}) {
      return client.request(`/marketplace/rfqs/${encodePath(rfqId)}/bids/${encodePath(bidId)}/counter-offer`, {
        ...withWriteOptions(options),
        method: 'POST',
        body
      });
    },
    acceptBid(rfqId, body, options = {}) {
      return client.request(`/marketplace/rfqs/${encodePath(rfqId)}/accept`, {
        ...withWriteOptions(options),
        method: 'POST',
        body
      });
    },
    autoAcceptBid(rfqId, body = {}, options = {}) {
      return client.request(`/marketplace/rfqs/${encodePath(rfqId)}/auto-accept`, {
        ...withWriteOptions(options),
        method: 'POST',
        body
      });
    }
  };
}
