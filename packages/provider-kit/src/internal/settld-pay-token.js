import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";
import { keyMapFromSettldKeyset } from "./settld-keys.js";

export const SETTLD_PAY_TOKEN_VERSION = 1;

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return String(value).trim();
}

function normalizeCurrency(value, name) {
  const raw = typeof value === "string" && value.trim() !== "" ? value : "USD";
  const out = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(out)) throw new TypeError(`${name} must match ^[A-Z][A-Z0-9_]{2,11}$`);
  return out;
}

function normalizePositiveSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function normalizeUnixSeconds(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer unix timestamp`);
  return n;
}

function normalizeHexHash(value, name) {
  const s = assertNonEmptyString(value, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new TypeError(`${name} must be a 64-hex sha256`);
  return s;
}

function decodeEnvelope(token) {
  const raw = assertNonEmptyString(token, "token");
  let decoded = null;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch (err) {
    throw new TypeError(`token is not valid base64url: ${err?.message ?? String(err ?? "")}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (err) {
    throw new TypeError(`token is not valid JSON envelope: ${err?.message ?? String(err ?? "")}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("token envelope must be an object");
  if (Number(parsed.v) !== SETTLD_PAY_TOKEN_VERSION) throw new TypeError(`token envelope version must be ${SETTLD_PAY_TOKEN_VERSION}`);
  const kid = assertNonEmptyString(parsed.kid, "token.kid");
  if (!parsed.payload || typeof parsed.payload !== "object" || Array.isArray(parsed.payload)) {
    throw new TypeError("token.payload must be an object");
  }
  const sig = assertNonEmptyString(parsed.sig, "token.sig");
  return { envelope: parsed, kid, payload: parsed.payload, sig };
}

export function buildSettldPayPayloadV1({
  iss = "settld",
  aud,
  gateId,
  authorizationRef,
  amountCents,
  currency = "USD",
  payeeProviderId,
  iat,
  exp
} = {}) {
  const normalizedIat = normalizeUnixSeconds(iat, "iat");
  const normalizedExp = normalizeUnixSeconds(exp, "exp");
  if (normalizedExp <= normalizedIat) throw new TypeError("exp must be greater than iat");

  return normalizeForCanonicalJson(
    {
      iss: assertNonEmptyString(iss, "iss"),
      aud: assertNonEmptyString(aud, "aud"),
      gateId: assertNonEmptyString(gateId, "gateId"),
      authorizationRef: assertNonEmptyString(authorizationRef, "authorizationRef"),
      amountCents: normalizePositiveSafeInt(amountCents, "amountCents"),
      currency: normalizeCurrency(currency, "currency"),
      payeeProviderId: assertNonEmptyString(payeeProviderId, "payeeProviderId"),
      iat: normalizedIat,
      exp: normalizedExp
    },
    { path: "$" }
  );
}

export function computeSettldPayPayloadHashV1(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("payload must be an object");
  return sha256Hex(canonicalJsonStringify(payload));
}

export function computeSettldPayTokenSha256(token) {
  return sha256Hex(assertNonEmptyString(token, "token"));
}

export function mintSettldPayTokenV1({ payload, keyId = null, publicKeyPem = null, privateKeyPem } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("payload must be an object");
  const normalizedPayload = normalizeForCanonicalJson(payload, { path: "$" });
  const privatePem = assertNonEmptyString(privateKeyPem, "privateKeyPem");
  const publicPem = (() => {
    if (publicKeyPem === null || publicKeyPem === undefined) return null;
    if (typeof publicKeyPem !== "string" || publicKeyPem.trim() === "") throw new TypeError("publicKeyPem must be a non-empty string");
    return publicKeyPem;
  })();
  const derivedKeyId = publicPem ? keyIdFromPublicKeyPem(publicPem) : null;
  const normalizedKeyId = keyId === null || keyId === undefined || String(keyId).trim() === "" ? derivedKeyId : String(keyId).trim();
  if (!normalizedKeyId) throw new TypeError("keyId is required (or provide publicKeyPem)");
  if (derivedKeyId && normalizedKeyId !== derivedKeyId) throw new TypeError("keyId does not match publicKeyPem");

  const payloadHashHex = computeSettldPayPayloadHashV1(normalizedPayload);
  const signatureBase64 = signHashHexEd25519(payloadHashHex, privatePem);
  const envelope = normalizeForCanonicalJson(
    {
      v: SETTLD_PAY_TOKEN_VERSION,
      kid: normalizedKeyId,
      payload: normalizedPayload,
      sig: Buffer.from(signatureBase64, "base64").toString("base64url")
    },
    { path: "$" }
  );
  const token = Buffer.from(canonicalJsonStringify(envelope), "utf8").toString("base64url");
  return {
    token,
    envelope,
    kid: normalizedKeyId,
    payloadHashHex,
    tokenSha256: computeSettldPayTokenSha256(token)
  };
}

export function parseSettldPayTokenV1(token) {
  const { envelope, kid, payload, sig } = decodeEnvelope(token);
  return { envelope, kid, payload, sig };
}

export function verifySettldPayTokenV1({
  token,
  keyset,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
  expectedAudience = null,
  expectedPayeeProviderId = null
} = {}) {
  const { envelope, kid, payload, sig } = decodeEnvelope(token);
  const keyMap = keyMapFromSettldKeyset(keyset);
  const keyEntry = keyMap.get(kid) ?? null;
  if (!keyEntry?.publicKeyPem) return { ok: false, code: "SETTLD_PAY_UNKNOWN_KID", kid };

  const payloadHashHex = computeSettldPayPayloadHashV1(payload);
  const signatureBase64 = (() => {
    try {
      return Buffer.from(sig, "base64url").toString("base64");
    } catch {
      return null;
    }
  })();
  if (!signatureBase64) return { ok: false, code: "SETTLD_PAY_SIGNATURE_INVALID", kid };

  let signatureValid = false;
  try {
    signatureValid = verifyHashHexEd25519({ hashHex: payloadHashHex, signatureBase64, publicKeyPem: keyEntry.publicKeyPem });
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, code: "SETTLD_PAY_SIGNATURE_INVALID", kid };

  let normalizedPayload;
  try {
    normalizedPayload = buildSettldPayPayloadV1(payload);
  } catch (err) {
    return { ok: false, code: "SETTLD_PAY_PAYLOAD_INVALID", kid, message: err?.message ?? String(err ?? "") };
  }

  const nowSec = normalizeUnixSeconds(nowUnixSeconds, "nowUnixSeconds");
  if (nowSec > Number(normalizedPayload.exp)) return { ok: false, code: "SETTLD_PAY_EXPIRED", kid, payload: normalizedPayload };
  if (expectedAudience !== null && expectedAudience !== undefined && String(expectedAudience) !== String(normalizedPayload.aud)) {
    return { ok: false, code: "SETTLD_PAY_AUDIENCE_MISMATCH", kid, payload: normalizedPayload };
  }
  if (
    expectedPayeeProviderId !== null &&
    expectedPayeeProviderId !== undefined &&
    String(expectedPayeeProviderId) !== String(normalizedPayload.payeeProviderId)
  ) {
    return { ok: false, code: "SETTLD_PAY_PAYEE_MISMATCH", kid, payload: normalizedPayload };
  }

  return {
    ok: true,
    kid,
    payload: normalizedPayload,
    envelope,
    payloadHashHex: normalizeHexHash(payloadHashHex, "payloadHashHex"),
    tokenSha256: computeSettldPayTokenSha256(token),
    key: keyEntry
  };
}
