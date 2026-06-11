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

test("doctor --fix rebuilds broken-ref parents and clears them", () => {
  resetNotes();
  w("Notes/Real.md", FM("Real"));
  w(
    "Notes/index.md",
    INDEX("| [Real.md](Real.md) | primary | Real |\n| [Sub/index.md](Sub/index.md) | index | Sub |"),
  );
  assert.equal(doctor(wiki).ok, false, "phantom Sub/index.md flagged before fix");
  const r = doctor(wiki, { fix: true });
  assert.equal(r.summary.brokenRefs, 0, `cleared after fix; got ${JSON.stringify(r.brokenRefs)}`);
  assert.ok(
    r.fixed.some((f) => f.index === "Notes/index.md" && f.fixed.includes("Sub/index.md")),
    `fixed lists the cleared ref; got ${JSON.stringify(r.fixed)}`,
  );
  const idx = fs.readFileSync(path.join(wiki, "Notes/index.md"), "utf8");
  assert.doesNotMatch(idx, /Sub\/index\.md/, "rebuilt index drops the dead child");
  assert.match(idx, /Real\.md/, "real child kept");
});

test("plain doctor (no --fix) never mutates an index.md", () => {
  resetNotes();
  w("Notes/Real.md", FM("Real"));
  w(
    "Notes/index.md",
    INDEX("| [Real.md](Real.md) | primary | Real |\n| [Sub/index.md](Sub/index.md) | index | Sub |"),
  );
  const before = fs.readFileSync(path.join(wiki, "Notes/index.md"), "utf8");
  const r = doctor(wiki); // default: read-only
  assert.equal(r.ok, false, "still reports the broken ref");
  assert.equal(r.fixed, undefined, "no `fixed` field without --fix");
  assert.equal(
    fs.readFileSync(path.join(wiki, "Notes/index.md"), "utf8"),
    before,
    "index untouched (read-only invariant)",
  );
});

test("doctor --fix on a clean wiki is a no-op (fixed empty, no rewrite)", () => {
  resetNotes();
  w("Notes/Real.md", FM("Real"));
  w("Notes/index.md", INDEX("| [Real.md](Real.md) | primary | Real |"));
  const before = fs.readFileSync(path.join(wiki, "Notes/index.md"), "utf8");
  const r = doctor(wiki, { fix: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fixed, [], "nothing to fix");
  assert.equal(
    fs.readFileSync(path.join(wiki, "Notes/index.md"), "utf8"),
    before,
    "no rebuild when there are no broken refs",
  );
});

test("CLI: doctor --fix exits 0 after clearing; idempotent re-run stays 0", () => {
  resetNotes();
  w("Notes/Real.md", FM("Real"));
  w(
    "Notes/index.md",
    INDEX("| [Real.md](Real.md) | primary | Real |\n| [Sub/index.md](Sub/index.md) | index | Sub |"),
  );
  assert.equal(runScript("scripts/cli.mjs", ["doctor"]).status, 3, "broken → exit 3");
  assert.equal(runScript("scripts/cli.mjs", ["doctor", "--fix"]).status, 0, "fix clears → exit 0");
  assert.equal(runScript("scripts/cli.mjs", ["doctor", "--fix"]).status, 0, "idempotent re-run → exit 0");
});
