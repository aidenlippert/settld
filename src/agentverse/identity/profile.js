import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeEnum,
  normalizeId,
  normalizeIsoDateTime,
  normalizeNonEmptyString,
  normalizeOptionalString,
  normalizeStringList,
  normalizeSha256Hex
} from '../protocol/utils.js';

export const AGENTVERSE_IDENTITY_PROFILE_SCHEMA_VERSION = 'AgentverseIdentityProfile.v1';

export const AGENTVERSE_IDENTITY_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REVOKED: 'revoked'
});

function normalizeDid(value, name, { allowNull = true } = {}) {
  if (allowNull && (value === null || value === undefined || String(value).trim() === '')) return null;
  const out = normalizeNonEmptyString(value, name, { max: 256 });
  if (!/^did:[A-Za-z0-9._:-]+:[A-Za-z0-9._:-]{1,256}$/.test(out)) {
    throw new TypeError(`${name} must be a DID`);
  }
  return out;
}

function normalizeAbsoluteUrl(value, name, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || String(value).trim() === '')) return null;
  const out = normalizeNonEmptyString(value, name, { max: 1024 });
  let parsed;
  try {
    parsed = new URL(out);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${name} must use http or https`);
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeCapabilities(capabilities) {
  if (capabilities === null || capabilities === undefined) return [];
  if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array');
  const seen = new Set();
  const out = [];

  for (let i = 0; i < capabilities.length; i += 1) {
    const row = capabilities[i];
    assertPlainObject(row, `capabilities[${i}]`);
    const capabilityId = normalizeId(row.capabilityId ?? row.id ?? row.name, `capabilities[${i}].capabilityId`, {
      min: 1,
      max: 200
    });
    if (seen.has(capabilityId)) continue;
    seen.add(capabilityId);
    out.push(
      canonicalize(
        {
          capabilityId,
          version: normalizeOptionalString(row.version, `capabilities[${i}].version`, { max: 64 }) ?? '1.0',
          description: normalizeOptionalString(row.description, `capabilities[${i}].description`, { max: 512 })
        },
        { path: `$.capabilities[${i}]` }
      )
    );
  }

  out.sort((left, right) => {
    const idOrder = String(left.capabilityId).localeCompare(String(right.capabilityId));
    if (idOrder !== 0) return idOrder;
    return String(left.version).localeCompare(String(right.version));
  });
  return out;
}

function normalizeEndpoints(endpoints) {
  if (endpoints === null || endpoints === undefined) return [];
  if (!Array.isArray(endpoints)) throw new TypeError('endpoints must be an array');
  const out = [];
  const seen = new Set();

  for (let i = 0; i < endpoints.length; i += 1) {
    const row = endpoints[i];
    assertPlainObject(row, `endpoints[${i}]`);
    const url = normalizeAbsoluteUrl(row.url ?? row.endpoint, `endpoints[${i}].url`);
    const kind = normalizeEnum(row.kind, `endpoints[${i}].kind`, ['api', 'stream', 'webhook'], {
      defaultValue: 'api'
    });
    const protocol = normalizeOptionalString(row.protocol, `endpoints[${i}].protocol`, { max: 32 }) ?? '1.0';
    const key = `${kind}\n${protocol}\n${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonicalize({ kind, protocol, url }, { path: `$.endpoints[${i}]` }));
  }

  out.sort((left, right) => {
    const kindOrder = String(left.kind).localeCompare(String(right.kind));
    if (kindOrder !== 0) return kindOrder;
    const protocolOrder = String(left.protocol).localeCompare(String(right.protocol));
    if (protocolOrder !== 0) return protocolOrder;
    return String(left.url).localeCompare(String(right.url));
  });
  return out;
}

function normalizeSigningKeys(keys) {
  if (keys === null || keys === undefined) return [];
  if (!Array.isArray(keys)) throw new TypeError('signingKeys must be an array');
  const out = [];
  const seen = new Set();

  for (let i = 0; i < keys.length; i += 1) {
    const row = keys[i];
    assertPlainObject(row, `signingKeys[${i}]`);
    const keyId = normalizeId(row.keyId, `signingKeys[${i}].keyId`, { min: 3, max: 200 });
    if (seen.has(keyId)) continue;
    seen.add(keyId);

    out.push(
      canonicalize(
        {
          keyId,
          algorithm: normalizeEnum(row.algorithm, `signingKeys[${i}].algorithm`, ['ed25519'], {
            defaultValue: 'ed25519'
          }),
          purpose: normalizeEnum(row.purpose, `signingKeys[${i}].purpose`, ['signing', 'verification'], {
            defaultValue: 'signing'
          }),
          publicKeyPemSha256: normalizeSha256Hex(row.publicKeyPemSha256, `signingKeys[${i}].publicKeyPemSha256`)
        },
        { path: `$.signingKeys[${i}]` }
      )
    );
  }

  out.sort((left, right) => String(left.keyId).localeCompare(String(right.keyId)));
  return out;
}

