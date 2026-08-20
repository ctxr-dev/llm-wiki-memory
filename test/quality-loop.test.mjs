import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mockResponse, __resetMockCallIndex } from "../scripts/lib/llm-parse.mjs";
import {
  qualityJudgeEnabled,
  qualityMaxRounds,
  __setSettingsForTest,
  __clearSettingsForTest,
} from "../scripts/lib/settings.mjs";
import { generateWithJudge, judgeLeaf, JudgeUnavailable } from "../scripts/lib/quality-loop.mjs";

const PASS = JSON.stringify({
  pass: true,
  score: 0.92,
  checks: {
    durable: true,
    no_volatile_locators: true,
    conceptual: true,
    depersonalized: true,
    has_why_how: true,
  },
  recommendation: "",
});
function fail(score, rec) {
  return JSON.stringify({
    pass: false,
    score,
    checks: {
      durable: false,
      no_volatile_locators: false,
      conceptual: true,
      depersonalized: true,
      has_why_how: false,
    },
    recommendation: rec,
  });
}

function setSeq(responses) {
  process.env.MEMORY_LLM_MOCK_SEQUENCE = JSON.stringify(responses);
}

beforeEach(() => {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  __resetMockCallIndex();
  __clearSettingsForTest();
});
afterEach(() => {
  delete process.env.MEMORY_LLM_PROVIDER;
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  __resetMockCallIndex();
  __clearSettingsForTest();
});

// ── mock rotation (JL8) ───────────────────────────────────────────────────
test("MEMORY_LLM_MOCK_SEQUENCE returns successive responses, clamping to the last", () => {
  process.env.MEMORY_LLM_MOCK_SEQUENCE = JSON.stringify(["one", "two"]);
  __resetMockCallIndex();
  assert.equal(mockResponse(), "one");
  assert.equal(mockResponse(), "two");
  assert.equal(mockResponse(), "two", "clamps to the last element past the end");
});

// ── settings defaults ─────────────────────────────────────────────────────
test("quality settings default to judge-on, maxRounds 3", () => {
  assert.equal(qualityJudgeEnabled(), true);
  assert.equal(qualityMaxRounds(), 3);
});

test("quality settings honour a fail-closed override and a maxRounds override", () => {
  __setSettingsForTest({ quality: { judgeEnabled: false, maxRounds: 2 } });
  assert.equal(qualityJudgeEnabled(), false);
  assert.equal(qualityMaxRounds(), 2);
});

// ── judgeLeaf ─────────────────────────────────────────────────────────────
test("judgeLeaf parses the verdict from the provider", async () => {
  setSeq([PASS]);
  const v = await judgeLeaf({
    category: "knowledge",
    title: "T",
    body: "durable body with Why: x",
  });
  assert.equal(v.pass, true);
  assert.equal(v.score, 0.92);
});

test("judgeLeaf forces pass:false when attribution is present (precision cross-check)", async () => {
  setSeq([PASS]);
  const v = await judgeLeaf({
    category: "self_improvement",
    title: "lesson",
    body: "The user said to run tests first. Why: skipped verification.",
  });
  assert.equal(v.pass, false, "attribution overrides an LLM pass");
  assert.match(v.recommendation, /attribution|impersonal|de-personal/i);
});

test("judgeLeaf is fail-closed when the judge provider is unavailable", async () => {
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  await assert.rejects(
    () => judgeLeaf({ category: "knowledge", title: "T", body: "b" }),
    (err) => err instanceof JudgeUnavailable,
  );
});

// ── generateWithJudge loop ────────────────────────────────────────────────
test("generateWithJudge: round-1 pass writes immediately", async () => {
  setSeq([PASS]);
  let calls = 0;
  const res = await generateWithJudge({
    category: "knowledge",
    generate: async () => {
      calls += 1;
      return { title: "T", body: "durable" };
    },
  });
  assert.equal(res.flagged, false);
  assert.equal(res.round, 1);
  assert.equal(calls, 1);
  assert.equal(res.verdict.pass, true);
});

test("generateWithJudge: fail -> recommendation fed back -> pass on round 2", async () => {
  setSeq([fail(0.4, "drop the line numbers; state it conceptually"), PASS]);
  const seenRecs = [];
  const res = await generateWithJudge({
    category: "knowledge",
    generate: async ({ round, recommendation }) => {
      seenRecs.push({ round, recommendation });
      return { title: "T", body: `attempt ${round}`, round };
    },
  });
  assert.equal(res.flagged, false);
  assert.equal(res.round, 2);
  assert.equal(seenRecs.length, 2);
  assert.equal(seenRecs[0].recommendation, "", "round 1 gets no prior recommendation");
  assert.match(
    seenRecs[1].recommendation,
    /line numbers/,
    "round 2 gets the judge's recommendation",
  );
});

test("generateWithJudge: 3 fails keeps the best-scoring attempt and flags it unverified", async () => {
  setSeq([fail(0.3, "r1"), fail(0.6, "r2"), fail(0.5, "r3")]);
  const res = await generateWithJudge({
    category: "knowledge",
    generate: async ({ round }) => ({ title: "T", body: `attempt ${round}`, round }),
  });
  assert.equal(res.flagged, true, "after maxRounds fails the best attempt is flagged");
  assert.equal(res.candidate.round, 2, "the highest-scoring attempt (0.6) is kept");
  assert.equal(res.verdict.pass, false);
});

test("generateWithJudge: identical regenerated content short-circuits (no wasted re-judge)", async () => {
  setSeq([fail(0.3, "make it durable")]);
  let genCalls = 0;
  const res = await generateWithJudge({
    category: "knowledge",
    generate: async () => {
      genCalls += 1;
      return { title: "T", body: "unchangeable body" };
    },
  });
  assert.equal(res.flagged, true, "kept flagged once the content could not change");
  assert.equal(genCalls, 2, "regenerated once to detect no-change, then stopped (no round 3)");
});

test("generateWithJudge: maxRounds arg caps the loop", async () => {
  setSeq([fail(0.3, "r1"), fail(0.4, "r2"), PASS]);
  let calls = 0;
  const res = await generateWithJudge({
    category: "knowledge",
    maxRounds: 2,
    generate: async ({ round }) => {
      calls += 1;
      return { title: "T", body: `a${round}`, round };
    },
  });
  assert.equal(calls, 2, "stopped at maxRounds even though a later pass was scripted");
  assert.equal(res.flagged, true);
});

test("generateWithJudge: judgeEnabled=false bypasses the judge (no rounds)", async () => {
  __setSettingsForTest({ quality: { judgeEnabled: false } });
  let calls = 0;
  const res = await generateWithJudge({
    category: "knowledge",
    generate: async () => {
      calls += 1;
      return { title: "T", body: "unjudged" };
    },
  });
  assert.equal(res.bypassed, true);
  assert.equal(res.verdict, null);
  assert.equal(res.flagged, false);
  assert.equal(calls, 1);
});

test("generateWithJudge: a __bypassJudge candidate is returned without judging", async () => {
  // No mock response set: if the judge were called this would throw. It must not.
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  const res = await generateWithJudge({
    category: "knowledge",
    generate: async () => ({ __bypassJudge: true, decision: { action: "skip" } }),
  });
  assert.equal(res.bypassed, true);
  assert.equal(res.verdict, null);
  assert.equal(res.flagged, false);
});

test("generateWithJudge: fail-closed when the judge provider is unavailable", async () => {
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  await assert.rejects(
    () =>
      generateWithJudge({
        category: "knowledge",
        generate: async () => ({ title: "T", body: "b" }),
      }),
    (err) => err instanceof JudgeUnavailable,
  );
});
