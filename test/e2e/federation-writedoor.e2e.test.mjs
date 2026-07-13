// Workstream F3 — the federated WRITE DOOR: a knowledge-only brain rejecting a
// default lesson/plan write; a layout.local.yaml-added flat category actually
// LANDING in the right level's tree (and refused where absent); a mixed brain +
// shared write in ONE commit batch. These consume the behaviors the pruned
// G1/L1 corpus rows only gestured at. Lexical backend, realpath'd temp HOME.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "../harness.mjs";

process.env.LLM_WIKI_SKILL_CLI = path.join(
  SRC,
  "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs",
);
process.env.LLM_WIKI_FIXED_TIMESTAMP = process.env.LLM_WIKI_FIXED_TIMESTAMP || "1700000000";
process.env.LLM_WIKI_NO_PROMPT = "1";

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** @param {string} dataDir @param {string} [template] */
function initWikiAt(dataDir, template) {
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "settings", "settings.yaml"),
    "embed:\n  backend: lexical\nwiki:\n  autoCommit: true\nconsolidate:\n  enabled: false\n",
  );
  const args = [
    path.join(SRC, "scripts/cli.mjs"),
    "init",
    ...(template ? ["--template", template] : []),
  ];
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, MEMORY_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`init failed for ${dataDir}: ${r.stderr || r.stdout}`);
}
/** @param {string} p @returns {string} */
function freshHome(p) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  tmps.push(home);
  return home;
}

// `MEMORY_DATA_DIR` is frozen at engine import time (env.mjs `export const`), and
// settings resolve from it even inside a `withWikiRoot` frame. Each test uses its
// OWN fresh brain (different templates) via `resolveWikiContext({ brainDataDir })`,
// so the SETTINGS dir must be pinned HERE — before the imports below — to a
// lexical, autoCommit workspace; otherwise in-process settings leak from whatever
// dir the process was launched with (a non-deterministic backend / autoCommit).
const SETTINGS_DATA_DIR = path.join(freshHome("lwm-wd-settings-"), ".llm-wiki-memory");
process.env.MEMORY_DATA_DIR = SETTINGS_DATA_DIR;
process.env.MEMORY_DEFAULT_PROJECT_MODULE = "brainmod";
fs.mkdirSync(path.join(SETTINGS_DATA_DIR, "settings"), { recursive: true });
fs.writeFileSync(
  path.join(SETTINGS_DATA_DIR, "settings", "settings.yaml"),
  "embed:\n  backend: lexical\nwiki:\n  autoCommit: true\nconsolidate:\n  enabled: false\n",
);

