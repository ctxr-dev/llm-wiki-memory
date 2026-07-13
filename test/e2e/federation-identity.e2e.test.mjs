// Workstream C e2e — deterministic project_module identity end-to-end through
// the real seams (buildFakeHome → resolveWikiContext → resolveProjectModuleIdentity
// / validateProjectModuleIdentity / searchMemoryFiltered). Lexical backend,
// realpath'd /tmp. Proves: two same-named non-repo folders get DISTINCT file://
// ids; the same repo cloned twice collapses to ONE org/repo id (centralised, and
// suffix-match gathers its leaves); nested distinct-origin repos build the full
// // chain; a no-own-git sub-package inherits its git ancestor's origin (git walks
// up) unless a project_id distinguishes it; a repo mount with no git and no
// project_id is a SURFACED conflict.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildFakeHome, rmAll, git } from "./federation-helpers.mjs";

const { resolveWikiContext, withWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { resolveProjectModuleIdentity, validateProjectModuleIdentity } =
  await import("../../scripts/lib/project-identity.mjs");
const { searchMemoryFiltered } = await import("../../scripts/lib/wiki-store.mjs");

/** @type {string[]} */
const homes = [];
/** @type {(() => void)[]} */
const restores = [];
after(() => {
  for (const r of restores) r();
  rmAll(homes);
});

/**
 * @param {import("./federation-helpers.mjs").FakeHome} built
 */
function track(built) {
  homes.push(built.home);
  restores.push(built.restore);
  return built;
}

/** @param {string} dir @param {string} url */
function addOrigin(dir, url) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.local"]);
  git(dir, ["config", "user.name", "tester"]);
  git(dir, ["remote", "add", "origin", url]);
}

/** @param {string} wikiRoot @param {string} name @param {string} token @param {string} module */
function writeLeaf(wikiRoot, name, token, module) {
  const dir = path.join(wikiRoot, "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    "memory:",
    "  atom_type: reference",
    `  project_module: ${module}`,
    "---",
    "",
    `${token} body for ${name}.`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, name), fm);
}

/** @param {string} home @param {string} brainDataDir @param {string[]} scopes */
function ctxFor(home, brainDataDir, scopes) {
  return resolveWikiContext(scopes, { home, brainDataDir });
}

test("identity: two same-named non-repo folders resolve to DISTINCT file:// ids", async () => {
  const b = track(
    await buildFakeHome({
      prefix: "c6-samename",
      projectModule: "brainmod",
      mounts: [{ rel: "one/app" }, { rel: "two/app" }],
    }),
  );
  const one = b.mounts.find((m) => m.rel === "one/app");
  const two = b.mounts.find((m) => m.rel === "two/app");
  assert.ok(one && two);
  const idOne = ctxFor(b.home, b.brainDataDir, [one.dir]).levels[1].projectModule;
  const idTwo = ctxFor(b.home, b.brainDataDir, [two.dir]).levels[1].projectModule;
  assert.equal(idOne, `file://${fs.realpathSync(one.dir)}`, "mount one → file:// of its realpath");
  assert.equal(idTwo, `file://${fs.realpathSync(two.dir)}`, "mount two → file:// of its realpath");
  assert.notEqual(idOne, idTwo, "same basename 'app', different absolute path → distinct identity");
});

test("identity: the same repo cloned to two paths collapses to ONE org/repo id, and recall gathers both", async () => {
  const b = track(
    await buildFakeHome({
      prefix: "c6-clone",
      projectModule: "brainmod",
      mounts: [{ rel: "cloneA" }, { rel: "cloneB" }],
    }),
  );
  const a = b.mounts.find((m) => m.rel === "cloneA");
  const c = b.mounts.find((m) => m.rel === "cloneB");
  assert.ok(a && c);
  addOrigin(a.dir, "git@github.com:acme/shared.git");
  addOrigin(c.dir, "https://gitlab.example.com/acme/shared.git");

  const idA = ctxFor(b.home, b.brainDataDir, [a.dir]).levels[1].projectModule;
  const idC = ctxFor(b.home, b.brainDataDir, [c.dir]).levels[1].projectModule;
  assert.equal(idA, "acme/shared", "ssh clone → canonical org/repo");
  assert.equal(idC, "acme/shared", "https clone (different host) → the SAME canonical org/repo");

  writeLeaf(a.wikiRoot, "fromA.md", "clonephoton", "acme/shared");
  writeLeaf(c.wikiRoot, "fromB.md", "clonephoton", "acme/shared");
  const both = ctxFor(b.home, b.brainDataDir, [a.dir, c.dir]);
  const out = await withWikiContext(both, () =>
    searchMemoryFiltered({
      query: "clonephoton",
      datasetId: "knowledge",
      filters: { project_module: "acme/shared" },
      limit: 10,
    }),
  );
  const names = out.records.map((r) => r.documentName).sort();
  assert.deepEqual(names, ["fromA.md", "fromB.md"], "one identity gathers leaves from both clones");
});

