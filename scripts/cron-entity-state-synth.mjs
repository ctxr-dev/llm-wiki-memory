import { collapse } from "./cron-shared.mjs";

/** @typedef {import("./cron-entity-state.mjs").PassResult} PassResult */
/** @typedef {import("./cron-entity-state.mjs").ConsolidateReport} ConsolidateReport */

// compile.mjs exits 69 (BSD EX_UNAVAILABLE) when daily docs are pending but
// no LLM/bridge provider is reachable. The tick still runs consolidate (its
// deterministic passes don't need a provider), but counts as a FAILED
// attempt and feeds the synthetic escalation entity below.
export const EX_UNAVAILABLE = 69;
// Synthetic self-healing entities for provider availability. They ride the
// SAME updateEntityState/evaluateEscalations/writeIssueReports machinery as
// dedup-pair/leaf entities: consecutive provider-unavailable ticks escalate
// into an issue report after consolidate.escalateAfterAttempts, and the
// first healthy tick records a success that resolves the episode.
const SYNTH_COMPILE_ENTITY = "system:compile-llm-providers";
const SYNTH_CONSOLIDATE_ENTITY = "system:consolidate-llm-providers";
const SYNTH_COMPILE_PASS = "compile-promote";
const SYNTH_CONSOLIDATE_PASS = "consolidate-llm";

// Fold provider availability into synthetic entity passes. Pure: returns a
// passes map shaped exactly like a consolidate report's `passes`, so
// updateEntityState consumes it unchanged.
//   - compile exit 69  -> compile-promote failure (excerpt = the redacted
//     abort line, so ENOENT vs timeout vs auth produce DIFFERENT signatures
//     and therefore different episodes — they are different root causes
//     with different operator fixes);
//   - compile ok       -> compile-promote success (resolves the episode);
//   - real consolidate report with llmRequested && !llm -> consolidate-llm
//     failure (LLM passes silently skipped); llmRequested && llm -> success.
// A skipped/dry-run consolidate — or one with llmRequested=false (--no-llm)
// — contributes nothing: its LLM half was never supposed to run, so there
// is no signal either way (recording success there would wrongly resolve
// an open episode without any provider attempt).
/**
 * @param {{ compileExit?: number | null, compileOk?: boolean | null, compileError?: string, report?: ConsolidateReport | null }} [args]
 * @returns {Record<string, PassResult>}
 */
export function synthesizeProviderEntities({
  compileExit = null,
  compileOk = null,
  compileError = "",
  report = null,
} = {}) {
  /** @type {Record<string, PassResult>} */
  const passes = {};
  if (compileExit === EX_UNAVAILABLE) {
    // Tail-first excerpt: the chain error reads "...exhausted (<providers>);
    // last: <the actual cause>". normalizeErrorSignature slugs only the
    // first 80 chars, and the shared prefix is longer than that — without
    // the reorder, ENOENT and timeout aborts would collapse into ONE
    // episode despite needing different operator fixes.
    const raw = collapse(compileError) || `compile providers unavailable (exit ${EX_UNAVAILABLE})`;
    const lastIdx = raw.indexOf("; last: ");
    const excerpt =
      lastIdx >= 0 ? `${raw.slice(lastIdx + "; last: ".length)} <= ${raw.slice(0, lastIdx)}` : raw;
    passes[SYNTH_COMPILE_PASS] = {
      name: SYNTH_COMPILE_PASS,
      entities: [],
      failures: [
        {
          id: SYNTH_COMPILE_ENTITY,
          kind: "system-provider",
          action: "promote",
          ok: false,
          excerpt,
        },
      ],
    };
  } else if (compileOk === true) {
    passes[SYNTH_COMPILE_PASS] = {
      name: SYNTH_COMPILE_PASS,
      entities: [
        { id: SYNTH_COMPILE_ENTITY, kind: "system-provider", action: "promote", ok: true },
      ],
      failures: [],
    };
  }
  const realConsolidate = Boolean(report && !report.skipped && !report.dryRun);
  if (realConsolidate && report?.llmRequested === true) {
    const llmSkipped = report?.llm === false;
    passes[SYNTH_CONSOLIDATE_PASS] = llmSkipped
      ? {
          name: SYNTH_CONSOLIDATE_PASS,
          entities: [],
          failures: [
            {
              id: SYNTH_CONSOLIDATE_ENTITY,
              kind: "system-provider",
              action: "llm-pass",
              ok: false,
              excerpt:
                "consolidate: LLM passes skipped (provider unavailable) llmRequested=true llm=false",
            },
          ],
        }
      : {
          name: SYNTH_CONSOLIDATE_PASS,
          entities: [
            { id: SYNTH_CONSOLIDATE_ENTITY, kind: "system-provider", action: "llm-pass", ok: true },
          ],
          failures: [],
        };
  }
  return passes;
}
