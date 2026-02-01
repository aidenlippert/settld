import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeArtifactHash, reconcileGlBatchAgainstPartyStatements } from "../packages/artifact-verify/src/index.js";

function makeProof() {
  return { lastChainHash: null, eventCount: 0, signatures: { signedEventCount: 0, signerKeyIds: [] } };
}

describe("reconcile: GLBatch.v1 ⇄ PartyStatement.v1", () => {
  it("passes when totals and entry ids match", () => {
    const glCore = {
      schemaVersion: "GLBatch.v1",
      artifactType: "GLBatch.v1",
      artifactId: "gl_1",
      generatedAt: "2026-01-20T10:00:00.000Z",
      tenantId: "tenant_default",
      period: "2026-01",
      basis: "settledAt",
      eventProof: makeProof(),
      batch: {
        type: "GLBatchBody.v1",
        tenantId: "tenant_default",
        period: "2026-01",
        basis: "settledAt",
        generatedAt: "2026-01-20T10:00:00.000Z",
        monthClose: null,
        totals: { totalCents: 0, totalsByAccountId: { acct_cash: 100, acct_platform_revenue: -100 }, totalsByPartyId: { pty_platform: 0 } },
        lines: [
          {
            lineId: "e1:p0:pty_platform",
            entryId: "e1",
            postingId: "p0",
            at: "2026-01-20T10:00:00.000Z",
            memo: "job:job_1 SETTLED",
            jobId: "job_1",
            accountId: "acct_cash",
            partyId: "pty_platform",
            partyRole: "platform",
            currency: "USD",
            amountCents: 100
          },
          {
            lineId: "e1:p1:pty_platform",
            entryId: "e1",
            postingId: "p1",
            at: "2026-01-20T10:00:00.000Z",
            memo: "job:job_1 SETTLED",
            jobId: "job_1",
            accountId: "acct_platform_revenue",
            partyId: "pty_platform",
            partyRole: "platform",
            currency: "USD",
            amountCents: -100
          }
        ]
      }
    };
    const glBatch = { ...glCore, artifactHash: computeArtifactHash(glCore) };

    const psCore = {
      schemaVersion: "PartyStatement.v1",
      artifactType: "PartyStatement.v1",
      artifactId: "ps_1",
      generatedAt: "2026-01-20T10:00:00.000Z",
      tenantId: "tenant_default",
      partyId: "pty_platform",
      partyRole: "platform",
      period: "2026-01",
      basis: "settledAt",
      statement: {
        totalsByAccountId: { acct_cash: 100, acct_platform_revenue: -100 },
        includedEntryIds: ["e1"]
      },
      eventProof: makeProof()
    };
    const partyStatement = { ...psCore, artifactHash: computeArtifactHash(psCore) };

    const res = reconcileGlBatchAgainstPartyStatements({ glBatch, partyStatements: [partyStatement] });
    assert.equal(res.ok, true);
  });

  it("fails when totals mismatch", () => {
    const glCore = {
      schemaVersion: "GLBatch.v1",
      artifactType: "GLBatch.v1",
      artifactId: "gl_1",
      generatedAt: "2026-01-20T10:00:00.000Z",
      tenantId: "tenant_default",
      period: "2026-01",
      basis: "settledAt",
      eventProof: makeProof(),
      batch: {
        type: "GLBatchBody.v1",
        tenantId: "tenant_default",
        period: "2026-01",
        basis: "settledAt",
        generatedAt: "2026-01-20T10:00:00.000Z",
        monthClose: null,
        totals: { totalCents: 0, totalsByAccountId: { acct_cash: 100, acct_platform_revenue: -100 }, totalsByPartyId: { pty_platform: 0 } },
        lines: [
          { lineId: "e1:p0:pty_platform", entryId: "e1", postingId: "p0", accountId: "acct_cash", partyId: "pty_platform", partyRole: "platform", currency: "USD", amountCents: 100 },
          { lineId: "e1:p1:pty_platform", entryId: "e1", postingId: "p1", accountId: "acct_platform_revenue", partyId: "pty_platform", partyRole: "platform", currency: "USD", amountCents: -100 }
        ]
      }
    };
    const glBatch = { ...glCore, artifactHash: computeArtifactHash(glCore) };

    const psCore = {
      schemaVersion: "PartyStatement.v1",
      artifactType: "PartyStatement.v1",
      artifactId: "ps_1",
      generatedAt: "2026-01-20T10:00:00.000Z",
      tenantId: "tenant_default",
      partyId: "pty_platform",
      partyRole: "platform",
      period: "2026-01",
      basis: "settledAt",
      statement: {
        totalsByAccountId: { acct_cash: 100, acct_platform_revenue: -99 },
        includedEntryIds: ["e1"]
      },
      eventProof: makeProof()
    };
    const partyStatement = { ...psCore, artifactHash: computeArtifactHash(psCore) };

    const res = reconcileGlBatchAgainstPartyStatements({ glBatch, partyStatements: [partyStatement] });
    assert.equal(res.ok, false);
    assert.equal(res.error, "totals mismatch");
  });
});

