// Phase I — cron isolation + guarded manual consolidate.
//
// Covers the two belt-and-suspenders isolation guards and the cron brain-only
// invariant:
//   1. consolidate skips `ownership==repo` (shared) refine categories.
//   2. an explicit shared/non-brain target is refused with a clear deferral
//      error and touches nothing (no lock/commit/rewrite).
//   3. consolidate re-scopes to the brain even under an ambient multi-level
//      context (the withBrainContext single-level invariant cron relies on).
//
// LLM is disabled in every consolidate call (`llm:false`); the lexical harness
// backend is pinned by setupWorkspace.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

// Import AFTER setupWorkspace pins MEMORY_DATA_DIR (env.mjs freezes it as an
// import-time const) — a static import would freeze the real data dir instead.
const { filterBrainOwnedRefine, guardConsolidateTarget, SHARED_TARGET_ERROR } =
  await import("../scripts/consolidate-isolation.mjs");
const { consolidateMemory } = await import("../scripts/consolidate.mjs");
const store = await import("../scripts/lib/wiki-store.mjs");
const { resolveWikiContext, withWikiContext } = await import("../scripts/lib/wiki-context.mjs");
const { resetLayoutCache } = await import("../scripts/lib/wiki-layout-state.mjs");

const FROZEN_NOW = new Date("2026-06-02T12:00:00Z");
const LAYOUT_YAML = path.join(wiki, ".layout", "layout.yaml");

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

function seedLeaf({ name, text, datasetId, metadata }) {
  return store.saveDocument({ name, text, datasetId, metadata });
}

function activeNames(datasetId) {
  return store
    .listDocuments({ datasetId, enabled: true })
    .documents.map((d) => d.name)
    .sort();
}

function disabledNames() {
  return store
    .listDocuments({ enabled: false })
    .documents.map((d) => d.name)
    .sort();
}

// Mark a refine category `ownership: repo` in the brain's own layout, so it
// becomes a shared/federated overlay category. Resets the mtime-keyed layout
// cache so the next read picks the edit up immediately.
function markCategoryRepoOwned(category) {
  const raw = fs.readFileSync(LAYOUT_YAML, "utf8");
  const needle = `  - path: ${category}\n`;
  assert.ok(raw.includes(needle), `layout has a '${category}' entry to mark repo-owned`);
  fs.writeFileSync(LAYOUT_YAML, raw.replace(needle, `${needle}    ownership: repo\n`));
  resetLayoutCache();
}

// ── filterBrainOwnedRefine (pure) ────────────────────────────────────────────

test("filterBrainOwnedRefine: brain-owned wiki has no ownership field so nothing is dropped", () => {
  const { brainRefine, repoOwnedRefine } = filterBrainOwnedRefine(
    ["knowledge", "self_improvement"],
    wiki,
  );
  assert.deepEqual(brainRefine, ["knowledge", "self_improvement"], "all refine kept (baseline)");
  assert.deepEqual(repoOwnedRefine, [], "no repo-owned category in a single-tree wiki");
});

// ── guardConsolidateTarget (pure) ────────────────────────────────────────────

test("guardConsolidateTarget: absent / empty / 'brain' target proceeds (null)", () => {
  assert.equal(guardConsolidateTarget(undefined), null);
  assert.equal(guardConsolidateTarget(null), null);
  assert.equal(guardConsolidateTarget(""), null);
  assert.equal(guardConsolidateTarget("   "), null);
  assert.equal(guardConsolidateTarget("brain"), null);
});

test("guardConsolidateTarget: an explicit non-brain target with no active context is refused", () => {
  const refusal = guardConsolidateTarget("/some/shared/repo");
  assert.ok(refusal, "a refusal envelope is returned");
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error, SHARED_TARGET_ERROR);
  assert.match(String(refusal.message), /brain-only/);
  assert.match(String(refusal.message), /re-run without a shared/);
});

// ── consolidate skips ownership==repo categories (integration) ───────────────

