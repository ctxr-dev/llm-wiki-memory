import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateLayoutText, validateLayoutFile } from "../scripts/lib/layout-validator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");

test("validator accepts the shipped default layout template", () => {
  const fp = path.join(SRC, "examples/layouts/default/layout.yaml");
  const result = validateLayoutFile(fp);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test("validator accepts the shipped tracker-issues layout template", () => {
  const fp = path.join(SRC, "examples/layouts/tracker-issues/layout.yaml");
  const result = validateLayoutFile(fp);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test("validator accepts the shipped repo layout template", () => {
  const fp = path.join(SRC, "examples/layouts/repo/layout.yaml");
  const result = validateLayoutFile(fp);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test("validator rejects an empty layout list with a location", () => {
  const text = `
layout: []
`.trim();
  const result = validateLayoutText(text);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.path.startsWith("layout") && e.message.includes("at least one")),
  );
});

test("validator pins error to the right line for a missing required field", () => {
  const text = `
layout:
  - placement_facets: [area]
    max_depth: 5
`;
  const result = validateLayoutText(text);
  assert.equal(result.ok, false);
  const pathErr = result.errors.find((e) => e.path.includes("path"));
  assert.ok(pathErr, JSON.stringify(result.errors));
  // The missing `path` is reported on the entry's start line — we don't pin
  // it to a precise column inside the (absent) key, but the line must point
  // at the entry block.
  assert.ok(pathErr.line >= 2, `expected line >= 2, got ${pathErr.line}`);
});

test("validator catches a typo in a field name (strict mode)", () => {
  const text = `
layout:
  - path: knowledge
    placment_facets: [area, atom_type]
    max_depth: 5
`;
  const result = validateLayoutText(text);
  assert.equal(result.ok, false);
  // The strict() schema flags unrecognised keys.
  assert.ok(
    result.errors.some(
      (e) =>
        e.message.toLowerCase().includes("unrecognized") ||
        e.message.toLowerCase().includes("unknown"),
    ),
    `expected an unrecognised-key error; got ${JSON.stringify(result.errors)}`,
  );
});

test("validator rejects out-of-set placement_strategy", () => {
  const text = `
layout:
  - path: daily
    placement_strategy: badname
`;
  const result = validateLayoutText(text);
  assert.equal(result.ok, false);
  const e = result.errors.find((x) => x.path.includes("placement_strategy"));
  assert.ok(e);
  assert.ok(e.line >= 3 && e.line <= 4, `expected line near placement_strategy; got ${e.line}`);
});

test("validator rejects malformed topology block with precise location", () => {
  const text = `
layout:
  - path: issues
    topology:
      strategy: not_a_real_strategy
      helper:
        module: x.mjs
      file_kinds:
        knowledge:
          required_facets: [tracker, prefix, number]
          path_template: ""
`;
  const result = validateLayoutText(text);
  assert.equal(result.ok, false);
  // Two errors expected: strategy enum + empty path_template
  const strategyErr = result.errors.find((e) => e.path.endsWith("strategy"));
  const tmplErr = result.errors.find((e) => e.path.endsWith("path_template"));
  assert.ok(strategyErr, JSON.stringify(result.errors));
  assert.ok(tmplErr, JSON.stringify(result.errors));
  assert.ok(strategyErr.line >= 4, `strategy error line: ${strategyErr.line}`);
  assert.ok(tmplErr.line >= 8, `path_template error line: ${tmplErr.line}`);
});

test("validator rejects path_template without any {variable}", () => {
  const text = `
layout:
  - path: issues
    topology:
      strategy: caller_path
      helper:
        module: x.mjs
      file_kinds:
        knowledge:
          required_facets: [foo]
          path_template: "issues/static/path.md"
`;
  const result = validateLayoutText(text);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("placeholder")));
});

test("validator catches YAML parse errors with line info", () => {
  const text = `layout:\n  - path: knowledge\n  this is: : not: valid\n`;
  const result = validateLayoutText(text);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "<yaml-parse>"));
  assert.ok(result.errors[0].line > 0);
});

test("validator reports missing file with a single error", () => {
  const result = validateLayoutFile("/does/not/exist.yaml");
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /not found/);
});

test("validator rejects file_kinds entry with empty required_facets", () => {
  const text = `
layout:
  - path: issues
    topology:
      strategy: caller_path
      helper:
        module: x.mjs
      file_kinds:
        knowledge:
          required_facets: []
          path_template: "issues/{x}.md"
`;
  const result = validateLayoutText(text);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("at least one")));
});

test("validator accepts a fully-formed custom topology entry", () => {
  const text = `
layout:
  - path: issues
    placement_facets: []
    allow_entry_types: [primary]
    max_depth: 8
    topology:
      strategy: caller_path
      helper:
        module: scripts/lib/topologies/tracker-issue.mjs
        package: llm-wiki-memory
        schema_version: 1
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
  const result = validateLayoutText(text);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});
