import fs from "node:fs";
import { POINTER_FALLBACK_NOTE } from "./memory-surface-constants.mjs";

/**
 * True when `abs` is a pointer WE wrote: a symlink (pre-D wiring) or a regular file
 * whose body carries our fallback-note signature. We match the fallback SENTENCE, not
 * the install path — the path varies by install layout (a repo-dev checkout points
 * outside `.llm-wiki-memory/src`), so a path match would miss our own orphans there;
 * the sentence is layout-independent and a user is very unlikely to reproduce it. A
 * user's own file at a reserved name (arbitrary content) and a directory both return
 * false, so a prefix-based prune never blind-deletes something we can't prove we
 * authored (nor EISDIRs on a dir).
 * @param {string} abs @returns {boolean}
 */
export function isOurPointer(abs) {
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) return true;
  if (!stat.isFile()) return false;
  try {
    const body = fs.readFileSync(abs, "utf8");
    // Both signals: a leading @-include line AND the fallback note. A user's doc that
    // merely MENTIONS the note (but isn't an @-pointer) no longer trips the prune.
    return body.trimStart().startsWith("@") && body.includes(POINTER_FALLBACK_NOTE);
  } catch {
    return false;
  }
}
