function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
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

  createMarketplaceTask(body, opts) {
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", "/marketplace/tasks", { ...opts, body });
  }

  listMarketplaceTasks(params = {}, opts) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.capability) qs.set("capability", String(params.capability));
    if (params.posterAgentId) qs.set("posterAgentId", String(params.posterAgentId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/tasks${suffix}`, opts);
  }

  submitMarketplaceBid(taskId, body, opts) {
    assertNonEmptyString(taskId, "taskId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/marketplace/tasks/${encodeURIComponent(taskId)}/bids`, { ...opts, body });
  }

  listMarketplaceBids(taskId, params = {}, opts) {
    assertNonEmptyString(taskId, "taskId");
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", String(params.status));
    if (params.bidderAgentId) qs.set("bidderAgentId", String(params.bidderAgentId));
    if (params.limit !== undefined && params.limit !== null) qs.set("limit", String(params.limit));
    if (params.offset !== undefined && params.offset !== null) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/marketplace/tasks/${encodeURIComponent(taskId)}/bids${suffix}`, opts);
  }

  applyMarketplaceBidCounterOffer(taskId, bidId, body, opts) {
    assertNonEmptyString(taskId, "taskId");
    assertNonEmptyString(bidId, "bidId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/marketplace/tasks/${encodeURIComponent(taskId)}/bids/${encodeURIComponent(bidId)}/counter-offer`, {
      ...opts,
      body
    });
  }

  acceptMarketplaceBid(taskId, body, opts) {
    assertNonEmptyString(taskId, "taskId");
    if (!body || typeof body !== "object") throw new TypeError("body is required");
    return this.request("POST", `/marketplace/tasks/${encodeURIComponent(taskId)}/accept`, { ...opts, body });
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
