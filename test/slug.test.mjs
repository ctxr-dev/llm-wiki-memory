import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugify,
  truncateAtWordBoundary,
  dailyDatePath,
  dailyDocName,
  knowledgeDocName,
  lessonDocName,
  parseDailyDocName,
  parseKnowledgeDocName,
  parseLessonDocName,
} from "../scripts/lib/slug.mjs";

test("slugify normalises to kebab-case", () => {
  assert.equal(slugify("Use OAuth2 over Custom Auth!"), "use-oauth2-over-custom-auth");
  assert.equal(slugify("   "), "untitled");
  assert.equal(slugify("café déjà vu"), "cafe-deja-vu");
});

test("dailyDatePath nests yyyy/mm/dd in UTC", () => {
  const d = new Date(Date.UTC(2026, 4, 22, 9, 0, 0));
  assert.equal(dailyDatePath(d), "2026/05/22");
});

test("doc names round-trip through parsers", () => {
  const d = new Date(Date.UTC(2026, 4, 22, 12, 0, 0, 0));
  const daily = dailyDocName(d);
  assert.match(daily, /^daily-2026-05-22-120000000\.md$/);
  assert.equal(parseDailyDocName(daily).date, "2026-05-22");

  const k = knowledgeDocName("Use OAuth2", d);
  assert.equal(parseKnowledgeDocName(k).slug, "use-oauth2");
  assert.equal(parseKnowledgeDocName(k).date, "2026-05-22");

  const l = lessonDocName("Always Await", d);
  assert.equal(parseLessonDocName(l).slug, "always-await");

  assert.equal(parseDailyDocName("not-a-daily.md"), null);
  assert.equal(parseKnowledgeDocName(daily), null);
});

// ─── truncateAtWordBoundary (mid-word cap fix, 2026-06-04 audit) ───────────

test("truncate: passthrough identity at or under max", () => {
  assert.equal(truncateAtWordBoundary("short title", 80), "short title");
  assert.equal(truncateAtWordBoundary("x".repeat(80), 80), "x".repeat(80));
});

test("truncate: cuts at the last word boundary, stripping trailing space", () => {
  assert.equal(truncateAtWordBoundary("alpha beta gamma", 12), "alpha beta");
});

test("truncate: single long token falls back to the hard slice (never empty)", () => {
  assert.equal(truncateAtWordBoundary("a".repeat(100), 10), "a".repeat(10));
});

test("truncate: max<=0 or non-finite returns empty", () => {
  assert.equal(truncateAtWordBoundary("abc", 0), "");
  assert.equal(truncateAtWordBoundary("abc", -1), "");
  assert.equal(truncateAtWordBoundary("abc", NaN), "");
});

test("truncate: never splits a surrogate pair at the cut", () => {
  const s = "ab" + "😀".repeat(10);
  const out = truncateAtWordBoundary(s, 5);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out), "no dangling high surrogate");
  for (const ch of out) void ch;
});

test("truncate: preferSentence cuts after a sentence end inside the window", () => {
  const s = "First sentence ends here. Second sentence is much longer and will be cut somewhere in the middle";
  const out = truncateAtWordBoundary(s, 60, { preferSentence: true });
  assert.equal(out, "First sentence ends here.");
});

test("truncate: preferSentence falls back to word boundary when no sentence end in window", () => {
  const s = "no terminator anywhere just words flowing on and on and on and on";
  const out = truncateAtWordBoundary(s, 30, { preferSentence: true });
  assert.ok(out.length <= 30);
  assert.ok(!out.endsWith(" "));
  assert.equal(out, "no terminator anywhere just");
});

test("truncate: all-whitespace input yields hard slice fallback semantics", () => {
  const out = truncateAtWordBoundary("          ", 5);
  assert.equal(out, "     ");
});

test("truncate: a LONE trailing high surrogate (malformed source) is also dropped", () => {
  const out = truncateAtWordBoundary("ab\uD83Dxy", 3);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out), "no dangling lone high surrogate");
});
