import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// MEMORY_DATA_DIR is resolved as an import-time const in env.mjs, so the brain
// data dir must be pinned to an isolated temp dir BEFORE the dynamic import
// (env-new-knobs precedent). The two path-override env vars are cleared so the
// no-override assertions see the pure MEMORY_DATA_DIR-anchored defaults.
const TMP_DATA_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-envctx-")));
process.env.MEMORY_DATA_DIR = TMP_DATA_DIR;
delete process.env.LLM_WIKI_MEMORY_ROOT;
delete process.env.MEMORY_EMBED_CACHE;

const {
  MEMORY_DATA_DIR,
  COMPILE_STATE_PATH,
  GC_STATE_PATH,
  wikiRoot,
  embedCachePath,
  withWikiRoot,
} = await import("../scripts/lib/env.mjs");
const { settingsPath } = await import("../scripts/lib/settings.mjs");
const { resolveWikiContext, withWikiContext } = await import("../scripts/lib/wiki-context.mjs");

/** @type {string[]} */
const tmpDirs = [TMP_DATA_DIR];
after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const FAKE_ROOT = "/fake/mount/.llm-wiki-memory/wiki";
const FAKE_CACHE = path.join("/fake/mount/.llm-wiki-memory", "index", "embeddings.json");

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeBrainHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-envctx-brain-")));
  tmpDirs.push(home);
  const layoutDir = path.join(home, ".llm-wiki-memory", "wiki", ".layout");
  fs.mkdirSync(layoutDir, { recursive: true });
  fs.writeFileSync(
    path.join(layoutDir, "layout.yaml"),
    "layout:\n  - path: knowledge\n  - path: daily\n",
  );
  return home;
}

test("withWikiRoot: wikiRoot() and embedCachePath() follow the override inside the frame, env defaults outside", () => {
  const defaultRoot = wikiRoot();
  const defaultCache = embedCachePath();

  withWikiRoot(FAKE_ROOT, () => {
    assert.equal(wikiRoot(), FAKE_ROOT, "wikiRoot() returns the active override");
    assert.equal(
      embedCachePath(),
      FAKE_CACHE,
      "embed cache derives from the active root's data dir",
    );
  });

  assert.equal(wikiRoot(), defaultRoot, "wikiRoot() restored to the env default after the frame");
  assert.equal(embedCachePath(), defaultCache, "embed cache restored after the frame");
});

test("no active override: wikiRoot()/embedCachePath() are the MEMORY_DATA_DIR-anchored defaults (regression)", () => {
  assert.equal(wikiRoot(), path.join(MEMORY_DATA_DIR, "wiki"));
  assert.equal(embedCachePath(), path.join(MEMORY_DATA_DIR, "index", "embeddings.json"));
});

test("withWikiRoot: brain-global paths (MEMORY_DATA_DIR, settingsPath, state dir) are unaffected by an override", () => {
  const beforeData = MEMORY_DATA_DIR;
  const beforeSettings = settingsPath();
  const beforeCompileState = COMPILE_STATE_PATH;
  const beforeGcState = GC_STATE_PATH;

  withWikiRoot(FAKE_ROOT, () => {
    assert.equal(MEMORY_DATA_DIR, beforeData, "MEMORY_DATA_DIR stays brain-anchored");
    assert.equal(settingsPath(), beforeSettings, "settingsPath stays brain-anchored");
    assert.equal(COMPILE_STATE_PATH, beforeCompileState, "compile state path stays brain-anchored");
    assert.equal(GC_STATE_PATH, beforeGcState, "gc state path stays brain-anchored");
    assert.ok(settingsPath().startsWith(MEMORY_DATA_DIR), "settings live under the brain data dir");
    assert.ok(!settingsPath().includes("/fake/mount"), "settings never follow the active root");
  });

  assert.equal(settingsPath(), beforeSettings, "settingsPath unchanged after the frame too");
});

test("withWikiRoot: nested overrides shadow the outer and restore it on exit", () => {
  const outerRoot = "/fake/outer/.llm-wiki-memory/wiki";
  const innerRoot = "/fake/inner/.llm-wiki-memory/wiki";

  withWikiRoot(outerRoot, () => {
    assert.equal(wikiRoot(), outerRoot);
    withWikiRoot(innerRoot, () => {
      assert.equal(wikiRoot(), innerRoot, "inner override wins while active");
    });
    assert.equal(wikiRoot(), outerRoot, "outer restored after the inner override exits");
  });
  assert.equal(wikiRoot(), path.join(MEMORY_DATA_DIR, "wiki"), "default restored after all frames");
});

test("withWikiRoot: concurrent async frames never leak into each other", async () => {
  const rootA = "/fake/a/.llm-wiki-memory/wiki";
  const rootB = "/fake/b/.llm-wiki-memory/wiki";

  const [aOk, bOk] = await Promise.all([
    withWikiRoot(rootA, async () => {
      await tick(20);
      const mid = wikiRoot();
      await tick(5);
      return mid === rootA && wikiRoot() === rootA;
    }),
    withWikiRoot(rootB, async () => {
      await tick(5);
      const mid = wikiRoot();
      await tick(20);
      return mid === rootB && wikiRoot() === rootB;
    }),
  ]);

  assert.equal(aOk, true, "frame A saw only rootA across awaits");
  assert.equal(bOk, true, "frame B saw only rootB across awaits");
  assert.equal(
    wikiRoot(),
    path.join(MEMORY_DATA_DIR, "wiki"),
    "default restored after both frames",
  );
});

test("withWikiContext: wikiRoot()/embedCachePath() default to ctx.writeDefault.root, a nested override restores to it", () => {
  const home = makeBrainHome();
  const ctx = resolveWikiContext([], { home, brainDataDir: path.join(home, ".llm-wiki-memory") });

  withWikiContext(ctx, () => {
    assert.equal(
      wikiRoot(),
      ctx.writeDefault.root,
      "wikiRoot() is the write-default (brain) root inside the context",
    );
    assert.equal(
      embedCachePath(),
      path.join(path.dirname(ctx.writeDefault.root), "index", "embeddings.json"),
      "the root-level embedCachePath still follows the write-default root's data dir",
    );
    assert.equal(
      ctx.writeDefault.embedCacheFor("knowledge"),
      path.join(ctx.writeDefault.root, "knowledge", ".embeddings", "embeddings.json"),
      "the context level's embedCacheFor is per-category under its own wiki root (Phase D)",
    );
    assert.notEqual(
      embedCachePath(),
      ctx.writeDefault.embedCacheFor("knowledge"),
      "the per-category cache is distinct from the legacy root-level path",
    );

    const other = "/fake/level/.llm-wiki-memory/wiki";
    withWikiRoot(other, () => {
      assert.equal(
        wikiRoot(),
        other,
        "a nested per-level override wins over the context write-default",
      );
    });
    assert.equal(
      wikiRoot(),
      ctx.writeDefault.root,
      "context write-default restored after the nested override",
    );
  });

  assert.equal(
    wikiRoot(),
    path.join(MEMORY_DATA_DIR, "wiki"),
    "env default restored after the context frame",
  );
});
