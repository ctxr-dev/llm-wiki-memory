import fs from "node:fs";
import path from "node:path";

// Walk UP from `dir`, removing every ancestor that is empty or holds only an
// auto-generated index.md, stopping at (and never removing) `wikiRoot`. Used
// after a leaf RELOCATION so the source subtree doesn't leave orphan folders
// (a dir with just an index.md, or a fully empty dir) behind — matching the
// invariant that the wiki never keeps "blind" nested dirs with no real leaves.
//
// "Empty" = zero entries, OR exactly one entry that is index.md (the only file
// the skill itself writes in a non-leaf dir). A dir with any other file or any
// subdir is meaningful and stops the walk.
export function pruneEmptyAncestors(dir, wikiRoot) {
  const wikiAbs = path.resolve(wikiRoot);
  let cur = path.resolve(dir);
  while (cur !== wikiAbs && cur.startsWith(wikiAbs + path.sep)) {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      break;
    }
    const meaningful = entries.filter((e) => e.name !== "index.md");
    if (meaningful.length > 0) break;
    if (entries.length === 1 && entries[0].name === "index.md") {
      try {
        fs.unlinkSync(path.join(cur, "index.md"));
      } catch {
        // best-effort
      }
    }
    try {
      fs.rmdirSync(cur);
    } catch {
      break;
    }
    cur = path.dirname(cur);
  }
}
