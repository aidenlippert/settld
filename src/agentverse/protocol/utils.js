import { canonicalJsonStringify, normalizeForCanonicalJson } from '../../core/canonical-json.js';
import { sha256Hex } from '../../core/crypto.js';

const DEFAULT_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

export function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function normalizeNonEmptyString(value, name, { max = 512 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const out = String(value).trim();
  if (out.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return out;
}

export function normalizeOptionalString(value, name, { max = 2048 } = {}) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  if (!out) return null;
  if (out.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return out;
}

export function normalizeId(value, name, { min = 1, max = 200, pattern = DEFAULT_ID_PATTERN } = {}) {
  const out = normalizeNonEmptyString(value, name, { max });
  if (out.length < min || out.length > max) throw new TypeError(`${name} must be length ${min}..${max}`);
  if (!pattern.test(out)) throw new TypeError(`${name} is invalid`);
  return out;
}

export function normalizeIsoDateTime(value, name, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined)) return null;
  const out = normalizeNonEmptyString(value, name, { max: 128 });
  const ms = Date.parse(out);
  if (!Number.isFinite(ms)) throw new TypeError(`${name} must be an ISO date-time`);
  return new Date(ms).toISOString();
}

export function normalizeSafeInt(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const out = Number(value);
  if (!Number.isSafeInteger(out)) throw new TypeError(`${name} must be a safe integer`);
  if (out < min || out > max) throw new TypeError(`${name} must be within ${min}..${max}`);
  return out;
}

export function normalizeEnum(value, name, allowed, { defaultValue = null } = {}) {
  const resolved = value === null || value === undefined || String(value).trim() === '' ? defaultValue : value;
  const out = normalizeNonEmptyString(resolved, name, { max: 128 }).toLowerCase();
  if (!allowed.includes(out)) {
    throw new TypeError(`${name} must be one of: ${allowed.join('|')}`);
  }
  return out;
}

export function normalizeSha256Hex(value, name, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || String(value).trim() === '')) return null;
  const out = normalizeNonEmptyString(value, name, { max: 64 }).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be a 64-char sha256 hex`);
  return out;
}

export function normalizeStringList(value, name, { maxItems = 1000, itemMax = 200, pattern = null } = {}) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > maxItems) throw new TypeError(`${name} must contain <= ${maxItems} entries`);
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const item = normalizeNonEmptyString(value[i], `${name}[${i}]`, { max: itemMax });
    if (pattern && !pattern.test(item)) throw new TypeError(`${name}[${i}] is invalid`);
    seen.add(item);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function canonicalize(value, { path = '$' } = {}) {
  return normalizeForCanonicalJson(value, { path });
}

export function canonicalHash(value, { path = '$' } = {}) {
  return sha256Hex(canonicalJsonStringify(canonicalize(value, { path })));
}

export function deriveDeterministicId(prefix, seed, { length = 24, path = '$.seed' } = {}) {
  const normalizedPrefix = normalizeId(prefix, 'prefix', { min: 1, max: 32, pattern: /^[a-z][a-z0-9_]*$/ });
  const digest = canonicalHash(seed, { path });
  return `${normalizedPrefix}_${digest.slice(0, Math.max(8, Math.min(64, length)))}`;
}

export function sortByDeterministicHash(rows, { path = '$.rows' } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  return [...rows]
    .map((row, index) => ({
      row,
      rowHash: canonicalHash({ row, index }, { path: `${path}[${index}]` })
    }))
    .sort((left, right) => left.rowHash.localeCompare(right.rowHash))
    .map((entry) => entry.row);
}
