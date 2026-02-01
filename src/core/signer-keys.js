export const SIGNER_KEY_STATUS = Object.freeze({
  ACTIVE: "active",
  ROTATED: "rotated",
  REVOKED: "revoked"
});

export const SIGNER_KEY_PURPOSE = Object.freeze({
  ROBOT: "robot",
  OPERATOR: "operator",
  SERVER: "server"
});

const SIGNER_KEY_STATUSES = new Set(Object.values(SIGNER_KEY_STATUS));
const SIGNER_KEY_PURPOSES = new Set(Object.values(SIGNER_KEY_PURPOSE));

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

export function normalizeSignerKeyStatus(status) {
  assertNonEmptyString(status, "status");
  const normalized = String(status).trim().toLowerCase();
  if (!SIGNER_KEY_STATUSES.has(normalized)) throw new TypeError("status is not supported");
  return normalized;
}

export function normalizeSignerKeyPurpose(purpose) {
  assertNonEmptyString(purpose, "purpose");
  const normalized = String(purpose).trim().toLowerCase();
  if (!SIGNER_KEY_PURPOSES.has(normalized)) throw new TypeError("purpose is not supported");
  return normalized;
}

