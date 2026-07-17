// Thin CLI over the uninstall helper: reverse the machine-managed install
// surfaces (MCP registration + chained git-hook blocks) under a workspace, then
// print the manual reversals it deliberately did NOT perform. Invoked by
// `bootstrap.sh --uninstall`, which owns the cron/launchd teardown separately.
//
//   node scripts/uninstall.mjs <workspaceDir> [repoDir ...]

import { pathToFileURL } from "node:url";
import { uninstall } from "./lib/uninstall.mjs";
import { helpGuard, refuseFlagAsPath, formatHelp, docsUrl } from "./lib/cli-args.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const HELP = formatHelp({
    name: "uninstall",
    summary:
      "reverse the machine-managed install surfaces (global MCP entry, hooks, marker blocks) for a workspace — never deletes memory data",
    usage: "node scripts/uninstall.mjs <workspaceDir> [repoDir...]",
    docs: docsUrl("docs/shared-wikis.md"),
  });
  helpGuard(args, HELP);
  refuseFlagAsPath(args[0], HELP);
  const [workspaceDir, ...repoDirs] = process.argv.slice(2);
  if (!workspaceDir) {
    process.stderr.write("usage: uninstall.mjs <workspaceDir> [repoDir ...]\n");
    process.exit(1);
  }
  const report = uninstall({ workspaceDir, repoDirs });
  process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`);
  process.stderr.write("\nManual steps NOT performed automatically:\n");
  for (const line of report.manual) process.stderr.write(`  - ${line}\n`);
  process.exit(0);
}
