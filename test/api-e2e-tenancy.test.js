import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

test("API e2e v1.2: tenant isolation + tenant-scoped idempotency", async () => {
  const api = createApi();

  const tenantA = "tenant_a";
  const tenantB = "tenant_b";

  const createJob = async (tenantId, idempotencyKey) => {
    const res = await request(api, {
      method: "POST",
      path: "/jobs",
      headers: { "x-proxy-tenant-id": tenantId, "x-idempotency-key": idempotencyKey },
      body: { templateId: "reset_lite", constraints: {} }
    });
    assert.equal(res.statusCode, 201);
    return res.json.job.id;
  };

  const jobA = await createJob(tenantA, "same_key");
  const jobB = await createJob(tenantB, "same_key");
  assert.notEqual(jobA, jobB);

  const listA = await request(api, { method: "GET", path: "/jobs", headers: { "x-proxy-tenant-id": tenantA } });
  assert.equal(listA.statusCode, 200);
  assert.ok(listA.json.jobs.some((j) => j.id === jobA));
  assert.ok(!listA.json.jobs.some((j) => j.id === jobB));

  const listB = await request(api, { method: "GET", path: "/jobs", headers: { "x-proxy-tenant-id": tenantB } });
  assert.equal(listB.statusCode, 200);
  assert.ok(listB.json.jobs.some((j) => j.id === jobB));
  assert.ok(!listB.json.jobs.some((j) => j.id === jobA));

  const crossRead = await request(api, { method: "GET", path: `/jobs/${jobA}`, headers: { "x-proxy-tenant-id": tenantB } });
  assert.equal(crossRead.statusCode, 404);

  const opsListA = await request(api, { method: "GET", path: "/ops/jobs", headers: { "x-proxy-tenant-id": tenantA } });
  assert.equal(opsListA.statusCode, 200);
  assert.ok(opsListA.json.jobs.some((j) => j.id === jobA));
  assert.ok(!opsListA.json.jobs.some((j) => j.id === jobB));

  // Robot IDs can overlap across tenants (tenancy is enforced by store scoping).
  const { publicKeyPem } = createEd25519Keypair();
  const regA = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: { "x-proxy-tenant-id": tenantA, "x-idempotency-key": "reg_rob_a" },
    body: { robotId: "rob_shared", publicKeyPem }
  });
  assert.equal(regA.statusCode, 201);

  const regB = await request(api, {
    method: "POST",
    path: "/robots/register",
    headers: { "x-proxy-tenant-id": tenantB, "x-idempotency-key": "reg_rob_b" },
    body: { robotId: "rob_shared", publicKeyPem }
  });
  assert.equal(regB.statusCode, 201);
  assert.notEqual(regA.json.robot.lastChainHash, regB.json.robot.lastChainHash);

  const robotsA = await request(api, { method: "GET", path: "/robots", headers: { "x-proxy-tenant-id": tenantA } });
  assert.equal(robotsA.statusCode, 200);
  assert.equal(robotsA.json.robots.length, 1);

  const robotsB = await request(api, { method: "GET", path: "/robots", headers: { "x-proxy-tenant-id": tenantB } });
  assert.equal(robotsB.statusCode, 200);
  assert.equal(robotsB.json.robots.length, 1);

  // Cross-tenant robot reads should not find the other tenant's robot stream.
  const robotCross = await request(api, { method: "GET", path: "/robots/rob_shared", headers: { "x-proxy-tenant-id": "tenant_c" } });
  assert.equal(robotCross.statusCode, 404);
});

