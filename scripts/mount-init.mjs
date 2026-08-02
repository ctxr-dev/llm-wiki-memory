// The no-clone shared-mount setup, run FROM the single global engine:
// `node scripts/mount-init.mjs <repo>`. The engine is
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
import { helpGuard, refuseFlagAsPath, formatHelp, docsUrl } from "./lib/cli-args.mjs";

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
 * Writes NOTHING outside the mount: no AGENTS.md/CLAUDE.md block, no rule or
 * skill pointers. The one per-machine engine install already supplies those
 * everywhere, so a per-repo copy would only duplicate them into a teammate's
 * repository. Any such artifact an OLDER engine wrote here is stripped.
 * @param {string} mountDir directory that HOLDS the `.llm-wiki-memory` mount
 * @param {{ template?: string }} [opts] seed template
 * @returns {Record<string, unknown>}
 */
export function initMount(mountDir, { template = MOUNT_TEMPLATE } = {}) {
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
  // A shared mount receives NOTHING outside its own `.llm-wiki-memory/` dir: the
  // one per-machine engine install already supplies every rule, skill and the
  // discipline everywhere. This call is CLEANUP-ONLY — it removes any pointer or
  // AGENTS/CLAUDE block an older engine wrote here. Idempotent; only reached for a
  // real shared mount (the no-shared-category path returned above).
  results.strippedInjections = wireSharedRepo(mountDir);
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const HELP = formatHelp({
    name: "mount-init",
    summary:
      "set up OR adopt a shared llm-wiki-memory team wiki in a repo — run from the one home engine, never clones the engine into the repo; seeds/adopts the wiki + git surfaces + a remote-read block in place (idempotent)",
    usage: "node scripts/mount-init.mjs [repo-dir]   (defaults to the current directory)",
    docs: docsUrl("docs/shared-wikis.md"),
  });
  const args = process.argv.slice(2);
  helpGuard(args, HELP);
  refuseFlagAsPath(args[0], HELP);
  const res = initMount(args[0] || process.cwd());
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  const host = /** @type {{ ok?: boolean, message?: string }} */ (res.hostIgnore);
  if (host && host.ok === false) process.stderr.write(`WARNING: ${host.message}\n`);
  process.exit(0);
}
