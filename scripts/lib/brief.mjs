import { truncateAtWordBoundary } from "./slug.mjs";

export const BRIEF_MAX_CHARS = 200;
export const BRIEF_MIN_HEADING_WORDS = 3;

const SEPARATOR_ONLY = /^[=\-_*#>~\s]+$/;
const HEADING = /^#{1,6}\s+(.+?)\s*$/gm;
const KEY_VALUE_LINE = /^[-*]\s*\w[\w-]*\s*:/;
const DAILY_ATOM_TITLE = /^### Atom · [^·]+· (.+?)\s*$/m;

function oneLine(s, max = 400) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function wordCount(text) {
  return String(text).split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

function firstAtomTitle(body) {
  const m = String(body || "").match(DAILY_ATOM_TITLE);
  return m ? m[1].trim() : "";
}

function firstHeadingWithMinWords(body, minWords) {
  HEADING.lastIndex = 0;
  let m;
  while ((m = HEADING.exec(String(body || ""))) !== null) {
    const text = m[1].trim();
    if (SEPARATOR_ONLY.test(text)) continue;
    if (wordCount(text) >= minWords) return text;
  }
  return "";
}

function firstProseSentence(body) {
  for (const raw of String(body || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || KEY_VALUE_LINE.test(line)) continue;
    // Strip a leading list marker so a "- prose" line reads as a clean brief.
    return line.replace(/^[-*]\s+/, "");
  }
  return "";
}

// Deterministic, LLM-free one-line brief for a leaf's frontmatter. Order matters:
// daily leaves are handled first because their generated `# Daily flush …` heading
// is itself 3 words and would otherwise satisfy the heading rule while telling the
// reader nothing. Returns "" only when there is genuinely nothing to summarise, so
// the caller can omit the field rather than store an empty one.
export function buildBrief({ body, memoryMeta } = {}) {
  const text = String(body || "");
  const atomType = (memoryMeta && memoryMeta.atom_type) || "";
  const raw =
    atomType === "daily-capture"
      ? firstAtomTitle(text) || firstProseSentence(text)
      : firstHeadingWithMinWords(text, BRIEF_MIN_HEADING_WORDS) || firstProseSentence(text);
  if (!raw) return "";
  // A brief renders at column 0 of re-parseable frontmatter, so newline-collapse it
  // before it can inject YAML or a forged key, then cap at a sentence boundary.
  return truncateAtWordBoundary(oneLine(raw), BRIEF_MAX_CHARS, { preferSentence: true });
}
