import {
  canonicalHash,
  canonicalize,
  normalizeEnum,
  normalizeId,
  normalizeIsoDateTime,
  normalizeOptionalString,
  normalizeSha256Hex
} from '../protocol/utils.js';
import {
  AGENTVERSE_REGISTRY_AGENT_SCHEMA_VERSION,
  AGENTVERSE_REGISTRY_STATUS,
  AgentRegistry,
  validateRegistryAgentV1
} from './agent-registry.js';

export const AGENTVERSE_LIFECYCLE_TRANSITION_SCHEMA_VERSION = 'AgentverseLifecycleTransition.v1';

export const AGENTVERSE_LIFECYCLE_ALLOWED_TRANSITIONS = Object.freeze({
  [AGENTVERSE_REGISTRY_STATUS.PROVISIONED]: [
    AGENTVERSE_REGISTRY_STATUS.ACTIVE,
    AGENTVERSE_REGISTRY_STATUS.PAUSED,
    AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED
  ],
  [AGENTVERSE_REGISTRY_STATUS.ACTIVE]: [
    AGENTVERSE_REGISTRY_STATUS.PAUSED,
    AGENTVERSE_REGISTRY_STATUS.THROTTLED,
    AGENTVERSE_REGISTRY_STATUS.OFFLINE,
    AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED
  ],
  [AGENTVERSE_REGISTRY_STATUS.PAUSED]: [
    AGENTVERSE_REGISTRY_STATUS.ACTIVE,
    AGENTVERSE_REGISTRY_STATUS.THROTTLED,
    AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED
  ],
  [AGENTVERSE_REGISTRY_STATUS.THROTTLED]: [
    AGENTVERSE_REGISTRY_STATUS.ACTIVE,
    AGENTVERSE_REGISTRY_STATUS.PAUSED,
    AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED
  ],
  [AGENTVERSE_REGISTRY_STATUS.OFFLINE]: [
    AGENTVERSE_REGISTRY_STATUS.ACTIVE,
    AGENTVERSE_REGISTRY_STATUS.PAUSED,
    AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED
  ],
  [AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED]: []
});

function normalizeStatus(value, name = 'status') {
  return normalizeEnum(value, name, Object.values(AGENTVERSE_REGISTRY_STATUS));
}

export function isLifecycleTransitionAllowedV1({ fromStatus, toStatus } = {}) {
  const from = normalizeStatus(fromStatus, 'fromStatus');
  const to = normalizeStatus(toStatus, 'toStatus');
  const allowed = AGENTVERSE_LIFECYCLE_ALLOWED_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

export function computeLifecycleTransitionHashV1(transitionCore) {
  const copy = { ...transitionCore };
  delete copy.transitionHash;
  return canonicalHash(copy, { path: '$.lifecycleTransition' });
}

export function buildLifecycleTransitionV1({
  agentId,
  fromStatus,
  toStatus,
  at,
  reasonCode = null,
  reasonMessage = null,
  actorId = null
} = {}) {
  if (!at) throw new TypeError('at is required to keep lifecycle transitions deterministic');
  const core = canonicalize(
    {
      schemaVersion: AGENTVERSE_LIFECYCLE_TRANSITION_SCHEMA_VERSION,
      agentId: normalizeId(agentId, 'agentId', { min: 3, max: 200 }),
      fromStatus: normalizeStatus(fromStatus, 'fromStatus'),
      toStatus: normalizeStatus(toStatus, 'toStatus'),
      at: normalizeIsoDateTime(at, 'at'),
      reasonCode: normalizeOptionalString(reasonCode, 'reasonCode', { max: 128 }),
      reasonMessage: normalizeOptionalString(reasonMessage, 'reasonMessage', { max: 512 }),
      actorId: normalizeOptionalString(actorId, 'actorId', { max: 200 })
    },
    { path: '$.lifecycleTransition' }
  );
  const transitionHash = computeLifecycleTransitionHashV1(core);
  return canonicalize({ ...core, transitionHash }, { path: '$.lifecycleTransition' });
}

export function validateLifecycleTransitionV1(transition) {
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
    throw new TypeError('transition must be an object');
  }
  if (transition.schemaVersion !== AGENTVERSE_LIFECYCLE_TRANSITION_SCHEMA_VERSION) {
    throw new TypeError(`transition.schemaVersion must be ${AGENTVERSE_LIFECYCLE_TRANSITION_SCHEMA_VERSION}`);
  }
  normalizeId(transition.agentId, 'transition.agentId', { min: 3, max: 200 });
  normalizeStatus(transition.fromStatus, 'transition.fromStatus');
  normalizeStatus(transition.toStatus, 'transition.toStatus');
  normalizeIsoDateTime(transition.at, 'transition.at');
  normalizeOptionalString(transition.reasonCode, 'transition.reasonCode', { max: 128 });
  normalizeOptionalString(transition.reasonMessage, 'transition.reasonMessage', { max: 512 });
  normalizeOptionalString(transition.actorId, 'transition.actorId', { max: 200 });
  normalizeSha256Hex(transition.transitionHash, 'transition.transitionHash');
  const expectedHash = computeLifecycleTransitionHashV1(transition);
  if (expectedHash !== transition.transitionHash) throw new TypeError('transitionHash mismatch');
  return true;
}

