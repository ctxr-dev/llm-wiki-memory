// Bootstrap primitive: wire the per-folder git + gitignore for a federated wiki
// MOUNT (Phase G). Thin orchestration over the tested lib helpers — bootstrap.sh
// invokes `node scripts/mount-init.mjs <mountDir>` when installing a mount.
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
import {
  initPersonalGit,
  assertMountNotHostIgnored,
  installSyncEmbeddingsHook,
} from "./lib/mount-git.mjs";

const MOUNT_DIRNAME = ".llm-wiki-memory";

/**
 * Provision a mount's git surfaces: a negated `.gitignore` tracking only shared
 * categories, a private personal git repo, a host-ignore shadow check, and the
 * chained sync-embeddings hook. No-op (returns `skipped`) when the layout
 * declares no shared category.
 * @param {string} mountDir directory that HOLDS the `.llm-wiki-memory` mount
 * @returns {Record<string, unknown>}
 */
export function initMount(mountDir) {
  const dataDir = path.join(mountDir, MOUNT_DIRNAME);
  const wikiRootDir = path.join(dataDir, "wiki");
  const layout = mergedLayoutForRoot(wikiRootDir);
  if (sharedCategories(layout).length === 0) {
    return { ok: true, skipped: "no-shared-categories" };
  }
  /** @type {Record<string, unknown>} */
  const results = {};
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
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = initMount(process.argv[2] || process.cwd());
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  const host = /** @type {{ ok?: boolean, message?: string }} */ (res.hostIgnore);
  if (host && host.ok === false) process.stderr.write(`WARNING: ${host.message}\n`);
  process.exit(0);
}
