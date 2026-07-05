// work-context — build a "what was the user just working on" markdown
// section to inject into SessionStart's additionalContext.
//
// Provider-agnostic by design: detects cwd + git branch via universal
// signals (process.cwd, `git rev-parse`), then uses semantic search
// against the wiki — no regex extraction of tracker keys, no reliance
// on Claude-specific env vars.
//
// Companion to the `current-work-context` skill: same idea, two
// invocation paths.
//   - This module: auto-pushed at SessionStart (no LLM round-trip needed)
//   - The skill: on-demand / mid-session branch-switch
// They reference the same MCP tools and produce the same shape of output.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import matter from "gray-matter";
import { recallPlanContextMax, recallRecentActivityDays } from "./settings.mjs";
import { buildBrief } from "./brief.mjs";
import { parseDailyDocName } from "./slug.mjs";

// Branches we deliberately don't warm context for — they're "blank slate"
// branches where injecting yesterday's work would be noise.
const SKIP_BRANCHES = new Set(["main", "master", "develop", "trunk", "HEAD"]);

function git(args, cwd) {
  try {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status !== 0) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

// Detect the active branch + repo from a starting cwd. Returns null when
// we're not inside a git repo, or the result is uninformative (detached
// HEAD, blank branch, etc.).
export function detectActiveContext(cwd = process.cwd()) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  if (!branch || !repoRoot) return null;
  if (SKIP_BRANCHES.has(branch)) return null;
  return {
    cwd,
    branch,
    repo: path.basename(repoRoot),
    repoRoot,
  };
}

// Read a plan file (or any wiki leaf) and return its frontmatter status
// + progress label. Defensive: returns null if anything fails. We don't
// recompute progress from the body here — the plan-frontmatter hook is
// what keeps that field current; we just surface it.
function readPlanProgress(absPath) {
  try {
    const raw = fs.readFileSync(absPath, "utf8");
    const fm = matter(raw).data || {};
    return {
      status: fm.status || null,
      progress: fm.progress || null,
    };
  } catch {
    return null;
  }
}

function safePlanContextMax() {
  try {
    return recallPlanContextMax();
  } catch {
    return 2;
  }
}

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
export function readRecentDailyLeaves(wikiRoot, days) {
  if (!wikiRoot || !(days > 0)) return [];
  const dailyRoot = path.join(wikiRoot, "daily");
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
  const keepDates = [];
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

function briefForDailyLeaf(absPath) {
  try {
    const parsed = matter(fs.readFileSync(absPath, "utf8"));
    const data = parsed.data || {};
    const mem = (data && typeof data.memory === "object" && data.memory) || {};
    const brief = data.brief || buildBrief({ body: parsed.content || "", memoryMeta: mem });
    return String(brief || "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function stampLabel(entry) {
  const t = entry.time && entry.time.length >= 4 ? `${entry.time.slice(0, 2)}:${entry.time.slice(2, 4)}` : "";
  return t ? `${entry.date} ${t}` : entry.date;
}

// Compose the "🧠 Recently — last N days" reminder: one dated bullet per recent
// daily note (its brief + a link to open it), built from briefs so it stays
// light. Returns "" when disabled (days=0) or there are no recent notes.
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
  const compose = (shown) => ["", `## 🧠  Recently — last ${window} days`, "", ...shown, ""].join("\n");
  let section = compose(bullets);
  while (section.length > RECENT_SECTION_BUDGET && bullets.length > 1) {
    bullets.pop();
    section = compose(bullets);
  }
  return section;
}

// Compose the markdown section. Returns an empty string when there's no
// useful context (no branch, no wiki matches) so the caller can simply
// concatenate without conditional logic.
export async function buildWorkContextSection({
  cwd = process.cwd(),
  searchMemory, // injected so the hook can supply its own impl (tests too)
  wikiRoot, // for resolving relative documentId paths
  maxResults = 5,
  planContextMax,
} = {}) {
  const active = detectActiveContext(cwd);
  if (!active) return "";
  const planMax = planContextMax == null ? safePlanContextMax() : planContextMax;

  let searchResult;
  try {
    searchResult = await searchMemory({
      query: active.branch,
      maxResults,
    });
  } catch (err) {
    // Search failure is non-fatal — return empty so the rest of the
    // SessionStart pipeline still works.
    return "";
  }

  const records = searchResult?.records || [];
  if (records.length === 0) return "";

  // Plan hits get their progress surfaced, but the list is capped to planMax and
  // unfinished plans are preferred, so a pile of related plans (or finished ones)
  // can't crowd out the plan you're actually working on. Non-plan hits are kept.
  const isPlanId = (id) => wikiRoot && typeof id === "string" && id.endsWith(".plan.md");
  const planProgress = new Map();
  const planHits = [];
  for (const r of records) {
    if (isPlanId(r.documentId)) {
      planProgress.set(r.documentId, readPlanProgress(path.join(wikiRoot, r.documentId)));
      planHits.push(r);
    }
  }
  const keepPlans = new Set(
    planHits
      .map((r, i) => ({ id: r.documentId, i, inProgress: planProgress.get(r.documentId)?.status === "in-progress" }))
      .sort((a, b) => (a.inProgress === b.inProgress ? a.i - b.i : a.inProgress ? -1 : 1))
      .slice(0, planMax)
      .map((x) => x.id),
  );

  const bullets = [];
  for (const r of records) {
    const plan = isPlanId(r.documentId);
    if (plan && !keepPlans.has(r.documentId)) continue;
    const score = typeof r.score === "number" ? r.score.toFixed(3) : "?";
    let extra = "";
    if (plan) {
      const prog = planProgress.get(r.documentId);
      if (prog?.progress?.label) {
        extra = ` — ${prog.progress.label} done` + (prog.status ? `, ${prog.status}` : "");
      } else if (prog?.status) {
        extra = ` — ${prog.status}`;
      }
    }
    bullets.push(`- \`${r.documentId}\` (${score})${extra}`);
  }

  const lines = [
    "",
    "## Current-work context",
    "",
    `**Branch**: \`${active.branch}\`  •  **Repo**: \`${active.repo}\`  •  **CWD**: \`${active.cwd}\``,
    "",
    `**Top wiki matches** (semantic, top ${bullets.length}):`,
    ...bullets,
    "",
    "_Auto-injected at SessionStart by `llm-wiki-memory/scripts/hooks/session-start.mjs`. " +
      "Use the `current-work-context` skill to re-fetch after a branch change._",
    "",
  ];
  return lines.join("\n");
}
