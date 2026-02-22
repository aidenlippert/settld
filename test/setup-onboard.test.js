import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOnboard } from "../scripts/setup/onboard.mjs";

test("onboard: rejects unsupported wallet mode", async () => {
  await assert.rejects(
    runOnboard({
      argv: [
        "--non-interactive",
        "--host",
        "openclaw",
        "--base-url",
        "https://api.settld.work",
        "--tenant-id",
        "tenant_default",
        "--settld-api-key",
        "sk_live_x.y",
        "--wallet-mode",
        "nope",
        "--no-preflight"
      ],
      stdout: { write() {} }
    }),
    /--wallet-mode must be managed\|byo\|none/
  );
});

test("onboard: managed wallet auto uses remote bootstrap when circle key is not present", async () => {
  const calls = [];
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
  const wizardCalls = [];
  const wizardStub = async ({ argv, extraEnv }) => {
    wizardCalls.push({ argv, extraEnv });
    return {
      ok: true,
      env: {
        SETTLD_BASE_URL: "https://api.settld.work",
        SETTLD_TENANT_ID: "tenant_default",
        SETTLD_API_KEY: "sk_live_x.y",
        ...extraEnv
      }
    };
  };

  const out = await runOnboard({
    argv: [
      "--non-interactive",
      "--host",
      "codex",
      "--wallet-mode",
      "managed",
      "--no-preflight",
      "--base-url",
      "https://api.settld.work",
      "--tenant-id",
      "tenant_default",
      "--settld-api-key",
      "sk_live_x.y",
      "--format",
      "json"
    ],
    runtimeEnv: {},
    requestRemoteWalletBootstrapImpl: remoteStub,
    runWizardImpl: wizardStub,
    stdout: { write() {} }
  });

  assert.equal(out.ok, true);
  assert.equal(out.host, "codex");
  assert.equal(out.wallet.mode, "managed");
  assert.equal(out.wallet.bootstrapMode, "remote");
  assert.equal(out.env.CIRCLE_WALLET_ID_SPEND, "wid_remote_spend");

  const remoteCall = calls.find((row) => row.step === "remote");
  assert.ok(remoteCall);
  assert.equal(remoteCall.baseUrl, "https://api.settld.work");
  assert.equal(remoteCall.tenantId, "tenant_default");
  assert.equal(remoteCall.settldApiKey, "sk_live_x.y");
  assert.equal(remoteCall.walletProvider, "circle");

  const wizardCall = wizardCalls[0];
  assert.ok(wizardCall);
  assert.ok(Array.isArray(wizardCall.argv));
  assert.ok(wizardCall.argv.includes("--host"));
  assert.ok(wizardCall.argv.includes("codex"));
  assert.equal(wizardCall.extraEnv.CIRCLE_WALLET_ID_SPEND, "wid_remote_spend");
});

