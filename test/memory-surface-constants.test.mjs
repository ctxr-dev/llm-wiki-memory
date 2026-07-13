import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKER_ID,
  POINTER_PREFIX,
  DOC_MARKER_START,
  DOC_MARKER_END,
  HASH_MARKER_START,
  HASH_MARKER_END,
  MEMORY_DOCS,
  RULE_SURFACES,
} from "../scripts/lib/memory-surface-constants.mjs";

test("surface-constants: the shared vocab is stable and matches the on-disk markers", () => {
  assert.equal(MARKER_ID, "llm-wiki-memory");
  assert.equal(POINTER_PREFIX, "llm-wiki-memory-");
  // These MUST equal the markers already living in installed AGENTS.md/CLAUDE.md.
  assert.equal(DOC_MARKER_START, "<!-- BEGIN llm-wiki-memory -->");
  assert.equal(DOC_MARKER_END, "<!-- END llm-wiki-memory -->");
  // Shell-comment fence for .gitignore (conda-style anchors).
  assert.equal(HASH_MARKER_START, "# >>> llm-wiki-memory >>>");
  assert.equal(HASH_MARKER_END, "# <<< llm-wiki-memory <<<");
  assert.deepEqual(MEMORY_DOCS, ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(RULE_SURFACES, [
    ".agents/rules",
    ".claude/skills",
    ".claude/rules",
    ".cursor/rules",
  ]);
});
