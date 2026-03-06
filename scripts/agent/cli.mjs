#!/usr/bin/env node

import process from "node:process";
import http from "node:http";
import https from "node:https";

import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";

const INTENT_STATUSES = new Set(["proposed", "countered", "accepted"]);
const INTENT_COMMANDS = new Set(["propose", "list", "get", "counter", "accept"]);
const WORK_ORDER_STATUSES = new Set(["created", "accepted", "working", "completed", "failed", "settled", "cancelled", "disputed"]);
const WORK_ORDER_COMMANDS = new Set(["create", "list", "get", "accept", "complete"]);
const SESSION_COMMANDS = new Set(["stream", "replay-pack"]);

function usage() {
  const lines = [
    "usage:",
    "  nooterra agent resolve <agentRef> [--json] [--base-url <url>] [--protocol <version>]",
    "  nooterra agent intent propose --proposer-agent-id <id> --counterparty-agent-id <id> (--objective <text>|--objective-json <json>) --budget-envelope-json <json> [--intent-id <id>] [--constraints-json <json>] [--required-approvals-json <json>] [--success-criteria-json <json>] [--termination-policy-json <json>] [--proposed-at <iso>] [--metadata-json <json>] [--idempotency-key <key>] [--json]",
    "  nooterra agent intent list [--intent-id <id>] [--proposer-agent-id <id>] [--counterparty-agent-id <id>] [--status <proposed|countered|accepted>] [--limit <n>] [--offset <n>] [--json]",
    "  nooterra agent intent get <intentId> [--json]",
    "  nooterra agent intent counter <intentId> --proposer-agent-id <id> [--new-intent-id <id>] [--parent-intent-hash <sha256>] [--objective <text>|--objective-json <json>] [--constraints-json <json>] [--budget-envelope-json <json>] [--required-approvals-json <json>] [--success-criteria-json <json>] [--termination-policy-json <json>] [--proposed-at <iso>] [--metadata-json <json>] [--idempotency-key <key>] [--json]",
    "  nooterra agent intent accept <intentId> --accepted-by-agent-id <id> [--accepted-at <iso>] [--intent-hash <sha256>] [--idempotency-key <key>] [--json]",
    "  nooterra agent work-order create --principal-agent-id <id> --sub-agent-id <id> --required-capability <capability> --amount-cents <int> [--work-order-id <id>] [--parent-task-id <id>] [--trace-id <id>] [--currency <code>] [--quote-id <id>] [--specification-json <json>] [--constraints-json <json>] [--evidence-policy-json <json>] [--delegation-grant-ref <id>] [--authority-grant-ref <id>] [--x402-tool-id <id>] [--x402-provider-id <id>] [--intent-binding-json <json>] [--idempotency-key <key>] [--json]",
    "  nooterra agent work-order list [--work-order-id <id>] [--principal-agent-id <id>] [--sub-agent-id <id>] [--status <created|accepted|working|completed|failed|settled|cancelled|disputed>] [--limit <n>] [--offset <n>] [--json]",
    "  nooterra agent work-order get <workOrderId> [--json]",
    "  nooterra agent work-order accept <workOrderId> [--accepted-by-agent-id <id>] [--accepted-at <iso>] [--idempotency-key <key>] [--json]",
    "  nooterra agent work-order complete <workOrderId> --receipt-id <id> --status <success|failed> [--outputs-json <json>] [--metrics-json <json>] [--evidence-refs-json <json>] [--intent-hash <sha256>] [--trace-id <id>] [--delivered-at <iso>] [--completed-at <iso>] [--metadata-json <json>] [--idempotency-key <key>] [--json]",
    "  nooterra agent session stream <sessionId> [--event-type <type>] [--since-event-id <id>] [--checkpoint-consumer-id <id>] [--last-event-id <id>] [--max-events <n>] [--timeout-ms <n>] [--json]",
    "  nooterra agent session replay-pack <sessionId> [--sign] [--signer-key-id <id>] [--json]",
    "",
    "common flags:",
    "  --json                     Emit machine-readable JSON",
    "  --base-url <url>           API base URL (default: NOOTERRA_BASE_URL or http://127.0.0.1:3000)",
    "  --protocol <version>       x-nooterra-protocol header value (default: NOOTERRA_PROTOCOL or 1.0)",
    "  --tenant-id <id>           x-proxy-tenant-id header (default: NOOTERRA_TENANT_ID)",
    "  --proxy-api-key <key>      x-proxy-api-key header (default: NOOTERRA_PROXY_API_KEY or NOOTERRA_API_KEY)",
    "  --api-key <key>            Alias for --proxy-api-key",
    "  --x-api-key <key>          Alias for --proxy-api-key",
    "  --bearer-token <token>     authorization bearer token (default: NOOTERRA_BEARER_TOKEN)",
    "  --ops-token <token>        x-proxy-ops-token header (default: NOOTERRA_OPS_TOKEN)",
    "  --request-id <id>          x-request-id header (default: NOOTERRA_REQUEST_ID)",
    "  --idempotency-key <key>    x-idempotency-key header for write requests",
    "  --help                     Show this help"
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

function fail(message) {
  throw new Error(String(message ?? "agent CLI failed"));
}

function readArgValue(argv, index, rawArg) {
  const arg = String(rawArg ?? "");
  const eq = arg.indexOf("=");
  if (eq >= 0) return { value: arg.slice(eq + 1), nextIndex: index };
  return { value: String(argv[index + 1] ?? ""), nextIndex: index + 1 };
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function parseNonNegativeSafeInteger(value, fieldName, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    fail(`${fieldName} must be a safe integer between ${min} and ${max}`);
  }
  return n;
}

function parsePositiveSafeInteger(value, fieldName, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    fail(`${fieldName} must be a safe integer between ${min} and ${max}`);
  }
  return n;
}

function parseSha256(value, fieldName) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) fail(`${fieldName} must be a sha256 hex string`);
  return normalized;
}

function parseIsoDateTime(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) fail(`${fieldName} must be a non-empty string`);
  if (!Number.isFinite(Date.parse(normalized))) fail(`${fieldName} must be an ISO date-time`);
  return normalized;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseJsonString(raw, fieldName) {
  const normalized = String(raw ?? "").trim();
  if (!normalized) fail(`${fieldName} is required`);
  try {
    return JSON.parse(normalized);
  } catch {
    fail(`${fieldName} must be valid JSON`);
  }
}

