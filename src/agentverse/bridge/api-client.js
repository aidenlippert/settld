function normalizeOptionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeBaseUrl(rawBaseUrl) {
  const raw = normalizeOptionalString(rawBaseUrl ?? process.env.NOOTERRA_BASE_URL ?? 'http://127.0.0.1:3000');
  if (!raw) throw new TypeError('baseUrl is required');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('baseUrl must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('baseUrl must use http(s)');
  }
  return url.toString().replace(/\/+$/, '');
}

function normalizeBearerToken(token) {
  const raw = normalizeOptionalString(token);
  if (!raw) return null;
  return /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

function assertNonEmptyString(value, fieldName) {
  const text = normalizeOptionalString(value);
  if (!text) throw new TypeError(`${fieldName} is required`);
  return text;
}

function parseJsonOrRaw(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function appendQueryParams(searchParams, query) {
  if (!query) return;
  if (query instanceof URLSearchParams) {
    for (const [key, value] of query.entries()) {
      if (value === null || value === undefined || String(value).trim() === '') continue;
      searchParams.append(String(key), String(value));
    }
    return;
  }
  const keys = Object.keys(query).sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    const value = query[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === null || entry === undefined || String(entry).trim() === '') continue;
        searchParams.append(String(key), String(entry));
      }
      continue;
    }
    if (typeof value === 'boolean') {
      searchParams.set(String(key), value ? 'true' : 'false');
      continue;
    }
    searchParams.set(String(key), String(value));
  }
}

function parseSseFrame(frameText) {
  const normalized = String(frameText ?? '').replace(/\r/g, '');
  if (!normalized.trim()) return null;
  const lines = normalized.split('\n');
  let event = 'message';
  let id = null;
  const dataLines = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(':')) continue;
    const splitIndex = line.indexOf(':');
    const field = splitIndex === -1 ? line : line.slice(0, splitIndex);
    let value = splitIndex === -1 ? '' : line.slice(splitIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    if (field === 'id') id = value || null;
    if (field === 'data') dataLines.push(value);
  }
  const rawData = dataLines.join('\n');
  let data = rawData;
  try {
    data = rawData ? JSON.parse(rawData) : null;
  } catch {
    // Leave data as a string when JSON parsing fails.
  }
  return { event, id, data, rawData };
}

export class AgentverseApiClient {
  constructor({
    baseUrl = process.env.NOOTERRA_BASE_URL ?? 'http://127.0.0.1:3000',
    protocol = process.env.NOOTERRA_PROTOCOL ?? '1.0',
    tenantId = process.env.NOOTERRA_TENANT_ID ?? null,
    apiKey = process.env.NOOTERRA_API_KEY ?? null,
    opsToken = process.env.NOOTERRA_OPS_TOKEN ?? null,
    bearerToken = process.env.NOOTERRA_BEARER_TOKEN ?? null,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.protocol = assertNonEmptyString(protocol, 'protocol');
    this.tenantId = normalizeOptionalString(tenantId);
    this.apiKey = normalizeOptionalString(apiKey);
    this.opsToken = normalizeOptionalString(opsToken);
    this.bearerToken = normalizeBearerToken(bearerToken);
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('fetchImpl must be a function');
    }
    this.fetchImpl = fetchImpl;
  }

