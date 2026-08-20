import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __resetMockCallIndex } from "../scripts/lib/llm-parse.mjs";
import { __setSettingsForTest, __clearSettingsForTest } from "../scripts/lib/settings.mjs";
import { judgeInteractiveSubmission } from "../mcp-server/mcp-judge-gate.mjs";

const PASS = JSON.stringify({ pass: true, score: 0.9, checks: {}, recommendation: "" });
const FAIL = JSON.stringify({
  pass: false,
  score: 0.3,
  checks: {},
  recommendation: "drop the line-number locators; state it conceptually",
});

function seq(responses) {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  process.env.MEMORY_LLM_MOCK_SEQUENCE = JSON.stringify(responses);
  __resetMockCallIndex();
}
function textOf(response) {
  return JSON.parse(response.content[0].text);
}

beforeEach(() => {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  __resetMockCallIndex();
  __clearSettingsForTest();
});
afterEach(() => {
  delete process.env.MEMORY_LLM_PROVIDER;
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  __resetMockCallIndex();
  __clearSettingsForTest();
});

test("non-judgeable category (plans) is not judged", async () => {
  // No mock response set: if the judge were called this would throw.
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  const r = await judgeInteractiveSubmission({ dataset: "plans", title: "T", body: "b" });
  assert.deepEqual(r, { block: false, flagged: false });
});

test("judge disabled bypasses the gate", async () => {
  __setSettingsForTest({ quality: { judgeEnabled: false } });
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  const r = await judgeInteractiveSubmission({ dataset: "knowledge", title: "T", body: "b" });
  assert.deepEqual(r, { block: false, flagged: false });
});

test("a passing submission proceeds unflagged", async () => {
  seq([PASS]);
  const r = await judgeInteractiveSubmission({ dataset: "knowledge", title: "T", body: "durable" });
  assert.equal(r.block, false);
  assert.equal(r.flagged, false);
});

test("a failing submission without acceptQuality is BLOCKED with the verdict + recommendation", async () => {
  seq([FAIL]);
  const r = await judgeInteractiveSubmission({
    dataset: "self_improvement",
    title: "lesson",
    body: "volatile Foo.scala:1 Bar.scala:2 Baz.scala:3",
  });
  assert.equal(r.block, true);
  const payload = textOf(r.response);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "quality-judge-rejected");
  assert.match(payload.recommendation, /line-number/);
});

test("a failing submission WITH acceptQuality proceeds, flagged unverified", async () => {
  seq([FAIL]);
  const r = await judgeInteractiveSubmission({
    dataset: "knowledge",
    title: "T",
    body: "b",
    acceptQuality: true,
  });
  assert.equal(r.block, false);
  assert.equal(r.flagged, true);
});

test("a judge outage blocks fail-closed with a retry message", async () => {
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  const r = await judgeInteractiveSubmission({ dataset: "knowledge", title: "T", body: "b" });
  assert.equal(r.block, true);
  const payload = textOf(r.response);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "quality-judge-unavailable");
});
