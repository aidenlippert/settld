import { createChainedEvent, appendChainedEvent } from "../core/event-chain.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../core/crypto.js";

const baseUrl = process.env.PROXY_API_URL ?? "http://localhost:3000";

async function api(method, path, body, extraHeaders) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json", ...(extraHeaders ?? {}) } : extraHeaders,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = json?.error ? `${json.error}: ${JSON.stringify(json.details ?? null)}` : text;
    throw new Error(`HTTP ${res.status} ${method} ${path} - ${msg}`);
  }
  return json;
}

async function main() {
  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const { publicKeyPem: operatorPublicKeyPem, privateKeyPem: operatorPrivateKeyPem } = createEd25519Keypair();
  const operatorKeyId = keyIdFromPublicKeyPem(operatorPublicKeyPem);

  const { robot } = await api("POST", "/robots/register", {
    capabilities: {
      mobility: "wheeled",
      manipulation: "single_arm",
      teleop: true
    },
    publicKeyPem: robotPublicKeyPem
  });

  const { operator } = await api("POST", "/operators/register", {
    operatorId: "op_demo",
    name: "Demo Operator",
    publicKeyPem: operatorPublicKeyPem
  });

  const { job } = await api("POST", "/jobs", {
    templateId: "reset_lite",
    constraints: { roomsAllowed: ["kitchen", "living_room"], privacyMode: "minimal" }
  });

  const { events: initialEvents } = await api("GET", `/jobs/${job.id}/events`);
  let lastEvent = initialEvents[initialEvents.length - 1];

  const now = Date.now();
  const bookingStartAt = new Date(now + 5 * 60_000).toISOString();
  const bookingEndAt = new Date(now + 65 * 60_000).toISOString();

  const systemEvent = async (type, payload, actor = { type: "system", id: "proxy" }) => {
    const { event, job: updatedJob } = await api(
      "POST",
      `/jobs/${job.id}/events`,
      { type, actor, payload },
      { "x-proxy-expected-prev-chain-hash": lastEvent.chainHash }
    );
    lastEvent = event;
    return updatedJob;
  };

  const agentSignedEvent = async (type, payload, actor = { type: "robot", id: robot.id }) => {
    const draft = createChainedEvent({ streamId: job.id, type, actor, payload });
    const chained = appendChainedEvent({
      events: [lastEvent],
      event: draft,
      signer: { privateKeyPem: robotPrivateKeyPem, keyId: robotKeyId }
    });
    const finalized = chained[chained.length - 1];

    const { event, job: updatedJob } = await api("POST", `/jobs/${job.id}/events`, finalized);
    lastEvent = event;
    return updatedJob;
  };

  const operatorSignedEvent = async (type, payload, actor = { type: "operator", id: operator.id }) => {
    const draft = createChainedEvent({ streamId: job.id, type, actor, payload });
    const chained = appendChainedEvent({
      events: [lastEvent],
      event: draft,
      signer: { privateKeyPem: operatorPrivateKeyPem, keyId: operatorKeyId }
    });
    const finalized = chained[chained.length - 1];

    const { event, job: updatedJob } = await api("POST", `/jobs/${job.id}/events`, finalized);
    lastEvent = event;
    return updatedJob;
  };

  // Make the robot available for the booking window.
  await api(
    "POST",
    `/robots/${robot.id}/availability`,
    {
      availability: [{ startAt: new Date(now - 60 * 60_000).toISOString(), endAt: new Date(now + 24 * 60 * 60_000).toISOString() }]
    },
    { "x-proxy-expected-prev-chain-hash": robot.lastChainHash }
  );

  await systemEvent("QUOTE_PROPOSED", { amountCents: 6500, currency: "USD", riskPremiumCents: 500 });
  await systemEvent(
    "BOOKED",
    { paymentHoldId: "hold_test_1", startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false },
    { type: "requester", id: "household_demo" }
  );
  await systemEvent("MATCHED", { robotId: robot.id }, { type: "dispatch", id: "dispatch_v0" });
  await systemEvent("RESERVED", { robotId: robot.id, startAt: bookingStartAt, endAt: bookingEndAt, reservationId: "rsv_demo_1", reservedUntil: bookingStartAt });

  const accessPlanId = "ap_demo";
  await systemEvent("ACCESS_PLAN_ISSUED", {
    jobId: job.id,
    accessPlanId,
    method: "BUILDING_CONCIERGE",
    credentialRef: "vault://access/ap_demo/v1",
    scope: { areas: ["ENTRYWAY"], noGo: ["BEDROOM_2"] },
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validTo: new Date(Date.now() + 60 * 60_000).toISOString(),
    revocable: true,
    requestedBy: "system"
  });

  await systemEvent("SKILL_LICENSED", {
    jobId: job.id,
    skill: { skillId: "skill_reset_lite", version: "1.0.0", developerId: "dev_demo" },
    pricing: { model: "PER_JOB", amountCents: 399, currency: "USD" },
    licenseId: "lic_demo",
    terms: { refundableUntilState: "EXECUTING", requiresCertificationTier: "CERTIFIED" }
  });

  await agentSignedEvent("TELEMETRY_HEARTBEAT", { batteryPct: 0.93, status: "ready" });
  await agentSignedEvent("EN_ROUTE", { etaSeconds: 120 });
  await agentSignedEvent("ACCESS_GRANTED", { jobId: job.id, accessPlanId, method: "BUILDING_CONCIERGE" });
  await agentSignedEvent("EXECUTION_STARTED", { plan: ["navigate", "scan", "reset"] });

  await agentSignedEvent("CHECKPOINT_REACHED", { checkpoint: "scan_start" });

  await operatorSignedEvent("ASSIST_STARTED", { reason: "uncertain_object" });
  await operatorSignedEvent("ASSIST_ENDED", { outcome: "approved" });

  await agentSignedEvent("INCIDENT_DETECTED", {
    jobId: job.id,
    incidentId: "inc_demo_1",
    type: "SAFETY_NEAR_MISS",
    severity: 2,
    summary: "minor slip detected",
    signals: { subsystem: "manipulation" }
  });

  await agentSignedEvent("SKILL_USED", { jobId: job.id, licenseId: "lic_demo", step: "reset" });

  await agentSignedEvent("EXECUTION_COMPLETED", { report: { durationSeconds: 540, notes: ["all good"] } });
  await systemEvent("SETTLED", { settlement: "demo" });

  // eslint-disable-next-line no-console
  console.log(`Sim complete: job=${job.id} robot=${robot.id} robotSignerKeyId=${robotKeyId} operator=${operator.id} operatorSignerKeyId=${operatorKeyId}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
