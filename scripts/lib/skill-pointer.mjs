import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { POINTER_PREFIX } from "./memory-surface-constants.mjs";
import { isOurPointer } from "./pointer-file.mjs";

// Claude Code discovers a skill ONLY as `<dir>/SKILL.md`, and lists it by the
// `name` + `description` in that file's frontmatter. A flat pointer FILE is
// invisible to it — which is how every memory skill came to be unreachable in
// Claude Code while the rules kept telling agents to follow them by name. The
// flat shape stays correct for `.agents/rules` and `.cursor/rules`, so the
// difference is per-SURFACE, not a global layout change.
export const SKILL_ENTRY = "SKILL.md";
export const SKILL_SURFACES = new Set([".claude/skills"]);

/**
 * The shipped template's own `description`, for the generated skill's frontmatter.
 * Tolerant on purpose: a template whose YAML does not parse still yields a VALID
 * generated file (the value is re-emitted JSON-quoted, which is valid YAML for any
 * single-line string) rather than a description-less, undiscoverable skill. The
 * shipped-template guard is a test, not a bootstrap failure.
 * @param {string} abs @returns {string}
 */
function templateDescription(abs) {
  let raw = "";
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
  try {
    const parsed = matter(raw);
    const d = parsed.data && parsed.data.description;
    if (typeof d === "string" && d.trim()) return d.trim();
  } catch {
    /* fall through to the raw line */
  }
  const line = raw.match(/^description:[ \t]*(.+)$/m);
  return line ? line[1].trim().replace(/^["']|["']$/g, "") : "";
}

/**
 * @param {string} name shipped basename, e.g. "absorb.md"
 * @param {string} body the plain pointer body this skill wraps
 * @param {string} canonicalAbs the shipped template, for its description
 * @returns {string}
 */
export function skillBody(name, body, canonicalAbs) {
  const skillName = `${POINTER_PREFIX}${name.replace(/\.md$/i, "")}`;
  const description = templateDescription(canonicalAbs).replace(/\s*\n\s*/g, " ");
  return `---\nname: ${skillName}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
}

/**
 * After removing a generated `<skill-dir>/SKILL.md`, drop the directory that held
 * it once it is empty. Without this an uninstall leaves a tree of empty prefixed
 * skill directories behind, so `.claude/skills` is never pruned and the round-trip
 * is not clean. Bounded twice over: the parent must carry our pointer prefix, and
 * it must already be empty.
 * @param {string} fileAbs the removed SKILL.md
 * @returns {void}
 */
export function pruneEmptiedSkillDir(fileAbs) {
  const dir = path.dirname(fileAbs);
  if (!path.basename(dir).startsWith(POINTER_PREFIX)) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* best effort: a non-empty or unreadable dir is left alone */
  }
}

/**
 * Remove one prefixed surface entry IF we can prove we authored it — a flat pointer
 * file, or a skill directory whose SKILL.md is one of ours. Returns the
 * surface-relative path removed, or null when the entry is not ours (a user's own
 * file or directory at a prefixed name is never touched).
 * @param {string} abs @param {string} entry @returns {string | null}
 */
export function removeOurSurfaceEntry(abs, entry) {
  if (!entry.startsWith(POINTER_PREFIX)) return null;
  if (entry.endsWith(".md") && isOurPointer(abs)) {
    fs.rmSync(abs, { force: true });
    return entry;
  }
  if (isOurSkillDir(abs)) {
    fs.rmSync(abs, { recursive: true, force: true });
    return `${entry}/${SKILL_ENTRY}`;
  }
  return null;
}

/**
 * Ours iff it is a directory holding a SKILL.md that is one of our pointers. A
 * user's own same-named directory (no SKILL.md, or a SKILL.md that is not ours) is
 * never deleted.
 * @param {string} abs @returns {boolean}
 */
export function isOurSkillDir(abs) {
  try {
    if (!fs.statSync(abs).isDirectory()) return false;
  } catch {
    return false;
  }
  const entry = path.join(abs, SKILL_ENTRY);
  return fs.existsSync(entry) && isOurPointer(entry);
}
