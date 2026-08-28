import { test } from "node:test";
import assert from "node:assert/strict";
import { embedTextForLeaf } from "../scripts/lib/wiki-core.mjs";
import { stripDiagramMarkup } from "../scripts/lib/diagram-markup.mjs";

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

const DIAGRAM = [
  '<div class="dd"><style>',
  ".dd svg{--paper:#f5f5f5;--ink:#2d3142}",
  ".dd .nb{fill:var(--card);stroke-width:1}",
  '</style><svg viewBox="0 0 640 300" role="img">',
  '<defs><marker id="a-a" refX="7"><path d="M0,0.5 L8,4 L0,7.5 Z"/></marker></defs>',
  '<rect class="nb" x="12" y="20" width="150" height="44"/>',
  '<text class="nn" x="107" y="38"><tspan x="107" dy="0">scala-webhooks</tspan>',
  '<tspan x="107" dy="13">auth · blocked-shop filter</tspan></text>',
  '<path class="e async" d="M162,42 C200,42 220,80 258,80"/>',
  '<text class="el" x="210" y="58">Kafka captured-order.1: CapturedOrder Avro</text>',
  "</svg></div>",
].join("\n");

test("stripDiagramMarkup: drops svg geometry and css, keeps text/tspan labels", () => {
  const out = stripDiagramMarkup(DIAGRAM);
  assert.ok(!out.includes("viewBox"), "viewBox survived");
  assert.ok(!out.includes("<path"), "path geometry survived");
  assert.ok(!out.includes("--paper"), "css custom property survived");
  assert.ok(!out.includes("<style"), "style tag survived");
  assert.ok(out.includes("scala-webhooks"), "node label was dropped");
  assert.ok(out.includes("auth · blocked-shop filter"), "node subtitle was dropped");
  assert.ok(
    out.includes("Kafka captured-order.1: CapturedOrder Avro"),
    "edge label was dropped — these are the diagram's whole retrievable content",
  );
});

// A real leaf in the corpus is titled "GitHub strips <style>, style= and data: URIs
// from markdown" and mentions `<style>` five times in prose and backticks, with no
// closing tag anywhere. Requiring a real open/close PAIR is the only reason its own
// subject is not deleted from its embed text. An open-tag-only pattern would eat it.
test("stripDiagramMarkup: an inline mention with no closing tag is left alone", () => {
  const body =
    "GitHub's sanitizer removes `<style>` blocks and inline `style=` attributes.\n" +
    "A bare <svg> named in prose is not a diagram either.";
  assert.equal(stripDiagramMarkup(body), body);
});

test("stripDiagramMarkup: an unclosed block is left alone rather than eating the rest", () => {
  const body = 'intro\n<svg viewBox="0 0 8 8"><rect/>\ntail prose that must survive';
  const out = stripDiagramMarkup(body);
  assert.ok(out.includes("tail prose that must survive"), "trailing prose was swallowed");
  assert.ok(out.includes("intro"));
});

test("stripDiagramMarkup: shrinks a diagram leaf by most of its length", () => {
  const body = `Prose before.\n\n${DIAGRAM}\n\nProse after.`;
  const out = stripDiagramMarkup(body);
  assert.ok(out.includes("Prose before."), "leading prose lost");
  assert.ok(out.includes("Prose after."), "trailing prose lost");
  assert.ok(out.length < body.length / 2, `expected >50% shrink, got ${out.length}/${body.length}`);
});

test("stripDiagramMarkup: markup-free bodies are returned byte-identical", () => {
  const body = "# Title\n\nA body with a `<code>` span and a < b comparison.";
  assert.equal(stripDiagramMarkup(body), body);
  assert.equal(stripDiagramMarkup(""), "");
  assert.equal(stripDiagramMarkup(undefined), "");
});

test("stripDiagramMarkup: handles several diagrams in one body independently", () => {
  const body = `${DIAGRAM}\nmiddle prose\n${DIAGRAM.replace("scala-webhooks", "bumblebee")}`;
  const out = stripDiagramMarkup(body);
  assert.ok(out.includes("scala-webhooks"));
  assert.ok(out.includes("bumblebee"));
  assert.ok(out.includes("middle prose"));
  assert.ok(!out.includes("<svg"), "an svg block escaped the strip");
});

test("embedTextForLeaf: embeds the stripped body, so chunkTexts can recover the header", () => {
  const out = leaf({ focus: "Core platform" }, `Prose.\n\n${DIAGRAM}`);
  assert.ok(out.startsWith("Core platform\n\n"));
  assert.ok(!out.includes("viewBox"), "geometry reached the embedded text");
  assert.ok(out.includes("scala-webhooks"), "labels were lost from the embedded text");
  assert.ok(
    out.endsWith(stripDiagramMarkup(`Prose.\n\n${DIAGRAM}`)),
    "embedText must end with the stripped body — chunkTexts slices the header off by length",
  );
});
