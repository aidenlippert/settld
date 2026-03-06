import test from 'node:test';
import assert from 'node:assert/strict';

import { assertModuleImplemented } from './module-scaffold-helpers.js';
import {
  createDeterministicRng,
  runDeterministicSimulationV1,
  validateSimulationReportV1
} from '../../src/agentverse/simulation/index.js';

test('agentverse simulation module implemented', async () => {
  await assertModuleImplemented('simulation', ['index.js', 'runner.js']);
});

test('deterministic simulation report validates', async () => {
  const rng1 = createDeterministicRng(42);
  const rng2 = createDeterministicRng(42);
  assert.equal(rng1.nextUInt32(), rng2.nextUInt32());

  const report = await runDeterministicSimulationV1({
    seed: 42,
    steps: 3,
    initialState: { count: 0 },
    transition: ({ state }) => ({ count: Number(state.count ?? 0) + 1 }),
    startedAt: '2026-03-02T00:00:00.000Z',
    stepAt: (i) => `2026-03-02T00:00:0${i}.000Z`
  });
  assert.equal(validateSimulationReportV1(report), true);
});
