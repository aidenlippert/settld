import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const ZONE_SET_SCHEMA_VERSION_V1 = "ZoneSet.v1";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function validateZoneSetV1(zoneSet) {
  assertPlainObject(zoneSet, "zoneSet");
  const allowed = new Set(["schemaVersion", "zoneSetId", "zones"]);
  for (const k of Object.keys(zoneSet)) {
    if (!allowed.has(k)) throw new TypeError(`zoneSet contains unknown field: ${k}`);
  }

  if (zoneSet.schemaVersion !== ZONE_SET_SCHEMA_VERSION_V1) throw new TypeError("zoneSet.schemaVersion is not supported");
  assertNonEmptyString(zoneSet.zoneSetId, "zoneSet.zoneSetId");
  if (!Array.isArray(zoneSet.zones) || zoneSet.zones.length === 0) throw new TypeError("zoneSet.zones must be a non-empty array");

  const seen = new Set();
  for (let i = 0; i < zoneSet.zones.length; i += 1) {
    const z = zoneSet.zones[i];
    assertPlainObject(z, `zoneSet.zones[${i}]`);
    const allowedZone = new Set(["zoneId", "label", "areaSqFt"]);
    for (const k of Object.keys(z)) {
      if (!allowedZone.has(k)) throw new TypeError(`zoneSet.zones[${i}] contains unknown field: ${k}`);
    }
    assertNonEmptyString(z.zoneId, `zoneSet.zones[${i}].zoneId`);
    if (z.label !== undefined && z.label !== null) assertNonEmptyString(z.label, `zoneSet.zones[${i}].label`);
    if (z.areaSqFt !== undefined && z.areaSqFt !== null) {
      if (!Number.isFinite(z.areaSqFt) || z.areaSqFt <= 0) throw new TypeError(`zoneSet.zones[${i}].areaSqFt must be a positive number`);
    }
    const zoneId = z.zoneId.trim();
    if (seen.has(zoneId)) throw new TypeError("zoneSet.zones zoneId must be unique");
    seen.add(zoneId);
  }

  return zoneSet;
}

export function normalizeZoneSetV1(zoneSet) {
  const validated = validateZoneSetV1(zoneSet);
  const normalized = normalizeForCanonicalJson(validated, { path: "$" });
  // Enforce stable ordering by zoneId for determinism.
  const zones = Array.isArray(normalized.zones) ? [...normalized.zones] : [];
  zones.sort((a, b) => {
    const az = String(a?.zoneId ?? "");
    const bz = String(b?.zoneId ?? "");
    if (az !== bz) return az < bz ? -1 : 1;
    return 0;
  });
  return { ...normalized, zones };
}

export function computeZoneSetHash(zoneSet) {
  const normalized = normalizeZoneSetV1(zoneSet);
  return sha256Hex(canonicalJsonStringify(normalized));
}

