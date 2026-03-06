import test from "node:test";
import assert from "node:assert/strict";

import { applyCorsHeaders, resolveCorsOrigin } from "../src/api/cors.js";

function createRes() {
  const headers = new Map();
  return {
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase()) ?? null;
    }
  };
}

test("api cors: resolves configured origins and wildcard to explicit request origin", () => {
  const configured = new Set(["https://www.nooterra.ai"]);
  assert.equal(
    resolveCorsOrigin({ originHeader: "https://www.nooterra.ai", corsAllowOrigins: configured }),
    "https://www.nooterra.ai"
  );
  assert.equal(
    resolveCorsOrigin({ originHeader: "https://127.0.0.1:3000", corsAllowOrigins: configured }),
    "https://127.0.0.1:3000"
  );
  assert.equal(
    resolveCorsOrigin({ originHeader: "https://app.example.com", corsAllowOrigins: new Set(["*"]) }),
    "https://app.example.com"
  );
});

test("api cors: applies credentialed headers for allowed origins", () => {
  const res = createRes();
  const applied = applyCorsHeaders({
    req: { headers: { origin: "https://www.nooterra.ai" } },
    res,
    corsAllowOrigins: new Set(["https://www.nooterra.ai"])
  });
  assert.equal(applied, true);
  assert.equal(res.getHeader("access-control-allow-origin"), "https://www.nooterra.ai");
  assert.equal(res.getHeader("access-control-allow-credentials"), "true");
  assert.match(String(res.getHeader("access-control-allow-headers")), /\bx-proxy-api-key\b/);
  assert.match(String(res.getHeader("access-control-allow-headers")), /\bx-api-key\b/);
});

test("api cors: skips disallowed origins", () => {
  const res = createRes();
  const applied = applyCorsHeaders({
    req: { headers: { origin: "https://blocked.example" } },
    res,
    corsAllowOrigins: new Set(["https://www.nooterra.ai"])
  });
  assert.equal(applied, false);
  assert.equal(res.getHeader("access-control-allow-origin"), null);
});
