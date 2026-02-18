import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const X402_PROVIDER_REFUND_DECISION_PAYLOAD_SCHEMA_VERSION = "X402ProviderRefundDecisionPayload.v1";
export const X402_PROVIDER_REFUND_DECISION_SCHEMA_VERSION = "X402ProviderRefundDecision.v1";
export const X402_PROVIDER_REFUND_DECISION_SIGNATURE_SCHEMA_VERSION = "X402ProviderRefundDecisionSignature.v1";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function assertPemString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty PEM string`);
  return value;
}

function assertOptionalString(value, name, { max = 1000 } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const out = String(value).trim();
  if (out.length > max) throw new TypeError(`${name} must be <= ${max} chars`);
  return out;
}

function assertOptionalId(value, name, { max = 200 } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const out = String(value).trim();
  if (out.length > max) throw new TypeError(`${name} must be <= ${max} chars`);
  if (!/^[A-Za-z0-9:._/-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:._/-]+$`);
  return out;
}

function assertIsoDateTime(value, name) {
  const out = assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(out))) throw new TypeError(`${name} must be an ISO date-time`);
  return new Date(out).toISOString();
}

function assertSha256Hex(value, name) {
  const out = assertNonEmptyString(value, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be sha256 hex`);
  return out;
}

function assertOptionalSha256Hex(value, name) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return assertSha256Hex(value, name);
}

function assertDecision(value, name = "decision") {
  const out = assertNonEmptyString(value, name).toLowerCase();
  if (out !== "accepted" && out !== "denied") throw new TypeError(`${name} must be accepted|denied`);
  return out;
}

export function buildX402ProviderRefundDecisionPayloadV1({
  decisionId = null,
  receiptId,
  gateId,
  quoteId = null,
  requestSha256 = null,
  decision,
  reason = null,
  decidedAt
} = {}) {
  return normalizeForCanonicalJson(
    {
      schemaVersion: X402_PROVIDER_REFUND_DECISION_PAYLOAD_SCHEMA_VERSION,
      ...(assertOptionalId(decisionId, "decisionId", { max: 200 }) ? { decisionId: assertOptionalId(decisionId, "decisionId", { max: 200 }) } : {}),
      receiptId: assertOptionalId(receiptId, "receiptId", { max: 200 }) ?? (() => {
        throw new TypeError("receiptId is required");
      })(),
      gateId: assertOptionalId(gateId, "gateId", { max: 200 }) ?? (() => {
        throw new TypeError("gateId is required");
      })(),
      ...(assertOptionalId(quoteId, "quoteId", { max: 200 }) ? { quoteId: assertOptionalId(quoteId, "quoteId", { max: 200 }) } : {}),
      ...(assertOptionalSha256Hex(requestSha256, "requestSha256") ? { requestSha256: assertOptionalSha256Hex(requestSha256, "requestSha256") } : {}),
      decision: assertDecision(decision, "decision"),
      ...(assertOptionalString(reason, "reason", { max: 1000 }) ? { reason: assertOptionalString(reason, "reason", { max: 1000 }) } : {}),
      decidedAt: assertIsoDateTime(decidedAt, "decidedAt")
    },
    { path: "$" }
  );
}

export function computeX402ProviderRefundDecisionPayloadHashV1({ payload } = {}) {
  const normalizedPayload = buildX402ProviderRefundDecisionPayloadV1(payload ?? {});
  return sha256Hex(canonicalJsonStringify(normalizedPayload));
}

function normalizeDecisionEnvelope(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) throw new TypeError("decision must be an object");
  const payload = buildX402ProviderRefundDecisionPayloadV1(decision);
  const signature = decision.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) throw new TypeError("decision.signature must be an object");
  if (String(signature.schemaVersion ?? "") !== X402_PROVIDER_REFUND_DECISION_SIGNATURE_SCHEMA_VERSION) {
    throw new TypeError(`decision.signature.schemaVersion must be ${X402_PROVIDER_REFUND_DECISION_SIGNATURE_SCHEMA_VERSION}`);
  }
  if (String(signature.algorithm ?? "").toLowerCase() !== "ed25519") throw new TypeError("decision.signature.algorithm must be ed25519");
  return {
    schemaVersion: decision.schemaVersion ?? X402_PROVIDER_REFUND_DECISION_SCHEMA_VERSION,
    payload,
    signature: normalizeForCanonicalJson(
      {
        schemaVersion: X402_PROVIDER_REFUND_DECISION_SIGNATURE_SCHEMA_VERSION,
        algorithm: "ed25519",
        keyId: assertNonEmptyString(signature.keyId, "decision.signature.keyId"),
        signedAt: assertIsoDateTime(signature.signedAt, "decision.signature.signedAt"),
        payloadHash: assertSha256Hex(signature.payloadHash, "decision.signature.payloadHash"),
        signatureBase64: assertNonEmptyString(signature.signatureBase64, "decision.signature.signatureBase64")
      },
      { path: "$" }
    )
  };
}

export function signX402ProviderRefundDecisionV1({ decision, signedAt, publicKeyPem, privateKeyPem } = {}) {
  const payload = buildX402ProviderRefundDecisionPayloadV1(decision ?? {});
  const signerPublicKeyPem = assertPemString(publicKeyPem, "publicKeyPem");
  const signerPrivateKeyPem = assertPemString(privateKeyPem, "privateKeyPem");
  const payloadHash = computeX402ProviderRefundDecisionPayloadHashV1({ payload });
  const signatureBase64 = signHashHexEd25519(payloadHash, signerPrivateKeyPem);
  const payloadFields = { ...payload };
  delete payloadFields.schemaVersion;
  return normalizeForCanonicalJson(
    {
      schemaVersion: X402_PROVIDER_REFUND_DECISION_SCHEMA_VERSION,
      ...payloadFields,
      signature: {
        schemaVersion: X402_PROVIDER_REFUND_DECISION_SIGNATURE_SCHEMA_VERSION,
        algorithm: "ed25519",
        keyId: keyIdFromPublicKeyPem(signerPublicKeyPem),
        signedAt: assertIsoDateTime(signedAt, "signedAt"),
        payloadHash,
        signatureBase64
      }
    },
    { path: "$" }
  );
}

export function verifyX402ProviderRefundDecisionV1({
  decision,
  publicKeyPem,
  expectedReceiptId = null,
  expectedGateId = null,
  expectedQuoteId = null,
  expectedRequestSha256 = null,
  expectedDecision = null
} = {}) {
  try {
    const signerPublicKeyPem = assertPemString(publicKeyPem, "publicKeyPem");
    const normalized = normalizeDecisionEnvelope(decision);
    if (String(normalized.schemaVersion ?? "") !== X402_PROVIDER_REFUND_DECISION_SCHEMA_VERSION) {
      return { ok: false, code: "X402_PROVIDER_REFUND_DECISION_SCHEMA_INVALID", error: "invalid schemaVersion" };
    }
    const expectedKeyId = keyIdFromPublicKeyPem(signerPublicKeyPem);
    if (normalized.signature.keyId !== expectedKeyId) {
      return { ok: false, code: "X402_PROVIDER_REFUND_DECISION_KEY_ID_MISMATCH", error: "signature keyId mismatch" };
    }
    const payloadHash = computeX402ProviderRefundDecisionPayloadHashV1({ payload: normalized.payload });
    if (normalized.signature.payloadHash !== payloadHash) {
      return { ok: false, code: "X402_PROVIDER_REFUND_DECISION_PAYLOAD_HASH_MISMATCH", error: "payload hash mismatch" };
    }
    const signatureValid = verifyHashHexEd25519({
      hashHex: payloadHash,
      signatureBase64: normalized.signature.signatureBase64,
      publicKeyPem: signerPublicKeyPem
    });
    if (!signatureValid) {
      return { ok: false, code: "X402_PROVIDER_REFUND_DECISION_SIGNATURE_INVALID", error: "signature invalid" };
    }

    if (expectedReceiptId !== null) {
      const expected = assertOptionalId(expectedReceiptId, "expectedReceiptId", { max: 200 });
      if (expected !== normalized.payload.receiptId) {
        return { ok: false, code: "X402_PROVIDER_REFUND_DECISION_RECEIPT_MISMATCH", error: "receiptId mismatch" };
      }
    }
    if (expectedGateId !== null) {
      const expected = assertOptionalId(expectedGateId, "expectedGateId", { max: 200 });
      if (expected !== normalized.payload.gateId) {
        return { ok: false, code: "X402_PROVIDER_REFUND_DECISION_GATE_MISMATCH", error: "gateId mismatch" };
      }
    }
    if (expectedQuoteId !== null) {
      const expected = assertOptionalId(expectedQuoteId, "expectedQuoteId", { max: 200 });
      if (expected !== normalized.payload.quoteId) {
        return { ok: false, code: "X402_PROVIDER_REFUND_DECISION_QUOTE_MISMATCH", error: "quoteId mismatch" };
      }
    }
    if (expectedRequestSha256 !== null) {
      const expected = assertOptionalSha256Hex(expectedRequestSha256, "expectedRequestSha256");
      if (expected !== normalized.payload.requestSha256) {
        return { ok: false, code: "X402_PROVIDER_REFUND_DECISION_REQUEST_HASH_MISMATCH", error: "requestSha256 mismatch" };
      }
    }
    if (expectedDecision !== null) {
      const expected = assertDecision(expectedDecision, "expectedDecision");
      if (expected !== normalized.payload.decision) {
        return { ok: false, code: "X402_PROVIDER_REFUND_DECISION_VALUE_MISMATCH", error: "decision mismatch" };
      }
    }

    return {
      ok: true,
      code: null,
      error: null,
      payload: normalized.payload,
      payloadHash,
      keyId: normalized.signature.keyId
    };
  } catch (err) {
    return {
      ok: false,
      code: "X402_PROVIDER_REFUND_DECISION_SCHEMA_INVALID",
      error: err?.message ?? String(err ?? "")
    };
  }
}
