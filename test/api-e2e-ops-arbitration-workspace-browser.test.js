import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createApi } from "../src/api/app.js";
import { canonicalJsonStringify, normalizeForCanonicalJson } from "../src/core/canonical-json.js";
import { createEd25519Keypair, sha256Hex, signHashHexEd25519 } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

const execFileAsync = promisify(execFile);
const PW_CLI_TIMEOUT_MS_RAW = Number(process.env.NOOTERRA_BROWSER_E2E_CLI_TIMEOUT_MS ?? 20_000);
const PW_CLI_TIMEOUT_MS = Number.isFinite(PW_CLI_TIMEOUT_MS_RAW) && PW_CLI_TIMEOUT_MS_RAW > 0 ? Math.floor(PW_CLI_TIMEOUT_MS_RAW) : 20_000;

async function registerAgent(api, { tenantId, agentId, ownerId = "svc_arb_workspace_browser_test", publicKeyPem: providedPublicKeyPem = null }) {
  const publicKeyPem = providedPublicKeyPem ?? createEd25519Keypair().publicKeyPem;
  const created = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `register_${tenantId}_${agentId}`
    },
    body: {
      agentId,
      displayName: agentId,
      owner: { ownerType: "service", ownerId },
      publicKeyPem
    }
  });
  assert.equal(created.statusCode, 201);
  return {
    keyId: created.json?.keyId ?? null,
    publicKeyPem
  };
}

