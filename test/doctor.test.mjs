import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const { doctor, findBrokenIndexRefs, findStrayLeaves, findUnlistedChildren } = await import(
  "../scripts/lib/doctor.mjs"
);

// Add a flat curated (consolidate:none) category + a topology category, so we
// can exercise both the curated heuristics AND the topology-skip.
const layoutPath = path.join(wiki, ".layout", "layout.yaml");
const originalLayout = fs.readFileSync(layoutPath, "utf8");
fs.writeFileSync(
  layoutPath,
  `${originalLayout}
  - path: Notes
    consolidate: none
    placement_facets: []
    allow_entry_types: [primary]
  - path: tickets
    consolidate: none
    allow_entry_types: [primary]
    topology:
      strategy: tracker
`,
);
store._resetLayoutCacheForTests();
// No layout-restore hook: the temp dataDir is discarded by cleanup() above.

function w(relPath, body) {
  const abs = path.join(wiki, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}
const FM = (id) => `---\nid: ${id}\ntype: primary\n---\n\n# ${id}\n\nA body.`;
const INDEX = (rows) =>
  `---\nid: Notes\ntype: index\n---\n<!-- BEGIN AUTO-GENERATED NAVIGATION -->\n# Notes\n## Children\n| File | Type | Focus |\n|------|------|-------|\n${rows}\n<!-- END AUTO-GENERATED NAVIGATION -->\n`;
const resetNotes = () => {
  fs.rmSync(path.join(wiki, "Notes"), { recursive: true, force: true });
  fs.rmSync(path.join(wiki, "tickets"), { recursive: true, force: true });
};

test("curatedCategories = flat consolidate:none only (facet + topology excluded)", () => {
  resetNotes();
  w("Notes/Real.md", FM("Real"));
  w("Notes/index.md", INDEX("| [Real.md](Real.md) | primary | Real |"));
  const r = doctor(wiki);
  assert.deepEqual(r.scanned.curatedCategories, ["Notes"], "only Notes is curated");
  assert.ok(!r.scanned.curatedCategories.includes("tickets"), "topology excluded from curated");
  assert.ok(!r.scanned.curatedCategories.includes("knowledge"), "facet category excluded from curated");
  assert.equal(r.ok, true, `clean → ok; got ${JSON.stringify(r.summary)}`);
});

test("broken index ref is flagged", () => {
  resetNotes();
  w("Notes/Real.md", FM("Real"));
  w(
    "Notes/index.md",
    INDEX("| [Real.md](Real.md) | primary | Real |\n| [Gone.md](Gone.md) | primary | Gone |"),
  );
  const broken = findBrokenIndexRefs(wiki);
  assert.ok(
    broken.some((b) => b.index === "Notes/index.md" && b.broken.includes("Gone.md")),
    `Gone.md flagged; got ${JSON.stringify(broken)}`,
  );
  assert.equal(doctor(wiki).ok, false);
});

test("no-frontmatter stray flagged in curated zone; topology leaf NOT flagged", () => {
  resetNotes();
  w("Notes/Real.md", FM("Real"));
  w("Notes/index.md", INDEX("| [Real.md](Real.md) | primary | Real |"));
  w("Notes/Raw.md", "just raw text, no frontmatter\n"); // restore-artifact signature
  w("tickets/raw-ticket.md", "raw ticket, no frontmatter\n"); // topology → must be skipped
  const strays = findStrayLeaves(wiki);
  assert.ok(strays.some((s) => s.stray === "Notes/Raw.md"), "curated stray flagged");
  assert.ok(
    !strays.some((s) => s.stray.startsWith("tickets/")),
    `topology leaf must NOT be flagged; got ${JSON.stringify(strays)}`,
  );
});

test("a real child missing from its index is flagged unlisted", () => {
  resetNotes();
  w("Notes/Real.md", FM("Real"));
  w("Notes/Extra.md", FM("Extra")); // present + frontmatter but NOT in the index
  w("Notes/index.md", INDEX("| [Real.md](Real.md) | primary | Real |"));
  const unlisted = findUnlistedChildren(wiki);
  assert.ok(
    unlisted.some((u) => u.unlisted.some((x) => x.name === "Extra.md")),
    `Extra.md unlisted; got ${JSON.stringify(unlisted)}`,
  );
});

test("CLI: doctor exits 0 when clean, 3 on findings", () => {
  resetNotes();
  w("Notes/Real.md", FM("Real"));
  w("Notes/index.md", INDEX("| [Real.md](Real.md) | primary | Real |"));
  let r = runScript("scripts/cli.mjs", ["doctor"]);
  assert.equal(r.status, 0, `clean → exit 0; got ${r.status}: ${r.stdout}${r.stderr}`);
  w("Notes/Raw.md", "no frontmatter\n");
  r = runScript("scripts/cli.mjs", ["doctor"]);
  assert.equal(r.status, 3, `findings → exit 3; got ${r.status}: ${r.stdout}`);
});
