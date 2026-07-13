// Phase F — write + mutate routing.
//
// A write defaults to the BRAIN (the user's private memory tree); an explicit
// `target` routes it into a chosen context level's working tree. The engine
// runs ZERO git against a shared (repo-owned) level — a shared write lands in
// the working tree and STOPS (R11: "commit and push it yourself"). Facet
// placement pre-validates the note's `subject` against the TARGET level's merged
// layout and remaps an out-of-vocab domain to `general` instead of throwing
// (R2). Mutations resolve the RELATIVE documentId against the chosen level, not
// the brain default, and fall back to the brain when the scope is omitted (R4).
//
// The federation is built under a controlled temp HOME (so the scope scanner,
// which walks up to home, discovers the shared repo) with the LEXICAL backend.
// The two wikis are fully materialised via `cli.mjs init`, so real
// saveDocument / updateDocMetadata / delete / move exercise the whole write
// path — including the skill-driven index rebuild — against each level's root.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "./harness.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-wroute-"));
const brainData = path.join(home, ".llm-wiki-memory");
const sharedMount = path.join(home, "shared-repo");
const sharedData = path.join(sharedMount, ".llm-wiki-memory");

// Settings are brain-global (read from MEMORY_DATA_DIR regardless of which
// level a write is routed to): pin the lexical backend and auto-commit ON, so
// the zero-git assertion proves the guard holds even with commits enabled.
process.env.MEMORY_DATA_DIR = brainData;
process.env.MEMORY_DEFAULT_PROJECT_MODULE = "brainmod";
process.env.LLM_WIKI_SKILL_CLI = path.join(
  SRC,
  "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs",
);
process.env.LLM_WIKI_FIXED_TIMESTAMP = process.env.LLM_WIKI_FIXED_TIMESTAMP || "1700000000";
process.env.LLM_WIKI_NO_PROMPT = "1";

function writeSettings(dataDir) {
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "settings", "settings.yaml"),
    "embed:\n  backend: lexical\nwiki:\n  autoCommit: true\nconsolidate:\n  enabled: false\n",
  );
}

function initWikiAt(dataDir) {
  writeSettings(dataDir);
  const r = spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), "init"], {
    env: { ...process.env, MEMORY_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`init failed for ${dataDir}: ${r.stderr || r.stdout}`);
  return path.join(dataDir, "wiki");
}

