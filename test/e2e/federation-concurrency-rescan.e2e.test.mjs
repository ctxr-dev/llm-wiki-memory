// Workstream J8 + J9 — concurrency + live re-scan for the federated (layered)
// wiki. J8 proves the AsyncLocalStorage promise wiki-context.mjs makes but never
// exercises directly: two operations in DIFFERENT context frames, interleaved
// concurrently with an await between entering the frame and writing, never
// cross-bleed — each write lands ONLY in its own context's tree, and a target
// drawn from another context's chain is rejected rather than silently accepted.
// J9 proves scope scanning is live per-resolve: a repo wiki mounted mid-session
// becomes targetable on the NEXT resolveWikiContext, no restart. Real seams
// (resolveWikiContext + withWikiContext + the write seam), lexical backend,
// realpath'd temp HOME.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "../harness.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-j89-")));
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
const { withWikiCommit } = await import("../../scripts/lib/wiki-commit.mjs");
const { resolveWikiContext, withWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { withWriteTarget } = await import("../../mcp-server/mcp-write-target.mjs");

after(() => fs.rmSync(home, { recursive: true, force: true }));

const opts = { home, brainDataDir: brainData };
const abs = (/** @type {string} */ r, /** @type {string} */ id) =>
  path.join(r, id.split("/").join(path.sep));

// The write seam composed exactly as `saveTo` in federation-routing-edge does
// (target → commit → saveDocument), but WITHOUT its own context frame, so a
// caller can drive it from inside either a synchronous or a concurrent async
// `withWikiContext`. Returns the created leaf's id (a wiki-relative path).
/** @param {string} target @param {string} name @param {string} token */
function writeLeaf(target, name, token) {
  const res = withWriteTarget(target, () =>
    withWikiCommit({ op: "j89", actor: "test" }, () =>
      store.saveDocument({
        name,
        text: `# ${name}\n\nquokka ${token} body`,
        datasetId: "knowledge",
        metadata: { atom_type: "reference", area: "infra", subject: ["general"] },
      }),
    ),
  );
  return res.created.document.id;
}

const repoA = path.join(home, "repoA");
const repoB = path.join(home, "repoB");
makeMount(repoA, "git@github.com:acme/aaa.git");
makeMount(repoB, "git@github.com:acme/bbb.git");
const ctxA = resolveWikiContext([repoA], opts);
const ctxB = resolveWikiContext([repoB], opts);

test("J8: interleaved writes in two concurrent context frames never cross-bleed", async () => {
  const la = ctxA.levels[1];
  const lb = ctxB.levels[1];
  assert.equal(la.projectModule, "acme/aaa", "repoA identity");
  assert.equal(lb.projectModule, "acme/bbb", "repoB identity");

  // Frame A yields (await) AFTER entering its context but BEFORE writing, so
  // frame B — a DIFFERENT context — runs to completion in the gap. Only correct
  // AsyncLocalStorage restoration makes A resume under ctxA and land in A's tree.
  const [idA, idB] = await Promise.all([
    withWikiContext(ctxA, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return writeLeaf(la.root, "j89-a.md", "aaatoken");
    }),
    withWikiContext(ctxB, async () => writeLeaf(lb.root, "j89-b.md", "bbbtoken")),
  ]);

  assert.ok(
    fs.existsSync(abs(la.root, idA)) && !fs.existsSync(abs(lb.root, idA)),
    "A's leaf lands ONLY under A's tree, never under B's",
  );
  assert.ok(
    fs.existsSync(abs(lb.root, idB)) && !fs.existsSync(abs(la.root, idB)),
    "B's leaf lands ONLY under B's tree, never under A's",
  );
});

test("J8b: a target drawn from ANOTHER context's chain is rejected, not silently accepted", () => {
  assert.throws(
    () => withWikiContext(ctxA, () => withWriteTarget(ctxB.levels[1].root, () => {})),
    /not one of the active context levels/,
    "B's mount root is not in ctxA's chain, so targeting it inside ctxA throws",
  );
});

test("J9: a repo wiki mounted mid-session becomes targetable on the next resolve", () => {
  const ancestor = path.join(home, "j9", "added");
  const someCwd = path.join(ancestor, "deep", "cwd");
  fs.mkdirSync(someCwd, { recursive: true });

  const ctx1 = resolveWikiContext([someCwd], opts);
  assert.equal(ctx1.levels.length, 1, "no mount above someCwd yet — brain-only chain");

  const addedRoot = path.join(ancestor, ".llm-wiki-memory", "wiki");
  assert.throws(
    () => withWikiContext(ctx1, () => withWriteTarget(addedRoot, () => {})),
    /not one of the active context levels/,
    "the not-yet-existing mount is out of scope, so a write targeting it throws",
  );

  makeMount(ancestor, "git@github.com:acme/added.git");
  const ctx2 = resolveWikiContext([someCwd], opts);
  assert.equal(ctx2.levels.length, 2, "the mid-session mount is discovered on re-resolve");
  assert.equal(ctx2.levels[1].projectModule, "acme/added", "the new level resolves its identity");
  assert.equal(ctx2.levels[1].root, addedRoot, "the discovered level's root is the added mount");

  const id = withWikiContext(ctx2, () => writeLeaf(addedRoot, "j89-added.md", "addedtoken"));
  assert.ok(
    fs.existsSync(abs(addedRoot, id)),
    "a write targeting the freshly-mounted level lands in the new tree",
  );
});
