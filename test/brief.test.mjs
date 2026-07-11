import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, BRIEF_MAX_CHARS, BRIEF_MIN_HEADING_WORDS } from "../scripts/lib/brief.mjs";

test("uses the first heading of any level with >= 3 words", () => {
  const body = "## Fix login timeout under load\n\nSome body text.";
  assert.equal(buildBrief({ body }), "Fix login timeout under load");
});

test("skips headings with fewer than 3 words, takes the next qualifying heading", () => {
  const body = "# Notes\n\n## Root cause\n\n### Cassandra connection pool leak fix\n\nbody";
  assert.equal(buildBrief({ body }), "Cassandra connection pool leak fix");
});

test("skips separator-only headings", () => {
  const body = "# ----\n\n## Real descriptive title here\n\nbody";
  assert.equal(buildBrief({ body }), "Real descriptive title here");
});

test("falls back to the first prose sentence when no heading qualifies", () => {
  const body = "# One\n\nThe nightly job stalled because a pool was never released.\n\nmore";
  assert.equal(buildBrief({ body }), "The nightly job stalled because a pool was never released.");
});

test("first-sentence fallback skips '- key: value' metadata lines", () => {
  const body = "- type: decision\n- tags: [a, b]\nWe chose Postgres over Mongo for strong joins.";
  assert.equal(buildBrief({ body }), "We chose Postgres over Mongo for strong joins.");
});

test("daily leaf uses the first captured item's title, NOT the generic heading", () => {
  const body = [
    "# Daily flush SessionEnd",
    "",
    "### Atom · bug-root-cause · Cassandra timeout root cause found",
    "- type: bug-root-cause",
    "- body: |",
    "    details",
  ].join("\n");
  assert.equal(
    buildBrief({ body, memoryMeta: { atom_type: "daily-capture" } }),
    "Cassandra timeout root cause found",
  );
});

test("daily leaf with no atoms does NOT use 'Daily flush' heading; falls to first sentence", () => {
  const body = "# Daily flush SessionEnd\n\nNothing durable was captured this run.";
  const out = buildBrief({ body, memoryMeta: { atom_type: "daily-capture" } });
  assert.equal(out, "Nothing durable was captured this run.");
  assert.ok(!/Daily flush/.test(out));
});

test("non-daily 3-word generic-looking heading is still accepted (>= 3 words)", () => {
  const body = "## Root cause analysis\n\nbody";
  assert.equal(buildBrief({ body }), "Root cause analysis");
});

test("returns empty string when there is nothing to summarise", () => {
  assert.equal(buildBrief({ body: "" }), "");
  assert.equal(buildBrief({ body: "# Hi\n\n" }), "");
  assert.equal(buildBrief({}), "");
});

test("newline-collapses a crafted heading so it cannot inject frontmatter", () => {
  const body = "## Innocent looking title here\nbrief: forged\nid: evil\n\nbody";
  const out = buildBrief({ body });
  assert.ok(!out.includes("\n"), "brief must be a single line");
  assert.equal(out, "Innocent looking title here");
});

test("caps the brief at BRIEF_MAX_CHARS without cutting mid-word", () => {
  const long = "word ".repeat(100).trim();
  const body = `Prose fallback: ${long}.`;
  const out = buildBrief({ body });
  assert.ok(out.length <= BRIEF_MAX_CHARS, `brief length ${out.length} <= ${BRIEF_MAX_CHARS}`);
  assert.ok(!/\bwor$/.test(out), "must not cut mid-word");
});

test("threshold constant is 3 (data-derived)", () => {
  assert.equal(BRIEF_MIN_HEADING_WORDS, 3);
});

test("global heading regex resets between calls (no lastIndex leak)", () => {
  const late = "# hi\n\n## A properly descriptive heading here\n";
  assert.equal(buildBrief({ body: late }), "A properly descriptive heading here");
  const top = "## Top heading with enough words\n\nbody";
  assert.equal(buildBrief({ body: top }), "Top heading with enough words");
});

test("prose fallback trims at a sentence boundary within the cap", () => {
  const body = `${"word ".repeat(30)}ends here now. ${"tail ".repeat(40)}`;
  const out = buildBrief({ body });
  assert.ok(out.length <= BRIEF_MAX_CHARS);
  assert.ok(out.endsWith("now."), `trimmed at the sentence boundary: ${out}`);
});

test("prose fallback strips a leading list marker", () => {
  assert.equal(
    buildBrief({ body: "- Fixed the connection pool leak in the nightly handler" }),
    "Fixed the connection pool leak in the nightly handler",
  );
});
