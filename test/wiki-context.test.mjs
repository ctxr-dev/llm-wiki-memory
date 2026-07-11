import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveWikiContext,
  withWikiContext,
  getActiveWikiContext,
  withBrainContext,
  WikiLevelSchema,
} from "../scripts/lib/wiki-context.mjs";

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const SHARED_LAYOUT = "layout:\n  - path: knowledge\n  - path: daily\n";
const LOCAL_LAYOUT = "layout:\n  - path: scratch\n    placement_facets: []\n";

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-wctx-"));
  tmpDirs.push(home);
  return home;
}

// Build a valid wiki mount at `dir` (a layout that passes LayoutYamlSchema so
// the resolver's loadMergedLayout does not throw). `local` adds a personal
// layout.local.yaml to prove the merge ran.
function mkMount(dir, { local } = {}) {
  const layoutDir = path.join(dir, ".llm-wiki-memory", "wiki", ".layout");
  fs.mkdirSync(layoutDir, { recursive: true });
  fs.writeFileSync(path.join(layoutDir, "layout.yaml"), SHARED_LAYOUT);
  if (local) fs.writeFileSync(path.join(layoutDir, "layout.local.yaml"), local);
  return dir;
}

function real(p) {
  return fs.realpathSync(p);
}

function brainOpts(home) {
  return { home, brainDataDir: path.join(home, ".llm-wiki-memory") };
}

