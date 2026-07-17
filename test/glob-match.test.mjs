import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globToRegExp, matchesAnyMask, collectFiles } from "../scripts/lib/glob-match.mjs";

test("globToRegExp: * matches within a segment, NOT across /", () => {
  assert.ok(globToRegExp("*.md").test("a.md"));
  assert.ok(!globToRegExp("*.md").test("sub/a.md"), "* does not cross a dir");
  assert.ok(!globToRegExp("*.md").test("a.txt"));
});

test("globToRegExp: ** matches any depth (incl. none)", () => {
  const re = globToRegExp("**/*.md");
  assert.ok(re.test("a.md"), "** matches zero segments");
  assert.ok(re.test("x/a.md"));
  assert.ok(re.test("x/y/z/a.md"));
  assert.ok(!re.test("a.txt"));
});

test("globToRegExp: ? matches one non-/ char; {a,b} alternation; dots literal", () => {
  assert.ok(globToRegExp("v?.md").test("v2.md"));
  assert.ok(!globToRegExp("v?.md").test("v.md"));
  const alt = globToRegExp("**/*.{md,markdown}");
  assert.ok(alt.test("x/a.md") && alt.test("y/b.markdown"));
  assert.ok(!alt.test("x/a.mdx"));
});

test("matchesAnyMask: OR of masks; matches basename or full relative path", () => {
  assert.ok(matchesAnyMask("docs/a.md", ["**/*.md"]));
  assert.ok(matchesAnyMask("a.markdown", ["**/*.md", "**/*.markdown"]));
  assert.ok(!matchesAnyMask("a.txt", ["**/*.md", "**/*.markdown"]));
});

test("globToRegExp: wildcards INSIDE {…} compile to a valid regex (no crash)", () => {
  const re = globToRegExp("{*.md,*.txt}"); // used to throw SyntaxError: nothing to repeat
  assert.ok(re.test("a.md") && re.test("b.txt"));
  assert.ok(!re.test("c.rst"));
});

test("globToRegExp / matchesAnyMask: matching is CASE-INSENSITIVE (macOS fs)", () => {
  assert.ok(globToRegExp("**/*.md").test("x/GUIDE.MD"), "uppercase extension matches");
  assert.ok(matchesAnyMask("README.Markdown", ["**/*.markdown"]));
});

// ── collectFiles over a real tmp tree ─────────────────────────────────────
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "glob-collect-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
function seed(rel, body = "x") {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}
const A = seed("docs/a.md");
const NESTED = seed("docs/guide/b.md");
seed("docs/notes.txt"); // non-markdown -> filtered out by default masks
const TOP = seed("top.markdown");

test("collectFiles: a directory recurses and keeps only mask matches; root = the dir", () => {
  const got = collectFiles([path.join(TMP, "docs")]);
  const files = got.map((g) => g.file).sort();
  assert.deepEqual(files, [A, NESTED].sort(), "recursed markdown only (notes.txt excluded)");
  assert.ok(
    got.every((g) => g.root === path.join(TMP, "docs")),
    "root is the given dir",
  );
});

test("collectFiles: an explicit file is taken as-is (root = its parent); non-md allowed when named", () => {
  const txt = seed("explicit.txt");
  const got = collectFiles([txt]);
  assert.deepEqual(got, [{ file: txt, root: path.dirname(txt) }]);
});

test("collectFiles: a ** glob expands and filters by mask", () => {
  const got = collectFiles([path.join(TMP, "docs", "**", "*.md")]);
  assert.deepEqual(got.map((g) => g.file).sort(), [A, NESTED].sort());
});

test("collectFiles: dedupes when a file matches via multiple inputs", () => {
  const got = collectFiles([path.join(TMP, "docs"), A]);
  assert.equal(got.filter((g) => g.file === A).length, 1, "A appears once");
});

test("collectFiles: no matches -> empty (no throw); a missing path is skipped", () => {
  assert.deepEqual(collectFiles([path.join(TMP, "does-not-exist")]), []);
  assert.deepEqual(collectFiles([path.join(TMP, "docs")], ["**/*.rst"]), []);
});

test("collectFiles: an unreadable subdirectory is skipped, not fatal (continue-on-error)", () => {
  const denied = path.join(TMP, "docs", "denied");
  fs.mkdirSync(denied, { recursive: true });
  fs.writeFileSync(path.join(denied, "secret.md"), "x");
  fs.chmodSync(denied, 0o000);
  try {
    fs.readdirSync(denied); // root can still read a 0o000 dir — then the guard isn't exercised
    return; // skip the assertion in that environment
  } catch {
    /* expected: EACCES for a non-root process */
  }
  try {
    const got = collectFiles([path.join(TMP, "docs")]); // must NOT throw
    assert.ok(
      got.every((g) => !g.file.includes("denied")),
      "the unreadable subtree is skipped",
    );
    assert.ok(
      got.some((g) => g.file === A),
      "readable siblings are still collected",
    );
  } finally {
    fs.chmodSync(denied, 0o755);
  }
});

test("collectFiles: custom masks (markdown extensions)", () => {
  const got = collectFiles([TMP], ["**/*.markdown"]);
  assert.deepEqual(
    got.map((g) => g.file),
    [TOP],
  );
});
