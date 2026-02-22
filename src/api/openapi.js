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

  const X402ExecutionProofV1 = {
    type: "object",
    additionalProperties: false,
    required: ["protocol", "publicSignals", "proofData"],
    properties: {
      schemaVersion: { type: "string", enum: ["X402ExecutionProof.v1"] },
      protocol: { type: "string", enum: ["groth16", "plonk", "stark"] },
      publicSignals: { type: "array", items: {} },
      proofData: { type: "object", additionalProperties: true },
      verificationKey: { type: "object", nullable: true, additionalProperties: true },
      verificationKeyRef: { type: "string", nullable: true },
      statementHashSha256: { type: "string", pattern: "^[0-9a-f]{64}$", nullable: true },
      inputDigestSha256: { type: "string", pattern: "^[0-9a-f]{64}$", nullable: true },
      outputDigestSha256: { type: "string", pattern: "^[0-9a-f]{64}$", nullable: true }
    }
  };

  const X402GateVerifyRequest = {
    type: "object",
    additionalProperties: true,
    required: ["gateId"],
    properties: {
      gateId: { type: "string" },
      proof: { ...X402ExecutionProofV1, nullable: true }
    }
  };

  const X402GateAuthorizePaymentRequest = {
    type: "object",
    additionalProperties: true,
    required: ["gateId"],
    properties: {
      gateId: { type: "string" },
      quoteId: { type: "string", nullable: true },
      requestBindingMode: { type: "string", enum: ["strict"], nullable: true },
      requestBindingSha256: { type: "string", pattern: "^[0-9a-f]{64}$", nullable: true },
      walletAuthorizationDecisionToken: { type: "string", nullable: true },
      escalationOverrideToken: { type: "string", nullable: true },
      executionIntent: {
        type: "object",
        nullable: true,
        additionalProperties: true,
        description: "ExecutionIntent.v1 payload bound to authorize-payment preconditions."
      }
    }
  };

  const X402WalletAssignment = {
    type: "object",
    additionalProperties: false,
    required: ["sponsorWalletRef", "policyRef", "policyVersion"],
    properties: {
      sponsorWalletRef: { type: "string" },
      policyRef: { type: "string" },
      policyVersion: { type: "integer", minimum: 1 }
    }
  };

  const X402WalletAssignmentResolveRequest = {
    type: "object",
    additionalProperties: false,
    properties: {
      profileRef: { type: "string", nullable: true },
      riskClass: { type: "string", enum: ["read", "compute", "action", "financial"], nullable: true },
      delegationRef: { type: "string", nullable: true },
      delegationDepth: { type: "integer", minimum: 0, nullable: true }
    }
  };

  const X402WalletAssignmentResolveResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "tenantId", "assignment"],
    properties: {
      ok: { type: "boolean" },
      tenantId: { type: "string" },
      profileRef: { type: "string", nullable: true },
      riskClass: { type: "string", enum: ["read", "compute", "action", "financial"], nullable: true },
      delegationRef: { type: "string", nullable: true },
      delegationDepth: { type: "integer", minimum: 0, nullable: true },
      assignment: { ...X402WalletAssignment, nullable: true }
    }
  };

  const X402AuthorizePaymentTaErrorCodes = Object.freeze([
    "X402_EXECUTION_INTENT_REQUIRED",
    "X402_EXECUTION_INTENT_IDEMPOTENCY_MISMATCH",
    "X402_EXECUTION_INTENT_CONFLICT"
  ]);

  const X402AuthorizePaymentBadRequestKnownErrorCodes = Object.freeze([
    "SCHEMA_INVALID",
    "X402_EXECUTION_INTENT_HASH_MISMATCH"
  ]);

  const X402AuthorizePaymentConflictKnownErrorCodes = Object.freeze([
    ...X402AuthorizePaymentTaErrorCodes,
    "X402_EXECUTION_INTENT_INVALID",
    "X402_EXECUTION_INTENT_TIME_INVALID",
    "X402_EXECUTION_INTENT_TENANT_MISMATCH",
    "X402_EXECUTION_INTENT_AGENT_MISMATCH",
    "X402_EXECUTION_INTENT_SIDE_EFFECTING_REQUIRED",
    "X402_EXECUTION_INTENT_REQUEST_BINDING_REQUIRED",
    "X402_EXECUTION_INTENT_REQUEST_MISMATCH",
    "X402_EXECUTION_INTENT_SPEND_LIMIT_EXCEEDED",
    "X402_EXECUTION_INTENT_CURRENCY_MISMATCH",
    "X402_EXECUTION_INTENT_RUN_MISMATCH",
    "X402_EXECUTION_INTENT_AGREEMENT_MISMATCH",
    "X402_EXECUTION_INTENT_QUOTE_MISMATCH",
    "X402_EXECUTION_INTENT_POLICY_VERSION_MISMATCH",
    "X402_EXECUTION_INTENT_POLICY_HASH_MISMATCH",
    "X402_EXECUTION_INTENT_EXPIRES_AT_INVALID",
    "X402_EXECUTION_INTENT_EXPIRED"
  ]);

  const X402GateVerifyBadRequestKnownErrorCodes = Object.freeze(["SCHEMA_INVALID"]);

  const X402GateVerifyConflictKnownErrorCodes = Object.freeze([
    "X402_INVALID_VERIFICATION_KEY_REF",
    "X402_MISSING_REQUIRED_PROOF",
    "X402_INVALID_CRYPTOGRAPHIC_PROOF",
    "X402_SPEND_AUTH_POLICY_FINGERPRINT_MISMATCH",
    "X402_REQUEST_BINDING_REQUIRED",
    "X402_REQUEST_BINDING_EVIDENCE_REQUIRED",
    "X402_REQUEST_BINDING_EVIDENCE_MISMATCH"
  ]);

  function errorResponseWithKnownCodes(knownCodes) {
    return {
      allOf: [
        ErrorResponse,
        {
          type: "object",
          additionalProperties: true,
          properties: {
            code: {
              anyOf: [{ type: "string", enum: [...knownCodes] }, { type: "string" }],
              description: "Known stable codes are listed in docs/spec/x402-error-codes.v1.txt."
            }
          }
        }
      ]
    };
  }

  const X402ZkVerificationKeyV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "verificationKeyId", "protocol", "verificationKey", "createdAt", "updatedAt"],
    properties: {
      schemaVersion: { type: "string", enum: ["X402ZkVerificationKey.v1"] },
      verificationKeyId: { type: "string" },
      protocol: { type: "string", enum: ["groth16", "plonk", "stark"] },
      verificationKey: { type: "object", additionalProperties: true },
      providerRef: { type: "string", nullable: true },
      metadata: { type: "object", additionalProperties: true, nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
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

  const AgentPassportV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "passportId",
      "agentId",
      "tenantId",
      "principalRef",
      "identityAnchors",
      "delegationRoot",
      "policyEnvelope",
      "status",
      "createdAt",
      "updatedAt",
      "sponsorRef",
      "agentKeyId",
      "delegationRef",
      "lineageRequired"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["AgentPassport.v1"] },
      passportId: { type: "string" },
      agentId: { type: "string" },
      tenantId: { type: "string" },
      principalRef: {
        type: "object",
        additionalProperties: false,
        required: ["principalType", "principalId"],
        properties: {
          principalType: { type: "string", enum: ["human", "business", "service", "dao"] },
          principalId: { type: "string" },
          jurisdiction: { type: "string" }
        }
      },
      identityAnchors: {
        type: "object",
        additionalProperties: false,
        required: ["jwksUri", "activeKeyId", "keysetHash"],
        properties: {
          did: { type: "string" },
          jwksUri: { type: "string", format: "uri" },
          activeKeyId: { type: "string" },
          keysetHash: { type: "string", pattern: "^[0-9a-f]{64}$" }
        }
      },
      delegationRoot: {
        type: "object",
        additionalProperties: false,
        required: ["rootGrantId", "rootGrantHash", "issuedAt"],
        properties: {
          rootGrantId: { type: "string" },
          rootGrantHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
          issuedAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time", nullable: true },
          revokedAt: { type: "string", format: "date-time", nullable: true }
        }
      },
      capabilityCredentials: { type: "array", items: { type: "object", additionalProperties: true } },
      policyEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["maxPerCallCents", "maxDailyCents", "allowedRiskClasses"],
        properties: {
          maxPerCallCents: { type: "integer", minimum: 0 },
          maxDailyCents: { type: "integer", minimum: 0 },
          allowedRiskClasses: { type: "array", items: { type: "string", enum: ["read", "compute", "action", "financial"] } },
          requireApprovalAboveCents: { type: "integer", minimum: 0, nullable: true },
          allowlistRefs: { type: "array", items: { type: "string" } }
        }
      },
      status: { type: "string", enum: ["active", "suspended", "revoked"] },
      metadata: { type: "object", nullable: true, additionalProperties: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      sponsorRef: { type: "string" },
      sponsorWalletRef: { type: "string" },
      agentKeyId: { type: "string" },
      delegationRef: { type: "string" },
      policyRef: { type: "string" },
      policyVersion: { type: "integer", minimum: 1 },
      delegationDepth: { type: "integer", minimum: 0 },
      maxDelegationDepth: { type: "integer", minimum: 0 },
      expiresAt: { type: "string", format: "date-time" },
      lineageRequired: { type: "boolean" }
    }
  };

  const AgentPassportUpsertRequest = {
    type: "object",
    additionalProperties: false,
    required: ["agentPassport"],
    properties: {
      agentPassport: AgentPassportV1
    }
  };

  const AgentPassportRevokeRequest = {
    type: "object",
    additionalProperties: false,
    properties: {
      revokedAt: { type: "string", format: "date-time", nullable: true },
      reasonCode: { type: "string" },
      reason: { type: "string" }
    }
  };

  const ToolCallAgreementV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "toolId",
      "manifestHash",
      "callId",
      "inputHash",
      "acceptanceCriteria",
      "settlementTerms",
      "payerAgentId",
      "payeeAgentId",
      "createdAt",
      "agreementHash"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["ToolCallAgreement.v1"] },
      toolId: { type: "string" },
      manifestHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      callId: { type: "string" },
      inputHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      acceptanceCriteria: { type: "object", nullable: true, additionalProperties: true },
      settlementTerms: { type: "object", nullable: true, additionalProperties: true },
      payerAgentId: { type: "string", nullable: true },
      payeeAgentId: { type: "string", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      agreementHash: { type: "string", pattern: "^[0-9a-f]{64}$" }
    }
  };

  const ToolCallEvidenceV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "agreementHash",
      "callId",
      "inputHash",
      "outputHash",
      "outputRef",
      "metrics",
      "startedAt",
      "completedAt",
      "createdAt",
      "evidenceHash"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["ToolCallEvidence.v1"] },
      agreementHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      callId: { type: "string" },
      inputHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      outputHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      outputRef: { type: "string", nullable: true },
      metrics: { type: "object", nullable: true, additionalProperties: true },
      startedAt: { type: "string", format: "date-time" },
      completedAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      evidenceHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      signature: {
        type: "object",
        nullable: true,
        additionalProperties: false,
        required: ["algorithm", "signerKeyId", "evidenceHash", "signature"],
        properties: {
          algorithm: { type: "string", enum: ["ed25519"] },
          signerKeyId: { type: "string" },
          evidenceHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
          signature: { type: "string" }
        }
      }
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
          releaseRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
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

  const SettlementDecisionRecordV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "decisionId",
      "tenantId",
      "runId",
      "settlementId",
      "decisionStatus",
      "decisionMode",
      "policyRef",
      "verifierRef",
      "workRef",
      "decidedAt",
      "decisionHash"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["SettlementDecisionRecord.v1"] },
      decisionId: { type: "string" },
      tenantId: { type: "string" },
      runId: { type: "string" },
      settlementId: { type: "string" },
      agreementId: { type: "string", nullable: true },
      decisionStatus: { type: "string", enum: ["pending", "auto_resolved", "manual_review_required", "manual_resolved"] },
      decisionMode: { type: "string", enum: ["automatic", "manual-review"] },
      decisionReason: { type: "string", nullable: true },
      verificationStatus: { type: "string", enum: ["green", "amber", "red"], nullable: true },
      policyRef: {
        type: "object",
        additionalProperties: false,
        required: ["policyHash", "verificationMethodHash"],
        properties: {
          policyHash: { type: "string", nullable: true },
          verificationMethodHash: { type: "string", nullable: true }
        }
      },
      verifierRef: {
        type: "object",
        additionalProperties: false,
        required: ["verifierId", "verifierVersion", "verifierHash", "modality"],
        properties: {
          verifierId: { type: "string", nullable: true },
          verifierVersion: { type: "string", nullable: true },
          verifierHash: { type: "string", nullable: true },
          modality: { type: "string", enum: ["deterministic", "attested", "discretionary"], nullable: true }
        }
      },
      workRef: {
        type: "object",
        additionalProperties: false,
        required: ["runStatus", "runLastEventId", "runLastChainHash", "resolutionEventId"],
        properties: {
          runStatus: { type: "string", nullable: true },
          runLastEventId: { type: "string", nullable: true },
          runLastChainHash: { type: "string", nullable: true },
          resolutionEventId: { type: "string", nullable: true }
        }
      },
      decidedAt: { type: "string", format: "date-time" },
      decisionHash: { type: "string" }
    }
  };

  const SettlementDecisionRecordV2 = {
    ...SettlementDecisionRecordV1,
    required: [...SettlementDecisionRecordV1.required, "policyHashUsed"],
    properties: {
      ...SettlementDecisionRecordV1.properties,
      schemaVersion: { type: "string", enum: ["SettlementDecisionRecord.v2"] },
      policyNormalizationVersion: { type: "string" },
      policyHashUsed: { type: "string" },
      verificationMethodHashUsed: { type: "string" }
    }
  };

  const SettlementDecisionRecordAny = {
    oneOf: [SettlementDecisionRecordV1, SettlementDecisionRecordV2]
  };

  const SettlementReceiptV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "receiptId",
      "tenantId",
      "runId",
      "settlementId",
      "decisionRef",
      "status",
      "amountCents",
      "releasedAmountCents",
      "refundedAmountCents",
      "releaseRatePct",
      "currency",
      "runStatus",
      "resolutionEventId",
      "finalityProvider",
      "finalityState",
      "settledAt",
      "createdAt",
      "receiptHash"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["SettlementReceipt.v1"] },
      receiptId: { type: "string" },
      tenantId: { type: "string" },
      runId: { type: "string" },
      settlementId: { type: "string" },
      decisionRef: {
        type: "object",
        additionalProperties: false,
        required: ["decisionId", "decisionHash"],
        properties: {
          decisionId: { type: "string" },
          decisionHash: { type: "string" }
        }
      },
      status: { type: "string", enum: ["locked", "released", "refunded"] },
      amountCents: { type: "integer", minimum: 1 },
      releasedAmountCents: { type: "integer", minimum: 0 },
      refundedAmountCents: { type: "integer", minimum: 0 },
      releaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
      currency: { type: "string" },
      runStatus: { type: "string", nullable: true },
      resolutionEventId: { type: "string", nullable: true },
      finalityProvider: { type: "string", enum: ["internal_ledger"] },
      finalityState: { type: "string", enum: ["pending", "final"] },
      settledAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      receiptHash: { type: "string" }
    }
  };

  const SettlementKernelVerification = {
    type: "object",
    additionalProperties: false,
    required: ["valid", "errors"],
    properties: {
      valid: { type: "boolean" },
      errors: { type: "array", items: { type: "string" } },
      decisionRecord: { ...SettlementDecisionRecordAny, nullable: true },
      settlementReceipt: { allOf: [SettlementReceiptV1], nullable: true }
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

  const MarketplaceOfferV2 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "offerId",
      "tenantId",
      "rfqId",
      "runId",
      "bidId",
      "revision",
      "amountCents",
      "currency",
      "proposalHash",
      "proposedAt",
      "createdAt",
      "offerHash"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceOffer.v2"] },
      offerId: { type: "string" },
      tenantId: { type: "string" },
      rfqId: { type: "string" },
      runId: { type: "string", nullable: true },
      bidId: { type: "string" },
      proposalId: { type: "string", nullable: true },
      revision: { type: "integer", minimum: 1 },
      proposerAgentId: { type: "string", nullable: true },
      amountCents: { type: "integer", minimum: 1 },
      currency: { type: "string" },
      etaSeconds: { type: "integer", minimum: 1, nullable: true },
      note: { type: "string", nullable: true },
      verificationMethod: { ...VerificationMethodV1, nullable: true },
      policy: { ...SettlementPolicyV1, nullable: true },
      policyRef: { ...MarketplaceSettlementPolicyRefV1, nullable: true },
      policyRefHash: { type: "string", nullable: true },
      prevProposalHash: { type: "string", nullable: true },
      proposalHash: { type: "string" },
      offerChainHash: { type: "string", nullable: true },
      proposalCount: { type: "integer", minimum: 1, nullable: true },
      metadata: { type: "object", additionalProperties: true, nullable: true },
      proposedAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      offerHash: { type: "string" }
    }
  };

  const MarketplaceAcceptanceV2 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "acceptanceId",
      "tenantId",
      "rfqId",
      "runId",
      "bidId",
      "acceptedAt",
      "acceptedByAgentId",
      "acceptedProposalId",
      "acceptedRevision",
      "acceptedProposalHash",
      "offerChainHash",
      "proposalCount",
      "offerRef",
      "createdAt",
      "acceptanceHash"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceAcceptance.v2"] },
      acceptanceId: { type: "string" },
      tenantId: { type: "string" },
      rfqId: { type: "string" },
      runId: { type: "string" },
      bidId: { type: "string" },
      agreementId: { type: "string", nullable: true },
      acceptedAt: { type: "string", format: "date-time", nullable: true },
      acceptedByAgentId: { type: "string", nullable: true },
      acceptedProposalId: { type: "string", nullable: true },
      acceptedRevision: { type: "integer", minimum: 1, nullable: true },
      acceptedProposalHash: { type: "string", nullable: true },
      offerChainHash: { type: "string", nullable: true },
      proposalCount: { type: "integer", minimum: 1, nullable: true },
      offerRef: {
        type: "object",
        additionalProperties: false,
        required: ["offerId", "offerHash"],
        properties: {
          offerId: { type: "string", nullable: true },
          offerHash: { type: "string", nullable: true }
        }
      },
      createdAt: { type: "string", format: "date-time" },
      acceptanceHash: { type: "string" }
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

  const DelegationTraceV1 = {
    type: "object",
    additionalProperties: false,
    required: ["chainHash", "tenantId", "runId", "rfqId", "agreementId", "contextType", "delegationChain"],
    properties: {
      chainHash: { type: "string" },
      tenantId: { type: "string" },
      runId: { type: "string" },
      rfqId: { type: "string" },
      agreementId: { type: "string" },
      contextType: { type: "string", enum: ["agreement_acceptance", "change_order_acceptance", "cancellation_acceptance"] },
      contextId: { type: "string", nullable: true },
      signedAt: { type: "string", format: "date-time", nullable: true },
      signerAgentId: { type: "string", nullable: true },
      signerKeyId: { type: "string", nullable: true },
      acceptedByAgentId: { type: "string", nullable: true },
      principalAgentId: { type: "string", nullable: true },
      delegateAgentId: { type: "string", nullable: true },
      delegationChain: { type: "array", minItems: 1, items: AgentDelegationLinkV1 }
    }
  };

  const DelegationTraceListResponse = {
    type: "object",
    additionalProperties: false,
    required: ["traces", "total", "limit", "offset"],
    properties: {
      traces: { type: "array", items: DelegationTraceV1 },
      total: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0 }
    }
  };

  const DelegationEmergencyRevokeRequest = {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: { type: "string" },
      chainHash: { type: "string" },
      delegationId: { type: "string" },
      signerKeyId: { type: "string" },
      signerAgentId: { type: "string" },
      authKeyId: { type: "string" },
      agentId: { type: "string" },
      includeDelegateAgent: { type: "boolean", default: true },
      includePrincipalAgent: { type: "boolean", default: false },
      includeSignerKey: { type: "boolean", default: true },
      reason: { type: "string" }
    }
  };

  const DelegationEmergencyRevokeResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "affectedTraceCount", "revoked", "missing"],
    properties: {
      ok: { type: "boolean" },
      selectors: { type: "object", additionalProperties: true },
      affectedTraceCount: { type: "integer", minimum: 0 },
      revoked: { type: "object", additionalProperties: true },
      missing: { type: "object", additionalProperties: true }
    }
  };

  const OpsEmergencyControlType = {
    type: "string",
    enum: ["pause", "quarantine", "revoke", "kill-switch"]
  };

  const OpsEmergencyAction = {
    type: "string",
    enum: ["pause", "quarantine", "revoke", "kill-switch", "resume"]
  };

  const OpsEmergencyScope = {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: { type: "string", enum: ["tenant", "agent", "adapter"] },
      id: { type: "string", nullable: true }
    }
  };

  const OpsEmergencyRequestedBy = {
    type: "object",
    additionalProperties: false,
    properties: {
      keyId: { type: "string", nullable: true },
      principalId: { type: "string", nullable: true }
    }
  };

  const OpsEmergencyControlEvent = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "eventId", "tenantId", "action", "scope", "requestedBy", "createdAt", "effectiveAt"],
    properties: {
      schemaVersion: { type: "string", enum: ["OpsEmergencyControlEvent.v1"] },
      eventId: { type: "string" },
      tenantId: { type: "string" },
      action: OpsEmergencyAction,
      controlType: { ...OpsEmergencyControlType, nullable: true },
      resumeControlTypes: { type: "array", items: OpsEmergencyControlType },
      scope: OpsEmergencyScope,
      reasonCode: { type: "string", nullable: true },
      reason: { type: "string", nullable: true },
      operatorAction: { type: "object", additionalProperties: true, nullable: true },
      secondOperatorAction: { type: "object", additionalProperties: true, nullable: true },
      requestedBy: OpsEmergencyRequestedBy,
      requestId: { type: "string", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      effectiveAt: { type: "string", format: "date-time" }
    }
  };

  const OpsEmergencyControlState = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "tenantId",
      "scopeType",
      "scopeId",
      "controlType",
      "active",
      "activatedAt",
      "resumedAt",
      "updatedAt",
      "lastEventId",
      "lastAction",
      "reasonCode",
      "reason",
      "operatorAction",
      "revision"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["OpsEmergencyControlState.v1"] },
      tenantId: { type: "string" },
      scopeType: { type: "string", enum: ["tenant", "agent", "adapter"] },
      scopeId: { type: "string", nullable: true },
      controlType: OpsEmergencyControlType,
      active: { type: "boolean" },
      activatedAt: { type: "string", format: "date-time" },
      resumedAt: { type: "string", format: "date-time", nullable: true },
      updatedAt: { type: "string", format: "date-time" },
      lastEventId: { type: "string", nullable: true },
      lastAction: { ...OpsEmergencyAction, nullable: true },
      reasonCode: { type: "string", nullable: true },
      reason: { type: "string", nullable: true },
      operatorAction: { type: "object", additionalProperties: true, nullable: true },
      revision: { type: "integer", minimum: 0 }
    }
  };

  const OpsEmergencyPauseRequest = {
    type: "object",
    additionalProperties: false,
    required: ["operatorAction"],
    properties: {
      scope: OpsEmergencyScope,
      scopeType: { type: "string", enum: ["tenant", "agent", "adapter"], nullable: true },
      scopeId: { type: "string", nullable: true },
      agentId: { type: "string", nullable: true },
      adapterId: { type: "string", nullable: true },
      providerId: { type: "string", nullable: true },
      reasonCode: { type: "string", nullable: true },
      reason: { type: "string", nullable: true },
      operatorAction: { type: "object", additionalProperties: true },
      secondOperatorAction: { type: "object", additionalProperties: true, nullable: true },
      effectiveAt: { type: "string", format: "date-time", nullable: true }
    }
  };

  const OpsEmergencyQuarantineRequest = {
    type: "object",
    additionalProperties: false,
    required: ["operatorAction"],
    properties: {
      scope: OpsEmergencyScope,
      scopeType: { type: "string", enum: ["tenant", "agent", "adapter"], nullable: true },
      scopeId: { type: "string", nullable: true },
      agentId: { type: "string", nullable: true },
      adapterId: { type: "string", nullable: true },
      providerId: { type: "string", nullable: true },
      reasonCode: { type: "string", nullable: true },
      reason: { type: "string", nullable: true },
      operatorAction: { type: "object", additionalProperties: true },
      secondOperatorAction: { type: "object", additionalProperties: true, nullable: true },
      effectiveAt: { type: "string", format: "date-time", nullable: true }
    }
  };

  const OpsEmergencyRevokeRequest = {
    type: "object",
    additionalProperties: false,
    required: ["operatorAction"],
    properties: {
      scope: OpsEmergencyScope,
      scopeType: { type: "string", enum: ["tenant", "agent", "adapter"], nullable: true },
      scopeId: { type: "string", nullable: true },
      agentId: { type: "string", nullable: true },
      adapterId: { type: "string", nullable: true },
      providerId: { type: "string", nullable: true },
      reasonCode: { type: "string", nullable: true },
      reason: { type: "string", nullable: true },
      operatorAction: { type: "object", additionalProperties: true },
      secondOperatorAction: { type: "object", additionalProperties: true, nullable: true },
      effectiveAt: { type: "string", format: "date-time", nullable: true }
    }
  };

  const OpsEmergencyKillSwitchRequest = {
    type: "object",
    additionalProperties: false,
    required: ["operatorAction"],
    properties: {
      scope: OpsEmergencyScope,
      scopeType: { type: "string", enum: ["tenant", "agent", "adapter"], nullable: true },
      scopeId: { type: "string", nullable: true },
      agentId: { type: "string", nullable: true },
      adapterId: { type: "string", nullable: true },
      providerId: { type: "string", nullable: true },
      reasonCode: { type: "string", nullable: true },
      reason: { type: "string", nullable: true },
      operatorAction: { type: "object", additionalProperties: true },
      secondOperatorAction: { type: "object", additionalProperties: true, nullable: true },
      effectiveAt: { type: "string", format: "date-time", nullable: true }
    }
  };

  const OpsEmergencyResumeRequest = {
    type: "object",
    additionalProperties: false,
    required: ["operatorAction"],
    properties: {
      scope: OpsEmergencyScope,
      scopeType: { type: "string", enum: ["tenant", "agent", "adapter"], nullable: true },
      scopeId: { type: "string", nullable: true },
      agentId: { type: "string", nullable: true },
      adapterId: { type: "string", nullable: true },
      providerId: { type: "string", nullable: true },
      controlType: OpsEmergencyControlType,
      controlTypes: { type: "array", items: OpsEmergencyControlType },
      resumeControlType: OpsEmergencyControlType,
      resumeControlTypes: { type: "array", items: OpsEmergencyControlType },
      reasonCode: { type: "string", nullable: true },
      reason: { type: "string", nullable: true },
      operatorAction: { type: "object", additionalProperties: true },
      secondOperatorAction: { type: "object", additionalProperties: true, nullable: true },
      effectiveAt: { type: "string", format: "date-time", nullable: true }
    }
  };

  const OpsEmergencyDualControlStatus = {
    type: "object",
    additionalProperties: false,
    required: ["required", "satisfied"],
    properties: {
      required: { type: "boolean" },
      satisfied: { type: "boolean", nullable: true }
    }
  };

  const OpsEmergencyControlResponse = {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "applied", "action"],
    properties: {
      tenantId: { type: "string" },
      applied: { type: "boolean" },
      action: OpsEmergencyAction,
      reason: { type: "string", nullable: true },
      event: { ...OpsEmergencyControlEvent, nullable: true },
      scope: { ...OpsEmergencyScope, nullable: true },
      controlType: { ...OpsEmergencyControlType, nullable: true },
      resumeControlTypes: { type: "array", items: OpsEmergencyControlType },
      dualControl: { ...OpsEmergencyDualControlStatus, nullable: true },
      control: { ...OpsEmergencyControlState, nullable: true }
    }
  };

  const MarketplaceAgreementAcceptanceSignatureV2 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "agreementId",
      "tenantId",
      "rfqId",
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
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementAcceptanceSignature.v2"] },
      agreementId: { type: "string" },
      tenantId: { type: "string" },
      rfqId: { type: "string" },
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

  const MarketplaceAgreementChangeOrderAcceptanceSignatureV2 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "tenantId",
      "runId",
      "agreementId",
      "rfqId",
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
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementChangeOrderAcceptanceSignature.v2"] },
      tenantId: { type: "string" },
      runId: { type: "string" },
      agreementId: { type: "string" },
      rfqId: { type: "string" },
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

  const MarketplaceAgreementCancellationAcceptanceSignatureV2 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "tenantId",
      "runId",
      "agreementId",
      "rfqId",
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
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementCancellationAcceptanceSignature.v2"] },
      tenantId: { type: "string" },
      runId: { type: "string" },
      agreementId: { type: "string" },
      rfqId: { type: "string" },
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

  const MarketplaceAgreementPolicyBindingV2 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "agreementId",
      "tenantId",
      "rfqId",
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
      schemaVersion: { type: "string", enum: ["MarketplaceAgreementPolicyBinding.v2"] },
      agreementId: { type: "string" },
      tenantId: { type: "string" },
      rfqId: { type: "string" },
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

  const MarketplaceCapabilityPriceModelV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "mode", "currency"],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceCapabilityPriceModel.v1"] },
      mode: { type: "string", enum: ["fixed", "hourly", "per_unit", "quote"] },
      amountCents: { type: "integer", minimum: 1, nullable: true },
      minAmountCents: { type: "integer", minimum: 1, nullable: true },
      maxAmountCents: { type: "integer", minimum: 1, nullable: true },
      currency: { type: "string" },
      unit: { type: "string", nullable: true }
    }
  };

  const MarketplaceCapabilityAvailabilityV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "timezone", "windows"],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceCapabilityAvailability.v1"] },
      timezone: { type: "string", nullable: true },
      windows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true
        }
      }
    }
  };

  const MarketplaceCapabilityListingV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "listingId",
      "tenantId",
      "capability",
      "title",
      "status",
      "tags",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceCapabilityListing.v1"] },
      listingId: { type: "string" },
      tenantId: { type: "string" },
      capability: { type: "string" },
      title: { type: "string" },
      description: { type: "string", nullable: true },
      category: { type: "string", nullable: true },
      sellerAgentId: { type: "string", nullable: true },
      status: { type: "string", enum: ["active", "paused", "retired"] },
      tags: {
        type: "array",
        items: { type: "string" }
      },
      priceModel: { ...MarketplaceCapabilityPriceModelV1, nullable: true },
      availability: { ...MarketplaceCapabilityAvailabilityV1, nullable: true },
      metadata: { type: "object", additionalProperties: true, nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  };

  const MarketplaceCapabilityListingUpsertRequest = {
    type: "object",
    additionalProperties: false,
    properties: {
      listingId: { type: "string" },
      capability: { type: "string" },
      title: { type: "string" },
      description: { type: "string", nullable: true },
      category: { type: "string", nullable: true },
      sellerAgentId: { type: "string", nullable: true },
      status: { type: "string", enum: ["active", "paused", "retired"] },
      tags: {
        type: "array",
        items: { type: "string" }
      },
      priceModel: { ...MarketplaceCapabilityPriceModelV1, nullable: true },
      availability: { ...MarketplaceCapabilityAvailabilityV1, nullable: true },
      metadata: { type: "object", additionalProperties: true, nullable: true }
    }
  };

  const ProviderConformanceVerdictV1 = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "requiredChecks", "passedChecks"],
    properties: {
      ok: { type: "boolean" },
      requiredChecks: { type: "integer", minimum: 0 },
      passedChecks: { type: "integer", minimum: 0 }
    }
  };

  const ProviderConformanceSummaryV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "generatedAt", "verdict"],
    properties: {
      schemaVersion: { type: "string" },
      generatedAt: { type: "string", format: "date-time", nullable: true },
      verdict: ProviderConformanceVerdictV1
    }
  };

  const MarketplaceProviderCertificationBadgeV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "providerId",
      "providerRef",
      "publicationId",
      "status",
      "certified",
      "manifestHash",
      "providerSigningKeyId",
      "toolCount",
      "conformance",
      "badgeHash"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceProviderCertificationBadge.v1"] },
      providerId: { type: "string" },
      providerRef: { type: "string" },
      publicationId: { type: "string" },
      status: { type: "string", enum: ["certified", "conformance_failed", "draft"] },
      certified: { type: "boolean" },
      certifiedAt: { type: "string", format: "date-time", nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true },
      manifestHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      providerSigningKeyId: { type: "string", nullable: true },
      toolCount: { type: "integer", minimum: 0 },
      conformance: { ...ProviderConformanceSummaryV1, nullable: true },
      badgeHash: { type: "string", pattern: "^[0-9a-f]{64}$" }
    }
  };

  const MarketplaceProviderPublicationSummaryV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "publicationId",
      "tenantId",
      "providerId",
      "providerRef",
      "status",
      "certified",
      "baseUrl",
      "tags",
      "toolCount",
      "manifestSchemaVersion",
      "manifestHash",
      "conformance",
      "certificationBadge",
      "publishedAt",
      "certifiedAt",
      "updatedAt"
    ],
    properties: {
      schemaVersion: { type: "string" },
      publicationId: { type: "string" },
      tenantId: { type: "string" },
      providerId: { type: "string" },
      providerRef: { type: "string", nullable: true },
      status: { type: "string", enum: ["certified", "conformance_failed", "draft"] },
      certified: { type: "boolean" },
      baseUrl: { type: "string" },
      description: { type: "string", nullable: true },
      tags: {
        type: "array",
        items: { type: "string" }
      },
      toolCount: { type: "integer", minimum: 0 },
      manifestSchemaVersion: { type: "string" },
      manifestHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      conformance: { ...ProviderConformanceSummaryV1, nullable: true },
      certificationBadge: { ...MarketplaceProviderCertificationBadgeV1, nullable: true },
      publishedAt: { type: "string", format: "date-time", nullable: true },
      certifiedAt: { type: "string", format: "date-time", nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true }
    }
  };

  const MarketplaceToolListingV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "providerId",
      "providerRef",
      "publicationId",
      "certified",
      "providerStatus",
      "providerTags",
      "manifestSchemaVersion",
      "manifestHash",
      "toolId",
      "pricing",
      "certificationBadge",
      "publishedAt",
      "updatedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceToolListing.v1"] },
      providerId: { type: "string" },
      providerRef: { type: "string", nullable: true },
      publicationId: { type: "string" },
      certified: { type: "boolean" },
      providerStatus: { type: "string", enum: ["certified", "conformance_failed", "draft"] },
      providerDescription: { type: "string", nullable: true },
      providerTags: {
        type: "array",
        items: { type: "string" }
      },
      manifestSchemaVersion: { type: "string", nullable: true },
      manifestHash: { type: "string", pattern: "^[0-9a-f]{64}$", nullable: true },
      toolId: { type: "string" },
      mcpToolName: { type: "string", nullable: true },
      description: { type: "string", nullable: true },
      method: { type: "string", nullable: true },
      paidPath: { type: "string", nullable: true },
      upstreamPath: { type: "string", nullable: true },
      tags: {
        type: "array",
        items: { type: "string" }
      },
      pricing: {
        type: "object",
        additionalProperties: false,
        required: ["amountCents", "currency"],
        properties: {
          amountCents: { type: "integer", minimum: 1, nullable: true },
          currency: { type: "string", nullable: true }
        }
      },
      idempotency: { type: "string", nullable: true },
      signatureMode: { type: "string", nullable: true },
      authMode: { type: "string", nullable: true },
      certificationBadge: { ...MarketplaceProviderCertificationBadgeV1, nullable: true },
      publishedAt: { type: "string", format: "date-time", nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true }
    }
  };

  const MarketplaceRfqV1 = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "rfqId", "tenantId", "title", "status", "currency", "createdAt", "updatedAt"],
    properties: {
      schemaVersion: { type: "string", enum: ["MarketplaceRfq.v1"] },
      rfqId: { type: "string" },
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

  const MarketplaceTaskAgreementV2 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "agreementId",
      "tenantId",
      "rfqId",
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
      schemaVersion: { type: "string", enum: ["MarketplaceTaskAgreement.v2"] },
      agreementId: { type: "string" },
      tenantId: { type: "string" },
      rfqId: { type: "string" },
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
      offer: { ...MarketplaceOfferV2, nullable: true },
      offerHash: { type: "string", nullable: true },
      offerAcceptance: { ...MarketplaceAcceptanceV2, nullable: true },
      offerAcceptanceHash: { type: "string", nullable: true },
      negotiation: { ...MarketplaceAgreementNegotiationV1, nullable: true },
      acceptance: { ...MarketplaceAgreementAcceptanceV1, nullable: true },
      acceptanceSignature: { ...MarketplaceAgreementAcceptanceSignatureV2, nullable: true },
      termsHash: { type: "string" },
      verificationMethodHash: { type: "string" },
      policyHash: { type: "string" },
      policyRef: MarketplaceSettlementPolicyRefV1,
      policyBinding: { ...MarketplaceAgreementPolicyBindingV2, nullable: true },
      verificationMethod: VerificationMethodV1,
      policy: SettlementPolicyV1,
      terms: MarketplaceAgreementTermsV1
    }
  };

  const MarketplaceRfqCreateRequest = {
    type: "object",
    additionalProperties: false,
    properties: {
      rfqId: { type: "string" },
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

  const MarketplaceRfqBidV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "bidId",
      "rfqId",
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
      rfqId: { type: "string" },
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
      rfq: MarketplaceRfqV1,
      run: AgentRunV1,
      settlement: AgentRunSettlementV1,
      agreement: { allOf: [MarketplaceTaskAgreementV2], nullable: true },
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

  const ArbitrationVerdictSignedRequest = {
    type: "object",
    additionalProperties: false,
    required: ["caseId", "verdictId", "arbiterAgentId", "outcome", "releaseRatePct", "rationale", "evidenceRefs", "signerKeyId", "signature"],
    properties: {
      caseId: { type: "string" },
      verdictId: { type: "string" },
      arbiterAgentId: { type: "string" },
      outcome: { type: "string", enum: ["accepted", "rejected", "partial"] },
      releaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
      rationale: { type: "string" },
      evidenceRefs: { type: "array", items: { type: "string" } },
      issuedAt: { type: "string", format: "date-time" },
      appealRef: {
        type: "object",
        additionalProperties: false,
        nullable: true,
        properties: {
          appealCaseId: { type: "string" },
          parentVerdictId: { type: "string" },
          reason: { type: "string", nullable: true }
        }
      },
      signerKeyId: { type: "string" },
      signature: { type: "string" }
    }
  };

  const DisputeOpenEnvelopeSignedRequest = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "artifactType",
      "artifactId",
      "envelopeId",
      "caseId",
      "tenantId",
      "agreementHash",
      "receiptHash",
      "holdHash",
      "openedByAgentId",
      "openedAt",
      "reasonCode",
      "nonce",
      "signerKeyId",
      "envelopeHash",
      "signature"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["DisputeOpenEnvelope.v1"] },
      artifactType: { type: "string", enum: ["DisputeOpenEnvelope.v1"] },
      artifactId: { type: "string" },
      envelopeId: { type: "string" },
      caseId: { type: "string" },
      tenantId: { type: "string" },
      agreementHash: { type: "string" },
      receiptHash: { type: "string" },
      holdHash: { type: "string" },
      openedByAgentId: { type: "string" },
      openedAt: { type: "string", format: "date-time" },
      reasonCode: { type: "string" },
      nonce: { type: "string" },
      signerKeyId: { type: "string" },
      envelopeHash: { type: "string" },
      signature: { type: "string" }
    }
  };

  const ArbitrationCaseV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "caseId",
      "tenantId",
      "runId",
      "settlementId",
      "disputeId",
      "claimantAgentId",
      "respondentAgentId",
      "status",
      "openedAt",
      "evidenceRefs",
      "revision",
      "createdAt",
      "updatedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["ArbitrationCase.v1"] },
      caseId: { type: "string" },
      tenantId: { type: "string" },
      runId: { type: "string" },
      settlementId: { type: "string" },
      disputeId: { type: "string" },
      claimantAgentId: { type: "string" },
      respondentAgentId: { type: "string" },
      arbiterAgentId: { type: "string", nullable: true },
      status: { type: "string", enum: ["open", "under_review", "verdict_issued", "closed"] },
      openedAt: { type: "string", format: "date-time" },
      closedAt: { type: "string", format: "date-time", nullable: true },
      summary: { type: "string", nullable: true },
      evidenceRefs: { type: "array", items: { type: "string" } },
      verdictId: { type: "string", nullable: true },
      verdictHash: { type: "string", nullable: true },
      appealRef: {
        type: "object",
        additionalProperties: false,
        nullable: true,
        properties: {
          parentCaseId: { type: "string" },
          parentVerdictId: { type: "string" },
          reason: { type: "string", nullable: true }
        }
      },
      metadata: { type: "object", additionalProperties: true, nullable: true },
      revision: { type: "integer", minimum: 0 },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    }
  };

  const FundingHoldV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "tenantId",
      "agreementHash",
      "receiptHash",
      "payerAgentId",
      "payeeAgentId",
      "amountCents",
      "heldAmountCents",
      "currency",
      "holdbackBps",
      "challengeWindowMs",
      "createdAt",
      "holdHash",
      "status",
      "revision",
      "updatedAt"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["FundingHold.v1"] },
      tenantId: { type: "string" },
      agreementHash: { type: "string" },
      receiptHash: { type: "string" },
      payerAgentId: { type: "string" },
      payeeAgentId: { type: "string" },
      amountCents: { type: "integer", minimum: 1 },
      heldAmountCents: { type: "integer", minimum: 0 },
      currency: { type: "string" },
      holdbackBps: { type: "integer", minimum: 0, maximum: 10000 },
      challengeWindowMs: { type: "integer", minimum: 0 },
      createdAt: { type: "string", format: "date-time" },
      holdHash: { type: "string" },
      status: { type: "string", enum: ["held", "released", "refunded"] },
      resolvedAt: { type: "string", format: "date-time", nullable: true },
      revision: { type: "integer", minimum: 0 },
      updatedAt: { type: "string", format: "date-time" },
      metadata: { type: "object", additionalProperties: true, nullable: true }
    }
  };

  const SettlementAdjustmentV1 = {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "adjustmentId",
      "tenantId",
      "agreementHash",
      "receiptHash",
      "holdHash",
      "kind",
      "amountCents",
      "currency",
      "createdAt",
      "adjustmentHash"
    ],
    properties: {
      schemaVersion: { type: "string", enum: ["SettlementAdjustment.v1"] },
      adjustmentId: { type: "string" },
      tenantId: { type: "string" },
      agreementHash: { type: "string" },
      receiptHash: { type: "string" },
      holdHash: { type: "string" },
      kind: { type: "string", enum: ["holdback_release", "holdback_refund"] },
      amountCents: { type: "integer", minimum: 0 },
      currency: { type: "string" },
      verdictRef: {
        type: "object",
        additionalProperties: false,
        nullable: true,
        properties: {
          caseId: { type: "string" },
          verdictHash: { type: "string" }
        }
      },
      createdAt: { type: "string", format: "date-time" },
      adjustmentHash: { type: "string" },
      metadata: { type: "object", additionalProperties: true, nullable: true }
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
      policyBinding: { allOf: [MarketplaceAgreementPolicyBindingV2], nullable: true },
      policyBindingVerification: { type: "object", additionalProperties: true },
      acceptanceSignatureVerification: { type: "object", additionalProperties: true },
      runStatus: { type: "string", nullable: true },
      verificationStatus: { type: "string", enum: ["green", "amber", "red"] },
      replay: { type: "object", additionalProperties: true },
      settlement: AgentRunSettlementV1,
      kernelVerification: SettlementKernelVerification,
      matchesStoredDecision: { type: "boolean" }
    }
  };

  const RunSettlementReplayEvaluateResponse = {
    type: "object",
    additionalProperties: false,
    required: ["runId", "runStatus", "verificationStatus", "replay", "stored", "kernelVerification", "comparisons"],
    properties: {
      runId: { type: "string" },
      agreementId: { type: "string", nullable: true },
      policyVersion: { type: "integer", nullable: true },
      policyHash: { type: "string", nullable: true },
      verificationMethodHash: { type: "string", nullable: true },
      policyRef: { allOf: [MarketplaceSettlementPolicyRefV1], nullable: true },
      runStatus: { type: "string", nullable: true },
      verificationStatus: { type: "string", enum: ["green", "amber", "red"] },
      replay: { type: "object", additionalProperties: true },
      stored: { type: "object", additionalProperties: true },
      kernelVerification: SettlementKernelVerification,
      comparisons: { type: "object", additionalProperties: true }
    }
  };

  const ToolCallReplayEvaluateResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "tenantId", "agreementHash", "runId", "replay", "stored", "comparisons", "issues"],
    properties: {
      ok: { type: "boolean" },
      tenantId: { type: "string" },
      agreementHash: { type: "string" },
      runId: { type: "string" },
      replay: { type: "object", additionalProperties: true },
      stored: { type: "object", additionalProperties: true },
      comparisons: { type: "object", additionalProperties: true },
      issues: { type: "array", items: { type: "string" } }
    }
  };

  const ReputationFactsResponse = {
    type: "object",
    additionalProperties: false,
    required: ["ok", "tenantId", "agentId", "window", "asOf", "facts"],
    properties: {
      ok: { type: "boolean" },
      tenantId: { type: "string" },
      agentId: { type: "string" },
      toolId: { type: "string", nullable: true },
      window: { type: "string", enum: ["7d", "30d", "allTime"] },
      asOf: { type: "string", format: "date-time" },
      windowStartAt: { type: "string", format: "date-time", nullable: true },
      facts: {
        type: "object",
        additionalProperties: false,
        properties: {
          totals: { type: "object", additionalProperties: true },
          latencyMs: {
            type: "object",
            additionalProperties: false,
            properties: {
              count: { type: "integer", minimum: 0 },
              p50: { type: "integer", minimum: 0, nullable: true },
              p95: { type: "integer", minimum: 0, nullable: true }
            }
          }
        }
      },
      events: {
        type: "array",
        nullable: true,
        items: { type: "object", additionalProperties: true }
      }
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

  const CommandCenterKernelCodeCount = {
    type: "object",
    additionalProperties: false,
    required: ["code", "count"],
    properties: {
      code: { type: "string" },
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
        required: [
          "windowHours",
          "resolvedCount",
          "lockedCount",
          "settlementAmountCents",
          "releasedAmountCents",
          "refundedAmountCents",
          "kernelVerificationErrorCount",
          "kernelVerificationErrorCountsByCode"
        ],
        properties: {
          windowHours: { type: "integer", minimum: 1 },
          resolvedCount: { type: "integer", minimum: 0 },
          lockedCount: { type: "integer", minimum: 0 },
          settlementAmountCents: { type: "integer", minimum: 0 },
          releasedAmountCents: { type: "integer", minimum: 0 },
          refundedAmountCents: { type: "integer", minimum: 0 },
          kernelVerificationErrorCount: { type: "integer", minimum: 0 },
          kernelVerificationErrorCountsByCode: { type: "array", items: CommandCenterKernelCodeCount }
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

  const OpsArbitrationQueueItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      caseId: { type: "string", nullable: true },
      runId: { type: "string", nullable: true },
      disputeId: { type: "string", nullable: true },
      settlementId: { type: "string", nullable: true },
      priority: { type: "string", enum: ["low", "normal", "high", "critical"], nullable: true },
      status: { type: "string", enum: ["open", "under_review", "verdict_issued", "closed"], nullable: true },
      arbiterAgentId: { type: "string", nullable: true },
      openedAt: { type: "string", format: "date-time", nullable: true },
      closedAt: { type: "string", format: "date-time", nullable: true },
      ageSeconds: { type: "integer", minimum: 0, nullable: true },
      ageHours: { type: "number", minimum: 0, nullable: true },
      slaHours: { type: "number", minimum: 1, maximum: 8760 },
      dueAt: { type: "string", format: "date-time", nullable: true },
      overSla: { type: "boolean" },
      summary: { type: "string", nullable: true },
      evidenceCount: { type: "integer", minimum: 0 },
      appealRef: { type: "object", additionalProperties: true, nullable: true },
      revision: { type: "integer", minimum: 0, nullable: true },
      updatedAt: { type: "string", format: "date-time", nullable: true }
    }
  };

  const OpsArbitrationQueueResponse = {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "filters", "count", "limit", "offset", "overSlaCount", "statusCounts", "queue"],
    properties: {
      tenantId: { type: "string" },
      filters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", nullable: true },
          openedSince: { type: "string", format: "date-time", nullable: true },
          runId: { type: "string", nullable: true },
          caseId: { type: "string", nullable: true },
          priority: { type: "string", enum: ["low", "normal", "high", "critical"], nullable: true },
          assignedArbiter: { type: "boolean", nullable: true },
          slaHours: { type: "number", minimum: 1, maximum: 8760 }
        }
      },
      count: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0 },
      overSlaCount: { type: "integer", minimum: 0 },
      statusCounts: {
        type: "object",
        additionalProperties: { type: "integer", minimum: 0 }
      },
      queue: { type: "array", items: OpsArbitrationQueueItem }
    }
  };

  const OpsArbitrationTimelineEvent = {
    type: "object",
    additionalProperties: false,
    required: ["eventType", "at", "source", "details"],
    properties: {
      eventType: { type: "string" },
      at: { type: "string", format: "date-time" },
      source: { type: "string", nullable: true },
      details: { type: "object", additionalProperties: true, nullable: true }
    }
  };

  const OpsArbitrationActionability = {
    type: "object",
    additionalProperties: false,
    required: ["canWrite", "canAssignArbiter", "canAddEvidence", "canSubmitVerdict", "canCloseCase", "canOpenAppeal"],
    properties: {
      canWrite: { type: "boolean" },
      canAssignArbiter: { type: "boolean" },
      canAddEvidence: { type: "boolean" },
      canSubmitVerdict: { type: "boolean" },
      canCloseCase: { type: "boolean" },
      canOpenAppeal: { type: "boolean" }
    }
  };

  const OpsArbitrationEvidenceRefs = {
    type: "object",
    additionalProperties: false,
    required: ["case", "disputeContext", "disputeResolution", "all"],
    properties: {
      case: { type: "array", items: { type: "string" } },
      disputeContext: { type: "array", items: { type: "string" } },
      disputeResolution: { type: "array", items: { type: "string" } },
      all: { type: "array", items: { type: "string" } }
    }
  };

  const OpsArbitrationWorkspaceResponse = {
    type: "object",
    additionalProperties: false,
    required: [
      "tenantId",
      "runId",
      "caseId",
      "slaHours",
      "queueItem",
      "arbitrationCase",
      "relatedCases",
      "settlement",
      "run",
      "actionability",
      "timeline",
      "evidenceRefs"
    ],
    properties: {
      tenantId: { type: "string" },
      runId: { type: "string" },
      caseId: { type: "string" },
      slaHours: { type: "number", minimum: 1, maximum: 8760 },
      queueItem: OpsArbitrationQueueItem,
      arbitrationCase: ArbitrationCaseV1,
      relatedCases: { type: "array", items: OpsArbitrationQueueItem },
      settlement: AgentRunSettlementV1,
      run: {
        type: "object",
        nullable: true,
        additionalProperties: false,
        properties: {
          run: AgentRunV1,
          verification: { type: "object", additionalProperties: true, nullable: true },
          recentEvents: { type: "array", items: { type: "object", additionalProperties: true } }
        }
      },
      actionability: OpsArbitrationActionability,
      timeline: { type: "array", items: OpsArbitrationTimelineEvent },
      evidenceRefs: OpsArbitrationEvidenceRefs
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
        AgentPassportV1,
        AgentPassportUpsertRequest,
        AgentPassportRevokeRequest,
        ToolCallAgreementV1,
        ToolCallEvidenceV1,
        AgentRunV1,
        AgentEventV1,
        AgentRunCreateRequest,
        AgentRunEventAppendRequest,
        AgentWalletV1,
        AgentRunSettlementV1,
        SettlementDecisionRecordV1,
        SettlementDecisionRecordV2,
        SettlementDecisionRecordAny,
        SettlementReceiptV1,
        SettlementKernelVerification,
        AgentReputationV1,
        AgentReputationWindowV2,
        AgentReputationV2,
        AgentReputationAny,
        X402WalletAssignment,
        X402WalletAssignmentResolveRequest,
        X402WalletAssignmentResolveResponse,
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
        MarketplaceOfferV2,
        MarketplaceAcceptanceV2,
        AgentDelegationLinkV1,
        AgentActingOnBehalfOfV1,
        DelegationTraceV1,
        DelegationTraceListResponse,
        DelegationEmergencyRevokeRequest,
        DelegationEmergencyRevokeResponse,
        OpsEmergencyPauseRequest,
        OpsEmergencyQuarantineRequest,
        OpsEmergencyRevokeRequest,
        OpsEmergencyKillSwitchRequest,
        OpsEmergencyResumeRequest,
        OpsEmergencyControlResponse,
        MarketplaceAgreementAcceptanceSignatureV2,
        MarketplaceAgreementChangeOrderAcceptanceSignatureV2,
        MarketplaceAgreementCancellationAcceptanceSignatureV2,
        MarketplaceAgreementAcceptanceSignatureInput,
        MarketplaceAgreementPolicyBindingV2,
        MarketplaceBidNegotiationProposalV1,
        MarketplaceBidNegotiationV1,
        MarketplaceAgreementNegotiationV1,
        MarketplaceCapabilityPriceModelV1,
        MarketplaceCapabilityAvailabilityV1,
        MarketplaceCapabilityListingV1,
        MarketplaceCapabilityListingUpsertRequest,
        ProviderConformanceVerdictV1,
        ProviderConformanceSummaryV1,
        MarketplaceProviderCertificationBadgeV1,
        MarketplaceProviderPublicationSummaryV1,
        MarketplaceToolListingV1,
        MarketplaceRfqV1,
        MarketplaceTaskAgreementV2,
        MarketplaceRfqCreateRequest,
        MarketplaceRfqBidV1,
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
        ArbitrationVerdictSignedRequest,
        DisputeOpenEnvelopeSignedRequest,
        ArbitrationCaseV1,
        RunSettlementPolicyReplayResponse,
        RunSettlementReplayEvaluateResponse,
        ToolCallReplayEvaluateResponse,
        ReputationFactsResponse,
        MonthCloseRequest,
        AckRequest,
        ArtifactVerificationSummary,
        OpsJobListItem,
        OpsJobsListResponse,
        CommandCenterReasonCount,
        CommandCenterDestinationCount,
        CommandCenterKernelCodeCount,
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
      "/marketplace/providers": {
        get: {
          summary: "List marketplace provider publications",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["certified", "conformance_failed", "draft", "all"] } },
            { name: "providerId", in: "query", required: false, schema: { type: "string" } },
            { name: "providerRef", in: "query", required: false, schema: { type: "string" } },
            { name: "toolId", in: "query", required: false, schema: { type: "string" } },
            { name: "q", in: "query", required: false, schema: { type: "string" } },
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
                    required: ["publications", "total", "limit", "offset"],
                    properties: {
                      publications: { type: "array", items: MarketplaceProviderPublicationSummaryV1 },
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
        }
      },
      "/marketplace/tools": {
        get: {
          summary: "List marketplace tool listings aggregated from provider publications",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["certified", "conformance_failed", "draft", "all"] } },
            { name: "providerId", in: "query", required: false, schema: { type: "string" } },
            { name: "providerRef", in: "query", required: false, schema: { type: "string" } },
            { name: "toolId", in: "query", required: false, schema: { type: "string" } },
            { name: "q", in: "query", required: false, schema: { type: "string" } },
            { name: "tags", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated tag filter" },
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
                    required: ["tools", "total", "limit", "offset"],
                    properties: {
                      tools: { type: "array", items: MarketplaceToolListingV1 },
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
        }
      },
      "/marketplace/providers/publish": {
        post: {
          summary: "Publish provider manifest and optionally run conformance",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["baseUrl", "manifest", "publishProof", "publishProofJwksUrl"],
                  properties: {
                    providerId: { type: "string", nullable: true },
                    baseUrl: { type: "string" },
                    toolId: { type: "string", nullable: true },
                    providerSigningPublicKeyPem: { type: "string", nullable: true },
                    publishProof: { type: "string" },
                    publishProofJwksUrl: { type: "string" },
                    runConformance: { type: "boolean", nullable: true },
                    description: { type: "string", nullable: true },
                    contactUrl: { type: "string", nullable: true },
                    termsUrl: { type: "string", nullable: true },
                    tags: { type: "array", items: { type: "string" } },
                    manifest: { type: "object", additionalProperties: true }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: "Updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["publication"],
                    properties: {
                      publication: { type: "object", additionalProperties: true }
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
                    required: ["publication"],
                    properties: {
                      publication: { type: "object", additionalProperties: true }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
            502: { description: "Bad Gateway", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/marketplace/providers/conformance/run": {
        post: {
          summary: "Run provider conformance checks",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["baseUrl", "manifest"],
                  properties: {
                    providerId: { type: "string", nullable: true },
                    baseUrl: { type: "string" },
                    toolId: { type: "string", nullable: true },
                    providerSigningPublicKeyPem: { type: "string", nullable: true },
                    manifest: { type: "object", additionalProperties: true }
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
                    required: ["report"],
                    properties: {
                      report: { type: "object", additionalProperties: true }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
            502: { description: "Bad Gateway", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/marketplace/providers/{providerId}": {
        get: {
          summary: "Get marketplace provider publication by id",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "providerId", in: "path", required: true, schema: { type: "string" } }
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
                    required: ["publication", "certificationBadge"],
                    properties: {
                      publication: { type: "object", additionalProperties: true },
                      certificationBadge: MarketplaceProviderCertificationBadgeV1
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
      "/marketplace/providers/{providerId}/badge": {
        get: {
          summary: "Get provider certification badge payload",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "providerId", in: "path", required: true, schema: { type: "string" } }
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
                    required: ["badge"],
                    properties: {
                      badge: MarketplaceProviderCertificationBadgeV1
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
      "/marketplace/capability-listings": {
        get: {
          summary: "List marketplace capability listings",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["active", "paused", "retired", "all"] } },
            { name: "capability", in: "query", required: false, schema: { type: "string" } },
            { name: "sellerAgentId", in: "query", required: false, schema: { type: "string" } },
            { name: "q", in: "query", required: false, schema: { type: "string" } },
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
                    required: ["listings", "total", "limit", "offset"],
                    properties: {
                      listings: { type: "array", items: MarketplaceCapabilityListingV1 },
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
          summary: "Create or upsert a marketplace capability listing",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: MarketplaceCapabilityListingUpsertRequest } } },
          responses: {
            200: {
              description: "Updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      listing: MarketplaceCapabilityListingV1
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
                      listing: MarketplaceCapabilityListingV1
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
      "/marketplace/capability-listings/{listingId}": {
        get: {
          summary: "Get marketplace capability listing by id",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "listingId", in: "path", required: true, schema: { type: "string" } }
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
                      listing: MarketplaceCapabilityListingV1
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
          summary: "Update marketplace capability listing by id",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "listingId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: MarketplaceCapabilityListingUpsertRequest } } },
          responses: {
            200: {
              description: "Updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      listing: MarketplaceCapabilityListingV1
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        delete: {
          summary: "Delete marketplace capability listing by id",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "listingId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "Deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      ok: { type: "boolean" },
                      deleted: { type: "boolean" },
                      listingId: { type: "string" },
                      listing: MarketplaceCapabilityListingV1
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
      "/marketplace/rfqs": {
        get: {
          summary: "List marketplace RFQs",
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
                    required: ["rfqs", "total", "limit", "offset"],
                    properties: {
                      rfqs: { type: "array", items: MarketplaceRfqV1 },
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
          summary: "Create a marketplace RFQ",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: MarketplaceRfqCreateRequest } } },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      rfq: MarketplaceRfqV1
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
      "/marketplace/rfqs/{rfqId}/bids": {
        get: {
          summary: "List bids for a marketplace RFQ",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "rfqId", in: "path", required: true, schema: { type: "string" } },
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
                    required: ["rfqId", "bids", "total", "limit", "offset"],
                    properties: {
                      rfqId: { type: "string" },
                      bids: { type: "array", items: MarketplaceRfqBidV1 },
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
          summary: "Submit a bid for a marketplace RFQ",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader, { name: "rfqId", in: "path", required: true, schema: { type: "string" } }],
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
                      rfq: MarketplaceRfqV1,
                      bid: MarketplaceRfqBidV1
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
      "/marketplace/rfqs/{rfqId}/bids/{bidId}/counter-offer": {
        post: {
          summary: "Apply a counter-offer revision to a pending marketplace bid",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "rfqId", in: "path", required: true, schema: { type: "string" } },
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
                      rfq: MarketplaceRfqV1,
                      bid: MarketplaceRfqBidV1,
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
      "/marketplace/rfqs/{rfqId}/accept": {
        post: {
          summary: "Accept a bid for a marketplace RFQ",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader, { name: "rfqId", in: "path", required: true, schema: { type: "string" } }],
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
                      rfq: MarketplaceRfqV1,
                      acceptedBid: { allOf: [MarketplaceRfqBidV1], nullable: true },
                      run: AgentRunV1,
                      settlement: AgentRunSettlementV1,
                      agreement: MarketplaceTaskAgreementV2,
                      offer: { allOf: [MarketplaceOfferV2], nullable: true },
                      offerAcceptance: { allOf: [MarketplaceAcceptanceV2], nullable: true },
                      decisionRecord: { ...SettlementDecisionRecordAny, nullable: true },
                      settlementReceipt: { ...SettlementReceiptV1, nullable: true }
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
      "/runs/{runId}/arbitration/cases": {
        get: {
          summary: "List arbitration cases for a run",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["open", "under_review", "verdict_issued", "closed"] } }
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
                      cases: { type: "array", items: ArbitrationCaseV1 }
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/arbitration/cases/{caseId}": {
        get: {
          summary: "Get arbitration case by id",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "runId", in: "path", required: true, schema: { type: "string" } },
            { name: "caseId", in: "path", required: true, schema: { type: "string" } }
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
                      arbitrationCase: ArbitrationCaseV1
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/runs/{runId}/arbitration/open": {
        post: {
          summary: "Open an arbitration case for an active dispute",
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
                    caseId: { type: "string" },
                    disputeId: { type: "string" },
                    claimantAgentId: { type: "string" },
                    respondentAgentId: { type: "string" },
                    arbiterAgentId: { type: "string" },
                    panelCandidateAgentIds: { type: "array", items: { type: "string" } },
                    summary: { type: "string" },
                    evidenceRefs: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      arbitrationCase: ArbitrationCaseV1,
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true }
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
      "/runs/{runId}/arbitration/assign": {
        post: {
          summary: "Assign or reassign arbiter for a case",
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
                  required: ["caseId"],
                  properties: {
                    caseId: { type: "string" },
                    arbiterAgentId: { type: "string" },
                    panelCandidateAgentIds: { type: "array", items: { type: "string" } }
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
                      arbitrationCase: ArbitrationCaseV1,
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true }
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
      "/runs/{runId}/arbitration/evidence": {
        post: {
          summary: "Attach evidence to arbitration case",
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
                  required: ["caseId", "evidenceRef"],
                  properties: {
                    caseId: { type: "string" },
                    disputeId: { type: "string" },
                    evidenceRef: { type: "string" }
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
                      arbitrationCase: ArbitrationCaseV1,
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true }
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
      "/runs/{runId}/arbitration/verdict": {
        post: {
          summary: "Submit signed arbitration verdict for a case",
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
                  required: ["caseId", "arbitrationVerdict"],
                  properties: {
                    caseId: { type: "string" },
                    disputeId: { type: "string" },
                    arbitrationVerdict: ArbitrationVerdictSignedRequest
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
                      arbitrationCase: ArbitrationCaseV1,
                      arbitrationVerdict: { type: "object", additionalProperties: true },
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationVerdictArtifact: { type: "object", additionalProperties: true, nullable: true }
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
      "/runs/{runId}/arbitration/close": {
        post: {
          summary: "Finalize arbitration case and settlement finality transition",
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
                  required: ["caseId"],
                  properties: {
                    caseId: { type: "string" },
                    disputeId: { type: "string" },
                    summary: { type: "string" },
                    resolutionOutcome: { type: "string", enum: ["accepted", "rejected", "partial", "withdrawn", "unresolved"] }
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
                      arbitrationCase: ArbitrationCaseV1,
                      settlement: AgentRunSettlementV1,
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true }
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
      "/runs/{runId}/arbitration/appeal": {
        post: {
          summary: "Open appeal arbitration case linked to parent verdict",
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
                  required: ["parentCaseId"],
                  properties: {
                    caseId: { type: "string" },
                    disputeId: { type: "string" },
                    parentCaseId: { type: "string" },
                    parentVerdictId: { type: "string" },
                    reason: { type: "string" },
                    summary: { type: "string" },
                    arbiterAgentId: { type: "string" },
                    panelCandidateAgentIds: { type: "array", items: { type: "string" } },
                    evidenceRefs: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      arbitrationCase: ArbitrationCaseV1,
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true }
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
                      verdictArtifact: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationVerdict: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationVerdictArtifact: { type: "object", additionalProperties: true, nullable: true }
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
                        releaseRatePct: { type: "integer", minimum: 0, maximum: 100, nullable: true },
                        evidenceRefs: { type: "array", items: { type: "string" } }
                      }
                    },
                    resolutionOutcome: { type: "string", enum: ["accepted", "rejected", "partial", "withdrawn", "unresolved"] },
                    resolutionEscalationLevel: { type: "string", enum: ["l1_counterparty", "l2_arbiter", "l3_external"] },
                    resolutionReleaseRatePct: { type: "integer", minimum: 0, maximum: 100 },
                    resolutionSummary: { type: "string" },
                    closedByAgentId: { type: "string" },
                    resolutionEvidenceRefs: { type: "array", items: { type: "string" } },
                    verdict: DisputeVerdictSignedRequest,
                    arbitrationVerdict: ArbitrationVerdictSignedRequest
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
                      },
                      arbitrationVerdict: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationVerdictArtifact: { type: "object", additionalProperties: true, nullable: true }
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
                      verdictArtifact: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationVerdict: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationVerdictArtifact: { type: "object", additionalProperties: true, nullable: true }
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
                      verdictArtifact: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationVerdict: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationCaseArtifact: { type: "object", additionalProperties: true, nullable: true },
                      arbitrationVerdictArtifact: { type: "object", additionalProperties: true, nullable: true }
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
      "/agents/{agentId}/passport": {
        get: {
          summary: "Get an issued agent passport",
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
                      agentPassport: AgentPassportV1
                    }
                  }
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        post: {
          summary: "Issue or rotate an agent passport",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader, { name: "agentId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: true, content: { "application/json": { schema: AgentPassportUpsertRequest } } },
          responses: {
            200: {
              description: "Updated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      agentPassport: AgentPassportV1
                    }
                  }
                }
              }
            },
            201: {
              description: "Issued",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      agentPassport: AgentPassportV1
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
      "/agents/{agentId}/passport/revoke": {
        post: {
          summary: "Revoke an issued agent passport",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader, { name: "agentId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: { required: false, content: { "application/json": { schema: AgentPassportRevokeRequest } } },
          responses: {
            200: {
              description: "Revoked",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      agentPassport: AgentPassportV1
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
                      settlement: { ...AgentRunSettlementV1, nullable: true },
                      decisionRecord: { ...SettlementDecisionRecordAny, nullable: true },
                      settlementReceipt: { ...SettlementReceiptV1, nullable: true },
                      kernelVerification: { ...SettlementKernelVerification, nullable: true }
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
                      settlement: AgentRunSettlementV1,
                      decisionRecord: { ...SettlementDecisionRecordAny, nullable: true },
                      settlementReceipt: { ...SettlementReceiptV1, nullable: true },
                      kernelVerification: SettlementKernelVerification
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
                      rfqId: { type: "string", nullable: true },
                      agreementId: { type: "string", nullable: true },
                      agreement: MarketplaceTaskAgreementV2,
                      offer: { allOf: [MarketplaceOfferV2], nullable: true },
                      offerAcceptance: { allOf: [MarketplaceAcceptanceV2], nullable: true },
                      policyRef: { allOf: [MarketplaceSettlementPolicyRefV1], nullable: true },
                      policyHash: { type: "string", nullable: true },
                      verificationMethodHash: { type: "string", nullable: true },
                      policyBindingVerification: { type: "object", additionalProperties: true },
                      acceptanceSignatureVerification: { type: "object", additionalProperties: true },
                      settlement: { ...AgentRunSettlementV1, nullable: true },
                      decisionRecord: { ...SettlementDecisionRecordAny, nullable: true },
                      settlementReceipt: { ...SettlementReceiptV1, nullable: true },
                      kernelVerification: { ...SettlementKernelVerification, nullable: true }
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
                      rfq: MarketplaceRfqV1,
                      agreement: MarketplaceTaskAgreementV2,
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
      "/runs/{runId}/settlement/replay-evaluate": {
        get: {
          summary: "Replay settlement evaluation and compare against stored decision trace",
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
                  schema: RunSettlementReplayEvaluateResponse
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
      "/tool-calls/arbitration/cases": {
        get: {
          summary: "List tool-call arbitration cases for an agreement hash",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agreementHash", in: "query", required: true, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["open", "under_review", "verdict_issued", "closed"] } }
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
                      agreementHash: { type: "string" },
                      runId: { type: "string" },
                      cases: { type: "array", items: ArbitrationCaseV1 }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/tool-calls/arbitration/cases/{caseId}": {
        get: {
          summary: "Get tool-call arbitration case by id",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "caseId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { caseId: { type: "string" }, arbitrationCase: ArbitrationCaseV1 } } } }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/tool-calls/arbitration/open": {
        post: {
          summary: "Open a tool-call arbitration case (holdback dispute)",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["agreementHash", "receiptHash", "holdHash", "summary"],
                  properties: {
                    agreementHash: { type: "string" },
                    receiptHash: { type: "string" },
                    holdHash: { type: "string" },
                    caseId: { type: "string" },
                    openedByAgentId: { type: "string" },
                    arbiterAgentId: { type: "string" },
                    panelCandidateAgentIds: { type: "array", items: { type: "string" } },
                    summary: { type: "string" },
                    evidenceRefs: { type: "array", items: { type: "string" } },
                    disputeOpenEnvelope: DisputeOpenEnvelopeSignedRequest,
                    adminOverride: { type: "object", additionalProperties: true }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      arbitrationCase: ArbitrationCaseV1,
                      arbitrationCaseArtifact: {
                        type: "object",
                        nullable: true,
                        additionalProperties: false,
                        properties: {
                          artifactId: { type: "string" },
                          artifactHash: { type: "string", nullable: true }
                        }
                      },
                      disputeOpenEnvelopeArtifact: {
                        type: "object",
                        nullable: true,
                        additionalProperties: false,
                        properties: {
                          artifactId: { type: "string" },
                          artifactHash: { type: "string", nullable: true }
                        }
                      },
                      alreadyExisted: { type: "boolean" }
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
      "/tool-calls/arbitration/verdict": {
        post: {
          summary: "Submit signed arbitration verdict for a tool-call case (binary release/refund)",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["caseId", "arbitrationVerdict"],
                  properties: {
                    caseId: { type: "string" },
                    arbitrationVerdict: ArbitrationVerdictSignedRequest
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
                      arbitrationCase: ArbitrationCaseV1,
                      arbitrationVerdict: { type: "object", additionalProperties: true, nullable: true },
                      settlementAdjustment: { allOf: [SettlementAdjustmentV1], nullable: true }
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
      "/ops/status": {
        get: {
          summary: "Ops status summary",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
        }
      },
      "/artifacts/{artifactId}": {
        get: {
          summary: "Get artifact body",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, { name: "artifactId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { artifact: { type: "object", additionalProperties: true } } } } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            501: { description: "Not Implemented", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/tool-calls/holds/lock": {
        post: {
          summary: "Ops: lock a tool-call funding hold (holdback escrow)",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_write"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["agreementHash", "receiptHash", "payerAgentId", "payeeAgentId", "amountCents", "holdbackBps", "challengeWindowMs"],
                  properties: {
                    agreementHash: { type: "string" },
                    receiptHash: { type: "string" },
                    payerAgentId: { type: "string" },
                    payeeAgentId: { type: "string" },
                    amountCents: { type: "integer", minimum: 1 },
                    currency: { type: "string" },
                    holdbackBps: { type: "integer", minimum: 0, maximum: 10000 },
                    challengeWindowMs: { type: "integer", minimum: 0 },
                    createdAt: { type: "string", format: "date-time" }
                  }
                }
              }
            }
          },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { hold: FundingHoldV1 } } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/tool-calls/holds": {
        get: {
          summary: "Ops: list tool-call funding holds",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agreementHash", in: "query", required: false, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 2000 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      ok: { type: "boolean" },
                      tenantId: { type: "string" },
                      agreementHash: { type: "string", nullable: true },
                      status: { type: "string", nullable: true },
                      limit: { type: "integer" },
                      offset: { type: "integer" },
                      holds: { type: "array", items: FundingHoldV1 }
                    }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            501: { description: "Not Implemented", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/tool-calls/replay-evaluate": {
        get: {
          summary: "Ops: replay tool-call holdback/dispute resolution by agreement hash",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agreementHash", in: "query", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: ToolCallReplayEvaluateResponse
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
            501: { description: "Not Implemented", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/reputation/facts": {
        get: {
          summary: "Ops: aggregate append-only reputation facts for an agent/tool window",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "agentId", in: "query", required: true, schema: { type: "string" } },
            { name: "toolId", in: "query", required: false, schema: { type: "string" } },
            { name: "window", in: "query", required: false, schema: { type: "string", enum: ["7d", "30d", "allTime"] } },
            { name: "asOf", in: "query", required: false, schema: { type: "string", format: "date-time" } },
            { name: "includeEvents", in: "query", required: false, schema: { type: "string", enum: ["1"] } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: ReputationFactsResponse
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            501: { description: "Not Implemented", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/tool-calls/holds/{holdHash}": {
        get: {
          summary: "Ops: get tool-call funding hold",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, { name: "holdHash", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: { ok: { type: "boolean" }, tenantId: { type: "string" }, hold: FundingHoldV1 }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            501: { description: "Not Implemented", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/maintenance/tool-call-holdback/run": {
        post: {
          summary: "Ops: run tool-call holdback maintenance tick",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_write"],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    dryRun: { type: "boolean" },
                    limit: { type: "integer", minimum: 1, maximum: 5000 }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } }
          }
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
      "/ops/delegation/chains": {
        get: {
          summary: "List delegation chains used in marketplace acceptance flows",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "runId", in: "query", required: false, schema: { type: "string" } },
            { name: "chainHash", in: "query", required: false, schema: { type: "string" } },
            { name: "delegationId", in: "query", required: false, schema: { type: "string" } },
            { name: "signerKeyId", in: "query", required: false, schema: { type: "string" } },
            { name: "signerAgentId", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: DelegationTraceListResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/delegation/chains/{chainHash}": {
        get: {
          summary: "Get delegation chain traces by chain hash",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "chainHash", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["chainHash", "traces", "total"],
                    properties: {
                      chainHash: { type: "string" },
                      traces: { type: "array", items: DelegationTraceV1 },
                      total: { type: "integer", minimum: 0 }
                    }
                  }
                }
              }
            },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/delegation/emergency-revoke": {
        post: {
          summary: "Emergency revoke delegated marketplace authority",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_write"],
          requestBody: { required: true, content: { "application/json": { schema: DelegationEmergencyRevokeRequest } } },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: DelegationEmergencyRevokeResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/emergency/pause": {
        post: {
          summary: "Emergency pause an agent for paid execution paths",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_write"],
          requestBody: { required: false, content: { "application/json": { schema: OpsEmergencyPauseRequest } } },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsEmergencyControlResponse } } },
            201: { description: "Created", content: { "application/json": { schema: OpsEmergencyControlResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/emergency/quarantine": {
        post: {
          summary: "Emergency quarantine an agent for paid execution paths",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_write"],
          requestBody: { required: false, content: { "application/json": { schema: OpsEmergencyQuarantineRequest } } },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsEmergencyControlResponse } } },
            201: { description: "Created", content: { "application/json": { schema: OpsEmergencyControlResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/emergency/revoke": {
        post: {
          summary: "Emergency revoke delegated authority for paid execution paths",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_write"],
          requestBody: { required: false, content: { "application/json": { schema: OpsEmergencyRevokeRequest } } },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsEmergencyControlResponse } } },
            201: { description: "Created", content: { "application/json": { schema: OpsEmergencyControlResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/emergency/kill-switch": {
        post: {
          summary: "Set emergency kill-switch state for high-risk execution",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_write"],
          requestBody: { required: false, content: { "application/json": { schema: OpsEmergencyKillSwitchRequest } } },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsEmergencyControlResponse } } },
            201: { description: "Created", content: { "application/json": { schema: OpsEmergencyControlResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/emergency/resume": {
        post: {
          summary: "Resume previously paused or quarantined emergency controls",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_write"],
          requestBody: { required: false, content: { "application/json": { schema: OpsEmergencyResumeRequest } } },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsEmergencyControlResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
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
            { name: "determinismRejectThreshold", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
            { name: "kernelVerificationErrorThreshold", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
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
      "/ops/arbitration/queue": {
        get: {
          summary: "List arbitration case queue for operator workflows",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["open", "under_review", "verdict_issued", "closed"] } },
            { name: "openedSince", in: "query", required: false, schema: { type: "string", format: "date-time" } },
            { name: "runId", in: "query", required: false, schema: { type: "string" } },
            { name: "caseId", in: "query", required: false, schema: { type: "string" } },
            { name: "priority", in: "query", required: false, schema: { type: "string", enum: ["low", "normal", "high", "critical"] } },
            { name: "assignedArbiter", in: "query", required: false, schema: { type: "boolean" } },
            { name: "slaHours", in: "query", required: false, schema: { type: "number", minimum: 1, maximum: 8760, default: 24 } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0, default: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_read", "finance_write", "ops_read"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsArbitrationQueueResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            501: { description: "Not implemented", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/settlement-adjustments/{adjustmentId}": {
        get: {
          summary: "Ops: get settlement adjustment record",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, { name: "adjustmentId", in: "path", required: true, schema: { type: "string" } }],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["ops_read"],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: { ok: { type: "boolean" }, tenantId: { type: "string" }, adjustment: SettlementAdjustmentV1 }
                  }
                }
              }
            },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            501: { description: "Not Implemented", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/arbitration/cases/{caseId}/workspace": {
        get: {
          summary: "Get arbitration case workspace packet",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "caseId", in: "path", required: true, schema: { type: "string" } },
            { name: "slaHours", in: "query", required: false, schema: { type: "number", minimum: 1, maximum: 8760, default: 24 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_read", "finance_write", "ops_read"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: OpsArbitrationWorkspaceResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
            501: { description: "Not implemented", content: { "application/json": { schema: ErrorResponse } } }
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
      "/ops/money-rails/{providerId}/operations/{operationId}/submit": {
        post: {
          summary: "Submit a money rail payout operation to the configured provider",
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
                    providerRef: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
            502: { description: "Upstream provider error", content: { "application/json": { schema: ErrorResponse } } },
            503: { description: "Provider circuit open", content: { "application/json": { schema: ErrorResponse } } }
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
      "/ops/finance/money-rails/stripe-connect/accounts/sync": {
        post: {
          summary: "Sync Stripe Connect account KYB/capability state from Stripe",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "providerId", in: "query", required: false, schema: { type: "string" } }
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
                    providerId: { type: "string" },
                    dryRun: { type: "boolean", default: false },
                    accountIds: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
            502: { description: "Upstream provider error", content: { "application/json": { schema: ErrorResponse } } },
            503: { description: "Provider circuit open", content: { "application/json": { schema: ErrorResponse } } }
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
      "/ops/finance/money-rails/reconcile": {
        get: {
          summary: "Reconcile payout instructions against money rail operations for a period",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "period", in: "query", required: true, schema: { type: "string", example: "2026-02" } },
            { name: "providerId", in: "query", required: false, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_read", "finance_write"],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/finance/net-close": {
        get: {
          summary: "Compute deterministic escrow net-close snapshot for a period",
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
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/ops/finance/net-close/execute": {
        post: {
          summary: "Execute escrow net-close when deterministic preconditions pass",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_write"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["period"],
                  properties: {
                    period: { type: "string", example: "2026-02" },
                    dryRun: { type: "boolean", default: false }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Preconditions failed", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/x402/wallet-assignment/resolve": {
        post: {
          summary: "Resolve deterministic x402 wallet assignment",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: X402WalletAssignmentResolveRequest
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: X402WalletAssignmentResolveResponse } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/x402/gate/authorize-payment": {
        post: {
          summary: "Authorize payment for an x402 gate",
          description:
            "Uses strict preconditions (including optional ExecutionIntent.v1 binding) before minting or reusing an authorization token.",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: X402GateAuthorizePaymentRequest
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: {
              description: "Bad Request",
              "x-settld-known-error-codes": [...X402AuthorizePaymentBadRequestKnownErrorCodes],
              content: {
                "application/json": {
                  schema: errorResponseWithKnownCodes(X402AuthorizePaymentBadRequestKnownErrorCodes)
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: {
              description: "Conflict",
              "x-settld-known-error-codes": [...X402AuthorizePaymentConflictKnownErrorCodes],
              content: {
                "application/json": {
                  schema: errorResponseWithKnownCodes(X402AuthorizePaymentConflictKnownErrorCodes)
                }
              }
            }
          }
        }
      },
      "/x402/gate/verify": {
        post: {
          summary: "Verify x402 gated execution and settle escrow",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: X402GateVerifyRequest
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: {
              description: "Bad Request",
              "x-settld-known-error-codes": [...X402GateVerifyBadRequestKnownErrorCodes],
              content: {
                "application/json": {
                  schema: errorResponseWithKnownCodes(X402GateVerifyBadRequestKnownErrorCodes)
                }
              }
            },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: {
              description: "Conflict",
              "x-settld-known-error-codes": [...X402GateVerifyConflictKnownErrorCodes],
              content: {
                "application/json": {
                  schema: errorResponseWithKnownCodes(X402GateVerifyConflictKnownErrorCodes)
                }
              }
            }
          }
        }
      },
      "/x402/zk/verification-keys": {
        post: {
          summary: "Register an immutable x402 zk verification key",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["verificationKey"],
                  properties: {
                    verificationKey: X402ZkVerificationKeyV1
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            201: { description: "Created", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        get: {
          summary: "List x402 zk verification keys",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "protocol", in: "query", required: false, schema: { type: "string", enum: ["groth16", "plonk", "stark"] } },
            { name: "providerRef", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 2000, default: 200 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 100000, default: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/x402/zk/verification-keys/{verificationKeyId}": {
        get: {
          summary: "Get x402 zk verification key by id",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "verificationKeyId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/x402/webhooks/endpoints": {
        post: {
          summary: "Register an x402 principal webhook endpoint (secret returned once)",
          parameters: [TenantHeader, ProtocolHeader, RequestIdHeader, IdempotencyHeader],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["url", "events"],
                  properties: {
                    url: { type: "string", format: "uri", example: "https://principal.example.com/webhooks/settld" },
                    events: {
                      type: "array",
                      minItems: 1,
                      items: {
                        type: "string",
                        enum: ["x402.escalation.created", "x402.escalation.approved", "x402.escalation.denied"]
                      }
                    },
                    description: { type: "string", maxLength: 300 },
                    status: { type: "string", enum: ["active", "disabled"], default: "active" }
                  }
                }
              }
            }
          },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        get: {
          summary: "List x402 webhook endpoints",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["active", "disabled", "revoked"] } },
            {
              name: "event",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["x402.escalation.created", "x402.escalation.approved", "x402.escalation.denied"] }
            },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 100000, default: 0 } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/x402/webhooks/endpoints/{endpointId}": {
        get: {
          summary: "Get x402 webhook endpoint",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "endpointId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        },
        delete: {
          summary: "Revoke x402 webhook endpoint",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            IdempotencyHeader,
            { name: "endpointId", in: "path", required: true, schema: { type: "string" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } }
          }
        }
      },
      "/x402/webhooks/endpoints/{endpointId}/rotate-secret": {
        post: {
          summary: "Rotate x402 webhook endpoint secret (returns new secret once)",
          parameters: [
            TenantHeader,
            ProtocolHeader,
            RequestIdHeader,
            { name: "endpointId", in: "path", required: true, schema: { type: "string" } }
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
                    gracePeriodSeconds: { type: "integer", minimum: 1, maximum: 604800, default: 86400 }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: ErrorResponse } } },
            404: { description: "Not Found", content: { "application/json": { schema: ErrorResponse } } },
            409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } }
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
