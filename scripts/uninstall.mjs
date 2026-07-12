// Thin CLI over the uninstall helper: reverse the machine-managed install
// surfaces (MCP registration + chained git-hook blocks) under a workspace, then
// print the manual reversals it deliberately did NOT perform. Invoked by
// `bootstrap.sh --uninstall`, which owns the cron/launchd teardown separately.
//
//   node scripts/uninstall.mjs <workspaceDir> [repoDir ...]

import { pathToFileURL } from "node:url";
import { uninstall } from "./lib/uninstall.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
