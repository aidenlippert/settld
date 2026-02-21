import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, runCircleBootstrap } from "../scripts/setup/circle-bootstrap.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("circle bootstrap: parseArgs validates mode", () => {
  const parsed = parseArgs(["--mode", "sandbox", "--format=json", "--faucet"]);
  assert.equal(parsed.mode, "sandbox");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.faucet, true);
  assert.throws(() => parseArgs(["--mode", "nope"]), /--mode must be auto\|sandbox\|production/);
});

test("circle bootstrap: auto mode falls back to production and emits env", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push(`${init.method || "GET"} ${u.origin}${u.pathname}`);

    if (u.origin === "https://api-sandbox.circle.com" && u.pathname === "/v1/w3s/wallets") {
      return jsonResponse(401, { code: 401, message: "Invalid credentials." });
    }

    if (u.origin === "https://api.circle.com" && u.pathname === "/v1/w3s/wallets") {
      return jsonResponse(200, {
        data: {
          wallets: [
            { id: "wid_spend", blockchain: "BASE-SEPOLIA" },
            { id: "wid_escrow", blockchain: "BASE-SEPOLIA" }
          ]
        }
      });
    }

    if (u.origin === "https://api.circle.com" && u.pathname === "/v1/w3s/wallets/wid_spend") {
      return jsonResponse(200, { data: { wallet: { id: "wid_spend", address: "0xspend" } } });
    }

    if (u.origin === "https://api.circle.com" && u.pathname === "/v1/w3s/wallets/wid_escrow") {
      return jsonResponse(200, { data: { wallet: { id: "wid_escrow", address: "0xescrow" } } });
    }

    if (u.origin === "https://api.circle.com" && u.pathname === "/v1/w3s/wallets/wid_spend/balances") {
      return jsonResponse(200, {
        data: {
          tokenBalances: [
            {
              token: { id: "token_usdc_1", symbol: "USDC" },
              amount: "10"
            }
          ]
        }
      });
    }

    return jsonResponse(404, { message: `unhandled route ${u.origin}${u.pathname}` });
  };

  const out = await runCircleBootstrap({
    argv: [
      "--api-key",
      "TEST_API_KEY:abc123",
      "--format",
      "json",
      "--no-faucet",
      "--entity-secret-hex",
      "a".repeat(64),
      "--blockchain",
      "BASE-SEPOLIA"
    ],
    fetchImpl,
    stdout: { write() {} }
  });

  assert.equal(out.mode, "production");
  assert.equal(out.baseUrl, "https://api.circle.com");
  assert.equal(out.wallets.spend.walletId, "wid_spend");
  assert.equal(out.wallets.escrow.walletId, "wid_escrow");
  assert.equal(out.tokenIdUsdc, "token_usdc_1");
  assert.equal(out.env.CIRCLE_WALLET_ID_SPEND, "wid_spend");
  assert.equal(out.env.CIRCLE_WALLET_ID_ESCROW, "wid_escrow");
  assert.equal(out.env.CIRCLE_TOKEN_ID_USDC, "token_usdc_1");
  assert.equal(out.env.X402_CIRCLE_RESERVE_MODE, "production");
  assert.ok(calls.includes("GET https://api-sandbox.circle.com/v1/w3s/wallets"));
  assert.ok(calls.includes("GET https://api.circle.com/v1/w3s/wallets"));
});

test("circle bootstrap: sandbox mode requests faucet for both wallets", async () => {
  const faucetCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));

    if (u.origin === "https://api-sandbox.circle.com" && u.pathname === "/v1/w3s/wallets") {
      return jsonResponse(200, {
        data: {
          wallets: [
            { id: "wid_a", blockchain: "BASE-SEPOLIA" },
            { id: "wid_b", blockchain: "BASE-SEPOLIA" }
          ]
        }
      });
    }

    if (u.origin === "https://api-sandbox.circle.com" && u.pathname === "/v1/w3s/wallets/wid_a") {
      return jsonResponse(200, { data: { wallet: { id: "wid_a", address: "0xaaa" } } });
    }

    if (u.origin === "https://api-sandbox.circle.com" && u.pathname === "/v1/w3s/wallets/wid_b") {
      return jsonResponse(200, { data: { wallet: { id: "wid_b", address: "0xbbb" } } });
    }

    if (u.origin === "https://api-sandbox.circle.com" && u.pathname === "/v1/w3s/wallets/wid_a/balances") {
      return jsonResponse(200, { data: { tokenBalances: [{ token: { id: "token_usdc_2", symbol: "USDC" } }] } });
    }

    if (u.origin === "https://api-sandbox.circle.com" && u.pathname === "/v1/faucet/drips") {
      faucetCalls.push(JSON.parse(String(init.body || "{}")));
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { message: `unhandled route ${u.origin}${u.pathname}` });
  };

  const out = await runCircleBootstrap({
    argv: [
      "--api-key",
      "TEST_API_KEY:abc123",
      "--mode",
      "sandbox",
      "--format",
      "json",
      "--entity-secret-hex",
      "b".repeat(64)
    ],
    fetchImpl,
    stdout: { write() {} }
  });

  assert.equal(out.mode, "sandbox");
  assert.equal(out.faucetEnabled, true);
  assert.equal(out.faucetResults.length, 2);
  assert.equal(faucetCalls.length, 2);
  assert.equal(out.env.CIRCLE_BASE_URL, "https://api-sandbox.circle.com");
  assert.equal(out.env.CIRCLE_TOKEN_ID_USDC, "token_usdc_2");
});