async function createArbitrationCaseFixture(
  api,
  { tenantId, payerAgentId, payeeAgentId, arbiterAgentId, runId, disputeId, caseId, evidenceRefs, idempotencyPrefix }
) {
  const createdRun = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_create`
    },
    body: {
      runId,
      taskType: "analysis",
      settlement: {
        payerAgentId,
        amountCents: 1200,
        currency: "USD",
        disputeWindowDays: 3
      }
    }
  });
  assert.equal(createdRun.statusCode, 201);

  const prevChainHash = createdRun.json?.run?.lastChainHash;
  assert.ok(prevChainHash);
  const completed = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_complete`,
      "x-proxy-expected-prev-chain-hash": prevChainHash
    },
    body: {
      type: "RUN_COMPLETED",
      payload: { outputRef: `evidence://${runId}/output.json` }
    }
  });
  assert.equal(completed.statusCode, 201);

  const openedDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_dispute_open`
    },
    body: {
      disputeId,
      openedByAgentId: payerAgentId,
      reason: "workspace browser packet test",
      disputePriority: "high",
      evidenceRefs
    }
  });
  assert.equal(openedDispute.statusCode, 200);

  const openedArbitration = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/open`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_arbitration_open`
    },
    body: {
      disputeId,
      caseId,
      arbiterAgentId,
      evidenceRefs
    }
  });
  assert.equal(openedArbitration.statusCode, 201);
}

function makePwCliPath() {
  const nooterraHome = process.env.NOOTERRA_HOME || path.join(os.homedir(), ".nooterra");
  return path.join(nooterraHome, "skills", "playwright", "scripts", "playwright_cli.sh");
}

async function runPw({ session, args, env = {}, withSession = true }) {
  const cli = makePwCliPath();
  const mergedEnv = { ...process.env, ...env };
  const fullArgs = withSession ? ["--session", session, ...args] : [...args];
  try {
    const out = await execFileAsync("bash", [cli, ...fullArgs], {
      env: mergedEnv,
      maxBuffer: 1024 * 1024 * 20,
      timeout: PW_CLI_TIMEOUT_MS
    });
    return out;
  } catch (err) {
    const stdout = typeof err?.stdout === "string" ? err.stdout : "";
    const stderr = typeof err?.stderr === "string" ? err.stderr : "";
    const timeoutLabel = err?.killed === true ? `timeoutMs=${PW_CLI_TIMEOUT_MS}` : "";
    const message = [`playwright-cli failed`, `args=${JSON.stringify(args)}`, timeoutLabel, stdout, stderr].filter(Boolean).join("\n");
    throw new Error(message);
  }
}

test(
  "API browser e2e: arbitration workspace supports open -> verdict -> close -> appeal flow",
  { skip: process.env.NOOTERRA_RUN_BROWSER_E2E !== "1" },
  async (t) => {
    let nowAt = "2026-02-10T14:00:00.000Z";
    const api = createApi({
      now: () => nowAt,
      opsTokens: ["tok_finw:finance_write"].join(";")
    });

    const tenantId = "tenant_arb_workspace_browser";
    const payerAgentId = "agt_arb_browser_payer";
    const payeeAgentId = "agt_arb_browser_payee";
    const arbiterAgentId = "agt_arb_browser_arbiter";
    const runId = "run_arb_browser_1";
    const disputeId = "dispute_arb_browser_1";
    const caseId = "arb_case_browser_1";
    const appealCaseId = "arb_case_browser_appeal_1";
    const evidenceRefs = ["evidence://arb/browser/1.json"];
    const arbiterKeypair = createEd25519Keypair();
    const browser = typeof process.env.NOOTERRA_BROWSER_E2E_BROWSER === "string" && process.env.NOOTERRA_BROWSER_E2E_BROWSER.trim() !== ""
      ? process.env.NOOTERRA_BROWSER_E2E_BROWSER.trim()
      : "firefox";
    const session = `arb_ws_${Date.now()}`;

    try {
      await runPw({ session, args: ["open", "--browser", browser, "about:blank"] });
      await runPw({ session, args: ["close"] });
    } catch (err) {
      const message = String(err?.message ?? err ?? "");
      if (
        message.includes("Host system is missing dependencies") ||
        message.includes("Chromium distribution 'chrome' is not found") ||
        message.includes("timeoutMs=")
      ) {
        t.skip(`Playwright browser runtime unavailable in this environment: ${message.split("\n")[0]}`);
        return;
      }
      throw err;
    }

    await registerAgent(api, { tenantId, agentId: payerAgentId });
    await registerAgent(api, { tenantId, agentId: payeeAgentId });
    const arbiterRegistration = await registerAgent(api, {
      tenantId,
      agentId: arbiterAgentId,
      publicKeyPem: arbiterKeypair.publicKeyPem
    });
    assert.ok(typeof arbiterRegistration.keyId === "string" && arbiterRegistration.keyId.length > 0);

    const credit = await request(api, {
      method: "POST",
      path: `/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`,
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-idempotency-key": "arb_browser_credit_1"
      },
      body: {
        amountCents: 10000,
        currency: "USD"
      }
    });
    assert.equal(credit.statusCode, 201);

    await createArbitrationCaseFixture(api, {
      tenantId,
      payerAgentId,
      payeeAgentId,
      arbiterAgentId,
      runId,
      disputeId,
      caseId,
      evidenceRefs,
      idempotencyPrefix: "arb_browser_case_1"
    });

    const workspaceBeforeVerdict = await request(api, {
      method: "GET",
      path: `/ops/arbitration/cases/${encodeURIComponent(caseId)}/workspace`,
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_finw"
      }
    });
    assert.equal(workspaceBeforeVerdict.statusCode, 200, workspaceBeforeVerdict.body);

    const arbitrationVerdictCore = normalizeForCanonicalJson(
      {
        schemaVersion: "ArbitrationVerdict.v1",
        verdictId: "arb_vrd_browser_1",
        caseId,
        tenantId,
        runId,
        settlementId: workspaceBeforeVerdict.json?.settlement?.settlement?.settlementId,
        disputeId,
        arbiterAgentId,
        outcome: "accepted",
        releaseRatePct: 100,
        rationale: "browser workflow accepted",
        evidenceRefs,
        issuedAt: nowAt,
        appealRef: null
      },
      { path: "$" }
    );
    const arbitrationVerdictHash = sha256Hex(canonicalJsonStringify(arbitrationVerdictCore));
    const arbitrationVerdictSignature = signHashHexEd25519(arbitrationVerdictHash, arbiterKeypair.privateKeyPem);
    const signedVerdict = {
      caseId,
      verdictId: "arb_vrd_browser_1",
      arbiterAgentId,
      outcome: "accepted",
      releaseRatePct: 100,
      rationale: "browser workflow accepted",
      evidenceRefs,
      issuedAt: nowAt,
      signerKeyId: arbiterRegistration.keyId,
      signature: arbitrationVerdictSignature
    };

    const server = http.createServer(api.handle);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : null;
    assert.ok(Number.isInteger(port) && port > 0);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await runPw({
        session,
        args: ["open", "--browser", browser, "about:blank"]
      });
      await runPw({
        session,
        args: [
          "run-code",
          `await page.setExtraHTTPHeaders({ 'x-proxy-tenant-id': ${JSON.stringify(tenantId)}, 'x-proxy-ops-token': 'tok_finw' });
           await page.goto(${JSON.stringify(
             `${baseUrl}/ops/arbitration/workspace?tenantId=${encodeURIComponent(tenantId)}&caseId=${encodeURIComponent(caseId)}&status=under_review`
           )});`
        ]
      });
      await runPw({ session, args: ["run-code", "await page.waitForSelector('#arbitrationWorkspaceRoot');"] });
      await runPw({
        session,
        args: ["run-code", "await page.waitForFunction(() => document.querySelectorAll('#arbitrationQueueBody tr button').length > 0);"]
      });
      await runPw({
        session,
        args: [
          "run-code",
          `await page.evaluate(() => {
            const rows = [...document.querySelectorAll('#arbitrationQueueBody tr')];
            const row = rows.find((node) => String(node.textContent || '').includes(${JSON.stringify(caseId)}));
            if (!row) throw new Error('queue row not found for case');
            const btn = row.querySelector('button');
            if (!btn) throw new Error('open button missing');
            btn.click();
          });`
        ]
      });
      await runPw({
        session,
        args: [
          "run-code",
          `await page.waitForFunction(() => String(document.querySelector('#caseOverview')?.textContent || '').includes(${JSON.stringify(caseId)}));`
        ]
      });

      await runPw({
        session,
        args: ["run-code", `await page.fill('#verdictJson', ${JSON.stringify(JSON.stringify(signedVerdict))});`]
      });
      await runPw({ session, args: ["run-code", "await page.click('#submitVerdictBtn');"] });
      await runPw({
        session,
        args: [
          "run-code",
          "await page.waitForFunction(() => String(document.querySelector('#actionStatus')?.textContent || '').includes('verdict success') && String(document.querySelector('#actionStatus')?.textContent || '').includes('status=verdict_issued'));"
        ]
      });

      await runPw({
        session,
        args: ["run-code", "await page.fill('#closeSummaryInput', 'closed from browser e2e'); await page.click('#closeCaseBtn');"]
      });
      await runPw({
        session,
        args: [
          "run-code",
          "await page.waitForFunction(() => String(document.querySelector('#actionStatus')?.textContent || '').includes('close success') && String(document.querySelector('#actionStatus')?.textContent || '').includes('status=closed'));"
        ]
      });

      nowAt = "2026-02-10T14:15:00.000Z";
      await runPw({
        session,
        args: [
          "run-code",
          `await page.fill('#appealCaseIdInput', ${JSON.stringify(appealCaseId)});
           await page.fill('#appealReasonInput', 'browser workflow appeal');
           await page.click('#openAppealBtn');`
        ]
      });
      await runPw({
        session,
        args: [
          "run-code",
          "await page.waitForFunction(() => String(document.querySelector('#actionStatus')?.textContent || '').includes('appeal success') && String(document.querySelector('#actionStatus')?.textContent || '').includes('status=under_review'));"
        ]
      });
      await runPw({
        session,
        args: [
          "run-code",
          `await page.waitForFunction(() => String(document.querySelector('#caseOverview')?.textContent || '').includes(${JSON.stringify(appealCaseId)}));`
        ]
      });
      await runPw({
        session,
        args: [
          "run-code",
          `await page.waitForFunction(() => String(document.querySelector('#arbitrationRelatedCases')?.textContent || '').includes(${JSON.stringify(caseId)}));`
        ]
      });
      await runPw({
        session,
        args: [
          "run-code",
          "await page.waitForFunction(() => String(document.querySelector('#arbitrationAuditLinks')?.textContent || '').includes('Run settlement packet'));"
        ]
      });
    } finally {
      await Promise.allSettled([
        runPw({ session, args: ["close"] }),
        runPw({ session, args: ["close-all"] })
      ]);
      await new Promise((resolve) => server.close(resolve));
    }
  }
);
