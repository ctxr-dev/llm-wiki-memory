import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gateRefusal } from "../mcp-server/mcp-write-dispatch.mjs";
import { __setSettingsForTest, __clearSettingsForTest } from "../scripts/lib/settings.mjs";

function payload(resp) {
  return JSON.parse(resp.content[0].text);
}

afterEach(() => __clearSettingsForTest());

test("gateRefusal FAILS CLOSED: an unresolvable target refuses even an ungated category", () => {
  __setSettingsForTest({ gate: { selfImprovementEnabled: true } });
  // No active wiki context + a bogus target → parseTarget throws → the resolved
  // layout is null → gated=true → refused, even for `knowledge` (ungated by
  // default). A resolve error must never fail OPEN (let the write proceed).
  const refusal = gateRefusal({
    tool: "save_to_dataset",
    dataset: "knowledge",
    name: "x.md",
    metadata: {},
    userRequested: undefined,
    refuseLabel: "save_to_dataset",
    env: undefined,
    target: "definitely-not-a-real-target",
  });
  assert.ok(refusal, "a resolve failure must refuse (fail-closed), not proceed");
  assert.equal(payload(refusal).error, "write-gate-refused");
});

test("gateRefusal: consent (userRequested:true) proceeds even on the fail-closed path", () => {
  __setSettingsForTest({ gate: { selfImprovementEnabled: true } });
  const refusal = gateRefusal({
    tool: "save_to_dataset",
    dataset: "knowledge",
    name: "x.md",
    metadata: {},
    userRequested: true,
    refuseLabel: "save_to_dataset",
    env: undefined,
    target: "definitely-not-a-real-target",
  });
  assert.equal(
    refusal,
    null,
    "explicit consent clears the gate; a later parse step handles the bad target",
  );
});

test("gateRefusal: the whole gate is disabled by gate.selfImprovementEnabled=false", () => {
  __setSettingsForTest({ gate: { selfImprovementEnabled: false } });
  const refusal = gateRefusal({
    tool: "save_lesson",
    dataset: "self_improvement",
    name: "x",
    metadata: {},
    userRequested: undefined,
    refuseLabel: "save_lesson",
    env: undefined,
    target: "definitely-not-a-real-target",
  });
  assert.equal(refusal, null, "operator escape hatch disables the L3 gate");
});
