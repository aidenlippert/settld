import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const TOOL_PROVIDER_SIGNATURE_PAYLOAD_SCHEMA_VERSION = "ToolProviderSignaturePayload.v1";
export const TOOL_PROVIDER_SIGNATURE_SCHEMA_VERSION = "ToolProviderSignature.v1";

function assertNonEmptyString(v, name) {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertIsoDate(v, name) {
  assertNonEmptyString(v, name);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new TypeError(`${name} must be an ISO date-time`);
}

function assertSha256Hex(v, name) {
  assertNonEmptyString(v, name);
  const s = v.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new TypeError(`${name} must be sha256 hex`);
  return s;
}

function assertNonceHex(v, name) {
  assertNonEmptyString(v, name);
  const s = v.trim().toLowerCase();
  if (!/^[0-9a-f]{16,128}$/.test(s)) throw new TypeError(`${name} must be hex (16..128 chars)`);
  return s;
}

export function buildToolProviderSignaturePayloadV1({ responseHash, nonce, signedAt } = {}) {
  const payload = normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_PROVIDER_SIGNATURE_PAYLOAD_SCHEMA_VERSION,
      responseHash: assertSha256Hex(responseHash, "responseHash"),
      nonce: assertNonceHex(nonce, "nonce"),
      signedAt: (() => {
        assertIsoDate(signedAt, "signedAt");
        return signedAt;
      })()
    },
    { path: "$" }
  );
  return payload;
}

export function computeToolProviderSignaturePayloadHashV1({ responseHash, nonce, signedAt } = {}) {
  const payload = buildToolProviderSignaturePayloadV1({ responseHash, nonce, signedAt });
  return sha256Hex(canonicalJsonStringify(payload));
}

export function signToolProviderSignatureV1({ responseHash, nonce, signedAt, publicKeyPem, privateKeyPem } = {}) {
  assertNonEmptyString(publicKeyPem, "publicKeyPem");
  assertNonEmptyString(privateKeyPem, "privateKeyPem");
  const keyId = keyIdFromPublicKeyPem(publicKeyPem);
  const payloadHashHex = computeToolProviderSignaturePayloadHashV1({ responseHash, nonce, signedAt });
  const signatureBase64 = signHashHexEd25519(payloadHashHex, privateKeyPem);
  const sig = normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_PROVIDER_SIGNATURE_SCHEMA_VERSION,
      algorithm: "ed25519",
      keyId,
      signedAt,
      nonce,
      responseHash: String(responseHash).trim().toLowerCase(),
      payloadHash: payloadHashHex,
      signatureBase64
    },
    { path: "$" }
  );
  return sig;
}

export function verifyToolProviderSignatureV1({ signature, publicKeyPem } = {}) {
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) throw new TypeError("signature must be an object");
  assertNonEmptyString(publicKeyPem, "publicKeyPem");

  if (signature.schemaVersion !== TOOL_PROVIDER_SIGNATURE_SCHEMA_VERSION) {
    throw new TypeError(`signature.schemaVersion must be ${TOOL_PROVIDER_SIGNATURE_SCHEMA_VERSION}`);
  }
  if (String(signature.algorithm ?? "").toLowerCase() !== "ed25519") {
    throw new TypeError("signature.algorithm must be ed25519");
  }
  const expectedKeyId = keyIdFromPublicKeyPem(publicKeyPem);
  if (String(signature.keyId ?? "").trim() !== expectedKeyId) return false;

  const payloadHashHex = computeToolProviderSignaturePayloadHashV1({
    responseHash: signature.responseHash,
    nonce: signature.nonce,
    signedAt: signature.signedAt
  });
  if (String(signature.payloadHash ?? "").trim().toLowerCase() !== payloadHashHex) return false;
  const signatureBase64 = String(signature.signatureBase64 ?? "").trim();
  if (!signatureBase64) return false;

  return verifyHashHexEd25519({ hashHex: payloadHashHex, signatureBase64, publicKeyPem });
}

