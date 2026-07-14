// Workstream J17 (round-1 finding) — a git-merge-conflicted SHARED leaf (invalid
// YAML frontmatter) must NOT abort recall/search across the whole fan-out. Two
// teammates editing the same shared `knowledge` leaf on different branches will
// conflict on a frontmatter line; before the fix, `readLeaf`'s `matter()` threw and
// one poisoned leaf blanked recall for everyone with that repo in scope. The fix
// makes searchOneTree/listDocuments skip an unreadable leaf with a breadcrumb.
// Pollution-safe: env set + wiki init BEFORE the engine import; explicit-opts
// resolveWikiContext; realpath'd temp HOME; leaf names prefixed `jconf-`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "../harness.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-jconf-")));
const brainData = path.join(home, ".llm-wiki-memory");
process.env.MEMORY_DATA_DIR = brainData;
process.env.MEMORY_DEFAULT_PROJECT_MODULE = "brainmod";
process.env.LLM_WIKI_SKILL_CLI = path.join(
  SRC,
  "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs",
);
process.env.LLM_WIKI_FIXED_TIMESTAMP = process.env.LLM_WIKI_FIXED_TIMESTAMP || "1700000000";
process.env.LLM_WIKI_NO_PROMPT = "1";

/** @param {string} dataDir */
function initWikiAt(dataDir) {
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "settings", "settings.yaml"),
    "embed:\n  backend: lexical\nwiki:\n  autoCommit: true\nconsolidate:\n  enabled: false\n",
  );
  const r = spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), "init"], {
    env: { ...process.env, MEMORY_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`init failed for ${dataDir}: ${r.stderr || r.stdout}`);
}
/** @param {string} mountDir @param {string} [origin] */
function makeMount(mountDir, origin) {
  fs.mkdirSync(mountDir, { recursive: true });
  initWikiAt(path.join(mountDir, ".llm-wiki-memory"));
  spawnSync("git", ["-C", mountDir, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", mountDir, "config", "user.email", "t@t.local"], { encoding: "utf8" });
  spawnSync("git", ["-C", mountDir, "config", "user.name", "t"], { encoding: "utf8" });
  if (origin)
    spawnSync("git", ["-C", mountDir, "remote", "add", "origin", origin], { encoding: "utf8" });
}
initWikiAt(brainData);

const store = await import("../../scripts/lib/wiki-store.mjs");
const { searchMemoryFiltered } = store;
const { withWikiCommit } = await import("../../scripts/lib/wiki-commit.mjs");
const { resolveWikiContext, withWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { withWriteTarget } = await import("../../mcp-server/mcp-write-target.mjs");

after(() => fs.rmSync(home, { recursive: true, force: true }));

const opts = { home, brainDataDir: brainData };

/** @param {ReturnType<typeof resolveWikiContext>} ctx @param {string} target @param {string} name @param {string} token */
function saveTo(ctx, target, name, token) {
  const res = withWikiContext(ctx, () =>
    withWriteTarget(target, () =>
      withWikiCommit({ op: "jconf", actor: "test" }, () =>
        store.saveDocument({
          name,
          text: `# ${name}\n\nquokka ${token} body`,
          datasetId: "knowledge",
          metadata: { atom_type: "reference", area: "infra", subject: ["general"] },
        }),
      ),
    ),
  );
  return res.created.document.id;
}

test("a git-conflicted SHARED leaf (invalid YAML frontmatter) does NOT abort recall — valid hits still return", async () => {
  const svc = path.join(home, "svc");
  makeMount(svc, "git@github.com:acme/svc.git");
  const ctx = resolveWikiContext([svc], opts);
  const svcLevel = ctx.levels[1];

  // A valid shared leaf (found by the query) + a valid brain leaf.
  saveTo(ctx, svcLevel.root, "jconf-valid.md", "conflictprobe");
  saveTo(ctx, ctx.levels[0].root, "jconf-brainvalid.md", "conflictprobe");

  // A conflicted leaf written straight into the shared mount's knowledge tree:
  // git merge markers land INSIDE the frontmatter, so gray-matter/js-yaml throws
  // on parse. Placed directly under `knowledge/` (walkLeaves still finds it).
  fs.writeFileSync(
    path.join(svcLevel.root, "knowledge", "jconf-conflicted.md"),
    `---
atom_type: reference
<<<<<<< HEAD
priority: P1
=======
priority: P2
>>>>>>> feature-branch
area: infra
---

# Conflicted leaf

conflictprobe body that would match the query if it parsed.
`,
  );

  // Before the fix this THREW a YAMLException out of the whole fan-out. Now it
  // resolves, skipping the unreadable leaf.
  const out = await withWikiContext(ctx, () =>
    searchMemoryFiltered({ query: "conflictprobe", datasetId: "knowledge" }),
  );
  const names = out.records.map((r) => r.documentName);
  assert.ok(names.includes("jconf-valid.md"), "the valid shared leaf is returned");
  assert.ok(names.includes("jconf-brainvalid.md"), "the valid brain leaf is returned");
  assert.ok(
    !names.includes("jconf-conflicted.md"),
    "the conflicted (unparseable) leaf is skipped, not surfaced",
  );
});

test("listDocuments is likewise resilient to a conflicted shared leaf", async () => {
  const svc2 = path.join(home, "svc2");
  makeMount(svc2, "git@github.com:acme/svc2.git");
  const ctx = resolveWikiContext([svc2], opts);
  saveTo(ctx, ctx.levels[1].root, "jconf-ok.md", "listprobe");
  fs.writeFileSync(
    path.join(ctx.levels[1].root, "knowledge", "jconf-bad.md"),
    `---\natom_type: reference\n<<<<<<< HEAD\narea: a\n=======\narea: b\n>>>>>>> x\n---\n\nbody\n`,
  );
  const listed = await withWikiContext(ctx, () =>
    withWriteTarget(ctx.levels[1].root, () => store.listDocuments({ datasetId: "knowledge" })),
  );
  const names = listed.documents.map((d) => d.name);
  assert.ok(names.includes("jconf-ok.md"), "the valid leaf is listed");
  assert.ok(!names.includes("jconf-bad.md"), "the conflicted leaf is skipped, not thrown on");
});

test("a READ-ONLY shared repo tree does not abort recall — embed-cache persist is best-effort", async () => {
  // The "owner curates, teammate consumes read-only" model: the shared tree isn't
  // writable, so the first search can't create .embeddings/. That write MUST NOT
  // throw out of the fan-out and blank recall. Skip where 0o555 doesn't block writes
  // (root / a mode-ignoring FS).
  const probe = fs.mkdtempSync(path.join(home, "wprobe-"));
  fs.chmodSync(probe, 0o555);
  let modeBlocks = false;
  try {
    fs.writeFileSync(path.join(probe, "x"), "x");
  } catch {
    modeBlocks = true;
  }
  fs.chmodSync(probe, 0o755);
  if (!modeBlocks) return; // running as root or a FS that ignores mode → skip

  const svc3 = path.join(home, "svc3");
  makeMount(svc3, "git@github.com:acme/svc3.git");
  const ctx = resolveWikiContext([svc3], opts);
  saveTo(ctx, ctx.levels[1].root, "jconf-ro-shared.md", "readonlyprobe");
  saveTo(ctx, ctx.levels[0].root, "jconf-ro-brain.md", "readonlyprobe");
  const sharedKnowledge = path.join(ctx.levels[1].root, "knowledge");
  fs.chmodSync(sharedKnowledge, 0o555); // no write → .embeddings/ can't be created
  try {
    const out = await withWikiContext(ctx, () =>
      searchMemoryFiltered({ query: "readonlyprobe", datasetId: "knowledge" }),
    );
    const names = out.records.map((r) => r.documentName);
    assert.ok(names.includes("jconf-ro-brain.md"), "the brain leaf still returns");
    assert.ok(
      names.includes("jconf-ro-shared.md"),
      "the read-only shared leaf still returns (scored from its in-memory vector)",
    );
  } finally {
    fs.chmodSync(sharedKnowledge, 0o755); // restore so after() can clean up
  }
});
