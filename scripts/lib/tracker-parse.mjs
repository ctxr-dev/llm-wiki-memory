// tracker-parse — pure-function utilities for the tracker-sync hook.
//
// Tracker-agnostic by design: the topology runtime (and therefore this
// hook) treats every tracker (Jira, Linear, ZenDesk, …) uniformly —
// only the `tracker` facet name and `prefix` differ on a per-issue basis.
//
// The hook is a thin layer above four deterministic primitives:
//   1. extractIssueKeys(text)       : scan a string for "{PREFIX}-{N}"
//                                     issue keys (the shape Jira / Linear /
//                                     most prefix-N trackers use)
//   2. parseIssueKey(key)           : key string -> { prefix, number }
//   3. parseChecklist(planMarkdown) : extract every "- [ ] ..." line as a
//                                     stable checkbox record (keyed by the
//                                     item's leading "1." / "5.1" number)
//   4. diffChecklists(before,after) : pair up checkbox records between two
//                                     plan-file versions and report state
//                                     flips and reason-tag additions.
//
// All functions are pure (no I/O, no globals). They're tested standalone
// before the hook orchestration wires them together.
//
// The issue-key extraction primitives (extractIssueKeys / extractIssueKeysByPrefix
// / parseIssueKey) live in tracker-parse-keys.mjs; they're re-exported below so
// this module remains the single import surface for the hook.

export {
  extractIssueKeys,
  extractIssueKeysByPrefix,
  parseIssueKey,
} from "./tracker-parse-keys.mjs";

/**
 * A reason tag parsed off a checkbox line (`reason:<key>:<comment>`).
 * @typedef {Object} ChecklistReason
 * @property {string} key - lowercased reason key.
 * @property {string} comment - trimmed comment text.
 */

/**
 * A single parsed checkbox record from a plan markdown body.
 * @typedef {Object} ChecklistItem
 * @property {number} lineIdx - zero-based source line index.
 * @property {number} indent - leading indent length.
 * @property {string | null} number - stable `<num>`/`<num>.<sub>` diff identity, null if unnumbered.
 * @property {boolean} checked
 * @property {string} label - line text with reason tags stripped.
 * @property {ChecklistReason[]} reasons
 * @property {string} raw - the original source line.
 */

/**
 * A checkbox state flip between two plan versions (from `diffChecklists`).
 * @typedef {Object} ChecklistFlip
 * @property {string} id - the item identity (number, or `label:<label>`).
 * @property {boolean} from - prior checked state.
 * @property {boolean} to - new checked state.
 * @property {ChecklistItem} item - the after-version item.
 */

// Match a markdown checkbox at the start of a line. Accepts ALL these
// shapes the plan-format rule prescribes:
//
//   1. - [ ] X          numbered, leading dash
//   1. [ ] X            numbered, no dash
//   5.1 - [ ] X         nested-numbered, embedded dash
//   - 5.1 - [ ] X       bulleted with embedded sub-number
//   - [ ] X             plain unnumbered
//   - [x] X             plain checked
//
// Captures:
//   1: leading indent
//   2: the `<number>` (or `<num>.<sub>`) prefix — used as the stable
//      diff identity, null if absent
//   3: bracket state — " " (open) or "x"/"X" (closed)
//   4: rest of the line (label + any reason: tags)
const CHECKBOX_RE = /^(\s*)(?:-\s+)?(?:(\d+(?:\.\d+)*)\.?\s+(?:-\s+)?)?\[([ xX])\]\s+(.*)$/;

// `reason:<key>:<comment>` inline tag near a checkbox. Keys are open-ended
// but we recognise the four conventional ones explicitly in tests; the
// regex itself doesn't restrict the key.
const REASON_TAG_RE = /reason:([A-Za-z_][A-Za-z0-9_-]*):(.+?)(?=\s+reason:|$)/g;

/**
 * @param {unknown} planMarkdown
 * @returns {ChecklistItem[]}
 */
export function parseChecklist(planMarkdown) {
  if (!planMarkdown || typeof planMarkdown !== "string") return [];
  /** @type {ChecklistItem[]} */
  const items = [];
  const lines = planMarkdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    const [, indent, number, bracket, rest] = m;
    const checked = bracket.toLowerCase() === "x";
    /** @type {ChecklistReason[]} */
    const reasons = [];
    REASON_TAG_RE.lastIndex = 0;
    let r;
    while ((r = REASON_TAG_RE.exec(rest)) !== null) {
      reasons.push({ key: r[1].toLowerCase(), comment: r[2].trim() });
    }
    // Label is the rest with the reason: tags stripped; preserve other text.
    const label = rest.replace(REASON_TAG_RE, "").trim();
    items.push({
      lineIdx: i,
      indent: indent.length,
      number: number || null, // null if checkbox isn't part of a numbered list
      checked,
      label,
      reasons,
      raw: lines[i],
    });
  }
  return items;
}

