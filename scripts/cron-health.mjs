import { consolidateEnabled } from "./lib/settings.mjs";
import { collapse, attemptsKeepSafe } from "./cron-shared.mjs";
import { readAttempts } from "./cron-attempts.mjs";
import { openEscalationsFromIndex } from "./cron-issues-index.mjs";

/** @typedef {import("./cron-attempts.mjs").SlimAttemptEntry} SlimAttemptEntry */

// ─── health ───────────────────────────────────────────────────────────────

// Inspect the attempt log + open escalations to decide whether the cron
// pipeline is healthy. Two-tier output:
//   - `summary` (≤200 chars) is a single-line deterministic signal safe to
//     embed in SessionStart's additionalContext. NO JSON, NO stderr dump.
//   - `lastAttempt` / `recent` / `escalations` carry the detail for callers
//     that explicitly want it (the CLI prints them; the hook does NOT).
//
// Unhealthy ⟺ the most-recent attempt errored with no later success, OR at
// least one escalation episode is still open (entity-level: the same entity
// kept failing across runs, or one signature spans many entities). A failure
// that later resolved stays silent.
export function cronHealth({ limit = 20 } = {}) {
  if (!consolidateEnabled()) {
    const escalations = openEscalationsFromIndex();
    return {
      ok: true,
      healthy: true,
      disabled: true,
      summary: `consolidation disabled (consolidate.enabled=false)${
        escalations.length ? `; ${escalations.length} open escalation(s) preserved` : ""
      }`.slice(0, 200),
      lastAttempt: null,
      escalations,
    };
  }
  const all = readAttempts({ limit: Math.max(attemptsKeepSafe(), 200) });
  const escalations = openEscalationsFromIndex();
  const lastAttempt = all.length ? all[all.length - 1] : null;

  if (!lastAttempt && escalations.length === 0) {
    return {
      ok: true,
      healthy: true,
      summary: "no cron-job attempts logged yet (system fresh or cron not yet scheduled)",
      lastAttempt: null,
      escalations,
    };
  }

  const shortError = collapse(lastAttempt?.error || "<no detail>").slice(0, 120);

  if (escalations.length > 0) {
    const newest = escalations.reduce((a, b) => ((a.sinceTs || "") >= (b.sinceTs || "") ? a : b));
    const where = newest.unrendered
      ? `report write FAILED (signature ${newest.signature}; see cron stderr)`
      : `newest report ${newest.issuePath}`;
    return {
      ok: true,
      healthy: false,
      summary: `UNRESOLVED: ${escalations.length} open consolidation escalation(s); ${where}`.slice(
        0,
        200,
      ),
      lastAttempt,
      escalations,
    };
  }

  const attempt = /** @type {SlimAttemptEntry} */ (lastAttempt);
  if (attempt.ok === false) {
    return {
      ok: true,
      healthy: false,
      summary: `UNRESOLVED FAILURE at ${attempt.ts}: ${shortError}`,
      lastAttempt,
      escalations,
    };
  }

  let lastFailureAt = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].ok === false) {
      lastFailureAt = all[i].ts;
      break;
    }
  }
  return {
    ok: true,
    healthy: true,
    summary: `healthy; last cron-job ok at ${attempt.ts}`,
    lastAttempt,
    lastSuccessAt: attempt.ts,
    ...(lastFailureAt ? { lastFailureAt } : {}),
    recent: all.slice(-limit),
    escalations,
  };
}
