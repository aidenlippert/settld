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
        MonthCloseRequest,
        AckRequest
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
            { name: "partyId", in: "path", required: true, schema: { type: "string" } },
            { name: "period", in: "path", required: true, schema: { type: "string", example: "2026-02" } }
          ],
          security: [{ BearerAuth: [] }, { ProxyApiKey: [] }],
          "x-settld-scopes": ["finance_write"],
          responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } }
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
