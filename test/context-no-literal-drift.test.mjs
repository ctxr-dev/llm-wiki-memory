import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// A1 replaced these LOGIC literals with shared constants from context/enums.mjs.
// Human-facing description PROSE (the strings that teach the model) intentionally
// keeps the plain words — they are documentation, not routing logic.
/** @type {Record<string, string[]>} */
const FORBIDDEN = {
  "mcp-server/mcp-schemas.mjs": ['z.enum(["P0"'],
  "mcp-server/tools-write.mjs": ['z.enum(["P0"', 'z.enum(["disable"', 'op: "mcp-', 'actor: "mcp"'],
  "mcp-server/tools-documents.mjs": ['op: "mcp-', 'actor: "mcp"'],
  "mcp-server/tools-search.mjs": ['z.enum(["frontmatter"'],
  "mcp-server/tools-maintenance.mjs": [
    'z.enum(["duplicate-error-pattern"',
    '|| "issues"',
    '["self_improvement", "knowledge"]',
    'slot === "self_improvement"',
    'has("missing-metadata")',
    'has("duplicate-error-pattern")',
    'class: "missing-metadata"',
    'class: "duplicate-error-pattern"',
  ],
  "mcp-server/mcp-write-gate.mjs": [
    '=== "self_improvement"',
    ', "self_improvement")',
    '? "plan" : "knowledge"',
    'endsWith(".plan.md")',
  ],
  "mcp-server/mcp-write-target.mjs": ['!== "repo"'],
  "scripts/lib/scope-scanner.mjs": ['ownership: "repo"', 'ownership: "wiki"'],
  "scripts/lib/wiki-context.mjs": ['z.enum(["repo"', '=== "brain"', 'ownership === "wiki"'],
  "scripts/cli-validate.mjs": ['|| "issues"', 'categoryPath = "issues"'],
};

for (const [rel, patterns] of Object.entries(FORBIDDEN)) {
  test(`no residual logic-literal in ${rel}`, () => {
    const src = read(rel);
    for (const p of patterns) {
      assert.ok(!src.includes(p), `expected a shared constant, found literal ${JSON.stringify(p)}`);
    }
  });
}

test("every migrated file imports the shared enums module", () => {
  for (const rel of Object.keys(FORBIDDEN)) {
    assert.match(read(rel), /context\/enums\.mjs/, `${rel} should import context/enums.mjs`);
  }
});
