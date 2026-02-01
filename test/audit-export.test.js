import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { request } from "./api-test-harness.js";

test("audit export redacts credentialRef and evidenceRef; evidence export includes evidenceRef", async () => {
  const store = createStore();
  const api = createApi({ store, now: () => "2026-01-26T00:00:00.000Z" });

  const robotId = "rob_audit";
  const reg = await request(api, {
    method: "POST",
    path: "/robots/register",
    body: { robotId, trustScore: 1, homeZoneId: "zone_default", currentZoneId: "zone_default" }
  });
  assert.equal(reg.statusCode, 201);
  const robotPrev = reg.json.robot.lastChainHash;

  const avail = await request(api, {
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: { "x-proxy-expected-prev-chain-hash": robotPrev },
    body: {
      availability: [{ startAt: "2026-01-26T00:00:00.000Z", endAt: "2026-01-26T03:00:00.000Z" }],
      timezone: "UTC"
    }
  });
  assert.equal(avail.statusCode, 201);

  const pilotStartAt = "2026-01-26T01:00:00.000Z";
  const pilot = await request(api, {
    method: "POST",
    path: "/pilot/jobs",
    body: { startAt: pilotStartAt, autoBook: true, constraints: { privacyMode: "minimal" } }
  });
  assert.equal(pilot.statusCode, 201);
  const job = pilot.json.job;
  const jobId = job.id;

  const issueAccessPlan = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": job.lastChainHash },
    body: {
      type: "ACCESS_PLAN_ISSUED",
      actor: { type: "system", id: "proxy" },
      payload: {
        jobId,
        accessPlanId: "ap_audit_1",
        method: "BUILDING_CONCIERGE",
        credentialRef: "vault://access/ap_audit_1/v1",
        scope: { areas: ["ENTRYWAY"], noGo: [] },
        validFrom: job.booking.startAt,
        validTo: job.booking.endAt,
        revocable: true,
        requestedBy: "ops"
      }
    }
  });
  assert.equal(issueAccessPlan.statusCode, 201);
  const afterAccess = issueAccessPlan.json.job;

  const incidentId = "inc_audit_1";
  const reportIncident = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": afterAccess.lastChainHash },
    body: {
      type: "INCIDENT_REPORTED",
      actor: { type: "ops", id: "ops_test" },
      payload: {
        jobId,
        incidentId,
        type: "DAMAGE_PROPERTY",
        severity: 4,
        summary: "test incident",
        description: "test description",
        reportedBy: "customer"
      }
    }
  });
  assert.equal(reportIncident.statusCode, 201);
  const afterIncident = reportIncident.json.job;

  const evidenceId = "evid_audit_1";
  const captureEvidence = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": afterIncident.lastChainHash },
    body: {
      type: "EVIDENCE_CAPTURED",
      actor: { type: "trust", id: "evidence_test" },
      payload: {
        jobId,
        incidentId,
        evidenceId,
        evidenceRef: "obj://evidence-bucket/job_audit/evid_audit_1.jpg",
        kind: "STILL_IMAGE",
        durationSeconds: 1,
        contentType: "image/jpeg",
        redaction: { state: "NONE", notes: "none" }
      }
    }
  });
  assert.equal(captureEvidence.statusCode, 201);

  const auditRes = await request(api, { method: "GET", path: `/jobs/${jobId}/audit` });
  assert.equal(auditRes.statusCode, 200);
  const audit = auditRes.json.audit;
  assert.equal(audit.job.id, jobId);

  const accessPlanPayloads = audit.timeline.filter((e) => e.type === "ACCESS_PLAN_ISSUED").map((e) => e.payload);
  assert.equal(accessPlanPayloads.length, 1);
  assert.equal(accessPlanPayloads[0].credentialRef, undefined);

  const evidencePayloads = audit.timeline.filter((e) => e.type === "EVIDENCE_CAPTURED").map((e) => e.payload);
  assert.equal(evidencePayloads.length, 1);
  assert.equal(evidencePayloads[0].evidenceRef, undefined);

  const evidenceRes = await request(api, { method: "GET", path: `/jobs/${jobId}/evidence` });
  assert.equal(evidenceRes.statusCode, 200);
  const evidence = evidenceRes.json.evidence;
  assert.equal(evidence.jobId, jobId);
  assert.ok(Array.isArray(evidence.evidence));
  const item = evidence.evidence.find((e) => e.evidenceId === evidenceId);
  assert.ok(item);
  assert.equal(item.evidenceRef, "obj://evidence-bucket/job_audit/evid_audit_1.jpg");
});
