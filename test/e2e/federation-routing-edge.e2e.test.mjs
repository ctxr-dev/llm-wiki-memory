// Workstream F1 — routing DETERMINISM for the overlap/nesting shapes the user
// flagged: the same repo checked out twice, two different repos in one parent, the
// surprising sibling depth tie-break, one identity at two depths, brain sharing,
// and a malformed origin. Real seams (scanScopes/resolveWikiContext + the write
// seam + the search fan-out), lexical backend, realpath'd temp HOME.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "../harness.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-redge-")));
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
const { validateProjectModuleIdentity } = await import("../../scripts/lib/project-identity.mjs");

after(() => fs.rmSync(home, { recursive: true, force: true }));

const opts = { home, brainDataDir: brainData };
const abs = (/** @type {string} */ r, /** @type {string} */ id) =>
  path.join(r, id.split("/").join(path.sep));
/** @param {ReturnType<typeof resolveWikiContext>} ctx @param {string|undefined} target @param {string} name @param {string} token @param {string} [mod] */
function saveTo(ctx, target, name, token, mod) {
  const metadata = {
    atom_type: "reference",
    area: "infra",
    subject: ["general"],
    ...(mod ? { project_module_override: mod } : {}),
  };
  const res = withWikiContext(ctx, () =>
    withWriteTarget(target, () =>
      withWikiCommit({ op: "redge", actor: "test" }, () =>
        store.saveDocument({
          name,
          text: `# ${name}\n\nquokka ${token} body`,
          datasetId: "knowledge",
          metadata,
        }),
      ),
    ),
  );
  return res.created.document.id;
}

test("F1d: two DIFFERENT-origin repos in one parent, both in scope → distinct identities + independent routing", () => {
  const A = path.join(home, "p", "alpha");
  const B = path.join(home, "p", "bravo");
  makeMount(A, "git@github.com:acme/alpha.git");
  makeMount(B, "git@github.com:acme/bravo.git");
  const ctx = resolveWikiContext([A, B], opts);
  assert.equal(ctx.levels.length, 3, "brain + two siblings");
  const [, la, lb] = ctx.levels;
  assert.equal(la.projectModule, "acme/alpha");
  assert.equal(lb.projectModule, "acme/bravo");
  const idA = saveTo(ctx, la.root, "a.md", "alphatok");
  const idB = saveTo(ctx, lb.root, "b.md", "bravotok");
  assert.ok(
    fs.existsSync(abs(la.root, idA)) && !fs.existsSync(abs(lb.root, idA)),
    "A-target lands only in A",
  );
  assert.ok(
    fs.existsSync(abs(lb.root, idB)) && !fs.existsSync(abs(la.root, idB)),
    "B-target lands only in B",
  );
});

test("F1e: equal-depth sibling mounts get SEQUENTIAL depths by alphabetical mountDir — reversed scope input is identical (determinism lock)", () => {
  const A = path.join(home, "q", "aaa");
  const B = path.join(home, "q", "bbb");
  makeMount(A, "git@github.com:acme/aaa.git");
  makeMount(B, "git@github.com:acme/bbb.git");
  const forward = resolveWikiContext([A, B], opts).levels.map((l) => l.root);
  const reversed = resolveWikiContext([B, A], opts).levels.map((l) => l.root);
  assert.deepEqual(reversed, forward, "input order does not change the chain (sorted by mountDir)");
  const roots = forward.slice(1); // drop brain
  assert.ok(
    roots[0].includes(`${path.sep}aaa${path.sep}`),
    "alphabetically-earlier sibling is depth 1",
  );
  assert.ok(
    roots[1].includes(`${path.sep}bbb${path.sep}`),
    "later sibling is depth 2 (higher fan-out boost)",
  );
});

