export const docsSections = [
  {
    slug: "quickstart",
    href: "/docs/quickstart",
    title: "Quickstart",
    summary: "Run the first production-style quote -> authorize -> execute -> verify loop.",
    tags: ["onboarding", "sdk", "first-run"],
    commands: ["npm run dev:api", "npx settld dev:sdk:key --print-only", "npx settld sdk:first-run"]
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
    summary: "Cryptographic guarantees, replay defense, key management, and verification evidence.",
    tags: ["security", "signatures", "offline-verify"],
    commands: ["npx settld closepack export --receipt-id rcpt_123", "npx settld closepack verify closepack.zip"]
  },
  {
    slug: "ops",
    href: "/docs/ops",
    title: "Operations",
    summary: "Deploy, monitor, rotate keys, handle escalation queues, and run release gates.",
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
      { method: "POST", path: "/x402/gate/reversal", purpose: "Void/refund lifecycle command dispatch." }
    ]
  },
  {
    title: "Receipts and Evidence",
    rows: [
      { method: "GET", path: "/x402/receipts/:receiptId", purpose: "Immutable receipt snapshot retrieval." },
      { method: "GET", path: "/x402/receipts", purpose: "Cursor-based receipt querying." },
      { method: "GET", path: "/x402/receipts/export.jsonl", purpose: "Deterministic reconciliation export." }
    ]
  },
  {
    title: "Escalation and Webhooks",
    rows: [
      { method: "GET", path: "/x402/gate/escalations", purpose: "List pending/approved/denied escalation items." },
      { method: "POST", path: "/x402/gate/escalations/:id/resolve", purpose: "Approve/deny with signed override decision." },
      { method: "POST", path: "/x402/webhooks/endpoints", purpose: "Register signed delivery endpoints." }
    ]
  }
];

export function findDocsSection(slug) {
  return docsSections.find((row) => row.slug === slug) ?? null;
}

