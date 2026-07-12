// Phase M e2e — federation INSTALL surface: real `cmdInit`, real `initMount`,
// real git check-ignore matrix (both directions), host-shadow refusal, and the
// clone-adopt regenerate-not-converge guard. Lexical backend; realpath'd /tmp.
//
// §6 items covered: (1) install matrix + gitignore negation, (10) host
// .gitignore shadowing surfaces an actionable error, (9) clone-adopt rebuilds
// indexes without clobbering committed shared leaves.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  SRC,
  MOUNT_INIT,
  SKILL_CLI,
  realTmp,
  rmAll,
  gitInit,
  isIgnored,
  writeMountLayout,
  seedLeafFile,
  cliEnv,
  writeLexicalSettings,
  runInit,
} from "./e2e-federation-helpers.mjs";

const { initMount } = await import("../scripts/mount-init.mjs");

/** @type {string[]} */
const tmps = [];
after(() => rmAll(tmps));

const R = ".llm-wiki-memory/wiki";

// A recording stand-in for the skill CLI: log the subcommand, forward to the
// real one so the wiki is genuinely rebuilt (proves regenerate vs converge).
const SPY_SRC = `import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SKILL_SPY_LOG, (args[0] ?? "") + "\\n");
const r = spawnSync(process.execPath, [process.env.SKILL_SPY_REAL, ...args], {
  stdio: "inherit", env: process.env,
});
process.exit(r.status ?? 1);
`;

