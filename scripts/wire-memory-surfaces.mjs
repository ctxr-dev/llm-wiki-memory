import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  POINTER_PREFIX,
  RULE_SURFACES,
  MEMORY_DOCS,
  MARKER_ID,
  POINTER_FALLBACK_NOTE,
} from "./lib/memory-surface-constants.mjs";
import { sha256, writeManifest } from "./lib/install-manifest.mjs";
import { withFsRetry } from "./lib/fs-retry.mjs";
import { isOurPointer } from "./lib/pointer-file.mjs";
import { wireInclude, stripDocBlock, writeIfChanged } from "./lib/memory-doc-block.mjs";
import { SKILL_ENTRY, SKILL_SURFACES, skillBody, isOurSkillDir } from "./lib/skill-pointer.mjs";
import { isSharedWiki } from "./bootstrap/shared-wiki.mjs";
import { helpGuard, refuseFlagAsPath, formatHelp, docsUrl } from "./lib/cli-args.mjs";

const INSTRUCTIONS_REL = "templates/agents-memory-instructions.md";
const SELF_OBS = "self-observability.md";

const SHIPPED_GROUPS = [
  { sub: "templates/skills", surfaces: [".agents/rules", ".claude/skills", ".cursor/rules"] },
  { sub: "templates/rules", surfaces: [".agents/rules", ".claude/rules", ".cursor/rules"] },
];
const SELF_OBS_SURFACES = [".agents/rules", ".claude/rules", ".cursor/rules"];

/** @param {string} home @param {string} abs @returns {string} */
function homeRef(home, abs) {
  return `~/${path.relative(home, abs).split(path.sep).join("/")}`;
}

/** @param {string} name @returns {string} */
function pointerName(name) {
  return `${POINTER_PREFIX}${name}`;
}

/** @param {string} ref @returns {string} */
export function pointerBody(ref) {
  return `@${ref}\n\n${POINTER_FALLBACK_NOTE}\n${ref}\n`;
}

/** @param {string} srcDir @param {string} sub @returns {string[]} */
function mdFiles(srcDir, sub) {
  const dir = path.join(srcDir, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
}

/** @param {string} srcDir @returns {Map<string, string>} managed basename → canonical abs path */
function managedCanonical(srcDir) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const g of SHIPPED_GROUPS) {
    for (const n of mdFiles(srcDir, g.sub)) {
      if (map.has(n)) {
        console.error(
          `wire-memory-surfaces: shipped basename collision '${n}' across groups (last wins)`,
        );
      }
      map.set(n, path.join(srcDir, g.sub, n));
    }
  }
  const selfObs = path.join(srcDir, ".agents/rules", SELF_OBS);
  if (fs.existsSync(selfObs)) map.set(SELF_OBS, selfObs);
  return map;
}

/**
 * A surface file is OUR old (pre-@-pointer) artifact only when it is a symlink (the
 * old .claude/.cursor wiring) or byte-identical to the shipped canonical (the old
 * hard-copy render). A consumer's own same-named file — different content, not a
 * symlink — is never ours and must survive the migration.
 * @param {string} surfacePath @param {string} canonicalAbs @returns {boolean}
 */
