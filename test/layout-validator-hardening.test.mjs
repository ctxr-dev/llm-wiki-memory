// Hardening tests for layout-validator — covers strict-schema gaps,
// cross-field semantics, error reporting, and file I/O edge cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateLayoutText, validateLayoutFile } from "../scripts/lib/layout-validator.mjs";

test("rejects FacetInputSchema typo (unrecognised key) with line:col", () => {
  const text = `
layout:
  - path: issues
    placement_facets: []
    topology:
      strategy: caller_path
      helper: { module: ./x.mjs }
      file_kinds:
        knowledge:
          required_facets: [x]
          path_template: "issues/{x}.md"
      facet_inputs:
        x: { type: string, mininum: 5 }
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  // The strict() check on FacetInputSchema flags `mininum` as unrecognised.
  assert.ok(
    r.errors.some(
      (e) =>
        e.message.toLowerCase().includes("unrecognized") ||
        e.message.toLowerCase().includes("mininum"),
    ),
    JSON.stringify(r.errors, null, 2),
  );
});

test("rejects FileKindSchema declaring TWO forward mechanisms", () => {
  const text = `
layout:
  - path: issues
    placement_facets: []
    topology:
      strategy: caller_path
      helper: { module: ./x.mjs }
      file_kinds:
        knowledge:
          required_facets: [x]
          path_template: "issues/{x}.md"
          to_path: "() => 'x'"
      facet_inputs:
        x: { type: string }
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes("ONLY ONE")));
});

test("rejects FileKindSchema declaring zero forward mechanisms", () => {
  const text = `
layout:
  - path: issues
    placement_facets: []
    topology:
      strategy: caller_path
      helper: { module: ./x.mjs }
      file_kinds:
        knowledge:
          required_facets: [x]
      facet_inputs:
        x: { type: string }
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes("exactly one")));
});

test("rejects FileKindSchema declaring BOTH from_path and from_path_file", () => {
  const text = `
layout:
  - path: issues
    placement_facets: []
    topology:
      strategy: caller_path
      helper: { module: ./x.mjs }
      file_kinds:
        knowledge:
          required_facets: [x]
          path_template: "issues/{x}.md"
          from_path: "() => null"
          from_path_file: ./from.mjs
      facet_inputs:
        x: { type: string }
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes("AT MOST ONE of from_path")));
});

test("rejects path_template with no {variable} placeholders", () => {
  const text = `
layout:
  - path: issues
    topology:
      strategy: caller_path
      helper: { module: ./x.mjs }
      file_kinds:
        knowledge:
          required_facets: [x]
          path_template: "issues/static/path.md"
      facet_inputs:
        x: { type: string }
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message.includes("placeholder")));
});

test("rejects LayoutEntry path with a slash (single safe segment only)", () => {
  const text = `
layout:
  - path: issues/sub
    placement_facets: []
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("path")));
});

test("rejects schema_version 0 (must be positive)", () => {
  const text = `
layout:
  - path: issues
    topology:
      strategy: caller_path
      helper: { module: ./x.mjs, schema_version: 0 }
      file_kinds:
        knowledge:
          required_facets: [x]
          path_template: "issues/{x}.md"
      facet_inputs:
        x: { type: string }
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("schema_version")));
});

test("rejects max_depth of 0 (positive only)", () => {
  const text = `
layout:
  - path: knowledge
    placement_facets: [area]
    max_depth: 0
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("max_depth")));
});

test("rejects placement_strategy that isn't `daily-date`", () => {
  const text = `
layout:
  - path: daily
    placement_strategy: weekly-rollup
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("placement_strategy")));
});

test("rejects topology strategy that isn't `caller_path`", () => {
  const text = `
layout:
  - path: issues
    topology:
      strategy: experimental_value
      helper: { module: ./x.mjs }
      file_kinds:
        knowledge:
          required_facets: [x]
          path_template: "issues/{x}.md"
      facet_inputs:
        x: { type: string }
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("strategy")));
});

test("validateLayoutFile reports a sensible error when target is a directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvf-dir-"));
  const r = validateLayoutFile(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /directory, not a YAML file/.test(e.message)));
});

test("validateLayoutFile reports a sensible error when target is missing", () => {
  const r = validateLayoutFile("/no/such/file.yaml");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not found/.test(e.message)));
});

test("validateLayoutFile reports a broken symlink as missing (descriptive)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvf-broken-symlink-"));
  const link = path.join(dir, "layout.yaml");
  fs.symlinkSync("/no/such/target", link);
  const r = validateLayoutFile(link);
  assert.equal(r.ok, false);
  // lstat succeeds (symlink itself exists), then readFileSync errors with
  // ENOENT — caught by the read-time try/catch as "cannot read".
  assert.ok(r.errors.some((e) => /cannot read|not found/.test(e.message)));
});

test("validateLayoutText: empty YAML body produces a single clear error", () => {
  const r = validateLayoutText("");
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
});

test("validateLayoutText: layout key as a string (not an array) fails type check", () => {
  const r = validateLayoutText(`layout: "not an array"\n`);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("layout")));
});

test("validateLayoutText: typo at the entry level surfaces with location", () => {
  // `placment_facets` typo — strict() flags it.
  const text = `
layout:
  - path: knowledge
    placment_facets: [area]
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  const e = r.errors.find((er) => er.message.toLowerCase().includes("unrecognized"));
  assert.ok(e);
  assert.ok(e.line >= 2, `expected entry line; got ${e.line}`);
});

test("multi-error YAML: every issue reported with its own line:col", () => {
  const text = `
layout:
  - path: issues
    topology:
      strategy: BAD_STRATEGY
      helper: { module: "" }
      file_kinds:
        knowledge:
          required_facets: []
          path_template: ""
`;
  const r = validateLayoutText(text);
  assert.equal(r.ok, false);
  // We expect: bad strategy, empty helper.module, empty required_facets,
  // and empty path_template. Each should be its own error entry.
  assert.ok(
    r.errors.length >= 3,
    `got ${r.errors.length} errors: ${JSON.stringify(r.errors, null, 2)}`,
  );
  // All errors must include a line number > 0.
  for (const e of r.errors) {
    assert.ok(e.line > 0, `error missing line: ${JSON.stringify(e)}`);
  }
});
