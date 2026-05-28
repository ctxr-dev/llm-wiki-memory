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

// Compose the markdown section. Returns an empty string when there's no
// useful context (no branch, no wiki matches) so the caller can simply
// concatenate without conditional logic.
export async function buildWorkContextSection({
  cwd = process.cwd(),
  searchMemory, // injected so the hook can supply its own impl (tests too)
  wikiRoot, // for resolving relative documentId paths
  maxResults = 5,
} = {}) {
  const active = detectActiveContext(cwd);
  if (!active) return "";

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

  // For plan files among the top hits, pull their progress to surface
  // alongside the path.
  const lines = [
    "",
    "## Current-work context",
    "",
    `**Branch**: \`${active.branch}\`  •  **Repo**: \`${active.repo}\`  •  **CWD**: \`${active.cwd}\``,
    "",
    `**Top wiki matches** (semantic, top ${records.length}):`,
  ];
  for (const r of records) {
    const score = typeof r.score === "number" ? r.score.toFixed(3) : "?";
    let extra = "";
    if (
      wikiRoot &&
      typeof r.documentId === "string" &&
      r.documentId.endsWith(".plan.md")
    ) {
      const abs = path.join(wikiRoot, r.documentId);
      const prog = readPlanProgress(abs);
      if (prog?.progress?.label) {
        extra = ` — ${prog.progress.label} done` + (prog.status ? `, ${prog.status}` : "");
      } else if (prog?.status) {
        extra = ` — ${prog.status}`;
      }
    }
    lines.push(`- \`${r.documentId}\` (${score})${extra}`);
  }
  lines.push("");
  lines.push(
    "_Auto-injected at SessionStart by `llm-wiki-memory/scripts/hooks/session-start.mjs`. " +
      "Use the `current-work-context` skill to re-fetch after a branch change._",
  );
  lines.push("");
  return lines.join("\n");
}