export class AgentLifecycleManager {
  constructor({
    registry,
    now = () => new Date().toISOString()
  } = {}) {
    if (!(registry instanceof AgentRegistry)) throw new TypeError('registry must be an AgentRegistry');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.registry = registry;
    this.now = now;
    this._transitions = [];
  }

  listTransitions({ agentId = null } = {}) {
    const normalizedAgentId = agentId === null || agentId === undefined
      ? null
      : normalizeId(agentId, 'agentId', { min: 3, max: 200 });
    const out = normalizedAgentId
      ? this._transitions.filter((row) => row.agentId === normalizedAgentId)
      : this._transitions;
    return out.map((row) => canonicalize(row, { path: '$.lifecycleTransition' }));
  }

  transition(agentId, {
    toStatus,
    at = this.now(),
    reasonCode = null,
    reasonMessage = null,
    actorId = null
  } = {}) {
    const current = this.registry.getAgent(agentId);
    if (!current) {
      const err = new Error(`agent not found: ${agentId}`);
      err.code = 'AGENTVERSE_REGISTRY_AGENT_NOT_FOUND';
      throw err;
    }
    validateRegistryAgentV1(current);
    if (current.schemaVersion !== AGENTVERSE_REGISTRY_AGENT_SCHEMA_VERSION) {
      throw new TypeError(`agent.schemaVersion must be ${AGENTVERSE_REGISTRY_AGENT_SCHEMA_VERSION}`);
    }
    const normalizedToStatus = normalizeStatus(toStatus, 'toStatus');
    const allowed = isLifecycleTransitionAllowedV1({
      fromStatus: current.status,
      toStatus: normalizedToStatus
    });
    if (!allowed) {
      const err = new Error(`lifecycle transition denied: ${current.status} -> ${normalizedToStatus}`);
      err.code = 'AGENTVERSE_REGISTRY_LIFECYCLE_TRANSITION_DENIED';
      throw err;
    }

    const transition = buildLifecycleTransitionV1({
      agentId: current.agentId,
      fromStatus: current.status,
      toStatus: normalizedToStatus,
      at,
      reasonCode,
      reasonMessage,
      actorId
    });
    validateLifecycleTransitionV1(transition);

    const updated = this.registry.setStatus(current.agentId, {
      status: normalizedToStatus,
      at: transition.at,
      reasonCode: transition.reasonCode
    });
    this._transitions.push(transition);
    this._transitions.sort((left, right) => String(left.transitionHash).localeCompare(String(right.transitionHash)));
    return {
      transition,
      agent: updated
    };
  }

  provisionAgent({ at = this.now(), ...agent }) {
    return this.registry.registerAgent({
      ...agent,
      status: AGENTVERSE_REGISTRY_STATUS.PROVISIONED,
      registeredAt: at
    });
  }

  activate(agentId, options = {}) {
    return this.transition(agentId, {
      ...options,
      toStatus: AGENTVERSE_REGISTRY_STATUS.ACTIVE
    });
  }

  pause(agentId, options = {}) {
    return this.transition(agentId, {
      ...options,
      toStatus: AGENTVERSE_REGISTRY_STATUS.PAUSED
    });
  }

  throttle(agentId, options = {}) {
    return this.transition(agentId, {
      ...options,
      toStatus: AGENTVERSE_REGISTRY_STATUS.THROTTLED
    });
  }

  decommission(agentId, options = {}) {
    return this.transition(agentId, {
      ...options,
      toStatus: AGENTVERSE_REGISTRY_STATUS.DECOMMISSIONED
    });
  }
}
