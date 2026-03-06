import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PolicyEngine } from '../policy/engine.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeBearer(token) {
  if (!token) return null;
  const raw = String(token).trim();
  if (!raw) return null;
  return /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

function normalizeCapabilityName(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return null;
  if (typeof value.capabilityId === 'string' && value.capabilityId.trim()) return value.capabilityId.trim();
  if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  if (typeof value.id === 'string' && value.id.trim()) return value.id.trim();
  return null;
}

function sanitizeIdSegment(value, fallback = 'x') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return fallback;
  return normalized.slice(0, 80);
}

function buildDeterministicBidId({ rfqId, agentId }) {
  return `bid_${sanitizeIdSegment(rfqId, 'rfq')}_${sanitizeIdSegment(agentId, 'agent')}`;
}

function normalizeBidDraft(rawDraft, rfq, agentId) {
  if (!rawDraft || typeof rawDraft !== 'object' || Array.isArray(rawDraft)) {
    throw new Error('bid handler must return an object');
  }

  const amountCents = Number(rawDraft.amountCents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error('bid.amountCents must be a positive safe integer');
  }

  const rfqCurrency = typeof rfq?.currency === 'string' && rfq.currency.trim() ? rfq.currency.trim().toUpperCase() : 'USD';
  const currency = typeof rawDraft.currency === 'string' && rawDraft.currency.trim() ? rawDraft.currency.trim().toUpperCase() : rfqCurrency;
  if (!currency) throw new Error('bid.currency must be a non-empty string');
  if (currency !== rfqCurrency) {
    throw new Error('bid.currency must match rfq currency');
  }

  let etaSeconds = null;
  if (rawDraft.etaSeconds !== null && rawDraft.etaSeconds !== undefined && rawDraft.etaSeconds !== '') {
    const parsedEta = Number(rawDraft.etaSeconds);
    if (!Number.isSafeInteger(parsedEta) || parsedEta <= 0) {
      throw new Error('bid.etaSeconds must be a positive safe integer');
    }
    etaSeconds = parsedEta;
  }

  const bidId =
    typeof rawDraft.bidId === 'string' && rawDraft.bidId.trim()
      ? rawDraft.bidId.trim()
      : buildDeterministicBidId({ rfqId: rfq?.rfqId, agentId });
  const note = typeof rawDraft.note === 'string' && rawDraft.note.trim() ? rawDraft.note.trim() : null;
  const metadata =
    rawDraft.metadata === null || rawDraft.metadata === undefined
      ? null
      : rawDraft.metadata && typeof rawDraft.metadata === 'object' && !Array.isArray(rawDraft.metadata)
        ? rawDraft.metadata
        : (() => {
            throw new Error('bid.metadata must be an object or null');
          })();

  return {
    bidId,
    bidderAgentId: agentId,
    amountCents,
    currency,
    etaSeconds,
    note,
    metadata,
    verificationMethod: rawDraft.verificationMethod ?? undefined,
    policy: rawDraft.policy ?? undefined,
    policyRef: rawDraft.policyRef ?? undefined,
    fromType: rawDraft.fromType ?? undefined,
    toType: rawDraft.toType ?? undefined
  };
}

function sortRfqs(rfqs = []) {
  return [...rfqs].sort((left, right) => {
    const leftAt = Date.parse(String(left?.createdAt ?? ''));
    const rightAt = Date.parse(String(right?.createdAt ?? ''));
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && rightAt !== leftAt) return rightAt - leftAt;
    return String(left?.rfqId ?? '').localeCompare(String(right?.rfqId ?? ''));
  });
}

export class AgentDaemon {
  constructor({
    baseUrl = process.env.NOOTERRA_BASE_URL ?? 'http://127.0.0.1:3000',
    protocol = process.env.NOOTERRA_PROTOCOL ?? '1.0',
    tenantId = process.env.NOOTERRA_TENANT_ID ?? null,
    apiKey = process.env.NOOTERRA_API_KEY ?? null,
    opsToken = process.env.NOOTERRA_OPS_TOKEN ?? null,
    bearerToken = process.env.NOOTERRA_BEARER_TOKEN ?? null,
    agentId,
    pollMs = 1500,
    log = console
  } = {}) {
    if (!agentId) throw new Error('agentId is required');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.protocol = protocol;
    this.tenantId = tenantId;
    this.apiKey = apiKey;
    this.opsToken = opsToken;
    this.bearerToken = normalizeBearer(bearerToken);
    this.agentId = agentId;
    this.pollMs = Math.max(250, Number(pollMs) || 1500);
    this.log = log;

    this._running = false;
    this._timer = null;
    this._inflight = new Set();
    this._inflightRfqs = new Set();
    this._resetStopPromise();

    this.policyEngine = new PolicyEngine({ defaults: { action: 'allow' }, rules: [] });
    this.handlerModule = null;
    this.handlerPath = null;
    this.policyPath = null;
  }

