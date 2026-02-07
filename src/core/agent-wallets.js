export const AGENT_WALLET_SCHEMA_VERSION = "AgentWallet.v1";
export const AGENT_RUN_SETTLEMENT_SCHEMA_VERSION = "AgentRunSettlement.v1";
export const DEFAULT_AGENT_WALLET_CURRENCY = "USD";

export const AGENT_RUN_SETTLEMENT_STATUS = Object.freeze({
  LOCKED: "locked",
  RELEASED: "released",
  REFUNDED: "refunded"
});

export const AGENT_RUN_SETTLEMENT_DISPUTE_STATUS = Object.freeze({
  NONE: "none",
  OPEN: "open",
  CLOSED: "closed"
});

export const AGENT_RUN_SETTLEMENT_DISPUTE_KIND = Object.freeze({
  QUALITY: "quality",
  DELIVERY: "delivery",
  FRAUD: "fraud",
  POLICY: "policy",
  PAYMENT: "payment",
  OTHER: "other"
});

export const AGENT_RUN_SETTLEMENT_DISPUTE_PRIORITY = Object.freeze({
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
  CRITICAL: "critical"
});

export const AGENT_RUN_SETTLEMENT_DISPUTE_CHANNEL = Object.freeze({
  COUNTERPARTY: "counterparty",
  POLICY_ENGINE: "policy_engine",
  ARBITER: "arbiter",
  EXTERNAL: "external"
});

export const AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL = Object.freeze({
  L1_COUNTERPARTY: "l1_counterparty",
  L2_ARBITER: "l2_arbiter",
  L3_EXTERNAL: "l3_external"
});

export const AGENT_RUN_SETTLEMENT_DISPUTE_RESOLUTION_OUTCOME = Object.freeze({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  PARTIAL: "partial",
  WITHDRAWN: "withdrawn",
  UNRESOLVED: "unresolved"
});

export const AGENT_RUN_SETTLEMENT_DECISION_STATUS = Object.freeze({
  PENDING: "pending",
  AUTO_RESOLVED: "auto_resolved",
  MANUAL_REVIEW_REQUIRED: "manual_review_required",
  MANUAL_RESOLVED: "manual_resolved"
});

