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
  deriveDigitBuckets,
  _resetCacheForTests,
} from "../scripts/lib/topologies/tracker-issue.mjs";

// Note: this helper is filesystem-pure (only loadTopology reads disk). Tests
// here exercise the deterministic path/parse round-trip and validation
// contract independent of the wiki-store / MCP layer.

function tmpWiki(layoutYaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-iss-test-"));
  fs.writeFileSync(path.join(dir, ".llmwiki.layout.yaml"), layoutYaml);
  return dir;
}

const STANDARD_YAML = `
layout:
  - path: issues
    placement_facets: []
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [tracker, prefix, number]
          path_template: "issues/{tracker}/{prefix}/{thousands}/{hundreds_tens}/{units}/{prefix}-{number}.md"
        plan:
          required_facets: [tracker, prefix, number, lifecycle, slug]
          enums:
            lifecycle: [pending, in-progress, done, archived]
          path_template: "issues/{tracker}/{prefix}/{thousands}/{hundreds_tens}/{units}/{lifecycle}/{prefix}-{number}-{slug}.plan.md"
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
        lifecycle: { type: string }
        slug: { type: string, pattern: "^[A-Za-z0-9-]+$" }
`;

test("deriveDigitBuckets: 129957 -> {thousands:129, hundreds_tens:95, units:7}", () => {
  assert.deepEqual(deriveDigitBuckets(129957), {
    thousands: 129,
    hundreds_tens: 95,
    units: 7,
  });
});

test("deriveDigitBuckets: small / large / string-input edge cases", () => {
  assert.deepEqual(deriveDigitBuckets(1), { thousands: 0, hundreds_tens: 0, units: 1 });
  assert.deepEqual(deriveDigitBuckets(42), { thousands: 0, hundreds_tens: 4, units: 2 });
  assert.deepEqual(deriveDigitBuckets(957), { thousands: 0, hundreds_tens: 95, units: 7 });
  assert.deepEqual(deriveDigitBuckets(1234567), {
    thousands: 1234,
    hundreds_tens: 56,
    units: 7,
  });
  assert.deepEqual(deriveDigitBuckets("42"), { thousands: 0, hundreds_tens: 4, units: 2 });
});

test("deriveDigitBuckets: rejects negative / non-integer / non-numeric", () => {
  assert.throws(() => deriveDigitBuckets(-1));
  assert.throws(() => deriveDigitBuckets(1.5));
  assert.throws(() => deriveDigitBuckets("abc"));
});

test("loadTopology reads file_kinds + facet_inputs", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  assert.equal(topo.strategy, "caller_path");
  assert.deepEqual(
    topo.fileKinds.knowledge.required_facets,
    ["tracker", "prefix", "number"],
  );
  assert.deepEqual(topo.fileKinds.plan.enums.lifecycle, [
    "pending",
    "in-progress",
    "done",
    "archived",
  ]);
});

test("pathFor knowledge: DEV-129957 -> issues/JIRA/DEV/129/95/7/DEV-129957.md", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 129957 }),
    "issues/JIRA/DEV/129/95/7/DEV-129957.md",
  );
});

test("pathFor plan: lifecycle + slug + .plan.md", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
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

test("pathFor: 1-digit and 7-digit numbers", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 1 }),
    "issues/JIRA/DEV/0/0/1/DEV-1.md",
  );
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 1234567 }),
    "issues/JIRA/DEV/1234/56/7/DEV-1234567.md",
  );
});

test("pathFor: non-JIRA trackers (GitHub, Linear) follow the same shape", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  assert.equal(
    pathFor(topo, "knowledge", {
      tracker: "GITHUB",
      prefix: "my-org-my-repo",
      number: 42,
    }),
    "issues/GITHUB/my-org-my-repo/0/4/2/my-org-my-repo-42.md",
  );
  assert.equal(
    pathFor(topo, "knowledge", { tracker: "LINEAR", prefix: "ENG", number: 1234 }),
    "issues/LINEAR/ENG/1/23/4/ENG-1234.md",
  );
});

test("validateFacets: missing required facets", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  const r = validateFacets(topo, "plan", { tracker: "JIRA", prefix: "DEV", number: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("lifecycle")));
  assert.ok(r.errors.some((e) => e.includes("slug")));
});

test("validateFacets: out-of-enum lifecycle rejected", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  const r = validateFacets(topo, "plan", {
    tracker: "JIRA",
    prefix: "DEV",
    number: 1,
    lifecycle: "merged",
    slug: "x",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("'merged'") && e.includes("lifecycle")));
});

test("validateFacets: slug pattern enforcement", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  const r = validateFacets(topo, "plan", {
    tracker: "JIRA",
    prefix: "DEV",
    number: 1,
    lifecycle: "pending",
    slug: "bad slug with spaces",
  });
  assert.equal(r.ok, false);
});

test("parsePath round-trips a knowledge path", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  const facets = { tracker: "JIRA", prefix: "DEV", number: 129957 };
  const parsed = parsePath(topo, pathFor(topo, "knowledge", facets));
  assert.ok(parsed);
  assert.equal(parsed.kind, "knowledge");
  assert.equal(parsed.facets.tracker, "JIRA");
  assert.equal(parsed.facets.prefix, "DEV");
  assert.equal(parsed.facets.number, 129957);
});

test("parsePath round-trips a plan path (lifecycle + slug with hyphens)", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  const facets = {
    tracker: "JIRA",
    prefix: "DEV",
    number: 129957,
    lifecycle: "in-progress",
    slug: "investigate-timeout",
  };
  const parsed = parsePath(topo, pathFor(topo, "plan", facets));
  assert.ok(parsed);
  assert.equal(parsed.kind, "plan");
  assert.equal(parsed.facets.lifecycle, "in-progress");
  assert.equal(parsed.facets.slug, "investigate-timeout");
  assert.equal(parsed.facets.number, 129957);
});

test("parsePath: null for non-conforming paths", () => {
  const wiki = tmpWiki(STANDARD_YAML);
  _resetCacheForTests();
  const topo = loadTopology(wiki);
  assert.equal(parsePath(topo, "knowledge/foo/bar.md"), null);
  assert.equal(parsePath(topo, "issues/random/path/that/does/not/fit.md"), null);
});

test("loadTopology throws when entry has no .topology block", () => {
  const wiki = tmpWiki(`
layout:
  - path: issues
    placement_facets: []
`);
  _resetCacheForTests();
  assert.throws(() => loadTopology(wiki), /no \.topology declaration/);
});

test("loadTopology throws when YAML is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "missing-yaml-"));
  _resetCacheForTests();
  assert.throws(() => loadTopology(dir), /not found/);
});
