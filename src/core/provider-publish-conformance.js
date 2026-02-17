import { canonicalJsonStringify } from "./canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex } from "./crypto.js";
import { normalizePaidToolManifestV1, validatePaidToolManifestV1 } from "./paid-tool-manifest.js";
import { buildSettldPayPayloadV1, computeSettldPayRequestBindingSha256V1, mintSettldPayTokenV1 } from "./settld-pay-token.js";
import { parseX402PaymentRequired } from "./x402-gate.js";
import { computeToolProviderSignaturePayloadHashV1, verifyToolProviderSignatureV1 } from "./tool-provider-signature.js";

export const PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION = "ProviderConformanceReport.v1";

function normalizeOptionalString(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return String(value).trim();
}

function normalizeNonEmptyPem(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return String(value);
  return value.trim() === "" ? null : value;
}

function requestInitForMethod(method, token = null) {
  const m = String(method ?? "GET").toUpperCase();
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `SettldPay ${token}`;
  const hasBody = m !== "GET" && m !== "HEAD";
  if (!hasBody) return { method: m, headers };
  headers["content-type"] = "application/json";
  return { method: m, headers, body: "{}" };
}

function headerValue(headers, name) {
  return normalizeOptionalString(headers?.get?.(name));
}

function toHeaderObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = String(v);
  return out;
}

async function resolveProviderSigningPublicKeyPem({ providerSigningPublicKeyPem, providerBaseUrl, fetchFn, timeoutMs }) {
  const inlinePem = normalizeNonEmptyPem(providerSigningPublicKeyPem);
  if (inlinePem) {
    return inlinePem;
  }
  const url = new URL("/settld/provider-key", providerBaseUrl);
  const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
  const response = await fetchFn(url, { method: "GET", signal });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`provider signing key lookup failed (${response.status}): ${text || "unknown"}`);
  }
  const body = await response.json();
  const pem = normalizeNonEmptyPem(body?.publicKeyPem);
  if (!pem) throw new Error("provider key endpoint did not return publicKeyPem");
  return pem;
}

function pickConformanceTool({ manifest, toolId = null } = {}) {
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  if (tools.length === 0) return null;
  if (toolId) {
    const selected = tools.find((row) => String(row?.toolId ?? "") === String(toolId));
    if (selected) return selected;
  }
  const getTool = tools.find((row) => String(row?.method ?? "GET").toUpperCase() === "GET");
  return getTool ?? tools[0];
}

function parseChallengeFields(unpaidResponseHeaders) {
  const parsed = parseX402PaymentRequired({
    "x-payment-required": headerValue(unpaidResponseHeaders, "x-payment-required"),
    "payment-required": headerValue(unpaidResponseHeaders, "payment-required")
  });
  if (!parsed.ok) return { ok: false, code: "PROVIDER_CONFORMANCE_CHALLENGE_PARSE_FAILED", message: parsed.error ?? "invalid challenge" };
  const fields = parsed.fields && typeof parsed.fields === "object" && !Array.isArray(parsed.fields) ? parsed.fields : {};
  const rawAmount = fields.amountCents ?? fields.amount_cents ?? fields.priceCents ?? fields.price ?? fields.amount;
  const amountCents = Number(rawAmount);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { ok: false, code: "PROVIDER_CONFORMANCE_CHALLENGE_INVALID", message: "challenge amountCents missing/invalid" };
  }
  const currencyRaw = fields.currency ?? "USD";
  const currency = String(currencyRaw).trim().toUpperCase();
  if (!currency) return { ok: false, code: "PROVIDER_CONFORMANCE_CHALLENGE_INVALID", message: "challenge currency missing/invalid" };
  return { ok: true, parsed, fields, amountCents, currency };
}

function buildCheck(id, ok, details = null) {
  return {
    id,
    ok: ok === true,
    details: details && typeof details === "object" && !Array.isArray(details) ? details : details ?? null
  };
}

function evaluateChecks(checks) {
  const safe = Array.isArray(checks) ? checks : [];
  const passed = safe.filter((row) => row && row.ok === true).length;
  return {
    ok: safe.length > 0 && passed === safe.length,
    requiredChecks: safe.length,
    passedChecks: passed
  };
}

