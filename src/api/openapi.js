import fs from "node:fs";
import path from "node:path";

import { SETTLD_PROTOCOL_CURRENT } from "../core/protocol.js";

function readRepoVersion() {
  try {
    const p = path.resolve(process.cwd(), "SETTLD_VERSION");
    const raw = fs.readFileSync(p, "utf8");
    const v = String(raw).trim();
    return v || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildOpenApiSpec({ baseUrl = null } = {}) {
  const version = readRepoVersion();

  const TenantHeader = {
    name: "x-proxy-tenant-id",
    in: "header",
    required: true,
    schema: { type: "string", example: "tenant_default" },
    description: "Tenant scope for the request."
  };

  const ProtocolHeader = {
    name: "x-settld-protocol",
    in: "header",
    required: true,
    schema: { type: "string", example: SETTLD_PROTOCOL_CURRENT },
    description: "Client protocol version (major.minor). Required in production."
  };

  const RequestIdHeader = {
    name: "x-request-id",
    in: "header",
    required: false,
    schema: { type: "string" },
    description: "Optional request ID (echoed in responses)."
  };

  const IdempotencyHeader = {
    name: "x-idempotency-key",
    in: "header",
    required: false,
    schema: { type: "string" },
    description: "Optional idempotency key. If reused, request body must match."
  };

  const ExpectedPrevChainHashHeader = {
    name: "x-proxy-expected-prev-chain-hash",
    in: "header",
    required: true,
    schema: { type: "string" },
    description: "Optimistic concurrency precondition for append-style endpoints."
  };

  const ErrorResponse = {
    type: "object",
    additionalProperties: true,
    properties: {
      error: { type: "string" },
      code: { type: "string" },
      details: {}
    }
  };

  const JobCreateRequest = {
    type: "object",
    additionalProperties: false,
    required: ["templateId"],
    properties: {
      templateId: { type: "string" },
      customerId: { type: "string", nullable: true },
      siteId: { type: "string", nullable: true },
      contractId: { type: "string", nullable: true },
      constraints: { type: "object", additionalProperties: true }
    }
  };

  const JobQuoteRequest = {
    type: "object",
    additionalProperties: false,
    required: ["startAt", "endAt", "environmentTier"],
    properties: {
      startAt: { type: "string", format: "date-time" },
      endAt: { type: "string", format: "date-time" },
      environmentTier: { type: "string" },
      requiresOperatorCoverage: { type: "boolean" },
      zoneId: { type: "string" },
      customerId: { type: "string" },
      siteId: { type: "string" },
      contractId: { type: "string" }
    }
  };

  const JobBookRequest = {
    type: "object",
    additionalProperties: false,
    required: ["startAt", "endAt", "environmentTier"],
    properties: {
      paymentHoldId: { type: "string", nullable: true },
      startAt: { type: "string", format: "date-time" },
      endAt: { type: "string", format: "date-time" },
      environmentTier: { type: "string" },
      requiresOperatorCoverage: { type: "boolean" },
      zoneId: { type: "string" },
      customerId: { type: "string" },
      siteId: { type: "string" },
      contractId: { type: "string" }
    }
  };

  const JobEventAppendRequest = {
    type: "object",
    additionalProperties: false,
    required: ["type", "payload"],
    properties: {
      type: { type: "string" },
      at: { type: "string", format: "date-time" },
      actor: { type: "object", additionalProperties: true },
      payload: { type: "object", additionalProperties: true },
      signature: { type: "string" },
      signerKeyId: { type: "string" }
    }
  };

  const AgentIdentityV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "agentId", "tenantId", "displayName", "status", "owner", "keys", "capabilities", "createdAt", "updatedAt"],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentIdentity.v1"] },
      agentId: { type: "string" },
      tenantId: { type: "string" },
      displayName: { type: "string" },
      description: { type: "string", nullable: true },
      status: { type: "string", enum: ["active", "suspended", "revoked"] },
      owner: {
        type: "object",
        additionalProperties: false,
        required: ["ownerType", "ownerId"],
        properties: {
          ownerType: { type: "string", enum: ["human", "business", "service"] },
          ownerId: { type: "string" }
        }
      },
      keys: {
        type: "object",
        additionalProperties: false,
        required: ["keyId", "algorithm", "publicKeyPem"],
        properties: {
          keyId: { type: "string" },
          algorithm: { type: "string", enum: ["ed25519"] },
          publicKeyPem: { type: "string" }
        }
      },
      capabilities: { type: "array", items: { type: "string" } },
      walletPolicy: {
        type: "object",
        nullable: true,
        additionalProperties: false,
        properties: {
          maxPerTransactionCents: { type: "integer", minimum: 0 },
          maxDailyCents: { type: "integer", minimum: 0 },
          requireApprovalAboveCents: { type: "integer", minimum: 0 }
        }
      },
      metadata: { type: "object", nullable: true, additionalProperties: true },
      revision: { type: "integer", minimum: 0 },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  };

  const AgentRegisterRequest = {
    type: "object",
    additionalProperties: false,
    required: ["publicKeyPem"],
    properties: {
      agentId: { type: "string" },
      displayName: { type: "string" },
      description: { type: "string" },
      status: { type: "string", enum: ["active", "suspended", "revoked"] },
      ownerType: { type: "string", enum: ["human", "business", "service"] },
      ownerId: { type: "string" },
      owner: {
        type: "object",
        additionalProperties: false,
        properties: {
          ownerType: { type: "string", enum: ["human", "business", "service"] },
          ownerId: { type: "string" }
        }
      },
      publicKeyPem: { type: "string" },
      capabilities: { type: "array", items: { type: "string" } },
      walletPolicy: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxPerTransactionCents: { type: "integer", minimum: 0 },
          maxDailyCents: { type: "integer", minimum: 0 },
          requireApprovalAboveCents: { type: "integer", minimum: 0 }
        }
      },
      metadata: { type: "object", additionalProperties: true }
    }
  };

  const AgentRunV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "runId", "agentId", "tenantId", "status", "createdAt", "updatedAt"],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentRun.v1"] },
      runId: { type: "string" },
      agentId: { type: "string" },
      tenantId: { type: "string" },
      taskType: { type: "string", nullable: true },
      inputRef: { type: "string", nullable: true },
      status: { type: "string", enum: ["created", "running", "completed", "failed"] },
      evidenceRefs: { type: "array", items: { type: "string" } },
      metrics: { type: "object", nullable: true, additionalProperties: true },
      failure: {
        type: "object",
        nullable: true,
        additionalProperties: false,
        properties: {
          code: { type: "string", nullable: true },
          message: { type: "string", nullable: true }
        }
      },
      startedAt: { type: "string", format: "date-time", nullable: true },
      completedAt: { type: "string", format: "date-time", nullable: true },
      failedAt: { type: "string", format: "date-time", nullable: true },
      lastEventId: { type: "string", nullable: true },
      lastChainHash: { type: "string", nullable: true },
      revision: { type: "integer", minimum: 0 },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  };

  const AgentEventV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "v", "id", "streamId", "type", "at", "actor", "payload"],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentEvent.v1"] },
      v: { type: "integer", enum: [1] },
      id: { type: "string" },
      streamId: { type: "string" },
      type: {
        type: "string",
        enum: ["RUN_CREATED", "RUN_STARTED", "RUN_HEARTBEAT", "EVIDENCE_ADDED", "RUN_COMPLETED", "RUN_FAILED"]
      },
      at: { type: "string", format: "date-time" },
      actor: { type: "object", additionalProperties: true },
      payload: { type: "object", additionalProperties: true },
      payloadHash: { type: "string", nullable: true },
      prevChainHash: { type: "string", nullable: true },
      chainHash: { type: "string", nullable: true },
      signature: { type: "string", nullable: true },
      signerKeyId: { type: "string", nullable: true }
    }
  };

  const AgentRunCreateRequest = {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: { type: "string" },
      taskType: { type: "string" },
      inputRef: { type: "string" },
      settlement: {
        type: "object",
        additionalProperties: false,
        required: ["payerAgentId", "amountCents"],
        properties: {
          payerAgentId: { type: "string" },
          amountCents: { type: "integer", minimum: 1 },
          currency: { type: "string" }
        }
      }
    }
  };

  const AgentRunEventAppendRequest = {
    type: "object",
    additionalProperties: false,
    required: ["type", "payload"],
    properties: {
      type: { type: "string", enum: ["RUN_STARTED", "RUN_HEARTBEAT", "EVIDENCE_ADDED", "RUN_COMPLETED", "RUN_FAILED"] },
      at: { type: "string", format: "date-time" },
      actor: { type: "object", additionalProperties: true },
      payload: { type: "object", additionalProperties: true }
    }
  };

  const AgentWalletV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "walletId",
      "agentId",
      "tenantId",
      "currency",
      "availableCents",
      "escrowLockedCents",
      "totalDebitedCents",
      "totalCreditedCents",
      "revision",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentWallet.v1"] },
      walletId: { type: "string" },
      agentId: { type: "string" },
      tenantId: { type: "string" },
      currency: { type: "string" },
      availableCents: { type: "integer", minimum: 0 },
      escrowLockedCents: { type: "integer", minimum: 0 },
      totalDebitedCents: { type: "integer", minimum: 0 },
      totalCreditedCents: { type: "integer", minimum: 0 },
      revision: { type: "integer", minimum: 0 },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  };

  const AgentRunSettlementV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "settlementId",
      "runId",
      "tenantId",
      "agentId",
      "payerAgentId",
      "amountCents",
      "currency",
      "status",
      "lockedAt",
      "revision",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentRunSettlement.v1"] },
      settlementId: { type: "string" },
      runId: { type: "string" },
      tenantId: { type: "string" },
      agentId: { type: "string" },
      payerAgentId: { type: "string" },
      amountCents: { type: "integer", minimum: 1 },
      currency: { type: "string" },
      status: { type: "string", enum: ["locked", "released", "refunded"] },
      lockedAt: { type: "string", format: "date-time" },
      resolvedAt: { type: "string", format: "date-time", nullable: true },
      resolutionEventId: { type: "string", nullable: true },
      runStatus: { type: "string", nullable: true },
      releasedAmountCents: { type: "integer", minimum: 0 },
      refundedAmountCents: { type: "integer", minimum: 0 },
      releaseRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
      disputeWindowDays: { type: "integer", minimum: 0 },
      disputeWindowEndsAt: { type: "string", format: "date-time", nullable: true },
      disputeStatus: { type: "string", enum: ["none", "open", "closed"], nullable: true },
      disputeId: { type: "string", nullable: true },
      disputeOpenedAt: { type: "string", format: "date-time", nullable: true },
      disputeClosedAt: { type: "string", format: "date-time", nullable: true },
      disputeVerdictId: { type: "string", nullable: true },
      disputeVerdictHash: { type: "string", nullable: true },
      disputeVerdictArtifactId: { type: "string", nullable: true },
      disputeVerdictSignerKeyId: { type: "string", nullable: true },
      disputeVerdictIssuedAt: { type: "string", format: "date-time", nullable: true },
      disputeContext: {
        type: "object",
        additionalProperties: false,
        nullable: true,
        properties: {
          type: { type: "string", enum: ["quality", "delivery", "fraud", "policy", "payment", "other"] },
          priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
          channel: { type: "string", enum: ["counterparty", "policy_engine", "arbiter", "external"] },
          escalationLevel: { type: "string", enum: ["l1_counterparty", "l2_arbiter", "l3_external"] },
          openedByAgentId: { type: "string", nullable: true },
          reason: { type: "string", nullable: true },
          evidenceRefs: { type: "array", items: { type: "string" } }
        }
      },
      disputeResolution: {
        type: "object",
        additionalProperties: false,
        nullable: true,
        properties: {
          outcome: { type: "string", enum: ["accepted", "rejected", "partial", "withdrawn", "unresolved"] },
          escalationLevel: { type: "string", enum: ["l1_counterparty", "l2_arbiter", "l3_external"] },
          closedByAgentId: { type: "string", nullable: true },
          summary: { type: "string", nullable: true },
          closedAt: { type: "string", format: "date-time", nullable: true },
          evidenceRefs: { type: "array", items: { type: "string" } }
        }
      },
      decisionStatus: {
        type: "string",
        enum: ["pending", "auto_resolved", "manual_review_required", "manual_resolved"],
        nullable: true
      },
      decisionMode: { type: "string", enum: ["automatic", "manual-review"], nullable: true },
      decisionPolicyHash: { type: "string", nullable: true },
      decisionReason: { type: "string", nullable: true },
      decisionTrace: { type: "object", additionalProperties: true, nullable: true },
      decisionUpdatedAt: { type: "string", format: "date-time", nullable: true },
      revision: { type: "integer", minimum: 0 },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  };

  const AgentReputationV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "agentId",
      "tenantId",
      "trustScore",
      "riskTier",
      "totalRuns",
      "terminalRuns",
      "createdRuns",
      "runningRuns",
      "completedRuns",
      "failedRuns",
      "runsWithEvidence",
      "totalSettlements",
      "lockedSettlements",
      "releasedSettlements",
      "refundedSettlements",
      "runCompletionRatePct",
      "evidenceCoverageRatePct",
      "settlementReleaseRatePct",
      "avgRunDurationMs",
      "scoreBreakdown",
      "computedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentReputation.v1"] },
      agentId: { type: "string" },
      tenantId: { type: "string" },
      trustScore: { type: "integer", minimum: 0, maximum: 100 },
      riskTier: { type: "string", enum: ["low", "guarded", "elevated", "high"] },
      totalRuns: { type: "integer", minimum: 0 },
      terminalRuns: { type: "integer", minimum: 0 },
      createdRuns: { type: "integer", minimum: 0 },
      runningRuns: { type: "integer", minimum: 0 },
      completedRuns: { type: "integer", minimum: 0 },
      failedRuns: { type: "integer", minimum: 0 },
      runsWithEvidence: { type: "integer", minimum: 0 },
      totalSettlements: { type: "integer", minimum: 0 },
      lockedSettlements: { type: "integer", minimum: 0 },
      releasedSettlements: { type: "integer", minimum: 0 },
      refundedSettlements: { type: "integer", minimum: 0 },
      runCompletionRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
      evidenceCoverageRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
      settlementReleaseRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
      avgRunDurationMs: { type: "integer", minimum: 0, nullable: true },
      scoreBreakdown: {
        type: "object",
        additionalProperties: false,
        required: ["runQuality", "settlementQuality", "evidenceQuality", "activityScore"],
        properties: {
          runQuality: { type: "integer", minimum: 0, maximum: 100 },
          settlementQuality: { type: "integer", minimum: 0, maximum: 100 },
          evidenceQuality: { type: "integer", minimum: 0, maximum: 100 },
          activityScore: { type: "integer", minimum: 0, maximum: 100 }
        }
      },
      computedAt: { type: "string", format: "date-time" }
    }
  };

  const AgentReputationWindowV2 = {
    type: "object",
    additionalProperties: false,
    required: [
      "trustScore",
      "riskTier",
      "totalRuns",
      "terminalRuns",
      "createdRuns",
      "runningRuns",
      "completedRuns",
      "failedRuns",
      "runsWithEvidence",
      "totalSettlements",
      "lockedSettlements",
      "releasedSettlements",
      "refundedSettlements",
      "runCompletionRatePct",
      "evidenceCoverageRatePct",
      "settlementReleaseRatePct",
      "avgRunDurationMs",
      "scoreBreakdown",
      "computedAt"
    ],
    properties: {
      trustScore: { type: "integer", minimum: 0, maximum: 100 },
      riskTier: { type: "string", enum: ["low", "guarded", "elevated", "high"] },
      totalRuns: { type: "integer", minimum: 0 },
      terminalRuns: { type: "integer", minimum: 0 },
      createdRuns: { type: "integer", minimum: 0 },
      runningRuns: { type: "integer", minimum: 0 },
      completedRuns: { type: "integer", minimum: 0 },
      failedRuns: { type: "integer", minimum: 0 },
      runsWithEvidence: { type: "integer", minimum: 0 },
      totalSettlements: { type: "integer", minimum: 0 },
      lockedSettlements: { type: "integer", minimum: 0 },
      releasedSettlements: { type: "integer", minimum: 0 },
      refundedSettlements: { type: "integer", minimum: 0 },
      runCompletionRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
      evidenceCoverageRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
      settlementReleaseRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
      avgRunDurationMs: { type: "integer", minimum: 0, nullable: true },
      scoreBreakdown: AgentReputationV1.properties.scoreBreakdown,
      computedAt: { type: "string", format: "date-time" }
    }
  };

  const AgentReputationV2 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "agentId", "tenantId", "primaryWindow", "trustScore", "riskTier", "windows", "computedAt"],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentReputation.v2"] },
      agentId: { type: "string" },
      tenantId: { type: "string" },
      primaryWindow: { type: "string", enum: ["7d", "30d", "allTime"] },
      trustScore: { type: "integer", minimum: 0, maximum: 100 },
      riskTier: { type: "string", enum: ["low", "guarded", "elevated", "high"] },
      windows: {
        type: "object",
        additionalProperties: false,
        required: ["7d", "30d", "allTime"],
        properties: {
          "7d": AgentReputationWindowV2,
          "30d": AgentReputationWindowV2,
          allTime: AgentReputationWindowV2
        }
      },
      computedAt: { type: "string", format: "date-time" }
    }
  };

  const AgentReputationAny = {
    oneOf: [AgentReputationV1, AgentReputationV2]
  };

  const InteractionDirectionEntityType = {
    type: "string",
    enum: ["agent", "human", "robot", "machine"]
  };

  const VerificationMethodV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "mode"],
    properties: {
      schemaVersion: { type: "string", enum: ["VerificationMethod.v1"] },
      mode: { type: "string", enum: ["deterministic", "attested", "discretionary"] },
      source: { type: "string", nullable: true },
      attestor: { type: "string", nullable: true },
      notes: { type: "string", nullable: true }
    }
  };

  const SettlementPolicyV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "policyVersion", "mode", "rules", "policyHash"],
    properties: {
      schemaVersion: { type: "string", enum: ["SettlementPolicy.v1"] },
      policyVersion: { type: "integer", minimum: 1 },
      mode: { type: "string", enum: ["automatic", "manual-review"] },
      policyHash: { type: "string" },
      rules: {
        type: "object",
        additionalProperties: false,
        required: [
          "requireDeterministicVerification",
          "autoReleaseOnGreen",
          "autoReleaseOnAmber",
          "autoReleaseOnRed",
          "greenReleaseRatePct",
          "amberReleaseRatePct",
          "redReleaseRatePct"
        ],
        properties: {
          requireDeterministicVerification: { type: "boolean" },
          autoReleaseOnGreen: { type: "boolean" },
          autoReleaseOnAmber: { type: "boolean" },
          autoReleaseOnRed: { type: "boolean" },
          greenReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
          amberReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
          redReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
          maxAutoReleaseAmountCents: { type: "integer", nullable: true, minimum: 1 },
          manualReason: { type: "string", nullable: true }
        }
      }
    }
  };

  const MarketplaceSettlementPolicyRefV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "source", "policyVersion", "policyHash", "verificationMethodHash"],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceSettlementPolicyRef.v1"] },
      source: { type: "string", enum: ["tenant_registry", "inline"] },
      policyId: { type: "string", nullable: true },
      policyVersion: { type: "integer", minimum: 1 },
      policyHash: { type: "string" },
      verificationMethodHash: { type: "string" }
    }
  };

  const TenantSettlementPolicyV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "tenantId",
      "policyId",
      "policyVersion",
      "policyHash",
      "verificationMethodHash",
      "verificationMethod",
      "policy",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["TenantSettlementPolicy.v1"] },
      tenantId: { type: "string" },
      policyId: { type: "string" },
      policyVersion: { type: "integer", minimum: 1 },
      policyHash: { type: "string" },
      verificationMethodHash: { type: "string" },
      verificationMethod: VerificationMethodV1,
      policy: SettlementPolicyV1,
      description: { type: "string", nullable: true },
      metadata: { type: "object", additionalProperties: true, nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  };

  const MarketplaceAgreementMilestoneV1 = {
    type: "object",
    additionalProperties: false,
    required: ["milestoneId", "releaseRatePct", "statusGate"],
    properties: {
      milestoneId: { type: "string" },
      label: { type: "string", nullable: true },
      releaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
      statusGate: { type: "string", enum: ["green", "amber", "red", "any"] },
      requiredEvidenceCount: { type: "integer", minimum: 0, nullable: true }
    }
  };

  const MarketplaceAgreementCancellationV1 = {
    type: "object",
    additionalProperties: false,
    required: ["allowCancellationBeforeStart", "killFeeRatePct", "requireEvidenceOnCancellation", "requireCounterpartyAcceptance"],
    properties: {
      allowCancellationBeforeStart: { type: "boolean" },
      killFeeRatePct: { type: "integer", minimum: 0, maximum: 100 },
      requireEvidenceOnCancellation: { type: "boolean" },
      requireCounterpartyAcceptance: { type: "boolean" }
    }
  };

  const MarketplaceAgreementChangeOrderPolicyV1 = {
    type: "object",
    additionalProperties: false,
    required: ["enabled", "maxChangeOrders", "requireCounterpartyAcceptance"],
    properties: {
      enabled: { type: "boolean" },
      maxChangeOrders: { type: "integer", minimum: 0 },
      requireCounterpartyAcceptance: { type: "boolean" }
    }
  };

  const MarketplaceAgreementTermsV1 = {
    type: "object",
    additionalProperties: false,
    required: ["milestones", "cancellation", "changeOrderPolicy", "changeOrders"],
    properties: {
      title: { type: "string", nullable: true },
      capability: { type: "string", nullable: true },
      deadlineAt: { type: "string", format: "date-time", nullable: true },
      etaSeconds: { type: "integer", nullable: true, minimum: 1 },
      milestones: { type: "array", items: MarketplaceAgreementMilestoneV1 },
      cancellation: MarketplaceAgreementCancellationV1,
      changeOrderPolicy: MarketplaceAgreementChangeOrderPolicyV1,
      changeOrders: { type: "array", items: { type: "object", additionalProperties: true } }
    }
  };

  const MarketplaceAgreementTermsInput = {
    type: "object",
    additionalProperties: false,
    properties: {
      milestones: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["milestoneId", "releaseRatePct"],
          properties: {
            milestoneId: { type: "string" },
            label: { type: "string" },
            releaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
            statusGate: { type: "string", enum: ["green", "amber", "red", "any"] },
            requiredEvidenceCount: { type: "integer", minimum: 0 }
          }
        }
      },
      cancellation: {
        type: "object",
        additionalProperties: false,
        properties: {
          allowCancellationBeforeStart: { type: "boolean" },
          killFeeRatePct: { type: "integer", minimum: 0, maximum: 100 },
          requireEvidenceOnCancellation: { type: "boolean" },
          requireCounterpartyAcceptance: { type: "boolean" }
        }
      },
      changeOrderPolicy: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          maxChangeOrders: { type: "integer", minimum: 0 },
          requireCounterpartyAcceptance: { type: "boolean" }
        }
      }
    }
  };

  const MarketplaceCounterOfferPolicyV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "allowPosterCounterOffers",
      "allowBidderCounterOffers",
      "maxRevisions",
      "timeoutSeconds"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceCounterOfferPolicy.v1"] },
      allowPosterCounterOffers: { type: "boolean" },
      allowBidderCounterOffers: { type: "boolean" },
      maxRevisions: { type: "integer", minimum: 1 },
      timeoutSeconds: { type: "integer", minimum: 1 }
    }
  };

  const MarketplaceBidAcceptanceV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "acceptedAt", "acceptedByAgentId", "acceptedProposalId", "acceptedRevision"],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceBidAcceptance.v1"] },
      acceptedAt: { type: "string", format: "date-time" },
      acceptedByAgentId: { type: "string", nullable: true },
      acceptedProposalId: { type: "string", nullable: true },
      acceptedRevision: { type: "integer", minimum: 1, nullable: true }
    }
  };

  const MarketplaceAgreementAcceptanceV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "acceptedAt",
      "acceptedByAgentId",
      "acceptedProposalId",
      "acceptedRevision",
      "acceptedProposalHash",
      "offerChainHash",
      "proposalCount"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementAcceptance.v1"] },
      acceptedAt: { type: "string", format: "date-time", nullable: true },
      acceptedByAgentId: { type: "string", nullable: true },
      acceptedProposalId: { type: "string", nullable: true },
      acceptedRevision: { type: "integer", minimum: 1, nullable: true },
      acceptedProposalHash: { type: "string", nullable: true },
      offerChainHash: { type: "string", nullable: true },
      proposalCount: { type: "integer", minimum: 1 }
    }
  };

  const AgentDelegationLinkV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "delegationId",
      "tenantId",
      "principalAgentId",
      "delegateAgentId",
      "issuedAt",
      "signerKeyId",
      "delegationHash",
      "signature"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentDelegationLink.v1"] },
      delegationId: { type: "string" },
      tenantId: { type: "string" },
      principalAgentId: { type: "string" },
      delegateAgentId: { type: "string" },
      scope: { type: "string", nullable: true },
      issuedAt: { type: "string", format: "date-time" },
      expiresAt: { type: "string", format: "date-time", nullable: true },
      signerKeyId: { type: "string" },
      delegationHash: { type: "string" },
      signature: { type: "string" }
    }
  };

  const AgentActingOnBehalfOfV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "principalAgentId", "delegationChain"],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentActingOnBehalfOf.v1"] },
      principalAgentId: { type: "string" },
      delegateAgentId: { type: "string", nullable: true },
      delegationChain: { type: "array", minItems: 1, items: AgentDelegationLinkV1 },
      chainHash: { type: "string", nullable: true }
    }
  };

  const MarketplaceAgreementAcceptanceSignatureV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "agreementId",
      "tenantId",
      "taskId",
      "runId",
      "bidId",
      "acceptedByAgentId",
      "acceptedProposalId",
      "acceptedRevision",
      "acceptedProposalHash",
      "offerChainHash",
      "proposalCount",
      "signerAgentId",
      "signerKeyId",
      "signedAt",
      "acceptanceHash",
      "signature"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementAcceptanceSignature.v1"] },
      agreementId: { type: "string" },
      tenantId: { type: "string" },
      taskId: { type: "string" },
      runId: { type: "string" },
      bidId: { type: "string" },
      acceptedByAgentId: { type: "string" },
      acceptedProposalId: { type: "string", nullable: true },
      acceptedRevision: { type: "integer", minimum: 1, nullable: true },
      acceptedProposalHash: { type: "string", nullable: true },
      offerChainHash: { type: "string", nullable: true },
      proposalCount: { type: "integer", minimum: 1, nullable: true },
      actingOnBehalfOfPrincipalAgentId: { type: "string", nullable: true },
      actingOnBehalfOfDelegateAgentId: { type: "string", nullable: true },
      actingOnBehalfOfChainHash: { type: "string", nullable: true },
      signerAgentId: { type: "string" },
      signerKeyId: { type: "string" },
      signedAt: { type: "string", format: "date-time" },
      actingOnBehalfOf: { allOf: [AgentActingOnBehalfOfV1], nullable: true },
      acceptanceHash: { type: "string" },
      signature: { type: "string" }
    }
  };

  const MarketplaceAgreementChangeOrderAcceptanceSignatureV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "tenantId",
      "runId",
      "agreementId",
      "taskId",
      "bidId",
      "changeOrderId",
      "requestedByAgentId",
      "acceptedByAgentId",
      "reason",
      "previousTermsHash",
      "milestonesHash",
      "cancellationHash",
      "signerAgentId",
      "signerKeyId",
      "signedAt",
      "acceptanceHash",
      "signature"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementChangeOrderAcceptanceSignature.v1"] },
      tenantId: { type: "string" },
      runId: { type: "string" },
      agreementId: { type: "string" },
      taskId: { type: "string" },
      bidId: { type: "string" },
      changeOrderId: { type: "string" },
      requestedByAgentId: { type: "string" },
      acceptedByAgentId: { type: "string" },
      reason: { type: "string" },
      note: { type: "string", nullable: true },
      previousTermsHash: { type: "string", nullable: true },
      milestonesHash: { type: "string" },
      cancellationHash: { type: "string" },
      actingOnBehalfOfPrincipalAgentId: { type: "string", nullable: true },
      actingOnBehalfOfDelegateAgentId: { type: "string", nullable: true },
      actingOnBehalfOfChainHash: { type: "string", nullable: true },
      signerAgentId: { type: "string" },
      signerKeyId: { type: "string" },
      signedAt: { type: "string", format: "date-time" },
      actingOnBehalfOf: { allOf: [AgentActingOnBehalfOfV1], nullable: true },
      acceptanceHash: { type: "string" },
      signature: { type: "string" }
    }
  };

  const MarketplaceAgreementCancellationAcceptanceSignatureV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "tenantId",
      "runId",
      "agreementId",
      "taskId",
      "bidId",
      "cancellationId",
      "cancelledByAgentId",
      "acceptedByAgentId",
      "reason",
      "termsHash",
      "killFeeRatePct",
      "signerAgentId",
      "signerKeyId",
      "signedAt",
      "acceptanceHash",
      "signature"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementCancellationAcceptanceSignature.v1"] },
      tenantId: { type: "string" },
      runId: { type: "string" },
      agreementId: { type: "string" },
      taskId: { type: "string" },
      bidId: { type: "string" },
      cancellationId: { type: "string" },
      cancelledByAgentId: { type: "string" },
      acceptedByAgentId: { type: "string" },
      reason: { type: "string" },
      evidenceRef: { type: "string", nullable: true },
      termsHash: { type: "string" },
      killFeeRatePct: { type: "integer", minimum: 0, maximum: 100 },
      actingOnBehalfOfPrincipalAgentId: { type: "string", nullable: true },
      actingOnBehalfOfDelegateAgentId: { type: "string", nullable: true },
      actingOnBehalfOfChainHash: { type: "string", nullable: true },
      signerAgentId: { type: "string" },
      signerKeyId: { type: "string" },
      signedAt: { type: "string", format: "date-time" },
      actingOnBehalfOf: { allOf: [AgentActingOnBehalfOfV1], nullable: true },
      acceptanceHash: { type: "string" },
      signature: { type: "string" }
    }
  };

  const MarketplaceAgreementAcceptanceSignatureInput = {
    type: "object",
    additionalProperties: false,
    required: ["signerKeyId", "signature"],
    properties: {
      signerAgentId: { type: "string" },
      signerKeyId: { type: "string" },
      signedAt: { type: "string", format: "date-time" },
      actingOnBehalfOf: AgentActingOnBehalfOfV1,
      signature: { type: "string" }
    }
  };

  const MarketplaceAgreementPolicyBindingV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "agreementId",
      "tenantId",
      "taskId",
      "runId",
      "bidId",
      "acceptedAt",
      "acceptedByAgentId",
      "offerChainHash",
      "acceptedProposalId",
      "acceptedRevision",
      "acceptedProposalHash",
      "termsHash",
      "policyHash",
      "verificationMethodHash",
      "policyRefHash",
      "policyRef",
      "signerKeyId",
      "signedAt",
      "bindingHash",
      "signature"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementPolicyBinding.v1"] },
      agreementId: { type: "string" },
      tenantId: { type: "string" },
      taskId: { type: "string" },
      runId: { type: "string" },
      bidId: { type: "string" },
      acceptedAt: { type: "string", format: "date-time", nullable: true },
      acceptedByAgentId: { type: "string", nullable: true },
      offerChainHash: { type: "string", nullable: true },
      acceptedProposalId: { type: "string", nullable: true },
      acceptedRevision: { type: "integer", minimum: 1, nullable: true },
      acceptedProposalHash: { type: "string", nullable: true },
      termsHash: { type: "string" },
      policyHash: { type: "string" },
      verificationMethodHash: { type: "string" },
      policyRefHash: { type: "string" },
      policyRef: MarketplaceSettlementPolicyRefV1,
      signerKeyId: { type: "string" },
      signedAt: { type: "string", format: "date-time" },
      bindingHash: { type: "string" },
      signature: { type: "string" }
    }
  };

  const MarketplaceBidNegotiationProposalV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "proposalId",
      "bidId",
      "revision",
      "proposerAgentId",
      "amountCents",
      "currency",
      "verificationMethod",
      "policy",
      "policyRef",
      "proposedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceBidProposal.v1"] },
      proposalId: { type: "string" },
      bidId: { type: "string" },
      revision: { type: "integer", minimum: 1 },
      proposerAgentId: { type: "string" },
      amountCents: { type: "integer", minimum: 1 },
      currency: { type: "string" },
      etaSeconds: { type: "integer", minimum: 1, nullable: true },
      note: { type: "string", nullable: true },
      verificationMethod: VerificationMethodV1,
      policy: SettlementPolicyV1,
      policyRef: MarketplaceSettlementPolicyRefV1,
      policyRefHash: { type: "string" },
      prevProposalHash: { type: "string", nullable: true },
      proposalHash: { type: "string" },
      metadata: { type: "object", additionalProperties: true, nullable: true },
      proposedAt: { type: "string", format: "date-time" }
    }
  };

  const MarketplaceBidNegotiationV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "bidId", "state", "latestRevision", "proposals", "createdAt", "updatedAt"],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceBidNegotiation.v1"] },
      bidId: { type: "string" },
      state: { type: "string", enum: ["open", "accepted", "rejected", "cancelled", "expired"] },
      latestRevision: { type: "integer", minimum: 1 },
      acceptedRevision: { type: "integer", minimum: 1, nullable: true },
      acceptedProposalId: { type: "string", nullable: true },
      acceptedAt: { type: "string", format: "date-time", nullable: true },
      acceptance: { ...MarketplaceBidAcceptanceV1, nullable: true },
      counterOfferPolicy: MarketplaceCounterOfferPolicyV1,
      expiresAt: { type: "string", format: "date-time", nullable: true },
      expiredAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      proposals: {
        type: "array",
        minItems: 1,
        items: MarketplaceBidNegotiationProposalV1
      }
    }
  };

  const MarketplaceAgreementNegotiationV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "state", "latestRevision", "acceptedRevision", "acceptedProposalId", "proposalCount"],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementNegotiation.v1"] },
      state: { type: "string", enum: ["open", "accepted", "rejected", "cancelled", "expired"] },
      latestRevision: { type: "integer", minimum: 1 },
      acceptedRevision: { type: "integer", minimum: 1, nullable: true },
      acceptedProposalId: { type: "string", nullable: true },
      proposalCount: { type: "integer", minimum: 1 }
    }
  };

  const MarketplaceTaskV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "taskId", "tenantId", "title", "status", "currency", "createdAt", "updatedAt"],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceTask.v1"] },
      taskId: { type: "string" },
      tenantId: { type: "string" },
      title: { type: "string" },
      description: { type: "string", nullable: true },
      capability: { type: "string", nullable: true },
      fromType: InteractionDirectionEntityType,
      toType: InteractionDirectionEntityType,
      posterAgentId: { type: "string", nullable: true },
      status: { type: "string", enum: ["open", "assigned", "cancelled", "closed"] },
      budgetCents: { type: "integer", nullable: true, minimum: 1 },
      currency: { type: "string" },
      deadlineAt: { type: "string", format: "date-time", nullable: true },
      acceptedBidId: { type: "string", nullable: true },
      acceptedBidderAgentId: { type: "string", nullable: true },
      acceptedAt: { type: "string", format: "date-time", nullable: true },
      acceptedByAgentId: { type: "string", nullable: true },
      counterOfferPolicy: { ...MarketplaceCounterOfferPolicyV1, nullable: true },
      runId: { type: "string", nullable: true },
      agreementId: { type: "string", nullable: true },
      agreement: {
        type: "object",
        additionalProperties: true,
        nullable: true
      },
      settlementId: { type: "string", nullable: true },
      settlementStatus: { type: "string", enum: ["locked", "released", "refunded"], nullable: true },
      settlementResolvedAt: { type: "string", format: "date-time", nullable: true },
      settlementReleaseRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
      settlementDecisionStatus: {
        type: "string",
        enum: ["pending", "auto_resolved", "manual_review_required", "manual_resolved"],
        nullable: true
      },
      settlementDecisionReason: { type: "string", nullable: true },
      metadata: { type: "object", additionalProperties: true, nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  };

  const MarketplaceTaskAgreementV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "agreementId",
      "tenantId",
      "taskId",
      "runId",
      "bidId",
      "payerAgentId",
      "payeeAgentId",
      "fromType",
      "toType",
      "amountCents",
      "currency",
      "acceptedAt",
      "disputeWindowDays",
      "termsHash",
      "verificationMethodHash",
      "policyHash",
      "policyRef"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceTaskAgreement.v1"] },
      agreementId: { type: "string" },
      tenantId: { type: "string" },
      taskId: { type: "string" },
      runId: { type: "string" },
      bidId: { type: "string" },
      payerAgentId: { type: "string" },
      payeeAgentId: { type: "string" },
      fromType: InteractionDirectionEntityType,
      toType: InteractionDirectionEntityType,
      amountCents: { type: "integer", minimum: 1 },
      currency: { type: "string" },
      acceptedAt: { type: "string", format: "date-time" },
      acceptedByAgentId: { type: "string", nullable: true },
      disputeWindowDays: { type: "integer", minimum: 0 },
      agreementRevision: { type: "integer", minimum: 1, nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true },
      offerChainHash: { type: "string", nullable: true },
      acceptedProposalId: { type: "string", nullable: true },
      acceptedRevision: { type: "integer", minimum: 1, nullable: true },
      acceptedProposalHash: { type: "string", nullable: true },
      negotiation: { ...MarketplaceAgreementNegotiationV1, nullable: true },
      acceptance: { ...MarketplaceAgreementAcceptanceV1, nullable: true },
      acceptanceSignature: { ...MarketplaceAgreementAcceptanceSignatureV1, nullable: true },
      termsHash: { type: "string" },
      verificationMethodHash: { type: "string" },
      policyHash: { type: "string" },
      policyRef: MarketplaceSettlementPolicyRefV1,
      policyBinding: { ...MarketplaceAgreementPolicyBindingV1, nullable: true },
      verificationMethod: VerificationMethodV1,
      policy: SettlementPolicyV1,
      terms: MarketplaceAgreementTermsV1
    }
  };

  const MarketplaceTaskCreateRequest = {
    type: "object",
    additionalProperties: false,
    properties: {
      taskId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      capability: { type: "string" },
      fromType: InteractionDirectionEntityType,
      toType: InteractionDirectionEntityType,
      posterAgentId: { type: "string" },
      budgetCents: { type: "integer", minimum: 1 },
      currency: { type: "string" },
      deadlineAt: { type: "string", format: "date-time" },
      counterOfferPolicy: {
        type: "object",
        additionalProperties: false,
        properties: {
          allowPosterCounterOffers: { type: "boolean" },
          allowBidderCounterOffers: { type: "boolean" },
          maxRevisions: { type: "integer", minimum: 1 },
          timeoutSeconds: { type: "integer", minimum: 1 }
        }
      },
      metadata: { type: "object", additionalProperties: true }
    }
  };

  const MarketplaceBidV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "bidId",
      "taskId",
      "tenantId",
      "bidderAgentId",
      "amountCents",
      "currency",
      "status",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceBid.v1"] },
      bidId: { type: "string" },
      taskId: { type: "string" },
      tenantId: { type: "string" },
      fromType: InteractionDirectionEntityType,
      toType: InteractionDirectionEntityType,
      bidderAgentId: { type: "string" },
      amountCents: { type: "integer", minimum: 1 },
      currency: { type: "string" },
      etaSeconds: { type: "integer", nullable: true, minimum: 1 },
      note: { type: "string", nullable: true },
      verificationMethod: VerificationMethodV1,
      policy: SettlementPolicyV1,
      policyRef: { ...MarketplaceSettlementPolicyRefV1, nullable: true },
      status: { type: "string", enum: ["pending", "accepted", "rejected"] },
      acceptedAt: { type: "string", format: "date-time", nullable: true },
      rejectedAt: { type: "string", format: "date-time", nullable: true },
      negotiation: { ...MarketplaceBidNegotiationV1, nullable: true },
      counterOfferPolicy: { ...MarketplaceCounterOfferPolicyV1, nullable: true },
      metadata: { type: "object", additionalProperties: true, nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  };

  const MarketplaceBidCreateRequest = {
    type: "object",
    additionalProperties: false,
    required: ["bidderAgentId", "amountCents"],
    properties: {
      bidId: { type: "string" },
      proposalId: { type: "string" },
      fromType: InteractionDirectionEntityType,
      toType: InteractionDirectionEntityType,
      bidderAgentId: { type: "string" },
      amountCents: { type: "integer", minimum: 1 },
      currency: { type: "string" },
      etaSeconds: { type: "integer", minimum: 1 },
      note: { type: "string" },
      verificationMethod: {
        type: "object",
        additionalProperties: false,
        properties: {
          verificationMethodHash: { type: "string" },
          mode: { type: "string", enum: ["deterministic", "attested", "discretionary"] },
          source: { type: "string" },
          attestor: { type: "string" },
          notes: { type: "string" }
        }
      },
      policy: {
        type: "object",
        additionalProperties: false,
        properties: {
          policyHash: { type: "string" },
          policyVersion: { type: "integer", minimum: 1 },
          mode: { type: "string", enum: ["automatic", "manual-review"] },
          rules: {
            type: "object",
            additionalProperties: false,
            properties: {
              requireDeterministicVerification: { type: "boolean" },
              autoReleaseOnGreen: { type: "boolean" },
              autoReleaseOnAmber: { type: "boolean" },
              autoReleaseOnRed: { type: "boolean" },
              greenReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              amberReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              redReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              maxAutoReleaseAmountCents: { type: "integer", minimum: 1 },
              manualReason: { type: "string" }
            }
          }
        }
      },
      policyRef: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", enum: ["tenant_registry", "inline"] },
          policyId: { type: "string" },
          policyVersion: { type: "integer", minimum: 1 },
          policyHash: { type: "string" },
          verificationMethodHash: { type: "string" }
        }
      },
      metadata: { type: "object", additionalProperties: true }
    }
  };

  const MarketplaceBidCounterOfferRequest = {
    type: "object",
    additionalProperties: false,
    required: ["proposerAgentId"],
    properties: {
      proposalId: { type: "string" },
      proposerAgentId: { type: "string" },
      amountCents: { type: "integer", minimum: 1 },
      currency: { type: "string" },
      etaSeconds: { type: "integer", minimum: 1, nullable: true },
      note: { type: "string", nullable: true },
      verificationMethod: {
        type: "object",
        additionalProperties: false,
        properties: {
          verificationMethodHash: { type: "string" },
          mode: { type: "string", enum: ["deterministic", "attested", "discretionary"] },
          source: { type: "string" },
          attestor: { type: "string" },
          notes: { type: "string" }
        }
      },
      policy: {
        type: "object",
        additionalProperties: false,
        properties: {
          policyHash: { type: "string" },
          policyVersion: { type: "integer", minimum: 1 },
          mode: { type: "string", enum: ["automatic", "manual-review"] },
          rules: {
            type: "object",
            additionalProperties: false,
            properties: {
              requireDeterministicVerification: { type: "boolean" },
              autoReleaseOnGreen: { type: "boolean" },
              autoReleaseOnAmber: { type: "boolean" },
              autoReleaseOnRed: { type: "boolean" },
              greenReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              amberReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              redReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              maxAutoReleaseAmountCents: { type: "integer", minimum: 1 },
              manualReason: { type: "string" }
            }
          }
        }
      },
      policyRef: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", enum: ["tenant_registry", "inline"] },
          policyId: { type: "string" },
          policyVersion: { type: "integer", minimum: 1 },
          policyHash: { type: "string" },
          verificationMethodHash: { type: "string" }
        }
      },
      metadata: { type: "object", additionalProperties: true, nullable: true }
    }
  };

  const MarketplaceBidAcceptRequest = {
    type: "object",
    additionalProperties: false,
    required: ["bidId"],
    properties: {
      bidId: { type: "string" },
      acceptedByAgentId: { type: "string" },
      runId: { type: "string" },
      taskType: { type: "string" },
      inputRef: { type: "string" },
      payerAgentId: { type: "string" },
      fromType: InteractionDirectionEntityType,
      toType: InteractionDirectionEntityType,
      disputeWindowDays: { type: "integer", minimum: 0 },
      acceptanceSignature: MarketplaceAgreementAcceptanceSignatureInput,
      agreementTerms: MarketplaceAgreementTermsInput,
      verificationMethod: {
        type: "object",
        additionalProperties: false,
        properties: {
          verificationMethodHash: { type: "string" },
          mode: { type: "string", enum: ["deterministic", "attested", "discretionary"] },
          source: { type: "string" },
          attestor: { type: "string" },
          notes: { type: "string" }
        }
      },
      policy: {
        type: "object",
        additionalProperties: false,
        properties: {
          policyHash: { type: "string" },
          policyVersion: { type: "integer", minimum: 1 },
          mode: { type: "string", enum: ["automatic", "manual-review"] },
          rules: {
            type: "object",
            additionalProperties: false,
            properties: {
              requireDeterministicVerification: { type: "boolean" },
              autoReleaseOnGreen: { type: "boolean" },
              autoReleaseOnAmber: { type: "boolean" },
              autoReleaseOnRed: { type: "boolean" },
              greenReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              amberReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              redReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              maxAutoReleaseAmountCents: { type: "integer", minimum: 1 },
              manualReason: { type: "string" }
            }
          }
        }
      },
      policyRef: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", enum: ["tenant_registry", "inline"] },
          policyId: { type: "string" },
          policyVersion: { type: "integer", minimum: 1 },
          policyHash: { type: "string" },
          verificationMethodHash: { type: "string" }
        }
      },
      settlement: {
        type: "object",
        additionalProperties: false,
        properties: {
          payerAgentId: { type: "string" },
          fromType: InteractionDirectionEntityType,
          toType: InteractionDirectionEntityType,
          amountCents: { type: "integer", minimum: 1 },
          currency: { type: "string" },
          disputeWindowDays: { type: "integer", minimum: 0 },
          agreementTerms: MarketplaceAgreementTermsInput,
          verificationMethod: {
            type: "object",
            additionalProperties: false,
            properties: {
              verificationMethodHash: { type: "string" },
              mode: { type: "string", enum: ["deterministic", "attested", "discretionary"] },
              source: { type: "string" },
              attestor: { type: "string" },
              notes: { type: "string" }
            }
          },
          policy: {
            type: "object",
            additionalProperties: false,
            properties: {
              policyHash: { type: "string" },
              policyVersion: { type: "integer", minimum: 1 },
              mode: { type: "string", enum: ["automatic", "manual-review"] },
              rules: {
                type: "object",
                additionalProperties: false,
                properties: {
                  requireDeterministicVerification: { type: "boolean" },
                  autoReleaseOnGreen: { type: "boolean" },
                  autoReleaseOnAmber: { type: "boolean" },
                  autoReleaseOnRed: { type: "boolean" },
                  greenReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
                  amberReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
                  redReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
                  maxAutoReleaseAmountCents: { type: "integer", minimum: 1 },
                  manualReason: { type: "string" }
                }
              }
            }
          },
          policyRef: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: { type: "string", enum: ["tenant_registry", "inline"] },
              policyId: { type: "string" },
              policyVersion: { type: "integer", minimum: 1 },
              policyHash: { type: "string" },
              verificationMethodHash: { type: "string" }
            }
          }
        }
      }
    }
  };

  const TenantSettlementPolicyUpsertRequest = {
    type: "object",
    additionalProperties: false,
    required: ["policyId", "policy"],
    properties: {
      policyId: { type: "string" },
      policyVersion: { type: "integer", minimum: 1 },
      verificationMethod: {
        type: "object",
        additionalProperties: false,
        properties: {
          verificationMethodHash: { type: "string" },
          mode: { type: "string", enum: ["deterministic", "attested", "discretionary"] },
          source: { type: "string" },
          attestor: { type: "string" },
          notes: { type: "string" }
        }
      },
      policy: {
        type: "object",
        additionalProperties: false,
        properties: {
          policyHash: { type: "string" },
          policyVersion: { type: "integer", minimum: 1 },
          mode: { type: "string", enum: ["automatic", "manual-review"] },
          rules: {
            type: "object",
            additionalProperties: false,
            properties: {
              requireDeterministicVerification: { type: "boolean" },
              autoReleaseOnGreen: { type: "boolean" },
              autoReleaseOnAmber: { type: "boolean" },
              autoReleaseOnRed: { type: "boolean" },
              greenReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              amberReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              redReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
              maxAutoReleaseAmountCents: { type: "integer", minimum: 1 },
              manualReason: { type: "string" }
            }
          }
        }
      },
      description: { type: "string" },
      metadata: { type: "object", additionalProperties: true }
    }
  };

  const AgentWalletCreditRequest = {
    type: "object",
    additionalProperties: false,
    required: ["amountCents"],
    properties: {
      amountCents: { type: "integer", minimum: 1 },
      currency: { type: "string" }
    }
  };

  const RunSettlementResolveRequest = {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["released", "refunded"] },
      releaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
      releasedAmountCents: { type: "integer", minimum: 0 },
      refundedAmountCents: { type: "integer", minimum: 0 },
      reason: { type: "string" },
      resolvedByAgentId: { type: "string" },
      resolutionEventId: { type: "string" }
    }
  };

  const RunAgreementChangeOrderRequest = {
    type: "object",
    additionalProperties: false,
    required: ["requestedByAgentId", "reason"],
    properties: {
      changeOrderId: { type: "string" },
      requestedByAgentId: { type: "string" },
      acceptedByAgentId: { type: "string" },
      acceptanceSignature: MarketplaceAgreementAcceptanceSignatureInput,
      reason: { type: "string" },
      note: { type: "string" },
      milestones: MarketplaceAgreementTermsInput.properties.milestones,
      cancellation: MarketplaceAgreementTermsInput.properties.cancellation
    }
  };

  const RunAgreementCancelRequest = {
    type: "object",
    additionalProperties: false,
    required: ["cancelledByAgentId", "reason"],
    properties: {
      cancellationId: { type: "string" },
      cancelledByAgentId: { type: "string" },
      acceptedByAgentId: { type: "string" },
      acceptanceSignature: MarketplaceAgreementAcceptanceSignatureInput,
      reason: { type: "string" },
      evidenceRef: { type: "string" }
    }
  };

  const RunAgreementCancelResponse = {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: { type: "string" },
      task: MarketplaceTaskV1,
      run: AgentRunV1,
      settlement: AgentRunSettlementV1,
      agreement: { allOf: [MarketplaceTaskAgreementV1], nullable: true },
      cancellation: { type: "object", additionalProperties: true },
      acceptanceSignatureVerification: { type: "object", additionalProperties: true }
    }
  };

  const DisputeVerdictSignedRequest = {
    type: "object",
    additionalProperties: false,
    required: ["verdictId", "arbiterAgentId", "outcome", "signerKeyId", "signature"],
    properties: {
      verdictId: { type: "string" },
      arbiterAgentId: { type: "string" },
      outcome: { type: "string", enum: ["accepted", "rejected", "partial"] },
      releaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
      rationale: { type: "string" },
      issuedAt: { type: "string", format: "date-time" },
      signerKeyId: { type: "string" },
      signature: { type: "string" }
    }
  };

  const RunSettlementPolicyReplayResponse = {
    type: "object",
    additionalProperties: false,
    required: ["runId", "runStatus", "verificationStatus", "replay", "settlement", "matchesStoredDecision"],
    properties: {
      runId: { type: "string" },
      agreementId: { type: "string", nullable: true },
      policyVersion: { type: "integer", nullable: true },
      policyHash: { type: "string", nullable: true },
      verificationMethodHash: { type: "string", nullable: true },
      policyRef: { allOf: [MarketplaceSettlementPolicyRefV1], nullable: true },
      policyBinding: { allOf: [MarketplaceAgreementPolicyBindingV1], nullable: true },
      policyBindingVerification: { type: "object", additionalProperties: true },
      acceptanceSignatureVerification: { type: "object", additionalProperties: true },
      runStatus: { type: "string", nullable: true },
      verificationStatus: { type: "string", enum: ["green", "amber", "red"] },
      replay: { type: "object", additionalProperties: true },
      settlement: AgentRunSettlementV1,
      matchesStoredDecision: { type: "boolean" }
    }
  };

  const MonthCloseRequest = {
    type: "object",
    additionalProperties: false,
    required: ["month"],
    properties: {
      month: { type: "string", example: "2026-02" },
      basis: { type: "string", example: "settledAt" }
    }
  };

  const AckRequest = {
    type: "object",
    additionalProperties: false,
    required: ["deliveryId"],
    properties: {
      deliveryId: { type: ["string", "integer"] },
      artifactHash: { type: "string" },
      receivedAt: { type: "string", format: "date-time" }
    }
  };

  const ArtifactVerificationSummary = {
    type: "object",
    additionalProperties: true,
    properties: {
      verificationStatus: { type: "string", enum: ["green", "amber", "red"] },
      proofStatus: { type: "string", nullable: true },
      reasonCodes: { type: "array", items: { type: "string" } },
      missingEvidence: { type: "array", items: { type: "string" } },
      evidenceCount: { type: "integer" },
      activeEvidenceCount: { type: "integer" },
      slaCompliancePct: { type: "integer", nullable: true }
    }
  };

  const OpsJobListItem = {
    type: "object",
    additionalProperties: true,
    properties: {
      verificationStatus: { type: "string", enum: ["green", "amber", "red"] },
      evidenceCount: { type: "integer" },
      activeEvidenceCount: { type: "integer" },
      slaCompliancePct: { type: "integer", nullable: true },
      verification: ArtifactVerificationSummary
    }
  };

  const OpsJobsListResponse = {
    type: "object",
    additionalProperties: false,
    required: ["jobs", "total", "offset", "limit"],
    properties: {
      jobs: { type: "array", items: OpsJobListItem },
      total: { type: "integer" },
      offset: { type: "integer" },
      limit: { type: "integer" }
    }
  };

  const CommandCenterReasonCount = {
    type: "object",
    additionalProperties: false,
    required: ["reason", "count"],
    properties: {
      reason: { type: "string" },
      count: { type: "integer", minimum: 0 }
    }
  };

  const CommandCenterDestinationCount = {
    type: "object",
    additionalProperties: false,
    required: ["destinationId", "count"],
    properties: {
      destinationId: { type: "string" },
      count: { type: "integer", minimum: 0 }
    }
  };

  const OpsNetworkCommandCenterSummary = {
    type: "object",
    additionalProperties: false,
    required: ["generatedAt", "freshness", "reliability", "determinism", "settlement", "disputes", "revenue", "trust"],
    properties: {
      generatedAt: { type: "string", format: "date-time" },
      freshness: {
        type: "object",
        additionalProperties: false,
        required: ["maxAgeSeconds", "generatedWithinSla"],
        properties: {
          maxAgeSeconds: { type: "integer", minimum: 0 },
          generatedWithinSla: { type: "boolean" }
        }
      },
      reliability: {
        type: "object",
        additionalProperties: false,
        required: ["httpRequestsTotal", "http4xxTotal", "http5xxTotal", "httpClientErrorRatePct", "httpServerErrorRatePct", "backlog"],
        properties: {
          httpRequestsTotal: { type: "integer", minimum: 0 },
          http4xxTotal: { type: "integer", minimum: 0 },
          http5xxTotal: { type: "integer", minimum: 0 },
          httpClientErrorRatePct: { type: "number", minimum: 0 },
          httpServerErrorRatePct: { type: "number", minimum: 0 },
          backlog: {
            type: "object",
            additionalProperties: false,
            required: ["deliveriesPending", "deliveriesFailed", "ingestRejected", "deliveryDlqTopDestinations"],
            properties: {
              outboxByKind: {
                type: "object",
                nullable: true,
                additionalProperties: { type: "integer", minimum: 0 }
              },
              deliveriesPending: { type: "integer", minimum: 0 },
              deliveriesFailed: { type: "integer", minimum: 0 },
              ingestRejected: { type: "integer", minimum: 0 },
              deliveryDlqTopDestinations: { type: "array", items: CommandCenterDestinationCount }
            }
          }
        }
      },
      determinism: {
        type: "object",
        additionalProperties: false,
        required: ["appendRejectedTopReasons", "ingestRejectedTopReasons", "determinismSensitiveRejects"],
        properties: {
          appendRejectedTopReasons: { type: "array", items: CommandCenterReasonCount },
          ingestRejectedTopReasons: { type: "array", items: CommandCenterReasonCount },
          determinismSensitiveRejects: { type: "integer", minimum: 0 }
        }
      },
      settlement: {
        type: "object",
        additionalProperties: false,
        required: ["windowHours", "resolvedCount", "lockedCount", "settlementAmountCents", "releasedAmountCents", "refundedAmountCents"],
        properties: {
          windowHours: { type: "integer", minimum: 1 },
          resolvedCount: { type: "integer", minimum: 0 },
          lockedCount: { type: "integer", minimum: 0 },
          settlementAmountCents: { type: "integer", minimum: 0 },
          releasedAmountCents: { type: "integer", minimum: 0 },
          refundedAmountCents: { type: "integer", minimum: 0 }
        }
      },
      disputes: {
        type: "object",
        additionalProperties: false,
        required: ["openCount", "openedCountInWindow", "closedCountInWindow", "oldestOpenAgeSeconds", "overSlaCount", "expiredWindowOpenCount"],
        properties: {
          openCount: { type: "integer", minimum: 0 },
          openedCountInWindow: { type: "integer", minimum: 0 },
          closedCountInWindow: { type: "integer", minimum: 0 },
          oldestOpenAgeSeconds: { type: "integer", minimum: 0 },
          overSlaCount: { type: "integer", minimum: 0 },
          expiredWindowOpenCount: { type: "integer", minimum: 0 }
        }
      },
      revenue: {
        type: "object",
        additionalProperties: false,
        required: ["transactionFeeBps", "estimatedTransactionFeesCentsInWindow"],
        properties: {
          transactionFeeBps: { type: "integer", minimum: 0, maximum: 5000 },
          estimatedTransactionFeesCentsInWindow: { type: "integer", minimum: 0 },
          currentPlatformRevenueCents: { type: "integer", nullable: true }
        }
      },
      trust: {
        type: "object",
        additionalProperties: false,
        required: ["totalAgents", "activeAgents", "sampledAgents", "averageTrustScore"],
        properties: {
          totalAgents: { type: "integer", minimum: 0 },
          activeAgents: { type: "integer", minimum: 0 },
          sampledAgents: { type: "integer", minimum: 0 },
          averageTrustScore: { type: "number", minimum: 0, maximum: 100, nullable: true }
        }
      }
    }
  };

  const OpsNetworkCommandCenterResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "tenantId", "commandCenter"],
    properties: {
      ok: { type: "boolean" },
      tenantId: { type: "string" },
      commandCenter: OpsNetworkCommandCenterSummary,
      alerts: {
        type: "object",
        nullable: true,
        additionalProperties: false,
        properties: {
          evaluatedCount: { type: "integer", minimum: 0 },
          breachCount: { type: "integer", minimum: 0 },
          emittedCount: { type: "integer", minimum: 0 },
          emitted: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                alertType: { type: "string" },
                severity: { type: "string" },
                artifactId: { type: "string" },
                artifactHash: { type: "string" },
                deliveriesCreated: { type: "integer", minimum: 0 }
              }
            }
          }
        }
      }
    }
  };

  const OpsFinanceReconcileResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "tenantId", "period", "reportHash", "reconcile", "inputs"],
    properties: {
      ok: { type: "boolean" },
      tenantId: { type: "string" },
      period: { type: "string", example: "2026-01" },
      reportHash: { type: "string" },
      reconcile: { type: "object", additionalProperties: true },
      inputs: {
        type: "object",
        additionalProperties: false,
        required: ["glBatchArtifactId", "glBatchArtifactHash", "partyStatementArtifactIds", "partyStatementArtifactHashes"],
        properties: {
          glBatchArtifactId: { type: "string" },
          glBatchArtifactHash: { type: "string" },
          partyStatementArtifactIds: { type: "array", items: { type: "string" } },
          partyStatementArtifactHashes: { type: "array", items: { type: "string" } }
        }
      },
      artifact: {
        type: "object",
        nullable: true,
        additionalProperties: false,
        properties: {
          artifactId: { type: "string" },
          artifactHash: { type: "string" },
          deliveriesCreated: { type: "integer", minimum: 0 }
        }
      }
    }
  };

  const MagicLinkAnalyticsReportResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "report"],
    properties: {
      ok: { type: "boolean" },
      report: { type: "object", additionalProperties: true }
    }
  };

  const MagicLinkTrustGraphResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "graph"],
    properties: {
      ok: { type: "boolean" },
      graph: { type: "object", additionalProperties: true }
    }
  };

  const MagicLinkTrustGraphSnapshotCreateRequest = {
    type: "object",
    additionalProperties: false,
    properties: {
      month: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}$", example: "2026-02" },
      minRuns: { type: "integer", minimum: 1, maximum: 100000 },
      maxEdges: { type: "integer", minimum: 1, maximum: 2000 }
    }
  };

  const MagicLinkTrustGraphSnapshotListResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "schemaVersion", "tenantId", "generatedAt", "count", "rows"],
    properties: {
      ok: { type: "boolean" },
      schemaVersion: { type: "string", enum: ["MagicLinkTrustGraphSnapshotList.v1"] },
      tenantId: { type: "string" },
      generatedAt: { type: "string", format: "date-time" },
      count: { type: "integer", minimum: 0 },
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            month: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}$" },
            generatedAt: { type: "string", format: "date-time", nullable: true },
            source: { type: "string", nullable: true },
            nodes: { type: "integer", minimum: 0 },
            edges: { type: "integer", minimum: 0 },
            runs: { type: "integer", minimum: 0 }
          }
        }
      }
    }
  };

  const MagicLinkTrustGraphSnapshotCreateResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "snapshot"],
    properties: {
      ok: { type: "boolean" },
      snapshot: { type: "object", additionalProperties: true }
    }
  };

  const MagicLinkTrustGraphDiffResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "diff"],
    properties: {
      ok: { type: "boolean" },
      diff: { type: "object", additionalProperties: true }
    }
  };

  const spec = {
    openapi: "3.0.3",
    info: {
      title: "Settld API",
      version,
      description: "Settld system-of-record API (protocol-gated).",
      "x-settld-protocol": SETTLD_PROTOCOL_CURRENT
    },
    servers: baseUrl ? [{ url: baseUrl }] : undefined,
    components: {
      securitySchemes: {
        BearerAuth: { type: "http", scheme: "bearer" },
        ProxyApiKey: { type: "apiKey", in: "header", name: "x-proxy-api-key" }
      },
      schemas: {
        ErrorResponse,
        JobCreateRequest,
        JobQuoteRequest,
        JobBookRequest,
        JobEventAppendRequest,
        AgentIdentityV1,
        AgentRegisterRequest,
        AgentRunV1,
        AgentEventV1,
        AgentRunCreateRequest,
        AgentRunEventAppendRequest,
        AgentWalletV1,
        AgentRunSettlementV1,
        AgentReputationV1,
        AgentReputationWindowV2,
        AgentReputationV2,
        AgentReputationAny,
        VerificationMethodV1,
        SettlementPolicyV1,
        MarketplaceSettlementPolicyRefV1,
        TenantSettlementPolicyV1,
        MarketplaceAgreementMilestoneV1,
        MarketplaceAgreementCancellationV1,
        MarketplaceAgreementChangeOrderPolicyV1,
        MarketplaceAgreementTermsV1,
        MarketplaceAgreementTermsInput,
        MarketplaceCounterOfferPolicyV1,
        MarketplaceBidAcceptanceV1,
        MarketplaceAgreementAcceptanceV1,
        AgentDelegationLinkV1,
        AgentActingOnBehalfOfV1,
        MarketplaceAgreementAcceptanceSignatureV1,
        MarketplaceAgreementChangeOrderAcceptanceSignatureV1,
        MarketplaceAgreementCancellationAcceptanceSignatureV1,
        MarketplaceAgreementAcceptanceSignatureInput,
        MarketplaceAgreementPolicyBindingV1,
        MarketplaceBidNegotiationProposalV1,
        MarketplaceBidNegotiationV1,
        MarketplaceAgreementNegotiationV1,
        MarketplaceTaskV1,
        MarketplaceTaskAgreementV1,
        MarketplaceTaskCreateRequest,
        MarketplaceBidV1,
        MarketplaceBidCreateRequest,
        MarketplaceBidCounterOfferRequest,
        MarketplaceBidAcceptRequest,
        TenantSettlementPolicyUpsertRequest,
        AgentWalletCreditRequest,
        RunSettlementResolveRequest,
        RunAgreementChangeOrderRequest,
        RunAgreementCancelRequest,
        RunAgreementCancelResponse,
        DisputeVerdictSignedRequest,
        RunSettlementPolicyReplayResponse,
        MonthCloseRequest,
        AckRequest,
        ArtifactVerificationSummary,
        OpsJobListItem,
        OpsJobsListResponse,
        CommandCenterReasonCount,
        CommandCenterDestinationCount,
        OpsNetworkCommandCenterSummary,
        OpsNetworkCommandCenterResponse,
        OpsFinanceReconcileResponse,
        MagicLinkAnalyticsReportResponse,
        MagicLinkTrustGraphResponse,
        MagicLinkTrustGraphSnapshotCreateRequest,
        MagicLinkTrustGraphSnapshotListResponse,
        MagicLinkTrustGraphSnapshotCreateResponse,
        MagicLinkTrustGraphDiffResponse
      }
    },
    paths: {
      "/health": {
        get: { summary: "Liveness", responses: { 200: { description: "OK" } } }
      },
      "/healthz": {
        get: { summary: "Health with signals", responses: { 200: { description: "OK" } } }
      },
      "/metrics": {
        get: {
          summary: "Metrics",
          responses: { 200: { description: "OK", content: { "text/plain": { schema: { type: "string" } } } } }
        }
      },
      "/capabilities": {
        get: {
          summary: "Server capabilities",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          responses: {
            200: { description: "Capabilities JSON", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } }
          }
        }
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI document",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          responses: {
            200: { description: "OpenAPI JSON", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } }
          }
        }
      },
      "/jobs": {
        post: {
          summary: "Create job",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: JobCreateRequest } } },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/jobs/{jobId}": {
        get: {
          summary: "Get job",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, { name: "jobId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/marketplace/tasks": {
        get: {
          summary: "List marketplace tasks",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["open", "assigned", "cancelled", "closed", "all"] } },
            { name: "capability", in: "query", required: false, schema: { type: "string" } },
            { name: "posterAgentId", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["tasks", "total", "limit", "offset"],
                    properties: {
                      tasks: { type: "array", items: MarketplaceTaskV1 },
                      total: { type: "integer", minimum: 0 },
                      limit: { type: "integer", minimum: 1 },
                      offset: { type: "integer", minimum: 0 }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        post: {
          summary: "Create a marketplace task",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: MarketplaceTaskCreateRequest } } },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      task: MarketplaceTaskV1
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/marketplace/settlement-policies": {
        get: {
          summary: "List tenant settlement policies",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "policyId", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["policies", "total", "limit", "offset"],
                    properties: {
                      policies: { type: "array", items: TenantSettlementPolicyV1 },
                      total: { type: "integer", minimum: 0 },
                      limit: { type: "integer", minimum: 1 },
                      offset: { type: "integer", minimum: 0 }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        post: {
          summary: "Upsert tenant settlement policy version",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: TenantSettlementPolicyUpsertRequest } } },
          responses: {
            200: {
              description: "Updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      policy: TenantSettlementPolicyV1
                    }
                  }
                }
              }
            },
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      policy: TenantSettlementPolicyV1
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/marketplace/settlement-policies/{policyId}/{policyVersion}": {
        get: {
          summary: "Get tenant settlement policy version",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "policyId", in: "path", required: true, schema: { type: "string" } },
            { name: "policyVersion", in: "path", required: true, schema: { type: "integer", minimum: 1 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      policy: TenantSettlementPolicyV1
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/marketplace/tasks/{taskId}/bids": {
        get: {
          summary: "List bids for a marketplace task",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "taskId", in: "path", required: true, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["pending", "accepted", "rejected", "all"] } },
            { name: "bidderAgentId", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["taskId", "bids", "total", "limit", "offset"],
                    properties: {
                      taskId: { type: "string" },
                      bids: { type: "array", items: MarketplaceBidV1 },
                      total: { type: "integer", minimum: 0 },
                      limit: { type: "integer", minimum: 1 },
                      offset: { type: "integer", minimum: 0 }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        post: {
          summary: "Submit a bid for a marketplace task",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader, { name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: MarketplaceBidCreateRequest } } },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      task: MarketplaceTaskV1,
                      bid: MarketplaceBidV1
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/marketplace/tasks/{taskId}/bids/{bidId}/counter-offer": {
        post: {
          summary: "Apply a counter-offer revision to a pending marketplace bid",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "taskId", in: "path", required: true, schema: { type: "string" } },
            { name: "bidId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: MarketplaceBidCounterOfferRequest } } },
          responses: {
            200: {
              description: "Counter-offer applied",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      task: MarketplaceTaskV1,
                      bid: MarketplaceBidV1,
                      negotiation: MarketplaceBidNegotiationV1,
                      proposal: MarketplaceBidNegotiationProposalV1
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/marketplace/tasks/{taskId}/accept": {
        post: {
          summary: "Accept a bid for a marketplace task",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader, { name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: MarketplaceBidAcceptRequest } } },
          responses: {
            200: {
              description: "Accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      task: MarketplaceTaskV1,
                      acceptedBid: { allOf: [MarketplaceBidV1], nullable: true },
                      run: AgentRunV1,
                      settlement: AgentRunSettlementV1,
                      agreement: MarketplaceTaskAgreementV1
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/dispute/open": {
        post: {
          summary: "Open a run settlement dispute (within dispute window)",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    disputeId: { type: "string" },
                    disputeType: { type: "string", enum: ["quality", "delivery", "fraud", "policy", "payment", "other"] },
                    disputePriority: { type: "string", enum: ["low", "normal", "high", "critical"] },
                    disputeChannel: { type: "string", enum: ["counterparty", "policy_engine", "arbiter", "external"] },
                    escalationLevel: { type: "string", enum: ["l1_counterparty", "l2_arbiter", "l3_external"] },
                    openedByAgentId: { type: "string" },
                    reason: { type: "string" },
                    evidenceRefs: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      settlement: AgentRunSettlementV1,
                      disputeEvidence: { type: "object", additionalProperties: true, nullable: true },
                      disputeEscalation: { type: "object", additionalProperties: true, nullable: true },
                      verdict: { type: "object", additionalProperties: true, nullable: true },
                      verdictArtifact: { type: "object", additionalProperties: true, nullable: true }
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/dispute/close": {
        post: {
          summary: "Close an open run settlement dispute",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    disputeId: { type: "string" },
                    resolution: {
                      type: "object",
                      additionalProperties: true,
                      nullable: true,
                      properties: {
                        outcome: { type: "string", enum: ["accepted", "rejected", "partial", "withdrawn", "unresolved"] },
                        escalationLevel: { type: "string", enum: ["l1_counterparty", "l2_arbiter", "l3_external"] },
                        closedByAgentId: { type: "string", nullable: true },
                        summary: { type: "string", nullable: true },
                        closedAt: { type: "string", format: "date-time", nullable: true },
                        evidenceRefs: { type: "array", items: { type: "string" } }
                      }
                    },
                    resolutionOutcome: { type: "string", enum: ["accepted", "rejected", "partial", "withdrawn", "unresolved"] },
                    resolutionEscalationLevel: { type: "string", enum: ["l1_counterparty", "l2_arbiter", "l3_external"] },
                    resolutionSummary: { type: "string" },
                    closedByAgentId: { type: "string" },
                    resolutionEvidenceRefs: { type: "array", items: { type: "string" } },
                    verdict: DisputeVerdictSignedRequest
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      settlement: AgentRunSettlementV1,
                      disputeEvidence: { type: "object", additionalProperties: true, nullable: true },
                      disputeEscalation: { type: "object", additionalProperties: true, nullable: true },
                      verdict: {
                        type: "object",
                        additionalProperties: true,
                        nullable: true
                      },
                      verdictArtifact: {
                        type: "object",
                        additionalProperties: true,
                        nullable: true
                      }
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/dispute/evidence": {
        post: {
          summary: "Submit dispute evidence to an open run dispute",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["evidenceRef"],
                  properties: {
                    evidenceRef: { type: "string" },
                    submittedByAgentId: { type: "string" },
                    reason: { type: "string" },
                    disputeId: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      settlement: AgentRunSettlementV1,
                      disputeEvidence: { type: "object", additionalProperties: true, nullable: true },
                      disputeEscalation: { type: "object", additionalProperties: true, nullable: true },
                      verdict: { type: "object", additionalProperties: true, nullable: true },
                      verdictArtifact: { type: "object", additionalProperties: true, nullable: true }
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/dispute/escalate": {
        post: {
          summary: "Escalate an open run dispute to a higher escalation level",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["escalationLevel"],
                  properties: {
                    disputeId: { type: "string" },
                    escalationLevel: { type: "string", enum: ["l1_counterparty", "l2_arbiter", "l3_external"] },
                    channel: { type: "string", enum: ["counterparty", "policy_engine", "arbiter", "external"] },
                    escalatedByAgentId: { type: "string" },
                    reason: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      settlement: AgentRunSettlementV1,
                      disputeEvidence: { type: "object", additionalProperties: true, nullable: true },
                      disputeEscalation: { type: "object", additionalProperties: true, nullable: true },
                      verdict: { type: "object", additionalProperties: true, nullable: true },
                      verdictArtifact: { type: "object", additionalProperties: true, nullable: true }
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/marketplace/agents/search": {
        get: {
          summary: "Search and rank marketplace agents",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["active", "suspended", "revoked", "all"] } },
            { name: "capability", in: "query", required: false, schema: { type: "string" } },
            { name: "minTrustScore", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 100 } },
            { name: "riskTier", in: "query", required: false, schema: { type: "string", enum: ["low", "guarded", "elevated", "high"] } },
            { name: "includeReputation", in: "query", required: false, schema: { type: "boolean" } },
            { name: "reputationVersion", in: "query", required: false, schema: { type: "string", enum: ["v1", "v2"] } },
            { name: "reputationWindow", in: "query", required: false, schema: { type: "string", enum: ["7d", "30d", "allTime"] } },
            { name: "scoreStrategy", in: "query", required: false, schema: { type: "string", enum: ["balanced", "recent_bias"] } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      reputationVersion: { type: "string", enum: ["v1", "v2"] },
                      reputationWindow: { type: "string", enum: ["7d", "30d", "allTime"] },
                      scoreStrategy: { type: "string", enum: ["balanced", "recent_bias"] },
                      total: { type: "integer" },
                      limit: { type: "integer" },
                      offset: { type: "integer" },
                      results: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            rank: { type: "integer", minimum: 1 },
                            rankingScore: { type: "integer", minimum: 0, maximum: 100 },
                            riskTier: { type: "string", enum: ["low", "guarded", "elevated", "high"] },
                            agentIdentity: AgentIdentityV1,
                            reputation: AgentReputationAny
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/agents": {
        get: {
          summary: "List registered agent identities",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["active", "suspended", "revoked"] } },
            { name: "capability", in: "query", required: false, schema: { type: "string" } },
            { name: "minTrustScore", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 100 } },
            { name: "includeReputation", in: "query", required: false, schema: { type: "boolean" } },
            { name: "reputationVersion", in: "query", required: false, schema: { type: "string", enum: ["v1", "v2"] } },
            { name: "reputationWindow", in: "query", required: false, schema: { type: "string", enum: ["7d", "30d", "allTime"] } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      agents: { type: "array", items: AgentIdentityV1 },
                      reputations: {
                        type: "object",
                        additionalProperties: AgentReputationAny
                      },
                      limit: { type: "integer" },
                      offset: { type: "integer" }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/agents/register": {
        post: {
          summary: "Register an autonomous agent identity",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: AgentRegisterRequest } } },
          responses: {
            201: {
              description: "Registered",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      agentIdentity: AgentIdentityV1,
                      keyId: { type: "string" }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/agents/{agentId}": {
        get: {
          summary: "Get a registered agent identity",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agentId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      agentIdentity: AgentIdentityV1
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/agents/{agentId}/reputation": {
        get: {
          summary: "Get computed reputation for an agent",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agentId", in: "path", required: true, schema: { type: "string" } },
            { name: "reputationVersion", in: "query", required: false, schema: { type: "string", enum: ["v1", "v2"] } },
            { name: "reputationWindow", in: "query", required: false, schema: { type: "string", enum: ["7d", "30d", "allTime"] } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      reputation: AgentReputationAny
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/agents/{agentId}/wallet": {
        get: {
          summary: "Get an agent wallet snapshot",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agentId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      wallet: AgentWalletV1
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/agents/{agentId}/wallet/credit": {
        post: {
          summary: "Credit an agent wallet",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader, { name: "agentId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: AgentWalletCreditRequest } } },
          responses: {
            201: {
              description: "Credited",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      wallet: AgentWalletV1
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/agents/{agentId}/runs": {
        get: {
          summary: "List runs for an agent",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agentId", in: "path", required: true, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["created", "running", "completed", "failed"] } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      runs: { type: "array", items: AgentRunV1 },
                      total: { type: "integer" },
                      limit: { type: "integer" },
                      offset: { type: "integer" }
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        post: {
          summary: "Create a run for an agent",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader, { name: "agentId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: false, content: { "application/json": { schema: AgentRunCreateRequest } } },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      run: AgentRunV1,
                      event: AgentEventV1,
                      settlement: { ...AgentRunSettlementV1, nullable: true }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/agents/{agentId}/runs/{runId}": {
        get: {
          summary: "Get run snapshot and verification summary",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agentId", in: "path", required: true, schema: { type: "string" } },
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      run: AgentRunV1,
                      verification: { type: "object", additionalProperties: true },
                      settlement: { ...AgentRunSettlementV1, nullable: true }
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/agents/{agentId}/runs/{runId}/events": {
        get: {
          summary: "List events for an agent run",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agentId", in: "path", required: true, schema: { type: "string" } },
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      events: { type: "array", items: AgentEventV1 }
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        post: {
          summary: "Append an event to an agent run",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            ExpectedPrevChainHashHeader,
            { name: "agentId", in: "path", required: true, schema: { type: "string" } },
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: AgentRunEventAppendRequest } } },
          responses: {
            201: {
              description: "Appended",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      event: AgentEventV1,
                      run: AgentRunV1,
                      settlement: { ...AgentRunSettlementV1, nullable: true }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/verification": {
        get: {
          summary: "Get verification summary for a run",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/settlement": {
        get: {
          summary: "Get run settlement details",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      settlement: AgentRunSettlementV1
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/agreement": {
        get: {
          summary: "Get run marketplace agreement details",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      runId: { type: "string" },
                      taskId: { type: "string", nullable: true },
                      agreementId: { type: "string", nullable: true },
                      agreement: MarketplaceTaskAgreementV1,
                      policyRef: { allOf: [MarketplaceSettlementPolicyRefV1], nullable: true },
                      policyHash: { type: "string", nullable: true },
                      verificationMethodHash: { type: "string", nullable: true },
                      policyBindingVerification: { type: "object", additionalProperties: true },
                      acceptanceSignatureVerification: { type: "object", additionalProperties: true }
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/agreement/change-order": {
        post: {
          summary: "Apply a change order to a locked marketplace agreement",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: RunAgreementChangeOrderRequest } } },
          responses: {
            200: {
              description: "Change order applied",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      runId: { type: "string" },
                      task: MarketplaceTaskV1,
                      agreement: MarketplaceTaskAgreementV1,
                      changeOrder: { type: "object", additionalProperties: true },
                      acceptanceSignatureVerification: { type: "object", additionalProperties: true }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/agreement/cancel": {
        post: {
          summary: "Cancel a locked marketplace agreement before run start",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: RunAgreementCancelRequest } } },
          responses: {
            200: {
              description: "Agreement cancelled",
              content: {
                "application/json": {
                  schema: RunAgreementCancelResponse
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/settlement/policy-replay": {
        get: {
          summary: "Replay settlement policy decision for a run",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: RunSettlementPolicyReplayResponse
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/settlement/resolve": {
        post: {
          summary: "Manually resolve a locked run settlement",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: RunSettlementResolveRequest } } },
          responses: {
            200: {
              description: "Resolved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      settlement: AgentRunSettlementV1
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/artifacts/{artifactId}/status": {
        get: {
          summary: "Get artifact verification status",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "artifactId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read", "audit_read", "finance_read"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/jobs/{jobId}/quote": {
        post: {
          summary: "Quote job (optimistic concurrency)",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            ExpectedPrevChainHashHeader,
            { name: "jobId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: JobQuoteRequest } } },
          responses: {
            201: { description: "Quoted", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/jobs/{jobId}/book": {
        post: {
          summary: "Book job (optimistic concurrency)",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            ExpectedPrevChainHashHeader,
            { name: "jobId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: JobBookRequest } } },
          responses: {
            201: { description: "Booked", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/jobs/{jobId}/events": {
        post: {
          summary: "Append job event",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, { name: "jobId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: JobEventAppendRequest } } },
          responses: {
            201: { description: "Appended", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Rejected", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/status": {
        get: {
          summary: "Ops status summary",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
        }
      },
      "/ops/jobs": {
        get: {
          summary: "List jobs (ops view) with verification summary",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "status", in: "query", required: false, schema: { type: "string" } },
            { name: "zoneId", in: "query", required: false, schema: { type: "string" } },
            { name: "environmentTier", in: "query", required: false, schema: { type: "string" } },
            { name: "templateId", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer" } },
            { name: "offset", in: "query", required: false, schema: { type: "integer" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read", "audit_read"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsJobsListResponse } } }
          }
        }
      },
      "/ops/network/command-center": {
        get: {
          summary: "Network command-center summary",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "transactionFeeBps", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 5000, default: 100 } },
            { name: "windowHours", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 8760, default: 24 } },
            { name: "disputeSlaHours", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 8760, default: 24 } },
            { name: "emitAlerts", in: "query", required: false, schema: { type: "boolean", default: false } },
            { name: "persistAlerts", in: "query", required: false, schema: { type: "boolean", default: false } },
            { name: "httpClientErrorRateThresholdPct", in: "query", required: false, schema: { type: "number", minimum: 0 } },
            { name: "httpServerErrorRateThresholdPct", in: "query", required: false, schema: { type: "number", minimum: 0 } },
            { name: "deliveryDlqThreshold", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
            { name: "disputeOverSlaThreshold", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
            { name: "determinismRejectThreshold", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsNetworkCommandCenterResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/sla-templates": {
        get: {
          summary: "List built-in SLA policy templates",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "vertical", in: "query", required: false, schema: { type: "string", enum: ["delivery", "security"] } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/v1/tenants/{tenantId}/analytics": {
        get: {
          summary: "Get tenant analytics report (Magic Link)",
          parameters: [
            RequestIdHeader,
            { name: "tenantId", in: "path", required: true, schema: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" } },
            { name: "month", in: "query", required: false, schema: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}$", example: "2026-02" } },
            { name: "bucket", in: "query", required: false, schema: { type: "string", enum: ["day", "week", "month"] } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } }
          ],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: MagicLinkAnalyticsReportResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/v1/tenants/{tenantId}/trust-graph": {
        get: {
          summary: "Get tenant trust graph (Magic Link)",
          parameters: [
            RequestIdHeader,
            { name: "tenantId", in: "path", required: true, schema: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" } },
            { name: "month", in: "query", required: false, schema: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}$", example: "2026-02" } },
            { name: "minRuns", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100000 } },
            { name: "maxEdges", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 2000 } }
          ],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: MagicLinkTrustGraphResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/v1/tenants/{tenantId}/trust-graph/snapshots": {
        get: {
          summary: "List tenant trust graph snapshots (Magic Link)",
          parameters: [
            RequestIdHeader,
            { name: "tenantId", in: "path", required: true, schema: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 } }
          ],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: MagicLinkTrustGraphSnapshotListResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        post: {
          summary: "Create tenant trust graph snapshot (Magic Link)",
          parameters: [
            RequestIdHeader,
            { name: "tenantId", in: "path", required: true, schema: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" } }
          ],
          requestBody: { required: false, content: { "application/json": { schema: MagicLinkTrustGraphSnapshotCreateRequest } } },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: MagicLinkTrustGraphSnapshotCreateResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/v1/tenants/{tenantId}/trust-graph/diff": {
        get: {
          summary: "Get tenant trust graph diff between months (Magic Link)",
          parameters: [
            RequestIdHeader,
            { name: "tenantId", in: "path", required: true, schema: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" } },
            { name: "baseMonth", in: "query", required: false, schema: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}$", example: "2026-01" } },
            { name: "compareMonth", in: "query", required: false, schema: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}$", example: "2026-02" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 } },
            { name: "minRuns", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100000 } },
            { name: "maxEdges", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 2000 } },
            { name: "includeUnchanged", in: "query", required: false, schema: { type: "boolean" } }
          ],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: MagicLinkTrustGraphDiffResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/month-close": {
        post: {
          summary: "Request month close",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_write"],
          requestBody: { required: true, content: { "application/json": { schema: MonthCloseRequest } } },
          responses: { 202: { description: "Accepted", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
        },
        get: {
          summary: "Get month close state",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_read"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
        }
      },
      "/ops/party-statements": {
        get: {
          summary: "List party statements",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "period", in: "query", required: true, schema: { type: "string", example: "2026-02" } },
            { name: "partyId", in: "query", required: false, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string", example: "CLOSED" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_read"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
        }
      },
      "/ops/party-statements/{partyId}/{period}": {
        get: {
          summary: "Get party statement",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "partyId", in: "path", required: true, schema: { type: "string" } },
            { name: "period", in: "path", required: true, schema: { type: "string", example: "2026-02" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_read"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
        }
      },
      "/ops/payouts/{partyId}/{period}/enqueue": {
        post: {
          summary: "Enqueue payout instruction for a closed period",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "partyId", in: "path", required: true, schema: { type: "string" } },
            { name: "period", in: "path", required: true, schema: { type: "string", example: "2026-02" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_write"],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    moneyRailProviderId: { type: "string" },
                    counterpartyRef: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/money-rails/{providerId}/operations/{operationId}": {
        get: {
          summary: "Get money rail operation status",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "providerId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_read"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/money-rails/{providerId}/events/ingest": {
        post: {
          summary: "Ingest provider event and deterministically map to operation state",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "providerId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_write"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["operationId"],
                  properties: {
                    operationId: { type: "string" },
                    eventType: { type: "string", enum: ["submitted", "confirmed", "failed", "cancelled", "reversed"] },
                    providerStatus: { type: "string" },
                    eventId: { type: "string" },
                    providerRef: { type: "string" },
                    reasonCode: { type: "string" },
                    at: { type: "string", format: "date-time" },
                    payload: { type: "object", additionalProperties: true, nullable: true }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/money-rails/{providerId}/operations/{operationId}/cancel": {
        post: {
          summary: "Cancel a money rail operation",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "providerId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_write"],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    reasonCode: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/finance/account-map": {
        get: {
          summary: "Get finance account map",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
        },
        put: {
          summary: "Upsert finance account map (audited)",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_write"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
        }
      },
      "/ops/finance/gl-batch": {
        get: {
          summary: "Get latest GLBatch artifact for a period",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "period", in: "query", required: true, schema: { type: "string", example: "2026-02" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_write"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/finance/gl-batch.csv": {
        get: {
          summary: "Render deterministic journal CSV for a period",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "period", in: "query", required: true, schema: { type: "string", example: "2026-02" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_write"],
          responses: {
            200: { description: "OK", content: { "text/csv": { schema: { type: "string" } } } },
            409: { description: "Not ready", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/finance/reconcile": {
        get: {
          summary: "Compute deterministic reconciliation report for a period",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "period", in: "query", required: true, schema: { type: "string", example: "2026-02" } },
            { name: "persist", in: "query", required: false, schema: { type: "boolean", default: false } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_read", "finance_write"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsFinanceReconcileResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/exports/ack": {
        post: {
          summary: "ACK a delivery (destination-signed)",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "x-proxy-destination-id", in: "header", required: true, schema: { type: "string" } },
            { name: "x-proxy-timestamp", in: "header", required: true, schema: { type: "string" } },
            { name: "x-proxy-signature", in: "header", required: true, schema: { type: "string" } }
          ],
          requestBody: { required: true, content: { "application/json": { schema: AckRequest } } },
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
        }
      }
    }
  };

  // Remove undefined `servers` if not provided (keeps JSON stable).
  if (!spec.servers) delete spec.servers;
  return spec;
}
