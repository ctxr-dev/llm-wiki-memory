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

// ---------------------------------------------------------------------------
// Issue-key extraction (tracker-agnostic)
// ---------------------------------------------------------------------------

// Match {PREFIX}-{N} where PREFIX is 2-10 uppercase-or-digit chars (must
// start with a letter) and N is 1-7 digits. Matches at word boundaries so
// arbitrary strings like "DEV-129957 / OPS-44231 / ENG-7" all extract.
// Covers Jira / Linear / and any tracker with the "{PREFIX}-{N}" key shape.
// (GitHub's "owner/repo#N" form isn't matched here — that's a separate
// pattern we'll add when GitHub-sync is actually wired up.)
const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;

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
export function extractIssueKeysByPrefix(text) {
  const grouped = new Map();
  for (const key of extractIssueKeys(text)) {
    const [prefix] = key.split("-");
    if (!grouped.has(prefix)) grouped.set(prefix, []);
    grouped.get(prefix).push(key);
  }
  return grouped;
}

// Split an issue key into its tracker-agnostic facets. Callers that map a
// key to a wiki path pass these into the `tracker-issue` topology's
// `pathFor(...)` directly — no tracker-specific logic in the hook.
export function parseIssueKey(key) {
  if (!key || typeof key !== "string") return null;
  const m = /^([A-Z][A-Z0-9]{1,9})-(\d{1,7})$/.exec(key);
  if (!m) return null;
  return { prefix: m[1], number: Number(m[2]) };
}

// ---------------------------------------------------------------------------
// Checkbox parsing
// ---------------------------------------------------------------------------

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
const CHECKBOX_RE =
  /^(\s*)(?:-\s+)?(?:(\d+(?:\.\d+)*)\.?\s+(?:-\s+)?)?\[([ xX])\]\s+(.*)$/;

// `reason:<key>:<comment>` inline tag near a checkbox. Keys are open-ended
// but we recognise the four conventional ones explicitly in tests; the
// regex itself doesn't restrict the key.
const REASON_TAG_RE = /reason:([A-Za-z_][A-Za-z0-9_-]*):(.+?)(?=\s+reason:|$)/g;

export function parseChecklist(planMarkdown) {
  if (!planMarkdown || typeof planMarkdown !== "string") return [];
  const items = [];
  const lines = planMarkdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    const [, indent, number, bracket, rest] = m;
    const checked = bracket.toLowerCase() === "x";
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

// ---------------------------------------------------------------------------
// Checklist diff (between two versions of the same plan file)
// ---------------------------------------------------------------------------

// Pair items by their `number` field first (stable across reorderings), then
// fall back to label for items without a number. Returns lists of:
//   - flipped[]:    same identity, state changed
//   - added[]:      identity present in `after` but not `before`
//   - removed[]:    identity present in `before` but not `after`
//   - reasonAdded[]: identity exists in both and a new reason tag appeared
export function diffChecklists(before, after) {
  const beforeItems = Array.isArray(before) ? before : parseChecklist(before);
  const afterItems = Array.isArray(after) ? after : parseChecklist(after);

  function identityOf(item) {
    return item.number || `label:${item.label}`;
  }
  const beforeIx = new Map(beforeItems.map((it) => [identityOf(it), it]));
  const afterIx = new Map(afterItems.map((it) => [identityOf(it), it]));

  const flipped = [];
  const added = [];
  const removed = [];
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

// ---------------------------------------------------------------------------
// Lifecycle inference
// ---------------------------------------------------------------------------

// Reason-tag keys that mark an UNCHECKED item as "resolved" for the
// lifecycle decision. `canceled` / `cancelled` / `skipped` are terminal:
// the work was deliberately not done. `deferred` / `blocked` are still
// OPEN (the item just isn't actionable yet) and do NOT count as resolved.
const RESOLVING_REASON_KEYS = new Set(["canceled", "cancelled", "skipped"]);

function isResolved(item) {
  if (item.checked) return true;
  return (
    Array.isArray(item.reasons) &&
    item.reasons.some((r) => RESOLVING_REASON_KEYS.has(r.key))
  );
}

// Derive the lifecycle from the checklist. Reason-tag-aware:
//   pending      <- nothing resolved
//   in-progress  <- some resolved, not all
//   done         <- every item resolved (checked OR canceled/skipped)
//
// `archived` is intentionally NOT derived here — that state is set by the
// user via an explicit `archived: true` frontmatter.
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
