import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC, setupWorkspace, cleanup } from "./harness.mjs";

const CLI = path.join(SRC, "scripts/cli.mjs");
const REAL_SKILL_CLI = path.join(SRC, "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs");
const LAYOUT_TMPL = path.join(SRC, "templates/llmwiki.layout.yaml");
const BOOTSTRAP = path.join(SRC, "bootstrap.sh");

// A recording stand-in for the skill CLI: it appends the subcommand it was
// asked to run to SKILL_SPY_LOG, then forwards to the REAL skill CLI so the
// wiki is genuinely (re)built. This lets a test assert WHICH engine path init
// took — `index-rebuild` (regenerate, non-destructive) vs `build` (whole-tree
// convergence that would clobber a freshly-cloned shared wiki).
const SPY_SRC = `import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SKILL_SPY_LOG, (args[0] ?? "") + "\\n");
const r = spawnSync(process.execPath, [process.env.SKILL_SPY_REAL, ...args], {
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status ?? 1);
`;

/** @type {string[]} */
const dataDirs = [];
after(() => {
  for (const d of dataDirs) cleanup(d);
});

/**
 * @param {string} wiki
 * @param {string} rel
 * @param {string} body
 */
function seedLeaf(wiki, rel, body) {
  const p = path.join(wiki, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

// Every `.md` leaf under the wiki that is neither a generated index.md nor a
// layout file, returned as sorted { rel, content } so a deepEqual proves count,
// placement, AND byte content are all preserved (a moved/re-clustered/edited
// leaf changes this array).
/**
 * @param {string} wiki
 * @returns {{ rel: string, content: string }[]}
 */
function listLeaves(wiki) {
  /** @type {{ rel: string, content: string }[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ".layout") continue;
        walk(full);
      } else if (ent.name.endsWith(".md") && ent.name !== "index.md") {
        out.push({ rel: path.relative(wiki, full), content: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(wiki);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Run `cli.mjs init` for a workspace with the skill CLI replaced by the spy.
 * @param {string} dataDir
 * @returns {{ status: number | null, stdout: string, stderr: string, log: string[] }}
 */
function runInitWithSpy(dataDir) {
  const spyDir = path.join(dataDir, "spy");
  fs.mkdirSync(spyDir, { recursive: true });
  const spyPath = path.join(spyDir, "skill-spy.mjs");
  const logPath = path.join(spyDir, "skill.log");
  fs.writeFileSync(spyPath, SPY_SRC);
  fs.writeFileSync(logPath, "");
  const r = spawnSync(process.execPath, [CLI, "init"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_DATA_DIR: dataDir,
      LLM_WIKI_SKILL_CLI: spyPath,
      SKILL_SPY_LOG: logPath,
      SKILL_SPY_REAL: REAL_SKILL_CLI,
    },
  });
  const log = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", log };
}

// git check-ignore <path>: exit 0 => ignored, 1 => not ignored.
/**
 * @param {string} repoDir
 * @param {string} rel
 * @returns {boolean}
 */
function isIgnored(repoDir, rel) {
  const r = spawnSync("git", ["-C", repoDir, "check-ignore", "-q", rel], { encoding: "utf8" });
  return r.status === 0;
}

/** @type {string[]} */
const repos = [];
function tmpRepo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-init-gi-")));
  repos.push(d);
  spawnSync("git", ["-C", d, "init", "-q"], { encoding: "utf8" });
  return d;
}
after(() => {
  for (const d of repos) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("fresh clone (leaves present, no index.md): init REGENERATES, never converges", () => {
  const { dataDir, wiki } = setupWorkspace({ init: false });
  dataDirs.push(dataDir);

  // A cloned shared wiki carries its tracked layout contract and leaves, but
  // NEVER its gitignored index.md files.
  fs.mkdirSync(path.join(wiki, ".layout"), { recursive: true });
  fs.copyFileSync(LAYOUT_TMPL, path.join(wiki, ".layout", "layout.yaml"));
  seedLeaf(
    wiki,
    "knowledge/testproj/reference/leaf-a.md",
    "# Leaf A\n\n- type: reference\n- tags: [alpha]\n\nBody of leaf A.\n",
  );
  seedLeaf(
    wiki,
    "knowledge/otherproj/pattern-gotcha/leaf-b.md",
    "# Leaf B\n\n- type: pattern-gotcha\n- tags: [beta]\n\nBody of leaf B.\n",
  );
  seedLeaf(
    wiki,
    "self_improvement/testproj/debugging/leaf-c.md",
    "# Leaf C\n\n- type: self-improvement-lesson\n- tags: [gamma]\n\nBody of leaf C.\n",
  );

  const leavesBefore = listLeaves(wiki);
  assert.equal(leavesBefore.length, 3, "three leaves seeded");
  assert.equal(fs.existsSync(path.join(wiki, "index.md")), false, "clone has no root index.md");

  const { status, log, stderr } = runInitWithSpy(dataDir);
  assert.equal(status, 0, `init exited 0 (stderr: ${stderr})`);

  // The falsifiable core: init took the regenerate path, NOT the destructive
  // whole-tree build convergence that would clobber a cloned wiki.
  assert.ok(log.includes("index-rebuild"), `init regenerated indexes (log: ${log.join(",")})`);
  assert.ok(!log.includes("build"), `init did NOT run build convergence (log: ${log.join(",")})`);

  // Root index.md reappears, carrying the generator marker isWikiRoot keys on.
  const rootIdx = path.join(wiki, "index.md");
  assert.equal(fs.existsSync(rootIdx), true, "root index.md regenerated on clone-adopt");
  assert.match(
    fs.readFileSync(rootIdx, "utf8"),
    /generator:\s*"?skill-llm-wiki/,
    "regenerated root index carries the skill-llm-wiki generator marker",
  );

  // No leaf was moved, re-clustered, deleted, or edited: byte-identical + same
  // paths + same count.
  assert.deepEqual(listLeaves(wiki), leavesBefore, "every leaf preserved in place, byte-for-byte");
});

test("index already present: second init is a no-op — no skill subprocess, wiki unchanged", () => {
  const { dataDir, wiki } = setupWorkspace({ init: true });
  dataDirs.push(dataDir);

  assert.equal(fs.existsSync(path.join(wiki, "index.md")), true, "first init built the root index");
  assert.equal(fs.existsSync(path.join(wiki, ".git")), false, "init does not git-init the wiki");
  const rootBefore = fs.readFileSync(path.join(wiki, "index.md"), "utf8");

  const { status, log } = runInitWithSpy(dataDir);
  assert.equal(status, 0);
  assert.deepEqual(log, [], "index present => the recovery branch is skipped, no skill subprocess");
  assert.equal(
    fs.readFileSync(path.join(wiki, "index.md"), "utf8"),
    rootBefore,
    "root index.md unchanged by the no-op init",
  );
  assert.equal(fs.existsSync(path.join(wiki, ".git")), false, "still no wiki .git after re-init");
});

test("commit-memory gitignore ignores every wiki index.md while leaves stay tracked", () => {
  const bootstrap = fs.readFileSync(BOOTSTRAP, "utf8");
  const pattern = "/.llm-wiki-memory/wiki/**/index.md";

  // The pattern must live in the --commit-memory (brain) branch, so a
  // clone of a committed wiki never carries index.md.
  const commitIdx = bootstrap.indexOf('"$COMMIT_MEMORY" -eq 1');
  assert.ok(commitIdx !== -1, "bootstrap.sh has a --commit-memory branch");
  const elseIdx = bootstrap.indexOf("\nelse", commitIdx);
  const commitBranch = bootstrap.slice(commitIdx, elseIdx === -1 ? undefined : elseIdx);
  assert.ok(
    commitBranch.includes(pattern),
    "bootstrap.sh commit-memory branch ignores the wiki index.md pattern",
  );

  // Prove the pattern's real git semantics with a live repo.
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), pattern + "\n");
  /** @param {string} rel */
  const mk = (rel) => {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x\n");
    return rel;
  };
  const rootIdx = mk(".llm-wiki-memory/wiki/index.md");
  const nestedIdx = mk(".llm-wiki-memory/wiki/knowledge/testproj/reference/index.md");
  const leaf = mk(".llm-wiki-memory/wiki/knowledge/testproj/reference/leaf-a.md");
  const projIdx = mk("src/index.md");

  assert.equal(isIgnored(repo, rootIdx), true, "root wiki index.md ignored");
  assert.equal(isIgnored(repo, nestedIdx), true, "nested wiki index.md ignored");
  assert.equal(isIgnored(repo, leaf), false, "a real knowledge leaf stays tracked");
  assert.equal(
    isIgnored(repo, projIdx),
    false,
    "a project index.md OUTSIDE the wiki stays tracked",
  );
});