  _resetStopPromise() {
    this._stopPromise = new Promise((resolve) => {
      this._resolveStop = resolve;
    });
  }

  headers({ write = false, idempotencyKey = null } = {}) {
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-nooterra-protocol': this.protocol
    };
    if (this.tenantId) headers['x-proxy-tenant-id'] = this.tenantId;
    if (this.apiKey) headers['x-proxy-api-key'] = this.apiKey;
    if (this.opsToken) headers['x-proxy-ops-token'] = this.opsToken;
    if (this.bearerToken) headers.authorization = this.bearerToken;
    if (write && idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;
    return headers;
  }

  async loadHandlerModule(filePath) {
    const abs = path.resolve(filePath);
    const mod = await import(pathToFileURL(abs).href + `?t=${Date.now()}`);
    const handlerModule = mod?.default ?? mod;

    if (!handlerModule || typeof handlerModule !== 'object') {
      throw new Error('handler module must export an object');
    }
    if (typeof handlerModule.handle !== 'function') {
      throw new Error('handler module must export handle(workOrder, context)');
    }

    this.handlerModule = handlerModule;
    this.handlerPath = abs;
    return handlerModule;
  }

  async loadPolicyFile(policyPath) {
    const abs = path.resolve(policyPath);
    this.policyEngine = await PolicyEngine.fromFile(abs);
    this.policyPath = abs;
    return this.policyEngine;
  }

  async reload({ reloadHandler = true, reloadPolicy = true } = {}) {
    if (reloadHandler && this.handlerPath) {
      await this.loadHandlerModule(this.handlerPath);
    }
    if (reloadPolicy && this.policyPath) {
      await this.loadPolicyFile(this.policyPath);
    }
    this.log.info(`[agentverse] reloaded handler=${reloadHandler} policy=${reloadPolicy}`);
  }

