import { parseProtocolVersion } from '../../core/protocol.js';
import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString,
  normalizeSafeInt
} from '../protocol/utils.js';

export const AGENTVERSE_TRANSPORT_REQUEST_SCHEMA_VERSION = 'AgentverseTransportRequest.v1';

function normalizeAbsoluteBaseUrl(baseUrl, name = 'baseUrl') {
  const raw = normalizeNonEmptyString(baseUrl, name, { max: 1024 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${name} must use http or https`);
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

export function computeTransportRequestHashV1(requestCore) {
  assertPlainObject(requestCore, 'requestCore');
  const copy = { ...requestCore };
  delete copy.requestHash;
  return canonicalHash(copy, { path: '$.transportRequest' });
}

export function buildTransportRequestV1({
  method = 'POST',
  path,
  headers = {},
  body = null,
  protocol = '1.0',
  timeoutMs = 15000,
  createdAt
} = {}) {
  if (!createdAt) throw new TypeError('createdAt is required to keep request generation deterministic');

  const normalizedMethod = normalizeNonEmptyString(method, 'method', { max: 16 }).toUpperCase();
  const normalizedPath = normalizeNonEmptyString(path, 'path', { max: 2048 });
  if (!normalizedPath.startsWith('/')) throw new TypeError('path must start with /');

  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('headers must be an object');
  }

  const canonicalHeaders = Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [String(key).trim().toLowerCase(), normalizeNonEmptyString(String(value), `headers.${String(key)}`, { max: 4096 })])
      .filter(([key]) => Boolean(key))
      .sort((left, right) => left[0].localeCompare(right[0]))
  );

  const requestCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_TRANSPORT_REQUEST_SCHEMA_VERSION,
      method: normalizedMethod,
      path: normalizedPath,
      headers: canonicalHeaders,
      body: body === undefined ? null : canonicalize(body, { path: '$.body' }),
      protocol: parseProtocolVersion(protocol).raw,
      timeoutMs: normalizeSafeInt(timeoutMs, 'timeoutMs', { min: 100, max: 120000 }),
      createdAt: normalizeIsoDateTime(createdAt, 'createdAt')
    },
    { path: '$.transportRequest' }
  );

  const requestHash = computeTransportRequestHashV1(requestCore);
  return canonicalize({ ...requestCore, requestHash }, { path: '$.transportRequest' });
}

export function buildDeterministicRetryPlanV1({
  attempts = 3,
  baseDelayMs = 200,
  maxDelayMs = 3000
} = {}) {
  const normalizedAttempts = normalizeSafeInt(attempts, 'attempts', { min: 1, max: 20 });
  const normalizedBaseDelayMs = normalizeSafeInt(baseDelayMs, 'baseDelayMs', { min: 1, max: 60000 });
  const normalizedMaxDelayMs = normalizeSafeInt(maxDelayMs, 'maxDelayMs', { min: normalizedBaseDelayMs, max: 120000 });

  const plan = [];
  for (let index = 0; index < normalizedAttempts; index += 1) {
    const delayMs = Math.min(normalizedMaxDelayMs, normalizedBaseDelayMs * 2 ** index);
    plan.push({ attempt: index + 1, delayMs });
  }
  return plan;
}

export function createFetchTransport({
  baseUrl,
  defaultHeaders = {},
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString()
} = {}) {
  const normalizedBaseUrl = normalizeAbsoluteBaseUrl(baseUrl, 'baseUrl');
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be available');
  }
  if (!defaultHeaders || typeof defaultHeaders !== 'object' || Array.isArray(defaultHeaders)) {
    throw new TypeError('defaultHeaders must be an object');
  }

  const normalizedDefaultHeaders = Object.fromEntries(
    Object.entries(defaultHeaders)
      .map(([key, value]) => [String(key).toLowerCase(), String(value)])
      .sort((left, right) => left[0].localeCompare(right[0]))
  );

  async function requestJson({
    method = 'GET',
    path,
    headers = {},
    body = null,
    protocol = '1.0',
    timeoutMs = 15000,
    createdAt = now()
  } = {}) {
    const request = buildTransportRequestV1({
      method,
      path,
      headers: {
        ...normalizedDefaultHeaders,
        ...headers,
        'x-nooterra-protocol': parseProtocolVersion(protocol).raw
      },
      body,
      protocol,
      timeoutMs,
      createdAt
    });

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await fetchImpl(`${normalizedBaseUrl}${request.path}`, {
        method: request.method,
        headers: request.headers,
        body: request.body === null ? undefined : JSON.stringify(request.body),
        signal: controller.signal
      });

      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { raw: text };
      }

      if (!response.ok) {
        const err = new Error(payload?.error || payload?.message || `transport request failed: ${response.status}`);
        err.status = response.status;
        err.request = request;
        err.payload = payload;
        throw err;
      }

      return {
        ok: true,
        status: response.status,
        request,
        payload
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async function sendEnvelope({ path = '/v1/federation/invoke', envelope, protocol = '1.0', timeoutMs = 15000, createdAt = now() } = {}) {
    return requestJson({
      method: 'POST',
      path,
      body: envelope,
      protocol,
      timeoutMs,
      createdAt,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      }
    });
  }

  return {
    requestJson,
    sendEnvelope,
    baseUrl: normalizedBaseUrl
  };
}

export function createInMemoryTransport({
  handler
} = {}) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');

  return {
    async requestJson({ method = 'GET', path, headers = {}, body = null, protocol = '1.0', timeoutMs = 15000, createdAt } = {}) {
      const request = buildTransportRequestV1({ method, path, headers, body, protocol, timeoutMs, createdAt });
      const payload = await handler(request);
      return {
        ok: true,
        status: 200,
        request,
        payload: payload === undefined ? null : payload
      };
    },
    async sendEnvelope({ path = '/v1/federation/invoke', envelope, protocol = '1.0', timeoutMs = 15000, createdAt } = {}) {
      return this.requestJson({
        method: 'POST',
        path,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: envelope,
        protocol,
        timeoutMs,
        createdAt
      });
    }
  };
}

export function buildTransportErrorV1({
  code,
  message,
  request = null,
  cause = null,
  at
} = {}) {
  if (!at) throw new TypeError('at is required to keep transport error payload deterministic');
  return canonicalize(
    {
      schemaVersion: 'AgentverseTransportError.v1',
      code: normalizeNonEmptyString(code, 'code', { max: 128 }),
      message: normalizeNonEmptyString(message, 'message', { max: 2048 }),
      requestHash: request?.requestHash ?? null,
      requestPath: normalizeOptionalString(request?.path, 'request.path', { max: 2048 }),
      cause: normalizeOptionalString(cause, 'cause', { max: 2048 }),
      at: normalizeIsoDateTime(at, 'at')
    },
    { path: '$.transportError' }
  );
}
