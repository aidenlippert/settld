import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function pythonAvailable() {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

function readFile(relativePath) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("api-sdk-python contract freeze: manual-review + dispute lifecycle methods remain published", () => {
  const source = readFile("packages/api-sdk-python/settld_api_sdk/client.py");
  const readme = readFile("packages/api-sdk-python/README.md");

  assert.match(source, /def get_run_settlement_policy_replay\(/);
  assert.match(source, /def resolve_run_settlement\(/);
  assert.match(source, /def create_agreement\(/);
  assert.match(source, /def sign_evidence\(/);
  assert.match(source, /def create_hold\(/);
  assert.match(source, /def settle\(/);
  assert.match(source, /def build_dispute_open_envelope\(/);
  assert.match(source, /def open_dispute\(/);
  assert.match(source, /def ops_get_tool_call_replay_evaluate\(/);
  assert.match(source, /def ops_get_reputation_facts\(/);
  assert.match(source, /def get_artifact\(/);
  assert.match(source, /def get_artifacts\(/);
  assert.match(source, /def open_run_dispute\(/);
  assert.match(source, /def submit_run_dispute_evidence\(/);
  assert.match(source, /def escalate_run_dispute\(/);
  assert.match(source, /def close_run_dispute\(/);

  assert.match(source, /\/ops\/tool-calls\/holds\/lock/);
  assert.match(source, /\/ops\/tool-calls\/replay-evaluate\?/);
  assert.match(source, /\/ops\/reputation\/facts\?/);
  assert.match(source, /\/tool-calls\/arbitration\/open/);
  assert.match(source, /\/artifacts\//);
  assert.match(source, /\/settlement\/policy-replay/);
  assert.match(source, /\/settlement\/resolve/);
  assert.match(source, /\/dispute\/open/);
  assert.match(source, /\/dispute\/evidence/);
  assert.match(source, /\/dispute\/escalate/);
  assert.match(source, /\/dispute\/close/);

  assert.match(readme, /create_agreement/);
  assert.match(readme, /sign_evidence/);
  assert.match(readme, /create_hold/);
  assert.match(readme, /settle/);
  assert.match(readme, /build_dispute_open_envelope/);
  assert.match(readme, /open_dispute/);
  assert.match(readme, /ops_get_tool_call_replay_evaluate/);
  assert.match(readme, /ops_get_reputation_facts/);
  assert.match(readme, /get_artifact/);
  assert.match(readme, /get_artifacts/);
  assert.match(readme, /get_run_settlement_policy_replay/);
  assert.match(readme, /resolve_run_settlement/);
  assert.match(readme, /open_run_dispute/);
  assert.match(readme, /submit_run_dispute_evidence/);
  assert.match(readme, /escalate_run_dispute/);
  assert.match(readme, /close_run_dispute/);
});

test("api-sdk-python contract freeze: dispute lifecycle dispatch wiring remains stable", { skip: !pythonAvailable() }, () => {
  const script = [
    "import json, pathlib, sys",
    "repo = pathlib.Path.cwd()",
    "sys.path.insert(0, str(repo / 'packages' / 'api-sdk-python'))",
    "from settld_api_sdk import SettldClient",
    "calls = []",
    "def fake(method, path, **kwargs):",
    "    calls.append({",
    "        'method': method,",
    "        'path': path,",
    "        'idempotencyKey': kwargs.get('idempotency_key'),",
    "        'body': kwargs.get('body')",
    "    })",
    "    return {'ok': True, 'status': 200, 'requestId': 'req_py_sdk_1', 'body': {'settlement': {'disputeStatus': 'open'}}}",
    "client = SettldClient(base_url='https://api.settld.local', tenant_id='tenant_py_sdk')",
    "client._request = fake",
    "client.get_run_settlement_policy_replay('run_py_1')",
    "client.resolve_run_settlement('run_py_1', {'status': 'released'}, idempotency_key='py_resolve_1')",
    "client.open_run_dispute('run_py_1', {'disputeId': 'dsp_py_1', 'escalationLevel': 'l1_counterparty'}, idempotency_key='py_open_1')",
    "client.submit_run_dispute_evidence('run_py_1', {'disputeId': 'dsp_py_1', 'evidenceRef': 'evidence://run_py_1/output.json'}, idempotency_key='py_evidence_1')",
    "client.escalate_run_dispute('run_py_1', {'disputeId': 'dsp_py_1', 'escalationLevel': 'l2_arbiter'}, idempotency_key='py_escalate_1')",
    "client.close_run_dispute('run_py_1', {'disputeId': 'dsp_py_1', 'resolutionOutcome': 'partial'}, idempotency_key='py_close_1')",
    "print(json.dumps(calls))"
  ].join("\n");

  const run = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(
    run.status,
    0,
    `python lifecycle contract check failed\n\nstdout:\n${run.stdout ?? ""}\n\nstderr:\n${run.stderr ?? ""}`
  );

  const calls = JSON.parse(String(run.stdout ?? "[]"));
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map((entry) => [entry.method, entry.path]),
    [
      ["GET", "/runs/run_py_1/settlement/policy-replay"],
      ["POST", "/runs/run_py_1/settlement/resolve"],
      ["POST", "/runs/run_py_1/dispute/open"],
      ["POST", "/runs/run_py_1/dispute/evidence"],
      ["POST", "/runs/run_py_1/dispute/escalate"],
      ["POST", "/runs/run_py_1/dispute/close"]
    ]
  );
  assert.equal(calls[1].idempotencyKey, "py_resolve_1");
  assert.equal(calls[2].idempotencyKey, "py_open_1");
  assert.equal(calls[3].idempotencyKey, "py_evidence_1");
  assert.equal(calls[4].idempotencyKey, "py_escalate_1");
  assert.equal(calls[5].idempotencyKey, "py_close_1");
});

test("api-sdk-python contract freeze: tool-call kernel wrappers remain wired", { skip: !pythonAvailable() }, () => {
  const script = [
    "import json, pathlib, sys",
    "repo = pathlib.Path.cwd()",
    "sys.path.insert(0, str(repo / 'packages' / 'api-sdk-python'))",
    "from settld_api_sdk import SettldClient",
    "calls = []",
    "def fake(method, path, **kwargs):",
    "    calls.append({",
    "        'method': method,",
    "        'path': path,",
    "        'idempotencyKey': kwargs.get('idempotency_key'),",
    "        'body': kwargs.get('body')",
    "    })",
    "    if path.startswith('/ops/tool-calls/holds/lock'):",
    "        body = kwargs.get('body') or {}",
    "        return {'ok': True, 'status': 201, 'requestId': 'req_py_sdk_tool_1', 'body': {'hold': {'holdHash': 'a'*64, 'agreementHash': body.get('agreementHash'), 'receiptHash': body.get('receiptHash')}}}",
    "    if path.startswith('/tool-calls/arbitration/open'):",
    "        return {'ok': True, 'status': 201, 'requestId': 'req_py_sdk_tool_2', 'body': {'arbitrationCase': {'caseId': 'arb_case_tc_demo'}}}",
    "    if path.startswith('/ops/reputation/facts?'):",
    "        return {'ok': True, 'status': 200, 'requestId': 'req_py_sdk_tool_4', 'body': {'facts': {'totals': {'decisions': {'approved': 1}}}}}",
    "    if path.startswith('/artifacts/'):",
    "        aid = path.split('/artifacts/', 1)[1]",
    "        return {'ok': True, 'status': 200, 'requestId': 'req_py_sdk_tool_3', 'body': {'artifact': {'artifactId': aid}}}",
    "    return {'ok': True, 'status': 200, 'requestId': 'req_py_sdk_tool_0', 'body': {}}",
    "client = SettldClient(base_url='https://api.settld.local', tenant_id='tenant_py_sdk')",
    "client._request = fake",
    "agreement = client.create_agreement({'toolId':'cap_demo','manifestHash':'f'*64,'callId':'call_demo_1','input':{'text':'hello'},'createdAt':'2026-02-11T00:00:00.000Z'})",
    "evidence = client.sign_evidence({'agreement': agreement['agreement'], 'output': {'upper':'HELLO'}, 'startedAt':'2026-02-11T00:00:01.000Z','completedAt':'2026-02-11T00:00:02.000Z'})",
    "settled = client.settle({'agreement': agreement['agreement'], 'evidence': evidence['evidence'], 'payerAgentId':'agt_payer_1', 'payeeAgentId':'agt_payee_1', 'amountCents':10000, 'currency':'USD', 'holdbackBps':2000, 'challengeWindowMs':60000, 'settledAt':'2026-02-11T00:00:03.000Z'}, idempotency_key='py_tool_settle_1')",
    "client.open_dispute({'agreementHash': settled['agreementHash'], 'receiptHash': settled['receiptHash'], 'holdHash': settled['hold']['holdHash'], 'openedByAgentId':'agt_payee_1', 'arbiterAgentId':'agt_arbiter_1', 'summary':'quality dispute', 'signerKeyId':'key_py_demo_1', 'signature':'sig_py_demo_1'}, idempotency_key='py_tool_open_1')",
    "client.ops_get_tool_call_replay_evaluate('1'*64)",
    "client.ops_get_reputation_facts({'agentId':'agt_payee_1','toolId':'tool_call','window':'allTime','includeEvents':True})",
    "client.get_artifacts(['art_case_1','art_verdict_1'])",
    "print(json.dumps({'agreementHash': agreement['agreementHash'], 'evidenceHash': evidence['evidenceHash'], 'calls': calls}))"
  ].join("\n");

  const run = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(
    run.status,
    0,
    `python tool-call wrapper contract check failed\n\nstdout:\n${run.stdout ?? ""}\n\nstderr:\n${run.stderr ?? ""}`
  );
  const parsed = JSON.parse(String(run.stdout ?? "{}"));
  assert.match(String(parsed.agreementHash ?? ""), /^[0-9a-f]{64}$/);
  assert.match(String(parsed.evidenceHash ?? ""), /^[0-9a-f]{64}$/);
  const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map((entry) => [entry.method, entry.path]),
    [
      ["POST", "/ops/tool-calls/holds/lock"],
      ["POST", "/tool-calls/arbitration/open"],
      ["GET", "/ops/tool-calls/replay-evaluate?agreementHash=1111111111111111111111111111111111111111111111111111111111111111"],
      ["GET", "/ops/reputation/facts?agentId=agt_payee_1&toolId=tool_call&window=allTime&includeEvents=1"],
      ["GET", "/artifacts/art_case_1"],
      ["GET", "/artifacts/art_verdict_1"]
    ]
  );
  assert.equal(calls[0].idempotencyKey, "py_tool_settle_1");
  assert.equal(calls[1].idempotencyKey, "py_tool_open_1");
});
