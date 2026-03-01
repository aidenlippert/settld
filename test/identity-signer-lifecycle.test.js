import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSignerLifecycleForContinuity,
  IDENTITY_SIGNER_LIFECYCLE_REASON_CODES,
  IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES
} from "../src/services/identity/signer-lifecycle.js";

function assertDualCodes(result, { legacy, canonical }) {
  assert.equal(result.code, legacy);
  assert.equal(result.legacyCode, legacy);
  assert.equal(result.canonicalCode, canonical);
}

test("identity lifecycle: rotatedAt boundary is deterministic and fail-closed at boundary", () => {
  const key = {
    keyId: "key_rotate_boundary_1",
    status: "active",
    rotatedAt: "2026-02-20T00:00:10.000Z"
  };

  const before = evaluateSignerLifecycleForContinuity({ signerKey: key, at: "2026-02-20T00:00:09.999Z" });
  const beforeRepeat = evaluateSignerLifecycleForContinuity({ signerKey: key, at: "2026-02-20T00:00:09.999Z" });
  assert.deepEqual(before, beforeRepeat);
  assert.equal(before.ok, true);
  assert.equal(before.code, null);
  assert.equal(before.legacyCode, null);
  assert.equal(before.canonicalCode, null);

  const atBoundary = evaluateSignerLifecycleForContinuity({ signerKey: key, at: "2026-02-20T00:00:10.000Z" });
  assert.equal(atBoundary.ok, false);
  assertDualCodes(atBoundary, {
    legacy: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_ROTATED,
    canonical: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_ROTATED
  });
});

test("identity lifecycle: revokedAt boundary is deterministic and fail-closed at boundary", () => {
  const key = {
    keyId: "key_revoke_boundary_1",
    status: "active",
    revokedAt: "2026-02-20T00:00:10.000Z"
  };

  const before = evaluateSignerLifecycleForContinuity({ signerKey: key, at: "2026-02-20T00:00:09.999Z" });
  assert.equal(before.ok, true);
  assert.equal(before.code, null);
  assert.equal(before.legacyCode, null);
  assert.equal(before.canonicalCode, null);

  const atBoundary = evaluateSignerLifecycleForContinuity({ signerKey: key, at: "2026-02-20T00:00:10.000Z" });
  assert.equal(atBoundary.ok, false);
  assertDualCodes(atBoundary, {
    legacy: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_REVOKED,
    canonical: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_REVOKED
  });
});

test("identity lifecycle: not-yet-valid and expired windows enforce deterministic boundaries", () => {
  const key = {
    keyId: "key_window_1",
    status: "active",
    validFrom: "2026-02-20T00:00:10.000Z",
    validTo: "2026-02-20T00:00:20.000Z"
  };

  const before = evaluateSignerLifecycleForContinuity({ signerKey: key, at: "2026-02-20T00:00:09.999Z" });
  assert.equal(before.ok, false);
  assertDualCodes(before, {
    legacy: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_NOT_YET_VALID,
    canonical: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_NOT_YET_VALID
  });

  const atStart = evaluateSignerLifecycleForContinuity({ signerKey: key, at: "2026-02-20T00:00:10.000Z" });
  assert.equal(atStart.ok, true);

  const atEnd = evaluateSignerLifecycleForContinuity({ signerKey: key, at: "2026-02-20T00:00:20.000Z" });
  assert.equal(atEnd.ok, true);

  const after = evaluateSignerLifecycleForContinuity({ signerKey: key, at: "2026-02-20T00:00:20.001Z" });
  assert.equal(after.ok, false);
  assertDualCodes(after, {
    legacy: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_EXPIRED,
    canonical: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_EXPIRED
  });
});

test("identity lifecycle: missing registration fails closed with canonical and legacy codes", () => {
  const missing = evaluateSignerLifecycleForContinuity({
    signerKey: null,
    at: "2026-02-20T00:00:15.000Z",
    requireRegistered: true
  });
  assert.equal(missing.ok, false);
  assertDualCodes(missing, {
    legacy: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_NOT_REGISTERED,
    canonical: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_NOT_REGISTERED
  });
});

test("identity lifecycle: invalid lifecycle field values fail closed deterministically", () => {
  const invalidDate = evaluateSignerLifecycleForContinuity({
    signerKey: { keyId: "key_invalid_1", status: "active", rotatedAt: "not-a-date" },
    at: "2026-02-20T00:00:15.000Z"
  });
  assert.equal(invalidDate.ok, false);
  assertDualCodes(invalidDate, {
    legacy: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_LIFECYCLE_INVALID,
    canonical: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_LIFECYCLE_INVALID
  });

  const invalidWindow = evaluateSignerLifecycleForContinuity({
    signerKey: {
      keyId: "key_invalid_2",
      status: "active",
      validFrom: "2026-02-20T00:00:20.000Z",
      validTo: "2026-02-20T00:00:10.000Z"
    },
    at: "2026-02-20T00:00:15.000Z"
  });
  assert.equal(invalidWindow.ok, false);
  assertDualCodes(invalidWindow, {
    legacy: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_LIFECYCLE_INVALID,
    canonical: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_LIFECYCLE_INVALID
  });
});
