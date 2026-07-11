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
  computeSessionScopes,
  buildScopeSeedSection,
  buildWorkContextSection,
  buildRecentActivitySection,
} from "../scripts/lib/work-context.mjs";

function gitToplevel(dir) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function writeDaily(wikiRoot, y, mo, d, hhmmss, ms, brief, body = "some body text") {
  const dir = path.join(wikiRoot, "daily", y, mo, d);
  fs.mkdirSync(dir, { recursive: true });
  const name = `daily-${y}-${mo}-${d}-${hhmmss}${ms}.md`;
  const fm = brief
    ? `---\nbrief: ${JSON.stringify(brief)}\nmemory:\n  atom_type: daily-capture\n---\n\n${body}\n`
    : `---\nmemory:\n  atom_type: daily-capture\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, name), fm);
  return `daily/${y}/${mo}/${d}/${name}`;
}

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

test("computeSessionScopes: returns just the cwd outside a git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-nogit-"));
  assert.deepEqual(computeSessionScopes(dir), [dir]);
});

test("computeSessionScopes: adds the repo root (cwd first) when cwd is a subdir", () => {
  const repo = initRepo("main");
  const sub = path.join(repo, "pkg", "inner");
  fs.mkdirSync(sub, { recursive: true });
  const scopes = computeSessionScopes(sub);
  assert.equal(scopes[0], sub, "cwd is first, verbatim");
  assert.equal(scopes.length, 2, "the git repo root is appended");
  assert.notEqual(scopes[1], sub, "second entry is the repo root, distinct from cwd");
});

test("computeSessionScopes: dedups when cwd already IS the repo root", () => {
  const repo = initRepo("main");
  const root = gitToplevel(repo);
  assert.ok(root, "repo has a resolvable toplevel");
  assert.deepEqual(computeSessionScopes(root), [root], "no duplicate root entry");
});

test("computeSessionScopes: returns [] when there is no cwd (empty string)", () => {
  assert.deepEqual(computeSessionScopes(""), []);
});

test("buildScopeSeedSection: one line naming the cwd + the REQUIRED scopes arg, within budget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-seed-"));
  const section = buildScopeSeedSection({ cwd: dir });
  assert.match(section, /Memory scopes for this session/);
  assert.ok(section.includes(dir), "names the computed scope (the cwd)");
  assert.match(section, /REQUIRED/, "states the arg is required");
  assert.match(section, /scopes/, "names the scopes argument");
  assert.ok(section.length < 1024, `scopes-seed section under 1KB (got ${section.length})`);
});

test("buildScopeSeedSection: empty string when no scope can be computed (no cwd)", () => {
  // This is the path the SessionStart hook relies on: an uncomputable scope
  // must yield "" so the other injected sections still ship and the hook exits 0.
  assert.equal(buildScopeSeedSection({ cwd: "" }), "");
});

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
  const fakeSearch = async ({ query }) => {
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
      return {
        records: [{ documentId: "knowledge/scala/concept/cats-effect-resource.md", score: 0.55 }],
      };
    },
  });
  assert.match(section, /fix-hermes-cassandra-timeout/);
  assert.match(section, /cats-effect-resource\.md/);
});

test("buildWorkContextSection: caps plans to planContextMax and prefers in-progress", async () => {
  const repo = initRepo("main");
  spawnSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: repo });
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-plans-"));
  const mkPlan = (rel, status) => {
    fs.mkdirSync(path.join(wikiRoot, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(
      path.join(wikiRoot, rel),
      `---\nstatus: ${status}\nprogress:\n  label: "1/3"\n---\n\nbody\n`,
    );
  };
  mkPlan("plans/a.plan.md", "done");
  mkPlan("plans/b.plan.md", "done");
  mkPlan("plans/c.plan.md", "in-progress");
  const records = [
    { documentId: "plans/a.plan.md", score: 0.9 },
    { documentId: "plans/b.plan.md", score: 0.85 },
    { documentId: "plans/c.plan.md", score: 0.5 },
  ];
  const section = await buildWorkContextSection({
    cwd: repo,
    searchMemory: async () => ({ records }),
    wikiRoot,
    planContextMax: 2,
  });
  const shown = ["a", "b", "c"].filter((x) => section.includes(`plans/${x}.plan.md`));
  assert.equal(shown.length, 2, "exactly planContextMax plans shown");
  assert.ok(shown.includes("c"), "the in-progress plan is kept despite lowest score");
  assert.match(section, /top 2\)/, "header count reflects the rendered (post-cap) bullets");
});

test("buildWorkContextSection: non-plan hits are never dropped by the plan cap", async () => {
  const repo = initRepo("main");
  spawnSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: repo });
  const records = [
    { documentId: "knowledge/a.md", score: 0.9 },
    { documentId: "knowledge/b.md", score: 0.8 },
    { documentId: "knowledge/c.md", score: 0.7 },
  ];
  const section = await buildWorkContextSection({
    cwd: repo,
    searchMemory: async () => ({ records }),
    wikiRoot: "/nonexistent",
    planContextMax: 1,
  });
  for (const id of ["knowledge/a.md", "knowledge/b.md", "knowledge/c.md"]) {
    assert.ok(section.includes(id), `${id} kept`);
  }
  assert.match(section, /top 3\)/, "all non-plan hits counted in the header");
});

test("buildRecentActivitySection: empty when disabled (days=0)", () => {
  assert.equal(buildRecentActivitySection({ wikiRoot: "/nope", days: 0 }), "");
});

test("buildRecentActivitySection: empty when there are no daily notes", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-empty-"));
  assert.equal(buildRecentActivitySection({ wikiRoot, days: 3 }), "");
});

test("buildRecentActivitySection: 🧠 header (nbsp gap) + dated bullet + clickable link + stored brief", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-daily-"));
  const rel = writeDaily(
    wikiRoot,
    "2026",
    "07",
    "02",
    "164400",
    "000",
    "Cassandra timeout root cause",
  );
  const section = buildRecentActivitySection({ wikiRoot, days: 3 });
  assert.match(section, /## 🧠  Recently — last 3 days/);
  assert.ok(
    section.includes("🧠 "),
    "non-breaking gap between emoji and text (survives markdown collapse)",
  );
  assert.match(section, /2026-07-02 16:44/);
  assert.match(section, /Cassandra timeout root cause/);
  assert.match(
    section,
    /\]\(file:\/\/.*daily.*\.md\)/,
    "renders a clickable absolute file:// link",
  );
  assert.ok(section.includes(rel), "the link target includes the daily note path");
});

test("buildRecentActivitySection: keeps only the last N distinct dates", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-window-"));
  writeDaily(wikiRoot, "2026", "07", "05", "100000", "000", "Newest day note");
  writeDaily(wikiRoot, "2026", "07", "04", "100000", "000", "Middle day note");
  writeDaily(wikiRoot, "2026", "07", "01", "100000", "000", "Oldest day note");
  const section = buildRecentActivitySection({ wikiRoot, days: 2 });
  assert.match(section, /Newest day note/);
  assert.match(section, /Middle day note/);
  assert.ok(!/Oldest day note/.test(section), "day outside the window is excluded");
});

test("buildRecentActivitySection: falls back to computed brief when none is stored", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-fallback-"));
  const dir = path.join(wikiRoot, "daily", "2026", "07", "03");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "daily-2026-07-03-120000000.md"),
    "---\nmemory:\n  atom_type: daily-capture\n---\n\n### Atom · bug-root-cause · Hermes retry storm root cause\n- body: |\n    x\n",
  );
  const section = buildRecentActivitySection({ wikiRoot, days: 3 });
  assert.match(section, /Hermes retry storm root cause/, "used the first captured item's title");
});

test("buildRecentActivitySection: stays under the ~1KB context budget", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-budget-"));
  for (let i = 0; i < 10; i += 1) {
    writeDaily(
      wikiRoot,
      "2026",
      "07",
      String(10 + i).padStart(2, "0"),
      "100000",
      "000",
      "X".repeat(300),
    );
  }
  const section = buildRecentActivitySection({ wikiRoot, days: 10 });
  assert.ok(section.length <= 1000, `section length ${section.length} must be <= 1000`);
});

test("buildRecentActivitySection: tolerates a legacy daily filename (no timestamp) without crashing", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-legacy-"));
  const dir = path.join(wikiRoot, "daily", "2026", "07", "02");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "daily-legacy-import.md"),
    "---\nmemory:\n  atom_type: daily-capture\n---\n\nThe legacy note body prose here.\n",
  );
  let section;
  assert.doesNotThrow(() => {
    section = buildRecentActivitySection({ wikiRoot, days: 3 });
  });
  assert.match(section, /2026-07-02/, "folder date used when the filename has no timestamp");
});

test("buildRecentActivitySection: orders same-day notes newest-first", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-sameday-"));
  writeDaily(wikiRoot, "2026", "07", "02", "090000", "000", "Morning note earlier one");
  writeDaily(wikiRoot, "2026", "07", "02", "170000", "000", "Evening note later two");
  const section = buildRecentActivitySection({ wikiRoot, days: 3 });
  assert.ok(
    section.indexOf("Evening note later two") < section.indexOf("Morning note earlier one"),
    "17:00 note renders before the 09:00 note",
  );
});

test("buildRecentActivitySection: omitting days uses the configured setting (default 3)", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-default-"));
  writeDaily(wikiRoot, "2026", "07", "02", "120000", "000", "Default days window note");
  const section = buildRecentActivitySection({ wikiRoot });
  assert.match(section, /Default days window note/);
  assert.match(section, /last 3 days/);
});

test("buildRecentActivitySection: over-cap notes are trimmed silently (no '…and N more' clutter)", () => {
  const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiki-more-"));
  for (let i = 0; i < 9; i += 1) {
    writeDaily(
      wikiRoot,
      "2026",
      "07",
      String(10 + i).padStart(2, "0"),
      "120000",
      "000",
      `Concise note ${i}`,
    );
  }
  const section = buildRecentActivitySection({ wikiRoot, days: 9 });
  assert.ok(!/and \d+ more/.test(section), "no dropped-count line");
  assert.ok(!section.includes("…and"), "no '…and' clutter the reader can't act on");
});
