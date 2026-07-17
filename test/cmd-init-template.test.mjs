// Template-aware `cli.mjs init --template <name>`: the default install stays
// byte-identical, `repo` yields a knowledge-only subject-only FULL tree, the
// tracker-issues template carries its sibling path-compiler helpers, an unknown
// template fails closed, and every fresh install declares consolidate for every
// category (getConsolidateLayout().missing === []).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withWikiRoot } from "../scripts/lib/env.mjs";
import {
  getConsolidateLayout,
  _resetLayoutCacheForTests,
} from "../scripts/lib/wiki-layout-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");
const CLI = path.join(SRC, "scripts/cli.mjs");

/** @type {string[]} */
const dirs = [];
/**
 * @param {string} template
 * @returns {{ status: number | null, stdout: string, stderr: string, dataDir: string, wiki: string }}
 */
function runInit(template) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-init-tmpl-")));
  dirs.push(dataDir);
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "settings", "settings.yaml"), "embed:\n  backend: lexical\n");
  const args = template === undefined ? ["init"] : ["init", "--template", template];
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, MEMORY_DATA_DIR: dataDir, MEMORY_EMBED_BACKEND: "lexical" },
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    dataDir,
    wiki: path.join(dataDir, "wiki"),
  };
}
after(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("no --template yields the historical default layout, byte-identical", () => {
  const { status, wiki } = runInit(undefined);
  assert.equal(status, 0);
  const installed = fs.readFileSync(path.join(wiki, ".layout", "layout.yaml"), "utf8");
  const shipped = fs.readFileSync(path.join(SRC, "examples/layouts/default/layout.yaml"), "utf8");
  assert.equal(
    installed,
    shipped,
    "default install layout is byte-identical to the shipped default",
  );
});

test("--template default matches the shipped default example", () => {
  const { status, wiki } = runInit("default");
  assert.equal(status, 0);
  assert.equal(
    fs.readFileSync(path.join(wiki, ".layout", "layout.yaml"), "utf8"),
    fs.readFileSync(path.join(SRC, "examples/layouts/default/layout.yaml"), "utf8"),
  );
});

test("--template repo yields a knowledge-only, subject-only FULL tree", () => {
  const { status, wiki } = runInit("repo");
  assert.equal(status, 0);
  const raw = fs.readFileSync(path.join(wiki, ".layout", "layout.yaml"), "utf8");
  assert.match(raw, /- path: knowledge/);
  assert.match(
    raw,
    /placement_facets:\s*\[subject\]/,
    "subject-only placement (no atom_type folder)",
  );
  assert.match(raw, /full:\s*true/, "team wiki holds whole documents (full leaves)");
  assert.match(raw, /ownership:\s*repo/);
  for (const other of ["self_improvement", "plans", "investigations", "daily", "issues"]) {
    assert.ok(!raw.includes(`- path: ${other}`), `repo layout must NOT declare '${other}'`);
  }
});

test("--template tracker-issues carries the sibling path-compiler helpers", () => {
  const { status, wiki } = runInit("tracker-issues");
  assert.equal(status, 0);
  const layoutDir = path.join(wiki, ".layout");
  assert.ok(fs.existsSync(path.join(layoutDir, "to_path.mjs")), "to_path.mjs travels");
  assert.ok(fs.existsSync(path.join(layoutDir, "from_path.mjs")), "from_path.mjs travels");

  // The path compiler works post-init: a plan path resolves with no leftover
  // placeholders (proves the sibling helpers loaded against the copied layout).
  const r = spawnSync(
    process.execPath,
    [
      CLI,
      "test-path-compiler",
      "plan",
      "--category",
      "issues",
      "tracker=JIRA",
      "prefix=DEV",
      "number=129957",
      "lifecycle=in-progress",
      "slug=fix",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MEMORY_DATA_DIR: path.dirname(wiki),
        MEMORY_EMBED_BACKEND: "lexical",
      },
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.path, "issues/JIRA/DEV/129/95/7/in-progress/DEV-129957-fix.plan.md");
  assert.deepEqual(parsed.unresolved_placeholders, []);
});

test("unknown --template fails closed (non-zero, clear message)", () => {
  const { status, stdout, stderr, wiki } = runInit("does-not-exist");
  assert.notEqual(status, 0, "exit is non-zero");
  const all = stdout + stderr;
  assert.match(all, /unknown layout template/i);
  assert.match(all, /Available templates:.*\bdefault\b/i, "lists available templates");
  assert.ok(
    !fs.existsSync(path.join(wiki, ".layout", "layout.yaml")),
    "no layout written on a fail-closed init",
  );
});

test("every fresh template install declares consolidate for every category", () => {
  for (const template of ["default", "repo", "tracker-issues"]) {
    const { status, wiki } = runInit(template);
    assert.equal(status, 0, `${template} init`);
    const res = withWikiRoot(wiki, () => {
      _resetLayoutCacheForTests();
      return getConsolidateLayout();
    });
    assert.deepEqual(res.missing, [], `${template}: no category missing a consolidate declaration`);
  }
});
