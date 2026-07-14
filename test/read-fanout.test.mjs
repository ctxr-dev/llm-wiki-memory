import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A FIXED settings home carries the lexical embed backend (settings are
// brain-global: read from MEMORY_DATA_DIR regardless of which level's tree a
// search is scoped to). Each test then builds its OWN federation under a fresh
// temp home and passes it as `brainDataDir`, so the trees are independent while
// every search still ranks with the deterministic lexical scorer.
const SETTINGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-fanout-set-"));
process.env.MEMORY_DATA_DIR = path.join(SETTINGS_HOME, ".llm-wiki-memory");
process.env.MEMORY_DEFAULT_PROJECT_MODULE = "brainmod";
fs.mkdirSync(path.join(process.env.MEMORY_DATA_DIR, "settings"), { recursive: true });
fs.writeFileSync(
  path.join(process.env.MEMORY_DATA_DIR, "settings", "settings.yaml"),
  "embed:\n  backend: lexical\nconsolidate:\n  enabled: false\n",
);

const { searchMemoryFiltered, searchOneTree } = await import("../scripts/lib/wiki-store.mjs");
const { recallLessons, searchMemory } = await import("../scripts/lib/recall.mjs");
const { resolveWikiContext, withWikiContext } = await import("../scripts/lib/wiki-context.mjs");
const { defaultProjectModule } = await import("../scripts/lib/env.mjs");
const { clampSearchResponse, SEARCH_TOTAL_BUDGET } =
  await import("../scripts/lib/search-clamp.mjs");

const tmpDirs = [SETTINGS_HOME];
after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-fanout-"));
  tmpDirs.push(home);
  return home;
}

// Build a wiki mount at `dir` declaring `cats`; returns the wiki root.
function mkMount(dir, cats) {
  const wikiRoot = path.join(dir, ".llm-wiki-memory", "wiki");
  const layoutDir = path.join(wikiRoot, ".layout");
  fs.mkdirSync(layoutDir, { recursive: true });
  fs.writeFileSync(
    path.join(layoutDir, "layout.yaml"),
    `layout:\n${cats.map((c) => `  - path: ${c}`).join("\n")}\n`,
  );
  return wikiRoot;
}

function writeLeaf(wikiRoot, category, name, { body, memory }) {
  const dir = path.join(wikiRoot, category);
  fs.mkdirSync(dir, { recursive: true });
  const fm = ["---", "memory:"];
  for (const [k, v] of Object.entries(memory)) fm.push(`  ${k}: ${v}`);
  fm.push("---", "", body, "");
  fs.writeFileSync(path.join(dir, name), fm.join("\n"));
}

function brainOpts(home) {
  return { home, brainDataDir: path.join(home, ".llm-wiki-memory") };
}

// ─── clamp: level-scaled budget, no dropped hits, priority governs spend ─────

test("clamp: total budget scales with the level count so more bodies survive", () => {
  const body = "x".repeat(599);
  const single = {
    records: Array.from({ length: 40 }, (_, i) => ({
      documentId: `s${i}`,
      priority: "P1",
      content: body,
    })),
  };
  const multi = {
    records: Array.from({ length: 40 }, (_, i) => ({
      documentId: `m${i}`,
      priority: "P1",
      content: body,
      depth: i % 2, // two distinct depths -> two contributing levels
    })),
  };
  const outSingle = clampSearchResponse(single);
  const outMulti = clampSearchResponse(multi);
  const alive = (o) => o.records.filter((r) => r.content.length > 0).length;
  assert.equal(outSingle.records.length, 40, "single-level: no hit dropped");
  assert.equal(outMulti.records.length, 40, "multi-level: no hit dropped");
  assert.ok(
    alive(outMulti) > alive(outSingle),
    `multi-level budget lets more bodies through (multi=${alive(outMulti)}, single=${alive(outSingle)})`,
  );
});

