import assert from "node:assert/strict";
import test from "node:test";

import { runLogin } from "../scripts/setup/login.mjs";

test("login: non-interactive saves tenant session from OTP flow", async () => {
  const calls = [];
  const writes = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    if (String(url).includes("/buyer/login/otp")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/buyer/login")) {
      return new Response(JSON.stringify({ ok: true, expiresAt: "2026-03-01T00:00:00.000Z" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "ml_buyer_session=session_abc123; Path=/; HttpOnly; Secure"
        }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const result = await runLogin({
    argv: [
      "--non-interactive",
      "--base-url",
      "https://api.settld.work",
      "--tenant-id",
      "tenant_default",
      "--email",
      "founder@example.com",
      "--otp",
      "123456",
      "--session-file",
      "/tmp/settld-session-test.json",
      "--format",
      "json"
    ],
    fetchImpl,
    writeSavedSessionImpl: async ({ session, sessionPath }) => {
      writes.push({ session, sessionPath });
      return { ...session };
    },
    stdout: { write() {} }
  });

  assert.equal(result.ok, true);
  assert.equal(result.tenantId, "tenant_default");
  assert.equal(result.sessionFile, "/tmp/settld-session-test.json");
  assert.equal(calls.length, 2);
  assert.ok(String(calls[0].url).includes("/buyer/login/otp"));
  assert.ok(String(calls[1].url).includes("/buyer/login"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].session.cookie, "ml_buyer_session=session_abc123");
  assert.equal(writes[0].session.tenantId, "tenant_default");
});
