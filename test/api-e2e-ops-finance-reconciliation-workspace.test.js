import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { sha256Hex } from "../src/core/crypto.js";
import { computeArtifactHash } from "../src/core/artifacts.js";
import { request } from "./api-test-harness.js";

test("API e2e: finance reconciliation triage persists owner/status with idempotent actions", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_finr:finance_read", "tok_aud:audit_read"].join(";")
  });
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw", "x-nooterra-protocol": "1.0" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_finr" };
  const month = "2026-01";
  const tenantId = "tenant_default";
  const partyId = "pty_fin_recon_triage_1";
  const partyRole = "operator";

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents: 2750
  };
  const statementHash = sha256Hex(JSON.stringify(statement));
  const partyArtifact = {
    artifactId: `pstmt_${tenantId}_${partyId}_${month}_${statementHash}`,
    artifactType: "PartyStatement.v1",
    partyId,
    partyRole,
    period: month,
    statement,
    artifactHash: statementHash
  };
  await api.store.putArtifact({ tenantId, artifact: partyArtifact });
  await api.store.putPartyStatement({
    tenantId,
    statement: {
      partyId,
      period: month,
      basis: "settledAt",
      status: "CLOSED",
      statementHash,
      artifactId: partyArtifact.artifactId,
      artifactHash: partyArtifact.artifactHash,
      closedAt: new Date("2026-02-01T00:00:00.000Z").toISOString()
    }
  });

  const enqueue = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "fin_recon_triage_enqueue_1"
    },
    body: {
      counterpartyRef: "bank:acct_fin_recon_triage_1"
    }
  });
  assert.equal(enqueue.statusCode, 201);
  const providerId = String(enqueue.json?.moneyRailOperation?.providerId ?? "");
  const operationId = String(enqueue.json?.moneyRailOperation?.operationId ?? "");
  assert.equal(providerId, "stub_default");
  assert.ok(operationId);

  const failed = await request(api, {
    method: "POST",
    path: `/ops/money-rails/${encodeURIComponent(providerId)}/events/ingest`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "fin_recon_triage_ingest_failed_1"
    },
    body: {
      operationId,
      eventType: "failed",
      eventId: "evt_fin_recon_triage_failed_1",
      reasonCode: "insufficient_liquidity",
      at: "2026-02-07T00:01:00.000Z"
    }
  });
  assert.equal(failed.statusCode, 200);

  const missingPayoutKey = `${tenantId}:party:pty_fin_recon_missing:period:${month}:statement:sha_missing`;
  const missingArtifactCore = {
    schemaVersion: "PayoutInstruction.v1",
    artifactType: "PayoutInstruction.v1",
    artifactId: `payout_${tenantId}_pty_fin_recon_missing_${month}_sha_missing`,
    generatedAt: "2026-02-02T00:00:00.000Z",
    tenantId,
    partyId: "pty_fin_recon_missing",
    partyRole: "operator",
    period: month,
    statementHash: "sha_missing",
    payoutKey: missingPayoutKey,
    payout: {
      currency: "USD",
      amountCents: 900,
      destinationRef: null
    },
    eventProof: {
      lastChainHash: "hash_missing",
      eventCount: 0,
      signatures: { signedEventCount: 0, signerKeyIds: [] }
    }
  };
  await api.store.putArtifact({
    tenantId,
    artifact: { ...missingArtifactCore, artifactHash: computeArtifactHash(missingArtifactCore) }
  });

  const reconcile = await request(api, {
    method: "GET",
    path: `/ops/finance/money-rails/reconcile?period=${encodeURIComponent(month)}&providerId=${encodeURIComponent(providerId)}`,
    headers: financeReadHeaders
  });
  assert.equal(reconcile.statusCode, 200);
  assert.equal(reconcile.json?.status, "fail");
  assert.ok(Array.isArray(reconcile.json?.triageQueue));
  assert.ok((reconcile.json?.triageQueue?.length ?? 0) >= 2);
  assert.equal(reconcile.json?.triageSummary?.unresolved, reconcile.json?.triageSummary?.total);

  const selected = reconcile.json.triageQueue.find((row) => row?.mismatchType === "terminal_failure") ?? reconcile.json.triageQueue[0];
  assert.ok(selected?.mismatchType);
  assert.ok(selected?.mismatchKey);
  assert.ok(selected?.triageKey);

  const triageUpdate = await request(api, {
    method: "POST",
    path: "/ops/finance/reconciliation/triage",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "fin_recon_triage_update_1"
    },
    body: {
      action: "investigate_terminal_failure",
      sourceType: "money_rails_reconcile",
      period: month,
      providerId,
      mismatchType: selected.mismatchType,
      mismatchKey: selected.mismatchKey,
      mismatchCode: selected.mismatchCode ?? null,
      status: "in_progress",
      severity: "critical",
      ownerPrincipalId: "ops.finance@nooterra.test",
      notes: "Investigating payout operation mismatch."
    }
  });
  assert.equal(triageUpdate.statusCode, 200, triageUpdate.body);
  assert.equal(triageUpdate.json?.changed, true);
  assert.equal(triageUpdate.json?.triage?.status, "in_progress");
  assert.equal(triageUpdate.json?.triage?.ownerPrincipalId, "ops.finance@nooterra.test");
  assert.equal(triageUpdate.json?.triage?.revision, 1);

  const triageReplay = await request(api, {
    method: "POST",
    path: "/ops/finance/reconciliation/triage",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "fin_recon_triage_update_1"
    },
    body: {
      action: "investigate_terminal_failure",
      sourceType: "money_rails_reconcile",
      period: month,
      providerId,
      mismatchType: selected.mismatchType,
      mismatchKey: selected.mismatchKey,
      mismatchCode: selected.mismatchCode ?? null,
      status: "in_progress",
      severity: "critical",
      ownerPrincipalId: "ops.finance@nooterra.test",
      notes: "Investigating payout operation mismatch."
    }
  });
  assert.equal(triageReplay.statusCode, 200);
  assert.deepEqual(triageReplay.json, triageUpdate.json);

  const triageList = await request(api, {
    method: "GET",
    path: `/ops/finance/reconciliation/triage?period=${encodeURIComponent(month)}&providerId=${encodeURIComponent(providerId)}&sourceType=money_rails_reconcile`,
    headers: financeReadHeaders
  });
  assert.equal(triageList.statusCode, 200);
  assert.ok((triageList.json?.count ?? 0) >= 1);
  assert.ok((triageList.json?.statusCounts?.in_progress ?? 0) >= 1);
  assert.equal(triageList.json?.triages?.[0]?.sourceType, "money_rails_reconcile");

  const resolved = await request(api, {
    method: "POST",
    path: "/ops/finance/reconciliation/triage",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "fin_recon_triage_resolve_1"
    },
    body: {
      triageKey: String(triageUpdate.json?.triage?.triageKey ?? ""),
      status: "resolved",
      notes: "Mismatch verified and closed.",
      action: "resolve_mismatch"
    }
  });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.json?.triage?.status, "resolved");
  assert.equal(typeof resolved.json?.triage?.resolvedAt, "string");
  assert.equal(resolved.json?.triage?.revision, 2);

  const reconcileAfterResolve = await request(api, {
    method: "GET",
    path: `/ops/finance/money-rails/reconcile?period=${encodeURIComponent(month)}&providerId=${encodeURIComponent(providerId)}`,
    headers: financeReadHeaders
  });
  assert.equal(reconcileAfterResolve.statusCode, 200);
  const resolvedQueueRow = (reconcileAfterResolve.json?.triageQueue ?? []).find(
    (row) => String(row?.triageKey ?? "") === String(triageUpdate.json?.triage?.triageKey ?? "")
  );
  assert.equal(resolvedQueueRow?.triage?.status, "resolved");
});

