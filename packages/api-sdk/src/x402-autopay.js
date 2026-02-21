function assertFetchFunction(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch must be a function");
  return fetchImpl;
}

function normalizeHeaderName(name, fallback) {
  const raw = typeof name === "string" && name.trim() !== "" ? name.trim() : fallback;
  return raw.toLowerCase();
}

function parseBooleanLike(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return null;
}

function normalizeChallengeRef(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw === "" ? null : raw;
}

function normalizeChallengeHash(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

function parseChallengeFields(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  const out = {};
  for (const part of raw.split(";")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const idx = chunk.indexOf("=");
    if (idx <= 0) continue;
    const key = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseBase64UrlJson(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  if (typeof Buffer === "undefined") return null;
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sortedJsonClone(value) {
  if (Array.isArray(value)) return value.map((entry) => sortedJsonClone(entry));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    out[key] = sortedJsonClone(value[key]);
  }
  return out;
}

function normalizeAgentPassportHeaderValue(agentPassport) {
  if (agentPassport === null || agentPassport === undefined) return null;
  if (!agentPassport || typeof agentPassport !== "object" || Array.isArray(agentPassport)) {
    throw new TypeError("agentPassport must be an object when provided");
  }
  if (typeof Buffer === "undefined") {
    throw new TypeError("agentPassport header encoding requires Buffer support");
  }
  const canonical = JSON.stringify(sortedJsonClone(agentPassport));
  return Buffer.from(canonical, "utf8").toString("base64url");
}

function buildX402ChallengeMetadata(res, { gateHeaderName }) {
  const gateIdRaw = res.headers.get(gateHeaderName);
  const gateId = typeof gateIdRaw === "string" && gateIdRaw.trim() !== "" ? gateIdRaw.trim() : null;
  const paymentRequiredRaw = res.headers.get("x-payment-required") ?? res.headers.get("payment-required");
  const paymentRequired = typeof paymentRequiredRaw === "string" && paymentRequiredRaw.trim() !== "" ? paymentRequiredRaw.trim() : null;
  const fields = paymentRequired ? parseChallengeFields(paymentRequired) : null;
  const quote = parseBase64UrlJson(res.headers.get("x-settld-provider-quote"));
  const quoteSignature = parseBase64UrlJson(res.headers.get("x-settld-provider-quote-signature"));
  const quoteRequired = parseBooleanLike(fields?.quoteRequired);
  return {
    gateId,
    paymentRequired,
    fields,
    policyChallenge: {
      spendAuthorizationMode: normalizeChallengeRef(fields?.spendAuthorizationMode),
      requestBindingMode: normalizeChallengeRef(fields?.requestBindingMode),
      requestBindingSha256: normalizeChallengeHash(fields?.requestBindingSha256),
      quoteRequired,
      quoteId: normalizeChallengeRef(fields?.quoteId),
      providerId: normalizeChallengeRef(fields?.providerId),
      toolId: normalizeChallengeRef(fields?.toolId),
      policyRef: normalizeChallengeRef(fields?.policyRef),
      policyVersion: normalizeChallengeRef(fields?.policyVersion),
      policyHash: normalizeChallengeHash(fields?.policyHash),
      policyFingerprint: normalizeChallengeHash(fields?.policyFingerprint),
      sponsorRef: normalizeChallengeRef(fields?.sponsorRef),
      sponsorWalletRef: normalizeChallengeRef(fields?.sponsorWalletRef)
    },
    providerQuote: quote,
    providerQuoteSignature: quoteSignature
  };
}

function cloneBodyForRetry(body) {
  if (body === null || body === undefined) return { ok: true, value: undefined };
  if (typeof body === "string") return { ok: true, value: body };
  if (body instanceof URLSearchParams) return { ok: true, value: new URLSearchParams(body) };
  if (body instanceof ArrayBuffer) return { ok: true, value: body.slice(0) };
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { ok: true, value: Uint8Array.from(bytes) };
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) return { ok: true, value: Buffer.from(body) };
  return { ok: false, reason: "body_not_replayable" };
}

function normalizeInitHeaders(initHeaders) {
  const out = new Headers();
  if (!initHeaders) return out;
  const input = new Headers(initHeaders);
  for (const [k, v] of input.entries()) out.set(k, v);
  return out;
}

function buildInitialInit(init, { agentPassportHeaderName, agentPassportHeaderValue }) {
  const safeInit = init && typeof init === "object" ? init : {};
  const headers = normalizeInitHeaders(safeInit.headers);
  if (agentPassportHeaderValue) headers.set(agentPassportHeaderName, agentPassportHeaderValue);
  return {
    ...safeInit,
    headers
  };
}

function buildRetryInit(init, { gateHeaderName, gateId, agentPassportHeaderName, agentPassportHeaderValue }) {
  const safeInit = init && typeof init === "object" ? init : {};
  const bodyResult = cloneBodyForRetry(safeInit.body);
  if (!bodyResult.ok) {
    const err = new Error("x402 autopay cannot replay this request body");
    err.code = "SETTLD_AUTOPAY_BODY_NOT_REPLAYABLE";
    throw err;
  }

  const headers = normalizeInitHeaders(safeInit.headers);
  headers.set(gateHeaderName, gateId);
  if (agentPassportHeaderValue) headers.set(agentPassportHeaderName, agentPassportHeaderValue);

  return {
    ...safeInit,
    headers,
    body: bodyResult.value
  };
}

export async function fetchWithSettldAutopay(url, init = {}, opts = {}) {
  const fetchImpl = assertFetchFunction(opts?.fetch ?? globalThis.fetch);
  const gateHeaderName = normalizeHeaderName(opts?.gateHeaderName, "x-settld-gate-id");
  const agentPassportHeaderName = normalizeHeaderName(opts?.agentPassportHeaderName, "x-settld-agent-passport");
  const agentPassportHeaderValue = normalizeAgentPassportHeaderValue(opts?.agentPassport ?? null);
  const onChallenge = typeof opts?.onChallenge === "function" ? opts.onChallenge : null;
  const maxAttemptsRaw = Number(opts?.maxAttempts ?? 2);
  const maxAttempts = Number.isSafeInteger(maxAttemptsRaw) && maxAttemptsRaw >= 1 ? maxAttemptsRaw : 2;

  let attempt = 0;
  let currentInit = buildInitialInit(init, { agentPassportHeaderName, agentPassportHeaderValue });
  let lastResponse = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    const res = await fetchImpl(url, currentInit);
    lastResponse = res;
    if (res.status !== 402) return res;

    if (onChallenge) {
      try {
        onChallenge(buildX402ChallengeMetadata(res, { gateHeaderName }));
      } catch {
        // Ignore callback failures to keep autopay deterministic.
      }
    }
    if (attempt >= maxAttempts) return res;

    const gateIdRaw = res.headers.get(gateHeaderName);
    const gateId = typeof gateIdRaw === "string" ? gateIdRaw.trim() : "";
    if (!gateId) return res;

    const nextInit = buildRetryInit(currentInit, { gateHeaderName, gateId, agentPassportHeaderName, agentPassportHeaderValue });
    currentInit = nextInit;
  }

  return lastResponse;
}