test("onboard: managed wallet local uses provider bootstrap", async () => {
  const bootstrapCalls = [];
  const bootstrapStub = async (input) => {
    bootstrapCalls.push(input);
    return {
      provider: "circle",
      mode: "sandbox",
      baseUrl: "https://api-sandbox.circle.com",
      blockchain: "BASE-SEPOLIA",
      wallets: {
        spend: { walletId: "wid_local_spend", address: "0xlocal_spend" },
        escrow: { walletId: "wid_local_escrow", address: "0xlocal_escrow" }
      },
      tokenIdUsdc: "token_usdc_local",
      env: {
        CIRCLE_BASE_URL: "https://api-sandbox.circle.com",
        CIRCLE_BLOCKCHAIN: "BASE-SEPOLIA",
        CIRCLE_WALLET_ID_SPEND: "wid_local_spend",
        CIRCLE_WALLET_ID_ESCROW: "wid_local_escrow",
        CIRCLE_TOKEN_ID_USDC: "token_usdc_local",
        CIRCLE_ENTITY_SECRET_HEX: "a".repeat(64),
        X402_CIRCLE_RESERVE_MODE: "sandbox",
        X402_REQUIRE_EXTERNAL_RESERVE: "1"
      }
    };
  };
  const wizardStub = async ({ extraEnv }) => ({
    ok: true,
    env: {
      SETTLD_BASE_URL: "https://api.settld.work",
      SETTLD_TENANT_ID: "tenant_default",
      SETTLD_API_KEY: "sk_live_x.y",
      ...extraEnv
    }
  });

  const out = await runOnboard({
    argv: [
      "--non-interactive",
      "--host",
      "openclaw",
      "--wallet-mode",
      "managed",
      "--wallet-bootstrap",
      "local",
      "--no-preflight",
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
    runtimeEnv: {},
    bootstrapWalletProviderImpl: bootstrapStub,
    runWizardImpl: wizardStub,
    stdout: { write() {} }
  });

  assert.equal(out.ok, true);
  assert.equal(out.wallet.bootstrapMode, "local");
  assert.equal(out.env.CIRCLE_WALLET_ID_SPEND, "wid_local_spend");
  assert.equal(bootstrapCalls.length, 1);
  assert.equal(bootstrapCalls[0].provider, "circle");
  assert.equal(bootstrapCalls[0].apiKey, "TEST_API_KEY:abc");
});

test("onboard: non-interactive can mint tenant API key via bootstrap key", async () => {
  const bootstrapCalls = [];
  const wizardCalls = [];
  const out = await runOnboard({
    argv: [
      "--non-interactive",
      "--host",
      "openclaw",
      "--wallet-mode",
      "none",
      "--no-preflight",
      "--base-url",
      "https://api.settld.work",
      "--tenant-id",
      "tenant_default",
      "--bootstrap-api-key",
      "ml_admin_bootstrap",
      "--bootstrap-key-id",
      "sk_generated",
      "--bootstrap-scopes",
      "tenant:runtime,mcp:invoke",
      "--format",
      "json"
    ],
    runtimeEnv: {},
    requestRuntimeBootstrapMcpEnvImpl: async (input) => {
      bootstrapCalls.push(input);
      return {
        SETTLD_BASE_URL: "https://api.settld.work",
        SETTLD_TENANT_ID: "tenant_default",
        SETTLD_API_KEY: "sk_bootstrap.generated",
        SETTLD_PAID_TOOLS_BASE_URL: "https://paid.tools.settld.work"
      };
    },
    runWizardImpl: async ({ argv, extraEnv }) => {
      wizardCalls.push({ argv, extraEnv });
      const keyIndex = argv.indexOf("--api-key");
      const generatedApiKey = keyIndex >= 0 ? String(argv[keyIndex + 1] ?? "") : "";
      return {
        ok: true,
        env: {
          SETTLD_BASE_URL: "https://api.settld.work",
          SETTLD_TENANT_ID: "tenant_default",
          SETTLD_API_KEY: generatedApiKey,
          ...extraEnv
        }
      };
    },
    stdout: { write() {} }
  });

  assert.equal(out.ok, true);
  assert.equal(out.env.SETTLD_API_KEY, "sk_bootstrap.generated");
  assert.equal(out.env.SETTLD_PAID_TOOLS_BASE_URL, "https://paid.tools.settld.work");
  assert.equal(bootstrapCalls.length, 1);
  assert.equal(bootstrapCalls[0].bootstrapApiKey, "ml_admin_bootstrap");
  assert.deepEqual(bootstrapCalls[0].bootstrapScopes, ["tenant:runtime", "mcp:invoke"]);
  assert.equal(bootstrapCalls[0].bootstrapKeyId, "sk_generated");
  assert.equal(wizardCalls.length, 1);
  const keyIndex = wizardCalls[0].argv.indexOf("--api-key");
  assert.ok(keyIndex >= 0);
  assert.equal(wizardCalls[0].argv[keyIndex + 1], "sk_bootstrap.generated");
});

test("onboard: non-interactive can mint tenant API key via saved login session", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-onboard-session-"));
  const sessionFile = path.join(tmpDir, "session.json");
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify(
      {
        schemaVersion: "SettldCliSession.v1",
        savedAt: "2026-02-22T00:00:00.000Z",
        baseUrl: "https://api.settld.work",
        tenantId: "tenant_session",
        cookie: "ml_buyer_session=session_cookie_abc",
        email: "founder@example.com"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const bootstrapCalls = [];
  const wizardCalls = [];
  try {
    const out = await runOnboard({
      argv: [
        "--non-interactive",
        "--host",
        "openclaw",
        "--wallet-mode",
        "none",
        "--no-preflight",
        "--session-file",
        sessionFile,
        "--format",
        "json"
      ],
      runtimeEnv: {},
      requestRuntimeBootstrapMcpEnvImpl: async (input) => {
        bootstrapCalls.push(input);
        return {
          SETTLD_BASE_URL: "https://api.settld.work",
          SETTLD_TENANT_ID: "tenant_session",
          SETTLD_API_KEY: "sk_session.generated"
        };
      },
      runWizardImpl: async ({ argv, extraEnv }) => {
        wizardCalls.push({ argv, extraEnv });
        const keyIndex = argv.indexOf("--api-key");
        const generatedApiKey = keyIndex >= 0 ? String(argv[keyIndex + 1] ?? "") : "";
        return {
          ok: true,
          env: {
            SETTLD_BASE_URL: "https://api.settld.work",
            SETTLD_TENANT_ID: "tenant_session",
            SETTLD_API_KEY: generatedApiKey,
            ...extraEnv
          }
        };
      },
      stdout: { write() {} }
    });

    assert.equal(out.ok, true);
    assert.equal(out.settld.tenantId, "tenant_session");
    assert.equal(out.env.SETTLD_API_KEY, "sk_session.generated");
    assert.equal(bootstrapCalls.length, 1);
    assert.equal(bootstrapCalls[0].bootstrapApiKey, "");
    assert.equal(bootstrapCalls[0].sessionCookie, "ml_buyer_session=session_cookie_abc");
    assert.equal(wizardCalls.length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("onboard: non-interactive defaults host from detected installations", async () => {
  const wizardCalls = [];
  const wizardStub = async ({ argv }) => {
    wizardCalls.push(argv);
    return {
      ok: true,
      env: {
        SETTLD_BASE_URL: "https://api.settld.work",
        SETTLD_TENANT_ID: "tenant_default",
        SETTLD_API_KEY: "sk_live_x.y"
      }
    };
  };

  const out = await runOnboard({
    argv: [
      "--non-interactive",
      "--wallet-mode",
      "none",
      "--no-preflight",
      "--base-url",
      "https://api.settld.work",
      "--tenant-id",
      "tenant_default",
      "--settld-api-key",
      "sk_live_x.y",
      "--format",
      "json"
    ],
    runtimeEnv: {},
    runWizardImpl: wizardStub,
    detectInstalledHostsImpl: () => ["cursor"],
    stdout: { write() {} }
  });

  assert.equal(out.ok, true);
  assert.equal(out.host, "cursor");
  assert.deepEqual(out.installedHosts, ["cursor"]);
  assert.ok(Array.isArray(wizardCalls[0]));
  const hostIdx = wizardCalls[0].indexOf("--host");
  assert.ok(hostIdx >= 0);
  assert.equal(wizardCalls[0][hostIdx + 1], "cursor");
});

test("onboard: runs preflight by default", async () => {
  const preflightCalls = [];
  const out = await runOnboard({
    argv: [
      "--non-interactive",
      "--host",
      "codex",
      "--wallet-mode",
      "none",
      "--base-url",
      "https://api.settld.work",
      "--tenant-id",
      "tenant_default",
      "--settld-api-key",
      "sk_live_x.y",
      "--format",
      "json"
    ],
    runtimeEnv: {},
    runPreflightChecksImpl: async (input) => {
      preflightCalls.push(input);
      return { ok: true, checks: [{ name: "api_health", ok: true }] };
    },
    runWizardImpl: async () => ({
      ok: true,
      env: {
        SETTLD_BASE_URL: "https://api.settld.work",
        SETTLD_TENANT_ID: "tenant_default",
        SETTLD_API_KEY: "sk_live_x.y"
      }
    }),
    stdout: { write() {} }
  });

  assert.equal(out.ok, true);
  assert.equal(out.preflight?.ok, true);
  assert.equal(preflightCalls.length, 1);
  assert.equal(preflightCalls[0].normalizedBaseUrl, "https://api.settld.work");
});

test("onboard: preflight-only skips wizard and returns preflight payload", async () => {
  let wizardCalled = false;
  const out = await runOnboard({
    argv: [
      "--non-interactive",
      "--host",
      "openclaw",
      "--wallet-mode",
      "none",
      "--preflight-only",
      "--base-url",
      "https://api.settld.work",
      "--tenant-id",
      "tenant_default",
      "--settld-api-key",
      "sk_live_x.y",
      "--format",
      "json"
    ],
    runtimeEnv: {},
    runPreflightChecksImpl: async () => ({ ok: true, checks: [{ name: "api_health", ok: true }] }),
    runWizardImpl: async () => {
      wizardCalled = true;
      return { ok: true, env: {} };
    },
    stdout: { write() {} }
  });

  assert.equal(out.ok, true);
  assert.equal(out.preflightOnly, true);
  assert.equal(out.settld.preflight, true);
  assert.equal(wizardCalled, false);
});

test("onboard: report-path writes payload json", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-onboard-report-"));
  const reportPath = path.join(tmpRoot, "reports", "onboard.json");
  const out = await runOnboard({
    argv: [
      "--non-interactive",
      "--host",
      "codex",
      "--wallet-mode",
      "none",
      "--no-preflight",
      "--base-url",
      "https://api.settld.work",
      "--tenant-id",
      "tenant_default",
      "--settld-api-key",
      "sk_live_x.y",
      "--report-path",
      reportPath,
      "--format",
      "json"
    ],
    runtimeEnv: {},
    runWizardImpl: async () => ({
      ok: true,
      env: {
        SETTLD_BASE_URL: "https://api.settld.work",
        SETTLD_TENANT_ID: "tenant_default",
        SETTLD_API_KEY: "sk_live_x.y"
      }
    }),
    stdout: { write() {} }
  });

  const written = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(out.ok, true);
  assert.equal(out.reportPath, reportPath);
  assert.equal(written.ok, true);
  assert.equal(written.reportPath, reportPath);
  assert.equal(written.host, "codex");
});

test("onboard: BYO mode error references required key docs", async () => {
  await assert.rejects(
    runOnboard({
      argv: [
        "--non-interactive",
        "--host",
        "openclaw",
        "--wallet-mode",
        "byo",
        "--no-preflight",
        "--base-url",
        "https://api.settld.work",
        "--tenant-id",
        "tenant_default",
        "--settld-api-key",
        "sk_live_x.y"
      ],
      runtimeEnv: {},
      stdout: { write() {} }
    }),
    /docs\/QUICKSTART_MCP_HOSTS\.md#3-wallet-modes-managed-vs-byo/
  );
});