test("identity: nested distinct-origin repos build the full // chain (innermost = the child)", async () => {
  const b = track(
    await buildFakeHome({
      prefix: "c6-nested",
      projectModule: "brainmod",
      mounts: [{ rel: "parent" }, { rel: "parent/child" }],
    }),
  );
  const parent = b.mounts.find((m) => m.rel === "parent");
  const child = b.mounts.find((m) => m.rel === "parent/child");
  assert.ok(parent && child);
  addOrigin(parent.dir, "git@github.com:acme/parent.git");
  addOrigin(child.dir, "git@github.com:acme2/child.git");

  const ctx = ctxFor(b.home, b.brainDataDir, [child.dir]);
  const childLevel = ctx.levels[ctx.levels.length - 1];
  assert.equal(childLevel.projectModule, "acme2/child", "the child level's own segment");
  const chain = resolveProjectModuleIdentity(ctx, childLevel);
  assert.equal(chain, "acme/parent//acme2/child", "the full ordered repo chain, outermost→owning");
  assert.ok(
    chain.endsWith("//acme2/child"),
    "the innermost segment (recall suffix key) is the child",
  );
});

test("identity: a no-own-git sub-package inherits its git ancestor's origin (git walks up)", async () => {
  const b = track(
    await buildFakeHome({
      prefix: "c6-subpkg",
      projectModule: "brainmod",
      mounts: [{ rel: "mono" }, { rel: "mono/pkg" }],
    }),
  );
  const mono = b.mounts.find((m) => m.rel === "mono");
  const pkg = b.mounts.find((m) => m.rel === "mono/pkg");
  assert.ok(mono && pkg);
  addOrigin(mono.dir, "git@github.com:acme/mono.git"); // ONLY the parent is a git repo

  const ctx = ctxFor(b.home, b.brainDataDir, [pkg.dir]);
  const pkgLevel = ctx.levels[ctx.levels.length - 1];
  assert.equal(
    pkgLevel.projectModule,
    "acme/mono",
    "no own .git → `git -C pkg` finds the parent repo, so the segment inherits the parent origin",
  );
  const chain = resolveProjectModuleIdentity(ctx, pkgLevel);
  assert.equal(
    chain,
    "acme/mono//acme/mono",
    "without a project_id the sub-package is not distinguished",
  );
  assert.equal(
    validateProjectModuleIdentity(ctx, pkgLevel).ok,
    true,
    "a git-derived segment is portable, so NOT a conflict",
  );
});

test("identity: a project_id on the sub-package distinguishes it (org/repo//declared)", async () => {
  const b = track(
    await buildFakeHome({
      prefix: "c6-projid",
      projectModule: "brainmod",
      mounts: [{ rel: "mono2" }, { rel: "mono2/pkg" }],
    }),
  );
  const mono = b.mounts.find((m) => m.rel === "mono2");
  const pkg = b.mounts.find((m) => m.rel === "mono2/pkg");
  assert.ok(mono && pkg);
  addOrigin(mono.dir, "git@github.com:acme/mono.git");
  const layoutYaml = path.join(pkg.wikiRoot, ".layout", "layout.yaml");
  fs.writeFileSync(
    layoutYaml,
    `project_id: acme/mono-billing\n${fs.readFileSync(layoutYaml, "utf8")}`,
  );

  const ctx = ctxFor(b.home, b.brainDataDir, [pkg.dir]);
  const pkgLevel = ctx.levels[ctx.levels.length - 1];
  assert.equal(pkgLevel.projectModule, "acme/mono-billing", "declared project_id wins the segment");
  assert.equal(
    resolveProjectModuleIdentity(ctx, pkgLevel),
    "acme/mono//acme/mono-billing",
    "the sub-package is now precisely distinguished in the chain",
  );
});

test("identity: a repo mount with no git and no project_id is a SURFACED conflict", async () => {
  const b = track(
    await buildFakeHome({
      prefix: "c6-conflict",
      projectModule: "brainmod",
      mounts: [{ rel: "loner" }],
    }),
  );
  const loner = b.mounts[0];
  const ctx = ctxFor(b.home, b.brainDataDir, [loner.dir]);
  const level = ctx.levels[ctx.levels.length - 1];
  assert.ok(level.projectModule.startsWith("file://"), "no git, no project_id → file:// segment");
  const v = validateProjectModuleIdentity(ctx, level);
  assert.equal(v.ok, false, "the non-portable file:// segment is surfaced");
  if (v.ok) return;
  assert.equal(v.conflicts.length, 1);
  assert.equal(v.conflicts[0].mountDir, level.mountDir, "the conflict names the offending mount");
});
