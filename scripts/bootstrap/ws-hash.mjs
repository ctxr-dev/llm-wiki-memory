#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { helpGuard, refuseFlagAsPath, formatHelp, docsUrl } from "../lib/cli-args.mjs";

// Windows analogue of the POSIX cksum bootstrap.sh feeds into the schedule id.
/** @param {string} workspaceDir @returns {string} */
export function wsHash(workspaceDir) {
  return createHash("sha256").update(String(workspaceDir)).digest("hex").slice(0, 12);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  const HELP = formatHelp({
    name: "ws-hash",
    summary: "print the deterministic workspace hash used for the scheduled-task id",
    usage: "node scripts/bootstrap/ws-hash.mjs <workspaceDir>",
    docs: docsUrl("AI-INSTALL-PROMPT.md"),
  });
  helpGuard(args, HELP);
  refuseFlagAsPath(args[0], HELP);
  process.stdout.write(wsHash(args[0] || ""));
}
