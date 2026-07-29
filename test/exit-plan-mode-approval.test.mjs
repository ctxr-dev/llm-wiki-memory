import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planApproved,
  describeToolResponse,
  planDocSpec,
} from "../scripts/hooks/exit-plan-mode-spec.mjs";

// The EXACT strings Claude Code puts in the ExitPlanMode tool result, copied from a
// real transcript. The hook originally required a structured `{approved:true}`, which
// none of these carry — so every approved plan was silently skipped and lost. Keep
// these verbatim: they are the contract with the host, not our own wording.
const REAL_APPROVAL =
  "User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: /Users/developer/.claude/plans/some-plan.md";
const REAL_REJECTION =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user may have left a message.";

const PLAN = "# A plan\n\n- [ ] first step\n- [ ] second step";

test("the real Claude Code approval string counts as approved", () => {
  assert.equal(planApproved(REAL_APPROVAL), true);
});

test("the real Claude Code rejection string does NOT count as approved", () => {
  assert.equal(planApproved(REAL_REJECTION), false);
});

test("a rejection is decisive even though it mentions the plan", () => {
  assert.equal(planApproved(`${REAL_REJECTION}\nUser has approved your plan`), false);
});

test("the legacy structured flag still works in both directions", () => {
  assert.equal(planApproved({ approved: true }), true);
  assert.equal(planApproved({ approved: false }), false);
});

test("wrapped response shapes are accepted (content string, content blocks, array)", () => {
  assert.equal(planApproved({ content: REAL_APPROVAL }), true);
  assert.equal(planApproved({ content: [{ type: "text", text: REAL_APPROVAL }] }), true);
  assert.equal(planApproved([{ type: "text", text: REAL_APPROVAL }]), true);
  assert.equal(planApproved({ content: REAL_REJECTION }), false);
});

test("absent, null, empty and unrelated responses are not approvals", () => {
  for (const v of [undefined, null, "", {}, [], "some unrelated text", 42, true]) {
    assert.equal(planApproved(v), false, `${JSON.stringify(v)} must not approve`);
  }
});

test("planDocSpec builds a spec from the real approval string", () => {
  const spec = planDocSpec({ tool_input: { plan: PLAN }, tool_response: REAL_APPROVAL });
  assert.equal(spec.skip, undefined, `expected a spec, got skip=${spec.skip}`);
  assert.match(spec.name, /\.plan\.md$/);
  assert.equal(spec.datasetSlot, "plans");
  assert.ok(spec.text.includes("first step"));
});

test("planDocSpec skips on the real rejection string", () => {
  const spec = planDocSpec({ tool_input: { plan: PLAN }, tool_response: REAL_REJECTION });
  assert.equal(spec.skip, "not-approved");
});

test("describeToolResponse reports the shape without leaking the body", () => {
  assert.equal(describeToolResponse(undefined), "tool_response absent");
  assert.equal(describeToolResponse(null), "tool_response null");
  assert.match(describeToolResponse(REAL_APPROVAL), /^string\(\d+\)/);
  assert.equal(describeToolResponse({ approved: true }), "object keys=[approved]");
  assert.equal(describeToolResponse([1, 2]), "array(2)");
  const described = describeToolResponse(`secret plan body ${"x".repeat(500)}`);
  assert.ok(described.length < 120, "truncates so the log stays small");
});
