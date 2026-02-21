import test from "node:test";
import assert from "node:assert/strict";

import { fetchWithSettldAutopay } from "../packages/api-sdk/src/index.js";

test("api-sdk x402 autopay: retries 402 with x-settld-gate-id", async () => {
  const calls = [];
  const fetchStub = async (_url, init = {}) => {
    const headers = new Headers(init?.headers ?? {});
    calls.push({ headers: Object.fromEntries(headers.entries()) });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ ok: false, code: "PAYMENT_REQUIRED" }), {
        status: 402,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-settld-gate-id": "gate_demo_1"
        }
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };

  const res = await fetchWithSettldAutopay("https://gateway.settld.local/resource", { method: "GET" }, { fetch: fetchStub });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.headers?.["x-settld-gate-id"], "gate_demo_1");
});

test("api-sdk x402 autopay: forwards policy-bearing agentPassport header across attempts", async () => {
  const calls = [];
  const fetchStub = async (_url, init = {}) => {
    const headers = new Headers(init?.headers ?? {});
    calls.push({ headers: Object.fromEntries(headers.entries()) });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ ok: false, code: "PAYMENT_REQUIRED" }), {
        status: 402,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-settld-gate-id": "gate_demo_passport_1"
        }
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };

  const agentPassport = {
    sponsorRef: "sponsor_demo_1",
    sponsorWalletRef: "wallet_demo_1",
    policyRef: "default",
    policyVersion: 1
  };
  const expectedHeader = Buffer.from(
    JSON.stringify({
      policyRef: "default",
      policyVersion: 1,
      sponsorRef: "sponsor_demo_1",
      sponsorWalletRef: "wallet_demo_1"
    }),
    "utf8"
  ).toString("base64url");

  const res = await fetchWithSettldAutopay(
    "https://gateway.settld.local/resource",
    { method: "GET" },
    { fetch: fetchStub, agentPassport }
  );
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.headers?.["x-settld-agent-passport"], expectedHeader);
  assert.equal(calls[1]?.headers?.["x-settld-agent-passport"], expectedHeader);
  assert.equal(calls[1]?.headers?.["x-settld-gate-id"], "gate_demo_passport_1");
});

test("api-sdk x402 autopay: exposes challenge metadata callback", async () => {
  const seen = [];
  const fetchStub = async (_url, init = {}) => {
    const headers = new Headers(init?.headers ?? {});
    if (headers.get("x-settld-gate-id")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
    return new Response(JSON.stringify({ ok: false, code: "PAYMENT_REQUIRED" }), {
      status: 402,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-settld-gate-id": "gate_demo_meta_1",
        "x-payment-required":
          "amountCents=500; currency=USD; providerId=prov_demo; toolId=tool_demo; quoteRequired=1; spendAuthorizationMode=required"
      }
    });
  };

  const res = await fetchWithSettldAutopay(
    "https://gateway.settld.local/resource",
    { method: "GET" },
    {
      fetch: fetchStub,
      onChallenge: (metadata) => {
        seen.push(metadata);
      }
    }
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.gateId, "gate_demo_meta_1");
  assert.equal(seen[0]?.policyChallenge?.quoteRequired, true);
  assert.equal(seen[0]?.policyChallenge?.spendAuthorizationMode, "required");
  assert.equal(seen[0]?.policyChallenge?.providerId, "prov_demo");
  assert.equal(seen[0]?.policyChallenge?.toolId, "tool_demo");
});

test("api-sdk x402 autopay: returns first 402 when gate header is missing", async () => {
  let calls = 0;
  const fetchStub = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: false, code: "PAYMENT_REQUIRED" }), {
      status: 402,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  };

  const res = await fetchWithSettldAutopay("https://gateway.settld.local/resource", { method: "GET" }, { fetch: fetchStub });
  assert.equal(res.status, 402);
  assert.equal(calls, 1);
});

test("api-sdk x402 autopay: throws for non-replayable request body", async () => {
  const fetchStub = async () =>
    new Response(JSON.stringify({ ok: false, code: "PAYMENT_REQUIRED" }), {
      status: 402,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-settld-gate-id": "gate_demo_2"
      }
    });

  await assert.rejects(
    async () =>
      await fetchWithSettldAutopay(
        "https://gateway.settld.local/resource",
        { method: "POST", body: new ReadableStream() },
        { fetch: fetchStub }
      ),
    (err) => err?.code === "SETTLD_AUTOPAY_BODY_NOT_REPLAYABLE"
  );
});
