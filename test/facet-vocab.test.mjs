import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const {
  collectFacetVocab,
  renderVocabVars,
  __resetFacetVocabForTest,
} = await import("../scripts/lib/facet-vocab.mjs");

function seed(name, area, errorPattern) {
  store.saveDocument({
    name,
    text: `# ${name}\n\nbody for ${name}`,
    datasetId: "knowledge",
    metadata: {
      area,
      atom_type: "pattern-gotcha",
      task_type: "implementation",
      ...(errorPattern ? { error_pattern: errorPattern } : {}),
    },
  });
}

test("empty wiki yields empty vocab and neutral prompt vars", () => {
  __resetFacetVocabForTest();
  const vocab = collectFacetVocab();
  assert.deepEqual(vocab, { areas: [], errorPatternsByArea: {} });
  const vars = renderVocabVars(vocab);
  assert.equal(vars.KNOWN_AREAS, "(none yet)");
  assert.equal(vars.KNOWN_ERROR_PATTERNS, "(none yet)");
});

test("collector tallies areas by leaf count and groups error patterns", () => {
  seed("knowledge-a1-2026-06-04-000000001.md", "auth", "missing-token-refresh");
  seed("knowledge-a2-2026-06-04-000000002.md", "auth", "missing-token-refresh");
  seed("knowledge-a3-2026-06-04-000000003.md", "auth", "stale-session-cache");
  seed("knowledge-b1-2026-06-04-000000004.md", "billing", null);
  __resetFacetVocabForTest();
  const vocab = collectFacetVocab();
  assert.equal(vocab.areas[0], "auth", "most-populated area ranks first");
  assert.ok(vocab.areas.includes("billing"));
  assert.equal(vocab.errorPatternsByArea.auth[0], "missing-token-refresh", "most-frequent pattern first");
  assert.ok(vocab.errorPatternsByArea.auth.includes("stale-session-cache"));
  assert.equal(vocab.errorPatternsByArea.billing, undefined, "no patterns -> no key");
});

test("caps are respected", () => {
  __resetFacetVocabForTest();
  const vocab = collectFacetVocab({ maxAreas: 1, maxPatternsPerArea: 1 });
  assert.equal(vocab.areas.length, 1);
  assert.equal(vocab.errorPatternsByArea.auth.length, 1);
});

test("sentinel areas are excluded from the vocabulary", () => {
  seed("knowledge-u1-2026-06-04-000000005.md", "unknown", "some-pattern");
  __resetFacetVocabForTest();
  const vocab = collectFacetVocab();
  assert.ok(!vocab.areas.includes("unknown"));
});

test("renderVocabVars formats the per-area pattern block", () => {
  const vars = renderVocabVars({
    areas: ["auth", "billing"],
    errorPatternsByArea: { auth: ["p1", "p2"] },
  });
  assert.equal(vars.KNOWN_AREAS, "auth, billing");
  assert.match(vars.KNOWN_ERROR_PATTERNS, /^auth: p1, p2$/m);
});

test("memoization returns the same object within a process until reset", () => {
  __resetFacetVocabForTest();
  const a = collectFacetVocab();
  const b = collectFacetVocab();
  assert.equal(a, b);
  __resetFacetVocabForTest();
  assert.notEqual(collectFacetVocab(), a);
});

test("flush prompt renders vocab vars and the anti-fragmentation rule (no literal placeholders)", async () => {
  __resetFacetVocabForTest();
  const { __loadPromptForTest } = await import("../scripts/hooks/flush.mjs");
  const prompt = __loadPromptForTest();
  assert.ok(!prompt.includes("{{KNOWN_AREAS}}") && !prompt.includes("{{KNOWN_ERROR_PATTERNS}}"));
  assert.match(prompt, /auth/, "seeded area appears in the rendered prompt");
  assert.match(prompt, /missing-token-refresh/, "seeded error_pattern appears");
  assert.match(prompt, /Prefer fewer, richer atoms/, "D4 anti-fragmentation rule present");
  assert.match(prompt, /REUSE an existing value/, "reuse-before-invent instruction present");
});

test("compile prompt renders vocab vars (no literal placeholders)", async () => {
  __resetFacetVocabForTest();
  const { __loadPromptForTest } = await import("../scripts/compile.mjs");
  const prompt = __loadPromptForTest();
  assert.ok(!prompt.includes("{{KNOWN_AREAS}}") && !prompt.includes("{{"), "all placeholders substituted");
  assert.match(prompt, /auth/);
  assert.match(prompt, /REUSE an existing slug/);
});