export function computeIdentityProfileHashV1(profileCore) {
  assertPlainObject(profileCore, 'profileCore');
  const copy = { ...profileCore };
  delete copy.profileHash;
  return canonicalHash(copy, { path: '$.identityProfile' });
}

export function buildIdentityProfileV1({
  agentId,
  did = null,
  displayName,
  description = null,
  status = AGENTVERSE_IDENTITY_STATUS.ACTIVE,
  capabilities = [],
  endpoints = [],
  signingKeys = [],
  tags = [],
  metadata = null,
  createdAt,
  updatedAt = null
} = {}) {
  if (!createdAt) throw new TypeError('createdAt is required to keep profile creation deterministic');
  const normalizedCreatedAt = normalizeIsoDateTime(createdAt, 'createdAt');
  const normalizedUpdatedAt = normalizeIsoDateTime(updatedAt ?? normalizedCreatedAt, 'updatedAt');

  const core = canonicalize(
    {
      schemaVersion: AGENTVERSE_IDENTITY_PROFILE_SCHEMA_VERSION,
      agentId: normalizeId(agentId, 'agentId', { min: 3, max: 200 }),
      did: normalizeDid(did, 'did', { allowNull: true }),
      displayName: normalizeNonEmptyString(displayName, 'displayName', { max: 200 }),
      description: normalizeOptionalString(description, 'description', { max: 2000 }),
      status: normalizeEnum(status, 'status', Object.values(AGENTVERSE_IDENTITY_STATUS), {
        defaultValue: AGENTVERSE_IDENTITY_STATUS.ACTIVE
      }),
      capabilities: normalizeCapabilities(capabilities),
      endpoints: normalizeEndpoints(endpoints),
      signingKeys: normalizeSigningKeys(signingKeys),
      tags: normalizeStringList(tags, 'tags', { maxItems: 128, itemMax: 64, pattern: /^[A-Za-z0-9:_-]+$/ }),
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? canonicalize(metadata, { path: '$.metadata' })
        : null,
      createdAt: normalizedCreatedAt,
      updatedAt: normalizedUpdatedAt
    },
    { path: '$.identityProfile' }
  );

  const profileHash = computeIdentityProfileHashV1(core);
  return canonicalize({ ...core, profileHash }, { path: '$.identityProfile' });
}

export function validateIdentityProfileV1(profile) {
  assertPlainObject(profile, 'profile');
  if (profile.schemaVersion !== AGENTVERSE_IDENTITY_PROFILE_SCHEMA_VERSION) {
    throw new TypeError(`profile.schemaVersion must be ${AGENTVERSE_IDENTITY_PROFILE_SCHEMA_VERSION}`);
  }

  normalizeId(profile.agentId, 'profile.agentId', { min: 3, max: 200 });
  normalizeDid(profile.did, 'profile.did', { allowNull: true });
  normalizeNonEmptyString(profile.displayName, 'profile.displayName', { max: 200 });
  normalizeOptionalString(profile.description, 'profile.description', { max: 2000 });
  normalizeEnum(profile.status, 'profile.status', Object.values(AGENTVERSE_IDENTITY_STATUS));
  normalizeCapabilities(profile.capabilities);
  normalizeEndpoints(profile.endpoints);
  normalizeSigningKeys(profile.signingKeys);
  normalizeStringList(profile.tags, 'profile.tags', { maxItems: 128, itemMax: 64, pattern: /^[A-Za-z0-9:_-]+$/ });
  if (profile.metadata !== null && profile.metadata !== undefined) assertPlainObject(profile.metadata, 'profile.metadata');
  normalizeIsoDateTime(profile.createdAt, 'profile.createdAt');
  normalizeIsoDateTime(profile.updatedAt, 'profile.updatedAt');

  const expectedHash = computeIdentityProfileHashV1(profile);
  const profileHash = normalizeSha256Hex(profile.profileHash, 'profile.profileHash');
  if (expectedHash !== profileHash) throw new TypeError('profileHash mismatch');
  return true;
}

export function updateIdentityProfileStatusV1({ profile, status, updatedAt } = {}) {
  validateIdentityProfileV1(profile);
  const normalizedUpdatedAt = normalizeIsoDateTime(updatedAt, 'updatedAt');
  const nextStatus = normalizeEnum(status, 'status', Object.values(AGENTVERSE_IDENTITY_STATUS));
  return buildIdentityProfileV1({
    ...profile,
    status: nextStatus,
    createdAt: profile.createdAt,
    updatedAt: normalizedUpdatedAt
  });
}
