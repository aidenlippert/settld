import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../agent.js');

test('agent module exports handler and capabilities', () => {
  assert.ok(mod.default);
  assert.equal(typeof mod.default.handle, 'function');
  assert.ok(Array.isArray(mod.default.capabilities));
  assert.ok(mod.default.capabilities.length > 0);
});
