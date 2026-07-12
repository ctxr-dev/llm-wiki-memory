import test from "node:test";
import assert from "node:assert/strict";
import * as datasets from "../scripts/lib/datasets.mjs";
import {
  DEFAULT_CATEGORIES as SRC_CATEGORIES,
  SELF_IMPROVEMENT as SRC_SI,
  KNOWLEDGE as SRC_K,
} from "../scripts/lib/wiki-layout-parse.mjs";
import * as enums from "../scripts/lib/context/enums.mjs";

test("enums re-export the source vocabulary verbatim", () => {
  assert.deepEqual(enums.ATOM_TYPES_LIST, datasets.ATOM_TYPES_LIST);
  assert.deepEqual(enums.TASK_TYPES_LIST, datasets.TASK_TYPES_LIST);
  assert.deepEqual(enums.PRIORITY_VALUES, datasets.PRIORITY_VALUES);
  assert.deepEqual(enums.DEFAULT_CATEGORIES, SRC_CATEGORIES);
  assert.equal(enums.SELF_IMPROVEMENT, SRC_SI);
  assert.equal(enums.KNOWLEDGE, SRC_K);
});

test("the ordered tuples are the single source of the derived Sets", () => {
  assert.deepEqual([...datasets.ATOM_TYPES], [...datasets.ATOM_TYPES_LIST]);
  assert.deepEqual([...datasets.TASK_TYPES], [...datasets.TASK_TYPES_LIST]);
});

test("the category-name constants match their strings and live in DEFAULT_CATEGORIES", () => {
  assert.equal(enums.SELF_IMPROVEMENT, "self_improvement");
  assert.equal(enums.KNOWLEDGE, "knowledge");
  assert.ok(enums.DEFAULT_CATEGORIES.includes(enums.SELF_IMPROVEMENT));
  assert.ok(enums.DEFAULT_CATEGORIES.includes(enums.KNOWLEDGE));
});

test("vocabulary constants carry the exact pre-refactor literal values", () => {
  assert.deepEqual({ ...enums.OWNERSHIP }, { REPO: "repo", WIKI: "wiki" });
  assert.deepEqual([...enums.OWNERSHIP_VALUES], ["repo", "wiki"]);
  assert.equal(enums.BRAIN_TARGET, "brain");
  assert.deepEqual([...enums.SECTION_VALUES], ["frontmatter", "body"]);
  assert.deepEqual([...enums.SUPERSEDES_ACTION_VALUES], ["disable", "delete"]);
  assert.deepEqual([...enums.AUDIT_CLASS_VALUES], ["duplicate-error-pattern", "missing-metadata"]);
  assert.deepEqual(
    { ...enums.AUDIT_CLASSES },
    { DUPLICATE_ERROR_PATTERN: "duplicate-error-pattern", MISSING_METADATA: "missing-metadata" },
  );
  assert.deepEqual([...enums.PRIORITY_VALUES], ["P0", "P1", "P2"]);
  assert.equal(enums.DEFAULT_TOPOLOGY_CATEGORY, "issues");
  assert.equal(enums.PLAN_SUFFIX, ".plan.md");
  assert.deepEqual({ ...enums.KIND }, { PLAN: "plan", KNOWLEDGE: "knowledge" });
  assert.equal(enums.MCP_ACTOR, "mcp");
  assert.deepEqual(
    { ...enums.MCP_OPS },
    {
      SAVE_LESSON: "mcp-save-lesson",
      SAVE: "mcp-save",
      WRITE_MEMORY: "mcp-write-memory",
      DISABLE: "mcp-disable",
      ENABLE: "mcp-enable",
      DELETE: "mcp-delete",
      MOVE: "mcp-move",
    },
  );
});

test("shared zod enums accept exactly the tuple values and reject anything else", () => {
  for (const v of enums.PRIORITY_VALUES) assert.equal(enums.PrioritySchema.parse(v), v);
  assert.throws(() => enums.PrioritySchema.parse("P3"));
  for (const v of enums.SECTION_VALUES) assert.equal(enums.SectionSchema.parse(v), v);
  assert.throws(() => enums.SectionSchema.parse("footer"));
  for (const v of enums.SUPERSEDES_ACTION_VALUES)
    assert.equal(enums.SupersedesActionSchema.parse(v), v);
  assert.throws(() => enums.SupersedesActionSchema.parse("archive"));
  for (const v of enums.AUDIT_CLASS_VALUES) assert.equal(enums.AuditClassSchema.parse(v), v);
  assert.throws(() => enums.AuditClassSchema.parse("unknown-class"));
});

test("shared constants are frozen (no stale-binding mutation)", () => {
  assert.ok(Object.isFrozen(enums.DEFAULT_CATEGORIES));
  assert.ok(Object.isFrozen(enums.PRIORITY_VALUES));
  assert.ok(Object.isFrozen(enums.OWNERSHIP));
  assert.ok(Object.isFrozen(enums.MCP_OPS));
  assert.ok(Object.isFrozen(datasets.ATOM_TYPES_LIST));
});
