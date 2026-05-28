// Tests for scripts/lib/work-context.mjs — branch detection +
// search-driven section composition. `searchMemory` is injected so
// the tests are deterministic (no Xenova model load, no wiki I/O).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  detectActiveContext,
  buildWorkContextSection,
} from "../scripts/lib/work-context.mjs";

function initRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-repo-"));
  spawnSync("git", ["init", "-q", "-b", branch || "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "ok\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

// ---------------------------------------------------------------------------
// detectActiveContext
// ---------------------------------------------------------------------------

test("detectActiveContext: returns null outside a git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-no-git-"));
  assert.equal(detectActiveContext(dir), null);
});

test("detectActiveContext: returns null on a 'blank-slate' branch (main/master/develop)", () => {
  const repo = initRepo("main");
  assert.equal(detectActiveContext(repo), null);
});

test("detectActiveContext: returns { cwd, branch, repo, repoRoot } on a feature branch", () => {
  const repo = initRepo("main");
  spawnSync("git", ["checkout", "-q", "-b", "feature/DEV-129957-investigate"], {
    cwd: repo,
  });
  const r = detectActiveContext(repo);
  assert.ok(r);
  assert.equal(r.branch, "feature/DEV-129957-investigate");
  assert.equal(r.cwd, repo);
  assert.ok(r.repoRoot);
});

test("detectActiveContext: works on a branch with no Jira-style key (semantic-only)", () => {
  const repo = initRepo("main");
  spawnSync("git", ["checkout", "-q", "-b", "fix-hermes-timeout"], { cwd: repo });
  const r = detectActiveContext(repo);
  assert.ok(r);
  assert.equal(r.branch, "fix-hermes-timeout");
});

// ---------------------------------------------------------------------------
// buildWorkContextSection
// ---------------------------------------------------------------------------

test("buildWorkContextSection: returns empty when not in a feature branch", async () => {
  const repo = initRepo("main");
  const r = await buildWorkContextSection({
    cwd: repo,
    searchMemory: async () => ({ records: [] }),
  });
  assert.equal(r, "");
});

test("buildWorkContextSection: returns empty when search returns no records", async () => {
  const repo = initRepo("main");
  spawnSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: repo });
  const r = await buildWorkContextSection({
    cwd: repo,
    searchMemory: async () => ({ records: [] }),
  });
  assert.equal(r, "");
});

test("buildWorkContextSection: returns empty when searchMemory throws", async () => {
  const repo = initRepo("main");
  spawnSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: repo });
  const r = await buildWorkContextSection({
    cwd: repo,
    searchMemory: async () => {
      throw new Error("simulated search failure");
    },
  });
  assert.equal(r, "");
});

test("buildWorkContextSection: composes a markdown section from top hits", async () => {
  const repo = initRepo("main");
  spawnSync("git", ["checkout", "-q", "-b", "feature/DEV-129957-investigate"], {
    cwd: repo,
  });
  const fakeSearch = async ({ query, maxResults }) => {
    assert.equal(query, "feature/DEV-129957-investigate", "branch is the verbatim query");
    return {
      records: [
        { documentId: "issues/JIRA/DEV/129/95/7/DEV-129957.md", score: 0.84 },
        { documentId: "knowledge/scala/concept/foo.md", score: 0.71 },
      ],
    };
  };
  const section = await buildWorkContextSection({
    cwd: repo,
    searchMemory: fakeSearch,
  });
  assert.match(section, /## Current-work context/);
  assert.match(section, /Branch.*feature\/DEV-129957-investigate/);
  assert.match(section, /issues\/JIRA\/DEV\/129\/95\/7\/DEV-129957\.md.*0\.840/);
  assert.match(section, /knowledge\/scala\/concept\/foo\.md/);
});

test("buildWorkContextSection: surfaces plan-file progress alongside the path", async () => {
  const repo = initRepo("main");
  spawnSync("git", ["checkout", "-q", "-b", "feature/DEV-129957-investigate"], {
    cwd: repo,
  });
  // Stage a fake wiki with one plan file carrying frontmatter progress.
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-"));
  const planRel = "issues/JIRA/DEV/129/95/7/in-progress/plan.plan.md";
  fs.mkdirSync(path.join(wikiRoot, path.dirname(planRel)), { recursive: true });
  fs.writeFileSync(
    path.join(wikiRoot, planRel),
    `---
status: in-progress
progress:
  total: 12
  done: 4
  label: "4/12"
---

body
`,
  );
  const section = await buildWorkContextSection({
    cwd: repo,
    searchMemory: async () => ({ records: [{ documentId: planRel, score: 0.6 }] }),
    wikiRoot,
  });
  assert.match(section, /4\/12 done/);
  assert.match(section, /in-progress/);
});

test("buildWorkContextSection: tracker-agnostic — works with plain branch names too", async () => {
  // No "DEV-" anywhere; the query is the literal branch text. The semantic
  // search would still rank wiki content; the section composes the same way.
  const repo = initRepo("main");
  spawnSync("git", ["checkout", "-q", "-b", "fix-hermes-cassandra-timeout"], {
    cwd: repo,
  });
  const section = await buildWorkContextSection({
    cwd: repo,
    searchMemory: async ({ query }) => {
      assert.equal(query, "fix-hermes-cassandra-timeout");
      return { records: [{ documentId: "knowledge/scala/concept/cats-effect-resource.md", score: 0.55 }] };
    },
  });
  assert.match(section, /fix-hermes-cassandra-timeout/);
  assert.match(section, /cats-effect-resource\.md/);
});