function methodSupportsBody(method) {
  const m = String(method ?? "GET").toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

function computeConformanceRequestBindingSha256({ method, requestUrl, requestBody }) {
  const bodyBytes = requestBody === undefined || requestBody === null ? Buffer.from("", "utf8") : Buffer.from(String(requestBody), "utf8");
  const bodySha256 = sha256Hex(bodyBytes);
  return computeSettldPayRequestBindingSha256V1({
    method: String(method ?? "GET").toUpperCase(),
    host: String(requestUrl?.host ?? "").toLowerCase(),
    pathWithQuery: `${requestUrl?.pathname ?? "/"}${requestUrl?.search ?? ""}`,
    bodySha256
  });
}

export async function runProviderConformanceV1({
  providerBaseUrl,
  manifest: manifestInput,
  providerId = null,
  providerSigningPublicKeyPem = null,
  conformanceToolId = null,
  settldSigner,
  fetchFn = null,
  ttlSeconds = 300,
  timeoutMs = 5000
} = {}) {
  const reportStartedAt = new Date().toISOString();
  const checks = [];

  const fetchImpl = typeof fetchFn === "function" ? fetchFn : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");

  const signerPublicKeyPem = normalizeOptionalString(settldSigner?.publicKeyPem);
  const signerKeyId = normalizeOptionalString(settldSigner?.keyId);
  const signerPrivateKeyPem = normalizeOptionalString(settldSigner?.privateKeyPem);
  if (!signerPrivateKeyPem || (!signerPublicKeyPem && !signerKeyId)) {
    throw new TypeError("settldSigner.privateKeyPem and (settldSigner.keyId or settldSigner.publicKeyPem) are required");
  }

  const manifestResult = validatePaidToolManifestV1(manifestInput);
  if (!manifestResult.ok) {
    const report = {
      schemaVersion: PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      startedAt: reportStartedAt,
      providerBaseUrl: normalizeOptionalString(providerBaseUrl),
      providerId: normalizeOptionalString(providerId),
      checks: [buildCheck("manifest_valid", false, { code: manifestResult.code, message: manifestResult.message })]
    };
    report.verdict = evaluateChecks(report.checks);
    return report;
  }
  const manifest = manifestResult.manifest;

  let safeBaseUrl = null;
  try {
    safeBaseUrl = new URL(String(providerBaseUrl ?? "").trim()).toString();
  } catch (err) {
    const report = {
      schemaVersion: PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      startedAt: reportStartedAt,
      providerBaseUrl: normalizeOptionalString(providerBaseUrl),
      providerId: normalizeOptionalString(providerId ?? manifest.providerId),
      checks: [
        buildCheck("manifest_valid", true),
        buildCheck("provider_base_url_valid", false, { message: err?.message ?? "invalid providerBaseUrl" })
      ]
    };
    report.verdict = evaluateChecks(report.checks);
    return report;
  }

  const effectiveProviderId = normalizeOptionalString(providerId) ?? String(manifest.providerId);
  const tool = pickConformanceTool({ manifest, toolId: conformanceToolId });
  if (!tool) {
    const report = {
      schemaVersion: PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      startedAt: reportStartedAt,
      providerBaseUrl: safeBaseUrl,
      providerId: effectiveProviderId,
      checks: [
        buildCheck("manifest_valid", true),
        buildCheck("provider_base_url_valid", true),
        buildCheck("conformance_tool_selected", false, { message: "no tool found in manifest" })
      ]
    };
    report.verdict = evaluateChecks(report.checks);
    return report;
  }

  checks.push(buildCheck("manifest_valid", true));
  checks.push(buildCheck("provider_base_url_valid", true));
  checks.push(buildCheck("conformance_tool_selected", true, { toolId: tool.toolId, method: tool.method, paidPath: tool.paidPath }));

  const requestUrl = new URL(tool.paidPath, safeBaseUrl);
  const toolIdempotency = typeof tool?.idempotency === "string" ? tool.idempotency.trim().toLowerCase() : "";
  const strictRequestBindingRequired = toolIdempotency === "non_idempotent" || toolIdempotency === "side_effecting";
  const unpaidReqInit = requestInitForMethod(tool.method);
  const unpaidSignal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
  const unpaidResponse = await fetchImpl(requestUrl, { ...unpaidReqInit, signal: unpaidSignal });
  checks.push(
    buildCheck("unpaid_returns_402", unpaidResponse.status === 402, {
      statusCode: unpaidResponse.status
    })
  );

  const challengeHeaderX = headerValue(unpaidResponse.headers, "x-payment-required");
  const challengeHeaderStd = headerValue(unpaidResponse.headers, "payment-required");
  checks.push(
    buildCheck("challenge_headers_present", Boolean(challengeHeaderX) && Boolean(challengeHeaderStd), {
      hasXPaymentRequired: Boolean(challengeHeaderX),
      hasPaymentRequired: Boolean(challengeHeaderStd)
    })
  );

  const parsedChallenge = parseChallengeFields(unpaidResponse.headers);
  checks.push(
    buildCheck("challenge_header_parseable", parsedChallenge.ok === true, parsedChallenge.ok ? null : { message: parsedChallenge.message, code: parsedChallenge.code })
  );

  const expectedAmount = Number(tool?.pricing?.amountCents ?? manifest?.defaults?.amountCents);
  const expectedCurrency = String(tool?.pricing?.currency ?? manifest?.defaults?.currency ?? "USD").toUpperCase();
  if (parsedChallenge.ok) {
    const parsedProviderId = normalizeOptionalString(parsedChallenge.fields?.providerId);
    const parsedToolId = normalizeOptionalString(parsedChallenge.fields?.toolId);
    checks.push(
      buildCheck("challenge_matches_manifest_pricing", parsedChallenge.amountCents === expectedAmount && parsedChallenge.currency === expectedCurrency, {
        expectedAmountCents: expectedAmount,
        challengeAmountCents: parsedChallenge.amountCents,
        expectedCurrency,
        challengeCurrency: parsedChallenge.currency
      })
    );
    checks.push(
      buildCheck(
        "challenge_matches_provider_and_tool",
        (!parsedProviderId || parsedProviderId === effectiveProviderId) && (!parsedToolId || parsedToolId === tool.toolId),
        {
          expectedProviderId: effectiveProviderId,
          challengeProviderId: parsedProviderId,
          expectedToolId: tool.toolId,
          challengeToolId: parsedToolId
        }
      )
    );
  } else {
    checks.push(buildCheck("challenge_matches_manifest_pricing", false, { message: "challenge parse failed" }));
    checks.push(buildCheck("challenge_matches_provider_and_tool", false, { message: "challenge parse failed" }));
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const authorizationRef = `auth_conformance_${sha256Hex(`${effectiveProviderId}\n${tool.toolId}\n${nowUnix}`).slice(0, 16)}`;
  const gateId = `gate_conformance_${sha256Hex(`${authorizationRef}\n${requestUrl.toString()}`).slice(0, 16)}`;
  const tokenKid = signerKeyId ?? keyIdFromPublicKeyPem(signerPublicKeyPem);
  const conformanceRequestBindingSha256 = strictRequestBindingRequired
    ? computeConformanceRequestBindingSha256({
        method: tool.method,
        requestUrl,
        requestBody: methodSupportsBody(tool.method) ? "{}" : ""
      })
    : null;
  const payload = buildSettldPayPayloadV1({
    iss: "settld",
    aud: effectiveProviderId,
    gateId,
    authorizationRef,
    amountCents: expectedAmount,
    currency: expectedCurrency,
    payeeProviderId: effectiveProviderId,
    ...(strictRequestBindingRequired ? { requestBindingMode: "strict", requestBindingSha256: conformanceRequestBindingSha256 } : {}),
    iat: nowUnix,
    exp: nowUnix + Number(ttlSeconds)
  });
  const mintArgs = {
    payload,
    keyId: tokenKid,
    privateKeyPem: signerPrivateKeyPem
  };
  if (!signerKeyId && signerPublicKeyPem) mintArgs.publicKeyPem = signerPublicKeyPem;
  const token = mintSettldPayTokenV1(mintArgs).token;

  const paidSignal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
  const paidResponse = await fetchImpl(requestUrl, {
    ...requestInitForMethod(tool.method, token),
    signal: paidSignal
  });
  const paidPaymentError = headerValue(paidResponse.headers, "x-settld-payment-error");
  checks.push(
    buildCheck("paid_retry_succeeds", paidResponse.status >= 200 && paidResponse.status < 300, {
      statusCode: paidResponse.status,
      paymentError: paidPaymentError,
      tokenKid
    })
  );
  const requestBindingModeHeader = headerValue(paidResponse.headers, "x-settld-request-binding-mode");
  const requestBindingSha256Header = headerValue(paidResponse.headers, "x-settld-request-binding-sha256");
  checks.push(
    buildCheck(
      "strict_request_binding_enforced",
      strictRequestBindingRequired
        ? requestBindingModeHeader === "strict" && requestBindingSha256Header === conformanceRequestBindingSha256
        : true,
      {
        required: strictRequestBindingRequired,
        observedMode: requestBindingModeHeader,
        observedSha256Present: Boolean(requestBindingSha256Header),
        observedSha256: requestBindingSha256Header,
        expectedSha256: conformanceRequestBindingSha256
      }
    )
  );

  const paidBytes = Buffer.from(await paidResponse.arrayBuffer());
  const responseSha256 = sha256Hex(paidBytes);
  const headerResponseSha256 = headerValue(paidResponse.headers, "x-settld-provider-response-sha256");
  const providerKeyId = headerValue(paidResponse.headers, "x-settld-provider-key-id");
  const providerSignedAt = headerValue(paidResponse.headers, "x-settld-provider-signed-at");
  const providerNonce = headerValue(paidResponse.headers, "x-settld-provider-nonce");
  const providerSignature = headerValue(paidResponse.headers, "x-settld-provider-signature");
  checks.push(
    buildCheck(
      "provider_signature_headers_present",
      Boolean(providerKeyId) && Boolean(providerSignedAt) && Boolean(providerNonce) && Boolean(providerSignature) && Boolean(headerResponseSha256),
      {
        keyIdPresent: Boolean(providerKeyId),
        signedAtPresent: Boolean(providerSignedAt),
        noncePresent: Boolean(providerNonce),
        signaturePresent: Boolean(providerSignature),
        responseHashPresent: Boolean(headerResponseSha256)
      }
    )
  );
  checks.push(
    buildCheck("provider_response_hash_matches_body", headerResponseSha256 === responseSha256, {
      headerResponseSha256,
      computedResponseSha256: responseSha256
    })
  );

  let resolvedProviderPublicKeyPem = null;
  try {
    resolvedProviderPublicKeyPem = await resolveProviderSigningPublicKeyPem({
      providerSigningPublicKeyPem,
      providerBaseUrl: safeBaseUrl,
      fetchFn: fetchImpl,
      timeoutMs
    });
    checks.push(buildCheck("provider_public_key_resolved", true));
  } catch (err) {
    checks.push(buildCheck("provider_public_key_resolved", false, { message: err?.message ?? String(err ?? "") }));
  }

  let signatureVerified = false;
  let signatureVerifyDetails = null;
  if (resolvedProviderPublicKeyPem && providerSignature && providerNonce && providerSignedAt) {
    const expectedProviderKeyId = keyIdFromPublicKeyPem(resolvedProviderPublicKeyPem);
    const payloadHash = computeToolProviderSignaturePayloadHashV1({
      responseHash: responseSha256,
      nonce: providerNonce,
      signedAt: providerSignedAt
    });
    const signature = {
      schemaVersion: "ToolProviderSignature.v1",
      algorithm: "ed25519",
      keyId: providerKeyId,
      signedAt: providerSignedAt,
      nonce: providerNonce,
      responseHash: responseSha256,
      payloadHash,
      signatureBase64: providerSignature
    };
    try {
      signatureVerified = verifyToolProviderSignatureV1({ signature, publicKeyPem: resolvedProviderPublicKeyPem }) === true;
      signatureVerifyDetails = {
        expectedProviderKeyId,
        providerKeyId,
        payloadHash
      };
    } catch (err) {
      signatureVerified = false;
      signatureVerifyDetails = {
        expectedProviderKeyId,
        providerKeyId,
        payloadHash,
        error: err?.message ?? String(err ?? "")
      };
    }
  }
  checks.push(buildCheck("provider_signature_verifies", signatureVerified, signatureVerifyDetails));

  const replaySignal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
  const replayResponse = await fetchImpl(requestUrl, {
    ...requestInitForMethod(tool.method, token),
    signal: replaySignal
  });
  const replayHeader = headerValue(replayResponse.headers, "x-settld-provider-replay");
  const replayPaymentError = headerValue(replayResponse.headers, "x-settld-payment-error");
  checks.push(
    buildCheck("replay_dedupe_behavior", replayResponse.status >= 200 && replayResponse.status < 300 && replayHeader === "duplicate", {
      statusCode: replayResponse.status,
      replayHeader,
      paymentError: replayPaymentError,
      tokenKid
    })
  );

  const report = {
    schemaVersion: PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    startedAt: reportStartedAt,
    settldSignerKeyId: tokenKid,
    providerId: effectiveProviderId,
    providerBaseUrl: safeBaseUrl,
    tool: {
      toolId: tool.toolId,
      method: tool.method,
      paidPath: tool.paidPath
    },
    manifestHash: sha256Hex(canonicalJsonStringify(normalizePaidToolManifestV1(manifest))),
    checks
  };
  report.verdict = evaluateChecks(checks);
  return report;
}