test("consolidate skips a repo-owned refine category: its duplicate leaves are never archived", async () => {
  markCategoryRepoOwned("knowledge");

  // Identical body in knowledge (now repo-owned). If knowledge were walked,
  // dedupe-by-sha256 would archive one of these — it must NOT.
  const kBody = "# Shared K\n\nIdentical body across both knowledge leaves; sha256 would fire.";
  seedLeaf({
    name: "shared-k-a.md",
    text: kBody,
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "isotest", area: "infra" },
  });
  seedLeaf({
    name: "shared-k-b.md",
    text: kBody,
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "isotest", area: "infra" },
  });

  // Identical body in self_improvement (still brain-owned) so the walk clearly
  // ran and archived a loser there — proves the skip is category-specific, not
  // a dead run. Distinct error_pattern so lesson-key does not also fire.
  const sBody = "# Brain S\n\nIdentical body across both lessons; sha256 dedupe fires here.";
  seedLeaf({
    name: "brain-s-a.md",
    text: sBody,
    datasetId: "self_improvement",
    metadata: {
      project_module: "isotest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "iso-brain-a",
    },
  });
  seedLeaf({
    name: "brain-s-b.md",
    text: sBody,
    datasetId: "self_improvement",
    metadata: {
      project_module: "isotest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "iso-brain-b",
    },
  });

  const knowledgeBefore = activeNames("knowledge");
  assert.deepEqual(
    knowledgeBefore,
    ["shared-k-a.md", "shared-k-b.md"],
    "two knowledge leaves seeded",
  );

  const r = await consolidateMemory({
    dryRun: false,
    llm: false,
    passes: ["dedupe-by-sha256"],
    now: FROZEN_NOW,
  });

  assert.equal(r.ok, true);
  // Working set excludes the repo-owned knowledge leaves; only the two
  // self_improvement leaves entered the loop.
  assert.equal(r.workingSetSize, 2, "only brain-owned self_improvement leaves are walked");

  assert.deepEqual(
    activeNames("knowledge"),
    knowledgeBefore,
    "both repo-owned knowledge leaves remain active — consolidate never touched the shared category",
  );

  const disabled = disabledNames();
  assert.deepEqual(
    disabled,
    ["brain-s-b.md"],
    "exactly the brain-owned self_improvement loser was archived",
  );
  assert.equal(r.totals.archived, 1, "report agrees: one archive, in the brain category only");
});

// ── shared-target consolidate is DEFERRED (integration) ──────────────────────

test("consolidateMemory({target:<shared>}) errors clearly and rewrites nothing", async () => {
  // A fresh dup pair whose survival proves the run never happened.
  const body = "# Defer dup\n\nIdentical body; would be deduped IF a run actually started.";
  seedLeaf({
    name: "defer-a.md",
    text: body,
    datasetId: "self_improvement",
    metadata: {
      project_module: "defertest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "defer-a",
    },
  });
  seedLeaf({
    name: "defer-b.md",
    text: body,
    datasetId: "self_improvement",
    metadata: {
      project_module: "defertest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "defer-b",
    },
  });
  const disabledBefore = disabledNames();

  const r = await consolidateMemory({
    dryRun: false,
    llm: false,
    passes: ["dedupe-by-sha256"],
    target: "/definitely/not/the/brain",
    now: FROZEN_NOW,
  });

  assert.equal(r.ok, false, "the shared-target request is refused");
  assert.equal(r.error, SHARED_TARGET_ERROR);
  assert.match(String(r.message), /brain-only/);

  // No lock/commit/rewrite: the dup pair is untouched (both still active).
  assert.deepEqual(
    disabledNames(),
    disabledBefore,
    "nothing was archived — consolidate never ran for a shared target",
  );
});

test("consolidateMemory refuses a target that resolves to a repo-owned level of the active context", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-iso-fed-"));
  tmpDirs.push(home);
  const layout = "layout:\n  - path: knowledge\n  - path: daily\n";
  const mkMount = (dir) => {
    const ld = path.join(dir, ".llm-wiki-memory", "wiki", ".layout");
    fs.mkdirSync(ld, { recursive: true });
    fs.writeFileSync(path.join(ld, "layout.yaml"), layout);
    return dir;
  };
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"));
  const brainOpts = { home, brainDataDir: path.join(home, ".llm-wiki-memory") };
  const ctx = resolveWikiContext([proj], brainOpts);
  assert.equal(ctx.levels.length, 2, "brain + one repo mount");
  assert.equal(ctx.levels[1].ownership, "repo");

  // The target names the repo mount → resolves to a repo-owned level → refused.
  const refusal = withWikiContext(ctx, () => guardConsolidateTarget(proj));
  assert.ok(refusal, "targeting the repo mount is refused");
  assert.equal(refusal.error, SHARED_TARGET_ERROR);

  // Targeting the brain explicitly under the SAME context proceeds.
  assert.equal(
    withWikiContext(ctx, () => guardConsolidateTarget("brain")),
    null,
    "explicit 'brain' target proceeds even in a federated context",
  );
});

