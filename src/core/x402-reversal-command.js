import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const X402_REVERSAL_COMMAND_PAYLOAD_SCHEMA_VERSION = "X402ReversalCommandPayload.v1";
export const X402_REVERSAL_COMMAND_SCHEMA_VERSION = "X402ReversalCommand.v1";
export const X402_REVERSAL_COMMAND_SIGNATURE_SCHEMA_VERSION = "X402ReversalCommandSignature.v1";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function assertPemString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty PEM string`);
  return value;
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

function assertOptionalId(value, name, { max = 200 } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const out = String(value).trim();
  if (out.length > max) throw new TypeError(`${name} must be <= ${max} chars`);
  if (!/^[A-Za-z0-9:._/-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:._/-]+$`);
  return out;
}

function assertAction(value, name = "action") {
  const out = assertNonEmptyString(value, name).toLowerCase();
  if (out !== "void_authorization" && out !== "request_refund" && out !== "resolve_refund") {
    throw new TypeError(`${name} must be void_authorization|request_refund|resolve_refund`);
  }
  return out;
}

function assertTarget(value, name = "target") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const gateId = assertOptionalId(value.gateId, `${name}.gateId`, { max: 200 });
  const receiptId = assertOptionalId(value.receiptId, `${name}.receiptId`, { max: 200 });
  if (!gateId) throw new TypeError(`${name}.gateId is required`);
  if (!receiptId) throw new TypeError(`${name}.receiptId is required`);
  const quoteId = assertOptionalId(value.quoteId, `${name}.quoteId`, { max: 200 });
  const requestSha256 = assertOptionalSha256Hex(value.requestSha256, `${name}.requestSha256`);
  return normalizeForCanonicalJson(
    {
      gateId,
      receiptId,
      ...(quoteId ? { quoteId } : {}),
      ...(requestSha256 ? { requestSha256 } : {})
    },
    { path: "$" }
  );
}

export function buildX402ReversalCommandPayloadV1({
  commandId,
  sponsorRef,
  agentKeyId = null,
  target,
  action,
  nonce,
  idempotencyKey,
  exp
} = {}) {
  const payload = normalizeForCanonicalJson(
    {
      schemaVersion: X402_REVERSAL_COMMAND_PAYLOAD_SCHEMA_VERSION,
      commandId: assertOptionalId(commandId, "commandId", { max: 200 }) ?? (() => {
        throw new TypeError("commandId is required");
      })(),
      sponsorRef: assertOptionalId(sponsorRef, "sponsorRef", { max: 200 }) ?? (() => {
        throw new TypeError("sponsorRef is required");
      })(),
      ...(assertOptionalId(agentKeyId, "agentKeyId", { max: 200 }) ? { agentKeyId: assertOptionalId(agentKeyId, "agentKeyId", { max: 200 }) } : {}),
      target: assertTarget(target, "target"),
      action: assertAction(action, "action"),
      nonce: assertOptionalId(nonce, "nonce", { max: 256 }) ?? (() => {
        throw new TypeError("nonce is required");
      })(),
      idempotencyKey: assertOptionalId(idempotencyKey, "idempotencyKey", { max: 256 }) ?? (() => {
        throw new TypeError("idempotencyKey is required");
      })(),
      exp: assertIsoDateTime(exp, "exp")
    },
    { path: "$" }
  );
  return payload;
}

export function computeX402ReversalCommandPayloadHashV1({ payload } = {}) {
  const normalizedPayload = buildX402ReversalCommandPayloadV1(payload ?? {});
  return sha256Hex(canonicalJsonStringify(normalizedPayload));
}

function normalizeCommandEnvelope(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new TypeError("command must be an object");
  const payload = buildX402ReversalCommandPayloadV1(command);
  const signature = command.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) throw new TypeError("command.signature must be an object");
  if (String(signature.schemaVersion ?? "") !== X402_REVERSAL_COMMAND_SIGNATURE_SCHEMA_VERSION) {
    throw new TypeError(`command.signature.schemaVersion must be ${X402_REVERSAL_COMMAND_SIGNATURE_SCHEMA_VERSION}`);
  }
  if (String(signature.algorithm ?? "").toLowerCase() !== "ed25519") throw new TypeError("command.signature.algorithm must be ed25519");
  return {
    schemaVersion: command.schemaVersion ?? X402_REVERSAL_COMMAND_SCHEMA_VERSION,
    payload,
    signature: normalizeForCanonicalJson(
      {
        schemaVersion: X402_REVERSAL_COMMAND_SIGNATURE_SCHEMA_VERSION,
        algorithm: "ed25519",
        keyId: assertNonEmptyString(signature.keyId, "command.signature.keyId"),
        signedAt: assertIsoDateTime(signature.signedAt, "command.signature.signedAt"),
        payloadHash: assertSha256Hex(signature.payloadHash, "command.signature.payloadHash"),
        signatureBase64: assertNonEmptyString(signature.signatureBase64, "command.signature.signatureBase64")
      },
      { path: "$" }
    )
  };
}

