export const PLAN_STATES = ["pending", "in-progress", "done", "archived"];

const PLAN_LEAF_SUFFIX = ".plan.md";
const STATES = new Set(PLAN_STATES);

/**
 * The lifecycle folder is the DEEPEST directory segment of a tracker plan id, so a
 * facet dir higher up that happens to be spelled like a state never wins over it.
 * @param {string[]} dirs
 * @returns {number}
 */
function lifecycleIndex(dirs) {
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    if (STATES.has(dirs[i])) return i;
  }
  return -1;
}

/**
 * Candidate ids for a plan whose id carries a STALE lifecycle segment: the same path
 * with that one segment swapped for each other state, in PLAN_STATES order so a leaf
 * present under two lifecycle folders resolves deterministically. Empty for anything
 * that is not a `.plan.md` under a lifecycle folder — matching is whole-segment, so
 * `pending-review/` or a leaf named `done-notes.md` is never treated as lifecycle.
 * @param {string} docId
 * @returns {string[]}
 */
export function lifecycleCandidateIds(docId) {
  const segments = String(docId || "").split("/");
  const name = segments[segments.length - 1];
  if (segments.length < 2 || !name.endsWith(PLAN_LEAF_SUFFIX)) return [];
  const dirs = segments.slice(0, -1);
  const index = lifecycleIndex(dirs);
  if (index === -1) return [];
  return PLAN_STATES.filter((state) => state !== dirs[index]).map((state) =>
    [...dirs.slice(0, index), state, ...dirs.slice(index + 1), name].join("/"),
  );
}
