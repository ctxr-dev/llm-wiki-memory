// tracker-parse-keys — issue-key extraction primitives for the tracker-sync
// hook (see `tracker-parse.mjs`, which composes these with the checkbox-diff
// primitives). Pure functions: no I/O, no globals beyond the shared /g regex
// whose lastIndex is reset defensively on each call.
//
// Tracker-agnostic by design: the topology runtime (and therefore this hook)
// treats every tracker (Jira, Linear, ZenDesk, …) uniformly — only the
// `tracker` facet name and `prefix` differ on a per-issue basis.

// Match {PREFIX}-{N} where PREFIX is 2-10 uppercase-or-digit chars (must
// start with a letter) and N is 1-7 digits. Matches at word boundaries so
// arbitrary strings like "DEV-129957 / OPS-44231 / ENG-7" all extract.
// Covers Jira / Linear / and any tracker with the "{PREFIX}-{N}" key shape.
// (GitHub's "owner/repo#N" form isn't matched here — that's a separate
// pattern we'll add when GitHub-sync is actually wired up.)
const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;

/**
 * @param {unknown} text
 * @returns {string[]}
 */
export function extractIssueKeys(text) {
  if (!text || typeof text !== "string") return [];
  const seen = new Set();
  let m;
  // Reset the regex's lastIndex defensively (it's a /g regex held in a
  // module-level binding; concurrent extractIssueKeys calls would otherwise
  // race on the shared lastIndex.)
  ISSUE_KEY_RE.lastIndex = 0;
  while ((m = ISSUE_KEY_RE.exec(text)) !== null) {
    seen.add(`${m[1]}-${m[2]}`);
  }
  return [...seen].sort();
}

// Convenience: extract distinct issue keys grouped by their prefix.
/**
 * @param {unknown} text
 * @returns {Map<string, string[]>}
 */
export function extractIssueKeysByPrefix(text) {
  /** @type {Map<string, string[]>} */
  const grouped = new Map();
  for (const key of extractIssueKeys(text)) {
    const [prefix] = key.split("-");
    if (!grouped.has(prefix)) grouped.set(prefix, []);
    /** @type {string[]} */ (grouped.get(prefix)).push(key);
  }
  return grouped;
}

// Split an issue key into its tracker-agnostic facets. Callers that map a
// key to a wiki path pass these into the `tracker-issue` topology's
// `pathFor(...)` directly — no tracker-specific logic in the hook.
/**
 * @param {unknown} key
 * @returns {{ prefix: string, number: number } | null}
 */
export function parseIssueKey(key) {
  if (!key || typeof key !== "string") return null;
  const m = /^([A-Z][A-Z0-9]{1,9})-(\d{1,7})$/.exec(key);
  if (!m) return null;
  return { prefix: m[1], number: Number(m[2]) };
}