  buildHeaders({
    headers = {},
    write = false,
    idempotencyKey = null,
    expectedPrevChainHash = null,
    body = null,
    principalId = null,
    lastEventId = null
  } = {}) {
    const out = {
      accept: 'application/json',
      'x-nooterra-protocol': this.protocol,
      ...headers
    };
    if (this.tenantId && !out['x-proxy-tenant-id']) out['x-proxy-tenant-id'] = this.tenantId;
    if (this.apiKey && !out['x-proxy-api-key']) out['x-proxy-api-key'] = this.apiKey;
    if (this.opsToken && !out['x-proxy-ops-token']) out['x-proxy-ops-token'] = this.opsToken;
    if (this.bearerToken && !out.authorization) out.authorization = this.bearerToken;
    if (write && idempotencyKey) out['x-idempotency-key'] = String(idempotencyKey);
    if (expectedPrevChainHash) out['x-proxy-expected-prev-chain-hash'] = String(expectedPrevChainHash);
    if (principalId) out['x-proxy-principal-id'] = String(principalId);
    if (lastEventId) out['last-event-id'] = String(lastEventId);

    const hasBody = body !== null && body !== undefined;
    const hasContentType = Object.keys(out).some((key) => key.toLowerCase() === 'content-type');
    if (hasBody && !hasContentType) out['content-type'] = 'application/json';
    return out;
  }

  buildUrl(pathname, query = null) {
    const path = String(pathname ?? '').trim();
    if (!path) throw new TypeError('pathname is required');
    const url = new URL(path.startsWith('/') ? path : `/${path}`, this.baseUrl);
    appendQueryParams(url.searchParams, query);
    return url;
  }

  async request(
    pathname,
    {
      method = 'GET',
      query = null,
      headers = {},
      body = null,
      write = false,
      idempotencyKey = null,
      expectedPrevChainHash = null,
      principalId = null,
      signal = undefined
    } = {}
  ) {
    const url = this.buildUrl(pathname, query);
    const requestMethod = assertNonEmptyString(method, 'method').toUpperCase();
    const requestHeaders = this.buildHeaders({
      headers,
      write,
      idempotencyKey,
      expectedPrevChainHash,
      body,
      principalId
    });
    const res = await this.fetchImpl(url.toString(), {
      method: requestMethod,
      headers: requestHeaders,
      body: body === null || body === undefined ? undefined : JSON.stringify(body),
      signal
    });
    const text = await res.text();
    const payload = parseJsonOrRaw(text);
    if (!res.ok) {
      const message = payload?.error ?? payload?.message ?? `${requestMethod} ${url.pathname} failed with ${res.status}`;
      const error = new Error(String(message));
      error.status = res.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async requestSse(
    pathname,
    {
      query = null,
      headers = {},
      maxEvents = 100,
      timeoutMs = 30_000,
      onEvent = null,
      signal = undefined,
      lastEventId = null,
      principalId = null
    } = {}
  ) {
    const safeMaxEvents = Number.isSafeInteger(Number(maxEvents)) && Number(maxEvents) > 0 ? Number(maxEvents) : 100;
    const safeTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('session stream timeout')), safeTimeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const url = this.buildUrl(pathname, query);
      const requestHeaders = this.buildHeaders({
        headers: { accept: 'text/event-stream', ...headers },
        principalId,
        lastEventId
      });
      const res = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: requestHeaders,
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text();
        const payload = parseJsonOrRaw(text);
        const message = payload?.error ?? payload?.message ?? `GET ${url.pathname} failed with ${res.status}`;
        const error = new Error(String(message));
        error.status = res.status;
        error.payload = payload;
        throw error;
      }
      if (!res.body || typeof res.body.getReader !== 'function') {
        throw new Error('stream response body is not readable');
      }

      const events = [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (events.length < safeMaxEvents) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (events.length < safeMaxEvents) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary < 0) break;
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const parsed = parseSseFrame(frame);
            if (!parsed) continue;
            events.push(parsed);
            if (typeof onEvent === 'function') onEvent(parsed);
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation races during shutdown.
        }
      }

      return events;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

export function createApiClient(options = {}) {
  return new AgentverseApiClient(options);
}

export function resolveApiClient(clientOrOptions = {}) {
  if (clientOrOptions instanceof AgentverseApiClient) return clientOrOptions;
  return createApiClient(clientOrOptions);
}

export function requireNonEmptyString(value, fieldName) {
  return assertNonEmptyString(value, fieldName);
}
