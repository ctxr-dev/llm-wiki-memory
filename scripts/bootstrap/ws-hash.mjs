#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Windows analogue of the POSIX cksum bootstrap.sh feeds into the schedule id.
/** @param {string} workspaceDir @returns {string} */
export function wsHash(workspaceDir) {
  return createHash("sha256").update(String(workspaceDir)).digest("hex").slice(0, 12);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.stdout.write(wsHash(process.argv[2] || ""));
}
