import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scaffoldAgentProject } from '../scaffold/init.js';
import { runAgentDaemon, waitForDaemonExit } from './agent-run.js';
import { streamSessionEvents } from './observe.js';

function printUsage() {
  process.stderr.write(
    [
      'usage:',
      '  agentverse agent init <name> [--capability <cap>] [--description <text>] [--dir <path>] [--force]',
      '  agentverse agent run [--file <agent.js>] [--policy <policy.yaml>] [--agent-id <id>] [--base-url <url>] [--tenant-id <id>] [--protocol <v>] [--poll-ms <n>]',
      '  agentverse agent status --agent-id <id> [--base-url <url>] [--tenant-id <id>] [--protocol <v>] [--x-api-key <key>] [--ops-token <tok>] [--bearer-token <tok>]',
      '  agentverse agent logs --session-id <id> [--base-url <url>] [--tenant-id <id>] [--protocol <v>] [--x-api-key <key>] [--ops-token <tok>] [--max-events <n>] [--timeout-ms <n>]',
      '  agentverse agent upgrade [--pid-file <path>] [--no-reload] [--status <status>] [--agent-id <id>] [--reason-code <code>] [--reason-message <text>] [--base-url <url>] [--tenant-id <id>] [--protocol <v>]',
      '  agentverse agent decommission [--agent-id <id>] [--reason-code <code>] [--reason-message <text>] [--wind-down] [--no-stop] [--pid-file <path>] [--base-url <url>] [--tenant-id <id>] [--protocol <v>]',
      '  agentverse observe session --session-id <id> [--base-url <url>] [--tenant-id <id>] [--protocol <v>] [--max-events <n>] [--timeout-ms <n>]'
    ].join('\n') + '\n'
  );
}

function parseFlag(argv, name, fallback = null) {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  return idx + 1 < argv.length ? argv[idx + 1] : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

async function requestJson(url, { method = 'GET', headers = {}, body = null, idempotencyKey = null } = {}) {
  const reqHeaders = {
    ...headers
  };
  if (body !== null && body !== undefined) {
    if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      reqHeaders['content-type'] = 'application/json';
    }
  }
  if (idempotencyKey) reqHeaders['x-idempotency-key'] = idempotencyKey;

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(json?.error || json?.message || `${method} ${url} failed: ${res.status}`);
  }
  return json;
}

function baseHeaders({ protocol = '1.0', tenantId = null, apiKey = null, opsToken = null, bearerToken = null } = {}) {
  const h = {
    accept: 'application/json',
    'x-nooterra-protocol': protocol
  };
  if (tenantId) h['x-proxy-tenant-id'] = tenantId;
  if (apiKey) h['x-proxy-api-key'] = apiKey;
  if (opsToken) h['x-proxy-ops-token'] = opsToken;
  if (bearerToken) h.authorization = /^bearer\s+/i.test(bearerToken) ? bearerToken : `Bearer ${bearerToken}`;
  return h;
}