test("API e2e: finance reconciliation workspace page renders with token query bootstrap", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_finr:finance_read", "tok_aud:audit_read"].join(";")
  });

  const workspace = await request(api, {
    method: "GET",
    path: "/ops/finance/reconciliation/workspace?period=2026-01&providerId=stub_default",
    headers: {
      "x-proxy-tenant-id": "tenant_default",
      "x-proxy-ops-token": "tok_finr"
    },
    auth: "none"
  });
  assert.equal(workspace.statusCode, 200, workspace.body);
  assert.ok(String(workspace.headers?.get("content-type") ?? "").includes("text/html"));
  assert.match(workspace.body, /Finance Reconciliation Workspace/);
  assert.match(workspace.body, /id="financeReconciliationWorkspaceRoot"/);
  assert.match(workspace.body, /id="mismatchQueueBody"/);
  assert.match(workspace.body, /id="applyTriageBtn"/);
  assert.match(workspace.body, /id="persistReconcileBtn"/);
  assert.match(workspace.body, /id="refreshMaintenanceBtn"/);
  assert.match(workspace.body, /id="runMaintenanceBtn"/);
  assert.match(workspace.body, /id="maintenanceStatus"/);
  assert.match(workspace.body, /id="maintenanceDetail"/);
  assert.match(workspace.body, /\/ops\/finance\/reconciliation\/triage/);
  assert.match(workspace.body, /\/ops\/status/);
  assert.match(workspace.body, /\/ops\/maintenance\/finance-reconcile\/run/);

  const queryAuthWorkspace = await request(api, {
    method: "GET",
    path: "/ops/finance/reconciliation/workspace?tenantId=tenant_default&opsToken=tok_finr&period=2026-01",
    headers: {},
    auth: "none"
  });
  assert.equal(queryAuthWorkspace.statusCode, 403, queryAuthWorkspace.body);

  const forbidden = await request(api, {
    method: "GET",
    path: "/ops/finance/reconciliation/workspace?tenantId=tenant_default&opsToken=tok_aud&period=2026-01",
    headers: {},
    auth: "none"
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

test("API e2e: finance scopes can read ops status and run finance reconcile maintenance", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_finr:finance_read", "tok_opsr:ops_read", "tok_aud:audit_read"].join(";"),
    financeReconcileIntervalSeconds: 0
  });

  const status = await request(api, {
    method: "GET",
    path: "/ops/status",
    headers: {
      "x-proxy-tenant-id": "tenant_default",
      "x-proxy-ops-token": "tok_finr"
    },
    auth: "none"
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json?.ok, true);
  assert.equal(status.json?.maintenance?.financeReconciliation?.enabled, true);

  const run = await request(api, {
    method: "POST",
    path: "/ops/maintenance/finance-reconcile/run",
    headers: {
      "x-proxy-tenant-id": "tenant_default",
      "x-proxy-ops-token": "tok_finw",
      "x-nooterra-protocol": "1.0"
    },
    body: {
      force: true,
      period: "2026-01",
      maxTenants: 5,
      maxPeriodsPerTenant: 1
    },
    auth: "none"
  });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json?.ok, true);
  assert.equal(typeof run.json?.summary, "object");
});