test("clamp: priority (not depth) governs body spend — deep P0 survives, shallow P2 emptied", () => {
  const body = "x".repeat(599);
  const records = [
    ...Array.from({ length: 60 }, (_, i) => ({
      documentId: `p2_${i}`,
      priority: "P2",
      content: body,
      depth: 0,
    })),
    { documentId: "p0deep", priority: "P0", content: body, depth: 2 },
  ];
  const out = clampSearchResponse({ records });
  assert.equal(out.records.length, 61, "no hit dropped from the ranked list");
  const p0 = out.records.find((r) => r.documentId === "p0deep");
  assert.ok(
    p0 && p0.content.length > 0,
    "the deepest hit keeps its body because it is P0 (priority spent first, not depth)",
  );
  const emptiedShallow = out.records.filter((r) => r.priority === "P2" && r.content === "").length;
  assert.ok(emptiedShallow > 0, "some shallow P2 bodies are emptied once the budget is spent");
});

test("clamp: single-tree response (no depth tags) keeps the un-scaled budget", () => {
  const body = "x".repeat(599);
  const records = Array.from({ length: 60 }, (_, i) => ({
    documentId: `h${i}`,
    priority: "P1",
    content: body,
  }));
  const out = clampSearchResponse({ records });
  const totalChars = out.records.reduce((s, r) => s + r.content.length, 0);
  assert.ok(
    totalChars <= SEARCH_TOTAL_BUDGET + 600,
    `within the single-level budget: ${totalChars}`,
  );
});

// ─── §3f worked example: BANDED depth boost (comparable-deeper wins; a weak
//     deeper hit does NOT bury a strongly-relevant shallower one) ─────────────

test("§3f banded boost: a COMPARABLY-relevant deeper hit outranks the brain, but a WEAK deeper hit does not bury a strong brain hit", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "daily"]);
  const webhooks = mkMount(path.join(home, "repos", "webhooks"), ["knowledge", "daily"]);
  const mem = { atom_type: "knowledge-fact" };
  // H1 (brain) and W2 (deepest) match the query EQUALLY strongly → both at the top
  // cosine → both boost-eligible, so the deeper W2 wins (repo-preference on
  // comparable relevance). W1 (deepest) matches WEAKLY (only "octopus", diluted by
  // fillers) → its cosine is far below the top, so the band STRIPS its depth boost
  // and it can't bury the strong brain hit H1.
  writeLeaf(brain, "knowledge", "H1.md", { body: "octopus garden octopus garden", memory: mem });
  writeLeaf(webhooks, "knowledge", "W2.md", {
    body: "octopus garden octopus garden",
    memory: mem,
  });
  writeLeaf(webhooks, "knowledge", "W1.md", {
    body: "octopus zulu yankee xray whiskey victor uniform",
    memory: mem,
  });

  const ctx = resolveWikiContext([path.join(home, "repos", "webhooks")], brainOpts(home));
  assert.deepEqual(
    ctx.levels.map((l) => l.depth),
    [0, 1],
    "brain(d0), webhooks(d1)",
  );

  const out = await withWikiContext(ctx, () =>
    searchMemoryFiltered({ query: "octopus garden", datasetId: "knowledge" }),
  );
  assert.deepEqual(
    out.records.map((r) => r.documentName),
    ["W2.md", "H1.md", "W1.md"],
    "comparable deeper (W2) wins; strong brain (H1) beats the WEAK deeper (W1)",
  );
  const byName = Object.fromEntries(out.records.map((r) => [r.documentName, r]));
  assert.equal(byName["W2.md"].depthBoost, 1, "comparable deeper hit KEEPS its depth boost");
  assert.equal(byName["W1.md"].depthBoost, 0, "weak deeper hit's boost is BANDED OFF");
  assert.equal(byName["H1.md"].depthBoost, 0, "brain is depth 0 (no boost)");
  assert.ok(
    byName["H1.md"].adjustedConfidence > byName["W1.md"].adjustedConfidence,
    "the strong brain hit is NOT buried by the weak deeper hit",
  );
});

// ─── regression: single level is byte-identical to the single-tree scorer ────