async function resolveAgentDefaults(cwd) {
  try {
    const raw = await readFile(path.join(cwd, 'nooterra.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return {
      agentId: cfg?.agentId ?? null,
      baseUrl: cfg?.defaults?.baseUrl ?? null,
      protocol: cfg?.defaults?.protocol ?? null,
      tenantId: cfg?.defaults?.tenantId ?? null,
      policyPath: cfg?.policyPath ?? null,
      entrypoint: cfg?.entrypoint ?? null
    };
  } catch {
    return {
      agentId: null,
      baseUrl: null,
      protocol: null,
      tenantId: null,
      policyPath: null,
      entrypoint: null
    };
  }
}

async function readPidMetadata(pidFilePath) {
  const raw = await readFile(pidFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const pid = Number(parsed?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid pid in ${pidFilePath}`);
  }
  return {
    ...parsed,
    pid
  };
}

function trySignal(pid, signal) {
  process.kill(pid, signal);
}

async function cmdAgentInit(argv) {
  const name = argv[0];
  if (!name) throw new Error('agent init requires <name>');

  const capability = parseFlag(argv, '--capability', 'code_review');
  const description = parseFlag(argv, '--description', 'Nooterra agent');
  const dir = parseFlag(argv, '--dir', null);
  const force = hasFlag(argv, '--force');

  const result = await scaffoldAgentProject({ name, capability, description, dir, force });
  process.stdout.write(`scaffolded: ${result.dir}\n`);
  for (const f of result.files) process.stdout.write(`  - ${f}\n`);
}

async function cmdAgentRun(argv) {
  const defaults = await resolveAgentDefaults(process.cwd());

  const file = parseFlag(argv, '--file', defaults.entrypoint ?? 'agent.js');
  const policyPath = parseFlag(argv, '--policy', defaults.policyPath ?? 'policy.yaml');
  const agentId = parseFlag(argv, '--agent-id', defaults.agentId ?? process.env.NOOTERRA_AGENT_ID ?? null);
  const baseUrl = parseFlag(argv, '--base-url', defaults.baseUrl ?? process.env.NOOTERRA_BASE_URL ?? 'http://127.0.0.1:3000');
  const protocol = parseFlag(argv, '--protocol', defaults.protocol ?? process.env.NOOTERRA_PROTOCOL ?? '1.0');
  const tenantId = parseFlag(argv, '--tenant-id', defaults.tenantId ?? process.env.NOOTERRA_TENANT_ID ?? null);
  const pollMs = Number(parseFlag(argv, '--poll-ms', process.env.NOOTERRA_AGENT_POLL_MS ?? '1500'));
  const pidFile = parseFlag(argv, '--pid-file', process.env.NOOTERRA_AGENT_PID_FILE ?? '.nooterra/agent.pid');
  const apiKey = parseFlag(argv, '--x-api-key', process.env.NOOTERRA_API_KEY ?? null);
  const opsToken = parseFlag(argv, '--ops-token', process.env.NOOTERRA_OPS_TOKEN ?? null);
  const bearerToken = parseFlag(argv, '--bearer-token', process.env.NOOTERRA_BEARER_TOKEN ?? null);

  if (!agentId) {
    throw new Error('agentId required: set --agent-id or nooterra.json.agentId');
  }

  process.stdout.write(`starting daemon for agentId=${agentId} baseUrl=${baseUrl}\n`);
  const daemon = await runAgentDaemon({
    file,
    policyPath,
    agentId,
    baseUrl,
    protocol,
    tenantId,
    apiKey,
    opsToken,
    bearerToken,
    pollMs,
    pidFile
  });
  process.stdout.write(`pidFile: ${path.resolve(pidFile)}\n`);
  await waitForDaemonExit(daemon);
}

async function cmdAgentStatus(argv) {
  const defaults = await resolveAgentDefaults(process.cwd());
  const agentId = parseFlag(argv, '--agent-id', defaults.agentId ?? null);
  if (!agentId) throw new Error('--agent-id is required');

  const baseUrl = parseFlag(argv, '--base-url', defaults.baseUrl ?? 'http://127.0.0.1:3000');
  const protocol = parseFlag(argv, '--protocol', defaults.protocol ?? '1.0');
  const tenantId = parseFlag(argv, '--tenant-id', defaults.tenantId ?? null);
  const apiKey = parseFlag(argv, '--x-api-key', process.env.NOOTERRA_API_KEY ?? null);
  const opsToken = parseFlag(argv, '--ops-token', process.env.NOOTERRA_OPS_TOKEN ?? null);
  const bearerToken = parseFlag(argv, '--bearer-token', process.env.NOOTERRA_BEARER_TOKEN ?? null);

  const headers = baseHeaders({ protocol, tenantId, apiKey, opsToken, bearerToken });

  const workOrderQ = new URLSearchParams({ subAgentId: agentId, limit: '100', offset: '0' });
  const workOrders = await requestJson(`${baseUrl}/work-orders?${workOrderQ.toString()}`, { headers });

  const rows = Array.isArray(workOrders?.workOrders) ? workOrders.workOrders : [];
  const byStatus = rows.reduce((acc, row) => {
    const s = String(row?.status ?? 'unknown');
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  process.stdout.write(`agentId: ${agentId}\n`);
  process.stdout.write(`workOrders.total: ${rows.length}\n`);
  for (const [status, count] of Object.entries(byStatus)) {
    process.stdout.write(`workOrders.${status}: ${count}\n`);
  }
}

async function cmdAgentLogs(argv) {
  const defaults = await resolveAgentDefaults(process.cwd());
  const sessionId = parseFlag(argv, '--session-id', null);
  if (!sessionId) throw new Error('--session-id is required');

  const baseUrl = parseFlag(argv, '--base-url', defaults.baseUrl ?? 'http://127.0.0.1:3000');
  const protocol = parseFlag(argv, '--protocol', defaults.protocol ?? '1.0');
  const tenantId = parseFlag(argv, '--tenant-id', defaults.tenantId ?? null);
  const apiKey = parseFlag(argv, '--x-api-key', process.env.NOOTERRA_API_KEY ?? null);
  const opsToken = parseFlag(argv, '--ops-token', process.env.NOOTERRA_OPS_TOKEN ?? null);
  const maxEvents = Number(parseFlag(argv, '--max-events', '100'));
  const timeoutMs = Number(parseFlag(argv, '--timeout-ms', '30000'));

  await streamSessionEvents({
    baseUrl,
    sessionId,
    protocol,
    tenantId,
    apiKey,
    opsToken,
    maxEvents,
    timeoutMs,
    onEvent: (ev) => {
      process.stdout.write(`${ev.event}: ${JSON.stringify(ev.data)}\n`);
    }
  });
}

async function cmdAgentUpgrade(argv) {
  const defaults = await resolveAgentDefaults(process.cwd());
  const pidFile = parseFlag(argv, '--pid-file', process.env.NOOTERRA_AGENT_PID_FILE ?? '.nooterra/agent.pid');
  const skipReload = hasFlag(argv, '--no-reload');

  const status = parseFlag(argv, '--status', null);
  const reasonCode = parseFlag(argv, '--reason-code', null);
  const reasonMessage = parseFlag(argv, '--reason-message', null);

  if (skipReload && !status) {
    throw new Error('agent upgrade requires either reload (default) or --status');
  }

  if (!skipReload) {
    const pidMeta = await readPidMetadata(path.resolve(pidFile));
    trySignal(pidMeta.pid, 'SIGHUP');
    process.stdout.write(`reloaded daemon pid=${pidMeta.pid} signal=SIGHUP\n`);
  }

  if (status) {
    const agentId = parseFlag(argv, '--agent-id', defaults.agentId ?? process.env.NOOTERRA_AGENT_ID ?? null);
    if (!agentId) throw new Error('--agent-id is required when --status is set');
    const baseUrl = parseFlag(argv, '--base-url', defaults.baseUrl ?? process.env.NOOTERRA_BASE_URL ?? 'http://127.0.0.1:3000');
    const protocol = parseFlag(argv, '--protocol', defaults.protocol ?? process.env.NOOTERRA_PROTOCOL ?? '1.0');
    const tenantId = parseFlag(argv, '--tenant-id', defaults.tenantId ?? process.env.NOOTERRA_TENANT_ID ?? null);
    const apiKey = parseFlag(argv, '--x-api-key', process.env.NOOTERRA_API_KEY ?? null);
    const opsToken = parseFlag(argv, '--ops-token', process.env.NOOTERRA_OPS_TOKEN ?? null);
    const bearerToken = parseFlag(argv, '--bearer-token', process.env.NOOTERRA_BEARER_TOKEN ?? null);

    const headers = baseHeaders({ protocol, tenantId, apiKey, opsToken, bearerToken });
    const lifecycle = await requestJson(`${baseUrl}/x402/gate/agents/${encodeURIComponent(agentId)}/lifecycle`, {
      method: 'POST',
      headers,
      body: {
        status,
        reasonCode,
        reasonMessage
      }
    });
    process.stdout.write(`lifecycle.agentId: ${agentId}\n`);
    process.stdout.write(`lifecycle.status: ${lifecycle?.lifecycle?.status ?? status}\n`);
    process.stdout.write(`lifecycle.changed: ${lifecycle?.changed === true}\n`);
  }
}

async function cmdAgentDecommission(argv) {
  const defaults = await resolveAgentDefaults(process.cwd());
  const agentId = parseFlag(argv, '--agent-id', defaults.agentId ?? process.env.NOOTERRA_AGENT_ID ?? null);
  if (!agentId) throw new Error('--agent-id is required');

  const baseUrl = parseFlag(argv, '--base-url', defaults.baseUrl ?? process.env.NOOTERRA_BASE_URL ?? 'http://127.0.0.1:3000');
  const protocol = parseFlag(argv, '--protocol', defaults.protocol ?? process.env.NOOTERRA_PROTOCOL ?? '1.0');
  const tenantId = parseFlag(argv, '--tenant-id', defaults.tenantId ?? process.env.NOOTERRA_TENANT_ID ?? null);
  const apiKey = parseFlag(argv, '--x-api-key', process.env.NOOTERRA_API_KEY ?? null);
  const opsToken = parseFlag(argv, '--ops-token', process.env.NOOTERRA_OPS_TOKEN ?? null);
  const bearerToken = parseFlag(argv, '--bearer-token', process.env.NOOTERRA_BEARER_TOKEN ?? null);
  const reasonCode = parseFlag(argv, '--reason-code', 'X402_AGENT_DECOMMISSIONED');
  const reasonMessage = parseFlag(argv, '--reason-message', null);
  const windDown = hasFlag(argv, '--wind-down');
  const noStop = hasFlag(argv, '--no-stop');
  const pidFile = parseFlag(argv, '--pid-file', process.env.NOOTERRA_AGENT_PID_FILE ?? '.nooterra/agent.pid');

  const headers = baseHeaders({ protocol, tenantId, apiKey, opsToken, bearerToken });
  const endpoint = windDown
    ? `${baseUrl}/x402/gate/agents/${encodeURIComponent(agentId)}/wind-down`
    : `${baseUrl}/x402/gate/agents/${encodeURIComponent(agentId)}/lifecycle`;
  const body = windDown
    ? {
        reasonCode,
        reasonMessage
      }
    : {
        status: 'decommissioned',
        reasonCode,
        reasonMessage
      };

  const response = await requestJson(endpoint, {
    method: 'POST',
    headers,
    body
  });
  process.stdout.write(`decommission.agentId: ${agentId}\n`);
  process.stdout.write(`decommission.status: ${response?.lifecycle?.status ?? (windDown ? 'frozen' : 'decommissioned')}\n`);
  process.stdout.write(`decommission.changed: ${response?.changed === true}\n`);

  if (!noStop) {
    const pidMeta = await readPidMetadata(path.resolve(pidFile));
    trySignal(pidMeta.pid, 'SIGTERM');
    process.stdout.write(`stopped daemon pid=${pidMeta.pid} signal=SIGTERM\n`);
  }
}

async function cmdObserveSession(argv) {
  await cmdAgentLogs(argv);
}

export async function runCli(argv = process.argv.slice(2)) {
  const [group, cmd, ...rest] = argv;
  if (!group || group === '--help' || group === '-h' || group === 'help') {
    printUsage();
    return 0;
  }

  try {
    if (group === 'agent' && cmd === 'init') {
      await cmdAgentInit(rest);
      return 0;
    }
    if (group === 'agent' && cmd === 'run') {
      await cmdAgentRun(rest);
      return 0;
    }
    if (group === 'agent' && cmd === 'status') {
      await cmdAgentStatus(rest);
      return 0;
    }
    if (group === 'agent' && cmd === 'logs') {
      await cmdAgentLogs(rest);
      return 0;
    }
    if (group === 'agent' && cmd === 'upgrade') {
      await cmdAgentUpgrade(rest);
      return 0;
    }
    if (group === 'agent' && cmd === 'decommission') {
      await cmdAgentDecommission(rest);
      return 0;
    }
    if (group === 'observe' && cmd === 'session') {
      await cmdObserveSession(rest);
      return 0;
    }

    printUsage();
    return 2;
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
}
