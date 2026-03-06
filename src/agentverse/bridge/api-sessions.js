import { requireNonEmptyString, resolveApiClient } from './api-client.js';

function encodePath(value) {
  return encodeURIComponent(requireNonEmptyString(value, 'path value'));
}

function withIdempotency(options = {}) {
  return options.idempotencyKey ? { ...options, write: true, idempotencyKey: options.idempotencyKey } : { ...options, write: true };
}

export function createSessionsApi(clientOrOptions = {}) {
  const client = resolveApiClient(clientOrOptions);
  return {
    client,
    createSession(body, options = {}) {
      return client.request('/sessions', { ...withIdempotency(options), method: 'POST', body });
    },
    listSessions(params = {}, options = {}) {
      return client.request('/sessions', { ...options, query: params });
    },
    getSession(sessionId, options = {}) {
      return client.request(`/sessions/${encodePath(sessionId)}`, options);
    },
    listEvents(sessionId, params = {}, options = {}) {
      return client.request(`/sessions/${encodePath(sessionId)}/events`, { ...options, query: params });
    },
    appendEvent(sessionId, body, options = {}) {
      return client.request(`/sessions/${encodePath(sessionId)}/events`, {
        ...withIdempotency(options),
        method: 'POST',
        expectedPrevChainHash: options.expectedPrevChainHash ?? null,
        body
      });
    },
    getReplayPack(sessionId, params = {}, options = {}) {
      return client.request(`/sessions/${encodePath(sessionId)}/replay-pack`, { ...options, query: params });
    },
    getTranscript(sessionId, params = {}, options = {}) {
      return client.request(`/sessions/${encodePath(sessionId)}/transcript`, { ...options, query: params });
    },
    getCheckpoint(sessionId, checkpointConsumerId, options = {}) {
      return client.request(`/sessions/${encodePath(sessionId)}/events/checkpoint`, {
        ...options,
        query: { ...(options.query ?? {}), checkpointConsumerId: requireNonEmptyString(checkpointConsumerId, 'checkpointConsumerId') }
      });
    },
    ackCheckpoint(sessionId, body, options = {}) {
      return client.request(`/sessions/${encodePath(sessionId)}/events/checkpoint`, {
        ...withIdempotency(options),
        method: 'POST',
        body
      });
    },
    requeueCheckpoint(sessionId, body, options = {}) {
      return client.request(`/sessions/${encodePath(sessionId)}/events/checkpoint/requeue`, {
        ...withIdempotency(options),
        method: 'POST',
        body
      });
    },
    streamEvents(sessionId, params = {}, options = {}) {
      const query = { ...params };
      const maxEvents =
        Number.isSafeInteger(Number(options.maxEvents)) && Number(options.maxEvents) > 0
          ? Number(options.maxEvents)
          : Number.isSafeInteger(Number(params.maxEvents)) && Number(params.maxEvents) > 0
            ? Number(params.maxEvents)
            : 100;
      const timeoutMs =
        Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
          ? Number(options.timeoutMs)
          : Number.isFinite(Number(params.timeoutMs)) && Number(params.timeoutMs) > 0
            ? Number(params.timeoutMs)
            : 30_000;
      return client.requestSse(`/sessions/${encodePath(sessionId)}/events/stream`, {
        ...options,
        query,
        maxEvents,
        timeoutMs,
        lastEventId: options.lastEventId ?? params.lastEventId ?? null
      });
    }
  };
}
