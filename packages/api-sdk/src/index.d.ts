export type ProtocolVersion = `${number}.${number}`;

export type SettldClientOptions = {
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
  signal?: AbortSignal;
};

export type SettldError = {
  status: number;
  code?: string | null;
  message: string;
  details?: unknown;
  requestId?: string | null;
};

export type SettldResponse<T> = {
  ok: boolean;
  status: number;
  requestId: string | null;
  body: T;
  headers: Record<string, string>;
};

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
  payeeRegistration: SettldResponse<{ agentIdentity: AgentIdentityV1; keyId: string }>;
  payerRegistration: SettldResponse<{ agentIdentity: AgentIdentityV1; keyId: string }> | null;
  payerCredit: SettldResponse<{ wallet: AgentWalletV1 }> | null;
  runCreated: SettldResponse<{ run: AgentRunV1; event: AgentEventV1; settlement?: AgentRunSettlementV1 | null }>;
  runStarted: SettldResponse<{ event: AgentEventV1; run: AgentRunV1; settlement?: AgentRunSettlementV1 | null }>;
  runEvidenceAdded: SettldResponse<{ event: AgentEventV1; run: AgentRunV1; settlement?: AgentRunSettlementV1 | null }>;
  runCompleted: SettldResponse<{ event: AgentEventV1; run: AgentRunV1; settlement?: AgentRunSettlementV1 | null }>;
  run: SettldResponse<{ run: AgentRunV1; verification: Record<string, unknown>; settlement?: AgentRunSettlementV1 | null }>;
  verification: SettldResponse<Record<string, unknown>>;
  settlement: SettldResponse<{ settlement: AgentRunSettlementV1 }> | null;
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
  holdResponse: SettldResponse<{ hold: Record<string, unknown> }>;
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

export class SettldClient {
  constructor(opts: SettldClientOptions);

