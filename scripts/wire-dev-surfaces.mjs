#!/usr/bin/env node
// Regenerates the CLIENT SHADOWS of this repo's OWN dev rules and skills.
//
// Canonical text lives once, in .agents/rules/<name>.md and .agents/skills/<name>.md.
// Claude Code and Cursor each need it on their own surface, so every canonical file
// gets pointer shadows:
//
//   .agents/rules/<n>.md    -> .claude/rules/<n>.md          + .cursor/rules/<n>.mdc
//   .agents/skills/<n>.md   -> .claude/skills/<n>/SKILL.md   + .cursor/rules/<n>.mdc
//
// This is NOT wire-memory-surfaces.mjs, which renders the memory DISCIPLINE from
// templates/ into a CONSUMER's workspace. That one never writes here (bootstrap derives
// its workspace as an ancestor of this clone), and its artifacts are all
// `llm-wiki-memory-`-prefixed, which canonicalNames excludes so the two can never fight.
//
// It exists because the surfaces drifted silently: Cursor was missing five of eight
// shadows (including self-observability and every skill) and still carried a pointer
// to a rule that had been renamed. A missing shadow is invisible — the rule simply
// does not apply in that client, and nothing says so. test/dev-surface-mirror.test.mjs
// is the gate; this script is the repair.
//
// It WRITES and DELETES files, so recognition of "is this ours?" is by shape, in
// scripts/lib/dev-surface-pointers.mjs. See that module for why a substring test was
// not safe enough.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RULES_DIR,
  SKILLS_DIR,
  claudeRuleShadow,
  claudeSkillShadow,
  cursorShadow,
  deriveDescription,
  isPointerBody,
  readDescription,
} from "./lib/dev-surface-pointers.mjs";

const DEFAULT_SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export { RULES_DIR, SKILLS_DIR };
export const CLAUDE_RULES_DIR = ".claude/rules";
export const CLAUDE_SKILLS_DIR = ".claude/skills";
export const CURSOR_RULES_DIR = ".cursor/rules";

/** @param {string} [srcDir] @returns {string} */
const root = (srcDir) => srcDir || DEFAULT_SRC_DIR;

/** @param {string} file @returns {string} */
function readOrEmpty(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// Canonical basenames, excluding the sibling generator's prefixed artifacts and anything
// whose name would not round-trip through a pointer reference.
/**
 * @param {string} dir @param {string} srcDir
 * @returns {string[]}
 */
function canonicalNames(dir, srcDir) {
  const abs = path.join(srcDir, dir);
  if (!fs.existsSync(abs)) return [];
  /** @type {string[]} */
  const names = [];
  for (const entry of fs.readdirSync(abs).sort()) {
    if (!entry.endsWith(".md") || entry.startsWith("llm-wiki-memory-")) continue;
    if (!fs.statSync(path.join(abs, entry)).isFile()) continue;
    const name = path.basename(entry, ".md");
    if (!/^[\w.-]+$/.test(name)) {
      throw new Error(
        `dev surfaces: canonical name "${entry}" in ${dir} must match /^[\\w.-]+$/ — a pointer reference cannot encode it`,
      );
    }
    names.push(name);
  }
  return names;
}

/**
 * The shadow files this repo's canonical rules and skills require.
 * @param {string} [srcDir]
 * @returns {{ rules: string[], skills: string[], expected: Map<string, "rules"|"skills"> }}
 */
export function surfaceInventory(srcDir) {
  const dir = root(srcDir);
  const rules = canonicalNames(RULES_DIR, dir);
  const skills = canonicalNames(SKILLS_DIR, dir);
  // One Cursor file per NAME, so a name in both trees would silently overwrite the other's
  // shadow and then wedge the gate with no message naming the cause.
  const collisions = rules.filter((n) => skills.includes(n));
  if (collisions.length) {
    throw new Error(
      `dev surfaces: ${collisions.join(", ")} exists as BOTH a rule and a skill; they would share one .cursor/rules/<name>.mdc — rename one`,
    );
  }
  /** @type {Map<string, "rules"|"skills">} */
  const expected = new Map();
  for (const n of rules) {
    expected.set(path.join(CLAUDE_RULES_DIR, `${n}.md`), "rules");
    expected.set(path.join(CURSOR_RULES_DIR, `${n}.mdc`), "rules");
  }
  for (const n of skills) {
    expected.set(path.join(CLAUDE_SKILLS_DIR, n, "SKILL.md"), "skills");
    expected.set(path.join(CURSOR_RULES_DIR, `${n}.mdc`), "skills");
  }
  return { rules, skills, expected };
}

// The complete set of shadow files and their exact bytes. Returned rather than written so
// the gate can assert on-disk === expected WITHOUT mutating the repo — which also proves
// idempotency: if every file already matches, a run writes nothing.
/**
 * @param {string} [srcDir]
 * @returns {Map<string, string>}
 */
export function expectedShadows(srcDir) {
  const dir = root(srcDir);
  const { rules, skills } = surfaceInventory(dir);
  /** @type {Map<string, string>} */
  const out = new Map();
  // Keys are platform-stable identifiers, not filesystem paths: callers compare them
  // against "/"-style prefixes. path.join would emit "\\" on Windows and make every
  // such comparison false. Node still resolves a "/" key correctly when joining.
  const key = (/** @type {string[]} */ ...parts) => parts.join("/");

  for (const name of rules) {
    const canonical = `${RULES_DIR}/${name}.md`;
    const body = readOrEmpty(path.join(dir, canonical));
    const cursorRel = key(CURSOR_RULES_DIR, `${name}.mdc`);
    const description =
      readDescription(readOrEmpty(path.join(dir, cursorRel))) || deriveDescription(body, canonical);
    out.set(key(CLAUDE_RULES_DIR, `${name}.md`), claudeRuleShadow(name));
    out.set(cursorRel, cursorShadow(name, description, "rules"));
  }

  for (const name of skills) {
    const canonical = `${SKILLS_DIR}/${name}.md`;
    const body = readOrEmpty(path.join(dir, canonical));
    const claudeRel = key(CLAUDE_SKILLS_DIR, name, "SKILL.md");
    const cursorRel = key(CURSOR_RULES_DIR, `${name}.mdc`);
    const description =
      readDescription(readOrEmpty(path.join(dir, claudeRel))) ||
      readDescription(readOrEmpty(path.join(dir, cursorRel))) ||
      deriveDescription(body, canonical);
    out.set(claudeRel, claudeSkillShadow(name, description));
    out.set(cursorRel, cursorShadow(name, description, "skills"));
  }
  return out;
}

// A shadow whose canonical file is gone. Only files that ARE pointers by shape are
// removed — a hand-authored client rule, even one discussing the pointer convention,
// must survive untouched.
/**
 * @param {Map<string, "rules"|"skills">} expected @param {string} [srcDir]
 * @returns {string[]}
 */
export function findOrphans(expected, srcDir) {
  const dir = root(srcDir);
  /** @type {string[]} */
  const orphans = [];
  /** @type {Array<[string, (f: string) => boolean]>} */
  const scan = [
    [CLAUDE_RULES_DIR, (f) => f.endsWith(".md")],
    [CURSOR_RULES_DIR, (f) => f.endsWith(".mdc")],
  ];
  for (const [surface, keep] of scan) {
    const abs = path.join(dir, surface);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter(keep)) {
      const rel = path.join(surface, f);
      if (expected.has(rel)) continue;
      if (isPointerBody(readOrEmpty(path.join(dir, rel)))) orphans.push(rel);
    }
  }
  const skillsAbs = path.join(dir, CLAUDE_SKILLS_DIR);
  if (fs.existsSync(skillsAbs)) {
    for (const d of fs.readdirSync(skillsAbs)) {
      const rel = path.join(CLAUDE_SKILLS_DIR, d, "SKILL.md");
      if (expected.has(rel) || !fs.existsSync(path.join(dir, rel))) continue;
      if (isPointerBody(readOrEmpty(path.join(dir, rel)))) orphans.push(rel);
    }
  }
  return orphans.sort();
}

