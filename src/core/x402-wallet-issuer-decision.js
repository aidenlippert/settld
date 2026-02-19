import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const X402_WALLET_ISSUER_DECISION_TOKEN_VERSION = 1;

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return String(value).trim();
}

function assertPositiveSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function assertOptionalId(value, name, { max = 200 } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const out = String(value).trim();
  if (out.length > max) throw new TypeError(`${name} must be <= ${max} chars`);
  if (!/^[A-Za-z0-9:._/-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:._/-]+$`);
  return out;
}

function assertOptionalSha256Hex(value, name) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const out = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be sha256 hex`);
  return out;
}

function normalizeCurrency(value, name) {
  const raw = typeof value === "string" && value.trim() !== "" ? value : "USD";
  const out = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(out)) throw new TypeError(`${name} must match ^[A-Z][A-Z0-9_]{2,11}$`);
  return out;
}

function normalizeOptionalRequestBindingMode(value, name) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const mode = String(value).trim().toLowerCase();
  if (mode !== "strict") throw new TypeError(`${name} must be strict when provided`);
  return mode;
}

function normalizeUnixSeconds(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer unix timestamp`);
  return n;
}

function decodeEnvelope(token) {
  const raw = assertNonEmptyString(token, "token");
  let decoded = null;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch (err) {
    throw new TypeError(`token is not valid base64url: ${err?.message ?? String(err ?? "")}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(decoded);
  } catch (err) {
    throw new TypeError(`token is not valid JSON envelope: ${err?.message ?? String(err ?? "")}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("token envelope must be an object");
  if (Number(parsed.v) !== X402_WALLET_ISSUER_DECISION_TOKEN_VERSION) {
    throw new TypeError(`token envelope version must be ${X402_WALLET_ISSUER_DECISION_TOKEN_VERSION}`);
  }
  const kid = assertNonEmptyString(parsed.kid, "token.kid");
  if (!parsed.payload || typeof parsed.payload !== "object" || Array.isArray(parsed.payload)) {
    throw new TypeError("token.payload must be an object");
  }
  const sig = assertNonEmptyString(parsed.sig, "token.sig");
  return { envelope: parsed, kid, payload: parsed.payload, sig };
}

export function buildX402WalletIssuerDecisionPayloadV1({
  decisionId,
  gateId,
  sponsorRef,
  sponsorWalletRef,
  policyRef,
  policyVersion,
  policyFingerprint,
  amountCents,
  currency = "USD",
  payeeProviderId,
  quoteId = null,
  quoteSha256 = null,
  requestBindingMode = null,
  requestBindingSha256 = null,
  idempotencyKey,
  nonce,
  iat,
  exp
} = {}) {
  const normalizedIat = normalizeUnixSeconds(iat, "iat");
  const normalizedExp = normalizeUnixSeconds(exp, "exp");
  if (normalizedExp <= normalizedIat) throw new TypeError("exp must be greater than iat");
  const normalizedRequestBindingSha256 = assertOptionalSha256Hex(requestBindingSha256, "requestBindingSha256");
  const normalizedRequestBindingMode =
    normalizeOptionalRequestBindingMode(requestBindingMode, "requestBindingMode") ??
    (normalizedRequestBindingSha256 ? "strict" : null);
  if (normalizedRequestBindingMode === "strict" && !normalizedRequestBindingSha256) {
    throw new TypeError("requestBindingSha256 is required when requestBindingMode=strict");
  }

  return normalizeForCanonicalJson(
    {
      schemaVersion: "X402WalletIssuerDecisionPayload.v1",
      decisionId: assertOptionalId(decisionId, "decisionId", { max: 200 }) ?? (() => {
        throw new TypeError("decisionId is required");
      })(),
      gateId: assertOptionalId(gateId, "gateId", { max: 200 }) ?? (() => {
        throw new TypeError("gateId is required");
      })(),
      sponsorRef: assertOptionalId(sponsorRef, "sponsorRef", { max: 200 }) ?? (() => {
        throw new TypeError("sponsorRef is required");
      })(),
      sponsorWalletRef: assertOptionalId(sponsorWalletRef, "sponsorWalletRef", { max: 200 }) ?? (() => {
        throw new TypeError("sponsorWalletRef is required");
      })(),
      policyRef: assertOptionalId(policyRef, "policyRef", { max: 200 }) ?? (() => {
        throw new TypeError("policyRef is required");
      })(),
      policyVersion: assertPositiveSafeInt(policyVersion, "policyVersion"),
      policyFingerprint: assertOptionalSha256Hex(policyFingerprint, "policyFingerprint") ?? (() => {
        throw new TypeError("policyFingerprint is required");
      })(),
      amountCents: assertPositiveSafeInt(amountCents, "amountCents"),
      currency: normalizeCurrency(currency, "currency"),
      payeeProviderId: assertOptionalId(payeeProviderId, "payeeProviderId", { max: 200 }) ?? (() => {
        throw new TypeError("payeeProviderId is required");
      })(),
      ...(assertOptionalId(quoteId, "quoteId", { max: 200 }) ? { quoteId: assertOptionalId(quoteId, "quoteId", { max: 200 }) } : {}),
      ...(assertOptionalSha256Hex(quoteSha256, "quoteSha256") ? { quoteSha256: assertOptionalSha256Hex(quoteSha256, "quoteSha256") } : {}),
      ...(normalizedRequestBindingMode ? { requestBindingMode: normalizedRequestBindingMode } : {}),
      ...(normalizedRequestBindingSha256 ? { requestBindingSha256: normalizedRequestBindingSha256 } : {}),
      idempotencyKey: assertOptionalId(idempotencyKey, "idempotencyKey", { max: 256 }) ?? (() => {
        throw new TypeError("idempotencyKey is required");
      })(),
      nonce: assertOptionalId(nonce, "nonce", { max: 256 }) ?? (() => {
        throw new TypeError("nonce is required");
      })(),
      iat: normalizedIat,
      exp: normalizedExp
    },
    { path: "$" }
  );
}

export function computeX402WalletIssuerDecisionPayloadHashV1(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("payload must be an object");
  return sha256Hex(canonicalJsonStringify(payload));
}

export function mintX402WalletIssuerDecisionTokenV1({ payload, keyId = null, publicKeyPem = null, privateKeyPem } = {}) {
  const normalizedPayload = buildX402WalletIssuerDecisionPayloadV1(payload ?? {});
  const privatePem = assertNonEmptyString(privateKeyPem, "privateKeyPem");
  const publicPem = publicKeyPem === null || publicKeyPem === undefined ? null : assertNonEmptyString(publicKeyPem, "publicKeyPem");
  const derivedKeyId = publicPem ? keyIdFromPublicKeyPem(publicPem) : null;
  const normalizedKeyId = keyId === null || keyId === undefined || String(keyId).trim() === "" ? derivedKeyId : String(keyId).trim();
  if (!normalizedKeyId) throw new TypeError("keyId is required (or provide publicKeyPem)");
  if (derivedKeyId && normalizedKeyId !== derivedKeyId) throw new TypeError("keyId does not match publicKeyPem");

  const payloadHashHex = computeX402WalletIssuerDecisionPayloadHashV1(normalizedPayload);
  const signatureBase64 = signHashHexEd25519(payloadHashHex, privatePem);
  const envelope = normalizeForCanonicalJson(
    {
      v: X402_WALLET_ISSUER_DECISION_TOKEN_VERSION,
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
    payload: normalizedPayload,
    payloadHashHex,
    tokenSha256: sha256Hex(token)
  };
}

export function verifyX402WalletIssuerDecisionTokenV1({
  token,
  publicKeyPem,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
  expected = {}
} = {}) {
  try {
    const { kid, payload, sig } = decodeEnvelope(token);
    const normalizedPayload = buildX402WalletIssuerDecisionPayloadV1(payload);
    const expectedKeyId = keyIdFromPublicKeyPem(assertNonEmptyString(publicKeyPem, "publicKeyPem"));
    if (kid !== expectedKeyId) return { ok: false, code: "X402_WALLET_ISSUER_DECISION_KEY_MISMATCH", kid };
    const payloadHashHex = computeX402WalletIssuerDecisionPayloadHashV1(normalizedPayload);
    const signatureBase64 = Buffer.from(sig, "base64url").toString("base64");
    if (!verifyHashHexEd25519({ hashHex: payloadHashHex, signatureBase64, publicKeyPem })) {
      return { ok: false, code: "X402_WALLET_ISSUER_DECISION_SIGNATURE_INVALID", kid };
    }
    if (!Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds <= 0) {
      throw new TypeError("nowUnixSeconds must be a positive safe integer");
    }
    if (normalizedPayload.exp <= nowUnixSeconds) {
      return { ok: false, code: "X402_WALLET_ISSUER_DECISION_EXPIRED", kid };
    }

    const expectedFields = [
      "gateId",
      "sponsorRef",
      "sponsorWalletRef",
      "policyRef",
      "policyVersion",
      "policyFingerprint",
      "amountCents",
      "currency",
      "payeeProviderId",
      "quoteId",
      "quoteSha256",
      "requestBindingMode",
      "requestBindingSha256"
    ];
    for (const field of expectedFields) {
      if (!Object.prototype.hasOwnProperty.call(expected, field)) continue;
      const expectedValueRaw = expected[field];
      const expectedValue = expectedValueRaw === null ? null : String(expectedValueRaw);
      const actualValue = normalizedPayload[field] === undefined || normalizedPayload[field] === null ? null : String(normalizedPayload[field]);
      if (expectedValue !== actualValue) {
        return { ok: false, code: "X402_WALLET_ISSUER_DECISION_MISMATCH", field, expected: expectedValue, actual: actualValue, kid };
      }
    }

    return {
      ok: true,
      code: null,
      kid,
      payload: normalizedPayload,
      payloadHashHex,
      tokenSha256: sha256Hex(assertNonEmptyString(token, "token"))
    };
  } catch (err) {
    return {
      ok: false,
      code: "X402_WALLET_ISSUER_DECISION_SCHEMA_INVALID",
      error: err?.message ?? String(err ?? "")
    };
  }
}
