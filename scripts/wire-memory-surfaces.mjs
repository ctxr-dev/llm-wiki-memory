import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const POINTER_PREFIX = "llm-wiki-memory-";
const BEGIN = "<!-- BEGIN llm-wiki-memory -->";
const END = "<!-- END llm-wiki-memory -->";
const INSTRUCTIONS_REL = "templates/agents-memory-instructions.md";
const SELF_OBS = "self-observability.md";

const SHIPPED_GROUPS = [
  { sub: "templates/skills", surfaces: [".agents/rules", ".claude/skills", ".cursor/rules"] },
  { sub: "templates/rules", surfaces: [".agents/rules", ".claude/rules", ".cursor/rules"] },
];
const SELF_OBS_SURFACES = [".agents/rules", ".claude/rules", ".cursor/rules"];
const ALL_SURFACES = [".agents/rules", ".claude/skills", ".claude/rules", ".cursor/rules"];

/** @param {string} home @param {string} abs @returns {string} */
function homeRef(home, abs) {
  return `~/${path.relative(home, abs).split(path.sep).join("/")}`;
}

/** @param {string} name @returns {string} */
function pointerName(name) {
  return `${POINTER_PREFIX}${name}`;
}

/** @param {string} ref @returns {string} */
function pointerBody(ref) {
  return `@${ref}\n\nIf your client does not resolve the @-include above, read the canonical file at:\n${ref}\n`;
}

/** @param {string} s @returns {string} */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} srcDir @param {string} sub @returns {string[]} */
function mdFiles(srcDir, sub) {
  const dir = path.join(srcDir, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
}

/** @param {string} p @param {string} content */
function writeIfChanged(p, content) {
  try {
    if (fs.readFileSync(p, "utf8") === content) return;
  } catch {
    /* absent → write */
  }
  fs.writeFileSync(p, content);
}

/**
 * @param {string} srcDir @param {string} home @param {boolean} selfObsEnabled
 * @returns {Map<string, Map<string, string>>} surface → (pointerFileName → home-relative ref)
 */
function desiredPointers(srcDir, home, selfObsEnabled) {
  /** @type {Map<string, Map<string, string>>} */
  const bySurface = new Map();
  /** @param {string} surface @param {string} name @param {string} abs */
  const add = (surface, name, abs) => {
    if (!bySurface.has(surface)) bySurface.set(surface, new Map());
    /** @type {Map<string, string>} */ (bySurface.get(surface)).set(
      pointerName(name),
      homeRef(home, abs),
    );
  };
  for (const g of SHIPPED_GROUPS) {
    for (const name of mdFiles(srcDir, g.sub)) {
      for (const s of g.surfaces) add(s, name, path.join(srcDir, g.sub, name));
    }
  }
  if (selfObsEnabled) {
    const abs = path.join(srcDir, ".agents/rules", SELF_OBS);
    if (fs.existsSync(abs)) for (const s of SELF_OBS_SURFACES) add(s, SELF_OBS, abs);
  }
  return bySurface;
}

/** @param {string} srcDir @returns {Set<string>} every canonical basename we manage (for migration) */
function managedNames(srcDir) {
  const set = new Set([SELF_OBS]);
  for (const g of SHIPPED_GROUPS) for (const n of mdFiles(srcDir, g.sub)) set.add(n);
  return set;
}

/** @param {string} file @param {string} ref */
function wireInclude(file, ref) {
  const inner = `## Project memory (llm-wiki-memory)\n\n@${ref}\n\nIf your client does not resolve the @-include above, read:\n${ref}`;
  const block = `${BEGIN}\n${inner}\n${END}`;
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = "";
  }
  const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`);
  const next = re.test(existing)
    ? existing.replace(re, block)
    : existing
      ? `${existing.replace(/\s*$/, "")}\n\n${block}\n`
      : `${block}\n`;
  writeIfChanged(file, next);
}

/**
 * Reference-only wiring for the llm-wiki-memory surfaces: each shipped rule/skill
 * becomes a prefixed `@`-pointer FILE (never a copy or OS symlink) targeting the
 * single home install `~/.llm-wiki-memory/src/...`; AGENTS.md/CLAUDE.md gain one
 * marker-fenced `@`-include of the extracted instructions. Old unprefixed copies
 * and stale prefixed pointers (e.g. self-observability when disabled) are removed;
 * a re-run is byte-stable. The consuming project's OWN rule files are left alone.
 * @param {{ srcDir: string, workspaceDir: string, home: string, selfObsEnabled?: boolean }} opts
 * @returns {{ surfaces: number }}
 */
export function wireMemorySurfaces({ srcDir, workspaceDir, home, selfObsEnabled = false }) {
  const desired = desiredPointers(srcDir, home, selfObsEnabled);
  const managed = managedNames(srcDir);
  const managedPointers = new Set([...managed].map(pointerName));
  for (const surface of ALL_SURFACES) {
    const dir = path.join(workspaceDir, surface);
    fs.mkdirSync(dir, { recursive: true });
    const want = desired.get(surface) || new Map();
    for (const entry of fs.readdirSync(dir)) {
      const staleCopy = managed.has(entry);
      const stalePointer = managedPointers.has(entry) && !want.has(entry);
      if (staleCopy || stalePointer) fs.rmSync(path.join(dir, entry), { force: true });
    }
    for (const [fname, ref] of want) writeIfChanged(path.join(dir, fname), pointerBody(ref));
  }
  const instructionsRef = homeRef(home, path.join(srcDir, INSTRUCTIONS_REL));
  wireInclude(path.join(workspaceDir, "AGENTS.md"), instructionsRef);
  wireInclude(path.join(workspaceDir, "CLAUDE.md"), instructionsRef);
  return { surfaces: ALL_SURFACES.length };
}

const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  const [srcDir, workspaceDir, home, selfObs] = process.argv.slice(2);
  if (!srcDir || !workspaceDir || !home) {
    console.error("usage: wire-memory-surfaces.mjs <srcDir> <workspaceDir> <home> [selfObs:0|1]");
    process.exit(1);
  }
  const res = wireMemorySurfaces({
    srcDir,
    workspaceDir,
    home,
    selfObsEnabled: selfObs === "1" || selfObs === "true",
  });
  process.stdout.write(`${JSON.stringify(res)}\n`);
}
