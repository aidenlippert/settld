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

export const COVERAGE_SOURCE = Object.freeze({
  ROBOT: "robot",
  PLATFORM: "platform"
});

const COVERAGE_SOURCES = new Set(Object.values(COVERAGE_SOURCE));

export function validateZoneCoverageReportedPayload(payload) {
  assertPlainObject(payload, "payload");
  const allowed = new Set(["jobId", "zoneId", "coveragePct", "window", "coverageMapHash", "source"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`payload contains unknown field: ${key}`);
  }

  assertNonEmptyString(payload.jobId, "payload.jobId");
  assertNonEmptyString(payload.zoneId, "payload.zoneId");

  if (!Number.isSafeInteger(payload.coveragePct) || payload.coveragePct < 0 || payload.coveragePct > 100) {
    throw new TypeError("payload.coveragePct must be an integer in range 0..100");
  }

  assertPlainObject(payload.window, "payload.window");
  const winAllowed = new Set(["startAt", "endAt"]);
  for (const key of Object.keys(payload.window)) {
    if (!winAllowed.has(key)) throw new TypeError(`payload.window contains unknown field: ${key}`);
  }
  assertIsoDate(payload.window.startAt, "payload.window.startAt");
  assertIsoDate(payload.window.endAt, "payload.window.endAt");
  if (Date.parse(payload.window.startAt) > Date.parse(payload.window.endAt)) throw new TypeError("payload.window.startAt must be <= payload.window.endAt");

  if (payload.coverageMapHash !== undefined && payload.coverageMapHash !== null) {
    assertNonEmptyString(payload.coverageMapHash, "payload.coverageMapHash");
    const hex = payload.coverageMapHash.trim();
    if (!/^[a-f0-9]{64}$/i.test(hex)) throw new TypeError("payload.coverageMapHash must be 64-hex when provided");
  }

  assertNonEmptyString(payload.source, "payload.source");
  if (!COVERAGE_SOURCES.has(payload.source)) throw new TypeError("payload.source is not supported");

  return payload;
}

