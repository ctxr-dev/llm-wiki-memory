// Tests for the "fail loud, never create garbage paths" principle.
//
// pathFor() must verify its output round-trips through parsePath().
// pruneEmptyAncestors() must clean up orphaned dirs after a move.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadTopology,
  pathFor,
  _resetCacheForTests,
} from "../scripts/lib/topology-runtime.mjs";
import { pruneEmptyAncestors } from "../scripts/lib/plan-sync.mjs";

function tmpWiki(yaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "round-trip-"));
  fs.mkdirSync(path.join(dir, "layout"));
  fs.writeFileSync(path.join(dir, "layout", "layout.yaml"), yaml);
  return dir;
}

// ---------------------------------------------------------------------------
// pathFor: round-trip enforcement
// ---------------------------------------------------------------------------

test("pathFor: round-trip check passes for a self-consistent topology", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [tracker, prefix, number]
          path_template: "issues/{tracker}/{prefix}/{prefix}-{number}.md"
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  // path_template-based topology — parse uses regex derived from the
  // template, so it round-trips by construction.
  assert.doesNotThrow(() =>
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 42 }),
  );
});

test("pathFor: round-trip check REFUSES an ambiguous from_path regex", async () => {
  // Forward compiler embeds the issue number into a slug. The reverse
  // compiler's regex is GREEDY and matches a different digit than the
  // forward used. Round-trip check should catch this.
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ambig-"));
  fs.mkdirSync(path.join(wiki, "layout"));
  fs.writeFileSync(
    path.join(wiki, "layout", "layout.yaml"),
    `
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        plan:
          required_facets: [prefix, number, slug]
          to_path_file: ./to_path.mjs
          from_path_file: ./from_path.mjs
      facet_inputs:
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
        slug: { type: string }
`,
  );
  fs.writeFileSync(
    path.join(wiki, "layout", "to_path.mjs"),
    `export function plan({ prefix, number, slug }) {
       return \`issues/\${prefix}/\${prefix}-\${number}-\${slug}.plan.md\`;
     }`,
  );
  // Bad: greedy regex that may extract the wrong digit if slug contains a digit.
  fs.writeFileSync(
    path.join(wiki, "layout", "from_path.mjs"),
    `const RE = /^issues\\/([^/]+)\\/[^/]+-(\\d+)-(.+)\\.plan\\.md$/;
     export function plan(rel) {
       const m = RE.exec(rel);
       return m ? { prefix: m[1], number: parseInt(m[2], 10), slug: m[3] } : null;
     }`,
  );
  _resetCacheForTests();
  const topo = await loadTopology(wiki);

  // For "DEV-122648-mirror-1-and-2": the GREEDY regex on the filename
  // pulls the last numeric run before -<slug>... actually JS regex is
  // greedy left-to-right so it captures the SMALLEST possible (\d+) at
  // the leftmost position. Let me verify the actual failure case.
  // The forward produces "issues/DEV/DEV-122648-mirror-1-and-2.plan.md".
  // The regex `[^/]+-(\d+)-(.+)\.plan\.md` against that file part:
  //   [^/]+ greedy: matches "DEV-122648-mirror-1"
  //   -      literal
  //   (\d+) : remaining must match \d+ then -<slug>.plan.md
  //   trying: after [^/]+="DEV-122648-mirror-1", needs "-(\d+)" → "-and" doesn't match
  //   backtrack: [^/]+="DEV-122648-mirror", "-1-and-2" needs "-(\d+)-..." → number=1, slug="and-2"
  // So the parsed number=1, NOT 122648. Round-trip check catches this.
  assert.throws(
    () =>
      pathFor(topo, "plan", { prefix: "DEV", number: 122648, slug: "mirror-1-and-2" }),
    /round-trip/,
  );
});

test("pathFor: round-trip catches a path_template that drops a required facet", async () => {
  // The template includes only `prefix`, not `number`. So pathFor would
  // happily produce "issues/DEV/leaf.md" — but the required facet
  // `number` never made it into the path. Round-trip check must refuse
  // because parsed.facets.number would be undefined.
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [prefix, number]
          path_template: "issues/{prefix}/leaf.md"
      facet_inputs:
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.throws(
    () => pathFor(topo, "knowledge", { prefix: "DEV", number: 42 }),
    /required facet 'number' is NOT recovered/,
  );
});

test("pathFor: skipRoundTripCheck disables the safety net (escape hatch)", async () => {
  // The escape hatch lets a topology author intentionally bypass the
  // round-trip enforcement for a specific call. Useful for migrations or
  // experimental compilers; production paths SHOULD leave the check on.
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [prefix, number]
          path_template: "issues/{prefix}/leaf.md"
      facet_inputs:
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  // With the check OFF the same call returns the path.
  const p = pathFor(
    topo,
    "knowledge",
    { prefix: "DEV", number: 42 },
    { skipRoundTripCheck: true },
  );
  assert.equal(p, "issues/DEV/leaf.md");
});

// ---------------------------------------------------------------------------
// pruneEmptyAncestors
// ---------------------------------------------------------------------------

test("pruneEmptyAncestors: removes a chain of dirs containing only auto-generated index.md", () => {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
  // Create wiki/a/b/c/ with each level containing only an index.md
  const deep = path.join(wiki, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(wiki, "a", "index.md"), "# a");
  fs.writeFileSync(path.join(wiki, "a", "b", "index.md"), "# b");
  fs.writeFileSync(path.join(wiki, "a", "b", "c", "index.md"), "# c");

  pruneEmptyAncestors(deep, wiki);
  assert.equal(fs.existsSync(deep), false, "leaf dir removed");
  assert.equal(fs.existsSync(path.join(wiki, "a", "b")), false, "b removed");
  assert.equal(fs.existsSync(path.join(wiki, "a")), false, "a removed");
  // Wiki root itself MUST remain.
  assert.equal(fs.existsSync(wiki), true);
});

test("pruneEmptyAncestors: STOPS at the first dir with real content", () => {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "prune-stop-"));
  const deep = path.join(wiki, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(wiki, "a", "index.md"), "# a");
  // Plant a real file at level b that's NOT index.md
  fs.writeFileSync(path.join(wiki, "a", "b", "other.md"), "real content");
  fs.writeFileSync(path.join(wiki, "a", "b", "index.md"), "# b");
  fs.writeFileSync(path.join(wiki, "a", "b", "c", "index.md"), "# c");

  pruneEmptyAncestors(deep, wiki);
  assert.equal(fs.existsSync(deep), false, "leaf dir removed");
  assert.equal(
    fs.existsSync(path.join(wiki, "a", "b", "other.md")),
    true,
    "real content preserved",
  );
  assert.equal(
    fs.existsSync(path.join(wiki, "a", "b", "index.md")),
    true,
    "index at level b NOT removed (sibling is meaningful)",
  );
});

test("pruneEmptyAncestors: never traverses ABOVE the wiki root", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prune-bound-"));
  const wiki = path.join(parent, "wiki");
  fs.mkdirSync(wiki);
  fs.writeFileSync(path.join(parent, "sibling.txt"), "outside");

  // Asking to prune from a path that doesn't live under wikiRoot — should be a no-op
  pruneEmptyAncestors(parent, wiki);
  assert.equal(fs.existsSync(path.join(parent, "sibling.txt")), true);
  assert.equal(fs.existsSync(wiki), true);
});