// ── normal brain consolidate still runs (regression) ─────────────────────────

test("consolidateMemory (no target) and target:'brain' still consolidate the brain", async () => {
  const body = "# Brain-run dup\n\nIdentical body; a normal brain run dedupes one of these.";
  seedLeaf({
    name: "run-a.md",
    text: body,
    datasetId: "self_improvement",
    metadata: {
      project_module: "runtest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "run-a",
    },
  });
  seedLeaf({
    name: "run-b.md",
    text: body,
    datasetId: "self_improvement",
    metadata: {
      project_module: "runtest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "run-b",
    },
  });

  // target:'brain' is accepted and runs.
  const r = await consolidateMemory({
    dryRun: false,
    llm: false,
    passes: ["dedupe-by-sha256"],
    target: "brain",
    now: FROZEN_NOW,
  });
  assert.equal(r.ok, true, "brain target proceeds");
  assert.ok(r.totals.archived >= 1, "a brain-owned duplicate was archived");
  assert.ok(disabledNames().includes("run-b.md"), "the deterministic loser run-b.md was archived");
});

// ── cron brain-only invariant ────────────────────────────────────────────────

test("cron brain-only: consolidate re-scopes to the env brain even under an ambient multi-level context", async () => {
  // Seed a dup pair in the ENV brain. If consolidate honoured the ambient
  // context below (whose brain is a DIFFERENT, empty tree), it would walk that
  // empty tree and archive nothing here.
  const body = "# Cron dup\n\nIdentical body in the env brain; only a brain-scoped run dedupes it.";
  seedLeaf({
    name: "cron-a.md",
    text: body,
    datasetId: "self_improvement",
    metadata: {
      project_module: "crontest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "cron-a",
    },
  });
  seedLeaf({
    name: "cron-b.md",
    text: body,
    datasetId: "self_improvement",
    metadata: {
      project_module: "crontest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "cron-b",
    },
  });

  // Build an ambient context whose brain + repo mount live under a DIFFERENT
  // home, then run consolidate inside it. consolidateMemory wraps its body in
  // withBrainContextSafe (no opts), which resolves the brain from
  // MEMORY_DATA_DIR — the env brain — regardless of this ambient frame.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-iso-cron-"));
  tmpDirs.push(home);
  const layout = "layout:\n  - path: knowledge\n  - path: daily\n";
  const mkMount = (dir) => {
    const ld = path.join(dir, ".llm-wiki-memory", "wiki", ".layout");
    fs.mkdirSync(ld, { recursive: true });
    fs.writeFileSync(path.join(ld, "layout.yaml"), layout);
    return dir;
  };
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"));
  const ambient = resolveWikiContext([proj], {
    home,
    brainDataDir: path.join(home, ".llm-wiki-memory"),
  });
  const repoMountWikiRoot = ambient.levels[1].root;

  const r = await withWikiContext(ambient, () =>
    consolidateMemory({
      dryRun: false,
      llm: false,
      passes: ["dedupe-by-sha256"],
      now: FROZEN_NOW,
    }),
  );

  assert.equal(r.ok, true);
  assert.ok(
    r.workingSetSize >= 2,
    "the env brain's leaves were walked, not the empty ambient brain",
  );
  assert.ok(
    disabledNames().includes("cron-b.md"),
    "consolidate archived the env brain's duplicate — it re-scoped to the brain, ignoring the ambient context",
  );

  // The ambient repo mount tree was never written (no shared writes).
  const repoLeaves = fs
    .readdirSync(repoMountWikiRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."));
  assert.equal(repoLeaves.length, 0, "the ambient repo mount received no category writes");
});