// §6.1 — brain install via the real cmdInit entrypoint --------------------------
test("install: cmdInit --template default provisions the 5-category brain", () => {
  const brain = realTmp("inst-brain");
  tmps.push(brain);
  writeLexicalSettings(brain);

  const r = runInit(brain, ["--template", "default"]);
  assert.equal(r.status, 0, `init exited non-zero: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.template, "default");
  assert.equal(parsed.wiki, path.join(brain, "wiki"));
  assert.ok(fs.existsSync(parsed.contract), "layout.yaml contract written");

  const layout = fs.readFileSync(parsed.contract, "utf8");
  for (const cat of ["knowledge", "self_improvement", "plans", "investigations", "daily"]) {
    assert.match(layout, new RegExp(`- path: ${cat}\\b`), `default layout declares ${cat}`);
  }
  assert.ok(!/ownership:\s*repo/.test(layout), "the default brain has no repo-owned category");
});

// §6.1 — shared mount install + git check-ignore matrix, BOTH directions --------
test("install: a shared mount tracks ONLY shared categories (check-ignore both directions)", () => {
  const repo = realTmp("inst-shared");
  tmps.push(repo);
  gitInit(repo);

  const res = initMount(repo);
  assert.equal(res.gitignore, true, "mount .gitignore generated");
  assert.equal(res.seeded, "repo", "knowledge-only repo template seeded");
  assert.equal(/** @type {{ ok: boolean }} */ (res.hostIgnore).ok, true, "not host-ignored");
  assert.equal(/** @type {{ ok: boolean }} */ (res.syncHook).ok, true, "sync hook installed");
  assert.ok(
    fs.existsSync(path.join(repo, ".llm-wiki-memory", "personal", ".git")),
    "private personal git initialised",
  );

  const wiki = path.join(repo, R);
  // Materialise the concrete tree the matrix inspects: a subject-first shared
  // leaf (TRACKED), a personal category + personal layout override + generated
  // caches/index (IGNORED).
  seedLeafFile(wiki, "knowledge/architecture/reference/leaf.md", "# Shared\n\nrepo-owned body\n");
  seedLeafFile(wiki, "knowledge/architecture/reference/index.md", "idx\n");
  seedLeafFile(wiki, "knowledge/index.md", "idx\n");
  seedLeafFile(wiki, "knowledge/architecture/.embeddings/embeddings.json", "{}\n");
  seedLeafFile(wiki, "self_improvement/personal-lesson.md", "# Personal\n\nnot shared\n");
  fs.writeFileSync(path.join(wiki, ".layout", "layout.local.yaml"), "layout: []\n");

  // TRACKED (not ignored):
  assert.equal(
    isIgnored(repo, `${R}/knowledge/architecture/reference/leaf.md`),
    false,
    "shared leaf tracked",
  );
  assert.equal(
    isIgnored(repo, `${R}/.layout/layout.yaml`),
    false,
    "shared layout contract tracked",
  );
  // IGNORED:
  assert.equal(
    isIgnored(repo, `${R}/.layout/layout.local.yaml`),
    true,
    "personal layout override ignored",
  );
  assert.equal(
    isIgnored(repo, `${R}/self_improvement/personal-lesson.md`),
    true,
    "personal category ignored",
  );
  assert.equal(
    isIgnored(repo, `${R}/knowledge/architecture/.embeddings/embeddings.json`),
    true,
    ".embeddings cache ignored inside a tracked category",
  );
  assert.equal(isIgnored(repo, `${R}/knowledge/index.md`), true, "generated root index.md ignored");
  assert.equal(
    isIgnored(repo, `${R}/knowledge/architecture/reference/index.md`),
    true,
    "generated nested index.md ignored",
  );
});

// §6.10 — a host repo already ignoring the mount surfaces an actionable error ----
test("install: a host .gitignore that shadows the mount fails LOUD (not silently)", () => {
  const repo = realTmp("inst-hostign");
  tmps.push(repo);
  gitInit(repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), "/.llm-wiki-memory\n");
  writeMountLayout(repo, "layout:\n  - path: knowledge\n    ownership: repo\n");

  // Drive the REAL install entrypoint (mount-init.mjs) as a subprocess: it must
  // surface the host-shadow as a non-fatal but visible WARNING + hostIgnore:false.
  const r = spawnSync(process.execPath, [MOUNT_INIT, repo], {
    encoding: "utf8",
    env: cliEnv(repo),
  });
  assert.equal(r.status, 0, "install entrypoint still exits 0 (non-fatal)");
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hostIgnore.ok, false, "host-shadow detected");
  assert.match(parsed.hostIgnore.message, /git-ignored by the enclosing repo/);
  assert.match(
    r.stderr,
    /WARNING:.*git-ignored by the enclosing repo/,
    "actionable warning on stderr",
  );
});

// §6.9 — a fresh clone regenerates indexes, never runs the destructive converge --
test("install: clone-adopt REGENERATES indexes and preserves committed shared leaves", () => {
  const mount = realTmp("inst-clone");
  tmps.push(mount);
  const dataDir = path.join(mount, ".llm-wiki-memory");
  const wiki = path.join(dataDir, "wiki");
  writeLexicalSettings(dataDir);

  // A clone carries the tracked repo layout + shared leaves, but NOT the
  // gitignored index.md (so the root index is absent — the recovery trigger).
  fs.mkdirSync(path.join(wiki, ".layout"), { recursive: true });
  fs.copyFileSync(
    path.join(SRC, "examples/layouts/repo/layout.yaml"),
    path.join(wiki, ".layout", "layout.yaml"),
  );
  const leaves = [
    ["knowledge/architecture/reference/leaf-a.md", "# A\n\n- type: reference\n\nBody A.\n"],
    ["knowledge/tooling/pattern-gotcha/leaf-b.md", "# B\n\n- type: pattern-gotcha\n\nBody B.\n"],
  ];
  for (const [rel, body] of leaves) seedLeafFile(wiki, rel, body);
  const before = leaves.map(([rel, body]) => ({ rel, body }));
  assert.equal(fs.existsSync(path.join(wiki, "index.md")), false, "clone has no root index.md");

  // Run init with the skill spy to observe WHICH engine path fired.
  const spyDir = path.join(dataDir, "spy");
  fs.mkdirSync(spyDir, { recursive: true });
  const spyPath = path.join(spyDir, "skill-spy.mjs");
  const logPath = path.join(spyDir, "skill.log");
  fs.writeFileSync(spyPath, SPY_SRC);
  fs.writeFileSync(logPath, "");
  const r = runInit(dataDir, [], {
    LLM_WIKI_SKILL_CLI: spyPath,
    SKILL_SPY_LOG: logPath,
    SKILL_SPY_REAL: SKILL_CLI,
  });
  assert.equal(r.status, 0, `clone-adopt init exited non-zero: ${r.stderr}`);

  const log = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  assert.ok(log.includes("index-rebuild"), `regenerated indexes (log: ${log.join(",")})`);
  assert.ok(!log.includes("build"), `never ran the destructive converge (log: ${log.join(",")})`);
  assert.equal(fs.existsSync(path.join(wiki, "index.md")), true, "root index.md regenerated");

  // Every committed shared leaf is byte-identical and in place after adoption.
  for (const { rel, body } of before) {
    assert.equal(
      fs.readFileSync(path.join(wiki, rel), "utf8"),
      body,
      `${rel} preserved byte-for-byte`,
    );
  }
});
