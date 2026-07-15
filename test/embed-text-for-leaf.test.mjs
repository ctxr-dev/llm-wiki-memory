import { test } from "node:test";
import assert from "node:assert/strict";
import { embedTextForLeaf } from "../scripts/lib/wiki-core.mjs";

const leaf = (data, body) => embedTextForLeaf(data, body);

test("prepends a title · tags · subject header, then a blank line, then the body", () => {
  const out = leaf(
    {
      focus: "Cats-effect resource leak on shutdown",
      tags: ["cats-effect", "resource"],
      memory: { subject: ["languages", "scala", "cats-effect"] },
    },
    "Body about the leak.",
  );
  assert.equal(
    out,
    "Cats-effect resource leak on shutdown · cats-effect, resource · languages / scala / cats-effect\n\nBody about the leak.",
  );
});

test("merges top-level tags[] and memory.tags string, deduped case-insensitively, order preserved", () => {
  const out = leaf({ focus: "T", tags: ["Kamon", "obs"], memory: { tags: "obs, metrics" } }, "b");
  assert.equal(out.split("\n\n")[0], "T · Kamon, obs, metrics");
});

test("subject is joined with ' / ' broad→narrow", () => {
  const out = leaf({ focus: "T", memory: { subject: ["a", "b", "c"] } }, "b");
  assert.equal(out.split("\n\n")[0], "T · a / b / c");
});

test("omits empty header segments (no title, no tags, no subject)", () => {
  const out = leaf({ memory: { subject: ["only", "subject"] } }, "b");
  assert.equal(out.split("\n\n")[0], "only / subject");
});

test("collapses whitespace in focus and trims", () => {
  const out = leaf({ focus: "  a   b\n c  " }, "body");
  assert.equal(out, "a b c\n\nbody");
});

test("no useful frontmatter → returns the body unchanged (no header, no leading newlines)", () => {
  assert.equal(leaf({ memory: {} }, "just the body"), "just the body");
  assert.equal(leaf({}, "just the body"), "just the body");
});

test("null/undefined data → body unchanged", () => {
  assert.equal(leaf(null, "b"), "b");
  assert.equal(leaf(undefined, "b"), "b");
});

test("empty body with a header → header + trailing blank line, no crash", () => {
  assert.equal(leaf({ focus: "Title" }, ""), "Title\n\n");
  assert.equal(leaf({ focus: "Title" }, undefined), "Title\n\n");
});

test("changes the embedded text vs body-only when frontmatter is present (cache re-embeds)", () => {
  const body = "shared body";
  assert.notEqual(leaf({ focus: "Title", memory: { tags: "x" } }, body), body);
  assert.equal(leaf({ memory: {} }, body), body);
});

test("ignores non-array subject and non-array tags without throwing", () => {
  const out = leaf({ focus: "T", tags: "notanarray", memory: { subject: "notanarray" } }, "b");
  assert.equal(out.split("\n\n")[0], "T");
});