  capabilities(opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  openApi(opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;

  createJob(body: { templateId: string } & Record<string, unknown>, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  getJob(jobId: string, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  registerAgent(
    body: AgentRegistrationInput,
    opts?: RequestOptions
  ): Promise<SettldResponse<{ agentIdentity: AgentIdentityV1; keyId: string }>>;
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
  ): Promise<SettldResponse<{ agents: AgentIdentityV1[]; reputations?: Record<string, AgentReputation>; limit: number; offset: number }>>;
  getAgent(agentId: string, opts?: RequestOptions): Promise<SettldResponse<{ agentIdentity: AgentIdentityV1 }>>;
  getAgentReputation(
    agentId: string,
    opts?: RequestOptions & { reputationVersion?: "v1" | "v2"; reputationWindow?: "7d" | "30d" | "allTime" }
  ): Promise<SettldResponse<{ reputation: AgentReputation }>>;
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
    SettldResponse<{
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
  ): Promise<SettldResponse<{ policy: TenantSettlementPolicyV1 }>>;
  listMarketplaceSettlementPolicies(
    params?: { policyId?: string; limit?: number; offset?: number },
    opts?: RequestOptions
  ): Promise<SettldResponse<{ policies: TenantSettlementPolicyV1[]; total: number; limit: number; offset: number }>>;
  getMarketplaceSettlementPolicy(
    policyId: string,
    policyVersion: number,
    opts?: RequestOptions
  ): Promise<SettldResponse<{ policy: TenantSettlementPolicyV1 }>>;
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
  ): Promise<SettldResponse<{ rfq: MarketplaceRfqV1 }>>;
  listMarketplaceRfqs(
    params?: {
      status?: "open" | "assigned" | "cancelled" | "closed" | "all";
      capability?: string;
      posterAgentId?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<SettldResponse<{ rfqs: MarketplaceRfqV1[]; total: number; limit: number; offset: number }>>;
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
  ): Promise<SettldResponse<{ rfq: MarketplaceRfqV1; bid: MarketplaceRfqBidV1 }>>;
  listMarketplaceBids(
    rfqId: string,
    params?: {
      status?: "pending" | "accepted" | "rejected" | "all";
      bidderAgentId?: string;
      limit?: number;
      offset?: number;
    },
    opts?: RequestOptions
  ): Promise<SettldResponse<{ rfqId: string; bids: MarketplaceRfqBidV1[]; total: number; limit: number; offset: number }>>;
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
    SettldResponse<{
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
    SettldResponse<{
      rfq: MarketplaceRfqV1;
      acceptedBid: MarketplaceRfqBidV1 | null;
      run: AgentRunV1;
      settlement: AgentRunSettlementV1;
      agreement: MarketplaceTaskAgreementV2;
    }>
  >;
  getAgentWallet(agentId: string, opts?: RequestOptions): Promise<SettldResponse<{ wallet: AgentWalletV1 }>>;
  creditAgentWallet(
    agentId: string,
    body: { amountCents: number; currency?: string },
    opts?: RequestOptions
  ): Promise<SettldResponse<{ wallet: AgentWalletV1 }>>;
  createAgentRun(
    agentId: string,
    body?: {
      runId?: string;
      taskType?: string;
      inputRef?: string;
      settlement?: { payerAgentId: string; amountCents: number; currency?: string };
    },
    opts?: RequestOptions
  ): Promise<SettldResponse<{ run: AgentRunV1; event: AgentEventV1; settlement?: AgentRunSettlementV1 | null }>>;
  listAgentRuns(
    agentId: string,
    params?: { status?: "created" | "running" | "completed" | "failed"; limit?: number; offset?: number },
    opts?: RequestOptions
  ): Promise<SettldResponse<{ runs: AgentRunV1[]; total: number; limit: number; offset: number }>>;
  getAgentRun(
    agentId: string,
    runId: string,
    opts?: RequestOptions
  ): Promise<SettldResponse<{ run: AgentRunV1; verification: Record<string, unknown>; settlement?: AgentRunSettlementV1 | null }>>;
  listAgentRunEvents(agentId: string, runId: string, opts?: RequestOptions): Promise<SettldResponse<{ events: AgentEventV1[] }>>;
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
  ): Promise<SettldResponse<{ event: AgentEventV1; run: AgentRunV1; settlement?: AgentRunSettlementV1 | null }>>;
  getRunVerification(runId: string, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  getRunSettlement(runId: string, opts?: RequestOptions): Promise<SettldResponse<{ settlement: AgentRunSettlementV1 }>>;
  getRunAgreement(
    runId: string,
    opts?: RequestOptions
  ): Promise<
    SettldResponse<{
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
    SettldResponse<{
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
    SettldResponse<{
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
    SettldResponse<{
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
  ): Promise<SettldResponse<{ settlement: AgentRunSettlementV1 }>>;

  opsLockToolCallHold(body: Record<string, unknown>, opts?: RequestOptions): Promise<SettldResponse<{ hold: Record<string, unknown> }>>;
  opsListToolCallHolds(
    params?: { agreementHash?: string; status?: string; limit?: number; offset?: number },
    opts?: RequestOptions
  ): Promise<
    SettldResponse<{
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
    SettldResponse<{
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
  opsGetToolCallHold(holdHash: string, opts?: RequestOptions): Promise<SettldResponse<{ ok: boolean; tenantId: string; hold: Record<string, unknown> }>>;
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
    SettldResponse<{
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
  ): Promise<SettldResponse<Record<string, unknown>>>;
  toolCallListArbitrationCases(
    params?: { agreementHash?: string; status?: string },
    opts?: RequestOptions
  ): Promise<
    SettldResponse<{
      agreementHash: string;
      runId: string;
      cases: Array<Record<string, unknown>>;
    }>
  >;
  toolCallGetArbitrationCase(caseId: string, opts?: RequestOptions): Promise<SettldResponse<{ caseId: string; arbitrationCase: Record<string, unknown> }>>;
  toolCallOpenArbitration(body: Record<string, unknown>, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  toolCallSubmitArbitrationVerdict(body: Record<string, unknown>, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  opsGetSettlementAdjustment(adjustmentId: string, opts?: RequestOptions): Promise<SettldResponse<{ ok: boolean; tenantId: string; adjustment: Record<string, unknown> }>>;
  getArtifact(artifactId: string, opts?: RequestOptions): Promise<SettldResponse<{ artifact: Record<string, unknown> }>>;
  getArtifacts(
    params: { artifactIds: string[] } | string[],
    opts?: RequestOptions
  ): Promise<{ artifacts: Array<{ artifactId: string; artifact: Record<string, unknown> | null }>; responses: Array<SettldResponse<{ artifact: Record<string, unknown> }>> }>;

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
  ): Promise<SettldResponse<{ hold: Record<string, unknown> }>>;
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
  ): Promise<SettldResponse<Record<string, unknown>>>;
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
    SettldResponse<{
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
    SettldResponse<{
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
    SettldResponse<{
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
    SettldResponse<{
      settlement: AgentRunSettlementV1;
      disputeEvidence?: RunDisputeEvidenceSubmissionV1 | null;
      disputeEscalation?: RunDisputeEscalationV1 | null;
      verdict?: Record<string, unknown> | null;
      verdictArtifact?: Record<string, unknown> | null;
    }>
  >;
  firstVerifiedRun(params: FirstVerifiedRunParams, opts?: FirstVerifiedRunOptions): Promise<FirstVerifiedRunResult>;
  quoteJob(jobId: string, body: Record<string, unknown>, opts: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  bookJob(jobId: string, body: Record<string, unknown>, opts: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  appendJobEvent(jobId: string, body: Record<string, unknown>, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;

  opsStatus(opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  listPartyStatements(
    params: { period: string; partyId?: string; status?: string },
    opts?: RequestOptions
  ): Promise<SettldResponse<Record<string, unknown>>>;
  getPartyStatement(partyId: string, period: string, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  enqueuePayout(partyId: string, period: string, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;

  requestMonthClose(body: { month: string; basis?: string }, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  getTenantAnalytics(
    tenantId: string,
    params?: TenantAnalyticsQuery,
    opts?: RequestOptions
  ): Promise<SettldResponse<{ ok: true; report: Record<string, unknown> }>>;
  getTenantTrustGraph(
    tenantId: string,
    params?: TenantTrustGraphQuery,
    opts?: RequestOptions
  ): Promise<SettldResponse<{ ok: true; graph: Record<string, unknown> }>>;
  listTenantTrustGraphSnapshots(
    tenantId: string,
    params?: { limit?: number },
    opts?: RequestOptions
  ): Promise<
    SettldResponse<{
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
  ): Promise<SettldResponse<{ ok: true; snapshot: Record<string, unknown> }>>;
  diffTenantTrustGraph(
    tenantId: string,
    params?: TenantTrustGraphDiffQuery,
    opts?: RequestOptions
  ): Promise<SettldResponse<{ ok: true; diff: Record<string, unknown> }>>;
}
