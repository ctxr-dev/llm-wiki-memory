import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogueTable, kindCatalogue } from "../scripts/lib/diagrams/registry.mjs";
import "../scripts/lib/diagrams/index.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RULE = path.join(repo, "templates/rules/legible-references-and-diagrams.md");
const BEGIN = "<!-- BEGIN GENERATED diagram-kinds";
const END = "<!-- END GENERATED diagram-kinds -->";

/** @returns {string} */
function committedTable() {
  const md = fs.readFileSync(RULE, "utf8");
  const start = md.indexOf(BEGIN);
  const end = md.indexOf(END);
  assert.ok(start >= 0 && end > start, "the rule must carry the generated diagram-kinds block");
  const inner = md.slice(md.indexOf("-->", start) + 3, end);
  return inner.trim();
}

test("the rule's diagram-kinds table matches the registry exactly", () => {
  // The whole point of generating this table is that it cannot rot. If this
  // fails, a kind was added or reworded without regenerating the rule, and every
  // agent reading the rule is now being told something untrue about what the
  // engine can draw. Regenerate with:
  //   node scripts/cli.mjs render-diagram --list --table
  assert.equal(committedTable(), catalogueTable());
});

test("every registered kind documents when to pick it", () => {
  for (const { kind, use, pick } of kindCatalogue()) {
    assert.ok(use.length > 8, `${kind} has no usable "use" line`);
    assert.ok(pick.length > 8, `${kind} has no usable "pick" cue`);
    // One line each: the catalogue is read by an agent that is choosing, not
    // studying, so it has to stay cheap enough to load whole.
    assert.ok(
      !use.includes("\n") && !pick.includes("\n"),
      `${kind} catalogue text must be one line`,
    );
    assert.ok(use.length < 90 && pick.length < 90, `${kind} catalogue text is too long to scan`);
  }
});

test("the always-loaded discipline text carries no diagram catalogue", () => {
  // The discipline is injected into EVERY session (MCP initialize instructions
  // plus the SessionStart hook), so anything added there is a permanent
  // per-session token cost. The catalogue therefore lives in the on-demand rule
  // file, and the discipline must not grow a copy of it.
  const discipline = fs.readFileSync(
    path.join(repo, "templates/agents-memory-instructions.md"),
    "utf8",
  );
  for (const { kind } of kindCatalogue()) {
    assert.ok(
      !discipline.includes(`\`${kind}\``),
      `the discipline text names the diagram kind ${kind}; keep the catalogue in the rule file`,
    );
  }
  assert.ok(
    !discipline.includes("render-diagram"),
    "the discipline text must not document the diagram CLI; that belongs in the rule",
  );
});
