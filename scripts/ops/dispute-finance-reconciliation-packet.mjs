#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";
import { sha256Hex, signHashHexEd25519 } from "../../src/core/crypto.js";

function usage() {
  // eslint-disable-next-line no-console
  console.error(
    "usage: node scripts/ops/dispute-finance-reconciliation-packet.mjs --ops-token <tok> --adjustment-id <id> --payer-agent-id <id> --payee-agent-id <id> [--base-url <url>] [--tenant-id <id>] [--generated-at <iso>] [--signing-key-file <pem>] [--signature-key-id <id>] [--out <file>]"
  );
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toSafeInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return null;
  return n;
}

function parseArgs(argv) {
  const out = {
    baseUrl: "http://127.0.0.1:3000",
    tenantId: "tenant_default",
    opsToken: null,
    adjustmentId: null,
    payerAgentId: null,
    payeeAgentId: null,
    generatedAt: null,
    signingKeyFile: null,
    signatureKeyId: null,
    outPath: null,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (arg === "--base-url") {
      out.baseUrl = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--tenant-id") {
      out.tenantId = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--ops-token") {
      out.opsToken = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--adjustment-id") {
      out.adjustmentId = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--payer-agent-id") {
      out.payerAgentId = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--payee-agent-id") {
      out.payeeAgentId = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--generated-at") {
      out.generatedAt = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--signing-key-file") {
      out.signingKeyFile = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--signature-key-id") {
      out.signatureKeyId = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--out") {
      out.outPath = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  out.baseUrl = normalizeOptionalString(out.baseUrl) ?? out.baseUrl;
  out.tenantId = normalizeOptionalString(out.tenantId) ?? out.tenantId;
  out.opsToken = normalizeOptionalString(out.opsToken);
  out.adjustmentId = normalizeOptionalString(out.adjustmentId);
  out.payerAgentId = normalizeOptionalString(out.payerAgentId);
  out.payeeAgentId = normalizeOptionalString(out.payeeAgentId);
  out.generatedAt = normalizeOptionalString(out.generatedAt);
  out.signingKeyFile = normalizeOptionalString(out.signingKeyFile);
  out.signatureKeyId = normalizeOptionalString(out.signatureKeyId);
  out.outPath = normalizeOptionalString(out.outPath);
  return out;
}

async function requestJson({ baseUrl, tenantId, opsToken, pathname }) {
  const url = new URL(pathname, baseUrl);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": opsToken
    }
  });
  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { raw };
  }
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : `HTTP ${response.status}`;
    const err = new Error(message);
    err.statusCode = response.status;
    err.body = body;
    throw err;
  }
  return body ?? {};
}

function walletSnapshot(wallet) {
  const availableCents = toSafeInteger(wallet?.availableCents);
  const escrowLockedCents = toSafeInteger(wallet?.escrowLockedCents);
  return normalizeForCanonicalJson(
    {
      walletId: typeof wallet?.walletId === "string" ? wallet.walletId : null,
      agentId: typeof wallet?.agentId === "string" ? wallet.agentId : null,
      currency: typeof wallet?.currency === "string" ? wallet.currency : null,
      availableCents,
      escrowLockedCents,
      updatedAt: typeof wallet?.updatedAt === "string" ? wallet.updatedAt : null
    },
    { path: "$.walletSnapshot" }
  );
}

