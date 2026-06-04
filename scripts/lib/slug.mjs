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

// Cap text without cutting mid-word: hard caps on LLM-authored titles/bodies
// used to slice blindly, shipping leaves that ended "varies by contex". The
// cut backs off a dangling UTF-16 high surrogate (truncation mirror of
// chunker.mjs surrogateSafe, which shifts FORWARD because it keeps the left
// chunk), then retreats to the last whitespace — or, for bodies
// (preferSentence), to the last sentence end within the final sentenceWindow
// chars. Falls back to the hard surrogate-safe slice when the text has no
// boundary in range, so the result is never empty for non-empty input.
export function truncateAtWordBoundary(text, max, { preferSentence = false, sentenceWindow = 80 } = {}) {
  const s = String(text ?? "");
  if (!Number.isFinite(max) || max <= 0) return "";
  if (s.length <= max) return s;
  let cut = max;
  // A high surrogate as the LAST retained unit is always dangling — whether
  // its low half sits just past the cut (straddled pair) or the source text
  // was already malformed. Back off unconditionally.
  const hi = s.charCodeAt(cut - 1);
  if (hi >= 0xd800 && hi <= 0xdbff) cut -= 1;
  const hard = s.slice(0, cut);
  if (preferSentence) {
    const windowStart = Math.max(0, cut - sentenceWindow);
    const m = hard.slice(windowStart).match(/^[\s\S]*[.!?](?=\s|$)/);
    if (m && m[0].length > 0) {
      const out = s.slice(0, windowStart + m[0].length).replace(/\s+$/, "");
      if (out) return out;
    }
  }
  const lastWs = hard.search(/\s\S*$/);
  if (lastWs > 0) {
    const out = s.slice(0, lastWs).replace(/\s+$/, "");
    if (out) return out;
  }
  return hard;
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
