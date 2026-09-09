import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The node-side quality gates are configured in THREE independent hardcoded
// lists: `jsconfig.json` include (tsc --strict --checkJs), knip's `project`
// (dead-code detection), and the `find` roots in the `check:size` script (the
// 300-line ceiling). ESLint is the odd one out: it globs `**/*.mjs`, so it
// covers everything by default.
//
// That asymmetry is a trap, and it nearly cost real coverage: a renderer was
// about to be added under `src/diagrams/`, which ESLint would have linted
// (making it LOOK covered) while tsc, knip and the size gate all silently
// ignored it. A 587-line file would have shipped untyped, its dead exports
// invisible, and the size ceiling never applied.
//
// So: every top-level directory holding node-side `.mjs` source must appear in
// all three lists. Adding a new source root now fails here until it is wired
// into each gate, instead of quietly opting out of them.

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Directories that are not node-side product source and are gated elsewhere. */
const NOT_PRODUCT_SOURCE = new Set([
  "node_modules",
  "test", // excluded from tsc on purpose; tests are not shipped
  "wiki",
  "src", // the webapp workspace: its own gates, and knip ignores it
  "examples", // layout templates copied verbatim, not imported
  "docs",
  "prompts",
  "templates",
]);

/** @returns {string[]} top-level dirs that contain at least one .mjs file */
function sourceRoots() {
  /** @param {string} dir @returns {boolean} */
  const hasMjs = (dir) => {
    /** @type {string[]} */
    const stack = [dir];
    while (stack.length > 0) {
      const current = /** @type {string} */ (stack.pop());
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".mjs")) return true;
      }
    }
    return false;
  };
  return fs
    .readdirSync(repo, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !NOT_PRODUCT_SOURCE.has(e.name))
    .map((e) => e.name)
    .filter((name) => hasMjs(path.join(repo, name)))
    .sort();
}

const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(repo, rel), "utf8");

test("every node-side source root is covered by tsc, knip AND the size gate", () => {
  const roots = sourceRoots();
  assert.ok(roots.length > 0, "expected to find node-side source roots");

  const jsconfig = JSON.parse(read("jsconfig.json"));
  const knip = JSON.parse(read("knip.json"));
  const checkSize = JSON.parse(read("package.json")).scripts["check:size"];

  const tscRoots = jsconfig.include.map((/** @type {string} */ g) => g.split("/")[0]);
  const knipRoots = knip.workspaces["."].project.map((/** @type {string} */ g) => g.split("/")[0]);
  const sizeRoots = (/^find ([^\\(]+)/.exec(checkSize)?.[1] ?? "").trim().split(/\s+/);

  for (const root of roots) {
    assert.ok(
      tscRoots.includes(root),
      `${root}/ holds .mjs source but is missing from jsconfig.json include, so tsc --strict never sees it`,
    );
    assert.ok(
      knipRoots.includes(root),
      `${root}/ holds .mjs source but is missing from knip.json project, so dead exports there are invisible`,
    );
    assert.ok(
      sizeRoots.includes(root),
      `${root}/ holds .mjs source but is missing from the check:size find roots, so the 300-line ceiling never applies`,
    );
  }
});

test("the size ceiling is 300 lines and is actually enforced, not just configured", () => {
  const checkSize = JSON.parse(read("package.json")).scripts["check:size"];
  assert.match(checkSize, /\$1>300/, "the 300-line ceiling must remain the threshold");
  // A gate that cannot fail is decoration: this pins the non-zero exit.
  assert.match(checkSize, /exit c>0\?1:0/, "check:size must exit non-zero when a file is over");
});
