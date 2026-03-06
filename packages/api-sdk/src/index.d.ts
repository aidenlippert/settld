export type ProtocolVersion = `${number}.${number}`;

export type NooterraAutopayFetchOptions = {
  fetch?: typeof fetch;
  gateHeaderName?: string;
  maxAttempts?: number;
};

export type NooterraClientOptions = {
  baseUrl: string;
  tenantId: string;
  protocol?: ProtocolVersion;
  apiKey?: string;
  xApiKey?: string;
  opsToken?: string;
  fetch?: typeof fetch;
  userAgent?: string;
};

export type RequestOptions = {
  requestId?: string;
  idempotencyKey?: string;
  expectedPrevChainHash?: string;
  principalId?: string;
  signal?: AbortSignal;
};

export type X402ExecutionIntentErrorCode =
  | "X402_EXECUTION_INTENT_REQUIRED"
  | "X402_EXECUTION_INTENT_IDEMPOTENCY_MISMATCH"
  | "X402_EXECUTION_INTENT_CONFLICT"
  | "X402_EXECUTION_INTENT_HASH_MISMATCH"
  | "X402_EXECUTION_INTENT_INVALID"
  | "X402_EXECUTION_INTENT_TIME_INVALID"
  | "X402_EXECUTION_INTENT_TENANT_MISMATCH"
  | "X402_EXECUTION_INTENT_AGENT_MISMATCH"
  | "X402_EXECUTION_INTENT_SIDE_EFFECTING_REQUIRED"
  | "X402_EXECUTION_INTENT_REQUEST_BINDING_REQUIRED"
  | "X402_EXECUTION_INTENT_REQUEST_MISMATCH"
  | "X402_EXECUTION_INTENT_SPEND_LIMIT_EXCEEDED"
  | "X402_EXECUTION_INTENT_CURRENCY_MISMATCH"
  | "X402_EXECUTION_INTENT_RUN_MISMATCH"
  | "X402_EXECUTION_INTENT_AGREEMENT_MISMATCH"
  | "X402_EXECUTION_INTENT_QUOTE_MISMATCH"
  | "X402_EXECUTION_INTENT_POLICY_VERSION_MISMATCH"
  | "X402_EXECUTION_INTENT_POLICY_HASH_MISMATCH"
  | "X402_EXECUTION_INTENT_EXPIRES_AT_INVALID"
  | "X402_EXECUTION_INTENT_EXPIRED";

export type X402GateVerifyErrorCode =
  | "X402_INVALID_VERIFICATION_KEY_REF"
  | "X402_MISSING_REQUIRED_PROOF"
  | "X402_INVALID_CRYPTOGRAPHIC_PROOF"
  | "X402_SPEND_AUTH_POLICY_FINGERPRINT_MISMATCH"
  | "X402_REQUEST_BINDING_REQUIRED"
  | "X402_REQUEST_BINDING_EVIDENCE_REQUIRED"
  | "X402_REQUEST_BINDING_EVIDENCE_MISMATCH";

export type NooterraApiErrorCode = X402ExecutionIntentErrorCode | X402GateVerifyErrorCode | "SCHEMA_INVALID" | (string & {});

export type NooterraError = {
  status: number;
  code?: NooterraApiErrorCode | null;
  message: string;
  details?: unknown;
  requestId?: string | null;
};

export type NooterraResponse<T> = {
  ok: boolean;
  status: number;
  requestId: string | null;
  body: T;
  headers: Record<string, string>;
};

export type NooterraSseEvent<T = unknown> = {
  event: string;
  id: string | null;
  rawData: string;
  data: T | string | null;
};

export declare function fetchWithNooterraAutopay(
  url: string | URL,
  init?: RequestInit,
  opts?: NooterraAutopayFetchOptions
): Promise<Response>;

export declare function canonicalJsonStringifyDeterministic(value: unknown): string;
export declare function computeCanonicalSha256(value: unknown): string;
export declare function buildCanonicalEnvelope(value: unknown): { canonicalJson: string; sha256: string };

export type NooterraWebhookSignatureVerifyOptions = {
  toleranceSeconds?: number;
  timestamp?: string | number | null;
  nowMs?: number;
};

export type NooterraWebhookMiddlewareOptions = {
  toleranceSeconds?: number;
  signatureHeaderName?: string;
  timestampHeaderName?: string;
};

export type NooterraWebhookSecretResolver = string | ((req: unknown) => string | Promise<string>);

export declare class NooterraWebhookSignatureError extends Error {
  code: string;
}

export declare class NooterraWebhookSignatureHeaderError extends NooterraWebhookSignatureError {}

export declare class NooterraWebhookTimestampToleranceError extends NooterraWebhookSignatureError {
  timestamp: string | null;
  toleranceSeconds: number | null;
  nowMs: number | null;
}

export declare class NooterraWebhookNoMatchingSignatureError extends NooterraWebhookSignatureError {}

export declare function verifyNooterraWebhookSignature(
  rawBody: string | Uint8Array | ArrayBuffer,
  signatureHeader: string,
  secret: string,
  optionsOrTolerance?: number | NooterraWebhookSignatureVerifyOptions
): true;

export declare function verifyNooterraWebhook(
  secretOrResolver: NooterraWebhookSecretResolver,
  optionsOrTolerance?: number | NooterraWebhookMiddlewareOptions
): (req: any, res: any, next: (err?: unknown) => void) => void;

export type InteractionEntityType = "agent" | "human" | "robot" | "machine";

