import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  POINTER_PREFIX,
  DOC_MARKER_START,
  DOC_MARKER_END,
  RULE_SURFACES,
  MEMORY_DOCS,
  MARKER_ID,
  POINTER_FALLBACK_NOTE,
  REMOTE_INSTRUCTIONS_URL,
} from "./lib/memory-surface-constants.mjs";
import { sha256, writeManifest } from "./lib/install-manifest.mjs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { withFsRetry } from "./lib/fs-retry.mjs";
import { stripManagedBlocks } from "./lib/marker-block.mjs";
import { isOurPointer } from "./lib/pointer-file.mjs";
import { isSharedWiki } from "./bootstrap/shared-wiki.mjs";

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

/** @param {string} p @param {string} content */
function writeIfChanged(p, content) {
  let current = null;
  try {
    current = fs.readFileSync(p, "utf8");
  } catch {
    current = null;
  }
  if (current === content) return;
  writeFileAtomic(p, content);
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

/** @param {string} file @param {string} inner the block body (marker fence added here) */
function writeDocBlock(file, inner) {
  const block = `${DOC_MARKER_START}\n${inner}\n${DOC_MARKER_END}`;
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = "";
  }
  const withoutBlocks = stripManagedBlocks(existing, DOC_MARKER_START, DOC_MARKER_END)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/[ \t\n]+$/, "");
  const next = withoutBlocks ? `${withoutBlocks}\n\n${block}\n` : `${block}\n`;
  writeIfChanged(file, next);
}

/** @param {string} file @param {string} ref local include (private brain) */
function wireInclude(file, ref) {
  writeDocBlock(
    file,
    `## Project memory (llm-wiki-memory)\n\n@${ref}\n\nIf your client does not resolve the @-include above, read:\n${ref}`,
  );
}

/** @param {string} file machine-INDEPENDENT remote-read block (shared repo) */
function wireRemoteInclude(file) {
  writeDocBlock(
    file,
    `## Project memory (llm-wiki-memory)\n\nThis repository uses llm-wiki-memory shared team memory. If you have the engine installed, its MCP tools are available globally. For the memory discipline, read:\n${REMOTE_INSTRUCTIONS_URL}`,
  );
}

/**
 * A SHARED (team) mount carries ZERO machine-dependent files: strip any `~/...`
 * pointers a prior private-style install left, and write only the one
 * machine-independent remote-read block into AGENTS.md/CLAUDE.md.
 * @param {string} workspaceDir @returns {{ surfaces: number, artifacts: number }}
 */
function wireSharedRepo(workspaceDir) {
  for (const surface of RULE_SURFACES) {
    const dir = path.join(workspaceDir, surface);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (entry.startsWith(POINTER_PREFIX) && entry.endsWith(".md") && isOurPointer(abs)) {
        withFsRetry(() => fs.rmSync(abs, { force: true }));
      }
    }
  }
  /** @type {import("./lib/install-manifest.mjs").InstallArtifact[]} */
  const artifacts = [];
  for (const doc of MEMORY_DOCS) {
    wireRemoteInclude(path.join(workspaceDir, doc));
    artifacts.push({ kind: "block", path: doc, marker: MARKER_ID });
  }
  writeManifest(workspaceDir, artifacts);
  return { surfaces: 0, artifacts: artifacts.length };
}

/**
 * @param {{ srcDir: string, workspaceDir: string, home: string, selfObsEnabled?: boolean }} opts
 * @returns {{ surfaces: number, artifacts: number }}
 */
export function wireMemorySurfaces({ srcDir, workspaceDir, home, selfObsEnabled = false }) {
  // A SHARED (team) mount must carry no machine-dependent `~/...` pointers — only
  // a remote-read block. The private brain keeps its local @-pointer wiring.
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
      const stalePointer =
        entry.startsWith(POINTER_PREFIX) &&
        entry.endsWith(".md") &&
        !want.has(entry) &&
        isOurPointer(abs);
      if (staleCopy || stalePointer) withFsRetry(() => fs.rmSync(abs, { force: true }));
    }
    for (const [fname, ref] of want) {
      const body = pointerBody(ref);
      writeIfChanged(path.join(dir, fname), body);
      artifacts.push({ kind: "file", path: `${surface}/${fname}`, sha256: sha256(body) });
    }
  }
  const instructionsRef = homeRef(home, path.join(srcDir, INSTRUCTIONS_REL));
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
