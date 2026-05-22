import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugify,
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
