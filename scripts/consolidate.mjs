// Search-driven AutoDream consolidation orchestrator.
//
// For every active leaf in the layout-declared `consolidate: refine`
// categories, compute its similarity cluster via `searchMemoryFiltered`,
// apply deterministic dedup passes (sha256 / lesson-key / cosine), then a
// sweep of corpus-scoped passes (staleness flag, orphan archive,
// compress-archived, prune-empty-ancestors, gc-embeddings, index-rebuild).
// Eligibility is layout-driven — NO category name is hardcoded in this
// file. Atom-type-based filters (LESSON_KEY_ELIGIBLE_ATOM_TYPES,
// STALENESS_ELIGIBLE_ATOM_TYPES, ORPHAN_EXCLUDE_ATOM_TYPES) decide
// per-leaf behaviour within a refine-eligible category. The whole run is
// wrapped in `withSystemMaintenance(...)` so every internal write is
// exempt from the L3 self_improvement write-gate.
//
// Phase 3 (LLM-merge + LLM-refresh) plugs into the SAME merge-candidates
// indirection used here: each cluster pass marks (keeper, loser) tuples
// in `ctx.mergeCandidates`; the per-leaf `finalizeMergeCandidates` step
// archives the losers. When LLM passes ship, they'll consume the same
// list BEFORE finalize to optionally rewrite the keeper body. No design
// rework needed when that lands.
//
// Determinism contract: with `now` injected (frozen-clock tests) and the
// same wiki state, two runs produce byte-identical post-state across the
// deterministic passes. LLM passes (Phase 3) hit the same contract via
// the mock-LLM plumbing.
//
// The pass implementations live in sibling modules:
//   - consolidate-constants.mjs      — pass names + atom-type Sets
//   - consolidate-time.mjs           — clock helpers (injectable `now`)
//   - consolidate-report.mjs         — per-pass report + state + selection
//   - consolidate-dedup-passes.mjs   — deterministic dedup (2B/2C/2D) + finalize
//   - consolidate-llm-merge.mjs      — 3A LLM merge-near-duplicates
//   - consolidate-llm-refresh.mjs    — 3B LLM semantic-refresh
//   - consolidate-corpus-passes.mjs  — 2E/2F/2G corpus content passes
//   - consolidate-structural-passes.mjs — 2H structural cleanup passes
//   - consolidate-run.mjs            — the Phase-2/3 per-leaf + corpus run loop

import { COMPILE_LOCK_PATH } from "./lib/env.mjs";
import {
  consolidateEnabled,
  consolidateIntervalDays,
  consolidateCosineThreshold,
  consolidateCosineLexicalThreshold,
  consolidateCosineBandFloor,
  consolidateLlmPassesEnabled,
  compileLockStaleMs,
} from "./lib/settings.mjs";
import { acquireLock, installLockReleaseHandlers } from "./lib/lock.mjs";
import { withSystemMaintenance } from "./lib/maintenance-tag.mjs";
import { withWikiCommit } from "./lib/wiki-commit.mjs";
import { activeBackend } from "./lib/embed.mjs";
import { getConsolidateLayout } from "./lib/wiki-store.mjs";
import { health as llmHealth } from "./lib/llm.mjs";

import { ALL_PASS_NAMES } from "./consolidate-constants.mjs";
import { toIso, nowMs, ageInDays, ageInMonths } from "./consolidate-time.mjs";
import {
  emptyPassReport,
  sortPassEntities,
  stripPassEntities,
  resolveAllowedPasses,
  readState,
  writeState,
} from "./consolidate-report.mjs";
import { pickKeeper, lessonKey } from "./consolidate-dedup-passes.mjs";
import { runConsolidate } from "./consolidate-run.mjs";

/** @typedef {import("./consolidate-time.mjs").NowInput} NowInput */

