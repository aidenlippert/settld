import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function pythonAvailable() {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

function pythonCryptographyAvailable() {
  if (!pythonAvailable()) return false;
  const probe = spawnSync("python3", ["-c", "import cryptography"], { encoding: "utf8" });
  return probe.status === 0;
}

function readFile(relativePath) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function extractJsMethodNames(source) {
  return new Set(
    Array.from(source.matchAll(/^\s{2}(?:async\s+)?\*?\s*([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\s*\{/gm), (match) => String(match[1]))
  );
}

function extractPythonMethodNames(source) {
  return new Set(
    Array.from(source.matchAll(/^\s{4}def\s+([A-Za-z_][A-Za-z0-9_]*)\(/gm), (match) => String(match[1]))
  );
}

test("api-sdk-python contract freeze: manual-review + dispute lifecycle methods remain published", () => {
  const source = readFile("packages/api-sdk-python/nooterra_api_sdk/client.py");
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
  assert.match(source, /def upsert_agent_card\(/);
  assert.match(source, /def discover_public_agent_cards\(/);
  assert.match(source, /def stream_public_agent_cards\(/);
  assert.match(source, /def get_public_agent_reputation_summary\(/);
  assert.match(source, /def get_agent_interaction_graph_pack\(/);
  assert.match(source, /def list_relationships\(/);
  assert.match(source, /def issue_delegation_grant\(/);
  assert.match(source, /def get_delegation_grant\(/);
  assert.match(source, /def issue_authority_grant\(/);
  assert.match(source, /def get_authority_grant\(/);
  assert.match(source, /def create_task_quote\(/);
  assert.match(source, /def get_task_quote\(/);
  assert.match(source, /def create_task_offer\(/);
  assert.match(source, /def get_task_offer\(/);
  assert.match(source, /def create_task_acceptance\(/);
  assert.match(source, /def get_task_acceptance\(/);
  assert.match(source, /def create_work_order\(/);
  assert.match(source, /def top_up_work_order\(/);
  assert.match(source, /def get_work_order_metering\(/);
  assert.match(source, /def create_state_checkpoint\(/);
  assert.match(source, /def list_state_checkpoints\(/);
  assert.match(source, /def get_state_checkpoint\(/);
  assert.match(source, /def create_session\(/);
  assert.match(source, /def list_sessions\(/);
  assert.match(source, /def get_session\(/);
  assert.match(source, /def list_session_events\(/);
  assert.match(source, /def stream_session_events\(/);
  assert.match(source, /def append_session_event\(/);
  assert.match(source, /def get_session_replay_pack\(/);
  assert.match(source, /def create_capability_attestation\(/);
  assert.match(source, /def get_capability_attestation\(/);
  assert.match(source, /def revoke_capability_attestation\(/);

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
  assert.match(source, /\/public\/agent-cards\/discover/);
  assert.match(source, /\/delegation-grants/);
  assert.match(source, /\/authority-grants/);
  assert.match(source, /\/task-quotes/);
  assert.match(source, /\/task-offers/);
  assert.match(source, /\/task-acceptances/);
  assert.match(source, /\/work-orders/);
  assert.match(source, /\/work-orders\/.*\/metering/);
  assert.match(source, /\/sessions/);
  assert.match(source, /\/relationships/);
  assert.match(source, /public\/agent-cards\/stream/);
  assert.match(source, /\/public\/agents\/.*\/reputation-summary/);
  assert.match(source, /\/interaction-graph-pack/);
  assert.match(source, /\/state-checkpoints/);
  assert.match(source, /\/capability-attestations/);
  assert.match(source, /includeRoutingFactors/);
  assert.match(source, /subjectAgentId/);

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
  assert.match(readme, /upsert_agent_card/);
  assert.match(readme, /discover_public_agent_cards/);
  assert.match(readme, /stream_public_agent_cards/);
  assert.match(readme, /get_public_agent_reputation_summary/);
  assert.match(readme, /get_agent_interaction_graph_pack/);
  assert.match(readme, /list_relationships/);
  assert.match(readme, /issue_delegation_grant/);
  assert.match(readme, /get_delegation_grant/);
  assert.match(readme, /issue_authority_grant/);
  assert.match(readme, /get_authority_grant/);
  assert.match(readme, /create_task_quote\|offer\|acceptance/);
  assert.match(readme, /list\/get/);
  assert.match(readme, /create_work_order/);
  assert.match(readme, /create_state_checkpoint/);
  assert.match(readme, /create_session/);
  assert.match(readme, /stream_session_events/);
  assert.match(readme, /create_capability_attestation/);
  assert.match(readme, /list\/get\/revoke_capability_attestation/);
});

test("api-sdk-python contract freeze: JS to Python ACS surface mapping remains complete", () => {
  const jsSource = readFile("packages/api-sdk/src/client.js");
  const pySource = readFile("packages/api-sdk-python/nooterra_api_sdk/client.py");
  const jsMethods = extractJsMethodNames(jsSource);
  const pyMethods = extractPythonMethodNames(pySource);

  const requiredAcsMethodMap = [
    ["upsertAgentCard", "upsert_agent_card"],
    ["listAgentCards", "list_agent_cards"],
    ["getAgentCard", "get_agent_card"],
    ["discoverAgentCards", "discover_agent_cards"],
    ["discoverPublicAgentCards", "discover_public_agent_cards"],
    ["streamPublicAgentCards", "stream_public_agent_cards"],
    ["getPublicAgentReputationSummary", "get_public_agent_reputation_summary"],
    ["getAgentInteractionGraphPack", "get_agent_interaction_graph_pack"],
    ["listRelationships", "list_relationships"],
    ["createDelegationGrant", "issue_delegation_grant"],
    ["listDelegationGrants", "list_delegation_grants"],
    ["getDelegationGrant", "get_delegation_grant"],
    ["revokeDelegationGrant", "revoke_delegation_grant"],
    ["createAuthorityGrant", "issue_authority_grant"],
    ["listAuthorityGrants", "list_authority_grants"],
    ["getAuthorityGrant", "get_authority_grant"],
    ["revokeAuthorityGrant", "revoke_authority_grant"],
    ["createTaskQuote", "create_task_quote"],
    ["listTaskQuotes", "list_task_quotes"],
    ["getTaskQuote", "get_task_quote"],
    ["createTaskOffer", "create_task_offer"],
    ["listTaskOffers", "list_task_offers"],
    ["getTaskOffer", "get_task_offer"],
    ["createTaskAcceptance", "create_task_acceptance"],
    ["listTaskAcceptances", "list_task_acceptances"],
    ["getTaskAcceptance", "get_task_acceptance"],
    ["proposeIntentContract", "propose_intent_contract"],
    ["listIntentContracts", "list_intent_contracts"],
    ["getIntentContract", "get_intent_contract"],
    ["counterIntentContract", "counter_intent_contract"],
    ["acceptIntentContract", "accept_intent_contract"],
    ["createWorkOrder", "create_work_order"],
    ["listWorkOrders", "list_work_orders"],
    ["getWorkOrder", "get_work_order"],
    ["acceptWorkOrder", "accept_work_order"],
    ["progressWorkOrder", "progress_work_order"],
    ["topUpWorkOrder", "top_up_work_order"],
    ["getWorkOrderMetering", "get_work_order_metering"],
    ["completeWorkOrder", "complete_work_order"],
    ["settleWorkOrder", "settle_work_order"],
    ["listWorkOrderReceipts", "list_work_order_receipts"],
    ["getWorkOrderReceipt", "get_work_order_receipt"],
    ["createStateCheckpoint", "create_state_checkpoint"],
    ["listStateCheckpoints", "list_state_checkpoints"],
    ["getStateCheckpoint", "get_state_checkpoint"],
    ["createSession", "create_session"],
    ["listSessions", "list_sessions"],
    ["getSession", "get_session"],
    ["listSessionEvents", "list_session_events"],
    ["getSessionEventCheckpoint", "get_session_event_checkpoint"],
    ["ackSessionEventCheckpoint", "ack_session_event_checkpoint"],
    ["requeueSessionEventCheckpoint", "requeue_session_event_checkpoint"],
    ["appendSessionEvent", "append_session_event"],
    ["streamSessionEvents", "stream_session_events"],
    ["getSessionReplayPack", "get_session_replay_pack"],
    ["getSessionTranscript", "get_session_transcript"],
    ["createCapabilityAttestation", "create_capability_attestation"],
    ["listCapabilityAttestations", "list_capability_attestations"],
    ["getCapabilityAttestation", "get_capability_attestation"],
    ["revokeCapabilityAttestation", "revoke_capability_attestation"],
  ];

  for (const [jsName, pyName] of requiredAcsMethodMap) {
    assert.equal(jsMethods.has(jsName), true, `missing JS SDK ACS method: ${jsName}`);
    assert.equal(pyMethods.has(pyName), true, `missing Python SDK ACS method: ${pyName}`);
  }
});

test("api-sdk-python contract freeze: dispute lifecycle dispatch wiring remains stable", { skip: !pythonAvailable() }, () => {
  const script = [
    "import json, pathlib, sys",
    "repo = pathlib.Path.cwd()",
    "sys.path.insert(0, str(repo / 'packages' / 'api-sdk-python'))",
    "from nooterra_api_sdk import NooterraClient",
    "calls = []",
    "def fake(method, path, **kwargs):",
    "    calls.append({",
    "        'method': method,",
    "        'path': path,",
    "        'idempotencyKey': kwargs.get('idempotency_key'),",
    "        'body': kwargs.get('body')",
    "    })",
    "    return {'ok': True, 'status': 200, 'requestId': 'req_py_sdk_1', 'body': {'settlement': {'disputeStatus': 'open'}}}",
    "client = NooterraClient(base_url='https://api.nooterra.local', tenant_id='tenant_py_sdk')",
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
    "from nooterra_api_sdk import NooterraClient",
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
    "client = NooterraClient(base_url='https://api.nooterra.local', tenant_id='tenant_py_sdk')",
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

test(
  "api-sdk-python contract freeze: auto-sign helper paths and fail-closed validation remain stable",
  { skip: !pythonAvailable() || !pythonCryptographyAvailable() },
  () => {
  const script = [
    "import json, pathlib, sys",
    "repo = pathlib.Path.cwd()",
    "sys.path.insert(0, str(repo / 'packages' / 'api-sdk-python'))",
    "from nooterra_api_sdk import NooterraClient",
    "client = NooterraClient(base_url='https://api.nooterra.local', tenant_id='tenant_py_sdk')",
    "private_key_pem = '-----BEGIN PRIVATE KEY-----\\nMC4CAQAwBQYDK2VwBCIEIMoDlT2W3lBH5gvYjpAT49u2WjXVn2YcTf6xuzJHrEKA\\n-----END PRIVATE KEY-----\\n'",
    "agreement = client.create_agreement({'toolId':'cap_demo','manifestHash':'f'*64,'callId':'call_demo_1','input':{'text':'hello'},'createdAt':'2026-02-11T00:00:00.000Z'})",
    "signed_evidence = client.sign_evidence({'agreement': agreement['agreement'], 'output': {'upper':'HELLO'}, 'startedAt':'2026-02-11T00:00:01.000Z','completedAt':'2026-02-11T00:00:02.000Z','signerKeyId':'key_py_signer_1','signerPrivateKeyPem': private_key_pem})",
    "signed_envelope = client.build_dispute_open_envelope({'agreementHash': agreement['agreementHash'], 'receiptHash': '1'*64, 'holdHash': '2'*64, 'openedByAgentId':'agt_payee_1', 'signerKeyId':'key_py_signer_1', 'signerPrivateKeyPem': private_key_pem, 'openedAt':'2026-02-11T00:00:03.000Z', 'nonce':'nonce_py_sign_1'})",
    "errors = {}",
    "def capture(name, fn):",
    "    try:",
    "        fn()",
    "        errors[name] = None",
    "    except Exception as exc:",
    "        errors[name] = str(exc)",
    "capture('signMissingSignerKeyId', lambda: client.sign_evidence({'agreement': agreement['agreement'], 'output': {'upper':'HELLO'}, 'startedAt':'2026-02-11T00:00:01.000Z','completedAt':'2026-02-11T00:00:02.000Z','signerPrivateKeyPem': private_key_pem}))",
    "capture('envelopeMissingSignatureOrKey', lambda: client.build_dispute_open_envelope({'agreementHash': agreement['agreementHash'], 'receiptHash': '1'*64, 'holdHash': '2'*64, 'openedByAgentId':'agt_payee_1', 'signerKeyId':'key_py_signer_1'}))",
    "capture('envelopeMissingSignerKeyId', lambda: client.build_dispute_open_envelope({'agreementHash': agreement['agreementHash'], 'receiptHash': '1'*64, 'holdHash': '2'*64, 'openedByAgentId':'agt_payee_1', 'signerPrivateKeyPem': private_key_pem}))",
    "print(json.dumps({'evidenceSignatureAlgorithm': signed_evidence.get('evidence', {}).get('signature', {}).get('algorithm'), 'evidenceSignerKeyId': signed_evidence.get('evidence', {}).get('signature', {}).get('signerKeyId'), 'evidenceSignature': signed_evidence.get('evidence', {}).get('signature', {}).get('signature'), 'envelopeSignerKeyId': signed_envelope.get('disputeOpenEnvelope', {}).get('signerKeyId'), 'envelopeSignature': signed_envelope.get('disputeOpenEnvelope', {}).get('signature'), 'errors': errors}))",
  ].join("\n");

  const run = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(
    run.status,
    0,
    `python auto-sign helper contract check failed\n\nstdout:\n${run.stdout ?? ""}\n\nstderr:\n${run.stderr ?? ""}`
  );

  const parsed = JSON.parse(String(run.stdout ?? "{}"));
  assert.equal(parsed.evidenceSignatureAlgorithm, "ed25519");
  assert.equal(parsed.evidenceSignerKeyId, "key_py_signer_1");
  assert.match(String(parsed.evidenceSignature ?? ""), /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(parsed.envelopeSignerKeyId, "key_py_signer_1");
  assert.match(String(parsed.envelopeSignature ?? ""), /^[A-Za-z0-9+/]+={0,2}$/);
  assert.match(String(parsed.errors?.signMissingSignerKeyId ?? ""), /signerKeyId/);
  assert.match(String(parsed.errors?.envelopeMissingSignatureOrKey ?? ""), /signature|signerPrivateKeyPem/);
  assert.match(String(parsed.errors?.envelopeMissingSignerKeyId ?? ""), /signerKeyId/);
  }
);

test("api-sdk-python contract freeze: ACS substrate wrappers remain wired", { skip: !pythonAvailable() }, () => {
  const script = [
    "import json, pathlib, sys",
    "repo = pathlib.Path.cwd()",
    "sys.path.insert(0, str(repo / 'packages' / 'api-sdk-python'))",
    "from nooterra_api_sdk import NooterraClient",
    "calls = []",
    "def fake(method, path, **kwargs):",
    "    calls.append({",
    "        'method': method,",
    "        'path': path,",
    "        'idempotencyKey': kwargs.get('idempotency_key'),",
    "        'expectedPrevChainHash': kwargs.get('expected_prev_chain_hash'),",
    "        'body': kwargs.get('body')",
    "    })",
    "    return {'ok': True, 'status': 200, 'requestId': 'req_py_sdk_acs_1', 'body': {'ok': True}}",
    "client = NooterraClient(base_url='https://api.nooterra.local', tenant_id='tenant_py_sdk')",
    "client._request = fake",
    "client.upsert_agent_card({'agentId':'agt_alpha'})",
    "client.discover_agent_cards({'capability':'capability://code','includeRoutingFactors':True,'requesterAgentId':'agt_buyer'})",
    "client.discover_public_agent_cards({'capability':'capability://travel','includeReputation':False,'limit':3})",
    "client.issue_delegation_grant({'grantId':'dg_1','delegatorAgentId':'agt_principal','delegateeAgentId':'agt_worker'})",
    "client.get_delegation_grant('dg_1')",
    "client.revoke_delegation_grant('dg_1', {'reasonCode':'REVOKED_BY_PRINCIPAL'})",
    "client.issue_authority_grant({'grantId':'ag_1','principalRef':{'principalId':'prn_1'},'granteeAgentId':'agt_worker'})",
    "client.get_authority_grant('ag_1')",
    "client.revoke_authority_grant('ag_1')",
    "client.create_task_quote({'quoteId':'q_1'})",
    "client.list_task_quotes({'quoteId':'q_1','requiredCapability':'capability://code','limit':5})",
    "client.get_task_quote('q_1')",
    "client.create_task_offer({'offerId':'o_1'})",
    "client.list_task_offers({'offerId':'o_1','quoteId':'q_1','limit':5})",
    "client.get_task_offer('o_1')",
    "client.create_task_acceptance({'acceptanceId':'a_1'})",
    "client.list_task_acceptances({'acceptanceId':'a_1','quoteId':'q_1','offerId':'o_1'})",
    "client.get_task_acceptance('a_1')",
    "client.create_work_order({'workOrderId':'wo_1'})",
    "client.list_work_orders({'workOrderId':'wo_1','status':'created'})",
    "client.accept_work_order('wo_1', {'acceptedByAgentId':'agt_worker'})",
    "client.progress_work_order('wo_1', {'eventType':'progress','percentComplete':50})",
    "client.complete_work_order('wo_1', {'output':{'ok':True}})",
    "client.settle_work_order('wo_1', {'decision':'release'})",
    "client.list_work_order_receipts({'workOrderId':'wo_1'})",
    "client.get_work_order_receipt('rcpt_1')",
    "client.create_session({'sessionId':'sess_1'})",
    "client.append_session_event('sess_1', {'type':'TASK_REQUESTED','payload':{'text':'hi'}}, expected_prev_chain_hash='0'*64)",
    "client.list_session_events('sess_1', {'eventType':'message','limit':10,'offset':0,'sinceEventId':'evt_prev_1'})",
    "client.get_session_replay_pack('sess_1', {'sign': True, 'signerKeyId': 'key_py_1'})",
    "client.get_session_transcript('sess_1', {'sign': True})",
    "client.create_capability_attestation({'attestationId':'catt_1'})",
    "client.list_capability_attestations({'subjectAgentId':'agt_worker','capability':'capability://code'})",
    "client.get_capability_attestation('catt_1')",
    "client.revoke_capability_attestation('catt_1', {'reasonCode':'REVOKED_BY_ISSUER'})",
    "print(json.dumps(calls))",
  ].join("\n");

  const run = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(
    run.status,
    0,
    `python ACS wrapper contract check failed\n\nstdout:\n${run.stdout ?? ""}\n\nstderr:\n${run.stderr ?? ""}`
  );

  const calls = JSON.parse(String(run.stdout ?? "[]"));
  assert.equal(calls.length, 35);
  assert.deepEqual(
    calls.map((entry) => [entry.method, entry.path]),
    [
      ["POST", "/agent-cards"],
      ["GET", "/agent-cards/discover?capability=capability%3A%2F%2Fcode&includeRoutingFactors=true&requesterAgentId=agt_buyer"],
      ["GET", "/public/agent-cards/discover?capability=capability%3A%2F%2Ftravel&includeReputation=false&limit=3"],
      ["POST", "/delegation-grants"],
      ["GET", "/delegation-grants/dg_1"],
      ["POST", "/delegation-grants/dg_1/revoke"],
      ["POST", "/authority-grants"],
      ["GET", "/authority-grants/ag_1"],
      ["POST", "/authority-grants/ag_1/revoke"],
      ["POST", "/task-quotes"],
      ["GET", "/task-quotes?quoteId=q_1&requiredCapability=capability%3A%2F%2Fcode&limit=5"],
      ["GET", "/task-quotes/q_1"],
      ["POST", "/task-offers"],
      ["GET", "/task-offers?offerId=o_1&quoteId=q_1&limit=5"],
      ["GET", "/task-offers/o_1"],
      ["POST", "/task-acceptances"],
      ["GET", "/task-acceptances?acceptanceId=a_1&quoteId=q_1&offerId=o_1"],
      ["GET", "/task-acceptances/a_1"],
      ["POST", "/work-orders"],
      ["GET", "/work-orders?workOrderId=wo_1&status=created"],
      ["POST", "/work-orders/wo_1/accept"],
      ["POST", "/work-orders/wo_1/progress"],
      ["POST", "/work-orders/wo_1/complete"],
      ["POST", "/work-orders/wo_1/settle"],
      ["GET", "/work-orders/receipts?workOrderId=wo_1"],
      ["GET", "/work-orders/receipts/rcpt_1"],
      ["POST", "/sessions"],
      ["POST", "/sessions/sess_1/events"],
      ["GET", "/sessions/sess_1/events?eventType=message&limit=10&offset=0&sinceEventId=evt_prev_1"],
      ["GET", "/sessions/sess_1/replay-pack?sign=true&signerKeyId=key_py_1"],
      ["GET", "/sessions/sess_1/transcript?sign=true"],
      ["POST", "/capability-attestations"],
      ["GET", "/capability-attestations?subjectAgentId=agt_worker&capability=capability%3A%2F%2Fcode"],
      ["GET", "/capability-attestations/catt_1"],
      ["POST", "/capability-attestations/catt_1/revoke"]
    ]
  );
  assert.equal(calls[27].expectedPrevChainHash, "0".repeat(64));
});
