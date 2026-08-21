// The frontmatter a leaf carries on disk is both a thing to strip (re-sending it
// as body stacks a second block) and the leaf's own record of its facets, which
// makes it the right default for any facet a caller did not restate. Shared by
// the save-leaf door and doctor's reference scan.
const LEAF_FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

// A body edit re-saves the leaf FILE, which still carries the frontmatter the
// engine wrote. Re-sending it as body stacks a second block, and omitting the
// facet flags lets placement fall back to defaults, which relocates the leaf and
// changes its documentId - silently breaking every inbound reference. So the
// block is stripped AND read: it is the leaf's own record of its facets, and
// therefore the right default for anything the caller did not restate.
/**
 * @param {string} text
 * @returns {{ body: string, inherited: Record<string, unknown> }}
 */
export function splitLeafFrontmatter(text) {
  const match = LEAF_FRONTMATTER.exec(text);
  if (!match) return { body: text, inherited: {} };
  const body = text.slice(match[0].length).replace(/^\n+/, "");
  /** @type {Record<string, unknown>} */
  const inherited = {};
  /** @type {string[]} */
  const subject = [];
  let inMemory = false;
  for (const line of match[1].split("\n")) {
    if (/^memory:\s*$/.test(line)) {
      inMemory = true;
      continue;
    }
    if (!inMemory) continue;
    const item = /^ {2,}- (.+)$/.exec(line);
    if (item) {
      subject.push(item[1].trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (!/^ {2}\S/.test(line)) break;
    const pair = /^ {2}([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair;
    const value = raw.trim().replace(/^['"]|['"]$/g, "");
    if (!value) continue;
    if (
      ["area", "atom_type", "task_type", "language", "priority", "error_pattern", "tags"].includes(
        key,
      )
    ) {
      inherited[key] = value;
    }
  }
  if (subject.length > 0) inherited.subject = subject;
  return { body, inherited };
}
