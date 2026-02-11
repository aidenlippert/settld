#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeArtifactHash } from "../../src/core/artifacts.js";
import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";
import {
  createEd25519Keypair,
  keyIdFromPublicKeyPem,
  sha256Hex,
  signHashHexEd25519,
  verifyHashHexEd25519
} from "../../src/core/crypto.js";

function parseArgs(argv) {
  const out = {
    baseUrl: "http://127.0.0.1:3000",
    tenantId: "tenant_default",
    protocol: "1.0",
    apiKey: null,
    opsToken: null,
    caseId: null,
    jsonOut: null,
    list: false,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--base-url") {
      out.baseUrl = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (a === "--tenant-id") {
      out.tenantId = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (a === "--protocol") {
      out.protocol = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (a === "--api-key") {
      out.apiKey = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (a === "--ops-token") {
      out.opsToken = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (a === "--case") {
      out.caseId = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (a === "--json-out") {
      out.jsonOut = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (a === "--list") {
      out.list = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function usage() {
  // eslint-disable-next-line no-console
  console.error("usage:");
  console.error(
    "  node conformance/kernel-v0/run.mjs --ops-token <tok_opsw> [--base-url http://127.0.0.1:3000] [--tenant-id tenant_default] [--protocol 1.0] [--case <id>] [--json-out <path>] [--list]"
  );
  console.error("");
  console.error("notes:");
  console.error("  This conformance pack exercises the hosted control-plane API (holdback + disputes + deterministic adjustments).");
  console.error("  It requires an ops token with ops_write scope for the current prototype.");
}

function uniqueSuffix() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCases() {
  const packDir = path.dirname(fileURLToPath(import.meta.url));
  const fp = path.join(packDir, "cases.json");
  const raw = await fs.readFile(fp, "utf8");
  const doc = JSON.parse(raw);
  if (doc?.schemaVersion !== "KernelConformanceCases.v0") {
    throw new Error(`unsupported cases schemaVersion: ${doc?.schemaVersion ?? "null"}`);
  }
  return Array.isArray(doc.cases) ? doc.cases : [];
}

async function requestJson({ baseUrl, tenantId, protocol, apiKey, opsToken, method, pathname, body, idempotencyKey, headers: extraHeaders }) {
  const url = new URL(pathname, baseUrl);
  const headers = {
    "content-type": "application/json",
    "x-proxy-tenant-id": String(tenantId),
    "x-settld-protocol": String(protocol),
    "x-request-id": `conf_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  };
  if (idempotencyKey) headers["x-idempotency-key"] = String(idempotencyKey);
  if (apiKey) headers.authorization = `Bearer ${String(apiKey)}`;
  if (opsToken) headers["x-proxy-ops-token"] = String(opsToken);
  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value === null || value === undefined || value === "") continue;
      headers[String(key).toLowerCase()] = String(value);
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const msg = parsed && typeof parsed === "object" ? (parsed?.message ?? parsed?.error ?? text ?? `HTTP ${res.status}`) : text;
    const err = new Error(String(msg));
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function assertArtifactHash(artifact) {
  assert(artifact && typeof artifact === "object" && !Array.isArray(artifact), "artifact must be an object");
  assert(isSha256Hex(String(artifact.artifactHash ?? "")), "artifact.artifactHash must be sha256 hex");
  // eslint-disable-next-line no-unused-vars
  const { artifactHash, ...rest } = artifact;
  const expected = computeArtifactHash(rest);
  assert(String(artifactHash) === expected, "artifactHash mismatch (artifact body not canonical/reproducible)");
}

async function fetchArtifact({ opts, artifactId }) {
  const out = await requestJson({
    ...opts,
    method: "GET",
    pathname: `/artifacts/${encodeURIComponent(artifactId)}`
  });
  if (out && typeof out === "object" && out.artifact && typeof out.artifact === "object") return out.artifact;
  return out;
}

function assertArbitrationCaseArtifact({ artifact, caseId, runId, disputeId, settlementId, expectedRevision, expectedStatus, expectedVerdictId, expectedVerdictHash }) {
  assert(artifact && typeof artifact === "object" && !Array.isArray(artifact), "case artifact must be an object");
  assert(String(artifact.schemaVersion ?? "") === "ArbitrationCase.v1", "case artifact schemaVersion mismatch");
  assert(String(artifact.artifactType ?? "") === "ArbitrationCase.v1", "case artifact artifactType mismatch");
  assert(String(artifact.caseId ?? "") === String(caseId), "case artifact caseId mismatch");
  assert(String(artifact.runId ?? "") === String(runId), "case artifact runId mismatch");
  assert(String(artifact.disputeId ?? "") === String(disputeId), "case artifact disputeId mismatch");
  assert(String(artifact.settlementId ?? "") === String(settlementId), "case artifact settlementId mismatch");
  if (expectedRevision !== null && expectedRevision !== undefined) {
    assert(Number(artifact.revision) === Number(expectedRevision), "case artifact revision mismatch");
  }
  if (expectedStatus) {
    assert(String(artifact.status ?? "").toLowerCase() === String(expectedStatus).toLowerCase(), "case artifact status mismatch");
  }
  if (expectedVerdictId) {
    assert(String(artifact.verdictId ?? "") === String(expectedVerdictId), "case artifact verdictId mismatch");
  }
  if (expectedVerdictHash) {
    assert(String(artifact.verdictHash ?? "") === String(expectedVerdictHash), "case artifact verdictHash mismatch");
  }
  assertArtifactHash(artifact);
}

function assertArbitrationVerdictArtifact({ artifact, caseId, runId, disputeId, settlementId, expectedVerdictId, arbiterKeyId, arbiterPublicKeyPem }) {
  assert(artifact && typeof artifact === "object" && !Array.isArray(artifact), "verdict artifact must be an object");
  assert(String(artifact.schemaVersion ?? "") === "ArbitrationVerdict.v1", "verdict artifact schemaVersion mismatch");
  assert(String(artifact.artifactType ?? "") === "ArbitrationVerdict.v1", "verdict artifact artifactType mismatch");
  assert(String(artifact.caseId ?? "") === String(caseId), "verdict artifact caseId mismatch");
  assert(String(artifact.runId ?? "") === String(runId), "verdict artifact runId mismatch");
  assert(String(artifact.disputeId ?? "") === String(disputeId), "verdict artifact disputeId mismatch");
  assert(String(artifact.settlementId ?? "") === String(settlementId), "verdict artifact settlementId mismatch");
  assert(String(artifact.verdictId ?? "") === String(expectedVerdictId), "verdict artifact verdictId mismatch");

  const sig = artifact.signature && typeof artifact.signature === "object" && !Array.isArray(artifact.signature) ? artifact.signature : null;
  assert(sig, "verdict artifact signature missing");
  assert(String(sig.algorithm ?? "") === "ed25519", "verdict artifact signature.algorithm must be ed25519");
  assert(String(sig.signerKeyId ?? "") === String(arbiterKeyId), "verdict artifact signature.signerKeyId mismatch");
  assert(isSha256Hex(String(sig.verdictHash ?? "")), "verdict artifact signature.verdictHash must be sha256 hex");
  assert(typeof sig.signature === "string" && sig.signature.trim() !== "", "verdict artifact signature.signature missing");

  const core = normalizeForCanonicalJson(
    {
      schemaVersion: "ArbitrationVerdict.v1",
      verdictId: artifact.verdictId,
      caseId: artifact.caseId,
      tenantId: artifact.tenantId,
      runId: artifact.runId,
      settlementId: artifact.settlementId,
      disputeId: artifact.disputeId,
      arbiterAgentId: artifact.arbiterAgentId,
      outcome: artifact.outcome,
      releaseRatePct: artifact.releaseRatePct,
      rationale: artifact.rationale,
      evidenceRefs: Array.isArray(artifact.evidenceRefs) ? artifact.evidenceRefs : [],
      issuedAt: artifact.issuedAt,
      appealRef: artifact.appealRef ?? null
    },
    { path: "$" }
  );
  const verdictHash = sha256Hex(canonicalJsonStringify(core));
  assert(verdictHash === String(sig.verdictHash), "verdictHash mismatch (signature does not bind to artifact core)");
  assert(
    verifyHashHexEd25519({ hashHex: verdictHash, signatureBase64: String(sig.signature), publicKeyPem: arbiterPublicKeyPem }) === true,
    "verdict signature verification failed"
  );

  assertArtifactHash(artifact);
}

function buildSignedArbitrationVerdictV1({
  tenantId,
  runId,
  settlementId,
  disputeId,
  caseId,
  arbiterAgentId,
  signerKeyId,
  signerPrivateKeyPem,
  releaseRatePct,
  rationale,
  outcome
}) {
  const issuedAt = new Date().toISOString();
  const core = normalizeForCanonicalJson(
    {
      schemaVersion: "ArbitrationVerdict.v1",
      verdictId: `avd_${sha256Hex(`conf:${caseId}:${issuedAt}`).slice(0, 16)}`,
      caseId,
      tenantId,
      runId,
      settlementId,
      disputeId,
      arbiterAgentId,
      outcome,
      releaseRatePct,
      rationale,
      evidenceRefs: [],
      issuedAt,
      appealRef: null
    },
    { path: "$" }
  );
  const verdictHash = sha256Hex(canonicalJsonStringify(core));
  const signature = signHashHexEd25519(verdictHash, signerPrivateKeyPem);
  return { ...core, signerKeyId, signature };
}

async function runToolCallHoldbackDisputeCase({ opts, verdict }) {
  const suffix = uniqueSuffix();
  const payerAgentId = `agt_conf_payer_${suffix}`;
  const payeeAgentId = `agt_conf_payee_${suffix}`;
  const arbiterAgentId = `agt_conf_arbiter_${suffix}`;

  const payerKeys = createEd25519Keypair();
  const payeeKeys = createEd25519Keypair();
  const arbiterKeys = createEd25519Keypair();

  const arbiterKeyId = keyIdFromPublicKeyPem(arbiterKeys.publicKeyPem);

  await requestJson({
    ...opts,
    method: "POST",
    pathname: "/agents/register",
    idempotencyKey: `conf_${suffix}_register_payer`,
    body: {
      agentId: payerAgentId,
      displayName: "Kernel Conformance Payer",
      owner: { ownerType: "service", ownerId: "svc_conformance" },
      capabilities: ["buyer"],
      publicKeyPem: payerKeys.publicKeyPem
    }
  });
  await requestJson({
    ...opts,
    method: "POST",
    pathname: "/agents/register",
    idempotencyKey: `conf_${suffix}_register_payee`,
    body: {
      agentId: payeeAgentId,
      displayName: "Kernel Conformance Payee",
      owner: { ownerType: "service", ownerId: "svc_conformance" },
      capabilities: ["seller"],
      publicKeyPem: payeeKeys.publicKeyPem
    }
  });
  const arbiterReg = await requestJson({
    ...opts,
    method: "POST",
    pathname: "/agents/register",
    idempotencyKey: `conf_${suffix}_register_arbiter`,
    body: {
      agentId: arbiterAgentId,
      displayName: "Kernel Conformance Arbiter",
      owner: { ownerType: "service", ownerId: "svc_conformance" },
      capabilities: ["arbiter"],
      publicKeyPem: arbiterKeys.publicKeyPem
    }
  });

  const arbiterKeyIdFromServer = arbiterReg?.keyId ?? arbiterReg?.agentIdentity?.keys?.keyId ?? null;
  assert(!arbiterKeyIdFromServer || String(arbiterKeyIdFromServer) === arbiterKeyId, "arbiter keyId mismatch");

  await requestJson({
    ...opts,
    method: "POST",
    pathname: `/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`,
    idempotencyKey: `conf_${suffix}_fund_payer`,
    body: { amountCents: 25_000, currency: "USD" }
  });

  const agreementHash = sha256Hex(`conf:tc:agreement:${suffix}`);
  const receiptHash = sha256Hex(`conf:tc:receipt:${suffix}`);
  const createdAt = new Date().toISOString();
  const challengeWindowMs = 800;
  const holdbackBps = 2000;

  const lock = await requestJson({
    ...opts,
    method: "POST",
    pathname: "/ops/tool-calls/holds/lock",
    idempotencyKey: `conf_${suffix}_hold_lock`,
    body: {
      agreementHash,
      receiptHash,
      payerAgentId,
      payeeAgentId,
      amountCents: 10_000,
      currency: "USD",
      holdbackBps,
      challengeWindowMs,
      createdAt
    }
  });
  const hold = lock?.hold ?? null;
  assert(hold && typeof hold === "object", "hold lock response missing hold");
  const holdHash = String(hold.holdHash ?? "");
  assert(/^[0-9a-f]{64}$/.test(holdHash), "hold.holdHash must be sha256 hex");

  const open = await requestJson({
    ...opts,
    method: "POST",
    pathname: "/tool-calls/arbitration/open",
    idempotencyKey: `conf_${suffix}_open`,
    body: {
      agreementHash,
      receiptHash,
      holdHash,
      openedByAgentId: verdict === "payer" ? payerAgentId : payeeAgentId,
      arbiterAgentId,
      summary: "Conformance dispute",
      evidenceRefs: []
    }
  });
  const arbitrationCase = open?.arbitrationCase ?? null;
  assert(arbitrationCase && typeof arbitrationCase === "object", "open response missing arbitrationCase");
  const caseId = String(arbitrationCase.caseId ?? "");
  const disputeId = String(arbitrationCase.disputeId ?? "");
  const settlementId = String(arbitrationCase.settlementId ?? "");
  const runId = String(arbitrationCase.runId ?? "");
  assert(caseId, "arbitrationCase.caseId missing");
  assert(disputeId, "arbitrationCase.disputeId missing");
  assert(settlementId, "arbitrationCase.settlementId missing");
  assert(runId, "arbitrationCase.runId missing");

  // Ensure the case artifact is vendored.
  const caseArtifactId = `arbitration_case_${caseId}`;
  assert(
    open?.arbitrationCaseArtifact && typeof open.arbitrationCaseArtifact === "object" && String(open.arbitrationCaseArtifact.artifactId ?? "") === caseArtifactId,
    "open response missing arbitrationCaseArtifact.artifactId"
  );
  await requestJson({
    ...opts,
    method: "GET",
    pathname: `/artifacts/${encodeURIComponent(caseArtifactId)}/status`
  });
  const caseArtifact = await fetchArtifact({ opts, artifactId: caseArtifactId });
  assertArbitrationCaseArtifact({
    artifact: caseArtifact,
    caseId,
    runId,
    disputeId,
    settlementId,
    expectedRevision: 1,
    expectedStatus: "under_review",
    expectedVerdictId: null,
    expectedVerdictHash: null
  });

  // Force the maintenance tick into the "window elapsed" branch, but ensure it blocks on the open arbitration case.
  await sleep(challengeWindowMs + 25);
  const tick = await requestJson({
    ...opts,
    method: "POST",
    pathname: "/ops/maintenance/tool-call-holdback/run",
    idempotencyKey: `conf_${suffix}_tick`,
    body: { dryRun: false, limit: 250 }
  });
  assert(tick && typeof tick === "object", "maintenance tick response missing");
  assert(Number(tick.blocked ?? 0) >= 1, "maintenance tick should report blocked>=1");
  assert(Array.isArray(tick.blockedCases), "maintenance tick should include blockedCases[]");
  assert(
    tick.blockedCases.some((row) => String(row?.holdHash ?? "") === holdHash && String(row?.caseId ?? "") === caseId),
    "maintenance tick should include blockedCases entry for this hold+case"
  );

  const holdAfterTick = await requestJson({
    ...opts,
    method: "GET",
    pathname: `/ops/tool-calls/holds/${encodeURIComponent(holdHash)}`
  });
  assert(String(holdAfterTick?.hold?.status ?? "") === "held", "hold must remain held while case is open");

  const releaseRatePct = verdict === "payer" ? 0 : 100;
  const signedVerdict = buildSignedArbitrationVerdictV1({
    tenantId: opts.tenantId,
    runId,
    settlementId,
    disputeId,
    caseId,
    arbiterAgentId,
    signerKeyId: arbiterKeyId,
    signerPrivateKeyPem: arbiterKeys.privateKeyPem,
    releaseRatePct,
    rationale: verdict === "payer" ? "Refund holdback to payer." : "Release holdback to payee.",
    outcome: verdict === "payer" ? "rejected" : "accepted"
  });

  const verdictRes = await requestJson({
    ...opts,
    method: "POST",
    pathname: "/tool-calls/arbitration/verdict",
    idempotencyKey: `conf_${suffix}_verdict`,
    body: { caseId, arbitrationVerdict: signedVerdict }
  });
  const verdictCaseArtifactId = verdictRes?.arbitrationCaseArtifact?.artifactId ?? null;
  const verdictArtifactIdFromResponse = verdictRes?.arbitrationVerdictArtifact?.artifactId ?? null;
  assert(
    String(verdictCaseArtifactId ?? "") === `arbitration_case_${caseId}_r2`,
    "verdict response missing arbitrationCaseArtifact.artifactId (expected revision 2)"
  );
  assert(
    String(verdictArtifactIdFromResponse ?? "") === `arbitration_verdict_${signedVerdict.verdictId}`,
    "verdict response missing arbitrationVerdictArtifact.artifactId"
  );
  const settlementAdjustment = verdictRes?.settlementAdjustment ?? null;
  assert(settlementAdjustment && typeof settlementAdjustment === "object", "verdict response missing settlementAdjustment");
  assert(
    String(settlementAdjustment.adjustmentId ?? "") === `sadj_agmt_${agreementHash}_holdback`,
    "settlementAdjustment.adjustmentId must follow deterministic pattern"
  );
  assert(
    String(settlementAdjustment.kind ?? "") === (verdict === "payer" ? "holdback_refund" : "holdback_release"),
    "settlementAdjustment.kind mismatch"
  );

  const holdAfterVerdict = await requestJson({
    ...opts,
    method: "GET",
    pathname: `/ops/tool-calls/holds/${encodeURIComponent(holdHash)}`
  });
  assert(
    String(holdAfterVerdict?.hold?.status ?? "") === (verdict === "payer" ? "refunded" : "released"),
    "hold status must be resolved on verdict"
  );

  // Ensure the verdict artifact is vendored.
  const verdictArtifactId = `arbitration_verdict_${signedVerdict.verdictId}`;
  await requestJson({
    ...opts,
    method: "GET",
    pathname: `/artifacts/${encodeURIComponent(verdictArtifactId)}/status`
  });
  await requestJson({
    ...opts,
    method: "GET",
    pathname: `/artifacts/${encodeURIComponent(verdictCaseArtifactId)}/status`
  });

  const verdictCaseArtifact = await fetchArtifact({ opts, artifactId: verdictCaseArtifactId });
  assertArbitrationCaseArtifact({
    artifact: verdictCaseArtifact,
    caseId,
    runId,
    disputeId,
    settlementId,
    expectedRevision: 2,
    expectedStatus: "closed",
    expectedVerdictId: signedVerdict.verdictId,
    expectedVerdictHash: String(verdictRes?.arbitrationVerdict?.verdictHash ?? "")
  });

  const verdictArtifact = await fetchArtifact({ opts, artifactId: verdictArtifactId });
  assertArbitrationVerdictArtifact({
    artifact: verdictArtifact,
    caseId,
    runId,
    disputeId,
    settlementId,
    expectedVerdictId: signedVerdict.verdictId,
    arbiterKeyId: arbiterKeyId,
    arbiterPublicKeyPem: arbiterKeys.publicKeyPem
  });

  // Idempotency/race safety: submitting again should return the existing deterministic adjustment.
  const verdictAgain = await requestJson({
    ...opts,
    method: "POST",
    pathname: "/tool-calls/arbitration/verdict",
    idempotencyKey: `conf_${suffix}_verdict_again`,
    body: { caseId, arbitrationVerdict: signedVerdict }
  });
  assert(verdictAgain?.alreadyExisted === true, "second verdict submission should return alreadyExisted=true");
  assert(
    String(verdictAgain?.settlementAdjustment?.adjustmentId ?? "") === `sadj_agmt_${agreementHash}_holdback`,
    "second verdict submission must return same deterministic adjustmentId"
  );
  assert(
    String(verdictAgain?.arbitrationCaseArtifact?.artifactId ?? "") === `arbitration_case_${caseId}_r2`,
    "second verdict submission should include arbitrationCaseArtifact.artifactId"
  );
  assert(
    String(verdictAgain?.arbitrationVerdictArtifact?.artifactId ?? "") === verdictArtifactId,
    "second verdict submission should include arbitrationVerdictArtifact.artifactId"
  );

  return {
    agreementHash,
    receiptHash,
    holdHash,
    caseId,
    disputeId,
    settlementId,
    runId,
    adjustmentId: `sadj_agmt_${agreementHash}_holdback`
  };
}

async function runMarketplaceRunReplayEvaluateCase({ opts }) {
  const suffix = uniqueSuffix();
  const payerAgentId = `agt_conf_mkt_payer_${suffix}`;
  const payeeAgentId = `agt_conf_mkt_payee_${suffix}`;
  const payerKeys = createEd25519Keypair();
  const payeeKeys = createEd25519Keypair();

  await requestJson({
    ...opts,
    method: "POST",
    pathname: "/agents/register",
    idempotencyKey: `conf_${suffix}_register_mkt_payer`,
    body: {
      agentId: payerAgentId,
      displayName: "Marketplace Conformance Payer",
      owner: { ownerType: "service", ownerId: "svc_conformance" },
      capabilities: ["buyer"],
      publicKeyPem: payerKeys.publicKeyPem
    }
  });
  await requestJson({
    ...opts,
    method: "POST",
    pathname: "/agents/register",
    idempotencyKey: `conf_${suffix}_register_mkt_payee`,
    body: {
      agentId: payeeAgentId,
      displayName: "Marketplace Conformance Payee",
      owner: { ownerType: "service", ownerId: "svc_conformance" },
      capabilities: ["seller"],
      publicKeyPem: payeeKeys.publicKeyPem
    }
  });
  await requestJson({
    ...opts,
    method: "POST",
    pathname: `/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`,
    idempotencyKey: `conf_${suffix}_fund_mkt_payer`,
    body: { amountCents: 25_000, currency: "USD" }
  });

  const rfqId = `rfq_conf_replay_${suffix}`;
  const bidId = `bid_conf_replay_${suffix}`;

  await requestJson({
    ...opts,
    method: "POST",
    pathname: "/marketplace/rfqs",
    idempotencyKey: `conf_${suffix}_rfq_create`,
    body: {
      rfqId,
      title: "Kernel v0 marketplace replay conformance",
      description: "Exercise run settlement replay-evaluate",
      capability: "conformance.replay_evaluate",
      posterAgentId: payerAgentId,
      budgetCents: 10_000,
      currency: "USD"
    }
  });

  await requestJson({
    ...opts,
    method: "POST",
    pathname: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`,
    idempotencyKey: `conf_${suffix}_bid_submit`,
    body: {
      bidId,
      bidderAgentId: payeeAgentId,
      amountCents: 10_000,
      currency: "USD",
      etaSeconds: 60,
      note: "conformance bid"
    }
  });

  const accepted = await requestJson({
    ...opts,
    method: "POST",
    pathname: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/accept`,
    idempotencyKey: `conf_${suffix}_accept`,
    body: {
      bidId,
      payerAgentId,
      acceptedByAgentId: payerAgentId,
      settlement: { payerAgentId }
    }
  });

  const run = accepted?.run ?? null;
  const runIdRaw = run?.id ?? run?.runId ?? accepted?.runId ?? null;
  const runId = runIdRaw ? String(runIdRaw) : "";
  assert(runId, "accept response missing runId");

  let prevChainHash = run?.lastChainHash ? String(run.lastChainHash) : "";
  if (!prevChainHash) {
    // Fetch the run if it wasn't returned.
    const fetched = await requestJson({
      ...opts,
      method: "GET",
      pathname: `/agents/${encodeURIComponent(payeeAgentId)}/runs/${encodeURIComponent(runId)}`
    });
    prevChainHash = fetched?.run?.lastChainHash ? String(fetched.run.lastChainHash) : "";
  }
  assert(prevChainHash, "run lastChainHash missing (cannot append events)");

  const evidence = await requestJson({
    ...opts,
    method: "POST",
    pathname: `/agents/${encodeURIComponent(payeeAgentId)}/runs/${encodeURIComponent(runId)}/events`,
    idempotencyKey: `conf_${suffix}_evidence`,
    headers: { "x-proxy-expected-prev-chain-hash": prevChainHash },
    body: {
      type: "EVIDENCE_ADDED",
      payload: { evidenceRef: `evidence://conf/${runId}/output.json` }
    }
  });
  prevChainHash = evidence?.run?.lastChainHash ? String(evidence.run.lastChainHash) : "";
  assert(prevChainHash, "evidence append did not return next lastChainHash");

  await requestJson({
    ...opts,
    method: "POST",
    pathname: `/agents/${encodeURIComponent(payeeAgentId)}/runs/${encodeURIComponent(runId)}/events`,
    idempotencyKey: `conf_${suffix}_complete`,
    headers: { "x-proxy-expected-prev-chain-hash": prevChainHash },
    body: {
      type: "RUN_COMPLETED",
      payload: { outputRef: `evidence://conf/${runId}/output.json`, metrics: { latencyMs: 250 } }
    }
  });

  const settlement = await requestJson({
    ...opts,
    method: "GET",
    pathname: `/runs/${encodeURIComponent(runId)}/settlement`
  });
  assert(settlement && typeof settlement === "object", "run settlement missing");

  const replayEvaluate = await requestJson({
    ...opts,
    method: "GET",
    pathname: `/runs/${encodeURIComponent(runId)}/settlement/replay-evaluate`
  });
  assert(replayEvaluate && typeof replayEvaluate === "object", "replay-evaluate response missing");
  assert(replayEvaluate?.comparisons?.kernelBindingsValid === true, "replay-evaluate kernelBindingsValid must be true");
  assert(replayEvaluate?.comparisons?.policyDecisionMatchesStored === true, "replay-evaluate policyDecisionMatchesStored must be true");
  assert(
    replayEvaluate?.comparisons?.decisionRecordReplayCriticalMatchesStored === true,
    "replay-evaluate decisionRecordReplayCriticalMatchesStored must be true"
  );

  return {
    rfqId,
    bidId,
    runId,
    settlementStatus: settlement?.settlement?.status ?? settlement?.status ?? null
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const cases = await readCases();
  if (opts.list) {
    for (const c of cases) {
      // eslint-disable-next-line no-console
      console.log(String(c?.id ?? ""));
    }
    process.exit(0);
  }

  if (!opts.opsToken || String(opts.opsToken).trim() === "") {
    usage();
    throw new Error("--ops-token is required");
  }

  const selected = opts.caseId ? cases.filter((c) => String(c?.id ?? "") === String(opts.caseId)) : cases;
  if (opts.caseId && selected.length === 0) throw new Error(`case not found: ${opts.caseId}`);

  const requestOpts = {
    baseUrl: opts.baseUrl,
    tenantId: opts.tenantId,
    protocol: opts.protocol,
    apiKey: opts.apiKey,
    opsToken: opts.opsToken
  };

  let pass = 0;
  let fail = 0;
  const results = [];
  for (const c of selected) {
    const id = String(c?.id ?? "");
    try {
      let details = null;
      if (String(c?.kind ?? "") === "tool_call_holdback_dispute") {
        const verdict = String(c?.verdict ?? "") === "payer" ? "payer" : "payee";
        details = await runToolCallHoldbackDisputeCase({ opts: requestOpts, verdict });
      } else if (String(c?.kind ?? "") === "marketplace_run_replay_evaluate") {
        details = await runMarketplaceRunReplayEvaluateCase({ opts: requestOpts });
      } else {
        throw new Error(`unsupported kind: ${String(c?.kind ?? "")}`);
      }
      pass += 1;
      results.push({ id, ok: true, details });
      // eslint-disable-next-line no-console
      console.log(`PASS ${id}`);
      if (details && typeof details === "object" && details.agreementHash) {
        const agreementHash = String(details.agreementHash);
        // eslint-disable-next-line no-console
        console.log(`INFO ${id} agreementHash=${agreementHash} holdHash=${details.holdHash} caseId=${details.caseId} adjustmentId=${details.adjustmentId}`);
        // eslint-disable-next-line no-console
        console.log(`INFO ${id} kernelExplorer=${opts.baseUrl.replace(/\/$/, "")}/ops/kernel/workspace?opsToken=${encodeURIComponent(opts.opsToken)}&agreementHash=${encodeURIComponent(agreementHash)}`);
      }
      if (details && typeof details === "object" && details.runId) {
        const runId = String(details.runId);
        // eslint-disable-next-line no-console
        console.log(`INFO ${id} runId=${runId} replayEvaluate=${opts.baseUrl.replace(/\/$/, "")}/runs/${encodeURIComponent(runId)}/settlement/replay-evaluate`);
      }
    } catch (err) {
      fail += 1;
      results.push({ id, ok: false, error: { message: err?.message ?? String(err ?? "") }, details: err?.body ?? null });
      // eslint-disable-next-line no-console
      console.error(`FAIL ${id}: ${err?.message ?? String(err ?? "")}`);
      if (err && typeof err === "object" && err.body) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify(err.body, null, 2));
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`summary: pass=${pass} fail=${fail}`);

  if (opts.jsonOut && String(opts.jsonOut).trim() !== "") {
    const fp = path.resolve(process.cwd(), String(opts.jsonOut));
    const report = normalizeForCanonicalJson(
      {
        schemaVersion: "KernelConformanceReport.v0",
        generatedAt: new Date().toISOString(),
        baseUrl: opts.baseUrl,
        tenantId: opts.tenantId,
        protocol: opts.protocol,
        results
      },
      { path: "$" }
    );
    await fs.writeFile(fp, JSON.stringify(report, null, 2) + "\n", "utf8");
    // eslint-disable-next-line no-console
    console.log(`wrote ${fp}`);
  }
  process.exit(fail ? 1 : 0);
}

await main();
