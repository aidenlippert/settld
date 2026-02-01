import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const OPS_TOKEN = __ENV.OPS_TOKEN || "";

const TENANTS = Number.parseInt(__ENV.TENANTS || "3", 10);
const ROBOTS_PER_TENANT = Number.parseInt(__ENV.ROBOTS_PER_TENANT || "3", 10);
const JOBS_PER_MIN_PER_TENANT = Number.parseInt(__ENV.JOBS_PER_MIN_PER_TENANT || "100", 10);
const DURATION = __ENV.DURATION || "2m";

const jobsTotalRate = Math.max(1, TENANTS * JOBS_PER_MIN_PER_TENANT);

export const options = {
  scenarios: {
    jobs: {
      executor: "constant-arrival-rate",
      rate: jobsTotalRate,
      timeUnit: "1m",
      duration: DURATION,
      preAllocatedVUs: Math.min(300, Math.max(30, jobsTotalRate)),
      maxVUs: 800
    },
    poll: {
      executor: "constant-arrival-rate",
      rate: Math.max(30, TENANTS * 30),
      timeUnit: "1m",
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: "pollOps"
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.1"]
  }
};

function jsonHeaders({ tenantId, token, extra = {} } = {}) {
  const headers = {
    "content-type": "application/json",
    "x-proxy-tenant-id": tenantId
  };
  if (token) headers.authorization = `Bearer ${token}`;
  for (const [k, v] of Object.entries(extra)) headers[k] = v;
  return { headers };
}

function opsTokenHeaders({ tenantId, extra = {} } = {}) {
  const headers = {
    "content-type": "application/json",
    "x-proxy-tenant-id": tenantId,
    "x-proxy-ops-token": OPS_TOKEN
  };
  for (const [k, v] of Object.entries(extra)) headers[k] = v;
  return { headers };
}

function randomId(prefix) {
  const n = Math.floor(Math.random() * 1e9);
  return `${prefix}_${Date.now()}_${n}`;
}

function isoNowPlusMs(deltaMs) {
  return new Date(Date.now() + deltaMs).toISOString();
}

export function setup() {
  if (!OPS_TOKEN) throw new Error("OPS_TOKEN is required");
  const runId = randomId("run");
  const tenants = [];

  const availStartAt = isoNowPlusMs(-60 * 60_000);
  const availEndAt = isoNowPlusMs(24 * 60 * 60_000);

  for (let i = 0; i < TENANTS; i += 1) {
    const tenantId = i === 0 ? "tenant_default" : `tenant_${i}`;

    const keyRes = http.post(
      `${BASE_URL}/ops/api-keys`,
      JSON.stringify({
        scopes: ["ops_read", "ops_write", "audit_read", "finance_read", "finance_write"],
        description: `load:${runId}:${tenantId}`
      }),
      opsTokenHeaders({ tenantId })
    );
    check(keyRes, { "setup: created api key": (r) => r.status === 201 });
    const keyJson = keyRes.json();
    const token = `${keyJson.keyId}.${keyJson.secret}`;

    for (let j = 0; j < ROBOTS_PER_TENANT; j += 1) {
      const robotId = `rob_${runId}_${tenantId}_${j}`;
      const reg = http.post(
        `${BASE_URL}/robots/register`,
        JSON.stringify({ robotId, trustScore: 0.8, homeZoneId: "zone_a" }),
        jsonHeaders({ tenantId, token, extra: { "x-idempotency-key": `reg_${robotId}` } })
      );
      check(reg, { "setup: robot registered": (r) => r.status === 201 });
      const lastChainHash = reg.json()?.robot?.lastChainHash;
      const avail = http.post(
        `${BASE_URL}/robots/${robotId}/availability`,
        JSON.stringify({ availability: [{ startAt: availStartAt, endAt: availEndAt }] }),
        jsonHeaders({
          tenantId,
          token,
          extra: { "x-idempotency-key": `avail_${robotId}`, "x-proxy-expected-prev-chain-hash": String(lastChainHash || "") }
        })
      );
      check(avail, { "setup: robot availability set": (r) => r.status === 201 });
    }

    tenants.push({ tenantId, token, runId });
  }

  return { runId, tenants };
}

export default function (data) {
  const tenants = data?.tenants || [];
  const t = tenants[Math.floor(Math.random() * tenants.length)];
  const tenantId = t.tenantId;
  const token = t.token;

  const startAt = isoNowPlusMs(10 * 60_000);
  const endAt = isoNowPlusMs(70 * 60_000);

  const created = http.post(
    `${BASE_URL}/jobs`,
    JSON.stringify({ templateId: "reset_lite", constraints: { zoneId: "zone_a" } }),
    jsonHeaders({ tenantId, token, extra: { "x-idempotency-key": randomId("job") } })
  );
  if (!check(created, { "job: created": (r) => r.status === 201 })) return;

  const jobId = created.json()?.job?.id;
  let prev = created.json()?.job?.lastChainHash;
  if (!jobId || !prev) return;

  const quote = http.post(
    `${BASE_URL}/jobs/${jobId}/quote`,
    JSON.stringify({ startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }),
    jsonHeaders({ tenantId, token, extra: { "x-idempotency-key": randomId("quote"), "x-proxy-expected-prev-chain-hash": String(prev) } })
  );
  if (!check(quote, { "job: quoted": (r) => r.status === 201 })) return;
  prev = quote.json()?.job?.lastChainHash;

  const book = http.post(
    `${BASE_URL}/jobs/${jobId}/book`,
    JSON.stringify({ paymentHoldId: randomId("hold"), startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING" }),
    jsonHeaders({ tenantId, token, extra: { "x-idempotency-key": randomId("book"), "x-proxy-expected-prev-chain-hash": String(prev) } })
  );
  if (!check(book, { "job: booked": (r) => r.status === 201 })) return;

  const cancel = http.post(
    `${BASE_URL}/ops/jobs/${jobId}/cancel`,
    JSON.stringify({ reason: "OPS" }),
    jsonHeaders({ tenantId, token, extra: { "x-idempotency-key": randomId("cancel") } })
  );
  if (!check(cancel, { "job: cancelled": (r) => r.status === 201 })) return;
  prev = cancel.json()?.job?.lastChainHash;
  if (!prev) return;

  const settled = http.post(
    `${BASE_URL}/jobs/${jobId}/events`,
    JSON.stringify({ type: "SETTLED", actor: { type: "ops", id: "load" }, payload: null }),
    jsonHeaders({ tenantId, token, extra: { "x-idempotency-key": randomId("settle"), "x-proxy-expected-prev-chain-hash": String(prev) } })
  );
  check(settled, { "job: settled": (r) => r.status === 201 });

  sleep(0.05);
}

export function pollOps(data) {
  const tenants = data?.tenants || [];
  const t = tenants[Math.floor(Math.random() * tenants.length)];
  const tenantId = t.tenantId;
  const token = t.token;

  http.get(`${BASE_URL}/healthz`, jsonHeaders({ tenantId, token }));
  http.get(`${BASE_URL}/ops/deliveries?limit=100`, jsonHeaders({ tenantId, token }));
  http.get(`${BASE_URL}/ops/deliveries?state=failed&limit=100`, jsonHeaders({ tenantId, token }));
  sleep(0.2);
}

