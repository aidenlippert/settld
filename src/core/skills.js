function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertSafePositiveCents(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer (cents)`);
}

export function validateSkillLicensedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "skill", "pricing", "licenseId", "terms"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");

  assertPlainObject(payload.skill, "payload.skill");
  const skillAllowed = new Set(["skillId", "version", "developerId"]);
  for (const key of Object.keys(payload.skill)) {
    if (!skillAllowed.has(key)) throw new TypeError(`payload.skill contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.skill.skillId, "payload.skill.skillId");
  assertNonEmptyString(payload.skill.version, "payload.skill.version");
  assertNonEmptyString(payload.skill.developerId, "payload.skill.developerId");

  assertPlainObject(payload.pricing, "payload.pricing");
  const pricingAllowed = new Set(["model", "amountCents", "currency"]);
  for (const key of Object.keys(payload.pricing)) {
    if (!pricingAllowed.has(key)) throw new TypeError(`payload.pricing contains unknown field: ${key}`);
  }
  assertNonEmptyString(payload.pricing.model, "payload.pricing.model");
  if (payload.pricing.model !== "PER_JOB") throw new TypeError("payload.pricing.model must be PER_JOB");
  assertSafePositiveCents(payload.pricing.amountCents, "payload.pricing.amountCents");
  assertNonEmptyString(payload.pricing.currency, "payload.pricing.currency");

  assertNonEmptyString(payload.licenseId, "payload.licenseId");

  if (payload.terms !== undefined) {
    assertPlainObject(payload.terms, "payload.terms");
    const termsAllowed = new Set(["refundableUntilState", "requiresCertificationTier"]);
    for (const key of Object.keys(payload.terms)) {
      if (!termsAllowed.has(key)) throw new TypeError(`payload.terms contains unknown field: ${key}`);
    }
    if (payload.terms.refundableUntilState !== undefined) {
      assertNonEmptyString(payload.terms.refundableUntilState, "payload.terms.refundableUntilState");
    }
    if (payload.terms.requiresCertificationTier !== undefined) {
      assertNonEmptyString(payload.terms.requiresCertificationTier, "payload.terms.requiresCertificationTier");
    }
  }

  return payload;
}

export function validateSkillUsedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "licenseId", "step"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.licenseId, "payload.licenseId");
  if (payload.step !== undefined) assertNonEmptyString(payload.step, "payload.step");
  return payload;
}

export function sumSkillLicenseFeesCents(skillLicenses) {
  if (!Array.isArray(skillLicenses)) return 0;
  let sum = 0;
  for (const lic of skillLicenses) {
    const amount = lic?.pricing?.amountCents;
    if (!Number.isSafeInteger(amount) || amount <= 0) continue;
    sum += amount;
  }
  return sum;
}

