import { resolveApiClient } from './api-client.js';

function withWriteOptions(options = {}) {
  return options.idempotencyKey ? { ...options, write: true, idempotencyKey: options.idempotencyKey } : { ...options, write: true };
}

export function createRouterApi(clientOrOptions = {}) {
  const client = resolveApiClient(clientOrOptions);
  return {
    client,
    plan(body, options = {}) {
      return client.request('/router/plan', {
        ...options,
        method: 'POST',
        body
      });
    },
    launch(body, options = {}) {
      return client.request('/router/launch', {
        ...withWriteOptions(options),
        method: 'POST',
        body
      });
    },
    dispatch(body, options = {}) {
      return client.request('/router/dispatch', {
        ...withWriteOptions(options),
        method: 'POST',
        body
      });
    }
  };
}
