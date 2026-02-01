import test from "node:test";
import assert from "node:assert/strict";

import { createJob, applyJobEvent, InvalidJobTransitionError, JOB_STATUS, JOB_EVENT_TYPE } from "../src/core/job-state-machine.js";

test("job state machine: happy path to settled", () => {
  const job = createJob({ id: "job_test", templateId: "reset_lite" });

  const quoted = applyJobEvent(job, { streamId: job.id, type: JOB_EVENT_TYPE.QUOTE_PROPOSED, at: "2026-01-26T00:00:00.000Z", payload: { amountCents: 100 } });
  assert.equal(quoted.status, JOB_STATUS.QUOTED);

  const booked = applyJobEvent(quoted, { streamId: job.id, type: JOB_EVENT_TYPE.BOOKED, at: "2026-01-26T00:01:00.000Z" });
  assert.equal(booked.status, JOB_STATUS.BOOKED);

  const matched = applyJobEvent(booked, { streamId: job.id, type: JOB_EVENT_TYPE.MATCHED, at: "2026-01-26T00:02:00.000Z", payload: { robotId: "rob_1" } });
  assert.equal(matched.status, JOB_STATUS.MATCHED);

  const reserved = applyJobEvent(matched, { streamId: job.id, type: JOB_EVENT_TYPE.RESERVED, at: "2026-01-26T00:03:00.000Z" });
  assert.equal(reserved.status, JOB_STATUS.RESERVED);

  const enRoute = applyJobEvent(reserved, { streamId: job.id, type: JOB_EVENT_TYPE.EN_ROUTE, at: "2026-01-26T00:04:00.000Z" });
  assert.equal(enRoute.status, JOB_STATUS.EN_ROUTE);

  const accessGranted = applyJobEvent(enRoute, { streamId: job.id, type: JOB_EVENT_TYPE.ACCESS_GRANTED, at: "2026-01-26T00:05:00.000Z" });
  assert.equal(accessGranted.status, JOB_STATUS.ACCESS_GRANTED);

  const executing = applyJobEvent(accessGranted, { streamId: job.id, type: JOB_EVENT_TYPE.EXECUTION_STARTED, at: "2026-01-26T00:06:00.000Z" });
  assert.equal(executing.status, JOB_STATUS.EXECUTING);

  const assisted = applyJobEvent(executing, { streamId: job.id, type: JOB_EVENT_TYPE.ASSIST_STARTED, at: "2026-01-26T00:07:00.000Z" });
  assert.equal(assisted.status, JOB_STATUS.ASSISTED);

  const resumed = applyJobEvent(assisted, { streamId: job.id, type: JOB_EVENT_TYPE.ASSIST_ENDED, at: "2026-01-26T00:08:00.000Z" });
  assert.equal(resumed.status, JOB_STATUS.EXECUTING);

  const completed = applyJobEvent(resumed, { streamId: job.id, type: JOB_EVENT_TYPE.EXECUTION_COMPLETED, at: "2026-01-26T00:09:00.000Z" });
  assert.equal(completed.status, JOB_STATUS.COMPLETED);

  const settled = applyJobEvent(completed, { streamId: job.id, type: JOB_EVENT_TYPE.SETTLED, at: "2026-01-26T00:10:00.000Z" });
  assert.equal(settled.status, JOB_STATUS.SETTLED);
});

test("job state machine: non-transition events are accepted", () => {
  const job = createJob({ id: "job_test2", templateId: "reset_lite" });
  const updated = applyJobEvent(job, { streamId: job.id, type: "TELEMETRY_HEARTBEAT", at: "2026-01-26T00:00:00.000Z" });
  assert.equal(updated.status, JOB_STATUS.CREATED);
  assert.equal(updated.revision, job.revision + 1);
});

test("job state machine: invalid transitions throw", () => {
  const job = createJob({ id: "job_test3", templateId: "reset_lite" });
  assert.throws(
    () => applyJobEvent(job, { streamId: job.id, type: JOB_EVENT_TYPE.BOOKED, at: "2026-01-26T00:00:00.000Z" }),
    (err) => err instanceof InvalidJobTransitionError
  );
});

