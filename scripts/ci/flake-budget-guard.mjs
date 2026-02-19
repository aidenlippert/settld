#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "tests.yml");
const POLICY_DOC_PATH = path.join(ROOT, "docs", "ops", "CI_FLAKE_BUDGET.md");

function fail(msg) {
  process.stderr.write(`[flake-budget-guard] ${msg}\n`);
  process.exit(1);
}

function requirePattern({ text, pattern, label }) {
  if (!pattern.test(text)) {
    fail(`missing required policy marker: ${label}`);
  }
}

function forbidPattern({ text, pattern, label }) {
  if (pattern.test(text)) {
    fail(`forbidden flaky tolerance detected: ${label}`);
  }
}

async function main() {
  const [workflowText, policyText] = await Promise.all([
    readFile(WORKFLOW_PATH, "utf8"),
    readFile(POLICY_DOC_PATH, "utf8")
  ]);

  // Guard against silent flake debt by forbidding retry/continue-on-error patterns
  // in the canonical tests workflow.
  forbidPattern({
    text: workflowText,
    pattern: /\bcontinue-on-error\s*:\s*true\b/i,
    label: "continue-on-error: true"
  });
  forbidPattern({
    text: workflowText,
    pattern: /\b--retries?\b/i,
    label: "explicit retry flag"
  });

  // Keep policy explicit and discoverable.
  requirePattern({
    text: policyText,
    pattern: /^#\s*CI Flake Budget/m,
    label: "CI Flake Budget heading"
  });
  requirePattern({
    text: policyText,
    pattern: /\bBudget:\s*0\b/i,
    label: "Budget: 0 policy"
  });
  requirePattern({
    text: policyText,
    pattern: /\bEscalation\b/i,
    label: "Escalation section"
  });

  process.stdout.write("[flake-budget-guard] ok\n");
}

main().catch((err) => {
  fail(err?.message ?? String(err ?? ""));
});
