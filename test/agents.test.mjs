import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAgents } from "../dist/agents.js";

test("all five free-edition adapters are registered", () => {
  const agents = detectAgents();
  assert.deepEqual(agents.map((agent) => agent.id), ["claude", "codex", "cursor", "antigravity", "grok"]);
  for (const agent of agents) {
    assert.ok(agent.name);
    assert.ok(agent.installUrl.startsWith("https://"));
    assert.equal(agent.detected, agent.command !== null);
    assert.ok(agent.roomCommand.length > 0);
  }
});
