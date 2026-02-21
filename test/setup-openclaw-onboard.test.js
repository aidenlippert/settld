import assert from "node:assert/strict";
import test from "node:test";

import { runOpenclawOnboard } from "../scripts/setup/openclaw-onboard.mjs";

test("openclaw onboard: rejects unsupported wallet provider", async () => {
  await assert.rejects(
    runOpenclawOnboard({
      argv: [
        "--base-url",
        "https://api.settld.work",
        "--tenant-id",
        "tenant_default",
        "--settld-api-key",
        "sk_live_x.y",
        "--wallet-provider",
        "unknown",
        "--circle-api-key",
        "TEST_API_KEY:abc"
      ],
      stdout: { write() {} }
    }),
    /unsupported --wallet-provider/
  );
});

test("openclaw onboard: orchestrates circle bootstrap + wizard and emits merged env", async () => {
  const calls = [];
  const circleStub = async ({ argv }) => {
    calls.push({ step: "circle", argv });
    return {
      mode: "sandbox",
      baseUrl: "https://api-sandbox.circle.com",
      blockchain: "BASE-SEPOLIA",
      wallets: {
        spend: { walletId: "wid_spend", address: "0xspend" },
        escrow: { walletId: "wid_escrow", address: "0xescrow" }
      },
      tokenIdUsdc: "token_usdc_x",
      faucetEnabled: true,
      env: {
        CIRCLE_BASE_URL: "https://api-sandbox.circle.com",
        CIRCLE_BLOCKCHAIN: "BASE-SEPOLIA",
        CIRCLE_WALLET_ID_SPEND: "wid_spend",
        CIRCLE_WALLET_ID_ESCROW: "wid_escrow",
        CIRCLE_TOKEN_ID_USDC: "token_usdc_x",
        CIRCLE_ENTITY_SECRET_HEX: "a".repeat(64),
        X402_CIRCLE_RESERVE_MODE: "sandbox",
        X402_REQUIRE_EXTERNAL_RESERVE: "1"
      }
    };
  };

  const wizardStub = async ({ argv }) => {
    calls.push({ step: "wizard", argv });
    return {
      ok: true,
      env: {
        SETTLD_BASE_URL: "https://api.settld.work",
        SETTLD_TENANT_ID: "tenant_default",
        SETTLD_API_KEY: "sk_live_x.y"
      }
    };
  };

  const out = await runOpenclawOnboard({
    argv: [
      "--base-url",
      "https://api.settld.work",
      "--tenant-id",
      "tenant_default",
      "--settld-api-key",
      "sk_live_x.y",
      "--circle-api-key",
      "TEST_API_KEY:abc",
      "--format",
      "json"
    ],
    runCircleBootstrapImpl: circleStub,
    runWizardImpl: wizardStub,
    stdout: { write() {} }
  });

  assert.equal(out.ok, true);
  assert.equal(out.host, "openclaw");
  assert.equal(out.walletProvider, "circle");
  assert.equal(out.walletBootstrap?.mode, "local");
  assert.equal(out.circle.mode, "sandbox");
  assert.equal(out.circle.tokenIdUsdc, "token_usdc_x");
  assert.equal(out.settld.tenantId, "tenant_default");
  assert.equal(out.env.CIRCLE_WALLET_ID_SPEND, "wid_spend");
  assert.equal(out.env.SETTLD_API_KEY, "sk_live_x.y");

  const circleCall = calls.find((row) => row.step === "circle");
  const wizardCall = calls.find((row) => row.step === "wizard");
  assert.ok(circleCall);
  assert.ok(wizardCall);
  assert.ok(circleCall.argv.includes("--exclude-api-key"));
  assert.ok(wizardCall.argv.includes("--host"));
  assert.ok(wizardCall.argv.includes("openclaw"));
});

test("openclaw onboard: uses remote wallet bootstrap when no local circle key is provided", async () => {
  const calls = [];
  const circleStub = async () => {
    throw new Error("local circle bootstrap should not be called");
  };
  const remoteStub = async ({ baseUrl, tenantId, settldApiKey, walletProvider }) => {
    calls.push({ step: "remote", baseUrl, tenantId, settldApiKey, walletProvider });
    return {
      provider: "circle",
      mode: "sandbox",
      baseUrl: "https://api-sandbox.circle.com",
      blockchain: "BASE-SEPOLIA",
      wallets: {
        spend: { walletId: "wid_remote_spend", address: "0xremote_spend" },
        escrow: { walletId: "wid_remote_escrow", address: "0xremote_escrow" }
      },
      tokenIdUsdc: "token_usdc_remote",
      faucetEnabled: false,
      env: {
        CIRCLE_BASE_URL: "https://api-sandbox.circle.com",
        CIRCLE_BLOCKCHAIN: "BASE-SEPOLIA",
        CIRCLE_WALLET_ID_SPEND: "wid_remote_spend",
        CIRCLE_WALLET_ID_ESCROW: "wid_remote_escrow",
        CIRCLE_TOKEN_ID_USDC: "token_usdc_remote",
        CIRCLE_ENTITY_SECRET_HEX: "b".repeat(64),
        X402_CIRCLE_RESERVE_MODE: "sandbox",
        X402_REQUIRE_EXTERNAL_RESERVE: "1"
      }
    };
  };
  const wizardStub = async ({ argv }) => {
    calls.push({ step: "wizard", argv });
    return {
      ok: true,
      env: {
        SETTLD_BASE_URL: "https://api.settld.work",
        SETTLD_TENANT_ID: "tenant_default",
        SETTLD_API_KEY: "sk_live_x.y"
      }
    };
  };

  const out = await runOpenclawOnboard({
    argv: [
      "--base-url",
      "https://api.settld.work",
      "--tenant-id",
      "tenant_default",
      "--settld-api-key",
      "sk_live_x.y",
      "--format",
      "json"
    ],
    runCircleBootstrapImpl: circleStub,
    requestRemoteWalletBootstrapImpl: remoteStub,
    runWizardImpl: wizardStub,
    stdout: { write() {} }
  });

  assert.equal(out.ok, true);
  assert.equal(out.walletBootstrap?.mode, "remote");
  assert.equal(out.circle.mode, "sandbox");
  assert.equal(out.env.CIRCLE_WALLET_ID_SPEND, "wid_remote_spend");
  assert.equal(out.env.SETTLD_API_KEY, "sk_live_x.y");

  const remoteCall = calls.find((row) => row.step === "remote");
  assert.ok(remoteCall);
  assert.equal(remoteCall.baseUrl, "https://api.settld.work");
  assert.equal(remoteCall.tenantId, "tenant_default");
  assert.equal(remoteCall.settldApiKey, "sk_live_x.y");
  assert.equal(remoteCall.walletProvider, "circle");
});
