// Tests for topology-validator — the pre-flight gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateTopologyAgainstSamples,
  formatValidationReport,
} from "../scripts/lib/topology-validator.mjs";
import { _resetCacheForTests } from "../scripts/lib/topology-runtime.mjs";

function tmpWiki(yaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "topo-validator-"));
  fs.mkdirSync(path.join(dir, ".layout"));
  fs.writeFileSync(path.join(dir, ".layout", "layout.yaml"), yaml);
  return dir;
}

test("validateTopologyAgainstSamples: GREEN on a self-consistent topology", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [prefix, number]
          path_template: "issues/{prefix}/{prefix}-{number}.md"
        plan:
          required_facets: [prefix, number, lifecycle, slug]
          enums:
            lifecycle: [pending, in-progress, done]
          path_template: "issues/{prefix}/{lifecycle}/{prefix}-{number}-{slug}.plan.md"
      facet_inputs:
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
        lifecycle: { type: string }
        slug: { type: string }
`);
  _resetCacheForTests();
  const r = await validateTopologyAgainstSamples(wiki);
  assert.equal(r.ok, true);
  assert.equal(r.perKind.length, 2);
  for (const k of r.perKind) {
    assert.equal(k.ok, true, `${k.kind}: ${k.error}`);
    assert.ok(k.samplePath);
  }
});

test("validateTopologyAgainstSamples: RED on a topology with dropped required facet", async () => {
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
  const r = await validateTopologyAgainstSamples(wiki);
  assert.equal(r.ok, false);
  assert.equal(r.perKind[0].ok, false);
  assert.match(r.perKind[0].error, /required facet 'number' is NOT recovered/);
});

test("validateTopologyAgainstSamples: surfaces missing-topology errors", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    placement_facets: []
`);
  _resetCacheForTests();
  const r = await validateTopologyAgainstSamples(wiki);
  assert.equal(r.ok, false);
  assert.match(r.error, /no \.topology declaration/);
});

test("validateTopologyAgainstSamples: overrides let callers supply non-default sample values", async () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [prefix, number]
          path_template: "issues/{prefix}/{prefix}-{number}.md"
      facet_inputs:
        prefix: { type: string, examples: ["DEV"] }
        number: { type: integer, minimum: 1, examples: [42] }
`);
  _resetCacheForTests();
  const r = await validateTopologyAgainstSamples(wiki, {
    overrides: { knowledge: { number: 129957 } },
  });
  assert.equal(r.ok, true);
  assert.ok(r.perKind[0].samplePath.includes("DEV-129957"));
});

test("formatValidationReport: distinguishes ok / fail entries", () => {
  const report = formatValidationReport({
    ok: false,
    perKind: [
      { kind: "knowledge", ok: true, samplePath: "issues/JIRA/DEV/0/0/1/DEV-1.md" },
      {
        kind: "plan",
        ok: false,
        error: "round-trip failure",
        sampleFacets: { prefix: "DEV" },
      },
    ],
  });
  assert.match(report, /✓ knowledge/);
  assert.match(report, /✗ plan/);
  assert.match(report, /1 kind\(s\) passed, 1 failed/);
});
