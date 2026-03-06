import {
  assertPlainObject,
  canonicalHash,
  canonicalize,
  normalizeIsoDateTime,
  normalizeSafeInt
} from '../protocol/utils.js';

export const AGENTVERSE_SIMULATION_REPORT_SCHEMA_VERSION = 'AgentverseSimulationReport.v1';

function normalizeSeed(seed) {
  const normalized = normalizeSafeInt(seed, 'seed', { min: 0, max: 0xffffffff });
  return normalized >>> 0;
}

export function createDeterministicRng(seed = 1) {
  let state = normalizeSeed(seed) || 1;
  return {
    nextUInt32() {
      // Xorshift32 keeps simulation deterministic with small, portable logic.
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    },
    nextFloat() {
      return this.nextUInt32() / 0x100000000;
    },
    nextInt(min, max) {
      const normalizedMin = normalizeSafeInt(min, 'min', { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
      const normalizedMax = normalizeSafeInt(max, 'max', { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
      if (normalizedMax < normalizedMin) throw new TypeError('max must be >= min');
      if (normalizedMax === normalizedMin) return normalizedMin;
      const span = normalizedMax - normalizedMin + 1;
      return normalizedMin + Math.floor(this.nextFloat() * span);
    },
    state() {
      return state >>> 0;
    }
  };
}

export function computeSimulationReportHashV1(reportCore) {
  assertPlainObject(reportCore, 'reportCore');
  const copy = { ...reportCore };
  delete copy.reportHash;
  return canonicalHash(copy, { path: '$.simulationReport' });
}

export async function runDeterministicSimulationV1({
  seed = 1,
  steps = 1,
  initialState = {},
  transition,
  startedAt,
  stepAt = null
} = {}) {
  if (!startedAt) throw new TypeError('startedAt is required to keep simulation runs deterministic');
  if (typeof transition !== 'function') throw new TypeError('transition must be a function');

  const normalizedSteps = normalizeSafeInt(steps, 'steps', { min: 1, max: 100000 });
  const rng = createDeterministicRng(seed);
  const timeline = [];
  let state = canonicalize(initialState ?? {}, { path: '$.state0' });

  for (let index = 0; index < normalizedSteps; index += 1) {
    const transitionInput = canonicalize(
      {
        index,
        seedState: rng.state(),
        state
      },
      { path: `$.step[${index}].input` }
    );

    const update = await transition({
      index,
      rng,
      state: transitionInput.state
    });

    const normalizedUpdate = canonicalize(update ?? {}, { path: `$.step[${index}].update` });
    state = canonicalize({ ...state, ...normalizedUpdate }, { path: `$.step[${index}].state` });

    timeline.push(
      canonicalize(
        {
          index,
          at: normalizeIsoDateTime(stepAt ? stepAt(index) : startedAt, `stepAt[${index}]`),
          seedState: transitionInput.seedState,
          update: normalizedUpdate,
          state
        },
        { path: `$.timeline[${index}]` }
      )
    );
  }

  const reportCore = canonicalize(
    {
      schemaVersion: AGENTVERSE_SIMULATION_REPORT_SCHEMA_VERSION,
      seed: normalizeSeed(seed),
      startedAt: normalizeIsoDateTime(startedAt, 'startedAt'),
      completedAt: normalizeIsoDateTime(timeline.length ? timeline[timeline.length - 1].at : startedAt, 'completedAt'),
      steps: normalizedSteps,
      finalSeedState: rng.state(),
      initialState: canonicalize(initialState ?? {}, { path: '$.initialState' }),
      finalState: state,
      timeline
    },
    { path: '$.simulationReport' }
  );

  const reportHash = computeSimulationReportHashV1(reportCore);
  return canonicalize({ ...reportCore, reportHash }, { path: '$.simulationReport' });
}

export function validateSimulationReportV1(report) {
  assertPlainObject(report, 'report');
  if (report.schemaVersion !== AGENTVERSE_SIMULATION_REPORT_SCHEMA_VERSION) {
    throw new TypeError(`report.schemaVersion must be ${AGENTVERSE_SIMULATION_REPORT_SCHEMA_VERSION}`);
  }
  normalizeSeed(report.seed);
  normalizeIsoDateTime(report.startedAt, 'report.startedAt');
  normalizeIsoDateTime(report.completedAt, 'report.completedAt');
  normalizeSafeInt(report.steps, 'report.steps', { min: 1, max: 100000 });
  normalizeSeed(report.finalSeedState);
  canonicalize(report.initialState ?? {}, { path: '$.initialState' });
  canonicalize(report.finalState ?? {}, { path: '$.finalState' });
  if (!Array.isArray(report.timeline)) throw new TypeError('report.timeline must be an array');
  for (let i = 0; i < report.timeline.length; i += 1) {
    const step = report.timeline[i];
    assertPlainObject(step, `report.timeline[${i}]`);
    normalizeSafeInt(step.index, `report.timeline[${i}].index`, { min: 0, max: 100000 });
    normalizeIsoDateTime(step.at, `report.timeline[${i}].at`);
    normalizeSeed(step.seedState);
  }
  const expectedHash = computeSimulationReportHashV1(report);
  if (report.reportHash !== expectedHash) throw new TypeError('reportHash mismatch');
  return true;
}
