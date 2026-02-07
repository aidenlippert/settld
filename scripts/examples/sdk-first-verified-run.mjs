import { generateKeyPairSync } from "node:crypto";

import { SettldClient } from "../../packages/api-sdk/src/index.js";

function generatePublicKeyPem() {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" }).toString("utf8");
}

function uniqueSuffix() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const baseUrl = process.env.SETTLD_BASE_URL ?? "http://127.0.0.1:3000";
  const tenantId = process.env.SETTLD_TENANT_ID ?? "tenant_default";
  const apiKey = process.env.SETTLD_API_KEY ?? "";

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.error("SETTLD_API_KEY is not set; the example will only work when API auth is disabled.");
  }

  const client = new SettldClient({
    baseUrl,
    tenantId,
    apiKey: apiKey || undefined
  });

  const suffix = uniqueSuffix();
  const runId = `run_sdk_${suffix}`;
  const disputeWindowDaysRaw = process.env.SETTLD_SDK_DISPUTE_WINDOW_DAYS ?? null;
  const disputeWindowDays =
    disputeWindowDaysRaw === null || disputeWindowDaysRaw === undefined || String(disputeWindowDaysRaw).trim() === ""
      ? null
      : Number(disputeWindowDaysRaw);
  if (disputeWindowDays !== null && (!Number.isSafeInteger(disputeWindowDays) || disputeWindowDays < 0)) {
    throw new TypeError("SETTLD_SDK_DISPUTE_WINDOW_DAYS must be a non-negative integer");
  }

  const result = await client.firstVerifiedRun({
    payeeAgent: {
      agentId: `agt_payee_${suffix}`,
      displayName: "SDK Demo Payee",
      owner: { ownerType: "service", ownerId: "svc_sdk_demo" },
      capabilities: ["translate", "summarize"],
      publicKeyPem: generatePublicKeyPem()
    },
    payerAgent: {
      agentId: `agt_payer_${suffix}`,
      displayName: "SDK Demo Payer",
      owner: { ownerType: "service", ownerId: "svc_sdk_demo" },
      capabilities: ["dispatch"],
      publicKeyPem: generatePublicKeyPem()
    },
    payerCredit: { amountCents: 5000, currency: "USD" },
    settlement: {
      amountCents: 1250,
      currency: "USD",
      ...(disputeWindowDays !== null ? { disputeWindowDays } : {})
    },
    run: {
      runId,
      taskType: "translation",
      inputRef: `urn:sdk:first-run:${suffix}`
    },
    completedMetrics: { latencyMs: 420 }
  });

  const verificationStatus =
    result.verification?.body?.verification?.verificationStatus ?? result.verification?.body?.verificationStatus ?? null;

  const summary = {
    runId: result.ids.runId,
    payeeAgentId: result.ids.payeeAgentId,
    payerAgentId: result.ids.payerAgentId,
    runStatus: result.runCompleted?.body?.run?.status ?? null,
    verificationStatus,
    settlementStatus: result.settlement?.body?.settlement?.status ?? null
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
