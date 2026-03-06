import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENTVERSE_AGENT_HEALTH_VERDICT,
  AGENTVERSE_REGISTRY_STATUS,
  AgentHealthMonitor,
  AgentLifecycleManager,
  AgentRegistry,
  CapabilityCatalog,
  DiscoveryService
} from '../../src/agentverse/index.js';

function createClock(startIso = '2026-03-02T00:00:00.000Z') {
  let currentMs = Date.parse(startIso);
  return {
    now() {
      return new Date(currentMs).toISOString();
    },
    advanceSeconds(seconds) {
      currentMs += Number(seconds) * 1000;
      return new Date(currentMs).toISOString();
    }
  };
}

test('registry section: provision -> activate -> advertise -> resolve capability', () => {
  const clock = createClock();
  const registry = new AgentRegistry({ now: clock.now, defaultHeartbeatTtlSec: 30 });
  const catalog = new CapabilityCatalog({ now: clock.now });
  const health = new AgentHealthMonitor({ registry, now: clock.now });
  const lifecycle = new AgentLifecycleManager({ registry, now: clock.now });
  const discovery = new DiscoveryService({
    registry,
    capabilityCatalog: catalog,
    healthMonitor: health,
    now: clock.now
  });

  lifecycle.provisionAgent({
    at: clock.now(),
    agentId: 'agt_reviewer',
    displayName: 'Reviewer Agent',
    endpoint: 'https://reviewer.example/agent',
    capabilities: ['code_review', 'security_audit'],
    version: '1.2.0'
  });
  lifecycle.activate('agt_reviewer', {
    at: clock.now(),
    reasonCode: 'AGENT_READY'
  });

  discovery.advertiseAgentCapabilities({
    agentId: 'agt_reviewer',
    category: 'engineering',
    updatedAt: clock.now(),
    tags: ['prod']
  });

  const resolved = discovery.resolveOne({
    capabilityId: 'code_review',
    asOf: clock.now()
  });

  assert.equal(resolved.selected.ok, true);
  assert.equal(resolved.selected.selected.agentId, 'agt_reviewer');
  assert.equal(resolved.totalCandidates, 1);
});

test('registry section: stale heartbeats are marked offline and excluded from discovery', () => {
  const clock = createClock();
  const registry = new AgentRegistry({ now: clock.now, defaultHeartbeatTtlSec: 10 });
  const catalog = new CapabilityCatalog({ now: clock.now });
  const health = new AgentHealthMonitor({ registry, now: clock.now });
  const lifecycle = new AgentLifecycleManager({ registry, now: clock.now });
  const discovery = new DiscoveryService({
    registry,
    capabilityCatalog: catalog,
    healthMonitor: health,
    now: clock.now
  });

  lifecycle.provisionAgent({
    at: clock.now(),
    agentId: 'agt_summarizer',
    displayName: 'Summarizer Agent',
    endpoint: 'https://summary.example/agent',
    capabilities: ['summarize_text']
  });
  lifecycle.activate('agt_summarizer', { at: clock.now() });
  discovery.advertiseAgentCapabilities({
    agentId: 'agt_summarizer',
    category: 'nlp',
    updatedAt: clock.now()
  });

  registry.heartbeat('agt_summarizer', { at: clock.now() });
  clock.advanceSeconds(11);

  const staleRows = health.listStale({ asOf: clock.now() });
  assert.equal(staleRows.length, 1);
  assert.equal(staleRows[0].health, AGENTVERSE_AGENT_HEALTH_VERDICT.STALE);

  const enforcement = health.enforceOfflineForStale({ asOf: clock.now() });
  assert.deepEqual(enforcement.updatedAgentIds, ['agt_summarizer']);
  assert.equal(registry.getAgent('agt_summarizer').status, AGENTVERSE_REGISTRY_STATUS.OFFLINE);

  const discovered = discovery.discover({
    capabilityId: 'summarize_text',
    asOf: clock.now()
  });
  assert.equal(discovered.totalCandidates, 0);
});

test('registry section: lifecycle manager fails closed on invalid transitions', () => {
  const clock = createClock();
  const registry = new AgentRegistry({ now: clock.now });
  const lifecycle = new AgentLifecycleManager({ registry, now: clock.now });

  lifecycle.provisionAgent({
    at: clock.now(),
    agentId: 'agt_planner',
    displayName: 'Planner Agent',
    endpoint: 'https://planner.example/agent',
    capabilities: ['project_plan']
  });

  assert.throws(
    () => lifecycle.throttle('agt_planner', { at: clock.now() }),
    (err) => err && err.code === 'AGENTVERSE_REGISTRY_LIFECYCLE_TRANSITION_DENIED'
  );

  lifecycle.activate('agt_planner', { at: clock.now() });
  const throttled = lifecycle.throttle('agt_planner', {
    at: clock.now(),
    reasonCode: 'RATE_LIMIT',
    reasonMessage: 'too many delegated jobs'
  });
  assert.equal(throttled.agent.status, AGENTVERSE_REGISTRY_STATUS.THROTTLED);
});

test('registry section: capability catalog retires entries and matching is deterministic', () => {
  const clock = createClock();
  const catalog = new CapabilityCatalog({ now: clock.now });

  catalog.upsertEntry({
    capabilityId: 'code_review',
    providerAgentId: 'agt_alpha',
    version: '1.0.0',
    category: 'engineering',
    updatedAt: clock.now()
  });
  catalog.upsertEntry({
    capabilityId: 'code_review',
    providerAgentId: 'agt_beta',
    version: '1.0.0',
    category: 'engineering',
    updatedAt: clock.now()
  });
  catalog.retireEntry({
    capabilityId: 'code_review',
    providerAgentId: 'agt_beta',
    version: '1.0.0',
    updatedAt: clock.now()
  });

  const activeEntries = catalog.listEntries({ capabilityId: 'code_review' });
  assert.equal(activeEntries.length, 1);
  assert.equal(activeEntries[0].providerAgentId, 'agt_alpha');

  const match = catalog.matchRequiredCapabilities({
    capabilityIds: ['code_review', 'security_audit']
  });
  assert.deepEqual(match.capabilityIds, ['code_review', 'security_audit']);
  assert.deepEqual(match.missing, ['security_audit']);
});