function isOurOldCopy(surfacePath, canonicalAbs) {
  try {
    if (fs.lstatSync(surfacePath).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  try {
    return fs.readFileSync(surfacePath, "utf8") === fs.readFileSync(canonicalAbs, "utf8");
  } catch {
    return false;
  }
}

/**
 * @param {string} srcDir @param {string} home @param {boolean} selfObsEnabled
 * @returns {Map<string, Map<string, string>>} surface → (surface-relative path → file body)
 */
function desiredPointers(srcDir, home, selfObsEnabled) {
  /** @type {Map<string, Map<string, string>>} */
  const bySurface = new Map();
  /** @param {string} surface @param {string} name @param {string} abs */
  const add = (surface, name, abs) => {
    if (!bySurface.has(surface)) bySurface.set(surface, new Map());
    const ref = homeRef(home, abs);
    const dir = pointerName(name).replace(/\.md$/i, "");
    const [rel, body] = SKILL_SURFACES.has(surface)
      ? [`${dir}/${SKILL_ENTRY}`, skillBody(name, pointerBody(ref), abs)]
      : [pointerName(name), pointerBody(ref)];
    /** @type {Map<string, string>} */ (bySurface.get(surface)).set(rel, body);
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

/**
 * A SHARED (team) mount is STRIP-ONLY: it receives NOTHING outside its own
 * `.llm-wiki-memory/` directory, and anything a prior install wrote there is
 * removed.
 *
 * Why nothing at all. A shared mount is a repo that HOSTS team wiki data; the
 * engine itself is installed once per machine, and that one install already
 * supplies every rule, skill and the discipline to every directory on the box
 * (agent clients read the user-level `~/.claude/...` surfaces and walk up through
 * ancestor AGENTS.md/CLAUDE.md files). So a per-repo copy is duplication for a
 * teammate who HAS the engine, and instructions for MCP tools that do not exist
 * for a teammate who does not. Nothing in the engine ever reads these files back
 * — the only consumer is an agent's context window — so writing them buys
 * nothing and costs a committed artifact in someone else's repository.
 *
 * The strip half remains because an existing mount may still carry artifacts an
 * older engine wrote: they are cleaned on the next run. A doc that held ONLY our
 * block is deleted; a doc the team also wrote in keeps their content.
 * @param {string} workspaceDir
 * @returns {{ surfaces: number, artifacts: number, removed: string[] }}
 */
export function wireSharedRepo(workspaceDir) {
  /** @type {string[]} */
  const removed = [];
  for (const surface of RULE_SURFACES) {
    const dir = path.join(workspaceDir, surface);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (!entry.startsWith(POINTER_PREFIX)) continue;
      // Flat pointer FILE, or a Claude Code skill DIRECTORY: both carry a
      // machine-dependent `~/...` include, so both must go when a private install
      // converts to shared.
      if (entry.endsWith(".md") && isOurPointer(abs)) {
        withFsRetry(() => fs.rmSync(abs, { force: true }));
        removed.push(`${surface}/${entry}`);
      } else if (isOurSkillDir(abs)) {
        withFsRetry(() => fs.rmSync(abs, { recursive: true, force: true }));
        removed.push(`${surface}/${entry}`);
      }
    }
  }
  for (const doc of MEMORY_DOCS) {
    if (stripDocBlock(path.join(workspaceDir, doc))) removed.push(doc);
  }
  // An empty artifact list, recorded deliberately: a later uninstall then knows
  // this workspace has nothing of ours outside the mount.
  writeManifest(workspaceDir, []);
  return { surfaces: 0, artifacts: 0, removed };
}

/**
 * @param {{ srcDir: string, workspaceDir: string, home: string, selfObsEnabled?: boolean }} opts
 * @returns {{ surfaces: number, artifacts: number }}
 */
export function wireMemorySurfaces({ srcDir, workspaceDir, home, selfObsEnabled = false }) {
  const instructionsRef = homeRef(home, path.join(srcDir, INSTRUCTIONS_REL));
  // A SHARED (team) mount receives NOTHING outside its own .llm-wiki-memory/ dir
  // (see wireSharedRepo). Only a PRIVATE brain — the one install that actually
  // supplies the discipline to this machine — gets the pointer + @-include wiring.
  if (isSharedWiki(path.join(workspaceDir, ".llm-wiki-memory", "wiki"))) {
    return wireSharedRepo(workspaceDir);
  }
  const desired = desiredPointers(srcDir, home, selfObsEnabled);
  const canonical = managedCanonical(srcDir);
  /** @type {import("./lib/install-manifest.mjs").InstallArtifact[]} */
  const artifacts = [];
  for (const surface of RULE_SURFACES) {
    const dir = path.join(workspaceDir, surface);
    fs.mkdirSync(dir, { recursive: true });
    const want = desired.get(surface) || new Map();
    for (const entry of fs.readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const canon = canonical.get(entry);
      const staleCopy = canon !== undefined && isOurOldCopy(abs, canon);
      // A prefixed pointer we no longer want here is stale — including one left by a
      // renamed/removed shipped rule — but only if it is actually OURS (isOurPointer
      // guards a user's same-named file and a prefixed directory).
      //
      // This is also the MIGRATION path off the old flat `.claude/skills` shape: those
      // files are our pointers and are no longer wanted at that surface (the wanted
      // key there is now `<dir>/SKILL.md`), so they are retired here. Leaving them
      // would strand an unreachable duplicate of every skill.
      const stalePointer =
        entry.startsWith(POINTER_PREFIX) &&
        entry.endsWith(".md") &&
        !want.has(entry) &&
        isOurPointer(abs);
      // A prefixed DIRECTORY we no longer want (a renamed/removed skill) — recognised
      // by the pointer it contains, so a same-named directory of the user's own is
      // never touched.
      const staleSkillDir =
        entry.startsWith(POINTER_PREFIX) &&
        !want.has(`${entry}/${SKILL_ENTRY}`) &&
        isOurSkillDir(abs);
      if (staleCopy || stalePointer) withFsRetry(() => fs.rmSync(abs, { force: true }));
      else if (staleSkillDir) withFsRetry(() => fs.rmSync(abs, { recursive: true, force: true }));
    }
    for (const [rel, body] of want) {
      const target = path.join(dir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeIfChanged(target, body);
      artifacts.push({ kind: "file", path: `${surface}/${rel}`, sha256: sha256(body) });
    }
  }
  for (const doc of MEMORY_DOCS) {
    wireInclude(path.join(workspaceDir, doc), instructionsRef);
    artifacts.push({ kind: "block", path: doc, marker: MARKER_ID });
  }
  writeManifest(workspaceDir, artifacts);
  return { surfaces: RULE_SURFACES.length, artifacts: artifacts.length };
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
  const args = process.argv.slice(2);
  const HELP = formatHelp({
    name: "wire-memory-surfaces",
    summary:
      "wire an install's rule/skill @-pointers + AGENTS/CLAUDE include (private brain) or the remote-read block (shared repo)",
    usage: "node scripts/wire-memory-surfaces.mjs <srcDir> <workspaceDir> <home> [selfObs]",
    docs: docsUrl("AI-INSTALL-PROMPT.md"),
  });
  helpGuard(args, HELP);
  refuseFlagAsPath(args[0], HELP);
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