function layoutPaths(layout) {
  const entries = /** @type {Array<{ path: string }>} */ (layout.layout);
  return entries.map((e) => e.path).sort();
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("resolveWikiContext: brain + one repo yields two enriched levels at depths 0/1", () => {
  const home = makeHome();
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"), { local: LOCAL_LAYOUT });

  const ctx = resolveWikiContext([proj], brainOpts(home));

  assert.equal(ctx.levels.length, 2, "brain + one repo");
  assert.deepEqual(
    ctx.levels.map((l) => l.depth),
    [0, 1],
  );
  assert.equal(ctx.brain, ctx.levels[0], "brain is the depth-0 level");
  assert.equal(ctx.brain.depth, 0);
  assert.equal(ctx.brain.ownership, "wiki");
  assert.equal(ctx.writeDefault, ctx.brain, "writeDefault is the brain for step 2");
  assert.equal(ctx.levels[1].ownership, "repo");
  assert.equal(ctx.levels[1].depth, 1);
});

test("resolveWikiContext: each level's layout is the merged (shared + local) object", () => {
  const home = makeHome();
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"), { local: LOCAL_LAYOUT });

  const ctx = resolveWikiContext([proj], brainOpts(home));

  assert.deepEqual(
    layoutPaths(ctx.brain.layout),
    ["daily", "knowledge"],
    "brain layout is the shared layout (no local override present)",
  );
  assert.deepEqual(
    layoutPaths(ctx.levels[1].layout),
    ["daily", "knowledge", "scratch"],
    "repo layout merged the local-only 'scratch' category on top of shared",
  );
});

test("resolveWikiContext: embedCacheFor returns the per-level, per-category cache path", () => {
  const home = makeHome();
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"), { local: LOCAL_LAYOUT });

  const ctx = resolveWikiContext([proj], brainOpts(home));
  const repo = ctx.levels[1];

  assert.equal(typeof repo.embedCacheFor, "function");
  assert.equal(
    repo.embedCacheFor("knowledge"),
    path.join(
      real(proj),
      ".llm-wiki-memory",
      "wiki",
      "knowledge",
      ".embeddings",
      "embeddings.json",
    ),
    "repo cache path is derived from the repo mount's wiki root + category",
  );
  assert.equal(
    ctx.brain.embedCacheFor("knowledge"),
    path.join(home, ".llm-wiki-memory", "wiki", "knowledge", ".embeddings", "embeddings.json"),
    "brain cache path is derived from the brain wiki root + category",
  );
  assert.notEqual(
    repo.embedCacheFor("knowledge"),
    repo.embedCacheFor("daily"),
    "each category resolves to its OWN per-category cache file (Phase D)",
  );
});

test("resolveWikiContext: no repo scopes yields a brain-only single-level context", () => {
  const home = makeHome();
  mkMount(home);
  const ctx = resolveWikiContext([], brainOpts(home));
  assert.equal(ctx.levels.length, 1);
  assert.equal(ctx.brain, ctx.levels[0]);
  assert.equal(ctx.brain.ownership, "wiki");
  assert.equal(ctx.brain.depth, 0);
});

test("withBrainContext: fn runs inside a single-level brain-only context", () => {
  const home = makeHome();
  mkMount(home);

  let seen = null;
  const ret = withBrainContext(() => {
    seen = getActiveWikiContext();
    return "ok";
  }, brainOpts(home));

  assert.equal(ret, "ok", "the fn's return value propagates");
  assert.ok(seen, "a context was active inside fn");
  assert.equal(seen.levels.length, 1, "brain-only context");
  assert.equal(seen.levels[0].ownership, "wiki");
  assert.equal(seen.brain, seen.levels[0]);
  assert.equal(seen.writeDefault, seen.brain);
  assert.equal(getActiveWikiContext(), null, "the frame is gone after fn returns");
});

test("getActiveWikiContext: null outside any frame", () => {
  assert.equal(getActiveWikiContext(), null);
});

test("withWikiContext: a nested frame restores the outer context on exit", () => {
  const home = makeHome();
  mkMount(home);
  const outer = resolveWikiContext([], brainOpts(home));
  const inner = resolveWikiContext([], brainOpts(home));
  assert.notEqual(outer, inner, "two resolves produce distinct context objects");

  withWikiContext(outer, () => {
    assert.equal(getActiveWikiContext(), outer);
    withWikiContext(inner, () => {
      assert.equal(getActiveWikiContext(), inner, "inner frame wins while active");
    });
    assert.equal(getActiveWikiContext(), outer, "outer restored after inner exits");
  });
  assert.equal(getActiveWikiContext(), null, "no frame after the outermost exits");
});

test("withWikiContext: concurrent interleaved frames never leak into each other", async () => {
  const home = makeHome();
  mkMount(home);
  const ctxA = resolveWikiContext([], brainOpts(home));
  const ctxB = resolveWikiContext([], brainOpts(home));

  const [aOk, bOk] = await Promise.all([
    withWikiContext(ctxA, async () => {
      await tick(20);
      const mid = getActiveWikiContext();
      await tick(5);
      return mid === ctxA && getActiveWikiContext() === ctxA;
    }),
    withWikiContext(ctxB, async () => {
      await tick(5);
      const mid = getActiveWikiContext();
      await tick(20);
      return mid === ctxB && getActiveWikiContext() === ctxB;
    }),
  ]);

  assert.equal(aOk, true, "frame A saw only ctxA across awaits");
  assert.equal(bOk, true, "frame B saw only ctxB across awaits");
  assert.equal(getActiveWikiContext(), null, "both frames closed");
});

test("WikiLevelSchema: accepts an enriched level, rejects bad ownership and a non-function embedCacheFor", () => {
  const good = {
    root: "/x/.llm-wiki-memory/wiki",
    ownership: "wiki",
    depth: 0,
    projectModule: "x",
    layout: { layout: [{ path: "knowledge" }] },
    embedCacheFor: () => "/x/.llm-wiki-memory/index/embeddings.json",
    embedBackend: "lexical",
  };
  assert.equal(WikiLevelSchema.safeParse(good).success, true, "a fully-enriched level validates");
  assert.equal(
    WikiLevelSchema.safeParse({ ...good, ownership: "server" }).success,
    false,
    "an out-of-enum ownership is rejected",
  );
  assert.equal(
    WikiLevelSchema.safeParse({ ...good, embedCacheFor: "not-a-function" }).success,
    false,
    "a non-function embedCacheFor is rejected",
  );
});
