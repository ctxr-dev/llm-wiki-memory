// Workstream J11 + J12 — federation clone routing + staged shared-recall scope.
// J11: two SAME-ORIGIN clones both in scope fold to one identity but keep
// DISTINCT roots, so a targeted write disambiguates them by path, the resolved
// chain is input-order-independent, and an identity STRING is not a valid write
// target. J12: a staged (uncommitted) shared write is recalled IN scope but
// absent OUT of scope — locally recallable, scope-bounded, never globally leaked.
// Real seams (resolveWikiContext + the write seam + the search fan-out), lexical
// backend, realpath'd temp HOME.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "../harness.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-j1112-")));
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
      withWikiCommit({ op: "j1112", actor: "test" }, () =>
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

test("J11: two SAME-ORIGIN clones both in scope fold to ONE identity but keep DISTINCT roots — a targeted write is deterministic", () => {
  const A = path.join(home, "checkouts", "one");
  const B = path.join(home, "checkouts", "two");
  makeMount(A, "git@github.com:acme/shared.git");
  makeMount(B, "https://gitlab.example/acme/shared.git"); // same org/repo, different host/proto
  const ctx = resolveWikiContext([A, B], opts);
  assert.equal(ctx.levels.length, 3, "brain + two same-identity clones");
  const [, la, lb] = ctx.levels;
  assert.equal(la.projectModule, "acme/shared", "clone A folds to the shared identity");
  assert.equal(lb.projectModule, "acme/shared", "clone B folds to the SAME identity");
  assert.notEqual(la.root, lb.root, "identity folds but the two clone roots stay distinct");

  // A targeted write disambiguates two same-identity clones by PATH: each leaf
  // lands only under the clone root it named, never the sibling's.
  const idA = saveTo(ctx, la.root, "j1112-a.md", "clonetok");
  const idB = saveTo(ctx, lb.root, "j1112-b.md", "clonetok");
  assert.ok(
    fs.existsSync(abs(la.root, idA)) && !fs.existsSync(abs(lb.root, idA)),
    "the A-named leaf lands ONLY under clone A's root",
  );
  assert.ok(
    fs.existsSync(abs(lb.root, idB)) && !fs.existsSync(abs(la.root, idB)),
    "the B-named leaf lands ONLY under clone B's root",
  );

  // Determinism: the chain is sorted by mountDir, so reversing the input scope
  // order yields the identical level roots (input-order-independent).
  assert.deepEqual(
    resolveWikiContext([B, A], opts).levels.map((l) => l.root),
    ctx.levels.map((l) => l.root),
    "input order does not change the resolved chain",
  );

  // Refusal: an identity STRING is not a valid write target — only a level's
  // root/mountDir, or "brain". Targeting the identity throws.
  assert.throws(
    () => withWikiContext(ctx, () => withWriteTarget("acme/shared", () => {})),
    /not one of the active context levels/,
    "targeting the identity string throws — an identity is not a level",
  );
});

test("J12: a staged shared write is recalled IN scope but absent OUT of scope — locally recallable, scope-bounded", async () => {
  const svc = path.join(home, "svc");
  makeMount(svc, "git@github.com:acme/svc.git");
  const ctx = resolveWikiContext([svc], opts);
  assert.equal(ctx.levels.length, 2, "brain + the svc repo level");
  const svcLevel = ctx.levels[1];
  assert.equal(svcLevel.projectModule, "acme/svc", "the svc mount folds to its git identity");

  // A repo-target write is only STAGED in the svc working tree (no git ran).
  const id = saveTo(ctx, svcLevel.root, "j1112-shared.md", "sharedrecalltok");
  assert.ok(fs.existsSync(abs(svcLevel.root, id)), "the shared leaf is staged under the svc root");

  // IN scope: resolving svc surfaces the staged leaf, resolved to the svc root.
  const inScope = await withWikiContext(ctx, () =>
    searchMemoryFiltered({ query: "sharedrecalltok", datasetId: "knowledge" }),
  );
  assert.ok(
    inScope.records.some(
      (r) => r.documentName === "j1112-shared.md" && r.resolvedRoot === svcLevel.root,
    ),
    "IN scope, the staged shared leaf is recalled from the svc root",
  );

  // OUT of scope: a brain-only context (svc NOT in scope) never surfaces it.
  const ctxBrain = resolveWikiContext([], opts);
  assert.ok(
    !ctxBrain.levels.some((l) => l.root === svcLevel.root),
    "the svc root is not part of a brain-only chain",
  );
  const outScope = await withWikiContext(ctxBrain, () =>
    searchMemoryFiltered({ query: "sharedrecalltok", datasetId: "knowledge" }),
  );
  assert.ok(
    !outScope.records.some((r) => r.documentName === "j1112-shared.md"),
    "OUT of scope, the staged shared leaf is not recalled (scope-bounded, not globally leaked)",
  );
});
