import {
  buildDiscoveryRecordV1,
  selectDiscoveryRecordV1
} from '../discovery/index.js';
import {
  buildProtocolEnvelopeV1,
  parseProtocolVersion,
  resolveNegotiatedProtocol
} from '../protocol/index.js';
import {
  createInMemoryTransport
} from '../transport/index.js';
import {
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeSafeInt
} from '../protocol/utils.js';

function buildUnavailableTransport() {
  return createInMemoryTransport({
    handler: () => {
      const err = new Error('network transport is not configured');
      err.code = 'AGENTVERSE_NETWORK_TRANSPORT_UNAVAILABLE';
      throw err;
    }
  });
}

function routeError(code, message, details = null) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

export class AgentNetwork {
  constructor({
    agentId,
    protocol = '1.0',
    transport = null,
    discoveryRecords = [],
    now = () => new Date().toISOString()
  } = {}) {
    this.agentId = normalizeId(agentId, 'agentId', { min: 3, max: 200 });
    this.protocol = parseProtocolVersion(protocol).raw;
    this.transport = transport && typeof transport === 'object' ? transport : buildUnavailableTransport();
    this.now = typeof now === 'function' ? now : (() => new Date().toISOString());

    this._records = [];
    this._sequenceByKey = new Map();
    this.registerDiscoveryRecords(discoveryRecords);
  }

  registerDiscoveryRecord(record) {
    const normalized = buildDiscoveryRecordV1(record);
    const key = normalized.recordHash;
    const next = this._records.filter((row) => row.recordHash !== key);
    next.push(normalized);
    next.sort((left, right) => String(left.recordHash).localeCompare(String(right.recordHash)));
    this._records = next;
    return normalized;
  }

  registerDiscoveryRecords(records = []) {
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
    for (const row of records) {
      this.registerDiscoveryRecord(row);
    }
    return this.listDiscoveryRecords();
  }

  listDiscoveryRecords() {
    return [...this._records];
  }

  resolvePeer({
    toAgentId = null,
    capabilityId = null,
    minTrustScore = 0,
    asOf = this.now()
  } = {}) {
    const normalizedAsOf = normalizeIsoDateTime(asOf, 'asOf');
    const normalizedMinTrust = normalizeSafeInt(minTrustScore, 'minTrustScore', { min: 0, max: 100 });

    let candidateRecords = this._records;
    if (toAgentId) {
      const normalizedTarget = normalizeId(toAgentId, 'toAgentId', { min: 3, max: 200 });
      candidateRecords = candidateRecords.filter((row) => row.agentId === normalizedTarget);
    }

    const result = selectDiscoveryRecordV1({
      records: candidateRecords,
      capabilityId,
      minTrustScore: normalizedMinTrust,
      asOf: normalizedAsOf
    });
    return result;
  }

  _nextSequence({ toAgentId, sessionId }) {
    const key = `${toAgentId}\n${sessionId ?? ''}`;
    const current = this._sequenceByKey.get(key) ?? 0;
    this._sequenceByKey.set(key, current + 1);
    return current;
  }

  async sendEnvelope({
    toAgentId = null,
    capabilityId = null,
    type,
    payload = {},
    metadata = null,
    sessionId = null,
    sequence = null,
    createdAt = this.now(),
    path = '/v1/federation/invoke',
    minTrustScore = 0
  } = {}) {
    const normalizedType = normalizeNonEmptyString(type, 'type', { max: 128 });
    const normalizedAt = normalizeIsoDateTime(createdAt, 'createdAt');

    const route = this.resolvePeer({
      toAgentId,
      capabilityId,
      minTrustScore,
      asOf: normalizedAt
    });

    if (!route.ok || !route.selected) {
      throw routeError(
        route.reasonCode ?? 'AGENTVERSE_NETWORK_ROUTE_UNRESOLVED',
        'unable to resolve destination peer',
        route
      );
    }

    const targetAgentId = route.selected.agentId;
    const resolvedSequence = sequence === null || sequence === undefined
      ? this._nextSequence({ toAgentId: targetAgentId, sessionId })
      : normalizeSafeInt(sequence, 'sequence', { min: 0, max: Number.MAX_SAFE_INTEGER });

    const negotiatedProtocol = resolveNegotiatedProtocol({
      requested: this.protocol,
      policy: {
        supported: [this.protocol, route.selected.protocol]
          .filter((value) => typeof value === 'string' && value.trim() !== '')
      }
    });

    const envelope = buildProtocolEnvelopeV1({
      protocol: negotiatedProtocol,
      sessionId,
      sequence: resolvedSequence,
      direction: 'outbound',
      fromAgentId: this.agentId,
      toAgentId: targetAgentId,
      type: normalizedType,
      payload,
      metadata,
      createdAt: normalizedAt
    });

    if (typeof this.transport.sendEnvelope === 'function') {
      const response = await this.transport.sendEnvelope({
        path,
        envelope,
        protocol: negotiatedProtocol,
        createdAt: normalizedAt
      });
      return {
        route,
        envelope,
        response
      };
    }

    if (typeof this.transport.requestJson === 'function') {
      const response = await this.transport.requestJson({
        method: 'POST',
        path,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: envelope,
        protocol: negotiatedProtocol,
        createdAt: normalizedAt
      });
      return {
        route,
        envelope,
        response
      };
    }

    throw routeError('AGENTVERSE_NETWORK_TRANSPORT_INVALID', 'transport must provide sendEnvelope or requestJson');
  }
}

export function createLoopbackNetworkTransport({
  handlersByAgentId = new Map()
} = {}) {
  const handlerMap = handlersByAgentId instanceof Map ? handlersByAgentId : new Map(Object.entries(handlersByAgentId));

  return createInMemoryTransport({
    async handler(request) {
      const toAgentId = request?.body?.toAgentId ?? request?.body?.targetAgentId ?? request?.body?.payload?.toAgentId;
      const normalizedToAgentId = toAgentId ? normalizeId(toAgentId, 'toAgentId', { min: 3, max: 200 }) : null;
      const destinationHandler = normalizedToAgentId ? handlerMap.get(normalizedToAgentId) : null;
      if (typeof destinationHandler !== 'function') {
        const err = new Error(`no loopback handler registered for agent: ${String(normalizedToAgentId ?? 'unknown')}`);
        err.code = 'AGENTVERSE_LOOPBACK_HANDLER_MISSING';
        throw err;
      }
      return destinationHandler(request);
    }
  });
}
