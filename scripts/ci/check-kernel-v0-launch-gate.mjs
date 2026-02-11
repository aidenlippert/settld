#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_AUDIT_PATH = "planning/kernel-v0-truth-audit.md";

const REQUIRED_TRUE_CLAIMS_BY_MODE = {
  prepublish: [
    {
      key: "dispute_envelope_required",
      description: "Signed dispute-open envelope required for non-admin opens",
      match: /signed dispute-open envelope required for non-admin opens/i
    },
    {
      key: "holdback_freeze_open_arbitration",
      description: "Holdback tick skips auto-release when arbitration is open",
      match: /holdback tick skips auto-release when arbitration is open/i
    },
    {
      key: "deterministic_holdback_adjustment",
      description: "Deterministic holdback adjustment flow exists",
      match: /deterministic holdback adjustment flow exists/i
    },
    {
      key: "tool_call_replay_endpoint",
      description: "Tool-call replay endpoint exists and is wired",
      match: /tool-call replay endpoint exists and is wired/i
    },
    {
      key: "run_replay_endpoint",
      description: "Run settlement replay endpoint exists",
      match: /run settlement replay endpoint exists/i
    },
    {
      key: "closepack_offline_verify_gated",
      description: "Closepack export + offline verify exists and is conformance-gated",
      match: /closepack export \+ offline verify exists and is conformance-gated/i
    },
    {
      key: "deterministic_verifier_meaningful_fail",
      description: "Deterministic verifier exists with at least one meaningful failing case",
      match: /deterministic verifier exists with at least one meaningful failing case/i
    },
    {
      key: "reputation_true",
      description: "Reputation is indexed/readable and idempotent insert paths exist",
      match: /reputation is indexed\/readable and idempotent insert paths exist/i
    },
    {
      key: "registry_publish_wired",
      description: "Registry publish is wired",
      match: /registry publish is wired/i
    }
  ],
  postpublish: [
    {
      key: "dispute_envelope_required",
      description: "Signed dispute-open envelope required for non-admin opens",
      match: /signed dispute-open envelope required for non-admin opens/i
    },
    {
      key: "holdback_freeze_open_arbitration",
      description: "Holdback tick skips auto-release when arbitration is open",
      match: /holdback tick skips auto-release when arbitration is open/i
    },
    {
      key: "deterministic_holdback_adjustment",
      description: "Deterministic holdback adjustment flow exists",
      match: /deterministic holdback adjustment flow exists/i
    },
    {
      key: "tool_call_replay_endpoint",
      description: "Tool-call replay endpoint exists and is wired",
      match: /tool-call replay endpoint exists and is wired/i
    },
    {
      key: "run_replay_endpoint",
      description: "Run settlement replay endpoint exists",
      match: /run settlement replay endpoint exists/i
    },
    {
      key: "closepack_offline_verify_gated",
      description: "Closepack export + offline verify exists and is conformance-gated",
      match: /closepack export \+ offline verify exists and is conformance-gated/i
    },
    {
      key: "deterministic_verifier_meaningful_fail",
      description: "Deterministic verifier exists with at least one meaningful failing case",
      match: /deterministic verifier exists with at least one meaningful failing case/i
    },
    {
      key: "reputation_true",
      description: "Reputation is indexed/readable and idempotent insert paths exist",
      match: /reputation is indexed\/readable and idempotent insert paths exist/i
    },
    {
      key: "npm_publish_proven",
      description: "First live npm publish proven",
      match: /first live npm publish proven/i
    }
  ]
};

const REQUIRED_TRUE_CLAIMS = REQUIRED_TRUE_CLAIMS_BY_MODE.prepublish;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { file: DEFAULT_AUDIT_PATH, mode: "prepublish" };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if ((a === "--file" || a === "-f") && args[i + 1]) {
      out.file = args[i + 1];
      i += 1;
    } else if ((a === "--mode" || a === "-m") && args[i + 1]) {
      const mode = String(args[i + 1]).trim().toLowerCase();
      if (mode !== "prepublish" && mode !== "postpublish") {
        throw new Error(`invalid --mode: ${mode} (expected prepublish|postpublish)`);
      }
      out.mode = mode;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function usage() {
  return [
    "Usage: node scripts/ci/check-kernel-v0-launch-gate.mjs [--file <path>] [--mode prepublish|postpublish]",
    "",
    "Fails when required Kernel v0 launch claims are not marked TRUE in",
    "planning/kernel-v0-truth-audit.md."
  ].join("\n");
}

function parseClaimStatuses(markdown) {
  const rows = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").map((c) => c.trim());
    if (cols.length < 4) continue;
    const claim = cols[1] || "";
    const statusCell = cols[2] || "";
    if (!claim || /^-+$/.test(claim.replace(/\s+/g, ""))) continue;
    const statusMatch = statusCell.match(/\*\*(TRUE|PARTIAL|FALSE)\*\*/i);
    if (!statusMatch) continue;
    rows.push({ claim, status: statusMatch[1].toUpperCase() });
  }
  return rows;
}

function findClaim(rows, matcher) {
  return rows.find((r) => matcher.test(r.claim));
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(String(err?.message || err));
    console.error("");
    console.error(usage());
    process.exit(2);
  }

  if (opts.help) {
    console.log(usage());
    return;
  }

  const auditPath = path.resolve(process.cwd(), opts.file);
  if (!fs.existsSync(auditPath)) {
    console.error(`launch gate audit file not found: ${auditPath}`);
    process.exit(2);
  }

  const markdown = fs.readFileSync(auditPath, "utf8");
  const rows = parseClaimStatuses(markdown);
  if (rows.length === 0) {
    console.error(`no TRUE/PARTIAL/FALSE claim rows found in ${auditPath}`);
    process.exit(2);
  }
  const requiredClaims = REQUIRED_TRUE_CLAIMS_BY_MODE[opts.mode] || REQUIRED_TRUE_CLAIMS;

  const failures = [];
  const passes = [];
  for (const requirement of requiredClaims) {
    const row = findClaim(rows, requirement.match);
    if (!row) {
      failures.push({
        key: requirement.key,
        description: requirement.description,
        reason: "MISSING_CLAIM_ROW"
      });
      continue;
    }
    if (row.status !== "TRUE") {
      failures.push({
        key: requirement.key,
        description: requirement.description,
        reason: `STATUS_${row.status}`
      });
      continue;
    }
    passes.push({ key: requirement.key, description: requirement.description });
  }

  console.log("Kernel v0 launch gate checklist");
  console.log(`Mode: ${opts.mode}`);
  console.log(`Audit file: ${path.relative(process.cwd(), auditPath)}`);
  console.log(`Required TRUE claims: ${requiredClaims.length}`);
  console.log(`Pass: ${passes.length}`);
  console.log(`Fail: ${failures.length}`);

  if (failures.length > 0) {
    console.error("\nLaunch gate check failed:");
    for (const failure of failures) {
      console.error(`- ${failure.key}: ${failure.description} (${failure.reason})`);
    }
    process.exit(1);
  }

  console.log("\nAll required launch gate claims are TRUE.");
}

main();
