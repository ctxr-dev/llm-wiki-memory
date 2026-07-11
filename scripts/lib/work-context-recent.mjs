// work-context-recent — the "🧠 Recently — last N days" reminder block injected
// at SessionStart (see `work-context.mjs`, which composes it alongside the
// branch-derived current-work section).
//
// Reads the date-nested `daily/` tree directly (not the semantic index) so
// recency is exact and promoted/disabled leaves still appear. Budget-guarded so
// the injected block respects the SessionStart context budget.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { recallRecentActivityDays } from "./settings.mjs";
import { buildBrief } from "./brief.mjs";
import { parseDailyDocName } from "./slug.mjs";

/**
 * @typedef {Object} DailyLeafEntry
 * @property {string} date
 * @property {string} time
 * @property {string} ms
 * @property {string} abs
 * @property {string} rel
 */

function safeRecentActivityDays() {
  try {
    return recallRecentActivityDays();
  } catch {
    return 3;
  }
}

// Budget guards for the injected "Recently" block: keep it small so it respects
// the SessionStart context budget (a test pins the whole section under ~1KB).
const RECENT_MAX_BULLETS = 6;
const RECENT_BRIEF_CHARS = 120;
const RECENT_SECTION_BUDGET = 1000;

/**
 * @param {string} dir
 * @returns {fs.Dirent[]}
 */
function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// The most recent daily notes across the last `days` distinct dates. Reads the
// date-nested `daily/` tree directly (not the semantic index) so recency is
// exact and promoted/disabled leaves still appear — they are what "what did I
// do recently" means, regardless of whether compile has archived them.
/**
 * @param {string} wikiRoot
 * @param {number} days
 * @returns {DailyLeafEntry[]}
 */
function readRecentDailyLeaves(wikiRoot, days) {
  if (!wikiRoot || !(days > 0)) return [];
  const dailyRoot = path.join(wikiRoot, "daily");
  /** @type {DailyLeafEntry[]} */
  const entries = [];
  for (const y of listDirSafe(dailyRoot)) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    for (const mo of listDirSafe(path.join(dailyRoot, y.name))) {
      if (!mo.isDirectory() || !/^\d{2}$/.test(mo.name)) continue;
      for (const d of listDirSafe(path.join(dailyRoot, y.name, mo.name))) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        const dayDir = path.join(dailyRoot, y.name, mo.name, d.name);
        for (const f of listDirSafe(dayDir)) {
          if (!f.isFile() || !f.name.startsWith("daily-") || !f.name.endsWith(".md")) continue;
          const parsed = parseDailyDocName(f.name);
          entries.push({
            date: `${y.name}-${mo.name}-${d.name}`,
            time: parsed?.time || "000000",
            ms: parsed?.ms || "000",
            abs: path.join(dayDir, f.name),
            rel: `daily/${y.name}/${mo.name}/${d.name}/${f.name}`,
          });
        }
      }
    }
  }
  entries.sort((a, b) => `${b.date}${b.time}${b.ms}`.localeCompare(`${a.date}${a.time}${a.ms}`));
  /** @type {string[]} */
  const keepDates = [];
  /** @type {DailyLeafEntry[]} */
  const kept = [];
  for (const e of entries) {
    if (!keepDates.includes(e.date)) {
      if (keepDates.length >= days) break;
      keepDates.push(e.date);
    }
    kept.push(e);
  }
  return kept;
}

/**
 * @param {string} absPath
 * @returns {string}
 */
function briefForDailyLeaf(absPath) {
  try {
    const parsed = matter(fs.readFileSync(absPath, "utf8"));
    const data = parsed.data || {};
    const mem = (data && typeof data.memory === "object" && data.memory) || {};
    const brief = data.brief || buildBrief({ body: parsed.content || "", memoryMeta: mem });
    return String(brief || "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

/**
 * @param {DailyLeafEntry} entry
 * @returns {string}
 */
function stampLabel(entry) {
  const t =
    entry.time && entry.time.length >= 4
      ? `${entry.time.slice(0, 2)}:${entry.time.slice(2, 4)}`
      : "";
  return t ? `${entry.date} ${t}` : entry.date;
}

// Compose the "🧠 Recently — last N days" reminder: one dated bullet per recent
// daily note (its brief + a link to open it), built from briefs so it stays
// light. Returns "" when disabled (days=0) or there are no recent notes.
/**
 * @param {{ wikiRoot?: string, days?: number }} [args]
 * @returns {string}
 */
export function buildRecentActivitySection({ wikiRoot, days } = {}) {
  const window = days == null ? safeRecentActivityDays() : days;
  if (!wikiRoot || !(window > 0)) return "";
  const leaves = readRecentDailyLeaves(wikiRoot, window);
  if (leaves.length === 0) return "";
  const bullets = leaves.slice(0, RECENT_MAX_BULLETS).map((e) => {
    const brief = briefForDailyLeaf(e.abs);
    let label = brief || "(note)";
    if (label.length > RECENT_BRIEF_CHARS) {
      label = `${label.slice(0, RECENT_BRIEF_CHARS).replace(/\s+\S*$/, "")}…`;
    }
    // Clickable absolute file:// link so the note can actually be opened.
    return `- **${stampLabel(e)}** — ${label} → [${path.basename(e.abs)}](file://${e.abs})`;
  });
  // Non-breaking space after the emoji so the gap survives markdown space-collapse and
  // never renders glued to the wide glyph. No "…and N more" line: a dropped-count the
  // reader can't act on is noise; over-budget bullets are simply trimmed.
  const compose = (/** @type {string[]} */ shown) =>
    ["", `## 🧠  Recently — last ${window} days`, "", ...shown, ""].join("\n");
  let section = compose(bullets);
  while (section.length > RECENT_SECTION_BUDGET && bullets.length > 1) {
    bullets.pop();
    section = compose(bullets);
  }
  return section;
}
