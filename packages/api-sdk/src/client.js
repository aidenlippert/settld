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
}

