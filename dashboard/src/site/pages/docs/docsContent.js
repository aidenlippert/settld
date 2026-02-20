export const docsSections = [
  {
    slug: "quickstart",
    href: "/docs/quickstart",
    title: "Quickstart",
    summary: "Run your first production-style primitive chain from authority to verification.",
    tags: ["onboarding", "sdk", "first-run"],
    commands: ["npm run dev:api", "npx settld dev:sdk:key --print-only", "npx settld sdk:first-run"]
  },
  {
    slug: "architecture",
    href: "/docs/architecture",
    title: "Architecture",
    summary: "Control-plane layers, deterministic state machines, and artifact lineage model.",
    tags: ["architecture", "state-machine", "artifacts"],
    commands: ["npx settld conformance kernel --ops-token tok_ops", "npx settld closepack verify closepack.zip"]
  },
  {
    slug: "integrations",
    href: "/docs/integrations",
    title: "Integrations",
    summary: "MCP, SDK, webhook, and operator integration patterns for production adoption.",
    tags: ["mcp", "sdk", "webhooks", "operator"],
    commands: ["npx settld init capability my-capability", "npx settld sdk:first-run"]
  },
  {
    slug: "api",
    href: "/docs/api",
    title: "API Reference",
    summary: "Core endpoints for auth, spend authorization, receipts, export, and reversals.",
    tags: ["api", "x402", "receipts"],
    commands: [
      "POST /x402/wallets/:walletId/authorize",
      "POST /x402/gate/authorize-payment",
      "GET /x402/receipts/:receiptId"
    ]
  },
  {
    slug: "security",
    href: "/docs/security",
    title: "Security Model",
    summary: "Cryptographic guarantees, replay defense, key management, identity trust, and verification evidence.",
    tags: ["security", "signatures", "offline-verify"],
    commands: ["npx settld closepack export --receipt-id rcpt_123", "npx settld closepack verify closepack.zip"]
  },
  {
    slug: "ops",
    href: "/docs/ops",
    title: "Operations",
    summary: "Deploy, monitor, rotate keys, handle escalation queues, and run release/safety gates.",
    tags: ["ops", "deploy", "runbook"],
    commands: ["npm run test:ops:go-live-gate", "npm run ops:x402:pilot:weekly-report", "npm run keys:rotate"]
  }
];

export const docsEndpointGroups = [
  {
    title: "Authorization and Spend",
    rows: [
      { method: "POST", path: "/x402/wallets/:walletId/authorize", purpose: "Mint bounded spend authorization." },
      { method: "POST", path: "/x402/gate/authorize-payment", purpose: "Provider-side payment authorization check." },
      { method: "POST", path: "/x402/gate/reversal", purpose: "Void/refund lifecycle command dispatch." },
      { method: "POST", path: "/x402/gate/verify", purpose: "Execution verification and settlement progression gate." }
    ]
  },
  {
    title: "Receipts and Evidence",
    rows: [
      { method: "GET", path: "/x402/receipts/:receiptId", purpose: "Immutable receipt snapshot retrieval." },
      { method: "GET", path: "/x402/receipts", purpose: "Cursor-based receipt querying." },
      { method: "GET", path: "/x402/receipts/export.jsonl", purpose: "Deterministic reconciliation export." },
      { method: "GET", path: "/x402/receipts/:receiptId/closepack", purpose: "Portable closepack bundle export." }
    ]
  },
  {
    title: "Escalation and Webhooks",
    rows: [
      { method: "GET", path: "/x402/gate/escalations", purpose: "List pending/approved/denied escalation items." },
      { method: "POST", path: "/x402/gate/escalations/:id/resolve", purpose: "Approve/deny with signed override decision." },
      { method: "POST", path: "/x402/webhooks/endpoints", purpose: "Register signed delivery endpoints." },
      { method: "POST", path: "/x402/webhooks/endpoints/:id/rotate-secret", purpose: "Zero-downtime webhook secret rotation." }
    ]
  },
  {
    title: "Lifecycle and Risk Controls",
    rows: [
      { method: "POST", path: "/x402/gate/agents/:id/wind-down", purpose: "Freeze and unwind insolvent agents." },
      { method: "GET", path: "/ops/outbox/debug", purpose: "Inspect async delivery and reversal queue states." },
      { method: "POST", path: "/x402/zk/verification-keys", purpose: "Publish proof verification keys for compute settlement." }
    ]
  }
];

export function findDocsSection(slug) {
  return docsSections.find((row) => row.slug === slug) ?? null;
}
