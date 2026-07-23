const META_LINE = /^[-*]\s*\w[\w-]*\s*:/;

/** @param {string} text @returns {string} */
function collapse(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** @param {string} token @returns {string} */
function trimEdges(token) {
  return token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

/** @param {string} query @returns {string[]} */
export function queryTerms(query) {
  return String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .map(trimEdges)
    .filter((term) => term.length >= 2);
}

/** @param {string} content @param {string} query @returns {{ index: number, length: number }} */
function firstHit(content, query) {
  const lower = content.toLowerCase();
  const phrase = String(query || "")
    .trim()
    .toLowerCase();
  if (phrase.length >= 2) {
    const at = lower.indexOf(phrase);
    if (at >= 0) return { index: at, length: phrase.length };
  }
  let index = -1;
  let length = 0;
  for (const term of queryTerms(query)) {
    const at = lower.indexOf(term);
    if (at >= 0 && (index < 0 || at < index)) {
      index = at;
      length = term.length;
    }
  }
  return { index, length };
}

const HEADING = /^#{1,6}\s+\S/;
const BREAK = /^(-{3,}|\*{3,})$/;
const BULLET = /^[-*]\s/;
const YAML_KEY = /^[a-z][a-z0-9_.-]*\s*:/;

/** @param {string} trimmed @returns {boolean} */
function metaLike(trimmed) {
  return META_LINE.test(trimmed) || YAML_KEY.test(trimmed);
}

/** @param {string} line @returns {boolean} */
function isStructural(line) {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    HEADING.test(trimmed) ||
    BREAK.test(trimmed) ||
    BULLET.test(trimmed) ||
    YAML_KEY.test(trimmed)
  );
}

/** @param {string} body @returns {string} */
function conservativeProse(body) {
  const lines = body.split("\n");
  let cursor = 0;
  while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
  if (cursor < lines.length && HEADING.test(lines[cursor].trim())) {
    cursor += 1;
    while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
  }
  while (cursor < lines.length && metaLike(lines[cursor].trim())) cursor += 1;
  while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
  return lines.slice(cursor).join("\n").trim();
}

/** @param {string} body @returns {string} */
function proseOf(body) {
  const lines = body.split("\n");
  let cursor = 0;
  while (cursor < lines.length && isStructural(lines[cursor])) cursor += 1;
  const aggressive = lines.slice(cursor).join("\n").trim();
  return aggressive || conservativeProse(body);
}

/** @param {string} content @param {string} title @param {number} cap @returns {string} */
function previewSkippingTitle(content, title, cap) {
  const titleLc = String(title || "")
    .trim()
    .toLowerCase();
  const kept = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || META_LINE.test(line)) continue;
    const bare = line.replace(/^#+\s*/, "");
    if (kept.length === 0 && bare.toLowerCase() === titleLc) continue;
    kept.push(bare);
    if (kept.join(" ").length >= cap) break;
  }
  return kept.join(" ").slice(0, cap).trim();
}

/** @param {string} body @param {string} query @param {string} title @param {number} cap @returns {string} */
export function buildSnippet(body, query, title, cap) {
  const source = proseOf(body || "");
  const { index, length } = firstHit(source, query);
  if (index >= 0) {
    const start = Math.max(0, index - 48);
    const end = Math.min(source.length, start + cap + length);
    const window = collapse(source.slice(start, end));
    return `${start > 0 ? "…" : ""}${window}${end < source.length ? "…" : ""}`;
  }
  return previewSkippingTitle(source, title, cap);
}
