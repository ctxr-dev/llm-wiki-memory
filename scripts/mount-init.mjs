// The no-clone shared-mount setup, run FROM the single global engine:
// `node ~/.llm-wiki-memory/src/scripts/mount-init.mjs <repo>`. The engine is
// NEVER cloned into a consuming repo — this seeds/adopts the shared wiki + git
// surfaces (+ the machine-independent remote-read block) in place, all from the
// one home install. It is the same command for FRESH setup and teammate ADOPT
// (idempotent). bootstrap.sh also invokes it during a full install.
//
// A "mount" is a `.llm-wiki-memory` data dir inside a CONSUMING project whose
// layout declares at least one shared (`ownership: repo`) category. With no such
// category this is NOT a mount (it is the private brain, or a fresh install),
// so we no-op — keeping the baseline install byte-identical.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { buildMountGitignore } from "./lib/mount-gitignore.mjs";
import { mergedLayoutForRoot, sharedCategories } from "./lib/wiki-ownership.mjs";
import { installLayoutTemplate } from "./lib/layout-template.mjs";
import {
  initPersonalGit,
  assertMountNotHostIgnored,
  installSyncEmbeddingsHook,
} from "./lib/mount-git.mjs";
import { wireSharedRepo } from "./wire-memory-surfaces.mjs";

const MOUNT_DIRNAME = ".llm-wiki-memory";
// A repo MOUNT is a shared, repo-owned brain, so it seeds the knowledge-only
// `repo` template (the one shipped template with an `ownership: repo` category).
const MOUNT_TEMPLATE = "repo";

/**
 * Provision a mount's git surfaces: a negated `.gitignore` tracking only shared
 * categories, a private personal git repo, a host-ignore shadow check, and the
 * chained sync-embeddings hook. When the mount has NO layout yet, seed the
 * knowledge-only `repo` template first, so a mount is a repo-owned brain by
 * construction. No-op (returns `skipped`) when the resolved layout declares no
 * shared category (e.g. a private-brain layout was seeded here on purpose).
 * With `wireRemote`, ALSO write the machine-independent remote-read block into
 * the repo's AGENTS.md/CLAUDE.md (and strip any stray home-relative pointer
 * files) — making this the complete no-clone shared setup. Default off so
 * bootstrap's own wire step and programmatic callers keep their exact contract.
 * @param {string} mountDir directory that HOLDS the `.llm-wiki-memory` mount
 * @param {{ template?: string, wireRemote?: boolean }} [opts] seed template + shared-block toggle
 * @returns {Record<string, unknown>}
 */
export function initMount(mountDir, { template = MOUNT_TEMPLATE, wireRemote = false } = {}) {
  const dataDir = path.join(mountDir, MOUNT_DIRNAME);
  const wikiRootDir = path.join(dataDir, "wiki");
  const layoutDir = path.join(wikiRootDir, ".layout");
  let seeded;
  if (!fs.existsSync(path.join(layoutDir, "layout.yaml"))) {
    seeded = installLayoutTemplate(layoutDir, template).template;
  }
  const layout = mergedLayoutForRoot(wikiRootDir);
  if (sharedCategories(layout).length === 0) {
    return { ok: true, skipped: "no-shared-categories", ...(seeded ? { seeded } : {}) };
  }
  /** @type {Record<string, unknown>} */
  const results = seeded ? { seeded } : {};
  fs.mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(path.join(dataDir, ".gitignore"), buildMountGitignore(layout));
  results.gitignore = true;
  results.personalGit = initPersonalGit(mountDir);
  // Host-ignore check is surfaced, not fatal here: the interactive install FLOW
  // (Phase J) decides how to act on it. bootstrap logs the actionable message.
  try {
    assertMountNotHostIgnored(mountDir);
    results.hostIgnore = { ok: true };
  } catch (err) {
    results.hostIgnore = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  results.syncHook = installSyncEmbeddingsHook(mountDir);
  // A shared mount carries the machine-INDEPENDENT remote-read block (no `~/…`
  // pointers) so a teammate who clones discovers the discipline. Idempotent, so
  // a re-run / adopt upserts the same block. Only reached for a real shared
  // mount (the no-shared-category path returned above), so the brain is untouched.
  if (wireRemote) results.remoteInclude = wireSharedRepo(mountDir);
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = initMount(process.argv[2] || process.cwd(), { wireRemote: true });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  const host = /** @type {{ ok?: boolean, message?: string }} */ (res.hostIgnore);
  if (host && host.ok === false) process.stderr.write(`WARNING: ${host.message}\n`);
  process.exit(0);
}
