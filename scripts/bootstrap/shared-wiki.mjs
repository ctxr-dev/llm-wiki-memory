import { pathToFileURL } from "node:url";
import { sharedCategories, mergedLayoutForRoot } from "../lib/wiki-ownership.mjs";
import { helpGuard, refuseFlagAsPath, formatHelp, docsUrl } from "../lib/cli-args.mjs";

// Is the wiki at `wikiDir` a SHARED (team) mount — i.e. its merged layout
// declares at least one `ownership: repo` category? This is the SAME predicate
// the runtime git-safety guard (`gitUsable`) uses, so bootstrap's install-time
// decision can never drift from it. A missing/garbage layout → false (never
// throws — a broken layout must not wedge install).

/**
 * @param {string} wikiDir the wiki root (the dir that holds `.layout/`)
 * @returns {boolean}
 */
export function isSharedWiki(wikiDir) {
  try {
    return sharedCategories(mergedLayoutForRoot(wikiDir)).length > 0;
  } catch {
    return false;
  }
}

// CLI: prints "1" for a shared wiki, "0" otherwise — the single-source-of-truth
// bootstrap uses (replacing the old ad-hoc grep, which missed layout.local.yaml
// and could misfire on malformed YAML; this agrees with gitUsable).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  const HELP = formatHelp({
    name: "shared-wiki",
    summary: "print 1 if the wiki at <wikiDir> is a shared (ownership: repo) mount, else 0",
    usage: "node scripts/bootstrap/shared-wiki.mjs <wikiDir>",
    docs: docsUrl("docs/shared-wikis.md"),
  });
  helpGuard(args, HELP);
  refuseFlagAsPath(args[0], HELP);
  process.stdout.write(isSharedWiki(args[0] || "") ? "1" : "0");
}