function parseCommonFlag(out, argv, index, rawArg) {
  const arg = String(rawArg ?? "");

  if (arg === "--help" || arg === "-h") {
    out.help = true;
    return { handled: true, nextIndex: index };
  }
  if (arg === "--json") {
    out.json = true;
    return { handled: true, nextIndex: index };
  }
  if (arg === "--base-url" || arg.startsWith("--base-url=")) {
    const parsed = readArgValue(argv, index, arg);
    out.baseUrl = parsed.value;
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (arg === "--protocol" || arg.startsWith("--protocol=")) {
    const parsed = readArgValue(argv, index, arg);
    out.protocol = parsed.value;
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (arg === "--tenant-id" || arg.startsWith("--tenant-id=")) {
    const parsed = readArgValue(argv, index, arg);
    out.tenantId = parsed.value;
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (
    arg === "--proxy-api-key" ||
    arg === "--api-key" ||
    arg === "--x-api-key" ||
    arg.startsWith("--proxy-api-key=") ||
    arg.startsWith("--api-key=") ||
    arg.startsWith("--x-api-key=")
  ) {
    const parsed = readArgValue(argv, index, arg);
    out.proxyApiKey = parsed.value;
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (arg === "--bearer-token" || arg.startsWith("--bearer-token=")) {
    const parsed = readArgValue(argv, index, arg);
    out.bearerToken = parsed.value;
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (arg === "--ops-token" || arg.startsWith("--ops-token=")) {
    const parsed = readArgValue(argv, index, arg);
    out.opsToken = parsed.value;
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (arg === "--request-id" || arg.startsWith("--request-id=")) {
    const parsed = readArgValue(argv, index, arg);
    out.requestId = parsed.value;
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (arg === "--idempotency-key" || arg.startsWith("--idempotency-key=")) {
    const parsed = readArgValue(argv, index, arg);
    out.idempotencyKey = parsed.value;
    return { handled: true, nextIndex: parsed.nextIndex };
  }

  return { handled: false, nextIndex: index };
}

function parseArgs(argv) {
  const out = {
    command: String(argv[0] ?? "").trim() || null,
    intentCommand: null,
    workOrderCommand: null,
    sessionCommand: null,
    agentRef: null,
    intentId: null,
    workOrderId: null,
    sessionId: null,
    receiptId: null,
    baseUrl: process.env.NOOTERRA_BASE_URL ?? "http://127.0.0.1:3000",
    protocol: process.env.NOOTERRA_PROTOCOL ?? "1.0",
    tenantId: process.env.NOOTERRA_TENANT_ID ?? null,
    proxyApiKey: process.env.NOOTERRA_PROXY_API_KEY ?? process.env.NOOTERRA_API_KEY ?? null,
    bearerToken: process.env.NOOTERRA_BEARER_TOKEN ?? null,
    opsToken: process.env.NOOTERRA_OPS_TOKEN ?? null,
    requestId: process.env.NOOTERRA_REQUEST_ID ?? null,
    idempotencyKey: null,
    json: false,
    help: false,

    proposerAgentId: null,
    counterpartyAgentId: null,
    acceptedByAgentId: null,
    objective: null,
    objectiveJson: null,
    budgetEnvelopeJson: null,
    constraintsJson: null,
    requiredApprovalsJson: null,
    successCriteriaJson: null,
    terminationPolicyJson: null,
    proposedAt: null,
    acceptedAt: null,
    metadataJson: null,
    status: null,
    limit: null,
    offset: null,
    newIntentId: null,
    parentIntentHash: null,
    intentHash: null,

    principalAgentId: null,
    subAgentId: null,
    requiredCapability: null,
    amountCents: null,
    currency: null,
    parentTaskId: null,
    traceId: null,
    quoteId: null,
    x402ToolId: null,
    x402ProviderId: null,
    specificationJson: null,
    evidencePolicyJson: null,
    delegationGrantRef: null,
    authorityGrantRef: null,
    intentBindingJson: null,
    outputsJson: null,
    metricsJson: null,
    evidenceRefsJson: null,
    deliveredAt: null,
    completedAt: null,
    workOrderStatus: null,
    completionStatus: null,

    eventType: null,
    sinceEventId: null,
    checkpointConsumerId: null,
    lastEventId: null,
    maxEvents: null,
    timeoutMs: null,
    sign: false,
    signerKeyId: null
  };

  if (!out.command || out.command === "--help" || out.command === "-h") {
    out.help = true;
    return out;
  }

  if (out.command === "resolve") {
    for (let i = 1; i < argv.length; i += 1) {
      const arg = String(argv[i] ?? "");
      if (!arg) continue;

      const common = parseCommonFlag(out, argv, i, arg);
      if (common.handled) {
        i = common.nextIndex;
        continue;
      }

      if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
      if (!out.agentRef) {
        out.agentRef = arg;
        continue;
      }
      fail(`unexpected positional argument: ${arg}`);
    }
  } else if (out.command === "intent") {
    out.intentCommand = String(argv[1] ?? "").trim() || null;
    if (!out.intentCommand || out.intentCommand === "--help" || out.intentCommand === "-h") {
      out.help = true;
      return out;
    }
    if (!INTENT_COMMANDS.has(out.intentCommand)) fail(`unsupported intent command: ${out.intentCommand}`);

    for (let i = 2; i < argv.length; i += 1) {
      const arg = String(argv[i] ?? "");
      if (!arg) continue;

      const common = parseCommonFlag(out, argv, i, arg);
      if (common.handled) {
        i = common.nextIndex;
        continue;
      }

      if (out.intentCommand === "propose") {
        if (arg === "--intent-id" || arg.startsWith("--intent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.intentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--proposer-agent-id" || arg.startsWith("--proposer-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.proposerAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--counterparty-agent-id" || arg.startsWith("--counterparty-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.counterpartyAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--objective" || arg.startsWith("--objective=")) {
          const parsed = readArgValue(argv, i, arg);
          out.objective = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--objective-json" || arg.startsWith("--objective-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.objectiveJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--budget-envelope-json" || arg.startsWith("--budget-envelope-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.budgetEnvelopeJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--constraints-json" || arg.startsWith("--constraints-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.constraintsJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--required-approvals-json" || arg.startsWith("--required-approvals-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.requiredApprovalsJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--success-criteria-json" || arg.startsWith("--success-criteria-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.successCriteriaJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--termination-policy-json" || arg.startsWith("--termination-policy-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.terminationPolicyJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--proposed-at" || arg.startsWith("--proposed-at=")) {
          const parsed = readArgValue(argv, i, arg);
          out.proposedAt = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--metadata-json" || arg.startsWith("--metadata-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.metadataJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
      }

      if (out.intentCommand === "list") {
        if (arg === "--intent-id" || arg.startsWith("--intent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.intentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--proposer-agent-id" || arg.startsWith("--proposer-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.proposerAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--counterparty-agent-id" || arg.startsWith("--counterparty-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.counterpartyAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--status" || arg.startsWith("--status=")) {
          const parsed = readArgValue(argv, i, arg);
          out.status = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--limit" || arg.startsWith("--limit=")) {
          const parsed = readArgValue(argv, i, arg);
          out.limit = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--offset" || arg.startsWith("--offset=")) {
          const parsed = readArgValue(argv, i, arg);
          out.offset = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
      }

      if (out.intentCommand === "get") {
        if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
        if (!out.intentId) {
          out.intentId = arg;
          continue;
        }
        fail(`unexpected positional argument: ${arg}`);
      }

      if (out.intentCommand === "counter") {
        if (arg === "--proposer-agent-id" || arg.startsWith("--proposer-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.proposerAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--new-intent-id" || arg.startsWith("--new-intent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.newIntentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--parent-intent-hash" || arg.startsWith("--parent-intent-hash=")) {
          const parsed = readArgValue(argv, i, arg);
          out.parentIntentHash = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--objective" || arg.startsWith("--objective=")) {
          const parsed = readArgValue(argv, i, arg);
          out.objective = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--objective-json" || arg.startsWith("--objective-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.objectiveJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--constraints-json" || arg.startsWith("--constraints-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.constraintsJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--budget-envelope-json" || arg.startsWith("--budget-envelope-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.budgetEnvelopeJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--required-approvals-json" || arg.startsWith("--required-approvals-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.requiredApprovalsJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--success-criteria-json" || arg.startsWith("--success-criteria-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.successCriteriaJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--termination-policy-json" || arg.startsWith("--termination-policy-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.terminationPolicyJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--proposed-at" || arg.startsWith("--proposed-at=")) {
          const parsed = readArgValue(argv, i, arg);
          out.proposedAt = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--metadata-json" || arg.startsWith("--metadata-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.metadataJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }

        if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
        if (!out.intentId) {
          out.intentId = arg;
          continue;
        }
        fail(`unexpected positional argument: ${arg}`);
      }

      if (out.intentCommand === "accept") {
        if (arg === "--accepted-by-agent-id" || arg.startsWith("--accepted-by-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.acceptedByAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--accepted-at" || arg.startsWith("--accepted-at=")) {
          const parsed = readArgValue(argv, i, arg);
          out.acceptedAt = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--intent-hash" || arg.startsWith("--intent-hash=")) {
          const parsed = readArgValue(argv, i, arg);
          out.intentHash = parsed.value;
          i = parsed.nextIndex;
          continue;
        }

        if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
        if (!out.intentId) {
          out.intentId = arg;
          continue;
        }
        fail(`unexpected positional argument: ${arg}`);
      }

      if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
      fail(`unexpected positional argument: ${arg}`);
    }
  } else if (out.command === "work-order") {
    out.workOrderCommand = String(argv[1] ?? "").trim() || null;
    if (!out.workOrderCommand || out.workOrderCommand === "--help" || out.workOrderCommand === "-h") {
      out.help = true;
      return out;
    }
    if (!WORK_ORDER_COMMANDS.has(out.workOrderCommand)) fail(`unsupported work-order command: ${out.workOrderCommand}`);

    for (let i = 2; i < argv.length; i += 1) {
      const arg = String(argv[i] ?? "");
      if (!arg) continue;

      const common = parseCommonFlag(out, argv, i, arg);
      if (common.handled) {
        i = common.nextIndex;
        continue;
      }

      if (out.workOrderCommand === "create") {
        if (arg === "--work-order-id" || arg.startsWith("--work-order-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.workOrderId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--principal-agent-id" || arg.startsWith("--principal-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.principalAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--sub-agent-id" || arg.startsWith("--sub-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.subAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--required-capability" || arg.startsWith("--required-capability=")) {
          const parsed = readArgValue(argv, i, arg);
          out.requiredCapability = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--amount-cents" || arg.startsWith("--amount-cents=")) {
          const parsed = readArgValue(argv, i, arg);
          out.amountCents = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--currency" || arg.startsWith("--currency=")) {
          const parsed = readArgValue(argv, i, arg);
          out.currency = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--parent-task-id" || arg.startsWith("--parent-task-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.parentTaskId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--trace-id" || arg.startsWith("--trace-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.traceId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--quote-id" || arg.startsWith("--quote-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.quoteId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--x402-tool-id" || arg.startsWith("--x402-tool-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.x402ToolId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--x402-provider-id" || arg.startsWith("--x402-provider-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.x402ProviderId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--specification-json" || arg.startsWith("--specification-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.specificationJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--constraints-json" || arg.startsWith("--constraints-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.constraintsJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--evidence-policy-json" || arg.startsWith("--evidence-policy-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.evidencePolicyJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--delegation-grant-ref" || arg.startsWith("--delegation-grant-ref=")) {
          const parsed = readArgValue(argv, i, arg);
          out.delegationGrantRef = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--authority-grant-ref" || arg.startsWith("--authority-grant-ref=")) {
          const parsed = readArgValue(argv, i, arg);
          out.authorityGrantRef = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--intent-binding-json" || arg.startsWith("--intent-binding-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.intentBindingJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
      }

      if (out.workOrderCommand === "list") {
        if (arg === "--work-order-id" || arg.startsWith("--work-order-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.workOrderId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--principal-agent-id" || arg.startsWith("--principal-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.principalAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--sub-agent-id" || arg.startsWith("--sub-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.subAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--status" || arg.startsWith("--status=")) {
          const parsed = readArgValue(argv, i, arg);
          out.workOrderStatus = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--limit" || arg.startsWith("--limit=")) {
          const parsed = readArgValue(argv, i, arg);
          out.limit = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--offset" || arg.startsWith("--offset=")) {
          const parsed = readArgValue(argv, i, arg);
          out.offset = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
      }

      if (out.workOrderCommand === "get") {
        if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
        if (!out.workOrderId) {
          out.workOrderId = arg;
          continue;
        }
        fail(`unexpected positional argument: ${arg}`);
      }

      if (out.workOrderCommand === "accept") {
        if (arg === "--accepted-by-agent-id" || arg.startsWith("--accepted-by-agent-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.acceptedByAgentId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--accepted-at" || arg.startsWith("--accepted-at=")) {
          const parsed = readArgValue(argv, i, arg);
          out.acceptedAt = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
        if (!out.workOrderId) {
          out.workOrderId = arg;
          continue;
        }
        fail(`unexpected positional argument: ${arg}`);
      }

      if (out.workOrderCommand === "complete") {
        if (arg === "--receipt-id" || arg.startsWith("--receipt-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.receiptId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--status" || arg.startsWith("--status=")) {
          const parsed = readArgValue(argv, i, arg);
          out.completionStatus = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--outputs-json" || arg.startsWith("--outputs-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.outputsJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--metrics-json" || arg.startsWith("--metrics-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.metricsJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--evidence-refs-json" || arg.startsWith("--evidence-refs-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.evidenceRefsJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--intent-hash" || arg.startsWith("--intent-hash=")) {
          const parsed = readArgValue(argv, i, arg);
          out.intentHash = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--trace-id" || arg.startsWith("--trace-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.traceId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--delivered-at" || arg.startsWith("--delivered-at=")) {
          const parsed = readArgValue(argv, i, arg);
          out.deliveredAt = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--completed-at" || arg.startsWith("--completed-at=")) {
          const parsed = readArgValue(argv, i, arg);
          out.completedAt = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--metadata-json" || arg.startsWith("--metadata-json=")) {
          const parsed = readArgValue(argv, i, arg);
          out.metadataJson = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
        if (!out.workOrderId) {
          out.workOrderId = arg;
          continue;
        }
        fail(`unexpected positional argument: ${arg}`);
      }

      if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
      fail(`unexpected positional argument: ${arg}`);
    }
  } else if (out.command === "session") {
    out.sessionCommand = String(argv[1] ?? "").trim() || null;
    if (!out.sessionCommand || out.sessionCommand === "--help" || out.sessionCommand === "-h") {
      out.help = true;
      return out;
    }
    if (!SESSION_COMMANDS.has(out.sessionCommand)) fail(`unsupported session command: ${out.sessionCommand}`);

    for (let i = 2; i < argv.length; i += 1) {
      const arg = String(argv[i] ?? "");
      if (!arg) continue;

      const common = parseCommonFlag(out, argv, i, arg);
      if (common.handled) {
        i = common.nextIndex;
        continue;
      }

      if (out.sessionCommand === "stream") {
        if (arg === "--event-type" || arg.startsWith("--event-type=")) {
          const parsed = readArgValue(argv, i, arg);
          out.eventType = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--since-event-id" || arg.startsWith("--since-event-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.sinceEventId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--checkpoint-consumer-id" || arg.startsWith("--checkpoint-consumer-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.checkpointConsumerId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--last-event-id" || arg.startsWith("--last-event-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.lastEventId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--max-events" || arg.startsWith("--max-events=")) {
          const parsed = readArgValue(argv, i, arg);
          out.maxEvents = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
        if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
          const parsed = readArgValue(argv, i, arg);
          out.timeoutMs = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
      }

      if (out.sessionCommand === "replay-pack") {
        if (arg === "--sign") {
          out.sign = true;
          continue;
        }
        if (arg === "--signer-key-id" || arg.startsWith("--signer-key-id=")) {
          const parsed = readArgValue(argv, i, arg);
          out.signerKeyId = parsed.value;
          i = parsed.nextIndex;
          continue;
        }
      }

      if (arg.startsWith("-")) fail(`unknown argument: ${arg}`);
      if (!out.sessionId) {
        out.sessionId = arg;
        continue;
      }
      fail(`unexpected positional argument: ${arg}`);
    }
  } else {
    fail(`unsupported agent command: ${out.command}`);
  }

  const normalizedBaseUrl = normalizeBaseUrl(out.baseUrl);
  if (!normalizedBaseUrl) fail("--base-url must be a valid http(s) URL");
  out.baseUrl = normalizedBaseUrl;

  out.protocol = String(out.protocol ?? "").trim() || "1.0";
  if (!out.protocol) fail("--protocol must be a non-empty string");

  out.tenantId = normalizeOptionalString(out.tenantId);
  out.proxyApiKey = normalizeOptionalString(out.proxyApiKey);
  out.bearerToken = normalizeOptionalString(out.bearerToken);
  out.opsToken = normalizeOptionalString(out.opsToken);
  out.requestId = normalizeOptionalString(out.requestId);
  out.idempotencyKey = normalizeOptionalString(out.idempotencyKey);

  if (out.command === "resolve") {
    if (typeof out.agentRef !== "string" || out.agentRef.trim() === "") fail("agentRef is required");
    out.agentRef = out.agentRef.trim();
    return out;
  }

  if (out.intentCommand === "propose") {
    out.intentId = normalizeOptionalString(out.intentId);
    out.proposerAgentId = normalizeOptionalString(out.proposerAgentId);
    out.counterpartyAgentId = normalizeOptionalString(out.counterpartyAgentId);
    if (!out.proposerAgentId) fail("proposerAgentId is required");
    if (!out.counterpartyAgentId) fail("counterpartyAgentId is required");
    if (out.objective !== null && out.objectiveJson !== null) fail("choose one of --objective or --objective-json");
    if (out.objective === null && out.objectiveJson === null) fail("objective is required");

    if (out.objectiveJson !== null) {
      const parsedObjective = parseJsonString(out.objectiveJson, "--objective-json");
      if (parsedObjective === null || parsedObjective === undefined) fail("--objective-json must not be null");
      out.objective = parsedObjective;
    } else {
      const objectiveText = normalizeOptionalString(out.objective);
      if (!objectiveText) fail("objective is required");
      out.objective = objectiveText;
    }

    const budgetEnvelope = parseJsonString(out.budgetEnvelopeJson, "--budget-envelope-json");
    if (!isPlainObject(budgetEnvelope)) fail("--budget-envelope-json must be a JSON object");
    out.budgetEnvelope = budgetEnvelope;

    if (out.constraintsJson !== null) {
      const constraints = parseJsonString(out.constraintsJson, "--constraints-json");
      if (!isPlainObject(constraints)) fail("--constraints-json must be a JSON object");
      out.constraints = constraints;
    }
    if (out.requiredApprovalsJson !== null) {
      const requiredApprovals = parseJsonString(out.requiredApprovalsJson, "--required-approvals-json");
      if (!Array.isArray(requiredApprovals)) fail("--required-approvals-json must be a JSON array");
      out.requiredApprovals = requiredApprovals;
    }
    if (out.successCriteriaJson !== null) {
      const successCriteria = parseJsonString(out.successCriteriaJson, "--success-criteria-json");
      if (!isPlainObject(successCriteria)) fail("--success-criteria-json must be a JSON object");
      out.successCriteria = successCriteria;
    }
    if (out.terminationPolicyJson !== null) {
      const terminationPolicy = parseJsonString(out.terminationPolicyJson, "--termination-policy-json");
      if (!isPlainObject(terminationPolicy)) fail("--termination-policy-json must be a JSON object");
      out.terminationPolicy = terminationPolicy;
    }
    if (out.metadataJson !== null) {
      const metadata = parseJsonString(out.metadataJson, "--metadata-json");
      if (!isPlainObject(metadata)) fail("--metadata-json must be a JSON object");
      out.metadata = metadata;
    }
    if (out.proposedAt !== null) out.proposedAt = parseIsoDateTime(out.proposedAt, "--proposed-at");
  }

  if (out.intentCommand === "list") {
    out.intentId = normalizeOptionalString(out.intentId);
    out.proposerAgentId = normalizeOptionalString(out.proposerAgentId);
    out.counterpartyAgentId = normalizeOptionalString(out.counterpartyAgentId);
    if (out.status !== null) {
      out.status = String(out.status).trim().toLowerCase();
      if (!INTENT_STATUSES.has(out.status)) fail("--status must be one of proposed|countered|accepted");
    }
    if (out.limit !== null) out.limit = parseNonNegativeSafeInteger(out.limit, "--limit", { min: 1, max: 1000 });
    if (out.offset !== null) out.offset = parseNonNegativeSafeInteger(out.offset, "--offset", { min: 0, max: Number.MAX_SAFE_INTEGER });
  }

  if (out.intentCommand === "get") {
    out.intentId = normalizeOptionalString(out.intentId);
    if (!out.intentId) fail("intentId is required");
  }

  if (out.intentCommand === "counter") {
    out.intentId = normalizeOptionalString(out.intentId);
    out.proposerAgentId = normalizeOptionalString(out.proposerAgentId);
    out.newIntentId = normalizeOptionalString(out.newIntentId);
    if (!out.intentId) fail("intentId is required");
    if (!out.proposerAgentId) fail("proposerAgentId is required");
    if (out.objective !== null && out.objectiveJson !== null) fail("choose one of --objective or --objective-json");

    if (out.objectiveJson !== null) {
      const objective = parseJsonString(out.objectiveJson, "--objective-json");
      if (objective === null || objective === undefined) fail("--objective-json must not be null");
      out.objective = objective;
    } else if (out.objective !== null) {
      const objectiveText = normalizeOptionalString(out.objective);
      if (!objectiveText) fail("--objective must be a non-empty string");
      out.objective = objectiveText;
    }

    if (out.parentIntentHash !== null) out.parentIntentHash = parseSha256(out.parentIntentHash, "--parent-intent-hash");
    if (out.constraintsJson !== null) {
      const constraints = parseJsonString(out.constraintsJson, "--constraints-json");
      if (!isPlainObject(constraints)) fail("--constraints-json must be a JSON object");
      out.constraints = constraints;
    }
    if (out.budgetEnvelopeJson !== null) {
      const budgetEnvelope = parseJsonString(out.budgetEnvelopeJson, "--budget-envelope-json");
      if (!isPlainObject(budgetEnvelope)) fail("--budget-envelope-json must be a JSON object");
      out.budgetEnvelope = budgetEnvelope;
    }
    if (out.requiredApprovalsJson !== null) {
      const requiredApprovals = parseJsonString(out.requiredApprovalsJson, "--required-approvals-json");
      if (!Array.isArray(requiredApprovals)) fail("--required-approvals-json must be a JSON array");
      out.requiredApprovals = requiredApprovals;
    }
    if (out.successCriteriaJson !== null) {
      const successCriteria = parseJsonString(out.successCriteriaJson, "--success-criteria-json");
      if (!isPlainObject(successCriteria)) fail("--success-criteria-json must be a JSON object");
      out.successCriteria = successCriteria;
    }
    if (out.terminationPolicyJson !== null) {
      const terminationPolicy = parseJsonString(out.terminationPolicyJson, "--termination-policy-json");
      if (!isPlainObject(terminationPolicy)) fail("--termination-policy-json must be a JSON object");
      out.terminationPolicy = terminationPolicy;
    }
    if (out.metadataJson !== null) {
      const metadata = parseJsonString(out.metadataJson, "--metadata-json");
      if (!isPlainObject(metadata)) fail("--metadata-json must be a JSON object");
      out.metadata = metadata;
    }
    if (out.proposedAt !== null) out.proposedAt = parseIsoDateTime(out.proposedAt, "--proposed-at");
  }

  if (out.intentCommand === "accept") {
    out.intentId = normalizeOptionalString(out.intentId);
    out.acceptedByAgentId = normalizeOptionalString(out.acceptedByAgentId);
    if (!out.intentId) fail("intentId is required");
    if (!out.acceptedByAgentId) fail("acceptedByAgentId is required");
    if (out.acceptedAt !== null) out.acceptedAt = parseIsoDateTime(out.acceptedAt, "--accepted-at");
    if (out.intentHash !== null) out.intentHash = parseSha256(out.intentHash, "--intent-hash");
  }

  if (out.command === "work-order") {
    out.workOrderId = normalizeOptionalString(out.workOrderId);
    out.principalAgentId = normalizeOptionalString(out.principalAgentId);
    out.subAgentId = normalizeOptionalString(out.subAgentId);
    out.requiredCapability = normalizeOptionalString(out.requiredCapability);
    out.currency = normalizeOptionalString(out.currency);
    out.parentTaskId = normalizeOptionalString(out.parentTaskId);
    out.traceId = normalizeOptionalString(out.traceId);
    out.quoteId = normalizeOptionalString(out.quoteId);
    out.x402ToolId = normalizeOptionalString(out.x402ToolId);
    out.x402ProviderId = normalizeOptionalString(out.x402ProviderId);
    out.delegationGrantRef = normalizeOptionalString(out.delegationGrantRef);
    out.authorityGrantRef = normalizeOptionalString(out.authorityGrantRef);

    if (out.workOrderCommand === "create") {
      if (!out.principalAgentId) fail("principalAgentId is required");
      if (!out.subAgentId) fail("subAgentId is required");
      if (!out.requiredCapability) fail("requiredCapability is required");
      out.amountCents = parsePositiveSafeInteger(out.amountCents, "--amount-cents", { min: 1, max: Number.MAX_SAFE_INTEGER });
      out.currency = String(out.currency ?? "USD").trim().toUpperCase();
      if (!out.currency || !/^[A-Z0-9_]{2,8}$/.test(out.currency)) fail("--currency must match ^[A-Z0-9_]{2,8}$");

      if (out.specificationJson !== null) {
        const specification = parseJsonString(out.specificationJson, "--specification-json");
        if (!isPlainObject(specification)) fail("--specification-json must be a JSON object");
        out.specification = specification;
      }
      if (out.constraintsJson !== null) {
        const constraints = parseJsonString(out.constraintsJson, "--constraints-json");
        if (!isPlainObject(constraints)) fail("--constraints-json must be a JSON object");
        out.constraints = constraints;
      }
      if (out.evidencePolicyJson !== null) {
        const evidencePolicy = parseJsonString(out.evidencePolicyJson, "--evidence-policy-json");
        if (!isPlainObject(evidencePolicy)) fail("--evidence-policy-json must be a JSON object");
        out.evidencePolicy = evidencePolicy;
      }
      if (out.intentBindingJson !== null) {
        const intentBinding = parseJsonString(out.intentBindingJson, "--intent-binding-json");
        if (!isPlainObject(intentBinding)) fail("--intent-binding-json must be a JSON object");
        if (!normalizeOptionalString(intentBinding.intentId)) fail("--intent-binding-json.intentId is required");
        if (intentBinding.intentHash !== null && intentBinding.intentHash !== undefined) {
          intentBinding.intentHash = parseSha256(intentBinding.intentHash, "--intent-binding-json.intentHash");
        }
        if (intentBinding.boundAt !== null && intentBinding.boundAt !== undefined) {
          intentBinding.boundAt = parseIsoDateTime(intentBinding.boundAt, "--intent-binding-json.boundAt");
        }
        out.intentBinding = intentBinding;
      }
      if (!out.idempotencyKey) fail("--idempotency-key is required for work-order create");
    }

    if (out.workOrderCommand === "list") {
      if (out.workOrderStatus !== null) {
        out.workOrderStatus = String(out.workOrderStatus).trim().toLowerCase();
        if (!WORK_ORDER_STATUSES.has(out.workOrderStatus)) {
          fail("--status must be one of created|accepted|working|completed|failed|settled|cancelled|disputed");
        }
      }
      if (out.limit !== null) out.limit = parsePositiveSafeInteger(out.limit, "--limit", { min: 1, max: 1000 });
      if (out.offset !== null) out.offset = parseNonNegativeSafeInteger(out.offset, "--offset", { min: 0, max: Number.MAX_SAFE_INTEGER });
    }

    if (out.workOrderCommand === "get") {
      if (!out.workOrderId) fail("workOrderId is required");
    }

    if (out.workOrderCommand === "accept") {
      if (!out.workOrderId) fail("workOrderId is required");
      out.acceptedByAgentId = normalizeOptionalString(out.acceptedByAgentId);
      if (out.acceptedAt !== null) out.acceptedAt = parseIsoDateTime(out.acceptedAt, "--accepted-at");
      if (!out.idempotencyKey) fail("--idempotency-key is required for work-order accept");
    }

    if (out.workOrderCommand === "complete") {
      if (!out.workOrderId) fail("workOrderId is required");
      out.receiptId = normalizeOptionalString(out.receiptId);
      if (!out.receiptId) fail("receiptId is required");
      out.completionStatus = String(out.completionStatus ?? "").trim().toLowerCase();
      if (out.completionStatus !== "success" && out.completionStatus !== "failed") {
        fail("--status must be one of success|failed");
      }
      if (out.outputsJson !== null) {
        const outputs = parseJsonString(out.outputsJson, "--outputs-json");
        if (!isPlainObject(outputs)) fail("--outputs-json must be a JSON object");
        out.outputs = outputs;
      }
      if (out.metricsJson !== null) {
        const metrics = parseJsonString(out.metricsJson, "--metrics-json");
        if (!isPlainObject(metrics)) fail("--metrics-json must be a JSON object");
        out.metrics = metrics;
      }
      if (out.evidenceRefsJson !== null) {
        const evidenceRefs = parseJsonString(out.evidenceRefsJson, "--evidence-refs-json");
        if (!Array.isArray(evidenceRefs)) fail("--evidence-refs-json must be a JSON array");
        out.evidenceRefs = evidenceRefs;
      }
      if (out.intentHash !== null) out.intentHash = parseSha256(out.intentHash, "--intent-hash");
      if (out.deliveredAt !== null) out.deliveredAt = parseIsoDateTime(out.deliveredAt, "--delivered-at");
      if (out.completedAt !== null) out.completedAt = parseIsoDateTime(out.completedAt, "--completed-at");
      if (out.metadataJson !== null) {
        const metadata = parseJsonString(out.metadataJson, "--metadata-json");
        if (!isPlainObject(metadata)) fail("--metadata-json must be a JSON object");
        out.metadata = metadata;
      }
      if (!out.idempotencyKey) fail("--idempotency-key is required for work-order complete");
    }
  }

  if (out.command === "session") {
    out.sessionId = normalizeOptionalString(out.sessionId);
    out.eventType = normalizeOptionalString(out.eventType);
    out.sinceEventId = normalizeOptionalString(out.sinceEventId);
    out.checkpointConsumerId = normalizeOptionalString(out.checkpointConsumerId);
    out.lastEventId = normalizeOptionalString(out.lastEventId);
    out.signerKeyId = normalizeOptionalString(out.signerKeyId);
    if (!out.sessionId) fail("sessionId is required");

    if (out.sessionCommand === "stream") {
      if (out.maxEvents !== null) out.maxEvents = parsePositiveSafeInteger(out.maxEvents, "--max-events", { min: 1, max: 200 });
      else out.maxEvents = 20;
      if (out.timeoutMs !== null) out.timeoutMs = parsePositiveSafeInteger(out.timeoutMs, "--timeout-ms", { min: 200, max: 300000 });
      else out.timeoutMs = 2000;
      if (out.eventType) out.eventType = String(out.eventType).trim().toUpperCase();
    }

    if (out.sessionCommand === "replay-pack") {
      if (!out.sign && out.signerKeyId) fail("--signer-key-id requires --sign");
    }
  }

  return out;
}

function printJson(payload) {
  process.stdout.write(`${canonicalJsonStringify(normalizeForCanonicalJson(payload, { path: "$" }))}\n`);
}

function printTextResolveSuccess(payload) {
  const locator = payload?.locator && typeof payload.locator === "object" && !Array.isArray(payload.locator) ? payload.locator : null;
  const resolved = locator?.resolved && typeof locator.resolved === "object" && !Array.isArray(locator.resolved) ? locator.resolved : null;
  const lines = [
    `status: ${String(locator?.status ?? "resolved")}`,
    `agentRef: ${String(locator?.agentRef ?? "")}`,
    `agentId: ${String(resolved?.agentId ?? "")}`,
    `tenantId: ${String(resolved?.tenantId ?? "")}`,
    `deterministicHash: ${String(locator?.deterministicHash ?? "")}`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printTextIntentSuccess(intentCommand, payload) {
  if (intentCommand === "list") {
    const intents = Array.isArray(payload?.intents) ? payload.intents : [];
    const intentIds = intents
      .map((row) => (row && typeof row === "object" && !Array.isArray(row) ? String(row.intentId ?? "").trim() : ""))
      .filter(Boolean);
    const lines = [
      "status: ok",
      "command: intent list",
      `count: ${intents.length}`,
      `limit: ${Number.isSafeInteger(Number(payload?.limit)) ? Number(payload.limit) : intents.length}`,
      `offset: ${Number.isSafeInteger(Number(payload?.offset)) ? Number(payload.offset) : 0}`,
      `intentIds: ${intentIds.join(",")}`
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  const intentContract = payload?.intentContract && typeof payload.intentContract === "object" && !Array.isArray(payload.intentContract)
    ? payload.intentContract
    : null;
  const lines = [
    "status: ok",
    `command: intent ${intentCommand}`,
    `intentId: ${String(intentContract?.intentId ?? "")}`,
    `intentStatus: ${String(intentContract?.status ?? "")}`,
    `intentHash: ${String(intentContract?.intentHash ?? "")}`,
    `revision: ${Number.isSafeInteger(Number(intentContract?.revision)) ? Number(intentContract.revision) : 0}`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printTextWorkOrderSuccess(workOrderCommand, payload) {
  if (workOrderCommand === "list") {
    const workOrders = Array.isArray(payload?.workOrders) ? payload.workOrders : [];
    const ids = workOrders
      .map((row) => (row && typeof row === "object" && !Array.isArray(row) ? String(row.workOrderId ?? "").trim() : ""))
      .filter(Boolean);
    const lines = [
      "status: ok",
      "command: work-order list",
      `count: ${workOrders.length}`,
      `limit: ${Number.isSafeInteger(Number(payload?.limit)) ? Number(payload.limit) : workOrders.length}`,
      `offset: ${Number.isSafeInteger(Number(payload?.offset)) ? Number(payload.offset) : 0}`,
      `workOrderIds: ${ids.join(",")}`
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  const workOrder = payload?.workOrder && typeof payload.workOrder === "object" && !Array.isArray(payload.workOrder) ? payload.workOrder : null;
  const completionReceipt =
    payload?.completionReceipt && typeof payload.completionReceipt === "object" && !Array.isArray(payload.completionReceipt)
      ? payload.completionReceipt
      : null;
  const lines = [
    "status: ok",
    `command: work-order ${workOrderCommand}`,
    `workOrderId: ${String(workOrder?.workOrderId ?? "")}`,
    `workOrderStatus: ${String(workOrder?.status ?? "")}`,
    `revision: ${Number.isSafeInteger(Number(workOrder?.revision)) ? Number(workOrder.revision) : 0}`,
    `completionReceiptId: ${String(completionReceipt?.receiptId ?? workOrder?.completionReceiptId ?? "")}`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printTextSessionSuccess(sessionCommand, payload) {
  if (sessionCommand === "stream") {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const eventIds = events
      .map((row) => (row && typeof row === "object" && !Array.isArray(row) ? String(row.id ?? "").trim() : ""))
      .filter(Boolean);
    const lines = [
      "status: ok",
      "command: session stream",
      `sessionId: ${String(payload?.sessionId ?? "")}`,
      `count: ${events.length}`,
      `lastEventId: ${String(payload?.lastEventId ?? "")}`,
      `eventIds: ${eventIds.join(",")}`
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  const replayPack = payload?.replayPack && typeof payload.replayPack === "object" && !Array.isArray(payload.replayPack) ? payload.replayPack : null;
  const lines = [
    "status: ok",
    "command: session replay-pack",
    `sessionId: ${String(replayPack?.sessionId ?? payload?.sessionId ?? "")}`,
    `packHash: ${String(replayPack?.packHash ?? "")}`,
    `eventCount: ${Number.isSafeInteger(Number(replayPack?.eventCount)) ? Number(replayPack.eventCount) : 0}`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printTextError(payload, statusCode) {
  const code = typeof payload?.code === "string" ? payload.code : "AGENT_COMMAND_FAILED";
  const error = typeof payload?.error === "string" ? payload.error : "agent command failed";
  process.stderr.write(`error: ${error}\n`);
  process.stderr.write(`code: ${code}\n`);
  process.stderr.write(`status: ${Number.isInteger(statusCode) ? statusCode : 0}\n`);
}

function normalizeBearerToken(rawToken) {
  const raw = normalizeOptionalString(rawToken);
  if (!raw) return null;
  if (/^bearer\s+/i.test(raw)) return raw;
  return `Bearer ${raw}`;
}

function buildHeaders(args, { write = false, json = false } = {}) {
  const headers = {
    accept: "application/json",
    "x-nooterra-protocol": args.protocol
  };
  if (args.tenantId) headers["x-proxy-tenant-id"] = args.tenantId;
  if (args.proxyApiKey) headers["x-proxy-api-key"] = args.proxyApiKey;
  if (args.opsToken) headers["x-proxy-ops-token"] = args.opsToken;
  if (args.requestId) headers["x-request-id"] = args.requestId;
  if (write && args.idempotencyKey) headers["x-idempotency-key"] = args.idempotencyKey;
  const bearerToken = normalizeBearerToken(args.bearerToken);
  if (bearerToken) headers.authorization = bearerToken;
  if (json) headers["content-type"] = "application/json";
  return headers;
}

async function requestJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 15000 } = {}) {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const req = transport.request(
      parsed,
      {
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: Number(res.statusCode ?? 0),
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("agent command request timed out"));
    });
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

function parseSseFrame(frameText) {
  if (typeof frameText !== "string") return null;
  const normalized = frameText.replace(/\r/g, "");
  if (normalized.trim() === "") return null;
  const lines = normalized.split("\n");
  let eventName = "message";
  let eventId = null;
  const dataLines = [];
  let sawCommentOnlyLine = false;
  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith(":")) {
      sawCommentOnlyLine = true;
      continue;
    }
    const sepIndex = line.indexOf(":");
    const field = sepIndex === -1 ? line : line.slice(0, sepIndex);
    let value = sepIndex === -1 ? "" : line.slice(sepIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value.trim() || "message";
    if (field === "id") eventId = value.trim() || null;
    if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) {
    if (sawCommentOnlyLine) return null;
    return { event: eventName, id: eventId, rawData: "", data: null };
  }
  const rawData = dataLines.join("\n");
  let data = rawData;
  if (rawData === "null") data = null;
  else {
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
  }
  return { event: eventName, id: eventId, rawData, data };
}

async function requestSseEvents(
  url,
  {
    headers = {},
    timeoutMs = 2000,
    maxEvents = 20
  } = {}
) {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;
  const safeTimeoutMs = Number.isSafeInteger(Number(timeoutMs)) ? Math.max(200, Number(timeoutMs)) : 2000;
  const safeMaxEvents = Number.isSafeInteger(Number(maxEvents)) ? Math.max(1, Math.min(200, Number(maxEvents))) : 20;

  return await new Promise((resolve, reject) => {
    const events = [];
    let resolved = false;
    let statusCode = 0;
    let buffer = "";

    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      resolve(payload);
    };

    const req = transport.request(
      parsed,
      {
        method: "GET",
        headers
      },
      (res) => {
        statusCode = Number(res.statusCode ?? 0);
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += String(chunk ?? "");
          for (;;) {
            const splitIndex = buffer.indexOf("\n\n");
            if (splitIndex < 0) break;
            const frame = buffer.slice(0, splitIndex);
            buffer = buffer.slice(splitIndex + 2);
            const parsedFrame = parseSseFrame(frame);
            if (!parsedFrame) continue;
            events.push(parsedFrame);
            if (events.length >= safeMaxEvents) {
              try {
                req.destroy();
              } catch {
                // no-op
              }
              finish({ statusCode, events, timedOut: false, reachedMaxEvents: true });
              return;
            }
          }
        });
        res.on("end", () => {
          const trailing = parseSseFrame(buffer);
          if (trailing) events.push(trailing);
          finish({ statusCode, events, timedOut: false, reachedMaxEvents: events.length >= safeMaxEvents });
        });
      }
    );

    req.on("error", (err) => {
      if (resolved) return;
      reject(err);
    });

    const timeout = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        // no-op
      }
      finish({ statusCode, events, timedOut: true, reachedMaxEvents: false });
    }, safeTimeoutMs);

    req.once("close", () => {
      clearTimeout(timeout);
    });

    req.end();
  });
}

function buildIntentRequest(args) {
  if (args.intentCommand === "propose") {
    const body = {
      proposerAgentId: args.proposerAgentId,
      counterpartyAgentId: args.counterpartyAgentId,
      objective: args.objective,
      budgetEnvelope: args.budgetEnvelope
    };
    if (args.intentId) body.intentId = args.intentId;
    if (args.constraints) body.constraints = args.constraints;
    if (args.requiredApprovals) body.requiredApprovals = args.requiredApprovals;
    if (args.successCriteria) body.successCriteria = args.successCriteria;
    if (args.terminationPolicy) body.terminationPolicy = args.terminationPolicy;
    if (args.proposedAt) body.proposedAt = args.proposedAt;
    if (args.metadata) body.metadata = args.metadata;
    return {
      method: "POST",
      path: "/intents/propose",
      write: true,
      body,
      requestErrorCode: "AGENT_INTENT_PROPOSE_REQUEST_FAILED",
      responseErrorCode: "AGENT_INTENT_PROPOSE_RESPONSE_INVALID"
    };
  }

  if (args.intentCommand === "list") {
    const query = new URLSearchParams();
    if (args.intentId) query.set("intentId", args.intentId);
    if (args.proposerAgentId) query.set("proposerAgentId", args.proposerAgentId);
    if (args.counterpartyAgentId) query.set("counterpartyAgentId", args.counterpartyAgentId);
    if (args.status) query.set("status", args.status);
    if (args.limit !== null && args.limit !== undefined) query.set("limit", String(args.limit));
    if (args.offset !== null && args.offset !== undefined) query.set("offset", String(args.offset));
    return {
      method: "GET",
      path: `/intents${query.toString() ? `?${query.toString()}` : ""}`,
      write: false,
      body: null,
      requestErrorCode: "AGENT_INTENT_LIST_REQUEST_FAILED",
      responseErrorCode: "AGENT_INTENT_LIST_RESPONSE_INVALID"
    };
  }

  if (args.intentCommand === "get") {
    return {
      method: "GET",
      path: `/intents/${encodeURIComponent(args.intentId)}`,
      write: false,
      body: null,
      requestErrorCode: "AGENT_INTENT_GET_REQUEST_FAILED",
      responseErrorCode: "AGENT_INTENT_GET_RESPONSE_INVALID"
    };
  }

  if (args.intentCommand === "counter") {
    const body = {
      proposerAgentId: args.proposerAgentId
    };
    if (args.newIntentId) body.intentId = args.newIntentId;
    if (args.parentIntentHash) body.parentIntentHash = args.parentIntentHash;
    if (args.objective !== null && args.objective !== undefined) body.objective = args.objective;
    if (args.constraints) body.constraints = args.constraints;
    if (args.budgetEnvelope) body.budgetEnvelope = args.budgetEnvelope;
    if (args.requiredApprovals) body.requiredApprovals = args.requiredApprovals;
    if (args.successCriteria) body.successCriteria = args.successCriteria;
    if (args.terminationPolicy) body.terminationPolicy = args.terminationPolicy;
    if (args.proposedAt) body.proposedAt = args.proposedAt;
    if (args.metadata) body.metadata = args.metadata;
    return {
      method: "POST",
      path: `/intents/${encodeURIComponent(args.intentId)}/counter`,
      write: true,
      body,
      requestErrorCode: "AGENT_INTENT_COUNTER_REQUEST_FAILED",
      responseErrorCode: "AGENT_INTENT_COUNTER_RESPONSE_INVALID"
    };
  }

  if (args.intentCommand === "accept") {
    const body = {
      acceptedByAgentId: args.acceptedByAgentId
    };
    if (args.acceptedAt) body.acceptedAt = args.acceptedAt;
    if (args.intentHash) body.intentHash = args.intentHash;
    return {
      method: "POST",
      path: `/intents/${encodeURIComponent(args.intentId)}/accept`,
      write: true,
      body,
      requestErrorCode: "AGENT_INTENT_ACCEPT_REQUEST_FAILED",
      responseErrorCode: "AGENT_INTENT_ACCEPT_RESPONSE_INVALID"
    };
  }

  fail(`unsupported intent command: ${args.intentCommand}`);
}

function buildWorkOrderRequest(args) {
  if (args.workOrderCommand === "create") {
    const body = {
      principalAgentId: args.principalAgentId,
      subAgentId: args.subAgentId,
      requiredCapability: args.requiredCapability,
      pricing: {
        amountCents: args.amountCents,
        currency: args.currency ?? "USD"
      }
    };
    if (args.workOrderId) body.workOrderId = args.workOrderId;
    if (args.parentTaskId) body.parentTaskId = args.parentTaskId;
    if (args.traceId) body.traceId = args.traceId;
    if (args.quoteId) body.pricing.quoteId = args.quoteId;
    if (args.x402ToolId) body.x402ToolId = args.x402ToolId;
    if (args.x402ProviderId) body.x402ProviderId = args.x402ProviderId;
    if (args.specification) body.specification = args.specification;
    if (args.constraints) body.constraints = args.constraints;
    if (args.evidencePolicy) body.evidencePolicy = args.evidencePolicy;
    if (args.delegationGrantRef) body.delegationGrantRef = args.delegationGrantRef;
    if (args.authorityGrantRef) body.authorityGrantRef = args.authorityGrantRef;
    if (args.intentBinding) body.intentBinding = args.intentBinding;
    return {
      method: "POST",
      path: "/work-orders",
      write: true,
      body,
      requestErrorCode: "AGENT_WORK_ORDER_CREATE_REQUEST_FAILED",
      responseErrorCode: "AGENT_WORK_ORDER_CREATE_RESPONSE_INVALID"
    };
  }

  if (args.workOrderCommand === "list") {
    const query = new URLSearchParams();
    if (args.workOrderId) query.set("workOrderId", args.workOrderId);
    if (args.principalAgentId) query.set("principalAgentId", args.principalAgentId);
    if (args.subAgentId) query.set("subAgentId", args.subAgentId);
    if (args.workOrderStatus) query.set("status", args.workOrderStatus);
    if (args.limit !== null && args.limit !== undefined) query.set("limit", String(args.limit));
    if (args.offset !== null && args.offset !== undefined) query.set("offset", String(args.offset));
    return {
      method: "GET",
      path: `/work-orders${query.toString() ? `?${query.toString()}` : ""}`,
      write: false,
      body: null,
      requestErrorCode: "AGENT_WORK_ORDER_LIST_REQUEST_FAILED",
      responseErrorCode: "AGENT_WORK_ORDER_LIST_RESPONSE_INVALID"
    };
  }

  if (args.workOrderCommand === "get") {
    return {
      method: "GET",
      path: `/work-orders/${encodeURIComponent(args.workOrderId)}`,
      write: false,
      body: null,
      requestErrorCode: "AGENT_WORK_ORDER_GET_REQUEST_FAILED",
      responseErrorCode: "AGENT_WORK_ORDER_GET_RESPONSE_INVALID"
    };
  }

  if (args.workOrderCommand === "accept") {
    const body = {};
    if (args.acceptedByAgentId) body.acceptedByAgentId = args.acceptedByAgentId;
    if (args.acceptedAt) body.acceptedAt = args.acceptedAt;
    return {
      method: "POST",
      path: `/work-orders/${encodeURIComponent(args.workOrderId)}/accept`,
      write: true,
      body,
      requestErrorCode: "AGENT_WORK_ORDER_ACCEPT_REQUEST_FAILED",
      responseErrorCode: "AGENT_WORK_ORDER_ACCEPT_RESPONSE_INVALID"
    };
  }

  if (args.workOrderCommand === "complete") {
    const body = {
      receiptId: args.receiptId,
      status: args.completionStatus
    };
    if (args.outputs) body.outputs = args.outputs;
    if (args.metrics) body.metrics = args.metrics;
    if (args.evidenceRefs) body.evidenceRefs = args.evidenceRefs;
    if (args.intentHash) body.intentHash = args.intentHash;
    if (args.traceId) body.traceId = args.traceId;
    if (args.deliveredAt) body.deliveredAt = args.deliveredAt;
    if (args.completedAt) body.completedAt = args.completedAt;
    if (args.metadata) body.metadata = args.metadata;
    return {
      method: "POST",
      path: `/work-orders/${encodeURIComponent(args.workOrderId)}/complete`,
      write: true,
      body,
      requestErrorCode: "AGENT_WORK_ORDER_COMPLETE_REQUEST_FAILED",
      responseErrorCode: "AGENT_WORK_ORDER_COMPLETE_RESPONSE_INVALID"
    };
  }

  fail(`unsupported work-order command: ${args.workOrderCommand}`);
}

function buildSessionRequest(args) {
  if (args.sessionCommand === "replay-pack") {
    const query = new URLSearchParams();
    if (args.sign) query.set("sign", "true");
    if (args.signerKeyId) query.set("signerKeyId", args.signerKeyId);
    return {
      method: "GET",
      path: `/sessions/${encodeURIComponent(args.sessionId)}/replay-pack${query.toString() ? `?${query.toString()}` : ""}`,
      write: false,
      body: null,
      requestErrorCode: "AGENT_SESSION_REPLAY_PACK_REQUEST_FAILED",
      responseErrorCode: "AGENT_SESSION_REPLAY_PACK_RESPONSE_INVALID"
    };
  }
  fail(`unsupported session command: ${args.sessionCommand}`);
}

async function performRequest(args, spec) {
  const endpoint = `${args.baseUrl}${spec.path}`;
  const bodyText =
    spec.body === null || spec.body === undefined
      ? null
      : canonicalJsonStringify(normalizeForCanonicalJson(spec.body, { path: "$.requestBody" }));

  let response;
  try {
    response = await requestJson(endpoint, {
      method: spec.method,
      headers: buildHeaders(args, {
        write: spec.write,
        json: bodyText !== null
      }),
      body: bodyText,
      timeoutMs: 15000
    });
  } catch (err) {
    return {
      ok: false,
      payload: {
        ok: false,
        code: spec.requestErrorCode,
        error: err?.message ?? String(err ?? "request failed")
      },
      statusCode: 0
    };
  }

  const rawText = response.text;
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    return {
      ok: false,
      payload: {
        ok: false,
        code: spec.responseErrorCode,
        error: "response must be valid JSON",
        statusCode: response.statusCode,
        rawText
      },
      statusCode: response.statusCode
    };
  }

  if (response.statusCode < 200 || response.statusCode >= 300 || payload?.ok !== true) {
    const out = {
      ok: false,
      statusCode: response.statusCode,
      ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { error: "agent command failed" })
    };
    return { ok: false, payload: out, statusCode: response.statusCode };
  }

  return {
    ok: true,
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? { ok: true, ...payload } : { ok: true, result: payload },
    statusCode: response.statusCode
  };
}

async function performSessionStream(args) {
  const query = new URLSearchParams();
  if (args.eventType) query.set("eventType", args.eventType);
  if (args.sinceEventId) query.set("sinceEventId", args.sinceEventId);
  if (args.checkpointConsumerId) query.set("checkpointConsumerId", args.checkpointConsumerId);
  const path = `/sessions/${encodeURIComponent(args.sessionId)}/events/stream${query.toString() ? `?${query.toString()}` : ""}`;
  const endpoint = `${args.baseUrl}${path}`;
  const headers = {
    ...buildHeaders(args, { write: false, json: false }),
    accept: "text/event-stream"
  };
  if (args.lastEventId) headers["last-event-id"] = args.lastEventId;

  let response;
  try {
    response = await requestSseEvents(endpoint, {
      headers,
      timeoutMs: args.timeoutMs,
      maxEvents: args.maxEvents
    });
  } catch (err) {
    return {
      ok: false,
      payload: {
        ok: false,
        code: "AGENT_SESSION_STREAM_REQUEST_FAILED",
        error: err?.message ?? String(err ?? "request failed")
      },
      statusCode: 0
    };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return {
      ok: false,
      payload: {
        ok: false,
        code: "AGENT_SESSION_STREAM_FAILED",
        error: "session stream request failed",
        statusCode: response.statusCode
      },
      statusCode: response.statusCode
    };
  }

  const events = Array.isArray(response.events) ? response.events : [];
  const lastEventId = (() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const id = normalizeOptionalString(events[i]?.id ?? null);
      if (id) return id;
    }
    return null;
  })();

  return {
    ok: true,
    payload: {
      ok: true,
      sessionId: args.sessionId,
      events,
      count: events.length,
      lastEventId,
      timedOut: response.timedOut === true,
      reachedMaxEvents: response.reachedMaxEvents === true
    },
    statusCode: response.statusCode
  };
}

async function runAgentCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }

  if (args.command === "resolve") {
    const spec = {
      method: "GET",
      path: `/v1/public/agents/resolve?agent=${encodeURIComponent(args.agentRef)}`,
      write: false,
      body: null,
      requestErrorCode: "AGENT_LOCATOR_REQUEST_FAILED",
      responseErrorCode: "AGENT_LOCATOR_RESPONSE_INVALID"
    };
    const result = await performRequest(args, spec);
    if (!result.ok) {
      if (args.json) printJson(result.payload);
      else printTextError(result.payload, result.statusCode);
      return 1;
    }

    if (args.json) printJson(result.payload);
    else printTextResolveSuccess(result.payload);
    return 0;
  }

  if (args.command === "intent") {
    const spec = buildIntentRequest(args);
    const result = await performRequest(args, spec);
    if (!result.ok) {
      if (args.json) printJson(result.payload);
      else printTextError(result.payload, result.statusCode);
      return 1;
    }

    if (args.json) printJson(result.payload);
    else printTextIntentSuccess(args.intentCommand, result.payload);
    return 0;
  }

  if (args.command === "work-order") {
    const spec = buildWorkOrderRequest(args);
    const result = await performRequest(args, spec);
    if (!result.ok) {
      if (args.json) printJson(result.payload);
      else printTextError(result.payload, result.statusCode);
      return 1;
    }

    if (args.json) printJson(result.payload);
    else printTextWorkOrderSuccess(args.workOrderCommand, result.payload);
    return 0;
  }

  if (args.command === "session") {
    const result =
      args.sessionCommand === "stream" ? await performSessionStream(args) : await performRequest(args, buildSessionRequest(args));
    if (!result.ok) {
      if (args.json) printJson(result.payload);
      else printTextError(result.payload, result.statusCode);
      return 1;
    }

    if (args.json) printJson(result.payload);
    else printTextSessionSuccess(args.sessionCommand, result.payload);
    return 0;
  }

  fail(`unsupported agent command: ${args.command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAgentCli().then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      process.stderr.write(`${err?.message ?? String(err ?? "agent command failed")}\n`);
      process.exit(1);
    }
  );
}

export { parseArgs, runAgentCli };