export const AGENT_RUN_SETTLEMENT_DECISION_MODE = Object.freeze({
  AUTOMATIC: "automatic",
  MANUAL_REVIEW: "manual-review"
});

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertAmountCents(value, name, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  const min = allowZero ? 0 : 1;
  if (value < min) throw new TypeError(`${name} must be >= ${min}`);
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO date string`);
}

function normalizeEnumValue(value, name, allowedValues) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!allowedValues.includes(normalized)) {
    throw new TypeError(`${name} must be one of: ${allowedValues.join("|")}`);
  }
  return normalized;
}

function normalizeDisputeEvidenceRefs(value, name) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const out = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.trim() === "") {
      throw new TypeError(`${name}[${index}] must be a non-empty string`);
    }
    const normalized = item.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeDisputeContext(disputeContext, { name = "settlement.disputeContext", defaultEscalationLevel = null } = {}) {
  if (disputeContext === null || disputeContext === undefined) return null;
  assertPlainObject(disputeContext, name);
  const kind = normalizeEnumValue(
    disputeContext.type ?? AGENT_RUN_SETTLEMENT_DISPUTE_KIND.OTHER,
    `${name}.type`,
    Object.values(AGENT_RUN_SETTLEMENT_DISPUTE_KIND)
  );
  const priority = normalizeEnumValue(
    disputeContext.priority ?? AGENT_RUN_SETTLEMENT_DISPUTE_PRIORITY.NORMAL,
    `${name}.priority`,
    Object.values(AGENT_RUN_SETTLEMENT_DISPUTE_PRIORITY)
  );
  const channel = normalizeEnumValue(
    disputeContext.channel ?? AGENT_RUN_SETTLEMENT_DISPUTE_CHANNEL.COUNTERPARTY,
    `${name}.channel`,
    Object.values(AGENT_RUN_SETTLEMENT_DISPUTE_CHANNEL)
  );
  const escalationLevel = normalizeEnumValue(
    disputeContext.escalationLevel ??
      defaultEscalationLevel ??
      AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL.L1_COUNTERPARTY,
    `${name}.escalationLevel`,
    Object.values(AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL)
  );
  const openedByAgentId =
    disputeContext.openedByAgentId === null || disputeContext.openedByAgentId === undefined
      ? null
      : String(disputeContext.openedByAgentId).trim();
  if (openedByAgentId !== null && openedByAgentId === "") {
    throw new TypeError(`${name}.openedByAgentId must be a non-empty string when provided`);
  }
  const reason =
    disputeContext.reason === null || disputeContext.reason === undefined ? null : String(disputeContext.reason).trim();
  if (reason !== null && reason === "") {
    throw new TypeError(`${name}.reason must be a non-empty string when provided`);
  }
  const evidenceRefs = normalizeDisputeEvidenceRefs(disputeContext.evidenceRefs, `${name}.evidenceRefs`);
  return {
    type: kind,
    priority,
    channel,
    escalationLevel,
    openedByAgentId,
    reason,
    evidenceRefs
  };
}

function normalizeDisputeResolution(disputeResolution, { name = "settlement.disputeResolution", defaultClosedAt = null } = {}) {
  if (disputeResolution === null || disputeResolution === undefined) return null;
  assertPlainObject(disputeResolution, name);
  const outcome = normalizeEnumValue(
    disputeResolution.outcome ?? AGENT_RUN_SETTLEMENT_DISPUTE_RESOLUTION_OUTCOME.UNRESOLVED,
    `${name}.outcome`,
    Object.values(AGENT_RUN_SETTLEMENT_DISPUTE_RESOLUTION_OUTCOME)
  );
  const escalationLevel = normalizeEnumValue(
    disputeResolution.escalationLevel ?? AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL.L1_COUNTERPARTY,
    `${name}.escalationLevel`,
    Object.values(AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL)
  );
  const closedByAgentId =
    disputeResolution.closedByAgentId === null || disputeResolution.closedByAgentId === undefined
      ? null
      : String(disputeResolution.closedByAgentId).trim();
  if (closedByAgentId !== null && closedByAgentId === "") {
    throw new TypeError(`${name}.closedByAgentId must be a non-empty string when provided`);
  }
  const summary =
    disputeResolution.summary === null || disputeResolution.summary === undefined ? null : String(disputeResolution.summary).trim();
  if (summary !== null && summary === "") {
    throw new TypeError(`${name}.summary must be a non-empty string when provided`);
  }
  const closedAtRaw = disputeResolution.closedAt ?? defaultClosedAt ?? null;
  const closedAt = closedAtRaw === null || closedAtRaw === undefined ? null : String(closedAtRaw).trim();
  if (closedAt !== null) assertIsoDate(closedAt, `${name}.closedAt`);
  const evidenceRefs = normalizeDisputeEvidenceRefs(disputeResolution.evidenceRefs, `${name}.evidenceRefs`);
  return {
    outcome,
    escalationLevel,
    closedByAgentId,
    summary,
    closedAt,
    evidenceRefs
  };
}

function normalizeCurrency(currency) {
  const raw = typeof currency === "string" && currency.trim() !== "" ? currency : DEFAULT_AGENT_WALLET_CURRENCY;
  const normalized = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(normalized)) throw new TypeError("currency must match ^[A-Z][A-Z0-9_]{2,11}$");
  return normalized;
}

function normalizeWalletRecord(wallet) {
  assertPlainObject(wallet, "wallet");
  assertNonEmptyString(wallet.schemaVersion, "wallet.schemaVersion");
  if (wallet.schemaVersion !== AGENT_WALLET_SCHEMA_VERSION) throw new TypeError(`wallet.schemaVersion must be ${AGENT_WALLET_SCHEMA_VERSION}`);
  assertNonEmptyString(wallet.walletId, "wallet.walletId");
  assertNonEmptyString(wallet.agentId, "wallet.agentId");
  assertNonEmptyString(wallet.tenantId, "wallet.tenantId");
  const currency = normalizeCurrency(wallet.currency);
  const availableCents = Number(wallet.availableCents ?? 0);
  const escrowLockedCents = Number(wallet.escrowLockedCents ?? 0);
  const totalDebitedCents = Number(wallet.totalDebitedCents ?? 0);
  const totalCreditedCents = Number(wallet.totalCreditedCents ?? 0);
  assertAmountCents(availableCents, "wallet.availableCents", { allowZero: true });
  assertAmountCents(escrowLockedCents, "wallet.escrowLockedCents", { allowZero: true });
  assertAmountCents(totalDebitedCents, "wallet.totalDebitedCents", { allowZero: true });
  assertAmountCents(totalCreditedCents, "wallet.totalCreditedCents", { allowZero: true });
  if (!Number.isSafeInteger(wallet.revision ?? 0) || Number(wallet.revision ?? 0) < 0) {
    throw new TypeError("wallet.revision must be a non-negative safe integer");
  }
  assertIsoDate(wallet.createdAt, "wallet.createdAt");
  assertIsoDate(wallet.updatedAt, "wallet.updatedAt");
  return {
    schemaVersion: AGENT_WALLET_SCHEMA_VERSION,
    walletId: String(wallet.walletId),
    agentId: String(wallet.agentId),
    tenantId: String(wallet.tenantId),
    currency,
    availableCents,
    escrowLockedCents,
    totalDebitedCents,
    totalCreditedCents,
    revision: Number(wallet.revision ?? 0),
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt
  };
}

export function createAgentWallet({ tenantId, agentId, currency = DEFAULT_AGENT_WALLET_CURRENCY, at }) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(agentId, "agentId");
  const timestamp = at ?? new Date().toISOString();
  assertIsoDate(timestamp, "at");
  return {
    schemaVersion: AGENT_WALLET_SCHEMA_VERSION,
    walletId: `wallet_${String(agentId)}`,
    tenantId: String(tenantId),
    agentId: String(agentId),
    currency: normalizeCurrency(currency),
    availableCents: 0,
    escrowLockedCents: 0,
    totalDebitedCents: 0,
    totalCreditedCents: 0,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function ensureAgentWallet({ wallet, tenantId, agentId, currency = DEFAULT_AGENT_WALLET_CURRENCY, at }) {
  if (!wallet) return createAgentWallet({ tenantId, agentId, currency, at });
  const normalized = normalizeWalletRecord(wallet);
  if (normalized.tenantId !== String(tenantId)) throw new TypeError("wallet.tenantId must match tenantId");
  if (normalized.agentId !== String(agentId)) throw new TypeError("wallet.agentId must match agentId");
  if (normalized.currency !== normalizeCurrency(currency)) throw new TypeError("wallet.currency must match requested currency");
  return normalized;
}

function withWalletUpdate(wallet, updater, { at }) {
  const base = normalizeWalletRecord(wallet);
  const next = updater(base);
  assertPlainObject(next, "wallet update");
  return normalizeWalletRecord({
    ...base,
    ...next,
    revision: base.revision + 1,
    updatedAt: at
  });
}

export function creditAgentWallet({ wallet, amountCents, at = new Date().toISOString() }) {
  assertIsoDate(at, "at");
  assertAmountCents(amountCents, "amountCents");
  return withWalletUpdate(
    wallet,
    (base) => ({
      availableCents: base.availableCents + amountCents,
      totalCreditedCents: base.totalCreditedCents + amountCents
    }),
    { at }
  );
}

export function lockAgentWalletEscrow({ wallet, amountCents, at = new Date().toISOString() }) {
  assertIsoDate(at, "at");
  assertAmountCents(amountCents, "amountCents");
  return withWalletUpdate(
    wallet,
    (base) => {
      if (base.availableCents < amountCents) {
        const err = new Error("insufficient wallet balance");
        err.code = "INSUFFICIENT_WALLET_BALANCE";
        throw err;
      }
      return {
        availableCents: base.availableCents - amountCents,
        escrowLockedCents: base.escrowLockedCents + amountCents
      };
    },
    { at }
  );
}

export function releaseAgentWalletEscrowToPayee({ payerWallet, payeeWallet, amountCents, at = new Date().toISOString() }) {
  assertIsoDate(at, "at");
  assertAmountCents(amountCents, "amountCents");
  const payer = withWalletUpdate(
    payerWallet,
    (base) => {
      if (base.escrowLockedCents < amountCents) {
        const err = new Error("insufficient escrow balance");
        err.code = "INSUFFICIENT_ESCROW_BALANCE";
        throw err;
      }
      return {
        escrowLockedCents: base.escrowLockedCents - amountCents,
        totalDebitedCents: base.totalDebitedCents + amountCents
      };
    },
    { at }
  );
  const payee = withWalletUpdate(
    payeeWallet,
    (base) => ({
      availableCents: base.availableCents + amountCents,
      totalCreditedCents: base.totalCreditedCents + amountCents
    }),
    { at }
  );
  return { payerWallet: payer, payeeWallet: payee };
}

export function refundAgentWalletEscrow({ wallet, amountCents, at = new Date().toISOString() }) {
  assertIsoDate(at, "at");
  assertAmountCents(amountCents, "amountCents");
  return withWalletUpdate(
    wallet,
    (base) => {
      if (base.escrowLockedCents < amountCents) {
        const err = new Error("insufficient escrow balance");
        err.code = "INSUFFICIENT_ESCROW_BALANCE";
        throw err;
      }
      return {
        escrowLockedCents: base.escrowLockedCents - amountCents,
        availableCents: base.availableCents + amountCents,
        totalCreditedCents: base.totalCreditedCents + amountCents
      };
    },
    { at }
  );
}

export function validateAgentRunSettlementRequest(payload) {
  assertPlainObject(payload, "settlement");
  assertNonEmptyString(payload.payerAgentId, "settlement.payerAgentId");
  const amountCents = Number(payload.amountCents);
  assertAmountCents(amountCents, "settlement.amountCents");
  const currency = normalizeCurrency(payload.currency ?? DEFAULT_AGENT_WALLET_CURRENCY);
  const disputeWindowDaysRaw = payload.disputeWindowDays;
  let disputeWindowDays = 0;
  if (disputeWindowDaysRaw !== undefined && disputeWindowDaysRaw !== null) {
    const parsed = Number(disputeWindowDaysRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new TypeError("settlement.disputeWindowDays must be a non-negative safe integer");
    }
    disputeWindowDays = parsed;
  }
  return { payerAgentId: String(payload.payerAgentId), amountCents, currency, disputeWindowDays };
}

function normalizeSettlementRecord(settlement) {
  assertPlainObject(settlement, "settlement");
  if (settlement.schemaVersion !== AGENT_RUN_SETTLEMENT_SCHEMA_VERSION) {
    throw new TypeError(`settlement.schemaVersion must be ${AGENT_RUN_SETTLEMENT_SCHEMA_VERSION}`);
  }
  assertNonEmptyString(settlement.settlementId, "settlement.settlementId");
  assertNonEmptyString(settlement.runId, "settlement.runId");
  assertNonEmptyString(settlement.tenantId, "settlement.tenantId");
  assertNonEmptyString(settlement.agentId, "settlement.agentId");
  assertNonEmptyString(settlement.payerAgentId, "settlement.payerAgentId");
  const amountCents = Number(settlement.amountCents);
  assertAmountCents(amountCents, "settlement.amountCents");
  const currency = normalizeCurrency(settlement.currency);
  const status = String(settlement.status ?? "").toLowerCase();
  if (!Object.values(AGENT_RUN_SETTLEMENT_STATUS).includes(status)) {
    throw new TypeError("settlement.status must be locked|released|refunded");
  }
  assertIsoDate(settlement.lockedAt, "settlement.lockedAt");
  if (settlement.resolvedAt !== null && settlement.resolvedAt !== undefined) assertIsoDate(settlement.resolvedAt, "settlement.resolvedAt");
  if (settlement.resolutionEventId !== null && settlement.resolutionEventId !== undefined) {
    assertNonEmptyString(settlement.resolutionEventId, "settlement.resolutionEventId");
  }
  if (settlement.runStatus !== null && settlement.runStatus !== undefined) {
    assertNonEmptyString(settlement.runStatus, "settlement.runStatus");
  }
  const releasedAmountCents = Number(settlement.releasedAmountCents ?? 0);
  const refundedAmountCents = Number(settlement.refundedAmountCents ?? 0);
  assertAmountCents(releasedAmountCents, "settlement.releasedAmountCents", { allowZero: true });
  assertAmountCents(refundedAmountCents, "settlement.refundedAmountCents", { allowZero: true });
  if (releasedAmountCents + refundedAmountCents > amountCents) {
    throw new TypeError("settlement released+refunded amounts exceed amountCents");
  }
  const releaseRatePctRaw = settlement.releaseRatePct;
  const releaseRatePct =
    releaseRatePctRaw === null || releaseRatePctRaw === undefined
      ? null
      : Number.isSafeInteger(Number(releaseRatePctRaw))
        ? Number(releaseRatePctRaw)
        : NaN;
  if (releaseRatePct !== null && (!Number.isSafeInteger(releaseRatePct) || releaseRatePct < 0 || releaseRatePct > 100)) {
    throw new TypeError("settlement.releaseRatePct must be an integer within 0..100");
  }
  const disputeWindowDays = Number(settlement.disputeWindowDays ?? 0);
  if (!Number.isSafeInteger(disputeWindowDays) || disputeWindowDays < 0) {
    throw new TypeError("settlement.disputeWindowDays must be a non-negative safe integer");
  }
  if (settlement.disputeWindowEndsAt !== null && settlement.disputeWindowEndsAt !== undefined) {
    assertIsoDate(settlement.disputeWindowEndsAt, "settlement.disputeWindowEndsAt");
  }
  const disputeStatus = String(settlement.disputeStatus ?? AGENT_RUN_SETTLEMENT_DISPUTE_STATUS.NONE).toLowerCase();
  if (!Object.values(AGENT_RUN_SETTLEMENT_DISPUTE_STATUS).includes(disputeStatus)) {
    throw new TypeError("settlement.disputeStatus must be none|open|closed");
  }
  if (settlement.disputeId !== null && settlement.disputeId !== undefined) {
    assertNonEmptyString(settlement.disputeId, "settlement.disputeId");
  }
  if (settlement.disputeOpenedAt !== null && settlement.disputeOpenedAt !== undefined) {
    assertIsoDate(settlement.disputeOpenedAt, "settlement.disputeOpenedAt");
  }
  if (settlement.disputeClosedAt !== null && settlement.disputeClosedAt !== undefined) {
    assertIsoDate(settlement.disputeClosedAt, "settlement.disputeClosedAt");
  }
  if (settlement.disputeVerdictId !== null && settlement.disputeVerdictId !== undefined) {
    assertNonEmptyString(settlement.disputeVerdictId, "settlement.disputeVerdictId");
  }
  if (settlement.disputeVerdictHash !== null && settlement.disputeVerdictHash !== undefined) {
    assertNonEmptyString(settlement.disputeVerdictHash, "settlement.disputeVerdictHash");
  }
  if (settlement.disputeVerdictArtifactId !== null && settlement.disputeVerdictArtifactId !== undefined) {
    assertNonEmptyString(settlement.disputeVerdictArtifactId, "settlement.disputeVerdictArtifactId");
  }
  if (settlement.disputeVerdictSignerKeyId !== null && settlement.disputeVerdictSignerKeyId !== undefined) {
    assertNonEmptyString(settlement.disputeVerdictSignerKeyId, "settlement.disputeVerdictSignerKeyId");
  }
  if (settlement.disputeVerdictIssuedAt !== null && settlement.disputeVerdictIssuedAt !== undefined) {
    assertIsoDate(settlement.disputeVerdictIssuedAt, "settlement.disputeVerdictIssuedAt");
  }
  const disputeContext = normalizeDisputeContext(settlement.disputeContext, {
    name: "settlement.disputeContext"
  });
  const disputeResolution = normalizeDisputeResolution(settlement.disputeResolution, {
    name: "settlement.disputeResolution",
    defaultClosedAt: settlement.disputeClosedAt ?? null
  });
  const decisionStatus = String(settlement.decisionStatus ?? AGENT_RUN_SETTLEMENT_DECISION_STATUS.PENDING).toLowerCase();
  if (!Object.values(AGENT_RUN_SETTLEMENT_DECISION_STATUS).includes(decisionStatus)) {
    throw new TypeError("settlement.decisionStatus must be pending|auto_resolved|manual_review_required|manual_resolved");
  }
  const decisionMode = String(settlement.decisionMode ?? AGENT_RUN_SETTLEMENT_DECISION_MODE.AUTOMATIC).toLowerCase();
  if (!Object.values(AGENT_RUN_SETTLEMENT_DECISION_MODE).includes(decisionMode)) {
    throw new TypeError("settlement.decisionMode must be automatic|manual-review");
  }
  if (settlement.decisionPolicyHash !== null && settlement.decisionPolicyHash !== undefined) {
    assertNonEmptyString(settlement.decisionPolicyHash, "settlement.decisionPolicyHash");
  }
  if (settlement.decisionReason !== null && settlement.decisionReason !== undefined) {
    assertNonEmptyString(settlement.decisionReason, "settlement.decisionReason");
  }
  if (settlement.decisionTrace !== null && settlement.decisionTrace !== undefined) {
    assertPlainObject(settlement.decisionTrace, "settlement.decisionTrace");
  }
  if (settlement.decisionUpdatedAt !== null && settlement.decisionUpdatedAt !== undefined) {
    assertIsoDate(settlement.decisionUpdatedAt, "settlement.decisionUpdatedAt");
  }
  if (!Number.isSafeInteger(settlement.revision ?? 0) || Number(settlement.revision ?? 0) < 0) {
    throw new TypeError("settlement.revision must be a non-negative safe integer");
  }
  assertIsoDate(settlement.createdAt, "settlement.createdAt");
  assertIsoDate(settlement.updatedAt, "settlement.updatedAt");
  return {
    schemaVersion: AGENT_RUN_SETTLEMENT_SCHEMA_VERSION,
    settlementId: String(settlement.settlementId),
    runId: String(settlement.runId),
    tenantId: String(settlement.tenantId),
    agentId: String(settlement.agentId),
    payerAgentId: String(settlement.payerAgentId),
    amountCents,
    currency,
    status,
    lockedAt: settlement.lockedAt,
    resolvedAt: settlement.resolvedAt ?? null,
    resolutionEventId: settlement.resolutionEventId ?? null,
    runStatus: settlement.runStatus ?? null,
    releasedAmountCents,
    refundedAmountCents,
    releaseRatePct,
    disputeWindowDays,
    disputeWindowEndsAt: settlement.disputeWindowEndsAt ?? null,
    disputeStatus,
    disputeId: settlement.disputeId ?? null,
    disputeOpenedAt: settlement.disputeOpenedAt ?? null,
    disputeClosedAt: settlement.disputeClosedAt ?? null,
    disputeVerdictId: settlement.disputeVerdictId ?? null,
    disputeVerdictHash: settlement.disputeVerdictHash ?? null,
    disputeVerdictArtifactId: settlement.disputeVerdictArtifactId ?? null,
    disputeVerdictSignerKeyId: settlement.disputeVerdictSignerKeyId ?? null,
    disputeVerdictIssuedAt: settlement.disputeVerdictIssuedAt ?? null,
    disputeContext,
    disputeResolution,
    decisionStatus,
    decisionMode,
    decisionPolicyHash: settlement.decisionPolicyHash ?? null,
    decisionReason: settlement.decisionReason ?? null,
    decisionTrace: settlement.decisionTrace ?? null,
    decisionUpdatedAt: settlement.decisionUpdatedAt ?? null,
    revision: Number(settlement.revision ?? 0),
    createdAt: settlement.createdAt,
    updatedAt: settlement.updatedAt
  };
}

export function createAgentRunSettlement({
  tenantId,
  runId,
  agentId,
  payerAgentId,
  amountCents,
  currency,
  disputeWindowDays = 0,
  at = new Date().toISOString()
}) {
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(runId, "runId");
  assertNonEmptyString(agentId, "agentId");
  assertNonEmptyString(payerAgentId, "payerAgentId");
  assertAmountCents(amountCents, "amountCents");
  if (!Number.isSafeInteger(Number(disputeWindowDays)) || Number(disputeWindowDays) < 0) {
    throw new TypeError("disputeWindowDays must be a non-negative safe integer");
  }
  assertIsoDate(at, "at");
  return normalizeSettlementRecord({
    schemaVersion: AGENT_RUN_SETTLEMENT_SCHEMA_VERSION,
    settlementId: `setl_${String(runId)}`,
    runId: String(runId),
    tenantId: String(tenantId),
    agentId: String(agentId),
    payerAgentId: String(payerAgentId),
    amountCents,
    currency: normalizeCurrency(currency),
    status: AGENT_RUN_SETTLEMENT_STATUS.LOCKED,
    lockedAt: at,
    resolvedAt: null,
    resolutionEventId: null,
    runStatus: null,
    releasedAmountCents: 0,
    refundedAmountCents: 0,
    releaseRatePct: null,
    disputeWindowDays: Number(disputeWindowDays),
    disputeWindowEndsAt: null,
    disputeStatus: AGENT_RUN_SETTLEMENT_DISPUTE_STATUS.NONE,
    disputeId: null,
    disputeOpenedAt: null,
    disputeClosedAt: null,
    disputeVerdictId: null,
    disputeVerdictHash: null,
    disputeVerdictArtifactId: null,
    disputeVerdictSignerKeyId: null,
    disputeVerdictIssuedAt: null,
    disputeContext: null,
    disputeResolution: null,
    decisionStatus: AGENT_RUN_SETTLEMENT_DECISION_STATUS.PENDING,
    decisionMode: AGENT_RUN_SETTLEMENT_DECISION_MODE.AUTOMATIC,
    decisionPolicyHash: null,
    decisionReason: null,
    decisionTrace: null,
    decisionUpdatedAt: at,
    revision: 0,
    createdAt: at,
    updatedAt: at
  });
}

export function resolveAgentRunSettlement({
  settlement,
  status,
  runStatus,
  releasedAmountCents = null,
  refundedAmountCents = null,
  releaseRatePct = null,
  disputeWindowDays = null,
  decisionStatus = AGENT_RUN_SETTLEMENT_DECISION_STATUS.AUTO_RESOLVED,
  decisionMode = AGENT_RUN_SETTLEMENT_DECISION_MODE.AUTOMATIC,
  decisionPolicyHash = null,
  decisionReason = null,
  decisionTrace = null,
  resolutionEventId = null,
  at = new Date().toISOString()
}) {
  const current = normalizeSettlementRecord(settlement);
  const nextStatus = String(status ?? "").toLowerCase();
  if (nextStatus !== AGENT_RUN_SETTLEMENT_STATUS.RELEASED && nextStatus !== AGENT_RUN_SETTLEMENT_STATUS.REFUNDED) {
    throw new TypeError("status must be released|refunded");
  }
  if (current.status !== AGENT_RUN_SETTLEMENT_STATUS.LOCKED) throw new TypeError("settlement already resolved");
  assertNonEmptyString(runStatus, "runStatus");
  assertIsoDate(at, "at");
  if (resolutionEventId !== null && resolutionEventId !== undefined) assertNonEmptyString(resolutionEventId, "resolutionEventId");
  let nextReleasedAmountCents = releasedAmountCents === null || releasedAmountCents === undefined ? null : Number(releasedAmountCents);
  let nextRefundedAmountCents = refundedAmountCents === null || refundedAmountCents === undefined ? null : Number(refundedAmountCents);
  if (nextStatus === AGENT_RUN_SETTLEMENT_STATUS.RELEASED) {
    if (nextReleasedAmountCents === null) nextReleasedAmountCents = current.amountCents;
    if (nextRefundedAmountCents === null) nextRefundedAmountCents = current.amountCents - nextReleasedAmountCents;
  } else {
    if (nextReleasedAmountCents === null) nextReleasedAmountCents = 0;
    if (nextRefundedAmountCents === null) nextRefundedAmountCents = current.amountCents;
  }
  assertAmountCents(nextReleasedAmountCents, "releasedAmountCents", { allowZero: true });
  assertAmountCents(nextRefundedAmountCents, "refundedAmountCents", { allowZero: true });
  if (nextReleasedAmountCents + nextRefundedAmountCents !== current.amountCents) {
    throw new TypeError("releasedAmountCents + refundedAmountCents must equal settlement.amountCents");
  }
  const nextReleaseRatePct =
    releaseRatePct === null || releaseRatePct === undefined
      ? current.amountCents > 0
        ? Math.round((nextReleasedAmountCents * 100) / current.amountCents)
        : 0
      : Number(releaseRatePct);
  if (!Number.isSafeInteger(nextReleaseRatePct) || nextReleaseRatePct < 0 || nextReleaseRatePct > 100) {
    throw new TypeError("releaseRatePct must be an integer within 0..100");
  }
  let nextDisputeWindowDays = disputeWindowDays === null || disputeWindowDays === undefined ? current.disputeWindowDays ?? 0 : Number(disputeWindowDays);
  if (!Number.isSafeInteger(nextDisputeWindowDays) || nextDisputeWindowDays < 0) {
    throw new TypeError("disputeWindowDays must be a non-negative safe integer");
  }
  let nextDisputeWindowEndsAt = null;
  if (nextDisputeWindowDays > 0) {
    const baseMs = Date.parse(at);
    const endMs = baseMs + nextDisputeWindowDays * 24 * 60 * 60_000;
    nextDisputeWindowEndsAt = new Date(endMs).toISOString();
  }
  const normalizedDecisionStatus = String(decisionStatus ?? AGENT_RUN_SETTLEMENT_DECISION_STATUS.AUTO_RESOLVED).toLowerCase();
  if (!Object.values(AGENT_RUN_SETTLEMENT_DECISION_STATUS).includes(normalizedDecisionStatus)) {
    throw new TypeError("decisionStatus must be pending|auto_resolved|manual_review_required|manual_resolved");
  }
  const normalizedDecisionMode = String(decisionMode ?? AGENT_RUN_SETTLEMENT_DECISION_MODE.AUTOMATIC).toLowerCase();
  if (!Object.values(AGENT_RUN_SETTLEMENT_DECISION_MODE).includes(normalizedDecisionMode)) {
    throw new TypeError("decisionMode must be automatic|manual-review");
  }
  const normalizedDecisionPolicyHash =
    decisionPolicyHash === null || decisionPolicyHash === undefined ? null : String(decisionPolicyHash).trim();
  if (normalizedDecisionPolicyHash !== null && normalizedDecisionPolicyHash === "") {
    throw new TypeError("decisionPolicyHash must be a non-empty string when provided");
  }
  const normalizedDecisionReason = decisionReason === null || decisionReason === undefined ? null : String(decisionReason).trim();
  if (normalizedDecisionReason !== null && normalizedDecisionReason === "") {
    throw new TypeError("decisionReason must be a non-empty string when provided");
  }
  if (decisionTrace !== null && decisionTrace !== undefined) {
    assertPlainObject(decisionTrace, "decisionTrace");
  }
  return normalizeSettlementRecord({
    ...current,
    status: nextStatus,
    runStatus: String(runStatus),
    releasedAmountCents: nextReleasedAmountCents,
    refundedAmountCents: nextRefundedAmountCents,
    releaseRatePct: nextReleaseRatePct,
    disputeWindowDays: nextDisputeWindowDays,
    disputeWindowEndsAt: nextDisputeWindowEndsAt,
    disputeStatus: AGENT_RUN_SETTLEMENT_DISPUTE_STATUS.NONE,
    disputeId: null,
    disputeOpenedAt: null,
    disputeClosedAt: null,
    disputeContext: null,
    disputeResolution: null,
    decisionStatus: normalizedDecisionStatus,
    decisionMode: normalizedDecisionMode,
    decisionPolicyHash: normalizedDecisionPolicyHash,
    decisionReason: normalizedDecisionReason,
    decisionTrace: decisionTrace ?? null,
    decisionUpdatedAt: at,
    resolvedAt: at,
    resolutionEventId: resolutionEventId ?? null,
    revision: current.revision + 1,
    updatedAt: at
  });
}

export function updateAgentRunSettlementDecision({
  settlement,
  decisionStatus = null,
  decisionMode = null,
  decisionPolicyHash = null,
  decisionReason = null,
  decisionTrace = null,
  at = new Date().toISOString()
}) {
  const current = normalizeSettlementRecord(settlement);
  if (current.status !== AGENT_RUN_SETTLEMENT_STATUS.LOCKED) {
    throw new TypeError("decision updates are only valid for locked settlements");
  }
  assertIsoDate(at, "at");
  const nextDecisionStatus =
    decisionStatus === null || decisionStatus === undefined
      ? current.decisionStatus
      : String(decisionStatus).toLowerCase();
  if (!Object.values(AGENT_RUN_SETTLEMENT_DECISION_STATUS).includes(nextDecisionStatus)) {
    throw new TypeError("decisionStatus must be pending|auto_resolved|manual_review_required|manual_resolved");
  }
  const nextDecisionMode =
    decisionMode === null || decisionMode === undefined
      ? current.decisionMode
      : String(decisionMode).toLowerCase();
  if (!Object.values(AGENT_RUN_SETTLEMENT_DECISION_MODE).includes(nextDecisionMode)) {
    throw new TypeError("decisionMode must be automatic|manual-review");
  }
  const nextDecisionPolicyHash =
    decisionPolicyHash === null || decisionPolicyHash === undefined
      ? current.decisionPolicyHash
      : String(decisionPolicyHash).trim();
  if (nextDecisionPolicyHash !== null && nextDecisionPolicyHash === "") {
    throw new TypeError("decisionPolicyHash must be a non-empty string when provided");
  }
  const nextDecisionReason =
    decisionReason === null || decisionReason === undefined
      ? current.decisionReason
      : String(decisionReason).trim();
  if (nextDecisionReason !== null && nextDecisionReason === "") {
    throw new TypeError("decisionReason must be a non-empty string when provided");
  }
  if (decisionTrace !== null && decisionTrace !== undefined) {
    assertPlainObject(decisionTrace, "decisionTrace");
  }
  return normalizeSettlementRecord({
    ...current,
    decisionStatus: nextDecisionStatus,
    decisionMode: nextDecisionMode,
    decisionPolicyHash: nextDecisionPolicyHash,
    decisionReason: nextDecisionReason,
    decisionTrace: decisionTrace ?? current.decisionTrace ?? null,
    decisionUpdatedAt: at,
    revision: current.revision + 1,
    updatedAt: at
  });
}

export function updateAgentRunSettlementDispute({
  settlement,
  action,
  disputeId = null,
  contextInput = null,
  resolutionInput = null,
  at = new Date().toISOString()
}) {
  const current = normalizeSettlementRecord(settlement);
  const nextAction = String(action ?? "").toLowerCase();
  assertIsoDate(at, "at");
  if (nextAction !== "open" && nextAction !== "close") throw new TypeError("action must be open|close");
  if (nextAction === "open") {
    if (current.disputeStatus === AGENT_RUN_SETTLEMENT_DISPUTE_STATUS.OPEN) {
      throw new TypeError("dispute is already open");
    }
    if (disputeId !== null && disputeId !== undefined) assertNonEmptyString(disputeId, "disputeId");
    const nextDisputeContext = normalizeDisputeContext(contextInput ?? {}, {
      name: "contextInput",
      defaultEscalationLevel: AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL.L1_COUNTERPARTY
    });
    return normalizeSettlementRecord({
      ...current,
      disputeStatus: AGENT_RUN_SETTLEMENT_DISPUTE_STATUS.OPEN,
      disputeId: disputeId ?? current.disputeId ?? `dsp_${current.runId}`,
      disputeOpenedAt: at,
      disputeClosedAt: null,
      disputeContext: nextDisputeContext,
      disputeResolution: null,
      revision: current.revision + 1,
      updatedAt: at
    });
  }
  if (current.disputeStatus !== AGENT_RUN_SETTLEMENT_DISPUTE_STATUS.OPEN) {
    throw new TypeError("dispute is not open");
  }
  if (disputeId !== null && disputeId !== undefined && String(disputeId) !== String(current.disputeId ?? "")) {
    throw new TypeError("disputeId does not match open dispute");
  }
  const nextDisputeResolution = normalizeDisputeResolution(
    resolutionInput ?? {},
    {
      name: "resolutionInput",
      defaultClosedAt: at
    }
  );
  return normalizeSettlementRecord({
    ...current,
    disputeStatus: AGENT_RUN_SETTLEMENT_DISPUTE_STATUS.CLOSED,
    disputeClosedAt: at,
    disputeResolution: nextDisputeResolution,
    revision: current.revision + 1,
    updatedAt: at
  });
}

export function patchAgentRunSettlementDisputeContext({
  settlement,
  contextPatch = null,
  appendEvidenceRefs = null,
  at = new Date().toISOString()
}) {
  const current = normalizeSettlementRecord(settlement);
  assertIsoDate(at, "at");
  if (current.disputeStatus !== AGENT_RUN_SETTLEMENT_DISPUTE_STATUS.OPEN) {
    throw new TypeError("dispute is not open");
  }
  const existingContext = normalizeDisputeContext(current.disputeContext ?? {}, {
    name: "settlement.disputeContext",
    defaultEscalationLevel: AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL.L1_COUNTERPARTY
  });
  let patch = {};
  if (contextPatch !== null && contextPatch !== undefined) {
    assertPlainObject(contextPatch, "contextPatch");
    patch = { ...contextPatch };
  }
  const mergedEvidenceRefs = [];
  const seenEvidenceRefs = new Set();
  const pushEvidenceRef = (value, sourceName, index = null) => {
    if (typeof value !== "string" || value.trim() === "") {
      const suffix = index === null ? "" : `[${index}]`;
      throw new TypeError(`${sourceName}${suffix} must be a non-empty string`);
    }
    const normalized = value.trim();
    if (seenEvidenceRefs.has(normalized)) return;
    seenEvidenceRefs.add(normalized);
    mergedEvidenceRefs.push(normalized);
  };
  const existingEvidenceRefs = Array.isArray(existingContext?.evidenceRefs) ? existingContext.evidenceRefs : [];
  for (let index = 0; index < existingEvidenceRefs.length; index += 1) {
    pushEvidenceRef(existingEvidenceRefs[index], "settlement.disputeContext.evidenceRefs", index);
  }
  const patchEvidenceRefs = contextPatch && Array.isArray(contextPatch.evidenceRefs) ? contextPatch.evidenceRefs : [];
  for (let index = 0; index < patchEvidenceRefs.length; index += 1) {
    pushEvidenceRef(patchEvidenceRefs[index], "contextPatch.evidenceRefs", index);
  }
  const appended = appendEvidenceRefs === null || appendEvidenceRefs === undefined ? [] : appendEvidenceRefs;
  if (!Array.isArray(appended)) throw new TypeError("appendEvidenceRefs must be an array when provided");
  for (let index = 0; index < appended.length; index += 1) {
    pushEvidenceRef(appended[index], "appendEvidenceRefs", index);
  }
  patch.evidenceRefs = mergedEvidenceRefs;
  const nextContext = normalizeDisputeContext(
    {
      ...existingContext,
      ...patch
    },
    {
      name: "contextPatch",
      defaultEscalationLevel: existingContext?.escalationLevel ?? AGENT_RUN_SETTLEMENT_DISPUTE_ESCALATION_LEVEL.L1_COUNTERPARTY
    }
  );
  return normalizeSettlementRecord({
    ...current,
    disputeContext: nextContext,
    revision: current.revision + 1,
    updatedAt: at
  });
}
