import fs from "node:fs";
import { DOC_MARKER_START, DOC_MARKER_END } from "./memory-surface-constants.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { stripManagedBlocks, stripBlockFromFile } from "./marker-block.mjs";

// The ONE marker-fenced block llm-wiki-memory maintains in a workspace's
// AGENTS.md / CLAUDE.md. Idempotent: any prior managed block is stripped before the
// current one is appended, so a re-wire never accumulates duplicates.

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
export function wireInclude(file, ref) {
  writeDocBlock(
    file,
    `## Project memory (llm-wiki-memory)\n\n@${ref}\n\nIf your client does not resolve the @-include above, read:\n${ref}`,
  );
}

/**
 * Remove OUR block from a workspace doc, deleting the doc when it held nothing
 * else. Used by the shared-mount path, which writes no block at all and cleans up
 * whatever an older engine left behind.
 * @param {string} file @returns {boolean}
 */
export function stripDocBlock(file) {
  return stripBlockFromFile(file, DOC_MARKER_START, DOC_MARKER_END);
}

export { writeIfChanged };
