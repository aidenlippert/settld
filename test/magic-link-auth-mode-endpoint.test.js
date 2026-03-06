import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";

function applyEnv(envPatch) {
  const prev = {};
  for (const [key, value] of Object.entries(envPatch ?? {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function makeMockRes() {
  const headers = new Map();
  const chunks = [];
  return {
    statusCode: 200,
    setHeader(k, v) {
      headers.set(String(k).toLowerCase(), String(v));
    },
    end(data) {
      if (data !== undefined && data !== null) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    },
    _body() {
      return Buffer.concat(chunks);
    }
  };
}

async function runReq(handler, { method, url, headers = {}, bodyChunks = [] }) {
  const req = Readable.from(bodyChunks);
  req.method = method;
  req.url = url;
  req.headers = headers;
  const res = makeMockRes();
  await handler(req, res);
  return res;
}

async function loadHandler({ dataDir, publicSignupEnabled, apiKey }) {
  const restoreEnv = applyEnv({
    MAGIC_LINK_DISABLE_LISTEN: "1",
    MAGIC_LINK_PORT: "0",
    MAGIC_LINK_HOST: "127.0.0.1",
    MAGIC_LINK_DATA_DIR: dataDir,
    MAGIC_LINK_PUBLIC_SIGNUP_ENABLED: publicSignupEnabled ? "1" : "0",
    MAGIC_LINK_API_KEY: apiKey ?? null,
    MAGIC_LINK_BILLING_PROVIDER: "none",
    MAGIC_LINK_SLACK_OAUTH_CLIENT_ID: "",
    MAGIC_LINK_SLACK_OAUTH_CLIENT_SECRET: "",
    MAGIC_LINK_SLACK_OAUTH_AUTHORIZE_URL: "",
    MAGIC_LINK_SLACK_OAUTH_TOKEN_URL: "",
    MAGIC_LINK_ZAPIER_OAUTH_CLIENT_ID: "",
    MAGIC_LINK_ZAPIER_OAUTH_CLIENT_SECRET: "",
    MAGIC_LINK_ZAPIER_OAUTH_AUTHORIZE_URL: "",
    MAGIC_LINK_ZAPIER_OAUTH_TOKEN_URL: ""
  });
  try {
    const mod = await import(`../services/magic-link/src/server.js?auth-mode-test=${Date.now()}-${Math.random()}`);
    return { handler: mod.magicLinkHandler, restoreEnv };
  } catch (err) {
    restoreEnv();
    throw err;
  }
}

test("magic-link auth mode endpoint: returns enterprise_preprovisioned when signup is disabled", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-magic-link-auth-mode-"));
  let restoreEnv = null;
  try {
    const loaded = await loadHandler({ dataDir, publicSignupEnabled: false, apiKey: "test_key" });
    restoreEnv = loaded.restoreEnv;
    const res = await runReq(loaded.handler, { method: "GET", url: "/v1/public/auth-mode" });
    assert.equal(res.statusCode, 200, res._body().toString("utf8"));
    const json = JSON.parse(res._body().toString("utf8"));
    assert.equal(json.ok, true);
    assert.equal(json.authMode, "enterprise_preprovisioned");
    assert.equal(json.publicSignupEnabled, false);
  } finally {
    if (restoreEnv) restoreEnv();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("magic-link auth mode endpoint: returns hybrid when signup is enabled and admin API key is configured", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-magic-link-auth-mode-"));
  let restoreEnv = null;
  try {
    const loaded = await loadHandler({ dataDir, publicSignupEnabled: true, apiKey: "test_key" });
    restoreEnv = loaded.restoreEnv;
    const res = await runReq(loaded.handler, { method: "GET", url: "/v1/public/auth-mode" });
    assert.equal(res.statusCode, 200, res._body().toString("utf8"));
    const json = JSON.parse(res._body().toString("utf8"));
    assert.equal(json.ok, true);
    assert.equal(json.authMode, "hybrid");
    assert.equal(json.publicSignupEnabled, true);
  } finally {
    if (restoreEnv) restoreEnv();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("magic-link auth mode endpoint: returns public_signup when signup is enabled and admin API key is absent", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-magic-link-auth-mode-"));
  let restoreEnv = null;
  try {
    const loaded = await loadHandler({ dataDir, publicSignupEnabled: true, apiKey: null });
    restoreEnv = loaded.restoreEnv;
    const res = await runReq(loaded.handler, { method: "GET", url: "/v1/public/auth-mode" });
    assert.equal(res.statusCode, 200, res._body().toString("utf8"));
    const json = JSON.parse(res._body().toString("utf8"));
    assert.equal(json.ok, true);
    assert.equal(json.authMode, "public_signup");
    assert.equal(json.publicSignupEnabled, true);
  } finally {
    if (restoreEnv) restoreEnv();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("magic-link signup endpoint: fails closed with SIGNUP_DISABLED when public signup is disabled", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-magic-link-signup-disabled-"));
  let restoreEnv = null;
  try {
    const loaded = await loadHandler({ dataDir, publicSignupEnabled: false, apiKey: "test_key" });
    restoreEnv = loaded.restoreEnv;
    const body = Buffer.from(
      JSON.stringify({
        company: "Nooterra Labs",
        fullName: "Aiden",
        email: "aiden@nooterra.work"
      }),
      "utf8"
    );
    const res = await runReq(loaded.handler, {
      method: "POST",
      url: "/v1/public/signup",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length)
      },
      bodyChunks: [body]
    });
    assert.equal(res.statusCode, 403, res._body().toString("utf8"));
    const json = JSON.parse(res._body().toString("utf8"));
    assert.equal(json.ok, false);
    assert.equal(json.code, "SIGNUP_DISABLED");
  } finally {
    if (restoreEnv) restoreEnv();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("magic-link buyer auth endpoints: fail closed with BUYER_AUTH_DISABLED when domains are not configured", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-magic-link-buyer-auth-disabled-"));
  let restoreEnv = null;
  try {
    const loaded = await loadHandler({ dataDir, publicSignupEnabled: true, apiKey: "test_key" });
    restoreEnv = loaded.restoreEnv;
    const tenantId = "tenant_auth_disabled";

    const otpBody = Buffer.from(JSON.stringify({ email: "buyer@acme.example" }), "utf8");
    const otpRes = await runReq(loaded.handler, {
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/buyer/login/otp`,
      headers: {
        "content-type": "application/json",
        "content-length": String(otpBody.length)
      },
      bodyChunks: [otpBody]
    });
    assert.equal(otpRes.statusCode, 400, otpRes._body().toString("utf8"));
    const otpJson = JSON.parse(otpRes._body().toString("utf8"));
    assert.equal(otpJson.ok, false);
    assert.equal(otpJson.code, "BUYER_AUTH_DISABLED");

    const loginBody = Buffer.from(JSON.stringify({ email: "buyer@acme.example", code: "123456" }), "utf8");
    const loginRes = await runReq(loaded.handler, {
      method: "POST",
      url: `/v1/tenants/${encodeURIComponent(tenantId)}/buyer/login`,
      headers: {
        "content-type": "application/json",
        "content-length": String(loginBody.length)
      },
      bodyChunks: [loginBody]
    });
    assert.equal(loginRes.statusCode, 400, loginRes._body().toString("utf8"));
    const loginJson = JSON.parse(loginRes._body().toString("utf8"));
    assert.equal(loginJson.ok, false);
    assert.equal(loginJson.code, "BUYER_AUTH_DISABLED");
  } finally {
    if (restoreEnv) restoreEnv();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
