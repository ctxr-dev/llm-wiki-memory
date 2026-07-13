// Workstream F2 — routing a save to "THIS folder vs a SUBFOLDER repo": target
// selection among ≥2 non-brain levels of one scope chain (the user's scenario).
// Prior tests only distinguished brain-vs-ONE-repo. Also proves the upward-only
// scan rule (a subfolder mount is addressable only when in scope) and the
// disambiguation edges. Lexical backend, realpath'd temp HOME, real write seam.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "../harness.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-tsel-")));
const brainData = path.join(home, ".llm-wiki-memory");
const repoA = path.join(home, "repoA"); // cwd folder (a mount)
const repoB = path.join(repoA, "sub"); // a subfolder repo (a nested mount)

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
/** @param {string} mountDir @param {string} origin */
function gitMount(mountDir, origin) {
  spawnSync("git", ["-C", mountDir, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", mountDir, "config", "user.email", "t@t.local"], { encoding: "utf8" });
  spawnSync("git", ["-C", mountDir, "config", "user.name", "t"], { encoding: "utf8" });
  spawnSync("git", ["-C", mountDir, "remote", "add", "origin", origin], { encoding: "utf8" });
}

fs.mkdirSync(repoB, { recursive: true });
initWikiAt(brainData);
initWikiAt(path.join(repoA, ".llm-wiki-memory"));
initWikiAt(path.join(repoB, ".llm-wiki-memory"));
gitMount(repoA, "git@github.com:acme/repoA.git");
gitMount(repoB, "git@github.com:acme/repoB.git");

const store = await import("../../scripts/lib/wiki-store.mjs");
const { withWikiCommit } = await import("../../scripts/lib/wiki-commit.mjs");
const { resolveWikiContext, withWikiContext, resolveTargetLevel } =
  await import("../../scripts/lib/wiki-context.mjs");
const { withWriteTarget } = await import("../../mcp-server/mcp-write-target.mjs");

after(() => fs.rmSync(home, { recursive: true, force: true }));

const opts = { home, brainDataDir: brainData };
const KNOWLEDGE = { atom_type: "reference", area: "infra", subject: ["general"] };
const abs = (/** @type {string} */ root, /** @type {string} */ id) =>
  path.join(root, id.split("/").join(path.sep));

/** Save into a chosen target level via the real MCP write seam; returns the leaf id. */
function saveTo(ctx, target, name) {
  const res = withWikiContext(ctx, () =>
    withWriteTarget(target, () =>
      withWikiCommit({ op: "tsel", actor: "test" }, () =>
        store.saveDocument({
          name,
          text: `# ${name}\n\nbody for ${name}`,
          datasetId: "knowledge",
          metadata: KNOWLEDGE,
        }),
      ),
    ),
  );
  return res.created.document.id;
}

test("F2a: a 3-level chain routes a save to THIS repo vs the SUBFOLDER repo vs the brain — each isolated", () => {
  const ctx = resolveWikiContext([repoA, repoB], opts);
  assert.equal(ctx.levels.length, 3, "brain + repoA + repoB");
  const [brain, lvlA, lvlB] = ctx.levels;
  assert.equal(brain.ownership, "wiki");
  assert.ok(lvlA.root.startsWith(repoA) && !lvlA.root.startsWith(repoB), "level 1 is repoA");
  assert.equal(lvlB.root.startsWith(repoB), true, "level 2 is the subfolder repoB (deeper)");

  const idA = saveTo(ctx, lvlA.root, "to-a.md");
  assert.ok(fs.existsSync(abs(lvlA.root, idA)), "saved into repoA's tree");
  assert.ok(!fs.existsSync(abs(lvlB.root, idA)), "NOT in repoB");
  assert.ok(!fs.existsSync(abs(brain.root, idA)), "NOT in the brain");

  const idB = saveTo(ctx, lvlB.root, "to-b.md");
  assert.ok(fs.existsSync(abs(lvlB.root, idB)), "saved into the subfolder repoB's tree");
  assert.ok(!fs.existsSync(abs(lvlA.root, idB)), "NOT in repoA");
  assert.ok(!fs.existsSync(abs(brain.root, idB)), "NOT in the brain");

  const idBrain = saveTo(ctx, undefined, "to-brain.md");
  assert.ok(fs.existsSync(abs(brain.root, idBrain)), "omitted target → the brain");
  assert.ok(
    !fs.existsSync(abs(lvlA.root, idBrain)) && !fs.existsSync(abs(lvlB.root, idBrain)),
    "NOT in either repo",
  );
});

test("F2b: upward-only scan — a subfolder mount OUT of scope is not addressable; targeting it is REFUSED", () => {
  const ctxA = resolveWikiContext([repoA], opts); // cwd = repoA only; repoB is BELOW, not scanned
  assert.equal(ctxA.levels.length, 2, "only brain + repoA — the subfolder mount is not discovered");
  assert.ok(!ctxA.levels.some((l) => l.root.startsWith(repoB)), "repoB absent from the chain");
  const repoBRoot = path.join(repoB, ".llm-wiki-memory", "wiki");
  assert.throws(
    () => resolveTargetLevel(ctxA, repoBRoot),
    /not one of the active context levels/,
    "targeting the out-of-scope subfolder is refused (no silent brain fallback)",
  );
  // Add it to scope → now addressable.
  const ctxAB = resolveWikiContext([repoA, repoB], opts);
  assert.ok(resolveTargetLevel(ctxAB, repoBRoot), "in scope → the subfolder is addressable");
});

test("F2c/F2d: only a FULL realpath-equal root/mountDir selects a level; relative/ambiguous strings are refused", () => {
  const ctx = resolveWikiContext([repoA, repoB], opts);
  const lvlB = ctx.levels[2];
  // Full mountDir and full root both select the same (subfolder) level.
  assert.equal(resolveTargetLevel(ctx, repoB).root, lvlB.root, "full mountDir selects the level");
  assert.equal(resolveTargetLevel(ctx, lvlB.root).root, lvlB.root, "full root selects the level");
  // A bare basename ("sub"), a child of a root, and a relative string all refuse.
  for (const bad of ["sub", path.join(lvlB.root, "knowledge"), "repoA/sub"]) {
    assert.throws(
      () => resolveTargetLevel(ctx, bad),
      /not one of the active context levels/,
      `refuses ${bad}`,
    );
  }
});

test("F2e: target='brain' from a DEEP (subfolder) cwd lands in the brain, absent from both repo trees", () => {
  const ctx = resolveWikiContext([repoB], opts); // cwd = the deep subfolder; walks up to repoA + brain
  assert.equal(ctx.levels.length, 3, "brain + repoA + repoB via the upward walk");
  const [brain, lvlA, lvlB] = ctx.levels;
  const id = saveTo(ctx, "brain", "deep-brain.md");
  assert.ok(fs.existsSync(abs(brain.root, id)), "target='brain' → the wiki brain tree");
  assert.ok(
    !fs.existsSync(abs(lvlA.root, id)) && !fs.existsSync(abs(lvlB.root, id)),
    "absent from both repos",
  );
});