test("F1a: same-repo clone ISOLATION — a save into clone A's tree is unreachable resolving clone B only", async () => {
  const A = path.join(home, "checkouts", "one");
  const B = path.join(home, "checkouts", "two");
  makeMount(A, "git@github.com:acme/shared.git");
  makeMount(B, "https://gitlab.example/acme/shared.git"); // same org/repo, different host/proto
  const ctxA = resolveWikiContext([A], opts);
  const la = ctxA.levels[1];
  assert.equal(la.projectModule, "acme/shared", "clone A identity");
  const idA = saveTo(ctxA, la.root, "only-in-a.md", "isolatok");

  // Resolve clone B ONLY (A not in scope): A's tree is not searched.
  const ctxB = resolveWikiContext([B], opts);
  assert.equal(ctxB.levels[1].projectModule, "acme/shared", "clone B folds to the SAME identity");
  assert.ok(!ctxB.levels.some((l) => l.root === la.root), "clone A's tree is NOT in B's chain");
  const out = await withWikiContext(ctxB, () =>
    searchMemoryFiltered({ query: "isolatok", datasetId: "knowledge" }),
  );
  assert.ok(
    !out.records.some((r) => r.resolvedRoot === la.root),
    "shared identity does NOT cross the scope boundary — A's leaf is unreachable from B alone",
  );
  assert.ok(fs.existsSync(abs(la.root, idA)), "the leaf does exist in A's own tree");
});

test("F1f: the SAME identity at two depths in ONE chain — both trees survive the fan-out, deeper ranks first", async () => {
  const outer = path.join(home, "mono");
  const inner = path.join(outer, "pkg");
  makeMount(outer, "git@github.com:acme/mono.git");
  makeMount(inner, "git@github.com:acme/mono.git"); // same origin at two depths
  const ctx = resolveWikiContext([inner], opts); // [brain, outer(1), inner(2)]
  const [, lo, li] = ctx.levels;
  assert.equal(lo.projectModule, "acme/mono");
  assert.equal(li.projectModule, "acme/mono");
  saveTo(ctx, lo.root, "note.md", "twindepth", lo.projectModule);
  saveTo(ctx, li.root, "note.md", "twindepth", li.projectModule);
  const out = await withWikiContext(ctx, () =>
    searchMemoryFiltered({ query: "twindepth", datasetId: "knowledge" }),
  );
  const roots = out.records.map((r) => r.resolvedRoot);
  assert.ok(
    roots.includes(lo.root) && roots.includes(li.root),
    "both same-identity trees survive (dedupe keys on resolvedRoot)",
  );
  const oi = roots.indexOf(lo.root);
  const ii = roots.indexOf(li.root);
  assert.ok(ii < oi, "the DEEPER (inner, higher depth boost) hit ranks before the shallower one");
});

test("F1h: default (no-target) save is shared via the BRAIN — the same brain tree backs both repo scopes", async () => {
  const A = path.join(home, "s", "svc-a");
  const B = path.join(home, "s", "svc-b");
  makeMount(A, "git@github.com:acme/svc-a.git");
  makeMount(B, "git@github.com:acme/svc-b.git");
  const ctxA = resolveWikiContext([A], opts);
  const ctxB = resolveWikiContext([B], opts);
  assert.equal(ctxA.brain.root, ctxB.brain.root, "both repo scopes resolve the SAME shared brain");
  const id = saveTo(ctxA, undefined, "shared-default.md", "brainshare");
  assert.ok(fs.existsSync(abs(ctxA.brain.root, id)), "default save landed in the brain");
  const out = await withWikiContext(ctxB, () =>
    searchMemoryFiltered({ query: "brainshare", datasetId: "knowledge" }),
  );
  assert.ok(
    out.records.some((r) => r.resolvedRoot === ctxB.brain.root),
    "the brain leaf saved under repoA's scope is found under repoB's scope (cross-repo sharing via the brain)",
  );
});

test("F1i: a real repo with a MALFORMED single-segment origin falls back to file:// and is surfaced as a conflict", () => {
  const R = path.join(home, "weird");
  makeMount(R, "git@host:onlyrepo.git"); // single-segment path → canonicalRepoId returns null
  const ctx = resolveWikiContext([R], opts);
  const lvl = ctx.levels[1];
  assert.ok(
    lvl.projectModule.startsWith("file://"),
    `single-segment origin → file:// (got ${lvl.projectModule})`,
  );
  const result = validateProjectModuleIdentity(ctx, lvl);
  assert.equal(result.ok, false, "a repo resolving to file:// is a surfaced conflict, not ok");
  assert.ok(
    result.conflicts.some((c) => c.mountDir === lvl.mountDir),
    "the file:// level is named in the conflicts list",
  );
});
