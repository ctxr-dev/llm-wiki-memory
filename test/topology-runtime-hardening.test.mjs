// Hardening tests for topology-runtime — covers edge cases the audit
// agents identified: malformed YAML structures, prototype pollution,
// invalid facets shape, async/generator compilers, broken regex
// patterns, parsePath input safety, frozen-shallow concerns.

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

function tmpWiki(layoutYaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "topo-hard-"));
  fs.mkdirSync(path.join(dir, ".layout"));
  fs.writeFileSync(path.join(dir, ".layout", "layout.yaml"), layoutYaml);
  return dir;
}

test("validateFacets rejects facets that aren't a plain object (null)", async () => {
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
  const r = validateFacets(topo, "knowledge", null);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("plain object")));
});

test("validateFacets rejects facets that are a primitive (string)", async () => {
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
  const r = validateFacets(topo, "knowledge", "not-an-object");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("plain object")));
});

test("validateFacets rejects facets that are an array", async () => {
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
  const r = validateFacets(topo, "knowledge", []);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("array")));
});

test("validateFacets rejects boolean coercion into an integer facet", async () => {
  // Number(true) === 1 would otherwise silently pass the integer check.
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [n]
          path_template: "issues/{n}.md"
      facet_inputs:
        n: { type: integer, minimum: 1 }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  const r = validateFacets(topo, "knowledge", { n: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.toLowerCase().includes("boolean")));
});

test("validateFacets rejects non-string value when a pattern is declared", async () => {
  // Previously, the pattern check was gated on typeof === 'string' and
  // silently skipped integer values. We now surface the type mismatch.
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [slug]
          path_template: "issues/{slug}.md"
      facet_inputs:
        slug:
          type: string
          pattern: "^[a-z]+$"
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  const r = validateFacets(topo, "knowledge", { slug: 42 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("pattern requires a string")));
});

test("validateFacets surfaces an invalid-regex pattern as a layout error, not a throw", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [slug]
          path_template: "issues/{slug}.md"
      facet_inputs:
        slug:
          type: string
          pattern: "[unclosed"
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  // The pattern is malformed; validateFacets must catch the RegExp ctor
  // exception and report it as a validation error rather than throwing.
  const r = validateFacets(topo, "knowledge", { slug: "abc" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("not a valid regex")));
});

test("validateFacets reports malformed YAML enums (string instead of array)", async () => {
  // The YAML author wrote `lifecycle: pending` (scalar) instead of a list.
  // Without defensive checks, .includes() would do character-matching.
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [lifecycle]
          enums:
            lifecycle: pending
          path_template: "issues/{lifecycle}.md"
      facet_inputs:
        lifecycle: { type: string }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  const r = validateFacets(topo, "knowledge", { lifecycle: "p" });
  // The crash would be subtle without the guard; here we expect a clear
  // "must be an array" error.
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("enums.lifecycle must be an array")));
});

test("validateFacets: required-facet check treats empty string as missing", async () => {
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
  const r = validateFacets(topo, "knowledge", { x: "" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("missing required facet 'x'")));
});

test("validateFacets: integer minimum is enforced (1 floor)", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [n]
          path_template: "issues/{n}.md"
      facet_inputs:
        n: { type: integer, minimum: 1 }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  const r = validateFacets(topo, "knowledge", { n: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("must be >= 1")));
});

test("pathFor rejects unknown kindName via validateFacets", async () => {
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
  assert.throws(
    () => pathFor(topo, "no_such_kind", { x: "a" }),
    /unknown file_kind 'no_such_kind'/,
  );
});

test("parsePath returns null for null / undefined / non-string / NUL inputs", async () => {
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
  assert.equal(parsePath(topo, null), null);
  assert.equal(parsePath(topo, undefined), null);
  assert.equal(parsePath(topo, 123), null);
  assert.equal(parsePath(topo, "issues/\0nul.md"), null);
});

test("pathFor: async compiler returns a Promise — clear error message", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [x]
          to_path: |
            async function to_path({ x }) { return "issues/" + x + ".md"; }
      facet_inputs:
        x: { type: string }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.throws(
    () => pathFor(topo, "knowledge", { x: "a" }),
    /Promise.*async compilers are not supported/i,
  );
});

test("pathFor: generator compiler returns an iterator — clear error message", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [x]
          to_path: |
            function* to_path({ x }) { yield "issues/" + x + ".md"; }
      facet_inputs:
        x: { type: string }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.throws(() => pathFor(topo, "knowledge", { x: "a" }), /generator\/iterator/i);
});

test("pathFor: compiler returning a non-string (number) is rejected", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [x]
          to_path: |
            (_) => 42
      facet_inputs:
        x: { type: string }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  assert.throws(() => pathFor(topo, "knowledge", { x: "a" }), /returned number, expected string/);
});

test("loadTopology rejects YAML where topology.file_kinds is missing", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds: {}
      facet_inputs:
        x: { type: string }
`);
  _resetCacheForTests();
  await assert.rejects(() => loadTopology(wiki), /no file_kinds/);
});

test("loadTopology rejects YAML where topology block is missing entirely", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    placement_facets: []
`);
  _resetCacheForTests();
  await assert.rejects(() => loadTopology(wiki), /no \.topology declaration/);
});

test("parsePath returns first-match for paths that could match two file_kinds", async () => {
  // Both knowledge and plan use templates that COULD share a prefix; the
  // narrower kind (plan) is declared first to ensure it wins.
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        plan:
          required_facets: [x]
          path_template: "issues/plans/{x}.plan.md"
        knowledge:
          required_facets: [x]
          path_template: "issues/plans/{x}.md"
      facet_inputs:
        x: { type: string }
`);
  _resetCacheForTests();
  const topo = await loadTopology(wiki);
  const parsedPlan = parsePath(topo, "issues/plans/foo.plan.md");
  assert.ok(parsedPlan);
  assert.equal(parsedPlan.kind, "plan");
  const parsedKnow = parsePath(topo, "issues/plans/foo.md");
  assert.ok(parsedKnow);
  assert.equal(parsedKnow.kind, "knowledge");
});
