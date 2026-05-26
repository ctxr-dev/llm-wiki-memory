import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadTopology,
  pathFor,
  parsePath,
  validateFacets,
  _resetCacheForTests,
} from "../scripts/lib/topology-runtime.mjs";

// Helper: writes a fresh tmp wiki dir with a single layout YAML at the root.
function tmpWiki(layoutYaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "topo-runtime-test-"));
  fs.mkdirSync(path.join(dir, "layout"));
  fs.writeFileSync(path.join(dir, "layout", "layout.yaml"), layoutYaml);
  return dir;
}

const TRACKER_ISSUES_YAML = `
layout:
  - path: issues
    placement_facets: []
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [tracker, prefix, number]
          to_path: |
            function to_path({ tracker, prefix, number }) {
              const n = Number(number);
              const thousands = Math.floor(n / 1000);
              const hundredsTens = Math.floor((n % 1000) / 10);
              const units = n % 10;
              return \`issues/\${tracker}/\${prefix}/\${thousands}/\${hundredsTens}/\${units}/\${prefix}-\${n}.md\`;
            }
          from_path: |
            function from_path(rel) {
              const m = /^issues\\/([^/]+)\\/([^/]+)\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/[^/]+-(\\d+)\\.md$/.exec(rel);
              if (!m) return null;
              return { tracker: m[1], prefix: m[2], number: parseInt(m[6], 10) };
            }
        plan:
          required_facets: [tracker, prefix, number, lifecycle, slug]
          enums:
            lifecycle: [pending, in-progress, done, archived]
          to_path: |
            function to_path({ tracker, prefix, number, lifecycle, slug }) {
              const n = Number(number);
              const t = Math.floor(n / 1000);
              const h = Math.floor((n % 1000) / 10);
              const u = n % 10;
              return \`issues/\${tracker}/\${prefix}/\${t}/\${h}/\${u}/\${lifecycle}/\${prefix}-\${n}-\${slug}.plan.md\`;
            }
          from_path: |
            function from_path(rel) {
              const m = /^issues\\/([^/]+)\\/([^/]+)\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/([^/]+)\\/[^/]+-(\\d+)-(.+)\\.plan\\.md$/.exec(rel);
              if (!m) return null;
              return {
                tracker: m[1], prefix: m[2], number: parseInt(m[7], 10),
                lifecycle: m[6], slug: m[8],
              };
            }
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
        lifecycle: { type: string }
        slug: { type: string, pattern: "^[A-Za-z0-9-]+$" }
`;

test("loadTopology compiles inline to_path / from_path functions", async () => {
  const wiki = tmpWiki(TRACKER_ISSUES_YAML);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.equal(typeof topo.fileKinds.knowledge.pathFn, "function");
  assert.equal(typeof topo.fileKinds.knowledge.parseFn, "function");
  assert.equal(typeof topo.fileKinds.plan.pathFn, "function");
});

test("pathFor knowledge: DEV-129957 -> issues/JIRA/DEV/129/95/7/DEV-129957.md", async () => {
  const wiki = tmpWiki(TRACKER_ISSUES_YAML);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 129957 }),
    "issues/JIRA/DEV/129/95/7/DEV-129957.md",
  );
});

test("pathFor plan: lifecycle + slug + .plan.md", async () => {
  const wiki = tmpWiki(TRACKER_ISSUES_YAML);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.equal(
    pathFor(topo, "plan", {
      tracker: "JIRA",
      prefix: "DEV",
      number: 129957,
      lifecycle: "in-progress",
      slug: "investigate-timeout",
    }),
    "issues/JIRA/DEV/129/95/7/in-progress/DEV-129957-investigate-timeout.plan.md",
  );
});

test("pathFor: 1-digit and 7-digit numbers", async () => {
  const wiki = tmpWiki(TRACKER_ISSUES_YAML);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 1 }),
    "issues/JIRA/DEV/0/0/1/DEV-1.md",
  );
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 1234567 }),
    "issues/JIRA/DEV/1234/56/7/DEV-1234567.md",
  );
});

test("pathFor: non-JIRA trackers", async () => {
  const wiki = tmpWiki(TRACKER_ISSUES_YAML);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "GITHUB", prefix: "my-org-my-repo", number: 42 }),
    "issues/GITHUB/my-org-my-repo/0/4/2/my-org-my-repo-42.md",
  );
});

test("pathFor surfaces compiler-internal errors with the kind name", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [x]
          to_path: |
            function to_path() { throw new Error("BOOM"); }
      facet_inputs:
        x: { type: string }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.throws(
    () => pathFor(topo, "knowledge", { x: "hello" }),
    /compiler error for 'knowledge': BOOM/,
  );
});

test("pathFor flags unresolved {var} placeholders the compiler accidentally embedded", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [x]
          to_path: |
            () => "issues/literal/{leaked_var}/file.md"
      facet_inputs:
        x: { type: string }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.throws(
    () => pathFor(topo, "knowledge", { x: "hi" }),
    /unresolved placeholders.*\{leaked_var\}/,
  );
});

