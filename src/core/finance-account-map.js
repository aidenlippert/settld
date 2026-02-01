import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

export const FINANCE_ACCOUNT_MAP_SCHEMA_VERSION_V1 = "FinanceAccountMap.v1";

export function computeFinanceAccountMapHash(map) {
  if (!isPlainObject(map)) throw new TypeError("finance account map must be an object");
  return sha256Hex(canonicalJsonStringify(map));
}

export function validateFinanceAccountMapV1(map) {
  if (!isPlainObject(map)) throw new TypeError("finance account map must be an object");
  if (map.schemaVersion !== FINANCE_ACCOUNT_MAP_SCHEMA_VERSION_V1) {
    throw new TypeError(`finance account map schemaVersion must be ${FINANCE_ACCOUNT_MAP_SCHEMA_VERSION_V1}`);
  }

  const accounts = map.accounts ?? null;
  if (!isPlainObject(accounts)) throw new TypeError("finance account map accounts must be an object");
  for (const [k, v] of Object.entries(accounts)) {
    if (typeof k !== "string" || !k.trim()) throw new TypeError("finance account map accounts keys must be non-empty strings");
    if (typeof v !== "string" || !v.trim()) throw new TypeError(`finance account map accounts.${k} must be a non-empty string`);
  }

  const exportPolicy = map.exportPolicy ?? null;
  if (exportPolicy !== null && exportPolicy !== undefined) {
    if (!isPlainObject(exportPolicy)) throw new TypeError("finance account map exportPolicy must be an object when provided");
    const gateMode = exportPolicy.gateMode ?? null;
    if (gateMode !== null && gateMode !== undefined) {
      const text = String(gateMode);
      if (text !== "warn" && text !== "strict") throw new TypeError("finance account map exportPolicy.gateMode must be warn or strict");
    }
  }

  const dimensions = map.dimensions ?? null;
  if (dimensions !== null && dimensions !== undefined && !isPlainObject(dimensions)) {
    throw new TypeError("finance account map dimensions must be an object when provided");
  }

  return true;
}

export function resolveExternalAccountFor({ map, accountId }) {
  if (!isPlainObject(map)) throw new TypeError("map is required");
  if (typeof accountId !== "string" || !accountId.trim()) throw new TypeError("accountId is required");
  const accounts = map.accounts ?? null;
  if (!isPlainObject(accounts)) throw new TypeError("map.accounts must be an object");
  const external = accounts[accountId] ?? null;
  if (typeof external !== "string" || !external.trim()) {
    const err = new Error(`missing account mapping for ${accountId}`);
    err.code = "FINANCE_ACCOUNT_MAP_MISSING";
    err.accountId = accountId;
    throw err;
  }
  return String(external);
}