export function signX402ReversalCommandV1({ command, signedAt, publicKeyPem, privateKeyPem } = {}) {
  const payload = buildX402ReversalCommandPayloadV1(command ?? {});
  const signerPublicKeyPem = assertPemString(publicKeyPem, "publicKeyPem");
  const signerPrivateKeyPem = assertPemString(privateKeyPem, "privateKeyPem");
  const payloadHash = computeX402ReversalCommandPayloadHashV1({ payload });
  const signatureBase64 = signHashHexEd25519(payloadHash, signerPrivateKeyPem);
  const payloadFields = { ...payload };
  delete payloadFields.schemaVersion;
  return normalizeForCanonicalJson(
    {
      schemaVersion: X402_REVERSAL_COMMAND_SCHEMA_VERSION,
      ...payloadFields,
      signature: {
        schemaVersion: X402_REVERSAL_COMMAND_SIGNATURE_SCHEMA_VERSION,
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

export function verifyX402ReversalCommandV1({
  command,
  publicKeyPem,
  nowAt = new Date().toISOString(),
  expectedAction = null,
  expectedSponsorRef = null,
  expectedGateId = null,
  expectedReceiptId = null,
  expectedQuoteId = null,
  expectedRequestSha256 = null
} = {}) {
  try {
    const signerPublicKeyPem = assertPemString(publicKeyPem, "publicKeyPem");
    const normalized = normalizeCommandEnvelope(command);
    if (String(normalized.schemaVersion ?? "") !== X402_REVERSAL_COMMAND_SCHEMA_VERSION) {
      return { ok: false, code: "X402_REVERSAL_COMMAND_SCHEMA_INVALID", error: "invalid schemaVersion" };
    }
    const expectedKeyId = keyIdFromPublicKeyPem(signerPublicKeyPem);
    if (normalized.signature.keyId !== expectedKeyId) {
      return { ok: false, code: "X402_REVERSAL_COMMAND_KEY_ID_MISMATCH", error: "signature keyId mismatch" };
    }

    const payloadHash = computeX402ReversalCommandPayloadHashV1({ payload: normalized.payload });
    if (normalized.signature.payloadHash !== payloadHash) {
      return { ok: false, code: "X402_REVERSAL_COMMAND_PAYLOAD_HASH_MISMATCH", error: "payload hash mismatch" };
    }
    const signatureValid = verifyHashHexEd25519({
      hashHex: payloadHash,
      signatureBase64: normalized.signature.signatureBase64,
      publicKeyPem: signerPublicKeyPem
    });
    if (!signatureValid) {
      return { ok: false, code: "X402_REVERSAL_COMMAND_SIGNATURE_INVALID", error: "signature invalid" };
    }

    const nowMs = Date.parse(assertIsoDateTime(nowAt, "nowAt"));
    const expMs = Date.parse(normalized.payload.exp);
    if (!Number.isFinite(expMs) || expMs <= nowMs) {
      return { ok: false, code: "X402_REVERSAL_COMMAND_EXPIRED", error: "command expired" };
    }

    if (expectedAction !== null && assertAction(expectedAction, "expectedAction") !== normalized.payload.action) {
      return { ok: false, code: "X402_REVERSAL_COMMAND_ACTION_MISMATCH", error: "action mismatch" };
    }
    if (expectedSponsorRef !== null) {
      const expected = assertOptionalId(expectedSponsorRef, "expectedSponsorRef", { max: 200 });
      if (expected !== normalized.payload.sponsorRef) {
        return { ok: false, code: "X402_REVERSAL_COMMAND_SPONSOR_MISMATCH", error: "sponsorRef mismatch" };
      }
    }
    if (expectedGateId !== null) {
      const expected = assertOptionalId(expectedGateId, "expectedGateId", { max: 200 });
      if (expected !== normalized.payload.target.gateId) {
        return { ok: false, code: "X402_REVERSAL_COMMAND_GATE_MISMATCH", error: "target.gateId mismatch" };
      }
    }
    if (expectedReceiptId !== null) {
      const expected = assertOptionalId(expectedReceiptId, "expectedReceiptId", { max: 200 });
      if (expected !== normalized.payload.target.receiptId) {
        return { ok: false, code: "X402_REVERSAL_COMMAND_RECEIPT_MISMATCH", error: "target.receiptId mismatch" };
      }
    }
    if (expectedQuoteId !== null) {
      const expected = assertOptionalId(expectedQuoteId, "expectedQuoteId", { max: 200 });
      if (expected !== normalized.payload.target.quoteId) {
        return { ok: false, code: "X402_REVERSAL_COMMAND_QUOTE_MISMATCH", error: "target.quoteId mismatch" };
      }
    }
    if (expectedRequestSha256 !== null) {
      const expected = assertOptionalSha256Hex(expectedRequestSha256, "expectedRequestSha256");
      if (expected !== normalized.payload.target.requestSha256) {
        return { ok: false, code: "X402_REVERSAL_COMMAND_REQUEST_HASH_MISMATCH", error: "target.requestSha256 mismatch" };
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
      code: "X402_REVERSAL_COMMAND_SCHEMA_INVALID",
      error: err?.message ?? String(err ?? "")
    };
  }
}
