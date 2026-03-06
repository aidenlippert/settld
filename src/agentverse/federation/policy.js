import {
  FEDERATION_ERROR_CODE,
  FEDERATION_OPENAPI_ERROR_CODES
} from '../../federation/error-codes.js';
import {
  buildFederationNamespacePolicy,
  resolveFederationNamespaceRoute
} from '../../federation/namespace-resolver.js';
import {
  buildFederationProxyPolicy,
  evaluateFederationTrustAndRoute,
  isTrustedFederationCoordinatorDid,
  validateFederationEnvelope
} from '../../federation/proxy-policy.js';
import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  deriveDeterministicId,
  normalizeEnum,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString,
  normalizeSha256Hex
} from '../protocol/utils.js';

export const AGENTVERSE_FEDERATION_ENVELOPE_SCHEMA_VERSION = 'AgentverseFederationEnvelope.v1';

function normalizeDid(value, name) {
  const out = normalizeNonEmptyString(value, name, { max: 300 });
  if (!/^did:[A-Za-z0-9._:-]+:[A-Za-z0-9._:-]{1,256}$/.test(out)) {
    throw new TypeError(`${name} must be a DID`);
  }
  return out;
}

export function computeFederationEnvelopeHashV1(envelopeCore) {
  assertPlainObject(envelopeCore, 'envelopeCore');
  const copy = { ...envelopeCore };
  delete copy.envelopeHash;
  return canonicalHash(copy, { path: '$.federationEnvelope' });
}

export function buildFederationEnvelopeV1({
  invocationId = null,
  type,
  originDid,
  targetDid,
  capabilityId = null,
  status = null,
  payload = null,
  createdAt
} = {}) {
  if (!createdAt) throw new TypeError('createdAt is required to keep federation envelopes deterministic');
  const normalizedType = normalizeEnum(type, 'type', ['coordinatorinvoke', 'coordinatorresult']);
  const normalizedStatus = normalizedType === 'coordinatorresult'
    ? normalizeEnum(status, 'status', ['success', 'error', 'timeout', 'denied'])
    : null;

  const normalizedPayload = canonicalize(payload ?? {}, { path: '$.payload' });

  const core = canonicalize(
    {
      schemaVersion: AGENTVERSE_FEDERATION_ENVELOPE_SCHEMA_VERSION,
      version: '1.0',
      type: normalizedType === 'coordinatorinvoke' ? 'coordinatorInvoke' : 'coordinatorResult',
      invocationId: invocationId
        ? normalizeId(invocationId, 'invocationId', { min: 3, max: 240 })
        : deriveDeterministicId(
          'fed_inv',
          {
            type: normalizedType,
            originDid,
            targetDid,
            capabilityId,
            status: normalizedStatus,
            payload: normalizedPayload,
            createdAt
          },
          { path: '$.invocationSeed' }
        ),
      originDid: normalizeDid(originDid, 'originDid'),
      targetDid: normalizeDid(targetDid, 'targetDid'),
      capabilityId:
        normalizedType === 'coordinatorinvoke'
          ? normalizeId(capabilityId, 'capabilityId', { min: 1, max: 200 })
          : normalizeOptionalString(capabilityId, 'capabilityId', { max: 200 }),
      status: normalizedStatus,
      payload: normalizedPayload,
      createdAt: normalizeIsoDateTime(createdAt, 'createdAt')
    },
    { path: '$.federationEnvelope' }
  );

  const envelopeHash = computeFederationEnvelopeHashV1(core);
  return canonicalize({ ...core, envelopeHash }, { path: '$.federationEnvelope' });
}

export function validateFederationEnvelopeV1(envelope) {
  assertPlainObject(envelope, 'envelope');
  if (envelope.schemaVersion !== AGENTVERSE_FEDERATION_ENVELOPE_SCHEMA_VERSION) {
    throw new TypeError(`envelope.schemaVersion must be ${AGENTVERSE_FEDERATION_ENVELOPE_SCHEMA_VERSION}`);
  }
  const endpoint = envelope.type === 'coordinatorResult' ? 'result' : 'invoke';
  const validation = validateFederationEnvelope({ endpoint, body: envelope });
  if (!validation.ok) {
    throw new TypeError(validation.message ?? 'invalid federation envelope');
  }
  const expectedHash = computeFederationEnvelopeHashV1(envelope);
  const actualHash = normalizeSha256Hex(envelope.envelopeHash, 'envelope.envelopeHash');
  if (expectedHash !== actualHash) throw new TypeError('envelopeHash mismatch');
  return true;
}

export function resolveFederationRouteV1({ endpoint, envelope, policy, asOf = null } = {}) {
  const normalizedEndpoint = normalizeEnum(endpoint, 'endpoint', ['invoke', 'result']);
  const evalResult = evaluateFederationTrustAndRoute({
    endpoint: normalizedEndpoint,
    envelope,
    policy,
    asOf: asOf ? normalizeIsoDateTime(asOf, 'asOf') : null
  });
  return evalResult;
}

export function buildFederationRoutingDecisionV1({ endpoint, envelope, policy, asOf } = {}) {
  const route = resolveFederationRouteV1({ endpoint, envelope, policy, asOf });
  const decisionCore = canonicalize(
    {
      schemaVersion: 'AgentverseFederationRoutingDecision.v1',
      endpoint,
      asOf: normalizeIsoDateTime(asOf, 'asOf'),
      invocationId: envelope?.invocationId ?? null,
      envelopeHash: envelope?.envelopeHash ?? null,
      ok: route.ok === true,
      code: route.code ?? null,
      statusCode: route.statusCode ?? null,
      namespaceDid: route.namespaceDid ?? null,
      resolvedCoordinatorDid: route.resolvedCoordinatorDid ?? null,
      upstreamBaseUrl: route.upstreamBaseUrl ?? null,
      routingReasonCode: route.routingReasonCode ?? null,
      details: route.details ?? null,
      namespaceLineage: route.namespaceLineage ?? null
    },
    { path: '$.federationRoutingDecision' }
  );
  const decisionHash = canonicalHash(decisionCore, { path: '$.federationRoutingDecision' });
  return canonicalize({ ...decisionCore, decisionHash }, { path: '$.federationRoutingDecision' });
}

export {
  FEDERATION_ERROR_CODE,
  FEDERATION_OPENAPI_ERROR_CODES,
  buildFederationProxyPolicy,
  isTrustedFederationCoordinatorDid,
  validateFederationEnvelope,
  evaluateFederationTrustAndRoute,
  buildFederationNamespacePolicy,
  resolveFederationNamespaceRoute
};