function deriveBeforeSnapshots({ adjustment, payerAfter, payeeAfter }) {
  const kind = typeof adjustment?.kind === "string" ? adjustment.kind.toLowerCase() : "";
  const amountCents = toSafeInteger(adjustment?.amountCents);
  const payerAfterAvailable = toSafeInteger(payerAfter?.availableCents);
  const payerAfterEscrow = toSafeInteger(payerAfter?.escrowLockedCents);
  const payeeAfterAvailable = toSafeInteger(payeeAfter?.availableCents);
  const payeeAfterEscrow = toSafeInteger(payeeAfter?.escrowLockedCents);

  const payerBefore = {
    ...payerAfter,
    availableCents: payerAfterAvailable,
    escrowLockedCents: payerAfterEscrow
  };
  const payeeBefore = {
    ...payeeAfter,
    availableCents: payeeAfterAvailable,
    escrowLockedCents: payeeAfterEscrow
  };
  let derivationMode = "unknown";

  if (amountCents !== null && amountCents >= 0 && kind === "holdback_release") {
    derivationMode = "holdback_release";
    if (payerAfterEscrow !== null) payerBefore.escrowLockedCents = payerAfterEscrow + amountCents;
    if (payeeAfterAvailable !== null) payeeBefore.availableCents = payeeAfterAvailable - amountCents;
  } else if (amountCents !== null && amountCents >= 0 && kind === "holdback_refund") {
    derivationMode = "holdback_refund";
    if (payerAfterEscrow !== null) payerBefore.escrowLockedCents = payerAfterEscrow + amountCents;
    if (payerAfterAvailable !== null) payerBefore.availableCents = payerAfterAvailable - amountCents;
  }

  return {
    derivationMode,
    amountCents,
    payerBefore: walletSnapshot(payerBefore),
    payeeBefore: walletSnapshot(payeeBefore)
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    usage();
    // eslint-disable-next-line no-console
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.opsToken || !args.adjustmentId || !args.payerAgentId || !args.payeeAgentId) {
    usage();
    // eslint-disable-next-line no-console
    console.error("--ops-token, --adjustment-id, --payer-agent-id, and --payee-agent-id are required");
    process.exit(1);
  }
  const generatedAt = args.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) {
    // eslint-disable-next-line no-console
    console.error("--generated-at must be an ISO date-time");
    process.exit(1);
  }

  const adjustmentOut = await requestJson({
    baseUrl: args.baseUrl,
    tenantId: args.tenantId,
    opsToken: args.opsToken,
    pathname: `/ops/settlement-adjustments/${encodeURIComponent(args.adjustmentId)}`
  });
  const payerWalletOut = await requestJson({
    baseUrl: args.baseUrl,
    tenantId: args.tenantId,
    opsToken: args.opsToken,
    pathname: `/agents/${encodeURIComponent(args.payerAgentId)}/wallet`
  });
  const payeeWalletOut = await requestJson({
    baseUrl: args.baseUrl,
    tenantId: args.tenantId,
    opsToken: args.opsToken,
    pathname: `/agents/${encodeURIComponent(args.payeeAgentId)}/wallet`
  });

  const adjustment = adjustmentOut?.adjustment ?? null;
  if (!adjustment || typeof adjustment !== "object" || Array.isArray(adjustment)) {
    throw new Error("adjustment response is missing adjustment object");
  }
  const payerAfter = walletSnapshot(payerWalletOut?.wallet ?? null);
  const payeeAfter = walletSnapshot(payeeWalletOut?.wallet ?? null);
  const derived = deriveBeforeSnapshots({ adjustment, payerAfter, payeeAfter });

  const packetCore = normalizeForCanonicalJson(
    {
      schemaVersion: "DisputeFinanceReconciliationPacket.v1",
      generatedAt: new Date(generatedAt).toISOString(),
      tenantId: args.tenantId,
      adjustmentId: args.adjustmentId,
      adjustment,
      balances: {
        derivationMode: derived.derivationMode,
        payer: {
          before: derived.payerBefore,
          after: payerAfter
        },
        payee: {
          before: derived.payeeBefore,
          after: payeeAfter
        }
      }
    },
    { path: "$" }
  );

  const packetHash = sha256Hex(canonicalJsonStringify(packetCore));
  const adjustmentHash = typeof adjustment?.adjustmentHash === "string" && adjustment.adjustmentHash.trim() !== "" ? adjustment.adjustmentHash : null;
  let signature = null;
  if (args.signingKeyFile) {
    const privateKeyPem = await fs.readFile(path.resolve(args.signingKeyFile), "utf8");
    signature = normalizeForCanonicalJson(
      {
        schemaVersion: "DisputeFinanceReconciliationPacketSignature.v1",
        algorithm: "ed25519",
        keyId: args.signatureKeyId ?? "finance_ops_default",
        signedAt: new Date(generatedAt).toISOString(),
        packetHash,
        signature: signHashHexEd25519(packetHash, privateKeyPem)
      },
      { path: "$.signature" }
    );
  }

  const packet = normalizeForCanonicalJson(
    {
      ...packetCore,
      checksums: {
        packetHash,
        adjustmentHash
      },
      signature
    },
    { path: "$" }
  );

  if (args.outPath) {
    const target = path.resolve(args.outPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(packet, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack ?? err?.message ?? String(err));
  process.exit(1);
});