/**
 * @param {{ prune?: boolean, srcDir?: string }} [opts]
 * @returns {{ written: string[], pruned: string[], refused: string[] }}
 */
export function wireDevSurfaces({ prune = true, srcDir } = {}) {
  const dir = root(srcDir);
  const { expected } = surfaceInventory(dir);
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const refused = [];
  /** @type {Set<string>} */
  const touched = new Set();

  for (const [rel, content] of expectedShadows(dir)) {
    const file = path.join(dir, rel);
    const current = fs.existsSync(file) ? readOrEmpty(file) : "";
    // Refuse anything that is not already a pointer by shape. A generator may create and
    // update what it owns; it must never clobber what it does not recognise. This is not
    // hypothetical — a skill kept its whole procedure at a shadow path and an earlier
    // substring check overwrote it with a two-line pointer.
    if (current && !isPointerBody(current)) {
      refused.push(rel);
      continue;
    }
    touched.add(path.resolve(file).toLowerCase());
    if (current === content) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    written.push(rel);
  }

  /** @type {string[]} */
  const pruned = [];
  if (prune) {
    for (const rel of findOrphans(expected, dir)) {
      const abs = path.join(dir, rel);
      // Never prune a path this run just wrote. On a case-insensitive filesystem a rename
      // that changes only case leaves readdir reporting the OLD spelling, so the orphan
      // scan selected the file the write had just produced and one "successful" run left
      // the surface empty.
      if (touched.has(path.resolve(abs).toLowerCase())) continue;
      fs.rmSync(abs, { force: true });
      const parent = path.dirname(abs);
      const skillsRoot = path.join(dir, CLAUDE_SKILLS_DIR);
      if (path.dirname(parent) === skillsRoot && fs.existsSync(parent)) {
        if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      }
      pruned.push(rel);
    }
  }
  return { written, pruned, refused };
}

if (import.meta.main) {
  const { written, pruned, refused } = wireDevSurfaces();
  for (const f of written) process.stdout.write(`wrote   ${f}\n`);
  for (const f of pruned) process.stdout.write(`pruned  ${f}\n`);
  for (const f of refused) {
    process.stderr.write(
      `REFUSED ${f} — holds content this script did not write. Move it into the canonical .agents/ file (or delete the file if it is a truncated stub), then re-run.\n`,
    );
  }
  if (!written.length && !pruned.length && !refused.length) {
    process.stdout.write("dev surfaces already in sync\n");
  }
  if (refused.length) process.exitCode = 1;
}
