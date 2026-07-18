import { test, expect } from "vitest";
import { isLossless, roundTripMarkdown } from "./losslessGuard";

test("plain markdown (headings, bold, lists) round-trips losslessly", () => {
  const md = "# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two\n";
  expect(isLossless(md)).toBe(true);
});

test("a fenced code block round-trips losslessly", () => {
  const md = "Intro.\n\n```js\nconst x = 1;\n```\n";
  expect(isLossless(md)).toBe(true);
  expect(roundTripMarkdown(md)).toContain("const x = 1;");
});

test("markdown that Lexical rewrites (ordered-list renumbering) triggers the source fallback", () => {
  const md = "1. first\n1. second\n1. third\n";
  const out = roundTripMarkdown(md);
  expect(out).toContain("2. second");
  expect(isLossless(md)).toBe(false);
});