test("parsePath uses from_path when present", async () => {
  const wiki = tmpWiki(TRACKER_ISSUES_YAML);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  const result = parsePath(topo, "issues/JIRA/DEV/129/95/7/DEV-129957.md");
  assert.ok(result);
  assert.equal(result.kind, "knowledge");
  assert.equal(result.facets.tracker, "JIRA");
  assert.equal(result.facets.prefix, "DEV");
  assert.equal(result.facets.number, 129957);
});

test("parsePath round-trips a plan path with hyphen-laden slug", async () => {
  const wiki = tmpWiki(TRACKER_ISSUES_YAML);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  const facets = {
    tracker: "JIRA",
    prefix: "DEV",
    number: 129957,
    lifecycle: "in-progress",
    slug: "investigate-timeout",
  };
  const result = parsePath(topo, pathFor(topo, "plan", facets));
  assert.ok(result);
  assert.equal(result.kind, "plan");
  assert.equal(result.facets.lifecycle, "in-progress");
  assert.equal(result.facets.slug, "investigate-timeout");
});

test("parsePath returns null for non-conforming inputs", async () => {
  const wiki = tmpWiki(TRACKER_ISSUES_YAML);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.equal(parsePath(topo, "knowledge/random/path.md"), null);
  assert.equal(parsePath(topo, "issues/JIRA/DEV/bogus.md"), null);
});

test("validateFacets: missing required, enum, and pattern errors", async () => {
  const wiki = tmpWiki(TRACKER_ISSUES_YAML);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  const missing = validateFacets(topo, "plan", { tracker: "JIRA", prefix: "DEV", number: 1 });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes("lifecycle")));

  const badEnum = validateFacets(topo, "plan", {
    tracker: "JIRA",
    prefix: "DEV",
    number: 1,
    lifecycle: "merged",
    slug: "x",
  });
  assert.equal(badEnum.ok, false);
  assert.ok(badEnum.errors.some((e) => e.includes("'merged'")));

  const badPattern = validateFacets(topo, "plan", {
    tracker: "JIRA",
    prefix: "DEV",
    number: 1,
    lifecycle: "pending",
    slug: "spaces are bad",
  });
  assert.equal(badPattern.ok, false);
});

test("loadTopology falls back to path_template when no compiler is supplied", async () => {
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
        number: { type: integer }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.equal(topo.fileKinds.knowledge.pathFn, null);
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 42 }),
    "issues/JIRA/DEV/DEV-42.md",
  );
});

test("to_path_file: reads a sibling .mjs file's default export", async () => {
  // The .mjs helper sits in the layout/ folder next to the YAML.
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "topo-file-"));
  fs.mkdirSync(path.join(wiki, "layout"));
  fs.writeFileSync(
    path.join(wiki, "layout", "knowledge-path.mjs"),
    "export default ({ tracker, prefix, number }) => `issues/${tracker}/${prefix}/${prefix}-${number}.md`;\n",
  );
  fs.writeFileSync(
    path.join(wiki, "layout", "layout.yaml"),
    `
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [tracker, prefix, number]
          to_path_file: ./knowledge-path.mjs
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer }
`,
  );
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.equal(typeof topo.fileKinds.knowledge.pathFn, "function");
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 42 }),
    "issues/JIRA/DEV/DEV-42.md",
  );
});

test("loadTopology reads from <wiki>/layout/layout.yaml (canonical location)", async () => {
  // The canonical (and only) location for the layout YAML.
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "topo-layout-folder-"));
  fs.mkdirSync(path.join(wiki, "layout"));
  fs.writeFileSync(
    path.join(wiki, "layout", "to_path.mjs"),
    "export function knowledge({ tracker, prefix, number }) { return `issues/${tracker}/${prefix}/${prefix}-${number}.md`; }\n",
  );
  fs.writeFileSync(
    path.join(wiki, "layout", "layout.yaml"),
    `
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [tracker, prefix, number]
          to_path_file: ./to_path.mjs
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer }
`,
  );
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 42 }),
    "issues/JIRA/DEV/DEV-42.md",
    "yaml-relative `./to_path.mjs` resolves against the YAML's directory (layout/), not the wiki root",
  );
});

test("loadTopology throws when layout/layout.yaml is missing", async () => {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "topo-no-layout-"));
  _resetCacheForTests();
  await assert.rejects(() => loadTopology(wiki), /layout\.yaml not found/);
});

// Sanity: with a fully-formed canonical layout, validateFacets-only path
// works and surfaces enum / required errors without a successful build.
test("validateFacets surfaces required + enum violations even before pathFor", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [x]
          path_template: "issues/{x}.md"
      facet_inputs:
        x: { type: string }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  const v = validateFacets(topo, "knowledge", {});
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("missing required facet 'x'")));
});

test("loadTopology rejects BOTH inline and file compiler in the same file_kind", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [x]
          to_path: "() => 'a'"
          to_path_file: ./x.mjs
      facet_inputs:
        x: { type: string }
`);
  _resetCacheForTests();
  await assert.rejects(() => loadTopology(wiki), /BOTH .* pick one/);
});
