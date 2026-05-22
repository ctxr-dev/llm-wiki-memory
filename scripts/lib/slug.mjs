export function slugify(text, { maxLen = 60 } = {}) {
  const base = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return "untitled";
  return base.slice(0, maxLen).replace(/-+$/g, "") || "untitled";
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

export function timestampUtc(date = new Date()) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    pad(date.getUTCMilliseconds(), 3)
  );
}

// Nested date path for the daily category: "2026/05/22". Keeps any single
// directory from accumulating an unbounded number of sibling entries.
export function dailyDatePath(date = new Date()) {
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
}

export function dailyDocName(date = new Date()) {
  return `daily-${timestampUtc(date)}.md`;
}

export function knowledgeDocName(slugOrTitle, date = new Date()) {
  return `knowledge-${slugify(slugOrTitle)}-${timestampUtc(date)}.md`;
}

export function lessonDocName(slugOrTitle, date = new Date()) {
  return `lesson-${slugify(slugOrTitle)}-${timestampUtc(date)}.md`;
}

const DAILY_RE = /^daily-(\d{4})-(\d{2})-(\d{2})-(\d{6})(\d{3})\.md$/;
const KNOWLEDGE_RE = /^knowledge-(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{6})(\d{3})\.md$/;
const LESSON_RE = /^lesson-(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{6})(\d{3})\.md$/;

export function parseDailyDocName(name) {
  const m = String(name || "").match(DAILY_RE);
  if (!m) return null;
  const [, y, mo, d, hms, ms] = m;
  return { date: `${y}-${mo}-${d}`, time: hms, ms };
}

export function parseKnowledgeDocName(name) {
  const m = String(name || "").match(KNOWLEDGE_RE);
  if (!m) return null;
  const [, slug, y, mo, d, hms, ms] = m;
  return { slug, date: `${y}-${mo}-${d}`, time: hms, ms };
}

export function parseLessonDocName(name) {
  const m = String(name || "").match(LESSON_RE);
  if (!m) return null;
  const [, slug, y, mo, d, hms, ms] = m;
  return { slug, date: `${y}-${mo}-${d}`, time: hms, ms };
}
