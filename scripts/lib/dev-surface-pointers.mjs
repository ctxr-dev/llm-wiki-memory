// The pure shape of a dev-rule client SHADOW: how one is written, how one is recognised,
// and where its description comes from. No filesystem access — scripts/wire-dev-surfaces.mjs
// owns that, which is what makes every rule here unit-testable against literal strings.
//
// Recognition is the load-bearing part. The generator DELETES orphan shadows and OVERWRITES
// stale ones, so "is this file ours?" decides whether authored content survives. A substring
// test for the pointer marker was not good enough: it overwrote a file that carried a pointer
// AND 30 lines of authored procedure, and it deleted an authored rule whose prose merely
// mentioned a relative `@`-import. Recognition is therefore by SHAPE — a shadow is
// frontmatter (optional), a stub note or follow-the-canonical line (optional), exactly one
// canonical pointer, and nothing else.

export const RULES_DIR = ".agents/rules";
export const SKILLS_DIR = ".agents/skills";

const FOLLOW_RULE = "Follow the canonical rule (edit that file, never this shadow):";
const FOLLOW_SKILL = "Follow the canonical procedure (edit that file, never this shadow):";
const POINTER_LINE = /^@(?:\.\.\/)*\.agents\/(?:rules|skills)\/[\w.-]+\.md$/;
const STUB_NOTE = /^<!-- Shadow stub: .* -->$/;

/** @param {string} body @returns {string} */
const normalize = (body) => String(body || "").replace(/\r\n/g, "\n");

// A YAML plain scalar cannot contain ": " — and every skill H1 here starts "Skill: …", so a
// derived description silently produced unparseable frontmatter and the client loaded NOTHING.
// JSON quoting is valid YAML for any single-line string.
/** @param {string} value @returns {string} */
export function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

/** @param {string} body @returns {string} the body with any frontmatter block removed */
function stripFrontmatter(body) {
  return normalize(body).replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/** @param {string} body @returns {string} the frontmatter block's inner text, or "" */
export function frontmatterOf(body) {
  const m = /^---\n([\s\S]*?)\n---/.exec(normalize(body));
  return m ? m[1] : "";
}

// Whether a file is a shadow THIS generator produced (or an earlier hand-written equivalent).
// Anything with content beyond the recognised parts is foreign and must never be touched.
/** @param {string} body @returns {boolean} */
export function isPointerBody(body) {
  const lines = stripFrontmatter(body)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  let pointers = 0;
  for (const line of lines) {
    if (POINTER_LINE.test(line)) {
      pointers += 1;
      continue;
    }
    if (STUB_NOTE.test(line) || line === FOLLOW_RULE || line === FOLLOW_SKILL) continue;
    return false;
  }
  return pointers === 1;
}

/** @param {string} body @returns {string} the canonical path a shadow points at, or "" */
export function pointerTarget(body) {
  for (const line of stripFrontmatter(body).split("\n")) {
    const trimmed = line.trim();
    if (POINTER_LINE.test(trimmed)) return trimmed.slice(1);
  }
  return "";
}

// A description a human wrote beats a derived one, so it is carried forward — but only when
// it is unambiguously a real single-line value. An empty value, a `>` / `|` block indicator,
// or a missing key all read as ABSENT, because the earlier regex captured the NEXT key on an
// empty value and re-emitted `description: alwaysApply: true`, which then stuck forever.
/** @param {string} body @returns {string} */
export function readDescription(body) {
  for (const line of frontmatterOf(body).split("\n")) {
    const m = /^description:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    if (!raw || raw === ">" || raw === "|" || raw === ">-" || raw === "|-") return "";
    try {
      return typeof JSON.parse(raw) === "string" ? JSON.parse(raw) : raw;
    } catch {
      return raw;
    }
  }
  return "";
}

// A one-line description derived from the canonical file's H1 plus its opening sentence.
// List items and blockquotes are skipped: the first line of a bullet-led file produced
// descriptions like "Skill: run the test suite safely — 1." which is useless as the
// discovery trigger a Cursor rule or a Claude skill is selected by.
/**
 * @param {string} body @param {string} canonical
 * @returns {string}
 */
export function deriveDescription(body, canonical) {
  const lines = normalize(body).split("\n");
  const h1Index = lines.findIndex((l) => l.startsWith("# "));
  const h1 = h1Index >= 0 ? lines[h1Index].replace(/^#\s*/, "").trim() : "";
  // The whole intro PARAGRAPH, not its first line: these files are hard-wrapped, so taking
  // one line truncated the description mid-sentence ("…the most expensive class of Canonical
  // file is…"), and the description is the discovery trigger a Cursor rule or a Claude skill
  // is selected by.
  const after = lines.slice(h1Index + 1);
  const start = after.findIndex(
    (l) => l.trim() && !/^[#>|]|^[-*+]\s|^\d+[.)]\s|^<!--/.test(l.trim()),
  );
  /** @type {string[]} */
  const para = [];
  if (start >= 0) {
    for (const line of after.slice(start)) {
      if (!line.trim()) break;
      para.push(line.trim());
    }
  }
  const sentence = firstSentence(para.join(" ").replace(/\s+/g, " "));
  const head = [h1, sentence].filter(Boolean).join(" — ");
  return `${head} Canonical file is ${canonical}.`.replace(/\s+/g, " ").trim();
}

// Cut at a sentence end, else at a word boundary — never mid-word, which produced
// descriptions reading "…the most expensive class of Canonical file is…".
/** @param {string} text @returns {string} */
function firstSentence(text) {
  const LIMIT = 200;
  const stop = text.search(/[.!?](\s|$)/);
  if (stop >= 0 && stop < LIMIT) return text.slice(0, stop + 1);
  if (text.length <= LIMIT) return text;
  const cut = text.slice(0, LIMIT);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

/** @param {string} name @returns {string} */
export function claudeRuleShadow(name) {
  const canonical = `${RULES_DIR}/${name}.md`;
  return `<!-- Shadow stub: the canonical rule lives in ${canonical} — edit THAT file, never this one. -->\n\n@../../${canonical}\n`;
}

/** @param {string} name @param {string} description @returns {string} */
export function claudeSkillShadow(name, description) {
  return `---\nname: ${name}\ndescription: ${yamlString(description)}\n---\n\n${FOLLOW_SKILL}\n\n@../../../${SKILLS_DIR}/${name}.md\n`;
}

/**
 * @param {string} name @param {string} description @param {"rules"|"skills"} kind
 * @returns {string}
 */
export function cursorShadow(name, description, kind) {
  const dir = kind === "rules" ? RULES_DIR : SKILLS_DIR;
  const follow = kind === "rules" ? FOLLOW_RULE : FOLLOW_SKILL;
  // Rules are standing policy so Cursor loads them every turn; a skill is invoked on
  // demand, and alwaysApply would spend context on it every turn instead.
  const applies = kind === "rules" ? "true" : "false";
  return `---\ndescription: ${yamlString(description)}\nalwaysApply: ${applies}\n---\n\n${follow}\n\n@${dir}/${name}.md\n`;
}