export type AgentIdentityV1 = {
  schemaVersion: "AgentIdentity.v1";
  agentId: string;
  tenantId: string;
  displayName: string;
  description?: string | null;
  status: "active" | "suspended" | "revoked";
  owner: { ownerType: "human" | "business" | "service"; ownerId: string };
  keys: { keyId: string; algorithm: "ed25519"; publicKeyPem: string };
  capabilities: string[];
  walletPolicy?: {
    maxPerTransactionCents?: number;
    maxDailyCents?: number;
    requireApprovalAboveCents?: number;
  } | null;
  metadata?: Record<string, unknown> | null;
  revision?: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentRunV1 = {
  schemaVersion: "AgentRun.v1";
  runId: string;
  agentId: string;
  tenantId: string;
  taskType?: string | null;
  inputRef?: string | null;
  status: "created" | "running" | "completed" | "failed";
  evidenceRefs?: string[];
  metrics?: Record<string, unknown> | null;
  failure?: { code?: string | null; message?: string | null } | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  lastEventId?: string | null;
  lastChainHash?: string | null;
  revision?: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentEventV1 = {
  schemaVersion: "AgentEvent.v1";
  v: 1;
  id: string;
  streamId: string;
  type: "RUN_CREATED" | "RUN_STARTED" | "RUN_HEARTBEAT" | "EVIDENCE_ADDED" | "RUN_COMPLETED" | "RUN_FAILED";
  at: string;
  actor: { type: string; id: string } & Record<string, unknown>;
  payload: Record<string, unknown>;
  payloadHash?: string | null;
  prevChainHash?: string | null;
  chainHash?: string | null;
  signature?: string | null;
  signerKeyId?: string | null;
};

export type AgentWalletV1 = {
  schemaVersion: "AgentWallet.v1";
  walletId: string;
  agentId: string;
  tenantId: string;
  currency: string;
  availableCents: number;
  escrowLockedCents: number;
  totalDebitedCents: number;
  totalCreditedCents: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type RunDisputeContextV1 = {
  type: "quality" | "delivery" | "fraud" | "policy" | "payment" | "other";
  priority: "low" | "normal" | "high" | "critical";
  channel: "counterparty" | "policy_engine" | "arbiter" | "external";
  escalationLevel: "l1_counterparty" | "l2_arbiter" | "l3_external";
  openedByAgentId?: string | null;
  reason?: string | null;
  evidenceRefs?: string[];
};

export type RunDisputeResolutionV1 = {
  outcome: "accepted" | "rejected" | "partial" | "withdrawn" | "unresolved";
  escalationLevel: "l1_counterparty" | "l2_arbiter" | "l3_external";
  closedByAgentId?: string | null;
  summary?: string | null;
  closedAt?: string | null;
  evidenceRefs?: string[];
};

export type RunDisputeEvidenceSubmissionV1 = {
  evidenceRef: string;
  submittedAt: string;
  submittedByAgentId?: string | null;
};

export type RunDisputeEscalationV1 = {
  previousEscalationLevel: "l1_counterparty" | "l2_arbiter" | "l3_external";
  escalationLevel: "l1_counterparty" | "l2_arbiter" | "l3_external";
  channel: "counterparty" | "policy_engine" | "arbiter" | "external";
  escalatedAt: string;
  escalatedByAgentId?: string | null;
};

export type AgentRunSettlementV1 = {
  schemaVersion: "AgentRunSettlement.v1";
  settlementId: string;
  runId: string;
  tenantId: string;
  agentId: string;
  payerAgentId: string;
  amountCents: number;
  currency: string;
  status: "locked" | "released" | "refunded";
  lockedAt: string;
  resolvedAt?: string | null;
  resolutionEventId?: string | null;
  runStatus?: string | null;
  releasedAmountCents?: number;
  refundedAmountCents?: number;
  releaseRatePct?: number | null;
  disputeWindowDays?: number;
  disputeWindowEndsAt?: string | null;
  disputeStatus?: "none" | "open" | "closed" | null;
  disputeId?: string | null;
  disputeOpenedAt?: string | null;
  disputeClosedAt?: string | null;
  disputeVerdictId?: string | null;
  disputeVerdictHash?: string | null;
  disputeVerdictArtifactId?: string | null;
  disputeVerdictSignerKeyId?: string | null;
  disputeVerdictIssuedAt?: string | null;
  disputeContext?: RunDisputeContextV1 | null;
  disputeResolution?: RunDisputeResolutionV1 | null;
  decisionStatus?: "pending" | "auto_resolved" | "manual_review_required" | "manual_resolved" | null;
  decisionMode?: "automatic" | "manual-review" | null;
  decisionPolicyHash?: string | null;
  decisionReason?: string | null;
  decisionTrace?: Record<string, unknown> | null;
  decisionUpdatedAt?: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentReputationV1 = {
  schemaVersion: "AgentReputation.v1";
  agentId: string;
  tenantId: string;
  trustScore: number;
  riskTier: "low" | "guarded" | "elevated" | "high";
  totalRuns: number;
  terminalRuns: number;
  createdRuns: number;
  runningRuns: number;
  completedRuns: number;
  failedRuns: number;
  runsWithEvidence: number;
  totalSettlements: number;
  lockedSettlements: number;
  releasedSettlements: number;
  refundedSettlements: number;
  runCompletionRatePct: number | null;
  evidenceCoverageRatePct: number | null;
  settlementReleaseRatePct: number | null;
  avgRunDurationMs: number | null;
  scoreBreakdown: {
    runQuality: number;
    settlementQuality: number;
    evidenceQuality: number;
    activityScore: number;
  };
  computedAt: string;
};

export type AgentReputationWindowV2 = {
  trustScore: number;
  riskTier: "low" | "guarded" | "elevated" | "high";
  totalRuns: number;
  terminalRuns: number;
  createdRuns: number;
  runningRuns: number;
  completedRuns: number;
  failedRuns: number;
  runsWithEvidence: number;
  totalSettlements: number;
  lockedSettlements: number;
  releasedSettlements: number;
  refundedSettlements: number;
  runCompletionRatePct: number | null;
  evidenceCoverageRatePct: number | null;
  settlementReleaseRatePct: number | null;
  avgRunDurationMs: number | null;
  scoreBreakdown: {
    runQuality: number;
    settlementQuality: number;
    evidenceQuality: number;
    activityScore: number;
  };
  computedAt: string;
};

export type AgentReputationV2 = {
  schemaVersion: "AgentReputation.v2";
  agentId: string;
  tenantId: string;
  primaryWindow: "7d" | "30d" | "allTime";
  trustScore: number;
  riskTier: "low" | "guarded" | "elevated" | "high";
  windows: {
    "7d": AgentReputationWindowV2;
    "30d": AgentReputationWindowV2;
    allTime: AgentReputationWindowV2;
  };
  computedAt: string;
};

export type AgentReputation = AgentReputationV1 | AgentReputationV2;

export type MarketplaceRfqV1 = {
  schemaVersion: "MarketplaceRfq.v1";
  rfqId: string;
  tenantId: string;
  title: string;
  description?: string | null;
  capability?: string | null;
  fromType?: InteractionEntityType;
  toType?: InteractionEntityType;
  posterAgentId?: string | null;
  status: "open" | "assigned" | "cancelled" | "closed";
  budgetCents?: number | null;
  currency: string;
  deadlineAt?: string | null;
  acceptedBidId?: string | null;
  acceptedBidderAgentId?: string | null;
  acceptedAt?: string | null;
  acceptedByAgentId?: string | null;
  counterOfferPolicy?: MarketplaceCounterOfferPolicyV1 | null;
  runId?: string | null;
  agreementId?: string | null;
  agreement?: Record<string, unknown> | null;
  settlementId?: string | null;
  settlementStatus?: "locked" | "released" | "refunded" | null;
  settlementResolvedAt?: string | null;
  settlementReleaseRatePct?: number | null;
  settlementDecisionStatus?: "pending" | "auto_resolved" | "manual_review_required" | "manual_resolved" | null;
  settlementDecisionReason?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type VerificationMethodV1 = {
  schemaVersion: "VerificationMethod.v1";
  mode: "deterministic" | "attested" | "discretionary";
  source?: string | null;
  attestor?: string | null;
  notes?: string | null;
};

export type SettlementPolicyV1 = {
  schemaVersion: "SettlementPolicy.v1";
  policyVersion: number;
  mode: "automatic" | "manual-review";
  policyHash: string;
  rules: {
    requireDeterministicVerification: boolean;
    autoReleaseOnGreen: boolean;
    autoReleaseOnAmber: boolean;
    autoReleaseOnRed: boolean;
    greenReleaseRatePct: number;
    amberReleaseRatePct: number;
    redReleaseRatePct: number;
    maxAutoReleaseAmountCents?: number | null;
    manualReason?: string | null;
  };
};

export type MarketplaceSettlementPolicyRefV1 = {
  schemaVersion: "MarketplaceSettlementPolicyRef.v1";
  source: "tenant_registry" | "inline";
  policyId?: string | null;
  policyVersion: number;
  policyHash: string;
  verificationMethodHash: string;
};

export type TenantSettlementPolicyV1 = {
  schemaVersion: "TenantSettlementPolicy.v1";
  tenantId: string;
  policyId: string;
  policyVersion: number;
  policyHash: string;
  verificationMethodHash: string;
  verificationMethod: VerificationMethodV1;
  policy: SettlementPolicyV1;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAgreementMilestoneV1 = {
  milestoneId: string;
  label?: string | null;
  releaseRatePct: number;
  statusGate: "green" | "amber" | "red" | "any";
  requiredEvidenceCount?: number | null;
};

export type MarketplaceAgreementCancellationV1 = {
  allowCancellationBeforeStart: boolean;
  killFeeRatePct: number;
  requireEvidenceOnCancellation: boolean;
};

export type MarketplaceAgreementChangeOrderPolicyV1 = {
  enabled: boolean;
  maxChangeOrders: number;
  requireCounterpartyAcceptance: boolean;
};

export type MarketplaceAgreementTermsV1 = {
  title?: string | null;
  capability?: string | null;
  deadlineAt?: string | null;
  etaSeconds?: number | null;
  milestones: MarketplaceAgreementMilestoneV1[];
  cancellation: MarketplaceAgreementCancellationV1;
  changeOrderPolicy: MarketplaceAgreementChangeOrderPolicyV1;
  changeOrders: Record<string, unknown>[];
};

export type MarketplaceAgreementTermsInput = {
  milestones?: Array<{
    milestoneId: string;
    label?: string;
    releaseRatePct: number;
    statusGate?: "green" | "amber" | "red" | "any";
    requiredEvidenceCount?: number;
  }>;
  cancellation?: {
    allowCancellationBeforeStart?: boolean;
    killFeeRatePct?: number;
    requireEvidenceOnCancellation?: boolean;
  };
  changeOrderPolicy?: {
    enabled?: boolean;
    maxChangeOrders?: number;
    requireCounterpartyAcceptance?: boolean;
  };
};

export type MarketplaceCounterOfferPolicyV1 = {
  schemaVersion: "MarketplaceCounterOfferPolicy.v1";
  allowPosterCounterOffers: boolean;
  allowBidderCounterOffers: boolean;
  maxRevisions: number;
  timeoutSeconds: number;
};

export type MarketplaceBidAcceptanceV1 = {
  schemaVersion: "MarketplaceBidAcceptance.v1";
  acceptedAt: string;
  acceptedByAgentId?: string | null;
  acceptedProposalId?: string | null;
  acceptedRevision?: number | null;
};

export type MarketplaceAgreementAcceptanceV1 = {
  schemaVersion: "MarketplaceAgreementAcceptance.v1";
  acceptedAt?: string | null;
  acceptedByAgentId?: string | null;
  acceptedProposalId?: string | null;
  acceptedRevision?: number | null;
  acceptedProposalHash?: string | null;
  offerChainHash?: string | null;
  proposalCount: number;
};

export type AgentDelegationLinkV1 = {
  schemaVersion: "AgentDelegationLink.v1";
  delegationId: string;
  tenantId: string;
  principalAgentId: string;
  delegateAgentId: string;
  scope?: string | null;
  issuedAt: string;
  expiresAt?: string | null;
  signerKeyId: string;
  delegationHash: string;
  signature: string;
};

export type AgentActingOnBehalfOfV1 = {
  schemaVersion: "AgentActingOnBehalfOf.v1";
  principalAgentId: string;
  delegateAgentId?: string | null;
  delegationChain: AgentDelegationLinkV1[];
  chainHash?: string | null;
};

export type MarketplaceAgreementAcceptanceSignatureV2 = {
  schemaVersion: "MarketplaceAgreementAcceptanceSignature.v2";
  agreementId: string;
  tenantId: string;
  rfqId: string;
  runId: string;
  bidId: string;
  acceptedByAgentId: string;
  acceptedProposalId?: string | null;
  acceptedRevision?: number | null;
  acceptedProposalHash?: string | null;
  offerChainHash?: string | null;
  proposalCount?: number | null;
  actingOnBehalfOfPrincipalAgentId?: string | null;
  actingOnBehalfOfDelegateAgentId?: string | null;
  actingOnBehalfOfChainHash?: string | null;
  signerAgentId: string;
  signerKeyId: string;
  signedAt: string;
  actingOnBehalfOf?: AgentActingOnBehalfOfV1 | null;
  acceptanceHash: string;
  signature: string;
};

export type MarketplaceAgreementAcceptanceSignatureInput = {
  signerAgentId?: string;
  signerKeyId: string;
  signedAt?: string;
  actingOnBehalfOf?: AgentActingOnBehalfOfV1;
  signature: string;
};

export type MarketplaceAgreementChangeOrderAcceptanceSignatureV2 = {
  schemaVersion: "MarketplaceAgreementChangeOrderAcceptanceSignature.v2";
  tenantId: string;
  runId: string;
  agreementId: string;
  rfqId: string;
  bidId: string;
  changeOrderId: string;
  requestedByAgentId: string;
  acceptedByAgentId: string;
  reason: string;
  note?: string | null;
  previousTermsHash?: string | null;
  milestonesHash: string;
  cancellationHash: string;
  actingOnBehalfOfPrincipalAgentId?: string | null;
  actingOnBehalfOfDelegateAgentId?: string | null;
  actingOnBehalfOfChainHash?: string | null;
  signerAgentId: string;
  signerKeyId: string;
  signedAt: string;
  actingOnBehalfOf?: AgentActingOnBehalfOfV1 | null;
  acceptanceHash: string;
  signature: string;
};

export type MarketplaceAgreementCancellationAcceptanceSignatureV2 = {
  schemaVersion: "MarketplaceAgreementCancellationAcceptanceSignature.v2";
  tenantId: string;
  runId: string;
  agreementId: string;
  rfqId: string;
  bidId: string;
  cancellationId: string;
  cancelledByAgentId: string;
  acceptedByAgentId: string;
  reason: string;
  evidenceRef?: string | null;
  termsHash: string;
  killFeeRatePct: number;
  actingOnBehalfOfPrincipalAgentId?: string | null;
  actingOnBehalfOfDelegateAgentId?: string | null;
  actingOnBehalfOfChainHash?: string | null;
  signerAgentId: string;
  signerKeyId: string;
  signedAt: string;
  actingOnBehalfOf?: AgentActingOnBehalfOfV1 | null;
  acceptanceHash: string;
  signature: string;
};

export type MarketplaceAgreementPolicyBindingV2 = {
  schemaVersion: "MarketplaceAgreementPolicyBinding.v2";
  agreementId: string;
  tenantId: string;
  rfqId: string;
  runId: string;
  bidId: string;
  acceptedAt?: string | null;
  acceptedByAgentId?: string | null;
  offerChainHash?: string | null;
  acceptedProposalId?: string | null;
  acceptedRevision?: number | null;
  acceptedProposalHash?: string | null;
  termsHash: string;
  policyHash: string;
  verificationMethodHash: string;
  policyRefHash: string;
  policyRef: MarketplaceSettlementPolicyRefV1;
  signerKeyId: string;
  signedAt: string;
  bindingHash: string;
  signature: string;
};

export type MarketplaceBidNegotiationProposalV1 = {
  schemaVersion: "MarketplaceBidProposal.v1";
  proposalId: string;
  bidId: string;
  revision: number;
  proposerAgentId: string;
  amountCents: number;
  currency: string;
  etaSeconds?: number | null;
  note?: string | null;
  verificationMethod: VerificationMethodV1;
  policy: SettlementPolicyV1;
  policyRef: MarketplaceSettlementPolicyRefV1;
  policyRefHash: string;
  prevProposalHash?: string | null;
  proposalHash: string;
  metadata?: Record<string, unknown> | null;
  proposedAt: string;
};

export type MarketplaceBidNegotiationV1 = {
  schemaVersion: "MarketplaceBidNegotiation.v1";
  bidId: string;
  state: "open" | "accepted" | "rejected" | "cancelled" | "expired";
  latestRevision: number;
  acceptedRevision?: number | null;
  acceptedProposalId?: string | null;
  acceptedAt?: string | null;
  acceptance?: MarketplaceBidAcceptanceV1 | null;
  counterOfferPolicy: MarketplaceCounterOfferPolicyV1;
  expiresAt?: string | null;
  expiredAt?: string | null;
  createdAt: string;
  updatedAt: string;
  proposals: MarketplaceBidNegotiationProposalV1[];
};

export type MarketplaceAgreementNegotiationV1 = {
  schemaVersion: "MarketplaceAgreementNegotiation.v1";
  state: "open" | "accepted" | "rejected" | "cancelled" | "expired";
  latestRevision: number;
  acceptedRevision?: number | null;
  acceptedProposalId?: string | null;
  proposalCount: number;
};

export type MarketplaceTaskAgreementV2 = {
  schemaVersion: "MarketplaceTaskAgreement.v2";
  agreementId: string;
  tenantId: string;
  rfqId: string;
  runId: string;
  bidId: string;
  payerAgentId: string;
  payeeAgentId: string;
  fromType: InteractionEntityType;
  toType: InteractionEntityType;
  amountCents: number;
  currency: string;
  acceptedAt: string;
  acceptedByAgentId?: string | null;
  disputeWindowDays: number;
  agreementRevision?: number | null;
  updatedAt?: string | null;
  offerChainHash?: string | null;
  acceptedProposalId?: string | null;
  acceptedRevision?: number | null;
  acceptedProposalHash?: string | null;
  negotiation?: MarketplaceAgreementNegotiationV1 | null;
  acceptance?: MarketplaceAgreementAcceptanceV1 | null;
  acceptanceSignature?: MarketplaceAgreementAcceptanceSignatureV2 | null;
  termsHash: string;
  verificationMethodHash: string;
  policyHash: string;
  policyRef: MarketplaceSettlementPolicyRefV1;
  policyBinding?: MarketplaceAgreementPolicyBindingV2 | null;
  verificationMethod?: VerificationMethodV1;
  policy?: SettlementPolicyV1;
  terms?: MarketplaceAgreementTermsV1;
};

export type MarketplaceBidV1 = {
  schemaVersion: "MarketplaceBid.v1";
  bidId: string;
  rfqId: string;
  tenantId: string;
  fromType?: InteractionEntityType;
  toType?: InteractionEntityType;
  bidderAgentId: string;
  amountCents: number;
  currency: string;
  etaSeconds?: number | null;
  note?: string | null;
  verificationMethod?: VerificationMethodV1;
  policy?: SettlementPolicyV1;
  policyRef?: MarketplaceSettlementPolicyRefV1 | null;
  status: "pending" | "accepted" | "rejected";
  acceptedAt?: string | null;
  rejectedAt?: string | null;
  negotiation?: MarketplaceBidNegotiationV1 | null;
  counterOfferPolicy?: MarketplaceCounterOfferPolicyV1 | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceRfqBidV1 = MarketplaceBidV1;

export type AgentRegistrationInput = {
  publicKeyPem: string;
  agentId?: string;
  displayName?: string;
  description?: string;
  status?: "active" | "suspended" | "revoked";
  ownerType?: "human" | "business" | "service";
  ownerId?: string;
  owner?: { ownerType?: "human" | "business" | "service"; ownerId?: string };
  capabilities?: string[];
  walletPolicy?: { maxPerTransactionCents?: number; maxDailyCents?: number; requireApprovalAboveCents?: number };
  metadata?: Record<string, unknown>;
};

export type FirstVerifiedRunParams = {
  payeeAgent: AgentRegistrationInput;
  payerAgent?: AgentRegistrationInput;
  payerCredit?: { amountCents: number; currency?: string };
  run?: {
    runId?: string;
    taskType?: string;
    inputRef?: string;
    settlement?: { payerAgentId: string; amountCents: number; currency?: string };
  };
  settlement?: { payerAgentId?: string; amountCents: number; currency?: string };
  actor?: Record<string, unknown>;
  startedPayload?: Record<string, unknown>;
  evidenceRef?: string;
  evidencePayload?: Record<string, unknown>;
  outputRef?: string;
  completedPayload?: Record<string, unknown>;
  completedMetrics?: Record<string, unknown>;
};

export type FirstVerifiedRunOptions = {
  signal?: AbortSignal;
  idempotencyPrefix?: string;
  requestIdPrefix?: string;
};

export type FirstVerifiedRunResult = {
  ids: { runId: string; payeeAgentId: string; payerAgentId: string | null };
  payeeRegistration: NooterraResponse<{ agentIdentity: AgentIdentityV1; keyId: string }>;
  payerRegistration: NooterraResponse<{ agentIdentity: AgentIdentityV1; keyId: string }> | null;
  payerCredit: NooterraResponse<{ wallet: AgentWalletV1 }> | null;
  runCreated: NooterraResponse<{ run: AgentRunV1; event: AgentEventV1; settlement?: AgentRunSettlementV1 | null }>;
  runStarted: NooterraResponse<{ event: AgentEventV1; run: AgentRunV1; settlement?: AgentRunSettlementV1 | null }>;
  runEvidenceAdded: NooterraResponse<{ event: AgentEventV1; run: AgentRunV1; settlement?: AgentRunSettlementV1 | null }>;
  runCompleted: NooterraResponse<{ event: AgentEventV1; run: AgentRunV1; settlement?: AgentRunSettlementV1 | null }>;
  run: NooterraResponse<{ run: AgentRunV1; verification: Record<string, unknown>; settlement?: AgentRunSettlementV1 | null }>;
  verification: NooterraResponse<Record<string, unknown>>;
  settlement: NooterraResponse<{ settlement: AgentRunSettlementV1 }> | null;
};

export type ToolCallAgreementV1 = {
  schemaVersion: "ToolCallAgreement.v1";
  toolId: string;
  manifestHash: string;
  callId: string;
  inputHash: string;
  acceptanceCriteria: Record<string, unknown> | null;
  settlementTerms: Record<string, unknown> | null;
  payerAgentId: string | null;
  payeeAgentId: string | null;
  createdAt: string;
  agreementHash: string;
};

export type ToolCallEvidenceV1 = {
  schemaVersion: "ToolCallEvidence.v1";
  agreementHash: string;
  callId: string;
  inputHash: string;
  outputHash: string;
  outputRef: string | null;
  metrics: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string;
  createdAt: string;
  evidenceHash: string;
  signature?: {
    algorithm: "ed25519";
    signerKeyId: string;
    evidenceHash: string;
    signature: string;
  } | null;
};

export type ToolCallSettleResult = {
  agreementHash: string;
  receiptHash: string;
  receiptRef: Record<string, unknown>;
  hold: Record<string, unknown> | null;
  holdResponse: NooterraResponse<{ hold: Record<string, unknown> }>;
};

export type TenantAnalyticsQuery = {
  month?: string;
  bucket?: "day" | "week" | "month";
  limit?: number;
};

export type TenantTrustGraphQuery = {
  month?: string;
  minRuns?: number;
  maxEdges?: number;
};

export type TenantTrustGraphSnapshotCreateInput = {
  month?: string;
  minRuns?: number;
  maxEdges?: number;
};

export type TenantTrustGraphDiffQuery = {
  baseMonth?: string;
  compareMonth?: string;
  limit?: number;
  minRuns?: number;
  maxEdges?: number;
  includeUnchanged?: boolean;
};

export type X402GateAuthorizePaymentRequest = {
  gateId: string;
  quoteId?: string | null;
  requestBindingMode?: "strict" | null;
  requestBindingSha256?: string | null;
  walletAuthorizationDecisionToken?: string | null;
  escalationOverrideToken?: string | null;
  executionIntent?: Record<string, unknown> | null;
} & Record<string, unknown>;

export type RelationshipEdge = {
  schemaVersion: "RelationshipEdge.v1";
  tenantId: string;
  agentId: string;
  counterpartyAgentId: string;
  visibility: "private" | "public_summary";
  reputationWindow: "7d" | "30d" | "allTime";
  asOf: string;
  eventCount: number;
  decisionsTotal: number;
  decisionsApproved: number;
  workedWithCount: number;
  successRate: number | null;
  disputesOpened: number;
  disputeRate: number | null;
  releaseRateAvg: number | null;
  settledCents: number;
  refundedCents: number;
  penalizedCents: number;
  autoReleasedCents: number;
  adjustmentAppliedCents: number;
  lastInteractionAt: string | null;
  minimumEconomicWeightCents?: number;
  economicWeightCents?: number;
  economicWeightQualified?: boolean;
  microLoopEventCount?: number;
  microLoopRate?: number | null;
  reciprocalDecisionCount?: number;
  reciprocalEconomicSymmetryDeltaCents?: number | null;
  reciprocalMicroLoopRate?: number | null;
  collusionSuspected?: boolean;
  dampened?: boolean;
  reputationImpactMultiplier?: number;
  antiGamingReasonCodes?: string[];
};

export type PublicAgentReputationSummary = {
  schemaVersion: "PublicAgentReputationSummary.v1";
  agentId: string;
  reputationVersion: "v1" | "v2";
  reputationWindow: "7d" | "30d" | "allTime";
  asOf: string;
  trustScore: number;
  riskTier: "low" | "guarded" | "elevated" | "high";
  eventCount: number;
  decisionsTotal: number;
  decisionsApproved: number;
  successRate: number | null;
  disputesOpened: number;
  disputeRate: number | null;
  lastInteractionAt: string | null;
  relationships: Array<{
    schemaVersion: "RelationshipEdge.v1";
    counterpartyAgentId: string;
    workedWithCount: number;
    successRate: number | null;
    disputeRate: number | null;
    lastInteractionAt: string | null;
  }>;
};

export type InteractionGraphSummary = {
  schemaVersion: "InteractionGraphSummary.v1";
  agentId: string;
  reputationVersion: "v1" | "v2";
  reputationWindow: "7d" | "30d" | "allTime";
  asOf: string;
  trustScore: number;
  riskTier: "low" | "guarded" | "elevated" | "high";
  eventCount: number;
  decisionsTotal: number;
  decisionsApproved: number;
  successRate: number | null;
  disputesOpened: number;
  disputeRate: number | null;
  settledCents: number;
  refundedCents: number;
  penalizedCents: number;
  autoReleasedCents: number;
  adjustmentAppliedCents: number;
  relationshipCount: number;
  economicallyQualifiedRelationshipCount: number;
  dampenedRelationshipCount: number;
  collusionSuspectedRelationshipCount: number;
  lastInteractionAt: string | null;
};

export type InteractionGraphVerification = {
  schemaVersion: "InteractionGraphVerification.v1";
  deterministicOrdering: boolean;
  antiGamingSignalsPresent: boolean;
  generatedBy: string;
};

export type InteractionGraphPackSignature = {
  schemaVersion: "VerifiedInteractionGraphPackSignature.v1";
  algorithm: "ed25519";
  keyId: string;
  signedAt: string;
  payloadHash: string;
  signatureBase64: string;
};

export type VerifiedInteractionGraphPack = {
  schemaVersion: "VerifiedInteractionGraphPack.v1";
  tenantId: string;
  agentId: string;
  reputationVersion: "v1" | "v2";
  reputationWindow: "7d" | "30d" | "allTime";
  asOf: string;
  generatedAt: string;
  relationshipCount: number;
  relationshipsHash: string;
  summaryHash: string;
  verification: InteractionGraphVerification;
  summary: InteractionGraphSummary;
  relationships: RelationshipEdge[];
  packHash: string;
  signature?: InteractionGraphPackSignature;
};

export type SessionParticipantV1 = {
  agentId: string;
  role?: string | null;
  displayName?: string | null;
  [key: string]: unknown;
};

export type SessionV1 = {
  schemaVersion?: "Session.v1";
  sessionId: string;
  tenantId?: string;
  participants?: SessionParticipantV1[];
  visibility?: "public" | "tenant" | "private";
  status?: "open" | "closed";
  title?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type SessionEventV1 = {
  schemaVersion?: "SessionEvent.v1";
  eventId?: string;
  sessionId: string;
  type: string;
  at: string;
  actor?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  provenance?: Record<string, unknown> | null;
  prevChainHash?: string | null;
  chainHash?: string | null;
  [key: string]: unknown;
};

export type SessionReplayPackV1 = {
  schemaVersion?: "SessionReplayPack.v1";
  sessionId: string;
  transcriptHash?: string | null;
  events: SessionEventV1[];
  [key: string]: unknown;
};

export type DelegationGrantV1 = {
  schemaVersion?: "DelegationGrant.v1";
  grantId?: string;
  grantHash?: string;
  delegatorAgentId: string;
  delegateeAgentId: string;
  status?: "active" | "revoked" | "expired" | (string & {});
  [key: string]: unknown;
};

export type AuthorityGrantV1 = {
  schemaVersion?: "AuthorityGrant.v1";
  grantId?: string;
  grantHash?: string;
  granteeAgentId: string;
  principalRef?: {
    principalType: "human" | "org" | "service" | "agent";
    principalId: string;
  };
  status?: "active" | "revoked" | "expired" | (string & {});
  [key: string]: unknown;
};

export type SubAgentWorkOrderV1 = {
  schemaVersion?: "SubAgentWorkOrder.v1";
  workOrderId: string;
  principalAgentId?: string;
  subAgentId?: string;
  acceptanceId?: string | null;
  status?: "created" | "accepted" | "working" | "completed" | "failed" | "settled" | "cancelled" | "disputed" | (string & {});
  [key: string]: unknown;
};

export type SubAgentCompletionReceiptV1 = {
  schemaVersion?: "SubAgentCompletionReceipt.v1";
  receiptId: string;
  workOrderId: string;
  status?: "success" | "failed" | (string & {});
  completedAt?: string;
  [key: string]: unknown;
};

export type NooterraParityTransport = "http" | "mcp";

export type NooterraParityReasonCode =
  | "PARITY_OPERATION_INVALID"
  | "PARITY_PAYLOAD_REQUIRED"
  | "PARITY_REQUIRED_FIELD_MISSING"
  | "PARITY_SHA256_FIELD_INVALID"
  | "PARITY_IDEMPOTENCY_KEY_REQUIRED"
  | "PARITY_EXPECTED_PREV_CHAIN_HASH_REQUIRED"
  | "PARITY_MCP_CALL_REQUIRED"
  | "PARITY_RESPONSE_INVALID"
  | "PARITY_TRANSPORT_ERROR"
  | "PARITY_REQUEST_REJECTED";

export type NooterraParityError = NooterraError & {
  code: NooterraParityReasonCode | (string & {});
  retryable: boolean;
  attempts: number;
  idempotencyKey: string | null;
  transport: NooterraParityTransport;
  operationId: string | null;
};

export type NooterraParityResponse<T = unknown> = NooterraResponse<T> & {
  transport: NooterraParityTransport;
  operationId: string;
  idempotencyKey: string | null;
  attempts: number;
};

export type NooterraParityRetryOptions = {
  maxAttempts?: number;
  retryStatusCodes?: number[];
  retryCodes?: string[];
  retryDelayMs?: number | ((attempt: number) => number);
};

export type NooterraParityOperationBase = {
  operationId: string;
  requiredFields?: string[];
  sha256Fields?: string[];
  idempotencyRequired?: boolean;
  expectedPrevChainHashRequired?: boolean;
};

export type NooterraHttpParityOperation = NooterraParityOperationBase & {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  path: string;
};

export type NooterraMcpParityOperation = NooterraParityOperationBase & {
  toolName: string;
};

export type NooterraMcpCallTool = (
  toolName: string,
  request: {
    operationId: string;
    payload: Record<string, unknown>;
    requestId: string;
    idempotencyKey?: string | null;
    expectedPrevChainHash?: string | null;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  }
) => Promise<Record<string, unknown>>;

export class NooterraHttpParityAdapter {
  constructor(client: NooterraClient, opts?: NooterraParityRetryOptions);
  invoke<T = unknown>(
    operation: NooterraHttpParityOperation,
    payload: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraParityResponse<T>>;
}

export class NooterraMcpParityAdapter {
  constructor(client: NooterraClient, opts: NooterraParityRetryOptions & { callTool: NooterraMcpCallTool });
  invoke<T = unknown>(
    operation: NooterraMcpParityOperation,
    payload: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraParityResponse<T>>;
}

export class NooterraClient {
  constructor(opts: NooterraClientOptions);
  createHttpParityAdapter(opts?: NooterraParityRetryOptions): NooterraHttpParityAdapter;
  createMcpParityAdapter(opts: NooterraParityRetryOptions & { callTool: NooterraMcpCallTool }): NooterraMcpParityAdapter;

  capabilities(opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  openApi(opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  x402GateAuthorizePayment(body: X402GateAuthorizePaymentRequest, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;

  createJob(body: { templateId: string } & Record<string, unknown>, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  getJob(jobId: string, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  registerAgent(
    body: AgentRegistrationInput,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ agentIdentity: AgentIdentityV1; keyId: string }>>;
  listAgents(
    params?: {
      status?: "active" | "suspended" | "revoked";
      capability?: string;
      minTrustScore?: number;
      includeReputation?: boolean;
      reputationVersion?: "v1" | "v2";
      reputationWindow?: "7d" | "30d" | "allTime";
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ agents: AgentIdentityV1[]; reputations?: Record<string, AgentReputation>; limit: number; offset: number }>>;
  getAgent(agentId: string, opts?: RequestOptions): Promise<NooterraResponse<{ agentIdentity: AgentIdentityV1 }>>;
  getAgentReputation(
    agentId: string,
    opts?: RequestOptions & { reputationVersion?: "v1" | "v2"; reputationWindow?: "7d" | "30d" | "allTime" }
  ): Promise<NooterraResponse<{ reputation: AgentReputation }>>;
  upsertAgentCard(body: Record<string, unknown>, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  getAgentCard(agentId: string, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  listAgentCards(
    params?: {
      agentId?: string;
      status?: "active" | "suspended" | "revoked";
      visibility?: "public" | "tenant" | "private";
      capability?: string;
      executionCoordinatorDid?: string;
      runtime?: string;
      supportsPolicyTemplate?: string;
      supportsEvidencePack?: string;
      toolId?: string;
      toolMcpName?: string;
      toolRiskClass?: "read" | "compute" | "action" | "financial";
      toolSideEffecting?: boolean;
      toolMaxPriceCents?: number;
      toolRequiresEvidenceKind?: "artifact" | "hash" | "verification_report";
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<Record<string, unknown>>>;
  discoverAgentCards(
    params?: {
      status?: "active" | "suspended" | "revoked" | "all";
      visibility?: "all" | "public" | "tenant" | "private";
      capability?: string;
      executionCoordinatorDid?: string;
      runtime?: string;
      supportsPolicyTemplate?: string;
      supportsEvidencePack?: string;
      toolId?: string;
      toolMcpName?: string;
      toolRiskClass?: "read" | "compute" | "action" | "financial";
      toolSideEffecting?: boolean;
      toolMaxPriceCents?: number;
      toolRequiresEvidenceKind?: "artifact" | "hash" | "verification_report";
      requireCapabilityAttestation?: boolean;
      attestationMinLevel?: "self_claimed" | "historical" | "benchmark" | "attested" | "certified";
      attestationIssuerAgentId?: string;
      includeAttestationMetadata?: boolean;
      minTrustScore?: number;
      riskTier?: "low" | "guarded" | "elevated" | "high";
      includeReputation?: boolean;
      reputationVersion?: "v1" | "v2";
      reputationWindow?: "7d" | "30d" | "allTime";
      scoreStrategy?: "balanced" | "recent_bias" | "trust_weighted";
      requesterAgentId?: string;
      includeRoutingFactors?: boolean;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<Record<string, unknown>>>;
  discoverPublicAgentCards(
    params?: {
      status?: "active" | "suspended" | "revoked" | "all";
      visibility?: "public";
      capability?: string;
      executionCoordinatorDid?: string;
      runtime?: string;
      toolId?: string;
      toolMcpName?: string;
      toolRiskClass?: "read" | "compute" | "action" | "financial";
      toolSideEffecting?: boolean;
      toolMaxPriceCents?: number;
      toolRequiresEvidenceKind?: "artifact" | "hash" | "verification_report";
      requireCapabilityAttestation?: boolean;
      attestationMinLevel?: "self_claimed" | "historical" | "benchmark" | "attested" | "certified";
      attestationIssuerAgentId?: string;
      includeAttestationMetadata?: boolean;
      minTrustScore?: number;
      riskTier?: "low" | "guarded" | "elevated" | "high";
      includeReputation?: boolean;
      reputationVersion?: "v1" | "v2";
      reputationWindow?: "7d" | "30d" | "allTime";
      scoreStrategy?: "balanced" | "recent_bias" | "trust_weighted";
      requesterAgentId?: string;
      includeRoutingFactors?: boolean;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<Record<string, unknown>>>;
  streamPublicAgentCards(
    params?: {
      capability?: string;
      executionCoordinatorDid?: string;
      toolId?: string;
      toolMcpName?: string;
      toolRiskClass?: "read" | "compute" | "action" | "financial";
      toolSideEffecting?: boolean;
      toolMaxPriceCents?: number;
      toolRequiresEvidenceKind?: "artifact" | "hash" | "verification_report";
      status?: "active" | "suspended" | "revoked" | "all";
      runtime?: string;
      sinceCursor?: string;
    },
    opts?: Pick<RequestOptions, "requestId" | "signal"> & { lastEventId?: string }
  ): AsyncGenerator<NooterraSseEvent, void, unknown>;
  getPublicAgentReputationSummary(
    agentId: string,
    params?: {
      reputationVersion?: "v1" | "v2";
      reputationWindow?: "7d" | "30d" | "allTime";
      asOf?: string;
      includeRelationships?: boolean;
      relationshipLimit?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ ok: boolean; summary: PublicAgentReputationSummary }>>;
  getAgentInteractionGraphPack(
    agentId: string,
    params?: {
      reputationVersion?: "v1" | "v2";
      reputationWindow?: "7d" | "30d" | "allTime";
      asOf?: string;
      counterpartyAgentId?: string;
      visibility?: "all" | "private" | "public_summary";
      sign?: boolean;
      signerKeyId?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ ok: boolean; graphPack: VerifiedInteractionGraphPack }>>;
  listRelationships(
    params: {
      agentId: string;
      counterpartyAgentId?: string;
      reputationWindow?: "7d" | "30d" | "allTime";
      asOf?: string;
      visibility?: "all" | "private" | "public_summary";
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      ok: boolean;
      agentId: string;
      reputationWindow: "7d" | "30d" | "allTime";
      asOf: string;
      total: number;
      limit: number;
      offset: number;
      relationships: RelationshipEdge[];
    }>
  >;
  searchMarketplaceAgents(
    params?: {
      status?: "active" | "suspended" | "revoked" | "all";
      capability?: string;
      minTrustScore?: number;
      riskTier?: "low" | "guarded" | "elevated" | "high";
      includeReputation?: boolean;
      reputationVersion?: "v1" | "v2";
      reputationWindow?: "7d" | "30d" | "allTime";
      scoreStrategy?: "balanced" | "recent_bias";
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      reputationVersion: "v1" | "v2";
      reputationWindow: "7d" | "30d" | "allTime";
      scoreStrategy: "balanced" | "recent_bias";
      total: number;
      limit: number;
      offset: number;
      results: Array<{
        rank: number;
        rankingScore: number;
        riskTier: "low" | "guarded" | "elevated" | "high";
        agentIdentity: AgentIdentityV1;
        reputation?: AgentReputation;
      }>;
    }>
  >;
  upsertMarketplaceSettlementPolicy(
    body: {
      policyId: string;
      policyVersion?: number;
      verificationMethod?: {
        verificationMethodHash?: string;
        mode?: "deterministic" | "attested" | "discretionary";
        source?: string;
        attestor?: string;
        notes?: string;
      };
      policy: {
        policyHash?: string;
        policyVersion?: number;
        mode?: "automatic" | "manual-review";
        rules?: {
          requireDeterministicVerification?: boolean;
          autoReleaseOnGreen?: boolean;
          autoReleaseOnAmber?: boolean;
          autoReleaseOnRed?: boolean;
          greenReleaseRatePct?: number;
          amberReleaseRatePct?: number;
          redReleaseRatePct?: number;
          maxAutoReleaseAmountCents?: number;
          manualReason?: string;
        };
      };
      description?: string;
      metadata?: Record<string, unknown>;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ policy: TenantSettlementPolicyV1 }>>;
  listMarketplaceSettlementPolicies(
    params?: { policyId?: string; limit?: number; offset?: number },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ policies: TenantSettlementPolicyV1[]; total: number; limit: number; offset: number }>>;
  getMarketplaceSettlementPolicy(
    policyId: string,
    policyVersion: number,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ policy: TenantSettlementPolicyV1 }>>;
  createMarketplaceRfq(
    body: {
      rfqId?: string;
      title?: string;
      description?: string;
      capability?: string;
      fromType?: InteractionEntityType;
      toType?: InteractionEntityType;
      posterAgentId?: string;
      budgetCents?: number;
      currency?: string;
      deadlineAt?: string;
      counterOfferPolicy?: {
        allowPosterCounterOffers?: boolean;
        allowBidderCounterOffers?: boolean;
        maxRevisions?: number;
        timeoutSeconds?: number;
      };
      metadata?: Record<string, unknown>;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ rfq: MarketplaceRfqV1 }>>;
  listMarketplaceRfqs(
    params?: {
      status?: "open" | "assigned" | "cancelled" | "closed" | "all";
      capability?: string;
      posterAgentId?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ rfqs: MarketplaceRfqV1[]; total: number; limit: number; offset: number }>>;
  submitMarketplaceBid(
    rfqId: string,
    body: {
      bidId?: string;
      proposalId?: string;
      fromType?: InteractionEntityType;
      toType?: InteractionEntityType;
      bidderAgentId: string;
      amountCents: number;
      currency?: string;
      etaSeconds?: number;
      note?: string;
      verificationMethod?: {
        verificationMethodHash?: string;
        mode?: "deterministic" | "attested" | "discretionary";
        source?: string;
        attestor?: string;
        notes?: string;
      };
      policy?: {
        policyHash?: string;
        policyVersion?: number;
        mode?: "automatic" | "manual-review";
        rules?: {
          requireDeterministicVerification?: boolean;
          autoReleaseOnGreen?: boolean;
          autoReleaseOnAmber?: boolean;
          autoReleaseOnRed?: boolean;
          greenReleaseRatePct?: number;
          amberReleaseRatePct?: number;
          redReleaseRatePct?: number;
          maxAutoReleaseAmountCents?: number;
          manualReason?: string;
        };
      };
      policyRef?: {
        source?: "tenant_registry" | "inline";
        policyId?: string;
        policyVersion?: number;
        policyHash?: string;
        verificationMethodHash?: string;
      };
      metadata?: Record<string, unknown>;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ rfq: MarketplaceRfqV1; bid: MarketplaceRfqBidV1 }>>;
  listMarketplaceBids(
    rfqId: string,
    params?: {
      status?: "pending" | "accepted" | "rejected" | "all";
      bidderAgentId?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ rfqId: string; bids: MarketplaceRfqBidV1[]; total: number; limit: number; offset: number }>>;
  applyMarketplaceBidCounterOffer(
    rfqId: string,
    bidId: string,
    body: {
      proposalId?: string;
      proposerAgentId: string;
      amountCents?: number;
      currency?: string;
      etaSeconds?: number | null;
      note?: string | null;
      verificationMethod?: {
        verificationMethodHash?: string;
        mode?: "deterministic" | "attested" | "discretionary";
        source?: string;
        attestor?: string;
        notes?: string;
      };
      policy?: {
        policyHash?: string;
        policyVersion?: number;
        mode?: "automatic" | "manual-review";
        rules?: {
          requireDeterministicVerification?: boolean;
          autoReleaseOnGreen?: boolean;
          autoReleaseOnAmber?: boolean;
          autoReleaseOnRed?: boolean;
          greenReleaseRatePct?: number;
          amberReleaseRatePct?: number;
          redReleaseRatePct?: number;
          maxAutoReleaseAmountCents?: number;
          manualReason?: string;
        };
      };
      policyRef?: {
        source?: "tenant_registry" | "inline";
        policyId?: string;
        policyVersion?: number;
        policyHash?: string;
        verificationMethodHash?: string;
      };
      metadata?: Record<string, unknown> | null;
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      rfq: MarketplaceRfqV1;
      bid: MarketplaceRfqBidV1;
      negotiation: MarketplaceBidNegotiationV1;
      proposal: MarketplaceBidNegotiationProposalV1;
    }>
  >;
  acceptMarketplaceBid(
    rfqId: string,
    body: {
      bidId: string;
      acceptedByAgentId?: string;
      runId?: string;
      taskType?: string;
      inputRef?: string;
      payerAgentId?: string;
      fromType?: InteractionEntityType;
      toType?: InteractionEntityType;
      disputeWindowDays?: number;
      acceptanceSignature?: MarketplaceAgreementAcceptanceSignatureInput;
      agreementTerms?: MarketplaceAgreementTermsInput;
      verificationMethod?: {
        verificationMethodHash?: string;
        mode?: "deterministic" | "attested" | "discretionary";
        source?: string;
        attestor?: string;
        notes?: string;
      };
      policy?: {
        policyHash?: string;
        policyVersion?: number;
        mode?: "automatic" | "manual-review";
        rules?: {
          requireDeterministicVerification?: boolean;
          autoReleaseOnGreen?: boolean;
          autoReleaseOnAmber?: boolean;
          autoReleaseOnRed?: boolean;
          greenReleaseRatePct?: number;
          amberReleaseRatePct?: number;
          redReleaseRatePct?: number;
          maxAutoReleaseAmountCents?: number;
          manualReason?: string;
        };
      };
      policyRef?: {
        source?: "tenant_registry" | "inline";
        policyId?: string;
        policyVersion?: number;
        policyHash?: string;
        verificationMethodHash?: string;
      };
      settlement?: {
        payerAgentId?: string;
        fromType?: InteractionEntityType;
        toType?: InteractionEntityType;
        amountCents?: number;
        currency?: string;
        disputeWindowDays?: number;
        agreementTerms?: MarketplaceAgreementTermsInput;
        verificationMethod?: {
          verificationMethodHash?: string;
          mode?: "deterministic" | "attested" | "discretionary";
          source?: string;
          attestor?: string;
          notes?: string;
        };
        policy?: {
          policyHash?: string;
          policyVersion?: number;
          mode?: "automatic" | "manual-review";
          rules?: {
            requireDeterministicVerification?: boolean;
            autoReleaseOnGreen?: boolean;
            autoReleaseOnAmber?: boolean;
            autoReleaseOnRed?: boolean;
            greenReleaseRatePct?: number;
            amberReleaseRatePct?: number;
            redReleaseRatePct?: number;
            maxAutoReleaseAmountCents?: number;
            manualReason?: string;
          };
        };
        policyRef?: {
          source?: "tenant_registry" | "inline";
          policyId?: string;
          policyVersion?: number;
          policyHash?: string;
          verificationMethodHash?: string;
        };
      };
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      rfq: MarketplaceRfqV1;
      acceptedBid: MarketplaceRfqBidV1 | null;
      run: AgentRunV1;
      settlement: AgentRunSettlementV1;
      agreement: MarketplaceTaskAgreementV2;
    }>
  >;
  createTaskQuote(
    body: {
      quoteId?: string;
      buyerAgentId: string;
      sellerAgentId: string;
      requiredCapability?: string | null;
      pricing?: { amountCents: number; currency?: string } | null;
      constraints?: Record<string, unknown> | null;
      quoteAt?: string;
      quoteExpiresAt?: string;
      metadata?: Record<string, unknown> | null;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ taskQuote: Record<string, unknown> }>>;
  listTaskQuotes(
    params?: {
      quoteId?: string;
      buyerAgentId?: string;
      sellerAgentId?: string;
      requiredCapability?: string;
      status?: "open" | "accepted" | "expired" | "cancelled";
      acceptanceId?: string;
      createdAfter?: string;
      createdBefore?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ taskQuotes: Array<Record<string, unknown>>; total: number; limit: number; offset: number }>>;
  getTaskQuote(quoteId: string, opts?: RequestOptions): Promise<NooterraResponse<{ taskQuote: Record<string, unknown> }>>;
  createTaskOffer(
    body: {
      offerId?: string;
      quoteRef?: { quoteId: string; quoteHash: string } | null;
      buyerAgentId: string;
      sellerAgentId: string;
      requiredCapability?: string | null;
      pricing?: { amountCents: number; currency?: string } | null;
      constraints?: Record<string, unknown> | null;
      offeredAt?: string;
      offerExpiresAt?: string;
      metadata?: Record<string, unknown> | null;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ taskOffer: Record<string, unknown> }>>;
  listTaskOffers(
    params?: {
      offerId?: string;
      quoteId?: string;
      buyerAgentId?: string;
      sellerAgentId?: string;
      requiredCapability?: string;
      status?: "open" | "accepted" | "expired" | "cancelled";
      acceptanceId?: string;
      createdAfter?: string;
      createdBefore?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ taskOffers: Array<Record<string, unknown>>; total: number; limit: number; offset: number }>>;
  getTaskOffer(offerId: string, opts?: RequestOptions): Promise<NooterraResponse<{ taskOffer: Record<string, unknown> }>>;
  createTaskAcceptance(
    body: {
      acceptanceId?: string;
      quoteId: string;
      offerId: string;
      acceptedByAgentId: string;
      acceptedAt?: string;
      metadata?: Record<string, unknown> | null;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ taskAcceptance: Record<string, unknown> }>>;
  listTaskAcceptances(
    params?: {
      acceptanceId?: string;
      quoteId?: string;
      offerId?: string;
      acceptedByAgentId?: string;
      status?: "accepted" | "cancelled";
      createdAfter?: string;
      createdBefore?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ taskAcceptances: Array<Record<string, unknown>>; total: number; limit: number; offset: number }>>;
  getTaskAcceptance(
    acceptanceId: string,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ taskAcceptance: Record<string, unknown> }>>;
  proposeIntentContract(
    body: Record<string, unknown> & {
      proposerAgentId: string;
      counterpartyAgentId: string;
      objective: unknown;
      budgetEnvelope: Record<string, unknown>;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ intentContract: Record<string, unknown> }>>;
  listIntentContracts(
    params?: {
      intentId?: string;
      proposerAgentId?: string;
      counterpartyAgentId?: string;
      status?: "proposed" | "countered" | "accepted";
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ intents: Array<Record<string, unknown>>; limit: number; offset: number }>>;
  getIntentContract(intentId: string, opts?: RequestOptions): Promise<NooterraResponse<{ intentContract: Record<string, unknown> }>>;
  counterIntentContract(
    intentId: string,
    body: Record<string, unknown> & { proposerAgentId: string },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ intentContract: Record<string, unknown> }>>;
  acceptIntentContract(
    intentId: string,
    body: Record<string, unknown> & { acceptedByAgentId: string },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ intentContract: Record<string, unknown> }>>;
  createWorkOrder(
    body: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ workOrder: SubAgentWorkOrderV1 }>>;
  listWorkOrders(
    params?: {
      workOrderId?: string;
      principalAgentId?: string;
      subAgentId?: string;
      status?: "created" | "accepted" | "working" | "completed" | "failed" | "settled" | "cancelled" | "disputed";
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ workOrders: Array<SubAgentWorkOrderV1>; limit: number; offset: number }>>;
  getWorkOrder(
    workOrderId: string,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ workOrder: SubAgentWorkOrderV1 }>>;
  acceptWorkOrder(
    workOrderId: string,
    body?: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ workOrder: SubAgentWorkOrderV1 }>>;
  progressWorkOrder(
    workOrderId: string,
    body: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ workOrder: SubAgentWorkOrderV1 }>>;
  topUpWorkOrder(
    workOrderId: string,
    body: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraResponse<Record<string, unknown>>>;
  getWorkOrderMetering(
    workOrderId: string,
    params?: {
      includeMeters?: boolean;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<Record<string, unknown>>>;
  completeWorkOrder(
    workOrderId: string,
    body: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ workOrder: SubAgentWorkOrderV1; completionReceipt: SubAgentCompletionReceiptV1 }>>;
  settleWorkOrder(
    workOrderId: string,
    body?: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ workOrder: SubAgentWorkOrderV1; completionReceipt: SubAgentCompletionReceiptV1 }>>;
  listWorkOrderReceipts(
    params?: {
      receiptId?: string;
      workOrderId?: string;
      principalAgentId?: string;
      subAgentId?: string;
      status?: "success" | "failed";
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ receipts: Array<SubAgentCompletionReceiptV1>; limit: number; offset: number }>>;
  getWorkOrderReceipt(
    receiptId: string,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ completionReceipt: SubAgentCompletionReceiptV1 }>>;
  createStateCheckpoint(
    body: {
      checkpointId?: string;
      ownerAgentId: string;
      projectId?: string | null;
      sessionId?: string | null;
      traceId?: string | null;
      parentCheckpointId?: string | null;
      delegationGrantRef?: string | null;
      authorityGrantRef?: string | null;
      stateRef: {
        schemaVersion?: "ArtifactRef.v1";
        artifactId: string;
        artifactHash: string;
        artifactType?: string | null;
        tenantId?: string | null;
        metadata?: Record<string, unknown> | null;
      };
      diffRefs?: Array<{
        schemaVersion?: "ArtifactRef.v1";
        artifactId: string;
        artifactHash: string;
        artifactType?: string | null;
        tenantId?: string | null;
        metadata?: Record<string, unknown> | null;
      }>;
      redactionPolicyRef?: string | null;
      metadata?: Record<string, unknown> | null;
      createdAt?: string | null;
      updatedAt?: string | null;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ stateCheckpoint: Record<string, unknown> }>>;
  listStateCheckpoints(
    params?: {
      checkpointId?: string;
      projectId?: string;
      sessionId?: string;
      ownerAgentId?: string;
      traceId?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ stateCheckpoints: Array<Record<string, unknown>>; limit: number; offset: number }>>;
  getStateCheckpoint(
    checkpointId: string,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ stateCheckpoint: Record<string, unknown> }>>;
  compactStateCheckpointLineage(
    body: {
      checkpoints: Array<Record<string, unknown>>;
      compactionId?: string | null;
      retainEvery?: number;
      retainTail?: number;
      compactedAt?: string | null;
      metadata?: Record<string, unknown> | null;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ stateCheckpointLineageCompaction: Record<string, unknown> }>>;
  restoreStateCheckpointLineage(
    body: {
      compaction: Record<string, unknown>;
      restoredAt?: string | null;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ stateCheckpointLineageRestore: Record<string, unknown> }>>;
  createSession(
    body: {
      sessionId?: string;
      participants?: Array<{ agentId: string; role?: string | null; displayName?: string | null }>;
      visibility?: "public" | "tenant" | "private";
      status?: "open" | "closed";
      title?: string | null;
      summary?: string | null;
      metadata?: Record<string, unknown> | null;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ session: SessionV1 }>>;
  listSessions(
    params?: {
      sessionId?: string;
      participantAgentId?: string;
      visibility?: "public" | "tenant" | "private";
      status?: "open" | "closed";
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ sessions: Array<SessionV1>; total: number; limit: number; offset: number }>>;
  getSession(sessionId: string, opts?: RequestOptions): Promise<NooterraResponse<{ session: SessionV1 }>>;
  listSessionEvents(
    sessionId: string,
    params?: { eventType?: string; sinceEventId?: string; checkpointConsumerId?: string; limit?: number; offset?: number },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ sessionId: string; events: Array<SessionEventV1>; limit: number; offset: number }>>;
  getSessionEventCheckpoint(
    sessionId: string,
    checkpointConsumerId: string,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ checkpoint: Record<string, unknown>; inbox: Record<string, unknown> }>>;
  ackSessionEventCheckpoint(
    sessionId: string,
    body: { checkpointConsumerId: string; sinceEventId?: string | null },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ checkpoint: Record<string, unknown>; inbox: Record<string, unknown> }>>;
  requeueSessionEventCheckpoint(
    sessionId: string,
    body: { checkpointConsumerId: string; sinceEventId?: string | null },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ checkpoint: Record<string, unknown>; inbox: Record<string, unknown> }>>;
  appendSessionEvent(
    sessionId: string,
    body: {
      type: string;
      at?: string;
      actor?: Record<string, unknown>;
      payload?: Record<string, unknown>;
      provenance?: Record<string, unknown>;
    },
    opts: RequestOptions
  ): Promise<NooterraResponse<{ sessionId: string; event: SessionEventV1; currentPrevChainHash: string | null }>>;
  getSessionReplayPack(sessionId: string, opts?: RequestOptions): Promise<NooterraResponse<{ replayPack: SessionReplayPackV1 }>>;
  getSessionTranscript(
    sessionId: string,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ transcript: Record<string, unknown> }>>;
  streamSessionEvents(
    sessionId: string,
    params?: { eventType?: string; sinceEventId?: string; checkpointConsumerId?: string },
    opts?: Pick<RequestOptions, "requestId" | "signal"> & { lastEventId?: string }
  ): AsyncGenerator<NooterraSseEvent, void, unknown>;
  getAgentWallet(agentId: string, opts?: RequestOptions): Promise<NooterraResponse<{ wallet: AgentWalletV1 }>>;
  createDelegationGrant(
    body: Record<string, unknown> & { delegatorAgentId: string; delegateeAgentId: string },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ delegationGrant: DelegationGrantV1 }>>;
  issueDelegationGrant(
    body: Record<string, unknown> & { delegatorAgentId: string; delegateeAgentId: string },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ delegationGrant: DelegationGrantV1 }>>;
  listDelegationGrants(
    params?: {
      grantId?: string;
      grantHash?: string;
      delegatorAgentId?: string;
      delegateeAgentId?: string;
      includeRevoked?: boolean;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ grants: Array<DelegationGrantV1>; limit: number; offset: number }>>;
  getDelegationGrant(grantId: string, opts?: RequestOptions): Promise<NooterraResponse<{ delegationGrant: DelegationGrantV1 }>>;
  revokeDelegationGrant(
    grantId: string,
    body?: { revocationReasonCode?: string; reasonCode?: string } & Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ delegationGrant: DelegationGrantV1 }>>;
  createAuthorityGrant(
    body: {
      grantId?: string;
      principalRef: {
        principalType: "human" | "org" | "service" | "agent";
        principalId: string;
      };
      granteeAgentId: string;
      scope?: {
        allowedProviderIds?: string[];
        allowedToolIds?: string[];
        allowedRiskClasses?: Array<"read" | "compute" | "action" | "financial">;
        sideEffectingAllowed?: boolean;
      };
      spendEnvelope?: {
        currency?: string;
        maxPerCallCents: number;
        maxTotalCents: number;
      };
      chainBinding?: {
        rootGrantHash?: string | null;
        parentGrantHash?: string | null;
        depth?: number;
        maxDelegationDepth?: number;
      };
      validity?: {
        issuedAt?: string;
        notBefore?: string;
        expiresAt?: string;
      };
      revocation?: {
        revocable?: boolean;
      };
      metadata?: Record<string, unknown>;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ authorityGrant: AuthorityGrantV1 }>>;
  listAuthorityGrants(
    params?: {
      grantId?: string;
      grantHash?: string;
      principalId?: string;
      granteeAgentId?: string;
      includeRevoked?: boolean;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ grants: Array<AuthorityGrantV1>; limit: number; offset: number }>>;
  getAuthorityGrant(grantId: string, opts?: RequestOptions): Promise<NooterraResponse<{ authorityGrant: AuthorityGrantV1 }>>;
  revokeAuthorityGrant(
    grantId: string,
    body?: { revocationReasonCode?: string },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ authorityGrant: AuthorityGrantV1 }>>;
  creditAgentWallet(
    agentId: string,
    body: { amountCents: number; currency?: string },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ wallet: AgentWalletV1 }>>;
  createAgentRun(
    agentId: string,
    body?: {
      runId?: string;
      taskType?: string;
      inputRef?: string;
      settlement?: { payerAgentId: string; amountCents: number; currency?: string };
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ run: AgentRunV1; event: AgentEventV1; settlement?: AgentRunSettlementV1 | null }>>;
  listAgentRuns(
    agentId: string,
    params?: { status?: "created" | "running" | "completed" | "failed"; limit?: number; offset?: number },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ runs: AgentRunV1[]; total: number; limit: number; offset: number }>>;
  getAgentRun(
    agentId: string,
    runId: string,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ run: AgentRunV1; verification: Record<string, unknown>; settlement?: AgentRunSettlementV1 | null }>>;
  listAgentRunEvents(agentId: string, runId: string, opts?: RequestOptions): Promise<NooterraResponse<{ events: AgentEventV1[] }>>;
  appendAgentRunEvent(
    agentId: string,
    runId: string,
    body: {
      type: "RUN_STARTED" | "RUN_HEARTBEAT" | "EVIDENCE_ADDED" | "RUN_COMPLETED" | "RUN_FAILED";
      at?: string;
      actor?: Record<string, unknown>;
      payload: Record<string, unknown>;
    },
    opts: RequestOptions
  ): Promise<NooterraResponse<{ event: AgentEventV1; run: AgentRunV1; settlement?: AgentRunSettlementV1 | null }>>;
  getRunVerification(runId: string, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  getRunSettlement(runId: string, opts?: RequestOptions): Promise<NooterraResponse<{ settlement: AgentRunSettlementV1 }>>;
  getRunAgreement(
    runId: string,
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      runId: string;
      rfqId?: string | null;
      agreementId?: string | null;
      agreement: MarketplaceTaskAgreementV2;
      policyRef?: MarketplaceSettlementPolicyRefV1 | null;
      policyHash?: string | null;
      verificationMethodHash?: string | null;
      policyBindingVerification: Record<string, unknown>;
      acceptanceSignatureVerification: Record<string, unknown>;
    }>
  >;
  applyRunAgreementChangeOrder(
    runId: string,
    body: {
      changeOrderId?: string;
      requestedByAgentId: string;
      acceptedByAgentId?: string;
      acceptanceSignature?: MarketplaceAgreementAcceptanceSignatureInput;
      reason: string;
      note?: string;
      milestones?: MarketplaceAgreementTermsInput["milestones"];
      cancellation?: MarketplaceAgreementTermsInput["cancellation"];
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      runId: string;
      rfq: MarketplaceRfqV1;
      agreement: MarketplaceTaskAgreementV2;
      changeOrder: Record<string, unknown>;
      acceptanceSignatureVerification: Record<string, unknown>;
    }>
  >;
  cancelRunAgreement(
    runId: string,
    body: {
      cancellationId?: string;
      cancelledByAgentId: string;
      acceptedByAgentId?: string;
      acceptanceSignature?: MarketplaceAgreementAcceptanceSignatureInput;
      reason: string;
      evidenceRef?: string;
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      runId: string;
      rfq: MarketplaceRfqV1;
      run: AgentRunV1;
      settlement: AgentRunSettlementV1;
      agreement: MarketplaceTaskAgreementV2 | null;
      cancellation: Record<string, unknown>;
      acceptanceSignatureVerification: Record<string, unknown>;
    }>
  >;
  getRunSettlementPolicyReplay(
    runId: string,
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      runId: string;
      agreementId?: string | null;
      policyVersion?: number | null;
      policyHash?: string | null;
      verificationMethodHash?: string | null;
      policyRef?: MarketplaceSettlementPolicyRefV1 | null;
      policyBinding?: MarketplaceAgreementPolicyBindingV2 | null;
      policyBindingVerification: Record<string, unknown>;
      acceptanceSignatureVerification: Record<string, unknown>;
      runStatus?: string | null;
      verificationStatus: "green" | "amber" | "red";
      replay: Record<string, unknown>;
      settlement: AgentRunSettlementV1;
      matchesStoredDecision: boolean;
    }>
  >;
  resolveRunSettlement(
    runId: string,
    body: {
      status: "released" | "refunded";
      releaseRatePct?: number;
      releasedAmountCents?: number;
      refundedAmountCents?: number;
      reason?: string;
      resolvedByAgentId?: string;
      resolutionEventId?: string;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ settlement: AgentRunSettlementV1 }>>;

  opsLockToolCallHold(body: Record<string, unknown>, opts?: RequestOptions): Promise<NooterraResponse<{ hold: Record<string, unknown> }>>;
  opsListToolCallHolds(
    params?: { agreementHash?: string; status?: string; limit?: number; offset?: number },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      ok: boolean;
      tenantId: string;
      agreementHash: string | null;
      status: string | null;
      limit: number;
      offset: number;
      holds: Array<Record<string, unknown>>;
    }>
  >;
  opsGetToolCallReplayEvaluate(
    agreementHash: string,
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      ok: boolean;
      tenantId: string;
      agreementHash: string;
      runId: string;
      replay: Record<string, unknown>;
      stored: Record<string, unknown>;
      comparisons: Record<string, unknown>;
      issues: string[];
    }>
  >;
  opsGetToolCallHold(holdHash: string, opts?: RequestOptions): Promise<NooterraResponse<{ ok: boolean; tenantId: string; hold: Record<string, unknown> }>>;
  opsGetReputationFacts(
    params: {
      agentId: string;
      toolId?: string;
      window?: "7d" | "30d" | "allTime";
      asOf?: string;
      includeEvents?: boolean;
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      ok: boolean;
      tenantId: string;
      agentId: string;
      toolId: string | null;
      window: "7d" | "30d" | "allTime";
      asOf: string;
      windowStartAt: string | null;
      facts: Record<string, unknown>;
      events?: Array<Record<string, unknown>>;
    }>
  >;
  opsRunToolCallHoldbackMaintenance(
    body?: { dryRun?: boolean; limit?: number; maxHolds?: number } & Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraResponse<Record<string, unknown>>>;
  toolCallListArbitrationCases(
    params?: { agreementHash?: string; status?: string },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      agreementHash: string;
      runId: string;
      cases: Array<Record<string, unknown>>;
    }>
  >;
  toolCallGetArbitrationCase(caseId: string, opts?: RequestOptions): Promise<NooterraResponse<{ caseId: string; arbitrationCase: Record<string, unknown> }>>;
  toolCallOpenArbitration(body: Record<string, unknown>, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  toolCallSubmitArbitrationVerdict(body: Record<string, unknown>, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  opsGetSettlementAdjustment(adjustmentId: string, opts?: RequestOptions): Promise<NooterraResponse<{ ok: boolean; tenantId: string; adjustment: Record<string, unknown> }>>;
  getArtifact(artifactId: string, opts?: RequestOptions): Promise<NooterraResponse<{ artifact: Record<string, unknown> }>>;
  createCapabilityAttestation(
    body: Record<string, unknown> & { subjectAgentId: string; capability: string },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ capabilityAttestation: Record<string, unknown> }>>;
  listCapabilityAttestations(
    params?: {
      attestationId?: string;
      subjectAgentId?: string;
      issuerAgentId?: string;
      capability?: string;
      status?: "active" | "expired" | "revoked" | "invalid" | "all";
      includeInvalid?: boolean;
      at?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      attestations: Array<{ capabilityAttestation: Record<string, unknown>; runtime: Record<string, unknown> }>;
      total: number;
      limit: number;
      offset: number;
    }>
  >;
  getCapabilityAttestation(
    attestationId: string,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ capabilityAttestation: Record<string, unknown>; runtime: Record<string, unknown> | null }>>;
  revokeCapabilityAttestation(
    attestationId: string,
    body?: { revokedAt?: string; reasonCode?: string } & Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ capabilityAttestation: Record<string, unknown>; runtime: Record<string, unknown> | null }>>;
  getArtifacts(
    params: { artifactIds: string[] } | string[],
    opts?: RequestOptions
  ): Promise<{ artifacts: Array<{ artifactId: string; artifact: Record<string, unknown> | null }>; responses: Array<NooterraResponse<{ artifact: Record<string, unknown> }>> }>;

  createAgreement(params: {
    toolId: string;
    manifestHash: string;
    callId: string;
    input?: Record<string, unknown>;
    acceptanceCriteria?: Record<string, unknown> | null;
    settlementTerms?: Record<string, unknown> | null;
    payerAgentId?: string;
    payeeAgentId?: string;
    createdAt?: string;
  }): {
    agreement: ToolCallAgreementV1;
    agreementHash: string;
    inputHash: string;
    canonicalJson: string;
  };
  signEvidence(params: {
    agreement?: ToolCallAgreementV1;
    agreementHash?: string;
    callId?: string;
    inputHash?: string;
    output?: Record<string, unknown>;
    outputRef?: string;
    metrics?: Record<string, unknown> | null;
    startedAt?: string;
    completedAt?: string;
    createdAt?: string;
    signerKeyId?: string;
    signerPrivateKeyPem?: string;
  }): {
    evidence: ToolCallEvidenceV1;
    evidenceHash: string;
    outputHash: string;
    canonicalJson: string;
  };
  createHold(
    params: {
      agreement?: ToolCallAgreementV1;
      agreementHash?: string;
      receiptHash: string;
      payerAgentId: string;
      payeeAgentId: string;
      amountCents: number;
      currency?: string;
      holdbackBps?: number;
      challengeWindowMs?: number;
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ hold: Record<string, unknown> }>>;
  settle(
    params: {
      agreement?: ToolCallAgreementV1;
      agreementHash?: string;
      evidence?: ToolCallEvidenceV1;
      evidenceHash?: string;
      payerAgentId: string;
      payeeAgentId: string;
      amountCents: number;
      currency?: string;
      holdbackBps?: number;
      challengeWindowMs?: number;
      settledAt?: string;
      receiptHash?: string;
    },
    opts?: RequestOptions
  ): Promise<ToolCallSettleResult>;
  openDispute(
    params: {
      agreementHash: string;
      receiptHash: string;
      holdHash: string;
      openedByAgentId?: string;
      arbiterAgentId: string;
      summary: string;
      evidenceRefs?: string[];
      disputeOpenEnvelope?: Record<string, unknown>;
      signerKeyId?: string;
      signerPrivateKeyPem?: string;
      signature?: string;
      caseId?: string;
      envelopeId?: string;
      reasonCode?: string;
      nonce?: string;
      openedAt?: string;
      tenantId?: string;
      adminOverride?: { enabled?: boolean; reason?: string };
    },
    opts?: RequestOptions
  ): Promise<NooterraResponse<Record<string, unknown>>>;
  buildDisputeOpenEnvelope(params: {
    agreementHash: string;
    receiptHash: string;
    holdHash: string;
    openedByAgentId: string;
    signerKeyId: string;
    signerPrivateKeyPem?: string;
    signature?: string;
    caseId?: string;
    envelopeId?: string;
    reasonCode?: string;
    nonce?: string;
    openedAt?: string;
    tenantId?: string;
  }): {
    disputeOpenEnvelope: Record<string, unknown>;
    envelopeHash: string;
    canonicalJson: string;
  };

  openRunDispute(
    runId: string,
    body?: {
      disputeId?: string;
      disputeType?: "quality" | "delivery" | "fraud" | "policy" | "payment" | "other";
      disputePriority?: "low" | "normal" | "high" | "critical";
      disputeChannel?: "counterparty" | "policy_engine" | "arbiter" | "external";
      escalationLevel?: "l1_counterparty" | "l2_arbiter" | "l3_external";
      openedByAgentId?: string;
      reason?: string;
      evidenceRefs?: string[];
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      settlement: AgentRunSettlementV1;
      disputeEvidence?: RunDisputeEvidenceSubmissionV1 | null;
      disputeEscalation?: RunDisputeEscalationV1 | null;
      verdict?: Record<string, unknown> | null;
      verdictArtifact?: Record<string, unknown> | null;
    }>
  >;
  closeRunDispute(
    runId: string,
    body?: {
      disputeId?: string;
      resolution?: Partial<RunDisputeResolutionV1> | null;
      resolutionOutcome?: "accepted" | "rejected" | "partial" | "withdrawn" | "unresolved";
      resolutionEscalationLevel?: "l1_counterparty" | "l2_arbiter" | "l3_external";
      resolutionSummary?: string;
      closedByAgentId?: string;
      resolutionEvidenceRefs?: string[];
      verdict?: Record<string, unknown>;
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      settlement: AgentRunSettlementV1;
      disputeEvidence?: RunDisputeEvidenceSubmissionV1 | null;
      disputeEscalation?: RunDisputeEscalationV1 | null;
      verdict?: Record<string, unknown> | null;
      verdictArtifact?: Record<string, unknown> | null;
    }>
  >;
  submitRunDisputeEvidence(
    runId: string,
    body: {
      evidenceRef: string;
      disputeId?: string;
      submittedByAgentId?: string;
      reason?: string;
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      settlement: AgentRunSettlementV1;
      disputeEvidence?: RunDisputeEvidenceSubmissionV1 | null;
      disputeEscalation?: RunDisputeEscalationV1 | null;
      verdict?: Record<string, unknown> | null;
      verdictArtifact?: Record<string, unknown> | null;
    }>
  >;
  escalateRunDispute(
    runId: string,
    body: {
      escalationLevel: "l1_counterparty" | "l2_arbiter" | "l3_external";
      disputeId?: string;
      channel?: "counterparty" | "policy_engine" | "arbiter" | "external";
      escalatedByAgentId?: string;
      reason?: string;
    },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      settlement: AgentRunSettlementV1;
      disputeEvidence?: RunDisputeEvidenceSubmissionV1 | null;
      disputeEscalation?: RunDisputeEscalationV1 | null;
      verdict?: Record<string, unknown> | null;
      verdictArtifact?: Record<string, unknown> | null;
    }>
  >;
  firstVerifiedRun(params: FirstVerifiedRunParams, opts?: FirstVerifiedRunOptions): Promise<FirstVerifiedRunResult>;
  quoteJob(jobId: string, body: Record<string, unknown>, opts: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  bookJob(jobId: string, body: Record<string, unknown>, opts: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  appendJobEvent(jobId: string, body: Record<string, unknown>, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;

  opsStatus(opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  listPartyStatements(
    params: { period: string; partyId?: string; status?: string },
    opts?: RequestOptions
  ): Promise<NooterraResponse<Record<string, unknown>>>;
  getPartyStatement(partyId: string, period: string, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  enqueuePayout(partyId: string, period: string, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;

  requestMonthClose(body: { month: string; basis?: string }, opts?: RequestOptions): Promise<NooterraResponse<Record<string, unknown>>>;
  getTenantAnalytics(
    tenantId: string,
    params?: TenantAnalyticsQuery,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ ok: true; report: Record<string, unknown> }>>;
  getTenantTrustGraph(
    tenantId: string,
    params?: TenantTrustGraphQuery,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ ok: true; graph: Record<string, unknown> }>>;
  listTenantTrustGraphSnapshots(
    tenantId: string,
    params?: { limit?: number },
    opts?: RequestOptions
  ): Promise<
    NooterraResponse<{
      ok: true;
      schemaVersion: "MagicLinkTrustGraphSnapshotList.v1";
      tenantId: string;
      generatedAt: string;
      count: number;
      rows: Array<Record<string, unknown>>;
    }>
  >;
  createTenantTrustGraphSnapshot(
    tenantId: string,
    body?: TenantTrustGraphSnapshotCreateInput,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ ok: true; snapshot: Record<string, unknown> }>>;
  diffTenantTrustGraph(
    tenantId: string,
    params?: TenantTrustGraphDiffQuery,
    opts?: RequestOptions
  ): Promise<NooterraResponse<{ ok: true; diff: Record<string, unknown> }>>;
}
