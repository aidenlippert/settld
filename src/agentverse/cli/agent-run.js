import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { AgentDaemon } from '../runtime/agent-daemon.js';

export async function loadProjectConfig(projectDir = process.cwd()) {
  const configPath = path.join(projectDir, 'nooterra.json');
  const raw = await readFile(configPath, 'utf8');
  return JSON.parse(raw);
}

export async function runAgentDaemon({
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
  pidFile = null,
  cwd = process.cwd()
}) {
  const daemon = new AgentDaemon({
    agentId,
    baseUrl,
    protocol,
    tenantId,
    apiKey,
    opsToken,
    bearerToken,
    pollMs,
    log: console
  });

  const handlerFile = file ? path.resolve(cwd, file) : path.resolve(cwd, 'agent.js');
  await daemon.loadHandlerModule(handlerFile);

  const resolvedPolicyPath = policyPath ? path.resolve(cwd, policyPath) : null;
  if (resolvedPolicyPath) {
    await daemon.loadPolicyFile(resolvedPolicyPath);
  }

  const resolvedPidFile = pidFile ? path.resolve(cwd, pidFile) : null;
  if (resolvedPidFile) {
    await mkdir(path.dirname(resolvedPidFile), { recursive: true });
    await writeFile(
      resolvedPidFile,
      `${JSON.stringify(
        {
          pid: process.pid,
          agentId,
          startedAt: new Date().toISOString(),
          handlerFile,
          policyPath: resolvedPolicyPath
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  }

  const shutdown = async (signal = 'unknown') => {
    if (shutdown._running) return;
    shutdown._running = true;
    daemon.log.info(`[agentverse] received ${signal}, shutting down`);
    await daemon.stop();
    if (resolvedPidFile) {
      await rm(resolvedPidFile, { force: true });
    }
  };

  const reload = async () => {
    try {
      await daemon.reload();
    } catch (err) {
      daemon.log.error(`[agentverse] reload failed: ${err.message}`);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGHUP', () => {
    void reload();
  });

  await daemon.start();

  return daemon;
}

export async function waitForDaemonExit(daemon) {
  if (!daemon || typeof daemon.waitForStop !== 'function') return;
  await daemon.waitForStop();
}