test("single-level fan-out is byte-identical to searchOneTree (no depth fields)", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "daily"]);
  const mem = { atom_type: "knowledge-fact" };
  writeLeaf(brain, "knowledge", "A.md", { body: "quokka wombat alpha note", memory: mem });
  writeLeaf(brain, "knowledge", "B.md", { body: "quokka bilby beta note", memory: mem });

  const ctx = resolveWikiContext([], brainOpts(home)); // brain-only: one level
  assert.equal(ctx.levels.length, 1, "single-level context");

  const viaFanout = await withWikiContext(ctx, () =>
    searchMemoryFiltered({ query: "quokka note", datasetId: "knowledge" }),
  );
  const viaOneTree = await withWikiContext(ctx, () =>
    searchOneTree({ query: "quokka note", datasetId: "knowledge" }),
  );
  assert.deepEqual(viaFanout, viaOneTree, "one-level door == single-tree scorer, exactly");
  for (const r of viaFanout.records) {
    assert.equal(r.depth, undefined, "no depth tag on a single-tree hit");
    assert.equal(r.adjustedConfidence, undefined, "no adjustedConfidence on a single-tree hit");
    assert.equal(r.resolvedRoot, undefined, "no resolvedRoot on a single-tree hit");
  }
});

// ─── tree-namespaced dedupe ──────────────────────────────────────────────────

test("dedupe: the SAME rel path in two DIFFERENT trees both survive", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "daily"]);
  const repos = mkMount(path.join(home, "repos"), ["knowledge", "daily"]);
  const mem = { atom_type: "knowledge-fact" };
  writeLeaf(brain, "knowledge", "DUPE.md", { body: "narwhal shared relpath brain", memory: mem });
  writeLeaf(repos, "knowledge", "DUPE.md", { body: "narwhal shared relpath repos", memory: mem });

  const ctx = resolveWikiContext([path.join(home, "repos")], brainOpts(home));
  const out = await withWikiContext(ctx, () =>
    searchMemoryFiltered({ query: "narwhal shared relpath", datasetId: "knowledge" }),
  );
  const dupes = out.records.filter((r) => r.documentName === "DUPE.md");
  assert.equal(dupes.length, 2, "both same-rel-path leaves survive (keyed on tree root)");
  assert.equal(new Set(dupes.map((r) => r.resolvedRoot)).size, 2, "distinct tree roots");
  assert.deepEqual(
    [...new Set(dupes.map((r) => r.depth))].sort(),
    [0, 1],
    "one from the brain (d0), one from the repo (d1)",
  );
});

// ─── per-level project_module ────────────────────────────────────────────────

test("per-level project_module: a mount leaf tagged with a DIFFERENT module is still returned", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "daily"]);
  const webhooks = mkMount(path.join(home, "webhooks"), ["knowledge", "daily"]);

  const ctx = resolveWikiContext([path.join(home, "webhooks")], brainOpts(home));
  writeLeaf(brain, "knowledge", "BrainFact.md", {
    body: "platypus config note",
    memory: { atom_type: "knowledge-fact", project_module: ctx.levels[0].projectModule },
  });
  // Tagged with the mount's OWN resolved module (its file:// identity), NOT the brain default.
  writeLeaf(webhooks, "knowledge", "RepoFact.md", {
    body: "platypus config note",
    memory: { atom_type: "knowledge-fact", project_module: ctx.levels[1].projectModule },
  });
  // searchMemory auto-injects the brain default module; without per-level
  // re-scoping the "webhooks"-tagged leaf would be filtered out by "brainmod".
  const out = await withWikiContext(ctx, () =>
    searchMemory({ query: "platypus config", filters: { atom_type: "knowledge-fact" } }),
  );
  const names = out.records.map((r) => r.documentName);
  assert.ok(names.includes("RepoFact.md"), "mount leaf under its own module is returned");
  assert.ok(names.includes("BrainFact.md"), "brain leaf under the default module is returned");
});

