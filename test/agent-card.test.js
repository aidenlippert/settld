import test from "node:test";
import assert from "node:assert/strict";

import { buildSettldAgentCard } from "../src/core/agent-card.js";

test("agent card builder emits stable, minimal discovery payload", () => {
  const card = buildSettldAgentCard({ baseUrl: "https://api.settld.example", version: "0.0.0-test" });
  assert.equal(card.url, "https://api.settld.example");
  assert.equal(card.version, "0.0.0-test");
  assert.equal(typeof card.name, "string");
  assert.ok(Array.isArray(card.skills));
  assert.ok(card.skills.some((s) => s && s.id === "create_agreement"));
  assert.ok(card.capabilities && card.capabilities.settlement);
});

