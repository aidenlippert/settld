import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import { runCli } from '../../src/agentverse/cli/commands.js';

test('runCli prints usage for no args', async () => {
  const code = await runCli([]);
  assert.equal(code, 0);
});

test('runCli agent init scaffolds project', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'nooterra-cli-'));
  const dir = path.join(base, 'my-agent');

  const code = await runCli(['agent', 'init', 'My Agent', '--dir', dir, '--capability', 'code_review']);
  assert.equal(code, 0);

  assert.equal(existsSync(path.join(dir, 'agent.js')), true);
  assert.equal(existsSync(path.join(dir, 'policy.yaml')), true);
  assert.equal(existsSync(path.join(dir, 'nooterra.json')), true);

  const cfg = JSON.parse(readFileSync(path.join(dir, 'nooterra.json'), 'utf8'));
  assert.equal(cfg.schemaVersion, 'NooterraAgentProject.v1');
});

test('runCli agent upgrade sends SIGHUP to daemon pid', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'nooterra-cli-upgrade-'));
  const pidFile = path.join(base, '.nooterra', 'agent.pid');
  await mkdir(path.dirname(pidFile), { recursive: true });
  await writeFile(pidFile, JSON.stringify({ pid: 424242 }, null, 2), 'utf8');

  const originalKill = process.kill;
  const calls = [];
  process.kill = ((pid, signal) => {
    calls.push({ pid, signal });
    return true;
  });

  try {
    const code = await runCli(['agent', 'upgrade', '--pid-file', pidFile]);
    assert.equal(code, 0);
    assert.deepEqual(calls, [{ pid: 424242, signal: 'SIGHUP' }]);
  } finally {
    process.kill = originalKill;
  }
});

test('runCli agent decommission calls lifecycle API and stops daemon', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'nooterra-cli-decom-'));
  const pidFile = path.join(base, '.nooterra', 'agent.pid');
  await mkdir(path.dirname(pidFile), { recursive: true });
  await writeFile(pidFile, JSON.stringify({ pid: 31337 }, null, 2), 'utf8');

  const originalFetch = globalThis.fetch;
  const originalKill = process.kill;
  const fetchCalls = [];
  const killCalls = [];

  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null
    });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          agentId: 'agt_demo',
          lifecycle: { status: 'decommissioned' },
          changed: true
        });
      }
    };
  };
  process.kill = ((pid, signal) => {
    killCalls.push({ pid, signal });
    return true;
  });

  try {
    const code = await runCli([
      'agent',
      'decommission',
      '--agent-id',
      'agt_demo',
      '--base-url',
      'http://127.0.0.1:3000',
      '--protocol',
      '1.0',
      '--pid-file',
      pidFile
    ]);
    assert.equal(code, 0);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'http://127.0.0.1:3000/x402/gate/agents/agt_demo/lifecycle');
    assert.equal(fetchCalls[0].method, 'POST');
    assert.equal(fetchCalls[0].body.status, 'decommissioned');
    assert.deepEqual(killCalls, [{ pid: 31337, signal: 'SIGTERM' }]);
  } finally {
    globalThis.fetch = originalFetch;
    process.kill = originalKill;
  }
});

test('runCli agent status forwards ops token header', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];

  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({
      url: String(url),
      method: options.method ?? 'GET',
      headers: { ...(options.headers ?? {}) }
    });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ workOrders: [] });
      }
    };
  };

  try {
    const code = await runCli([
      'agent',
      'status',
      '--agent-id',
      'agt_demo',
      '--base-url',
      'http://127.0.0.1:3000',
      '--protocol',
      '1.0',
      '--ops-token',
      'tok_ops_demo'
    ]);
    assert.equal(code, 0);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].method, 'GET');
    assert.equal(fetchCalls[0].headers['x-proxy-ops-token'], 'tok_ops_demo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