test("per-level project_module: a brain layout project_id is IGNORED for the brain module (read == write == defaultProjectModule)", async () => {
  const home = makeHome();
  // The brain layout declares a project_id. A real brain write (normaliseMeta)
  // ALWAYS stamps defaultProjectModule(), never the project_id, so the brain's
  // read-side module MUST also be defaultProjectModule() — otherwise the fan-out
  // swaps the brain filter to the project_id and every brain leaf silently drops.
  const brainRoot = path.join(home, ".llm-wiki-memory", "wiki");
  fs.mkdirSync(path.join(brainRoot, ".layout"), { recursive: true });
  fs.writeFileSync(
    path.join(brainRoot, ".layout", "layout.yaml"),
    "project_id: pinned/brain\nlayout:\n  - path: knowledge\n  - path: daily\n",
  );
  const webhooks = mkMount(path.join(home, "webhooks"), ["knowledge", "daily"]);

  const ctx = resolveWikiContext([path.join(home, "webhooks")], brainOpts(home));
  assert.equal(
    ctx.levels[0].projectModule,
    defaultProjectModule(),
    "the brain IGNORES its layout project_id — its module is the env default (== its write-stamp)",
  );
  assert.notEqual(
    ctx.levels[0].projectModule,
    "pinned/brain",
    "the layout project_id is NOT adopted as the brain module",
  );
  // Stamp the brain leaf with the WRITE-side value a real write produces
  // (defaultProjectModule()), NOT the read-side swap value — stamping the swap
  // value was the false-green this test replaces.
  writeLeaf(brainRoot, "knowledge", "BrainFact.md", {
    body: "echidna config note",
    memory: { atom_type: "knowledge-fact", project_module: defaultProjectModule() },
  });
  writeLeaf(webhooks, "knowledge", "RepoFact.md", {
    body: "echidna config note",
    memory: { atom_type: "knowledge-fact", project_module: ctx.levels[1].projectModule },
  });
  const out = await withWikiContext(ctx, () =>
    searchMemory({ query: "echidna config", filters: { atom_type: "knowledge-fact" } }),
  );
  const names = out.records.map((r) => r.documentName);
  assert.ok(
    names.includes("BrainFact.md"),
    "the brain leaf (stamped defaultProjectModule) survives the fan-out",
  );
  assert.ok(names.includes("RepoFact.md"), "the repo leaf is returned too");
});

// ─── category absence: a knowledge-only repo doesn't break recall ────────────

test("category-absence: a knowledge-only repo contributes knowledge and never breaks recall_lessons", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "self_improvement", "daily"]);
  // The repo declares NO self_improvement category and has no such dir.
  const proj = mkMount(path.join(home, "proj"), ["knowledge", "daily"]);

  const ctx = resolveWikiContext([path.join(home, "proj")], brainOpts(home));
  writeLeaf(brain, "self_improvement", "L1.md", {
    body: "kangaroo lesson always validate inputs",
    memory: {
      atom_type: "self-improvement-lesson",
      project_module: ctx.levels[0].projectModule,
      task_type: "implementation",
      error_pattern: "kangaroo-trap",
    },
  });
  writeLeaf(proj, "knowledge", "K1.md", {
    body: "kangaroo root cause cache invalidation",
    memory: {
      atom_type: "bug-root-cause",
      project_module: ctx.levels[1].projectModule,
      error_pattern: "kangaroo-trap",
    },
  });
  const out = await withWikiContext(ctx, () =>
    recallLessons({ query: "kangaroo validate cache", includeKnowledge: true }),
  );
  assert.ok(out.lessonHits >= 1, "brain lesson recalled despite the repo lacking self_improvement");
  assert.ok(
    out.records.some((r) => r.kind === "lesson" && r.documentName === "L1.md"),
    "the brain lesson is present",
  );
  assert.ok(
    out.records.some((r) => r.kind === "knowledge" && r.documentName === "K1.md"),
    "the knowledge-only repo's bug-root-cause is contributed via per-level module scoping",
  );
});