function git(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

initWikiAt(brainData);
initWikiAt(sharedData);

// A curated (facet-less, non-topology) category so move_document — which refuses
// facet + topology + daily categories — has a legal home to relocate within.
for (const d of [brainData, sharedData]) {
  fs.writeFileSync(
    path.join(d, "wiki", ".layout", "layout.local.yaml"),
    "layout:\n  - path: notes\n    placement_facets: []\n    consolidate: none\n",
  );
}

// Turn the shared mount into its OWN git repo (its .git sits at the repo root,
// NOT at the wiki root two levels down), so `gitUsable(<sharedWikiRoot>)` is
// false and the engine never runs git there.
git(sharedMount, ["init", "-q"]);
git(sharedMount, ["config", "user.email", "t@t.local"]);
git(sharedMount, ["config", "user.name", "tester"]);
git(sharedMount, ["remote", "add", "origin", "git@github.com:acme/shared-repo.git"]);
fs.writeFileSync(path.join(sharedMount, "repo.txt"), "tracked file\n");
git(sharedMount, ["add", "repo.txt"]);
git(sharedMount, ["commit", "-q", "-m", "init"]);

const store = await import("../scripts/lib/wiki-store.mjs");
const { withWikiCommit } = await import("../scripts/lib/wiki-commit.mjs");
const { resolveWikiContext, withWikiContext, resolveTargetLevel } =
  await import("../scripts/lib/wiki-context.mjs");
const { withWriteTarget } = await import("../mcp-server/mcp-write-target.mjs");

const ctx = resolveWikiContext([sharedMount], { home, brainDataDir: brainData });
const brainLevel = ctx.levels[0];
const sharedLevel = ctx.levels[1];
const brainRoot = brainLevel.root;
const sharedRoot = sharedLevel.root;

after(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const abs = (root, rel) => path.join(root, rel.split("/").join(path.sep));

// Route a save the way the MCP write tools do: inside the active context, into
// the chosen target level, under one wiki commit.
function saveTo(target, args) {
  return withWikiContext(ctx, () =>
    withWriteTarget(target, () =>
      withWikiCommit({ op: "test-save", actor: "test" }, () => store.saveDocument(args)),
    ),
  );
}

// ─── context shape sanity ────────────────────────────────────────────────────

test("federation resolves brain(d0, wiki) under shared-repo(d1, repo)", () => {
  assert.equal(ctx.levels.length, 2, "brain + one shared repo");
  assert.equal(brainLevel.ownership, "wiki");
  assert.equal(sharedLevel.ownership, "repo");
  assert.equal(ctx.writeDefault, brainLevel, "writeDefault is the brain");
  assert.equal(
    sharedLevel.projectModule,
    "acme/shared-repo",
    "repo mount resolves to its canonical git org/repo identity",
  );
});

// ─── resolveTargetLevel selector semantics ───────────────────────────────────

test("resolveTargetLevel: omitted / null / '' resolve to the brain (writeDefault)", () => {
  assert.equal(resolveTargetLevel(ctx, undefined), brainLevel);
  assert.equal(resolveTargetLevel(ctx, null), brainLevel);
  assert.equal(resolveTargetLevel(ctx, ""), brainLevel);
});

test("resolveTargetLevel: the literal 'brain' selects the wiki-owned level", () => {
  assert.equal(resolveTargetLevel(ctx, "brain"), brainLevel);
});

test("resolveTargetLevel: a level's root OR mountDir selects that level", () => {
  assert.equal(resolveTargetLevel(ctx, sharedLevel.root), sharedLevel);
  assert.equal(resolveTargetLevel(ctx, sharedLevel.mountDir), sharedLevel);
  assert.equal(resolveTargetLevel(ctx, brainLevel.root), brainLevel);
  assert.equal(resolveTargetLevel(ctx, brainLevel.mountDir), brainLevel);
});

test("resolveTargetLevel: a target naming no context level throws (never a silent brain fallback)", () => {
  assert.throws(
    () => resolveTargetLevel(ctx, path.join(home, "not-a-mount")),
    /not one of the active context levels/i,
  );
});

// ─── default routing: brain, never a silent shared write ─────────────────────

test("a write with no target lands in the brain, not the shared repo", () => {
  const res = saveTo(undefined, {
    name: "default-lands-brain.md",
    text: "# Default\n\nbody about the default write target.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "routing", subject: ["general"] },
  });
  const rel = "knowledge/routing/reference/general/default-lands-brain.md";
  assert.equal(res.created.document.id, rel);
  assert.ok(fs.existsSync(abs(brainRoot, rel)), "leaf materialised under the brain tree");
  assert.ok(!fs.existsSync(abs(sharedRoot, rel)), "nothing written under the shared tree");
});

test("a normal save with the shared level MERELY IN SCOPE still goes to the brain", () => {
  // The shared repo is part of the resolved context, but with no explicit
  // target the engine must never write to it.
  saveTo(undefined, {
    name: "in-scope-not-target.md",
    text: "# In scope\n\nthe shared repo is in context but not the target.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "routing", subject: ["general"] },
  });
  const rel = "knowledge/routing/reference/general/in-scope-not-target.md";
  assert.ok(fs.existsSync(abs(brainRoot, rel)), "brain got the leaf");
  assert.ok(!fs.existsSync(abs(sharedRoot, rel)), "shared repo untouched");
});

// ─── explicit shared target: working-tree only, ZERO engine git ──────────────

test("target=shared writes into the shared repo working tree with ZERO engine git", () => {
  const headBefore = git(sharedMount, ["rev-parse", "HEAD"]).stdout.trim();
  const indexBefore = fs.readFileSync(path.join(sharedMount, ".git", "index"));

  const res = saveTo(sharedLevel.root, {
    name: "shared-note.md",
    text: "# Shared\n\nbody about a shared write.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "routing", subject: ["general"] },
  });
  const rel = "knowledge/routing/reference/general/shared-note.md";
  assert.ok(fs.existsSync(abs(sharedRoot, rel)), "leaf materialised under the shared tree");
  assert.ok(!fs.existsSync(abs(brainRoot, rel)), "nothing written under the brain tree");

  const headAfter = git(sharedMount, ["rev-parse", "HEAD"]).stdout.trim();
  const indexAfter = fs.readFileSync(path.join(sharedMount, ".git", "index"));
  assert.equal(headAfter, headBefore, "shared repo HEAD unchanged (engine ran no commit)");
  assert.ok(indexBefore.equals(indexAfter), "shared repo git index byte-identical (no staging)");
  assert.equal(res.created.document.id, rel, "result reports the relative leaf path");
});

// ─── facet pre-validation: out-of-vocab subject remaps to general (R2) ───────

test("saveDocument still THROWS on an out-of-vocab subject when it is NOT remapped", () => {
  assert.throws(
    () =>
      saveTo(sharedLevel.root, {
        name: "raw-out-of-vocab.md",
        text: "# Raw\n\nunremapped out-of-vocab subject.",
        datasetId: "knowledge",
        metadata: { atom_type: "reference", area: "routing", subject: ["quantumphysics"] },
      }),
    /not in vocabulary/i,
    "the deep placement throw is preserved as the last-resort net",
  );
});

test("remapUnknownPathFacets rewrites an out-of-vocab domain to the layout fallback", () => {
  const { metadata, remaps } = withWikiContext(ctx, () =>
    withWriteTarget(sharedLevel.root, () =>
      store.remapUnknownPathFacets("knowledge", {
        atom_type: "reference",
        area: "routing",
        subject: ["quantumphysics", "entanglement"],
      }),
    ),
  );
  assert.deepEqual(
    metadata.subject,
    ["general", "entanglement"],
    "first segment remapped, rest kept",
  );
  assert.deepEqual(remaps, [{ facet: "subject", from: "quantumphysics", to: "general" }]);
});

test("an in-vocab subject is left untouched by the remap (no false positives)", () => {
  const { metadata, remaps } = withWikiContext(ctx, () =>
    withWriteTarget(sharedLevel.root, () =>
      store.remapUnknownPathFacets("knowledge", {
        atom_type: "reference",
        area: "routing",
        subject: ["observability", "kamon"],
      }),
    ),
  );
  assert.deepEqual(metadata.subject, ["observability", "kamon"]);
  assert.equal(remaps.length, 0);
});

test("a shared write with a remapped out-of-vocab subject lands under general and does NOT throw", () => {
  let res;
  assert.doesNotThrow(() => {
    res = withWikiContext(ctx, () =>
      withWriteTarget(sharedLevel.root, () => {
        const { metadata } = store.remapUnknownPathFacets("knowledge", {
          atom_type: "reference",
          area: "routing",
          subject: ["quantumphysics", "entanglement"],
        });
        return withWikiCommit({ op: "test", actor: "test" }, () =>
          store.saveDocument({
            name: "remapped.md",
            text: "# Remapped\n\nout-of-vocab subject, remapped to general.",
            datasetId: "knowledge",
            metadata,
          }),
        );
      }),
    );
  });
  assert.match(
    res.created.document.id,
    /^knowledge\/routing\/reference\/general\/entanglement\/remapped\.md$/,
  );
  assert.ok(fs.existsSync(abs(sharedRoot, res.created.document.id)), "leaf under the shared tree");
});

// ─── mutate routing: explicit scope hits that level's leaf (R4) ──────────────

test("delete_document with an explicit scope deletes the SHARED leaf, not the brain's same-relpath leaf", () => {
  const rel = "knowledge/routing/reference/general/dup-delete.md";
  const args = (name) => ({
    name,
    text: "# Dup\n\nsame relpath in both trees.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "routing", subject: ["general"] },
  });
  saveTo(brainLevel.root, args("dup-delete.md"));
  saveTo(sharedLevel.root, args("dup-delete.md"));
  assert.ok(fs.existsSync(abs(brainRoot, rel)) && fs.existsSync(abs(sharedRoot, rel)));

  withWikiContext(ctx, () =>
    withWriteTarget(sharedLevel.root, () =>
      withWikiCommit({ op: "test-del", actor: "test" }, () =>
        store.deleteDocument({ documentId: rel, datasetId: "knowledge" }),
      ),
    ),
  );
  assert.ok(!fs.existsSync(abs(sharedRoot, rel)), "shared leaf deleted");
  assert.ok(fs.existsSync(abs(brainRoot, rel)), "brain leaf at the same relpath untouched");
});

test("delete_document with the scope OMITTED resolves against the brain (back-compat)", () => {
  const rel = "knowledge/routing/reference/general/dup-omit.md";
  const args = (name) => ({
    name,
    text: "# Dup omit\n\nsame relpath in both trees.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "routing", subject: ["general"] },
  });
  saveTo(brainLevel.root, args("dup-omit.md"));
  saveTo(sharedLevel.root, args("dup-omit.md"));

  withWikiContext(ctx, () =>
    withWriteTarget(undefined, () =>
      withWikiCommit({ op: "test-del", actor: "test" }, () =>
        store.deleteDocument({ documentId: rel, datasetId: "knowledge" }),
      ),
    ),
  );
  assert.ok(!fs.existsSync(abs(brainRoot, rel)), "brain leaf deleted (omitted scope -> brain)");
  assert.ok(fs.existsSync(abs(sharedRoot, rel)), "shared leaf untouched");
});

test("updateDocMetadata with an explicit scope stamps the SHARED leaf, not the brain's", () => {
  const rel = "knowledge/routing/reference/general/dup-meta.md";
  const args = (name) => ({
    name,
    text: "# Dup meta\n\nsame relpath in both trees.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "routing", subject: ["general"] },
  });
  saveTo(brainLevel.root, args("dup-meta.md"));
  saveTo(sharedLevel.root, args("dup-meta.md"));

  withWikiContext(ctx, () =>
    withWriteTarget(sharedLevel.root, () =>
      withWikiCommit({ op: "test-meta", actor: "test" }, () =>
        store.updateDocMetadata({
          datasetId: "knowledge",
          documentId: rel,
          metadata: { language: "sharedlang" },
          placementOverride: path.dirname(rel),
        }),
      ),
    ),
  );
  assert.match(
    fs.readFileSync(abs(sharedRoot, rel), "utf8"),
    /language: sharedlang/,
    "shared stamped",
  );
  assert.ok(
    !/language: sharedlang/.test(fs.readFileSync(abs(brainRoot, rel), "utf8")),
    "brain leaf at the same relpath NOT stamped",
  );
});

test("move_document with an explicit scope relocates the SHARED leaf, not the brain's", () => {
  const fromRel = "notes/move-me.md";
  const toRel = "notes/relocated/move-me.md";
  const args = {
    name: "move-me.md",
    text: "# Move me\n\ncurated note, same relpath in both trees.",
    datasetId: "notes",
    metadata: { atom_type: "reference" },
  };
  saveTo(brainLevel.root, args);
  saveTo(sharedLevel.root, args);
  assert.ok(fs.existsSync(abs(brainRoot, fromRel)) && fs.existsSync(abs(sharedRoot, fromRel)));

  const res = withWikiContext(ctx, () =>
    withWriteTarget(sharedLevel.root, () =>
      withWikiCommit({ op: "test-move", actor: "test" }, () =>
        store.moveDocument({ documentId: fromRel, toPath: toRel, datasetId: "notes" }),
      ),
    ),
  );
  assert.equal(res.moved, true, `move reported: ${JSON.stringify(res)}`);
  assert.ok(!fs.existsSync(abs(sharedRoot, fromRel)), "shared source gone");
  assert.ok(fs.existsSync(abs(sharedRoot, toRel)), "shared leaf at destination");
  assert.ok(fs.existsSync(abs(brainRoot, fromRel)), "brain source untouched");
  assert.ok(!fs.existsSync(abs(brainRoot, toRel)), "brain destination absent");
});