// Pair items by their `number` field first (stable across reorderings), then
// fall back to label for items without a number. Returns lists of:
//   - flipped[]:    same identity, state changed
//   - added[]:      identity present in `after` but not `before`
//   - removed[]:    identity present in `before` but not `after`
//   - reasonAdded[]: identity exists in both and a new reason tag appeared
/**
 * @param {ChecklistItem[] | string} before
 * @param {ChecklistItem[] | string} after
 * @returns {{ flipped: ChecklistFlip[], added: ChecklistItem[], removed: ChecklistItem[], reasonAdded: Array<{ id: string, reason: ChecklistReason, item: ChecklistItem }> }}
 */
export function diffChecklists(before, after) {
  const beforeItems = Array.isArray(before) ? before : parseChecklist(before);
  const afterItems = Array.isArray(after) ? after : parseChecklist(after);

  /**
   * @param {ChecklistItem} item
   * @returns {string}
   */
  function identityOf(item) {
    return item.number || `label:${item.label}`;
  }
  /** @type {Map<string, ChecklistItem>} */
  const beforeIx = new Map(beforeItems.map((it) => [identityOf(it), it]));
  /** @type {Map<string, ChecklistItem>} */
  const afterIx = new Map(afterItems.map((it) => [identityOf(it), it]));

  /** @type {ChecklistFlip[]} */
  const flipped = [];
  /** @type {ChecklistItem[]} */
  const added = [];
  /** @type {ChecklistItem[]} */
  const removed = [];
  /** @type {Array<{ id: string, reason: ChecklistReason, item: ChecklistItem }>} */
  const reasonAdded = [];

  for (const [id, a] of afterIx) {
    const b = beforeIx.get(id);
    if (!b) {
      added.push(a);
      continue;
    }
    if (b.checked !== a.checked) {
      flipped.push({ id, from: b.checked, to: a.checked, item: a });
    }
    const before_reasons = new Set(b.reasons.map((r) => `${r.key}:${r.comment}`));
    for (const r of a.reasons) {
      const k = `${r.key}:${r.comment}`;
      if (!before_reasons.has(k)) {
        reasonAdded.push({ id, reason: r, item: a });
      }
    }
  }
  for (const [id, b] of beforeIx) {
    if (!afterIx.has(id)) removed.push(b);
  }
  return { flipped, added, removed, reasonAdded };
}

// Reason-tag keys that mark an UNCHECKED item as "resolved" for the
// lifecycle decision. `canceled` / `cancelled` / `skipped` are terminal:
// the work was deliberately not done. `deferred` / `blocked` are still
// OPEN (the item just isn't actionable yet) and do NOT count as resolved.
const RESOLVING_REASON_KEYS = new Set(["canceled", "cancelled", "skipped"]);

/**
 * @param {ChecklistItem} item
 * @returns {boolean}
 */
function isResolved(item) {
  if (item.checked) return true;
  return Array.isArray(item.reasons) && item.reasons.some((r) => RESOLVING_REASON_KEYS.has(r.key));
}

// Derive the lifecycle from the checklist. Reason-tag-aware:
//   pending      <- nothing resolved
//   in-progress  <- some resolved, not all
//   done         <- every item resolved (checked OR canceled/skipped)
//
// `archived` is intentionally NOT derived here — that state is set by the
// user via an explicit `archived: true` frontmatter.
/**
 * @param {ChecklistItem[] | string} items
 * @returns {import("./types.mjs").PlanStatus}
 */
export function inferLifecycle(items) {
  const list = Array.isArray(items) ? items : parseChecklist(items);
  if (list.length === 0) return "pending";
  const resolved = list.filter(isResolved).length;
  if (resolved === 0) return "pending";
  if (resolved === list.length) return "done";
  return "in-progress";
}

// Progress shape:
//   total     — all items
//   done      — actually checked
//   resolved  — checked OR canceled/skipped (the lifecycle's notion of "settled")
//   open      — total - resolved
//   label     — "{done}/{total}", the user-visible shape
/**
 * @param {ChecklistItem[] | string} items
 * @returns {{ total: number, done: number, resolved: number, open: number, ratio: number, label: string }}
 */
export function checklistProgress(items) {
  const list = Array.isArray(items) ? items : parseChecklist(items);
  const total = list.length;
  const done = list.filter((i) => i.checked).length;
  const resolved = list.filter(isResolved).length;
  return {
    total,
    done,
    resolved,
    open: total - resolved,
    ratio: total === 0 ? 0 : done / total,
    label: total === 0 ? "0/0" : `${done}/${total}`,
  };
}