  async requestJson(pathname, { method = 'GET', body = null, write = false, idempotencyKey = null } = {}) {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: this.headers({ write, idempotencyKey }),
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const msg = json?.error || json?.message || `request failed: ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.payload = json;
      throw err;
    }

    return json;
  }

  async listPendingWorkOrders() {
    const query = new URLSearchParams({
      subAgentId: this.agentId,
      status: 'created',
      limit: '100',
      offset: '0'
    });
    const payload = await this.requestJson(`/work-orders?${query.toString()}`);
    return Array.isArray(payload?.workOrders) ? payload.workOrders : [];
  }

  async acceptWorkOrder(workOrder) {
    const workOrderId = workOrder?.workOrderId || workOrder?.id;
    if (!workOrderId) throw new Error('missing workOrderId');

    return this.requestJson(`/work-orders/${encodeURIComponent(workOrderId)}/accept`, {
      method: 'POST',
      write: true,
      idempotencyKey: `accept_${workOrderId}`,
      body: {
        acceptedByAgentId: this.agentId,
        acceptedAt: nowIso()
      }
    });
  }

  async completeWorkOrder(workOrder, result) {
    const workOrderId = workOrder?.workOrderId || workOrder?.id;
    if (!workOrderId) throw new Error('missing workOrderId');

    const isFailure = Boolean(result?.error);
    const status = isFailure ? 'failed' : 'success';
    const receiptId = `rcpt_${randomUUID().replace(/-/g, '')}`;

    return this.requestJson(`/work-orders/${encodeURIComponent(workOrderId)}/complete`, {
      method: 'POST',
      write: true,
      idempotencyKey: `complete_${workOrderId}`,
      body: {
        receiptId,
        status,
        outputs: isFailure ? { error: String(result.error) } : (result?.output ?? result ?? {}),
        metrics: result?.metrics ?? {},
        evidenceRefs: Array.isArray(result?.evidenceRefs) ? result.evidenceRefs : [],
        deliveredAt: nowIso(),
        completedAt: nowIso(),
        metadata: {
          source: 'agentverse-daemon',
          agentId: this.agentId
        }
      }
    });
  }

  evaluatePolicy(workOrder) {
    const decision = this.policyEngine.evaluate({
      requiredCapability: workOrder?.requiredCapability,
      amountUsdCents: Number(workOrder?.pricing?.amountCents ?? 0),
      principalAgentId: workOrder?.principalAgentId,
      subAgentId: workOrder?.subAgentId
    });
    return decision;
  }

  resolveCapabilities() {
    const rawCapabilities = Array.isArray(this.handlerModule?.capabilities) ? this.handlerModule.capabilities : [];
    const normalized = new Set();
    for (const capability of rawCapabilities) {
      const name = normalizeCapabilityName(capability);
      if (name) normalized.add(name);
    }
    return Array.from(normalized.values()).sort((left, right) => left.localeCompare(right));
  }

  resolveBidHandler() {
    if (typeof this.handlerModule?.bid === 'function') return this.handlerModule.bid.bind(this.handlerModule);
    if (typeof this.handlerModule?.marketplace?.bid === 'function') return this.handlerModule.marketplace.bid.bind(this.handlerModule.marketplace);
    return null;
  }

  async listOpenRfqs() {
    const capabilities = this.resolveCapabilities();
    const rfqMap = new Map();
    const fetchPages = capabilities.length > 0 ? capabilities : [null];

    for (const capability of fetchPages) {
      const query = new URLSearchParams({
        status: 'open',
        limit: '100',
        offset: '0'
      });
      if (capability) query.set('capability', capability);
      const payload = await this.requestJson(`/marketplace/rfqs?${query.toString()}`);
      const rows = Array.isArray(payload?.rfqs) ? payload.rfqs : [];
      for (const row of rows) {
        const rfqId = typeof row?.rfqId === 'string' && row.rfqId.trim() ? row.rfqId.trim() : null;
        if (!rfqId || rfqMap.has(rfqId)) continue;
        rfqMap.set(rfqId, row);
      }
    }

    return sortRfqs(Array.from(rfqMap.values()));
  }

  async listOwnBids(rfq) {
    const rfqId = rfq?.rfqId;
    if (!rfqId) return [];
    const query = new URLSearchParams({
      status: 'all',
      bidderAgentId: this.agentId,
      limit: '100',
      offset: '0'
    });
    const payload = await this.requestJson(`/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids?${query.toString()}`);
    return Array.isArray(payload?.bids) ? payload.bids : [];
  }

  evaluateBidPolicy(rfq) {
    return this.policyEngine.evaluate({
      mode: 'marketplace_bid',
      agentId: this.agentId,
      bidderAgentId: this.agentId,
      requiredCapability: rfq?.capability ?? null,
      amountUsdCents: Number(rfq?.budgetCents ?? 0),
      principalAgentId: rfq?.posterAgentId ?? null,
      rfq: {
        rfqId: rfq?.rfqId ?? null,
        capability: rfq?.capability ?? null,
        budgetCents: rfq?.budgetCents ?? null,
        currency: rfq?.currency ?? null,
        posterAgentId: rfq?.posterAgentId ?? null,
        deadlineAt: rfq?.deadlineAt ?? null,
        metadata: rfq?.metadata ?? null
      }
    });
  }

  shouldBidOnRfq(rfq) {
    const rfqId = typeof rfq?.rfqId === 'string' ? rfq.rfqId.trim() : '';
    if (!rfqId) return false;
    if (String(rfq?.status ?? 'open').toLowerCase() !== 'open') return false;
    if (String(rfq?.posterAgentId ?? '') === this.agentId) return false;

    const capabilities = this.resolveCapabilities();
    if (capabilities.length > 0) {
      const requiredCapability = typeof rfq?.capability === 'string' ? rfq.capability.trim() : '';
      if (requiredCapability && !capabilities.includes(requiredCapability)) return false;
    }

    const candidateAgentIds = Array.isArray(rfq?.metadata?.routerLaunch?.candidateAgentIds)
      ? rfq.metadata.routerLaunch.candidateAgentIds
          .map((entry) => (typeof entry === 'string' && entry.trim() ? entry.trim() : null))
          .filter(Boolean)
      : [];
    if (candidateAgentIds.length > 0 && !candidateAgentIds.includes(this.agentId)) return false;

    return true;
  }

  async submitBid(rfq, draft) {
    const rfqId = rfq?.rfqId;
    if (!rfqId) throw new Error('missing rfqId');
    const bid = normalizeBidDraft(draft, rfq, this.agentId);
    return this.requestJson(`/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`, {
      method: 'POST',
      write: true,
      idempotencyKey: `bid_${bid.bidId}`,
      body: bid
    });
  }

  async processRfq(rfq) {
    const rfqId = rfq?.rfqId;
    if (!rfqId) return;
    if (this._inflightRfqs.has(rfqId)) return;

    const bidHandler = this.resolveBidHandler();
    if (typeof bidHandler !== 'function') return;
    if (!this.shouldBidOnRfq(rfq)) return;

    this._inflightRfqs.add(rfqId);
    try {
      const existingBids = await this.listOwnBids(rfq);
      if (existingBids.length > 0) return;

      const decision = this.evaluateBidPolicy(rfq);
      if (!decision.allowed) {
        this.log.info(`[agentverse] skipped bid for ${rfqId}: ${decision.reason}`);
        return;
      }

      const context = {
        agentId: this.agentId,
        mode: 'marketplace_bid',
        log: (...args) => this.log.info('[agentverse]', ...args),
        policyDecision: decision
      };
      const draft = await bidHandler(rfq, context);
      if (draft === null || draft === undefined || draft === false) return;

      const submitted = await this.submitBid(rfq, draft);
      const bidId = submitted?.bid?.bidId ?? draft?.bidId ?? null;
      this.log.info(`[agentverse] submitted bid ${bidId ?? 'n/a'} for rfq ${rfqId}`);
    } catch (err) {
      this.log.error(`[agentverse] failed bid for rfq ${rfqId}: ${err.message}`);
    } finally {
      this._inflightRfqs.delete(rfqId);
    }
  }

  async processWorkOrder(workOrder) {
    const id = workOrder?.workOrderId || workOrder?.id;
    if (!id) return;
    if (this._inflight.has(id)) return;

    this._inflight.add(id);
    try {
      const decision = this.evaluatePolicy(workOrder);
      if (!decision.allowed) {
        await this.completeWorkOrder(workOrder, {
          error: `policy_${decision.action}: ${decision.reason}`,
          metrics: { matchedRules: decision.matchedRules ?? [] }
        });
        return;
      }

      await this.acceptWorkOrder(workOrder);

      const context = {
        agentId: this.agentId,
        log: (...args) => this.log.info('[agentverse]', ...args)
      };

      const handler = this.handlerModule?.handle;
      if (typeof handler !== 'function') {
        throw new Error('handler function not loaded');
      }

      const result = await handler(workOrder, context);
      await this.completeWorkOrder(workOrder, result);
      this.log.info(`[agentverse] completed work order ${id}`);
    } catch (err) {
      this.log.error(`[agentverse] failed work order ${id}: ${err.message}`);
      try {
        await this.completeWorkOrder(workOrder, { error: err.message });
      } catch {
        // fail-closed: if completion fails we still keep daemon alive, error already logged
      }
    } finally {
      this._inflight.delete(id);
    }
  }

  async tick() {
    const [workOrdersResult, rfqsResult] = await Promise.allSettled([
      this.listPendingWorkOrders(),
      this.resolveBidHandler() ? this.listOpenRfqs() : Promise.resolve([])
    ]);

    if (workOrdersResult.status === 'fulfilled') {
      for (const workOrder of workOrdersResult.value) {
        // Fire and forget per order, tracked by _inflight
        void this.processWorkOrder(workOrder);
      }
    } else {
      this.log.error(`[agentverse] work-order poll error: ${workOrdersResult.reason?.message ?? workOrdersResult.reason}`);
    }

    if (rfqsResult.status === 'fulfilled') {
      for (const rfq of rfqsResult.value) {
        void this.processRfq(rfq);
      }
    } else {
      this.log.error(`[agentverse] rfq poll error: ${rfqsResult.reason?.message ?? rfqsResult.reason}`);
    }
  }

  async start() {
    if (this._running) return;
    if (!this._resolveStop) this._resetStopPromise();
    this._running = true;
    this.log.info(`[agentverse] daemon started for agentId=${this.agentId}`);

    const loop = async () => {
      if (!this._running) return;
      try {
        await this.tick();
      } catch (err) {
        this.log.error(`[agentverse] tick error: ${err.message}`);
      } finally {
        if (this._running) {
          this._timer = setTimeout(loop, this.pollMs);
        }
      }
    };

    await loop();
  }

  async stop() {
    if (!this._running && !this._timer) return;
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._resolveStop) {
      this._resolveStop();
      this._resolveStop = null;
    }
    this.log.info('[agentverse] daemon stopped');
  }

  async waitForStop() {
    return this._stopPromise;
  }
}
