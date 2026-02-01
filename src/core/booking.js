import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { POLICY_SNAPSHOT_VERSION, computePolicyHash } from "./policy.js";
import { computeZoneSetHash, validateZoneSetV1, ZONE_SET_SCHEMA_VERSION_V1 } from "./zoneset.js";

export const ENV_TIER = Object.freeze({
  ENV_MANAGED_BUILDING: "ENV_MANAGED_BUILDING",
  ENV_HOSPITALITY: "ENV_HOSPITALITY",
  ENV_OFFICE_AFTER_HOURS: "ENV_OFFICE_AFTER_HOURS",
  ENV_IN_HOME: "ENV_IN_HOME"
});

const ENV_TIERS = new Set(Object.values(ENV_TIER));

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new TypeError(`${name} must be an ISO date string`);
}

export function validateBookedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set([
    "paymentHoldId",
    "startAt",
    "endAt",
    "environmentTier",
    "requiresOperatorCoverage",
    "zoneId",
    "requiredZones",
    "requiredZonesHash",
    "sla",
    "customerId",
    "siteId",
    "contractId",
    "contractVersion",
    "customerContractHash",
    "customerCompilerId",
    "creditPolicy",
    "evidencePolicy",
    "policySnapshot",
    "policyHash"
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  if (payload.paymentHoldId !== undefined) assertNonEmptyString(payload.paymentHoldId, "payload.paymentHoldId");
  assertIsoDate(payload.startAt, "payload.startAt");
  assertIsoDate(payload.endAt, "payload.endAt");
  if (Date.parse(payload.startAt) >= Date.parse(payload.endAt)) throw new TypeError("payload.startAt must be before payload.endAt");

  if (payload.environmentTier !== undefined) {
    assertNonEmptyString(payload.environmentTier, "payload.environmentTier");
    if (!ENV_TIERS.has(payload.environmentTier)) throw new TypeError("payload.environmentTier is not supported");
  } else {
    throw new TypeError("payload.environmentTier is required");
  }
  if (typeof payload.requiresOperatorCoverage !== "boolean") throw new TypeError("payload.requiresOperatorCoverage must be a boolean");

  if (payload.zoneId !== undefined && payload.zoneId !== null) assertNonEmptyString(payload.zoneId, "payload.zoneId");
  if (payload.requiredZones !== undefined && payload.requiredZones !== null) {
    assertPlainObject(payload.requiredZones, "payload.requiredZones");
    if (payload.requiredZones.schemaVersion !== ZONE_SET_SCHEMA_VERSION_V1) throw new TypeError("payload.requiredZones.schemaVersion is not supported");
    validateZoneSetV1(payload.requiredZones);
  }
  if (payload.requiredZonesHash !== undefined && payload.requiredZonesHash !== null) {
    assertNonEmptyString(payload.requiredZonesHash, "payload.requiredZonesHash");
    const hex = payload.requiredZonesHash.trim();
    if (!/^[a-f0-9]{64}$/i.test(hex)) throw new TypeError("payload.requiredZonesHash must be 64-hex");
  }
  if (payload.customerId !== undefined && payload.customerId !== null) assertNonEmptyString(payload.customerId, "payload.customerId");
  if (payload.siteId !== undefined && payload.siteId !== null) assertNonEmptyString(payload.siteId, "payload.siteId");
  if (payload.contractId !== undefined && payload.contractId !== null) assertNonEmptyString(payload.contractId, "payload.contractId");
  else throw new TypeError("payload.contractId is required");
  if (!Number.isSafeInteger(payload.contractVersion) || payload.contractVersion <= 0) {
    throw new TypeError("payload.contractVersion must be a positive safe integer");
  }

  if (payload.customerContractHash !== undefined && payload.customerContractHash !== null) {
    assertNonEmptyString(payload.customerContractHash, "payload.customerContractHash");
  }
  if (payload.customerCompilerId !== undefined && payload.customerCompilerId !== null) {
    assertNonEmptyString(payload.customerCompilerId, "payload.customerCompilerId");
  }

  if (payload.sla !== undefined && payload.sla !== null) {
    assertPlainObject(payload.sla, "payload.sla");
    const slaAllowed = new Set(["slaVersion", "mustStartWithinWindow", "maxStallMs", "maxExecutionMs"]);
    for (const key of Object.keys(payload.sla)) {
      if (!slaAllowed.has(key)) throw new TypeError(`payload.sla contains unknown field: ${key}`);
    }
    if (!Number.isSafeInteger(payload.sla.slaVersion)) throw new TypeError("payload.sla.slaVersion must be a safe integer");
    if (typeof payload.sla.mustStartWithinWindow !== "boolean") throw new TypeError("payload.sla.mustStartWithinWindow must be a boolean");
    if (!Number.isSafeInteger(payload.sla.maxStallMs) || payload.sla.maxStallMs <= 0) throw new TypeError("payload.sla.maxStallMs must be a positive safe integer");
    if (!Number.isSafeInteger(payload.sla.maxExecutionMs) || payload.sla.maxExecutionMs <= 0) throw new TypeError("payload.sla.maxExecutionMs must be a positive safe integer");
  } else {
    throw new TypeError("payload.sla is required");
  }

  if (payload.creditPolicy !== undefined && payload.creditPolicy !== null) {
    assertPlainObject(payload.creditPolicy, "payload.creditPolicy");
    const allowedCredit = new Set(["enabled", "defaultAmountCents", "maxAmountCents", "currency", "ladder"]);
    for (const key of Object.keys(payload.creditPolicy)) {
      if (!allowedCredit.has(key)) throw new TypeError(`payload.creditPolicy contains unknown field: ${key}`);
    }
    if (typeof payload.creditPolicy.enabled !== "boolean") throw new TypeError("payload.creditPolicy.enabled must be a boolean");
    if (!Number.isSafeInteger(payload.creditPolicy.defaultAmountCents) || payload.creditPolicy.defaultAmountCents < 0) {
      throw new TypeError("payload.creditPolicy.defaultAmountCents must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(payload.creditPolicy.maxAmountCents) || payload.creditPolicy.maxAmountCents < 0) {
      throw new TypeError("payload.creditPolicy.maxAmountCents must be a non-negative safe integer");
    }
    assertNonEmptyString(payload.creditPolicy.currency, "payload.creditPolicy.currency");
    if (payload.creditPolicy.currency !== "USD") throw new TypeError("payload.creditPolicy.currency is not supported");
    if (payload.creditPolicy.maxAmountCents > 0 && payload.creditPolicy.defaultAmountCents > payload.creditPolicy.maxAmountCents) {
      throw new TypeError("payload.creditPolicy.defaultAmountCents must be <= maxAmountCents when maxAmountCents > 0");
    }
    if (payload.creditPolicy.ladder !== undefined && payload.creditPolicy.ladder !== null) {
      if (!Array.isArray(payload.creditPolicy.ladder)) throw new TypeError("payload.creditPolicy.ladder must be an array");
      const tierAllowed = new Set(["latenessMsGte", "amountCents"]);
      let last = -1;
      for (let i = 0; i < payload.creditPolicy.ladder.length; i += 1) {
        const tier = payload.creditPolicy.ladder[i];
        assertPlainObject(tier, `payload.creditPolicy.ladder[${i}]`);
        for (const key of Object.keys(tier)) {
          if (!tierAllowed.has(key)) throw new TypeError(`payload.creditPolicy.ladder[${i}] contains unknown field: ${key}`);
        }
        if (!Number.isSafeInteger(tier.latenessMsGte) || tier.latenessMsGte < 0) {
          throw new TypeError("payload.creditPolicy.ladder latenessMsGte must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(tier.amountCents) || tier.amountCents < 0) {
          throw new TypeError("payload.creditPolicy.ladder amountCents must be a non-negative safe integer");
        }
        if (tier.latenessMsGte <= last) throw new TypeError("payload.creditPolicy.ladder must be strictly increasing by latenessMsGte");
        last = tier.latenessMsGte;
        if (payload.creditPolicy.maxAmountCents > 0 && tier.amountCents > payload.creditPolicy.maxAmountCents) {
          throw new TypeError("payload.creditPolicy.ladder amountCents must be <= maxAmountCents when maxAmountCents > 0");
        }
      }
    }
  } else {
    throw new TypeError("payload.creditPolicy is required");
  }

  if (payload.evidencePolicy !== undefined && payload.evidencePolicy !== null) {
    assertPlainObject(payload.evidencePolicy, "payload.evidencePolicy");
    const allowedEvidence = new Set(["retentionDays"]);
    for (const key of Object.keys(payload.evidencePolicy)) {
      if (!allowedEvidence.has(key)) throw new TypeError(`payload.evidencePolicy contains unknown field: ${key}`);
    }
    if (!Number.isSafeInteger(payload.evidencePolicy.retentionDays) || payload.evidencePolicy.retentionDays < 0) {
      throw new TypeError("payload.evidencePolicy.retentionDays must be a non-negative safe integer");
    }
  } else {
    throw new TypeError("payload.evidencePolicy is required");
  }

  assertPlainObject(payload.policySnapshot, "payload.policySnapshot");
  if (payload.policySnapshot.schemaVersion !== POLICY_SNAPSHOT_VERSION) {
    throw new TypeError("payload.policySnapshot.schemaVersion is not supported");
  }
  assertNonEmptyString(payload.policyHash, "payload.policyHash");
  const computed = computePolicyHash(payload.policySnapshot);
  if (computed !== payload.policyHash) {
    throw new TypeError("payload.policyHash does not match payload.policySnapshot");
  }

  // ZoneSet consistency (optional, but if provided must match).
  if (payload.requiredZones !== undefined && payload.requiredZones !== null) {
    if (!payload.requiredZonesHash) throw new TypeError("payload.requiredZonesHash is required when payload.requiredZones is provided");
    const computedZonesHash = computeZoneSetHash(payload.requiredZones);
    if (computedZonesHash !== payload.requiredZonesHash) throw new TypeError("payload.requiredZonesHash does not match payload.requiredZones");
  }

  // Consistency checks: policySnapshot must match booking-effective fields.
  if (payload.policySnapshot.environmentTier !== payload.environmentTier) throw new TypeError("policySnapshot.environmentTier mismatch");
  if (payload.policySnapshot.requiresOperatorCoverage !== payload.requiresOperatorCoverage) {
    throw new TypeError("policySnapshot.requiresOperatorCoverage mismatch");
  }
  if (canonicalizeComparable(payload.policySnapshot.sla) !== canonicalizeComparable(payload.sla)) throw new TypeError("policySnapshot.sla mismatch");
  if (canonicalizeComparable(payload.policySnapshot.creditPolicy) !== canonicalizeComparable(payload.creditPolicy)) {
    throw new TypeError("policySnapshot.creditPolicy mismatch");
  }
  if (canonicalizeComparable(payload.policySnapshot.evidencePolicy) !== canonicalizeComparable(payload.evidencePolicy)) {
    throw new TypeError("policySnapshot.evidencePolicy mismatch");
  }
  if ((payload.policySnapshot.contractId ?? null) !== payload.contractId) throw new TypeError("policySnapshot.contractId mismatch");
  if ((payload.policySnapshot.contractVersion ?? null) !== payload.contractVersion) throw new TypeError("policySnapshot.contractVersion mismatch");

  return payload;
}

export function validateBookingWindowInput(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set([
    "paymentHoldId",
    "startAt",
    "endAt",
    "environmentTier",
    "requiresOperatorCoverage",
    "zoneId",
    "customerId",
    "siteId",
    "contractId"
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  if (payload.paymentHoldId !== undefined) assertNonEmptyString(payload.paymentHoldId, "payload.paymentHoldId");
  assertIsoDate(payload.startAt, "payload.startAt");
  assertIsoDate(payload.endAt, "payload.endAt");
  if (Date.parse(payload.startAt) >= Date.parse(payload.endAt)) throw new TypeError("payload.startAt must be before payload.endAt");

  assertNonEmptyString(payload.environmentTier, "payload.environmentTier");
  if (!ENV_TIERS.has(payload.environmentTier)) throw new TypeError("payload.environmentTier is not supported");

  if (payload.requiresOperatorCoverage !== undefined && typeof payload.requiresOperatorCoverage !== "boolean") {
    throw new TypeError("payload.requiresOperatorCoverage must be a boolean");
  }

  if (payload.zoneId !== undefined && payload.zoneId !== null) assertNonEmptyString(payload.zoneId, "payload.zoneId");
  if (payload.customerId !== undefined && payload.customerId !== null) assertNonEmptyString(payload.customerId, "payload.customerId");
  if (payload.siteId !== undefined && payload.siteId !== null) assertNonEmptyString(payload.siteId, "payload.siteId");
  if (payload.contractId !== undefined && payload.contractId !== null) assertNonEmptyString(payload.contractId, "payload.contractId");

  return payload;
}

function canonicalizeComparable(value) {
  return canonicalJsonStringify(normalizeForCanonicalJson(value ?? null, { path: "$" }));
}

export function validateReservedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["robotId", "startAt", "endAt", "reservationId", "reservedUntil"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.robotId, "payload.robotId");
  assertIsoDate(payload.startAt, "payload.startAt");
  assertIsoDate(payload.endAt, "payload.endAt");
  if (Date.parse(payload.startAt) >= Date.parse(payload.endAt)) throw new TypeError("payload.startAt must be before payload.endAt");

  if (payload.reservationId !== undefined) assertNonEmptyString(payload.reservationId, "payload.reservationId");
  if (payload.reservedUntil !== undefined) assertIsoDate(payload.reservedUntil, "payload.reservedUntil");
  return payload;
}

export function windowsOverlap(a, b) {
  const aStart = Date.parse(a.startAt);
  const aEnd = Date.parse(a.endAt);
  const bStart = Date.parse(b.startAt);
  const bEnd = Date.parse(b.endAt);
  return Number.isFinite(aStart) && Number.isFinite(aEnd) && Number.isFinite(bStart) && Number.isFinite(bEnd) && aStart < bEnd && bStart < aEnd;
}
