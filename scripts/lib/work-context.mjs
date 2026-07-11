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
//
// The "🧠 Recently — last N days" reminder (daily-tree scan + budget guards)
// lives in work-context-recent.mjs; its entry point is re-exported below
// so this module remains the single import surface for the SessionStart hook.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import matter from "gray-matter";
import { recallPlanContextMax } from "./settings.mjs";

export { buildRecentActivitySection } from "./work-context-recent.mjs";

/** @typedef {import("./types.mjs").SearchResponse} SearchResponse */
/** @typedef {import("./types.mjs").SearchHit} SearchHit */

/**
 * @typedef {Object} ActiveContext
 * @property {string} cwd
 * @property {string} branch
 * @property {string} repo
 * @property {string} repoRoot
 */

/**
 * @typedef {Object} ReadPlanProgressResult
 * @property {string | null} status
 * @property {{ label?: string } | null} progress
 */

// Branches we deliberately don't warm context for — they're "blank slate"
// branches where injecting yesterday's work would be noise.
const SKIP_BRANCHES = new Set(["main", "master", "develop", "trunk", "HEAD"]);

/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string | null}
 */
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
/**
 * @param {string} [cwd]
 * @returns {ActiveContext | null}
 */
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

// Compute the default `scopes` value for a session: the current working
// directory, plus its git repo root when inside a repo and distinct from cwd.
// Order-stable (cwd first) and deduplicated. Provider-agnostic: derived from
// `process.cwd()` + git only, never a client-specific env var (the
// dev-principles cross-client rule). An empty array when no cwd is available,
// so the caller seeds nothing rather than a bogus scope.
/**
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function computeSessionScopes(cwd = process.cwd()) {
  if (typeof cwd !== "string" || cwd.length === 0) return [];
  /** @type {string[]} */
  const scopes = [cwd];
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  if (repoRoot && !scopes.includes(repoRoot)) scopes.push(repoRoot);
  return scopes;
}

// One concise SessionStart line that SEEDS the required `scopes` argument (C5c
// made it mandatory on every memory tool), so a freshly restarted server stays
// usable: the agent reads this line and passes the named directories. Returns
// an empty string when no scope can be computed (no cwd) so the caller
// concatenates it unconditionally with the other SessionStart sections.
/**
 * @param {Object} [args]
 * @param {string} [args.cwd]
 * @returns {string}
 */
export function buildScopeSeedSection({ cwd = process.cwd() } = {}) {
  const scopes = computeSessionScopes(cwd);
  if (scopes.length === 0) return "";
  const list = scopes.map((s) => `\`${s}\``).join(", ");
  return (
    `\n\nMemory scopes for this session: [${list}]. ` +
    "Pass these as the REQUIRED `scopes` array to every memory tool " +
    "(the directories you are working in; the engine walks each up to your home wiki). " +
    "`scopes` is never optional."
  );
}

// Read a plan file (or any wiki leaf) and return its frontmatter status
// + progress label. Defensive: returns null if anything fails. We don't
// recompute progress from the body here — the plan-frontmatter hook is
// what keeps that field current; we just surface it.
/**
 * @param {string} absPath
 * @returns {ReadPlanProgressResult | null}
 */
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

// Compose the markdown section. Returns an empty string when there's no
// useful context (no branch, no wiki matches) so the caller can simply
// concatenate without conditional logic.
/**
 * @param {Object} [args]
 * @param {string} [args.cwd]
 * @param {(args: { query: string, maxResults: number }) => Promise<SearchResponse>} [args.searchMemory] - injected so the hook can supply its own impl (tests too)
 * @param {string} [args.wikiRoot] - for resolving relative documentId paths
 * @param {number} [args.maxResults]
 * @param {number} [args.planContextMax]
 * @returns {Promise<string>}
 */
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

  /** @type {SearchResponse | undefined} */
  let searchResult;
  try {
    searchResult = await /** @type {NonNullable<typeof searchMemory>} */ (searchMemory)({
      query: active.branch,
      maxResults,
    });
  } catch {
    // Search failure is non-fatal — return empty so the rest of the
    // SessionStart pipeline still works.
    return "";
  }

  const records = searchResult?.records || [];
  if (records.length === 0) return "";

  // Plan hits get their progress surfaced, but the list is capped to planMax and
  // unfinished plans are preferred, so a pile of related plans (or finished ones)
  // can't crowd out the plan you're actually working on. Non-plan hits are kept.
  const isPlanId = (/** @type {unknown} */ id) =>
    wikiRoot && typeof id === "string" && id.endsWith(".plan.md");
  /** @type {Map<string, ReadPlanProgressResult | null>} */
  const planProgress = new Map();
  /** @type {SearchHit[]} */
  const planHits = [];
  for (const r of records) {
    if (isPlanId(r.documentId)) {
      planProgress.set(
        r.documentId,
        readPlanProgress(path.join(/** @type {string} */ (wikiRoot), r.documentId)),
      );
      planHits.push(r);
    }
  }
  const keepPlans = new Set(
    planHits
      .map((r, i) => ({
        id: r.documentId,
        i,
        inProgress: planProgress.get(r.documentId)?.status === "in-progress",
      }))
      .sort((a, b) => (a.inProgress === b.inProgress ? a.i - b.i : a.inProgress ? -1 : 1))
      .slice(0, planMax)
      .map((x) => x.id),
  );

  /** @type {string[]} */
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