/**
 * Options accepted by the consolidate entry point (all optional; cron / CLI /
 * MCP each supply a subset).
 * @typedef {Object} ConsolidateOptions
 * @property {boolean} [dryRun]
 * @property {boolean} [ifDue]
 * @property {boolean} [force]
 * @property {boolean} [llm]
 * @property {string | string[] | null} [passes]
 * @property {NowInput} [now]
 */

// The set of categories the consolidate orchestrator walks is now declared
// EXPLICITLY in the layout YAML (per-category `consolidate: refine|none`).
// No defaults — every category must say which side it's on. The orchestrator
// reads the layout at run start and refuses to proceed if any category lacks
// the field. See getConsolidateLayout() in wiki-store.mjs.

// ─── entry point ───────────────────────────────────────────────────────────

/**
 * @param {ConsolidateOptions} [options]
 */
export async function consolidateMemory({
  dryRun = false,
  ifDue = false,
  force = false,
  llm = true,
  passes,
  now,
} = {}) {
  // Master switch (settings.consolidate.enabled, default false). When off,
  // consolidation is a no-op in EVERY path — cron, CLI, MCP tool, skill — and
  // `force` does NOT override it: flip the flag to run. Off by design so the
  // engine never reconciles memory unless the operator opts in.
  if (!consolidateEnabled()) {
    return { ok: true, skipped: "disabled", llmRequested: false, llm: false };
  }
  const startMs = Date.now();
  const allowed = resolveAllowedPasses(passes);

  // Resolve the LLM-requested flag up front so every return path can report
  // it consistently (success + skip). The actual ctx.llmEnabled (post-probe)
  // is set later, inside the maintenance frame.
  const llmRequested = consolidateLlmPassesEnabled() && llm !== false;

  // Layout must declare per-category eligibility. If any category lacks
  // `consolidate: refine|none`, refuse to run — author intent must be
  // explicit. The error envelope carries the missing category names so an
  // operator can fix the layout YAML and re-run.
  const layout = getConsolidateLayout();
  if (layout.missing.length > 0) {
    return {
      ok: false,
      error: "layout-missing-consolidate-field",
      message:
        "Each category in <wiki>/.layout/layout.yaml must declare `consolidate: refine` or `consolidate: none` — no default is applied. " +
        "Missing categories: " +
        layout.missing.join(", "),
      missing: layout.missing,
      llmRequested,
      llm: false,
    };
  }

  // Throttle. `ifDue` + last_run within the cadence => skip immediately.
  if (ifDue && !force) {
    const cadenceDays = consolidateIntervalDays();
    if (cadenceDays > 0) {
      const state = readState();
      const last = state?.last_run_utc ? Date.parse(state.last_run_utc) : 0;
      if (Number.isFinite(last) && last > 0) {
        const ageDays = (nowMs(now) - last) / (1000 * 60 * 60 * 24);
        if (ageDays < cadenceDays) {
          return {
            ok: true,
            skipped: "not-due",
            lastRunUtc: /** @type {{ last_run_utc?: string }} */ (state).last_run_utc,
            cadenceDays,
            ageDays,
            llmRequested,
            llm: false,
          };
        }
      }
    }
  }

  // Lock. Share the compile lock so consolidate never races with compile and
  // both fit one shared LLM-API quota window.
  // Pass the SAME staleMs source compile.mjs uses: both contend on
  // COMPILE_LOCK_PATH, so a shared lock must have one authoritative TTL —
  // otherwise an operator who lowers compile.lockStaleMs leaves the two
  // processes disagreeing on when the lock is stale.
  const lock = acquireLock(COMPILE_LOCK_PATH, {
    staleMs: compileLockStaleMs(),
    label: "consolidate",
  });
  if (!lock.ok) {
    return {
      ok: false,
      skipped: "locked-by",
      reason: lock.reason,
      owner: lock.owner,
      llmRequested,
      llm: false,
    };
  }
  // Wire SIGTERM/SIGINT/SIGHUP/exit to release the lock so a killed cron
  // (or an MCP-server shutdown mid-run) doesn't leave it stale for 30 min.
  // installLockReleaseHandlers is idempotent across calls (compile.mjs may
  // have wired the same path); the lock module dedupes via its own set.
  installLockReleaseHandlers(COMPILE_LOCK_PATH);

  try {
    // One consolidate run = one wiki commit (dedup archives, merges,
    // refreshes, stale stamps). Nested INSIDE the maintenance frame's caller
    // so dry-run records nothing and commits nothing.
    return await withWikiCommit(
      { op: "consolidate", actor: "consolidate", noCommit: Boolean(dryRun) },
      () =>
        withSystemMaintenance(async () => {
          const backend = activeBackend();
          const lexical = backend === "lexical";
          const cosineThreshold = lexical
            ? consolidateCosineLexicalThreshold()
            : consolidateCosineThreshold();
          // One-shot warning per run (moved out of the per-leaf cosine pass —
          // see review finding D-1: the per-leaf shallow-copied subCtx made
          // the previous in-pass flag fire on every leaf).
          if (lexical) {
            process.stderr.write(
              "[consolidate] embedding backend is lexical; cosine dedup threshold " +
                `auto-bumped to ${cosineThreshold} (real bge cosine inflates on the lexical fallback).\n`,
            );
          }
          // Band floor re-clamped against the ACTIVE threshold: the lexical
          // backend bumps the threshold to 0.995, and a floor that is no longer
          // strictly below it must disable the band (fail-safe OFF).
          const bandFloorRaw = consolidateCosineBandFloor();
          const cosineBandFloor =
            bandFloorRaw != null && bandFloorRaw >= 0.8 && bandFloorRaw < cosineThreshold
              ? bandFloorRaw
              : null;
          const ctx = {
            report: new Map(ALL_PASS_NAMES.map((n) => [n, emptyPassReport(n)])),
            touchedThisRun: new Set(),
            pairsSeen: new Set(),
            mergeCandidates: [], // accumulated across all leaves; finalized per leaf
            activeBackend: backend,
            cosineThreshold,
            cosineBandFloor,
            llmEnabled: false,
            refineCategories: layout.refine,
            excludedCategories: layout.excluded,
          };

          // Probe the LLM provider ONCE at the top of the run. If unreachable,
          // disable LLM passes for this run and log a single line — every
          // per-call probe would otherwise spam logs. `llmRequested` was
          // computed in the outer scope and is in closure here.
          if (llmRequested) {
            try {
              const h = await llmHealth();
              if (h?.available === true) {
                ctx.llmEnabled = true;
              } else {
                process.stderr.write(
                  `[consolidate] event=llm-provider-unavailable provider=${h?.provider} reason="${h?.reason || ""}" — LLM passes skipped this run\n`,
                );
              }
            } catch (err) {
              process.stderr.write(
                `[consolidate] event=llm-provider-unavailable reason="probe-threw: ${/** @type {Error} */ (err)?.message || err}" — LLM passes skipped this run\n`,
              );
            }
          }

          const summary = await runConsolidate({ allowed, dryRun, now, ctx });
          sortPassEntities(ctx.report);

          const stateOut = {
            last_run_utc: toIso(now),
            durationMs: Date.now() - startMs,
            dryRun: Boolean(dryRun),
            // Counts only: the per-entity arrays travel via the returned report
            // (and the sharded full cron log), never the slim state file.
            passes: stripPassEntities(Object.fromEntries(ctx.report)),
            totals: summary.totals,
          };
          if (!dryRun) writeState(stateOut);
          return {
            ok: true,
            dryRun: Boolean(dryRun),
            llm: ctx.llmEnabled,
            llmRequested,
            ...summary,
            stateOut,
          };
        }),
    );
  } finally {
    try {
      lock.release && lock.release();
    } catch {
      /* best-effort */
    }
  }
}

// Exported helpers for tests.
export const _internals = {
  ALL_PASS_NAMES,
  resolveAllowedPasses,
  pickKeeper,
  lessonKey,
  ageInDays,
  ageInMonths,
  readState,
  writeState,
};
