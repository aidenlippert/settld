import { createHash, sign as nodeSign } from "node:crypto";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertSha256Hex(value, name) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new TypeError(`${name} must be sha256 hex`);
  return raw;
}

function randomRequestId() {
  try {
    if (globalThis.crypto?.randomUUID) return String(globalThis.crypto.randomUUID());
  } catch {
    // ignore
  }
  return `req_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function normalizePrefix(value, fallback) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return fallback;
}

function canonicalize(value) {
  if (value === null) return null;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return value;
  if (valueType === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Unsupported number for canonical JSON: non-finite");
    if (Object.is(value, -0)) throw new TypeError("Unsupported number for canonical JSON: -0");
    return value;
  }
  if (valueType === "undefined") throw new TypeError("Unsupported value for canonical JSON: undefined");
  if (valueType === "bigint" || valueType === "function" || valueType === "symbol") {
    throw new TypeError(`Unsupported type for canonical JSON: ${valueType}`);
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (valueType === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("Unsupported object for canonical JSON: non-plain object");
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = canonicalize(value[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  throw new TypeError(`Unsupported value for canonical JSON: ${String(value)}`);
}

function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256HexUtf8(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function normalizeIsoDate(value, { fallbackNow = false, name = "timestamp" } = {}) {
  const raw =
    typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : fallbackNow
        ? new Date().toISOString()
        : null;
  if (!raw) throw new TypeError(`${name} is required`);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be an ISO date string`);
  return new Date(parsed).toISOString();
}

function asNonEmptyStringOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function assertReasonCode(value, name) {
  const raw = asNonEmptyStringOrNull(value);
  if (!raw) throw new TypeError(`${name} is required`);
  const normalized = String(raw).toUpperCase();
  if (!/^[A-Z0-9_]{2,64}$/.test(normalized)) throw new TypeError(`${name} must match ^[A-Z0-9_]{2,64}$`);
  return normalized;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headersToRecord(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[String(k).toLowerCase()] = String(v);
  return out;
}

export class SettldClient {
  constructor(opts) {
    assertNonEmptyString(opts?.baseUrl, "baseUrl");
    assertNonEmptyString(opts?.tenantId, "tenantId");
    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, "");
    this.tenantId = String(opts.tenantId);
    this.protocol = opts?.protocol ? String(opts.protocol) : "1.0";
    this.apiKey = opts?.apiKey ? String(opts.apiKey) : null;
    this.xApiKey = opts?.xApiKey ? String(opts.xApiKey) : null;
    this.opsToken = opts?.opsToken ? String(opts.opsToken) : null;
    this.fetchImpl = opts?.fetch ?? fetch;
    this.userAgent = opts?.userAgent ? String(opts.userAgent) : null;
  }

  async request(method, pathname, { body, requestId, idempotencyKey, expectedPrevChainHash, signal } = {}) {
    const url = new URL(pathname, this.baseUrl);
    const rid = requestId ?? randomRequestId();

    const headers = {
      "content-type": "application/json",
      "x-proxy-tenant-id": this.tenantId,
      "x-settld-protocol": this.protocol,
      "x-request-id": rid
    };
    if (this.userAgent) headers["user-agent"] = this.userAgent;
    if (idempotencyKey) headers["x-idempotency-key"] = String(idempotencyKey);
    if (expectedPrevChainHash) headers["x-proxy-expected-prev-chain-hash"] = String(expectedPrevChainHash);
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    if (this.xApiKey) headers["x-api-key"] = this.xApiKey;
    if (this.opsToken) headers["x-proxy-ops-token"] = this.opsToken;

    const res = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });

    const outHeaders = headersToRecord(res.headers);
    const responseRequestId = outHeaders["x-request-id"] ?? null;
    const parsed = await readJson(res);
    if (!res.ok) {
      const errBody = parsed && typeof parsed === "object" ? parsed : {};
      const e = {
        status: res.status,
        code: errBody?.code ?? null,
        message: errBody?.error ?? `request failed (${res.status})`,
        details: errBody?.details,
        requestId: responseRequestId
      };
      const thrown = new Error(e.message);
      thrown.settld = e;
      throw thrown;
    }

    return { ok: true, status: res.status, requestId: responseRequestId, body: parsed, headers: outHeaders };
  }

  capabilities(opts) {
    return this.request("GET", "/capabilities", opts);
  }

  openApi(opts) {
    return this.request("GET", "/openapi.json", opts);
  }

  createJob(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/jobs", { ...opts, body });
  }

  getJob(jobId, opts) {
    assertNonEmptyString(jobId, "jobId");
    return this.request("GET", `/jobs/${encodeURIComponent(jobId)}`, opts);
  }

  registerAgent(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.publicKeyPem, "body.publicKeyPem");
    return this.request("POST", "/agents/register", { ...opts, body });
  }

  listAgents(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.minTrustScore !== undefined && params.minTrustScore !== null) qs.set("minTrustScore", String(params.minTrustScore));
    if (params.includeReputation !== undefined && params.includeReputation !== null) qs.set("includeReputation", String(Boolean(params.includeReputation)));
    if (params.reputationVersion) qs.set("reputationVersion", String(params.reputationVersion));
    if (params.reputationWindow) qs.set("reputationWindow", String(params.reputationWindow));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/agents${suffix}`, opts);
  }

  getAgent(agentId, opts) {
    assertNonEmptyString(agentId, "agentId");
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}`, opts);
  }

  getAgentReputation(agentId, opts = {}) {
    assertNonEmptyString(agentId, "agentId");
    const qs = new URLSearchParams();
    if (opts.reputationVersion) qs.set("reputationVersion", String(opts.reputationVersion));
    if (opts.reputationWindow) qs.set("reputationWindow", String(opts.reputationWindow));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const { reputationVersion: _rVersion, reputationWindow: _rWindow, ...requestOpts } = opts ?? {};
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/reputation${suffix}`, requestOpts);
  }

  searchMarketplaceAgents(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.minTrustScore !== undefined && params.minTrustScore !== null) qs.set("minTrustScore", String(params.minTrustScore));
    if (params.riskTier) qs.set("riskTier", String(params.riskTier));
    if (params.includeReputation !== undefined && params.includeReputation !== null) qs.set("includeReputation", String(Boolean(params.includeReputation)));
    if (params.reputationVersion) qs.set("reputationVersion", String(params.reputationVersion));
    if (params.reputationWindow) qs.set("reputationWindow", String(params.reputationWindow));
    if (params.scoreStrategy) qs.set("scoreStrategy", String(params.scoreStrategy));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/agents/search${suffix}`, opts);
  }

  upsertMarketplaceSettlementPolicy(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/marketplace/settlement-policies", { ...opts, body });
  }

  listMarketplaceSettlementPolicies(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.policyId) qs.set("policyId", String(params.policyId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/settlement-policies${suffix}`, opts);
  }

  getMarketplaceSettlementPolicy(policyId, policyVersion, opts) {
    assertNonEmptyString(policyId, "policyId");
    if (!Number.isSafeInteger(Number(policyVersion)) || Number(policyVersion) <= 0) {
      throw new TypeError("policyVersion must be a positive safe integer");
    }
    return this.request(
      "GET",
      `/marketplace/settlement-policies/${encodeURIComponent(policyId)}/${encodeURIComponent(String(policyVersion))}`,
      opts
    );
  }

  createMarketplaceRfq(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/marketplace/rfqs", { ...opts, body });
  }

  listMarketplaceRfqs(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.posterAgentId) qs.set("posterAgentId", String(params.posterAgentId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/rfqs${suffix}`, opts);
  }

  submitMarketplaceBid(rfqId, body, opts) {
    assertNonEmptyString(rfqId, "rfqId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`, { ...opts, body });
  }

  listMarketplaceBids(rfqId, params = {}, opts) {
    assertNonEmptyString(rfqId, "rfqId");
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.bidderAgentId) qs.set("bidderAgentId", String(params.bidderAgentId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids${suffix}`, opts);
  }

  applyMarketplaceBidCounterOffer(rfqId, bidId, body, opts) {
    assertNonEmptyString(rfqId, "rfqId");
    assertNonEmptyString(bidId, "bidId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids/${encodeURIComponent(bidId)}/counter-offer`, {
      ...opts,
      body
    });
  }

  acceptMarketplaceBid(rfqId, body, opts) {
    assertNonEmptyString(rfqId, "rfqId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/marketplace/rfqs/${encodeURIComponent(rfqId)}/accept`, { ...opts, body });
  }

  getAgentWallet(agentId, opts) {
    assertNonEmptyString(agentId, "agentId");
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/wallet`, opts);
  }

  creditAgentWallet(agentId, body, opts) {
    assertNonEmptyString(agentId, "agentId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/wallet/credit`, { ...opts, body });
  }

  createAgentRun(agentId, body = {}, opts) {
    assertNonEmptyString(agentId, "agentId");
    if (!body || typeof body !== "object") throw new TypeError("body must be an object");
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/runs`, { ...opts, body });
  }

  listAgentRuns(agentId, params = {}, opts) {
    assertNonEmptyString(agentId, "agentId");
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/runs${suffix}`, opts);
  }

  getAgentRun(agentId, runId, opts) {
    assertNonEmptyString(agentId, "agentId");
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, opts);
  }

  listAgentRunEvents(agentId, runId, opts) {
    assertNonEmptyString(agentId, "agentId");
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/events`, opts);
  }

  appendAgentRunEvent(agentId, runId, body, opts) {
    assertNonEmptyString(agentId, "agentId");
    assertNonEmptyString(runId, "runId");
    if (!opts?.expectedPrevChainHash) throw new TypeError("expectedPrevChainHash is required for appendAgentRunEvent");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.type, "body.type");
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/events`, { ...opts, body });
  }

  getRunVerification(runId, opts) {
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/verification`, opts);
  }

  getRunSettlement(runId, opts) {
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/settlement`, opts);
  }

  getRunAgreement(runId, opts) {
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/agreement`, opts);
  }

  applyRunAgreementChangeOrder(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/agreement/change-order`, { ...opts, body });
  }

  cancelRunAgreement(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/agreement/cancel`, { ...opts, body });
  }

  getRunSettlementPolicyReplay(runId, opts) {
    assertNonEmptyString(runId, "runId");
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/settlement/policy-replay`, opts);
  }

  resolveRunSettlement(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/settlement/resolve`, { ...opts, body });
  }

  opsLockToolCallHold(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/ops/tool-calls/holds/lock", { ...opts, body });
  }

  opsListToolCallHolds(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.agreementHash) qs.set("agreementHash", String(params.agreementHash));
    if (params.status) qs.set("status", String(params.status));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/ops/tool-calls/holds${suffix}`, opts);
  }

  opsGetToolCallReplayEvaluate(agreementHash, opts) {
    assertSha256Hex(agreementHash, "agreementHash");
    return this.request("GET", `/ops/tool-calls/replay-evaluate?agreementHash=${encodeURIComponent(String(agreementHash).toLowerCase())}`, opts);
  }

  opsGetToolCallHold(holdHash, opts) {
    assertNonEmptyString(holdHash, "holdHash");
    return this.request("GET", `/ops/tool-calls/holds/${encodeURIComponent(holdHash)}`, opts);
  }

  opsGetReputationFacts(params = {}, opts) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agentId = asNonEmptyStringOrNull(params.agentId);
    if (!agentId) throw new TypeError("agentId is required");
    const qs = new URLSearchParams();
    qs.set("agentId", agentId);
    const toolId = asNonEmptyStringOrNull(params.toolId);
    if (toolId) qs.set("toolId", toolId);
    if (params.window !== undefined && params.window !== null) qs.set("window", String(params.window));
    const asOf = asNonEmptyStringOrNull(params.asOf);
    if (asOf) qs.set("asOf", asOf);
    if (params.includeEvents !== undefined && params.includeEvents !== null) qs.set("includeEvents", params.includeEvents ? "1" : "0");
    return this.request("GET", `/ops/reputation/facts?${qs.toString()}`, opts);
  }

  opsRunToolCallHoldbackMaintenance(body = {}, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body must be an object");
    return this.request("POST", "/ops/maintenance/tool-call-holdback/run", { ...opts, body });
  }

  toolCallListArbitrationCases(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.agreementHash) qs.set("agreementHash", String(params.agreementHash));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/tool-calls/arbitration/cases${suffix}`, opts);
  }

  toolCallGetArbitrationCase(caseId, opts) {
    assertNonEmptyString(caseId, "caseId");
    return this.request("GET", `/tool-calls/arbitration/cases/${encodeURIComponent(caseId)}`, opts);
  }

  toolCallOpenArbitration(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/tool-calls/arbitration/open", { ...opts, body });
  }

  toolCallSubmitArbitrationVerdict(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/tool-calls/arbitration/verdict", { ...opts, body });
  }

  opsGetSettlementAdjustment(adjustmentId, opts) {
    assertNonEmptyString(adjustmentId, "adjustmentId");
    return this.request("GET", `/ops/settlement-adjustments/${encodeURIComponent(adjustmentId)}`, opts);
  }

  getArtifact(artifactId, opts) {
    assertNonEmptyString(artifactId, "artifactId");
    return this.request("GET", `/artifacts/${encodeURIComponent(artifactId)}`, opts);
  }

  async getArtifacts(params = {}, opts) {
    const artifactIdsRaw = Array.isArray(params) ? params : params?.artifactIds;
    if (!Array.isArray(artifactIdsRaw) || artifactIdsRaw.length === 0) {
      throw new TypeError("artifactIds[] is required");
    }
    const artifactIds = artifactIdsRaw.map((id, idx) => {
      const raw = asNonEmptyStringOrNull(id);
      if (!raw) throw new TypeError(`artifactIds[${idx}] must be a non-empty string`);
      return raw;
    });
    const rows = await Promise.all(
      artifactIds.map(async (artifactId) => {
        const response = await this.getArtifact(artifactId, opts);
        return { artifactId, response };
      })
    );
    return {
      artifacts: rows.map((row) => ({ artifactId: row.artifactId, artifact: row.response?.body?.artifact ?? null })),
      responses: rows.map((row) => row.response)
    };
  }

  createAgreement(params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    assertNonEmptyString(params.toolId, "params.toolId");
    assertNonEmptyString(params.callId, "params.callId");
    const manifestHash = assertSha256Hex(params.manifestHash, "params.manifestHash");
    const createdAt = normalizeIsoDate(params.createdAt, { fallbackNow: true, name: "params.createdAt" });

    const inputCanonical = canonicalJsonStringify(params.input ?? {});
    const inputHash = sha256HexUtf8(inputCanonical);

    const agreementCore = canonicalize({
      schemaVersion: "ToolCallAgreement.v1",
      toolId: String(params.toolId),
      manifestHash,
      callId: String(params.callId),
      inputHash,
      acceptanceCriteria: params.acceptanceCriteria ?? null,
      settlementTerms: params.settlementTerms ?? null,
      payerAgentId: asNonEmptyStringOrNull(params.payerAgentId),
      payeeAgentId: asNonEmptyStringOrNull(params.payeeAgentId),
      createdAt
    });
    const agreementCanonical = canonicalJsonStringify(agreementCore);
    const agreementHash = sha256HexUtf8(agreementCanonical);
    const agreement = canonicalize({ ...agreementCore, agreementHash });
    return { agreement, agreementHash, inputHash, canonicalJson: canonicalJsonStringify(agreement) };
  }

  signEvidence(params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreement = params.agreement && typeof params.agreement === "object" && !Array.isArray(params.agreement) ? params.agreement : null;
    const agreementHash = assertSha256Hex(params.agreementHash ?? agreement?.agreementHash, "agreementHash");
    const callId = asNonEmptyStringOrNull(params.callId ?? agreement?.callId);
    const inputHash = assertSha256Hex(params.inputHash ?? agreement?.inputHash, "inputHash");
    if (!callId) throw new TypeError("callId is required");

    const startedAt = normalizeIsoDate(params.startedAt, { fallbackNow: true, name: "startedAt" });
    const completedAt = normalizeIsoDate(params.completedAt ?? startedAt, { fallbackNow: true, name: "completedAt" });
    const outputCanonical = canonicalJsonStringify(params.output ?? {});
    const outputHash = sha256HexUtf8(outputCanonical);

    const evidenceCore = canonicalize({
      schemaVersion: "ToolCallEvidence.v1",
      agreementHash,
      callId,
      inputHash,
      outputHash,
      outputRef: asNonEmptyStringOrNull(params.outputRef),
      metrics: params.metrics ?? null,
      startedAt,
      completedAt,
      createdAt: normalizeIsoDate(params.createdAt ?? completedAt, { fallbackNow: true, name: "createdAt" })
    });
    const evidenceHash = sha256HexUtf8(canonicalJsonStringify(evidenceCore));

    const signerPrivateKeyPem = asNonEmptyStringOrNull(params.signerPrivateKeyPem);
    const signerKeyId = asNonEmptyStringOrNull(params.signerKeyId);
    let signature = null;
    if (signerPrivateKeyPem) {
      if (!signerKeyId) throw new TypeError("signerKeyId is required when signerPrivateKeyPem is provided");
      const signatureBase64 = nodeSign(null, Buffer.from(evidenceHash, "hex"), signerPrivateKeyPem).toString("base64");
      signature = {
        algorithm: "ed25519",
        signerKeyId,
        evidenceHash,
        signature: signatureBase64
      };
    }

    const evidence = canonicalize({
      ...evidenceCore,
      evidenceHash,
      ...(signature ? { signature } : {})
    });
    return { evidence, evidenceHash, outputHash, canonicalJson: canonicalJsonStringify(evidence) };
  }

  createHold(params = {}, opts) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreement = params.agreement && typeof params.agreement === "object" && !Array.isArray(params.agreement) ? params.agreement : null;
    const agreementHash = assertSha256Hex(params.agreementHash ?? agreement?.agreementHash, "agreementHash");
    const receiptHash = assertSha256Hex(params.receiptHash, "receiptHash");
    const payerAgentId = asNonEmptyStringOrNull(params.payerAgentId);
    const payeeAgentId = asNonEmptyStringOrNull(params.payeeAgentId);
    if (!payerAgentId) throw new TypeError("payerAgentId is required");
    if (!payeeAgentId) throw new TypeError("payeeAgentId is required");
    if (payerAgentId === payeeAgentId) throw new TypeError("payerAgentId and payeeAgentId must differ");

    const amountCents = Number(params.amountCents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
    const holdbackBps = params.holdbackBps === undefined ? 0 : Number(params.holdbackBps);
    if (!Number.isSafeInteger(holdbackBps) || holdbackBps < 0 || holdbackBps > 10_000) {
      throw new TypeError("holdbackBps must be an integer within 0..10000");
    }
    const challengeWindowMs = params.challengeWindowMs === undefined ? 0 : Number(params.challengeWindowMs);
    if (!Number.isSafeInteger(challengeWindowMs) || challengeWindowMs < 0) {
      throw new TypeError("challengeWindowMs must be a non-negative safe integer");
    }

    return this.opsLockToolCallHold(
      {
        agreementHash,
        receiptHash,
        payerAgentId,
        payeeAgentId,
        amountCents,
        currency: asNonEmptyStringOrNull(params.currency) ?? "USD",
        holdbackBps,
        challengeWindowMs
      },
      opts
    );
  }

  async settle(params = {}, opts) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreement = params.agreement && typeof params.agreement === "object" && !Array.isArray(params.agreement) ? params.agreement : null;
    const evidence = params.evidence && typeof params.evidence === "object" && !Array.isArray(params.evidence) ? params.evidence : null;
    const agreementHash = assertSha256Hex(params.agreementHash ?? agreement?.agreementHash, "agreementHash");
    const evidenceHashRaw = params.evidenceHash ?? evidence?.evidenceHash ?? null;
    const evidenceHash = evidenceHashRaw ? assertSha256Hex(evidenceHashRaw, "evidenceHash") : null;

    const amountCents = Number(params.amountCents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
    const currency = asNonEmptyStringOrNull(params.currency) ?? "USD";
    const settledAt = normalizeIsoDate(params.settledAt, { fallbackNow: true, name: "settledAt" });
    const receiptRef = canonicalize({
      schemaVersion: "ToolCallSettlementReceiptRef.v1",
      agreementHash,
      evidenceHash,
      amountCents,
      currency,
      settledAt
    });
    const receiptHash = params.receiptHash
      ? assertSha256Hex(params.receiptHash, "receiptHash")
      : sha256HexUtf8(canonicalJsonStringify(receiptRef));

    const holdResponse = await this.createHold(
      {
        agreementHash,
        receiptHash,
        payerAgentId: params.payerAgentId,
        payeeAgentId: params.payeeAgentId,
        amountCents,
        currency,
        holdbackBps: params.holdbackBps,
        challengeWindowMs: params.challengeWindowMs
      },
      opts
    );

    return {
      agreementHash,
      receiptHash,
      receiptRef,
      hold: holdResponse?.body?.hold ?? null,
      holdResponse
    };
  }

  openDispute(params = {}, opts) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreementHash = assertSha256Hex(params.agreementHash, "agreementHash");
    const receiptHash = assertSha256Hex(params.receiptHash, "receiptHash");
    const holdHash = assertSha256Hex(params.holdHash, "holdHash");
    const arbiterAgentId = asNonEmptyStringOrNull(params.arbiterAgentId);
    const summary = asNonEmptyStringOrNull(params.summary);
    if (!arbiterAgentId) throw new TypeError("arbiterAgentId is required");
    if (!summary) throw new TypeError("summary is required");

    const evidenceRefs = Array.isArray(params.evidenceRefs) ? params.evidenceRefs.map((item) => String(item)) : [];
    const adminOverride = params.adminOverride && typeof params.adminOverride === "object" && !Array.isArray(params.adminOverride)
      ? params.adminOverride
      : null;
    const overrideEnabled = adminOverride?.enabled === true;

    const providedEnvelope =
      params.disputeOpenEnvelope && typeof params.disputeOpenEnvelope === "object" && !Array.isArray(params.disputeOpenEnvelope)
        ? params.disputeOpenEnvelope
        : null;
    const openedByAgentId =
      asNonEmptyStringOrNull(params.openedByAgentId) ?? asNonEmptyStringOrNull(providedEnvelope?.openedByAgentId);

    let disputeOpenEnvelope = providedEnvelope;
    if (!disputeOpenEnvelope && !overrideEnabled) {
      if (!openedByAgentId) throw new TypeError("openedByAgentId is required when disputeOpenEnvelope is not provided");
      disputeOpenEnvelope = this.buildDisputeOpenEnvelope({
        agreementHash,
        receiptHash,
        holdHash,
        openedByAgentId,
        signerKeyId: params.signerKeyId,
        signerPrivateKeyPem: params.signerPrivateKeyPem,
        signature: params.signature,
        caseId: params.caseId,
        envelopeId: params.envelopeId,
        reasonCode: params.reasonCode,
        nonce: params.nonce,
        openedAt: params.openedAt,
        tenantId: params.tenantId
      }).disputeOpenEnvelope;
    }

    return this.toolCallOpenArbitration(
      {
        agreementHash,
        receiptHash,
        holdHash,
        ...(openedByAgentId ? { openedByAgentId } : {}),
        ...(disputeOpenEnvelope ? { disputeOpenEnvelope } : {}),
        arbiterAgentId,
        summary,
        evidenceRefs,
        ...(adminOverride ? { adminOverride } : {})
      },
      opts
    );
  }

  buildDisputeOpenEnvelope(params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError("params must be an object");
    const agreementHash = assertSha256Hex(params.agreementHash, "agreementHash");
    const receiptHash = assertSha256Hex(params.receiptHash, "receiptHash");
    const holdHash = assertSha256Hex(params.holdHash, "holdHash");
    const openedByAgentId = asNonEmptyStringOrNull(params.openedByAgentId);
    if (!openedByAgentId) throw new TypeError("openedByAgentId is required");

    const caseId = asNonEmptyStringOrNull(params.caseId) ?? `arb_case_tc_${agreementHash}`;
    const envelopeId = asNonEmptyStringOrNull(params.envelopeId) ?? `dopen_tc_${agreementHash}`;
    const signerKeyId = asNonEmptyStringOrNull(params.signerKeyId);
    if (!signerKeyId) throw new TypeError("signerKeyId is required");
    const tenantId = asNonEmptyStringOrNull(params.tenantId) ?? this.tenantId;
    const openedAt = normalizeIsoDate(params.openedAt, { fallbackNow: true, name: "openedAt" });
    const reasonCode = assertReasonCode(params.reasonCode ?? "TOOL_CALL_DISPUTE", "reasonCode");
    const nonce = asNonEmptyStringOrNull(params.nonce) ?? `nonce_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;

    const core = canonicalize({
      schemaVersion: "DisputeOpenEnvelope.v1",
      artifactType: "DisputeOpenEnvelope.v1",
      artifactId: envelopeId,
      envelopeId,
      caseId,
      tenantId,
      agreementHash,
      receiptHash,
      holdHash,
      openedByAgentId,
      openedAt,
      reasonCode,
      nonce,
      signerKeyId
    });
    const envelopeHash = sha256HexUtf8(canonicalJsonStringify(core));
    let signature = asNonEmptyStringOrNull(params.signature);
    if (!signature) {
      const signerPrivateKeyPem = asNonEmptyStringOrNull(params.signerPrivateKeyPem);
      if (!signerPrivateKeyPem) throw new TypeError("signature or signerPrivateKeyPem is required");
      signature = nodeSign(null, Buffer.from(envelopeHash, "hex"), signerPrivateKeyPem).toString("base64");
    }
    const disputeOpenEnvelope = canonicalize({ ...core, envelopeHash, signature });
    return {
      disputeOpenEnvelope,
      envelopeHash,
      canonicalJson: canonicalJsonStringify(disputeOpenEnvelope)
    };
  }

  openRunDispute(runId, body = {}, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/dispute/open`, { ...opts, body });
  }

  closeRunDispute(runId, body = {}, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/dispute/close`, { ...opts, body });
  }

  submitRunDisputeEvidence(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    assertNonEmptyString(body?.evidenceRef, "body.evidenceRef");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/dispute/evidence`, { ...opts, body });
  }

  escalateRunDispute(runId, body, opts) {
    assertNonEmptyString(runId, "runId");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body is required");
    assertNonEmptyString(body?.escalationLevel, "body.escalationLevel");
    return this.request("POST", `/runs/${encodeURIComponent(runId)}/dispute/escalate`, { ...opts, body });
  }

  async firstVerifiedRun(params = {}, opts = {}) {
    if (!params || typeof params !== "object") throw new TypeError("params must be an object");
    if (!params?.payeeAgent || typeof params.payeeAgent !== "object") throw new TypeError("params.payeeAgent is required");
    assertNonEmptyString(params.payeeAgent?.publicKeyPem, "params.payeeAgent.publicKeyPem");

    const stepPrefix = normalizePrefix(
      opts.idempotencyPrefix,
      `sdk_first_verified_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    );
    const requestPrefix = normalizePrefix(opts.requestIdPrefix, randomRequestId());
    const makeStepOpts = (step, extra = {}) => ({
      signal: opts.signal,
      requestId: `${requestPrefix}_${step}`,
      idempotencyKey: `${stepPrefix}_${step}`,
      ...extra
    });

    const payeeRegistration = await this.registerAgent(params.payeeAgent, makeStepOpts("register_payee"));
    const payeeAgentId = payeeRegistration?.body?.agentIdentity?.agentId;
    assertNonEmptyString(payeeAgentId, "payeeAgentId");

    let payerRegistration = null;
    let payerCredit = null;
    let payerAgentId = null;
    if (params.payerAgent) {
      if (typeof params.payerAgent !== "object") throw new TypeError("params.payerAgent must be an object");
      assertNonEmptyString(params.payerAgent?.publicKeyPem, "params.payerAgent.publicKeyPem");
      payerRegistration = await this.registerAgent(params.payerAgent, makeStepOpts("register_payer"));
      payerAgentId = payerRegistration?.body?.agentIdentity?.agentId ?? null;
      assertNonEmptyString(payerAgentId, "payerAgentId");
    }

    const settlementAmountCents = params?.settlement?.amountCents;
    const settlementCurrency = params?.settlement?.currency ?? "USD";
    if ((settlementAmountCents !== undefined || params?.settlement?.payerAgentId) && !payerAgentId && !params?.settlement?.payerAgentId) {
      throw new TypeError("params.payerAgent or params.settlement.payerAgentId is required when settlement is requested");
    }

    if (params.payerCredit && typeof params.payerCredit !== "object") throw new TypeError("params.payerCredit must be an object");
    const payerCreditAmountCents = params?.payerCredit?.amountCents;
    if (payerCreditAmountCents !== undefined && payerCreditAmountCents !== null) {
      if (!Number.isFinite(payerCreditAmountCents) || payerCreditAmountCents <= 0) {
        throw new TypeError("params.payerCredit.amountCents must be a positive number");
      }
      if (!payerAgentId) throw new TypeError("params.payerAgent is required when params.payerCredit is provided");
      payerCredit = await this.creditAgentWallet(
        payerAgentId,
        {
          amountCents: Number(payerCreditAmountCents),
          currency: params?.payerCredit?.currency ?? settlementCurrency
        },
        makeStepOpts("credit_payer_wallet")
      );
    }

    const runBody = { ...(params.run ?? {}) };
    const settlementPayerAgentId = params?.settlement?.payerAgentId ?? payerAgentId;
    if (settlementAmountCents !== undefined && settlementAmountCents !== null) {
      if (!Number.isFinite(settlementAmountCents) || settlementAmountCents <= 0) {
        throw new TypeError("params.settlement.amountCents must be a positive number");
      }
      if (!settlementPayerAgentId) {
        throw new TypeError("params.settlement.payerAgentId or params.payerAgent is required when params.settlement.amountCents is set");
      }
      runBody.settlement = {
        payerAgentId: settlementPayerAgentId,
        amountCents: Number(settlementAmountCents),
        currency: settlementCurrency,
        ...(params?.settlement?.disputeWindowDays !== undefined ? { disputeWindowDays: params.settlement.disputeWindowDays } : {})
      };
    }

    const runCreated = await this.createAgentRun(payeeAgentId, runBody, makeStepOpts("create_run"));
    const runId = runCreated?.body?.run?.runId;
    assertNonEmptyString(runId, "runId");
    let prevChainHash = runCreated?.body?.run?.lastChainHash;
    assertNonEmptyString(prevChainHash, "runCreated.body.run.lastChainHash");

    const actor = params.actor ?? { type: "agent", id: payeeAgentId };
    const runStarted = await this.appendAgentRunEvent(
      payeeAgentId,
      runId,
      { type: "RUN_STARTED", actor, payload: params.startedPayload ?? { startedBy: "sdk.firstVerifiedRun" } },
      makeStepOpts("run_started", { expectedPrevChainHash: prevChainHash })
    );
    prevChainHash = runStarted?.body?.run?.lastChainHash;
    assertNonEmptyString(prevChainHash, "runStarted.body.run.lastChainHash");

    const evidenceRef = typeof params.evidenceRef === "string" && params.evidenceRef.trim() !== ""
      ? params.evidenceRef.trim()
      : `evidence://${runId}/output.json`;
    const runEvidenceAdded = await this.appendAgentRunEvent(
      payeeAgentId,
      runId,
      { type: "EVIDENCE_ADDED", actor, payload: params.evidencePayload ?? { evidenceRef } },
      makeStepOpts("evidence_added", { expectedPrevChainHash: prevChainHash })
    );
    prevChainHash = runEvidenceAdded?.body?.run?.lastChainHash;
    assertNonEmptyString(prevChainHash, "runEvidenceAdded.body.run.lastChainHash");

    const completedPayload = {
      outputRef: typeof params.outputRef === "string" && params.outputRef.trim() !== "" ? params.outputRef.trim() : evidenceRef,
      ...(params.completedPayload ?? {})
    };
    if (params.completedMetrics && typeof params.completedMetrics === "object") completedPayload.metrics = params.completedMetrics;
    const runCompleted = await this.appendAgentRunEvent(
      payeeAgentId,
      runId,
      { type: "RUN_COMPLETED", actor, payload: completedPayload },
      makeStepOpts("run_completed", { expectedPrevChainHash: prevChainHash })
    );

    const run = await this.getAgentRun(payeeAgentId, runId, makeStepOpts("get_run"));
    const verification = await this.getRunVerification(runId, makeStepOpts("get_verification"));

    let settlement = null;
    if (runBody.settlement || runCreated?.body?.settlement || runCompleted?.body?.settlement) {
      settlement = await this.getRunSettlement(runId, makeStepOpts("get_settlement"));
    }

    return {
      ids: { runId, payeeAgentId, payerAgentId },
      payeeRegistration,
      payerRegistration,
      payerCredit,
      runCreated,
      runStarted,
      runEvidenceAdded,
      runCompleted,
      run,
      verification,
      settlement
    };
  }

  quoteJob(jobId, body, opts) {
    assertNonEmptyString(jobId, "jobId");
    if (!opts?.expectedPrevChainHash) throw new TypeError("expectedPrevChainHash is required for quoteJob");
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/quote`, { ...opts, body });
  }

  bookJob(jobId, body, opts) {
    assertNonEmptyString(jobId, "jobId");
    if (!opts?.expectedPrevChainHash) throw new TypeError("expectedPrevChainHash is required for bookJob");
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/book`, { ...opts, body });
  }

  appendJobEvent(jobId, body, opts) {
    assertNonEmptyString(jobId, "jobId");
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/events`, { ...opts, body });
  }

  opsStatus(opts) {
    return this.request("GET", "/ops/status", opts);
  }

  listPartyStatements(params, opts) {
    assertNonEmptyString(params?.period, "period");
    const qs = new URLSearchParams({ period: String(params.period) });
    if (params.partyId) qs.set("partyId", String(params.partyId));
    if (params.status) qs.set("status", String(params.status));
    return this.request("GET", `/ops/party-statements?${qs.toString()}`, opts);
  }

  getPartyStatement(partyId, period, opts) {
    assertNonEmptyString(partyId, "partyId");
    assertNonEmptyString(period, "period");
    return this.request("GET", `/ops/party-statements/${encodeURIComponent(partyId)}/${encodeURIComponent(period)}`, opts);
  }

  enqueuePayout(partyId, period, opts) {
    assertNonEmptyString(partyId, "partyId");
    assertNonEmptyString(period, "period");
    return this.request("POST", `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(period)}/enqueue`, opts);
  }

  requestMonthClose(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    assertNonEmptyString(body?.month, "month");
    return this.request("POST", "/ops/month-close", { ...opts, body });
  }

  getTenantAnalytics(tenantId, params = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    const qs = new URLSearchParams();
    if (params.month) qs.set("month", String(params.month));
    if (params.bucket) qs.set("bucket", String(params.bucket));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/analytics${suffix}`, opts);
  }

  getTenantTrustGraph(tenantId, params = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    const qs = new URLSearchParams();
    if (params.month) qs.set("month", String(params.month));
    if (params.minRuns !== undefined && params.minRuns !== null) qs.set("minRuns", String(params.minRuns));
    if (params.maxEdges !== undefined && params.maxEdges !== null) qs.set("maxEdges", String(params.maxEdges));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph${suffix}`, opts);
  }

  listTenantTrustGraphSnapshots(tenantId, params = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    const qs = new URLSearchParams();
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph/snapshots${suffix}`, opts);
  }

  createTenantTrustGraphSnapshot(tenantId, body = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TypeError("body must be an object");
    return this.request("POST", `/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph/snapshots`, { ...opts, body });
  }

  diffTenantTrustGraph(tenantId, params = {}, opts) {
    assertNonEmptyString(tenantId, "tenantId");
    const qs = new URLSearchParams();
    if (params.baseMonth) qs.set("baseMonth", String(params.baseMonth));
    if (params.compareMonth) qs.set("compareMonth", String(params.compareMonth));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.minRuns !== undefined && params.minRuns !== null) qs.set("minRuns", String(params.minRuns));
    if (params.maxEdges !== undefined && params.maxEdges !== null) qs.set("maxEdges", String(params.maxEdges));
    if (params.includeUnchanged !== undefined && params.includeUnchanged !== null) qs.set("includeUnchanged", String(Boolean(params.includeUnchanged)));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph/diff${suffix}`, opts);
  }
}