const store = await import("../../scripts/lib/wiki-store.mjs");
const { withWikiCommit } = await import("../../scripts/lib/wiki-commit.mjs");
const { resolveWikiContext, withWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { withWriteTarget } = await import("../../mcp-server/mcp-write-target.mjs");
const commitCount = (/** @type {string} */ repo) =>
  Number(
    spawnSync("git", ["-C", repo, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim() || "0",
  );

test("F3a: a KNOWLEDGE-ONLY brain rejects a default self_improvement / plans write (fail-loud, not silent)", () => {
  const home = freshHome("lwm-wd-a-");
  const brainData = path.join(home, ".llm-wiki-memory");
  initWikiAt(brainData, "repo"); // knowledge-only brain
  const ctx = resolveWikiContext([], { home, brainDataDir: brainData });
  const save = (/** @type {string} */ datasetId) =>
    withWikiContext(ctx, () =>
      withWriteTarget(undefined, () =>
        withWikiCommit({ op: "wd", actor: "test" }, () =>
          store.saveDocument({
            name: "x.md",
            text: "# x\n\nbody long enough to pass",
            datasetId,
            metadata: { atom_type: "reference", area: "infra" },
          }),
        ),
      ),
    );
  for (const cat of ["self_improvement", "plans", "investigations"]) {
    assert.throws(() => save(cat), `a ${cat} write to a knowledge-only brain is refused`);
  }
  // The category the brain DOES declare still works.
  assert.ok(save("knowledge").created.document.id, "knowledge (declared) still writes");
});

test("F3b: a layout.local.yaml-added flat category LANDS in that level's tree; a level without it refuses", () => {
  const home = freshHome("lwm-wd-b-");
  const brainData = path.join(home, ".llm-wiki-memory");
  const repo = path.join(home, "repo");
  initWikiAt(brainData);
  initWikiAt(path.join(repo, ".llm-wiki-memory"));
  spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  // Add a curated flat category ONLY at the repo level via its local overlay.
  fs.writeFileSync(
    path.join(repo, ".llm-wiki-memory", "wiki", ".layout", "layout.local.yaml"),
    "layout:\n  - path: runbooks\n    placement_facets: []\n    consolidate: none\n",
  );
  const ctx = resolveWikiContext([repo], { home, brainDataDir: brainData });
  const [brain, lvl] = ctx.levels;
  const save = (/** @type {import("../../scripts/lib/wiki-context.mjs").WikiLevel} */ target) =>
    withWikiContext(ctx, () =>
      withWriteTarget(target.root, () =>
        withWikiCommit({ op: "wd", actor: "test" }, () =>
          store.saveDocument({
            name: "r.md",
            text: "# r\n\na runbook note",
            datasetId: "runbooks",
            metadata: { atom_type: "reference" },
          }),
        ),
      ),
    );
  const id = save(lvl).created.document.id;
  assert.ok(
    fs.existsSync(path.join(lvl.root, id.split("/").join(path.sep))),
    "runbooks note lands in the repo tree",
  );
  assert.match(id, /^runbooks\//, "under the local-added flat category");
  assert.throws(() => save(brain), "the brain (no runbooks category) refuses the write");
});

test("F3d: a MIXED brain + shared write in ONE commit batch — brain git +1, shared repo zero engine git", () => {
  const home = freshHome("lwm-wd-d-");
  const brainData = path.join(home, ".llm-wiki-memory");
  const shared = path.join(home, "shared");
  initWikiAt(brainData);
  initWikiAt(path.join(shared, ".llm-wiki-memory"));
  const brainWiki = path.join(brainData, "wiki");
  const gitInit = (/** @type {string} */ dir) => {
    spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "config", "user.email", "t@t.local"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "config", "user.name", "t"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "commit", "-qm", "init"], { encoding: "utf8" });
  };
  // The brain's git lives AT its wiki root → gitUsable → brain commits land.
  gitInit(brainWiki);
  // The shared mount's git lives at the REPO root (two levels above its wiki), so
  // gitUsable(<shared wiki>) is false and the engine never commits there.
  gitInit(shared);

  const ctx = resolveWikiContext([shared], { home, brainDataDir: brainData });
  const sharedLvl = ctx.levels.find((l) => l.root.startsWith(fs.realpathSync(shared)));
  assert.ok(sharedLvl, "shared mount level present");
  const brainBefore = commitCount(brainWiki);
  const sharedBefore = commitCount(shared);

  const meta = { atom_type: "reference", area: "infra", subject: ["general"] };
  withWikiContext(ctx, () =>
    withWikiCommit({ op: "mixed", actor: "test" }, () => {
      withWriteTarget(undefined, () =>
        store.saveDocument({
          name: "b.md",
          text: "# b\n\nbrain leaf",
          datasetId: "knowledge",
          metadata: meta,
        }),
      );
      withWriteTarget(sharedLvl.root, () =>
        store.saveDocument({
          name: "s.md",
          text: "# s\n\nshared leaf",
          datasetId: "knowledge",
          metadata: meta,
        }),
      );
    }),
  );
  assert.equal(
    commitCount(brainWiki),
    brainBefore + 1,
    "the brain wiki advanced by exactly one commit",
  );
  assert.equal(commitCount(shared), sharedBefore, "the shared repo saw ZERO engine commits");
});
