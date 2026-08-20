import { DRY_RUN, EX_UNAVAILABLE } from "./compile-flags.mjs";
import { compileQualityStrict } from "./lib/settings.mjs";
import { isAutoDistillCategory, WikiStoreUnavailable } from "./lib/wiki-store.mjs";
import { LLMProviderUnavailable, LLMOutputInvalid } from "./lib/llm.mjs";
import { scoreAtomQuality } from "./compile-atoms.mjs";
import { targetDatasetForAtom } from "./compile-routing.mjs";
import { dedupCandidates } from "./compile-dedup.mjs";
import { decideActionJudged, executeAction, applyMetadataToWritten } from "./compile-actions.mjs";
import { appendCompileLog, writeState } from "./compile-state.mjs";

/** @typedef {import("./lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./lib/types.mjs").DocumentSummary} DocumentSummary */
/** @typedef {import("./compile-state.mjs").CompileState} CompileState */
/** @typedef {import("./compile-state.mjs").CompileCounts} CompileCounts */

// In strict mode (settings.compile.qualityStrict) atoms failing the heuristic
// checks are dropped before any LLM round-trip. Wrapped as a zero-arg getter so
// a test-seam override takes effect mid-process.
const QUALITY_STRICT = () => compileQualityStrict();

// Promote a single atom into its target dataset. Returns true when the atom
// resolved cleanly (or was intentionally skipped) and false when it failed in
// a way that must keep the source daily enabled for a later retry. A
// bridge/LLM-unavailable failure persists state and exits the process here;
// it never returns.
/**
 * @param {Object} args
 * @param {DistilledAtom} args.atom
 * @param {DocumentSummary} args.daily
 * @param {string} args.systemPrompt
 * @param {Set<string>} args.warnedSchemaMissing
 * @param {CompileCounts} args.counts
 * @param {CompileState} args.state
 * @returns {Promise<boolean>}
 */
export async function processAtom({
  atom,
  daily,
  systemPrompt,
  warnedSchemaMissing,
  counts,
  state,
}) {
  // Defence in depth: `plan` is in ATOM_TYPES so the schema-level
  // routing table accepts it, but plans are produced exclusively by
  // the ExitPlanMode hook (upsert-by-name into the `plans` slot).
  // flush.mjs already drops `type:plan` atoms before write, but a
  // hand-edited daily could still slip one through and produce a
  // `knowledge-*.md`-named doc inside the plans slot. Drop it here
  // too so promotion can never leak.
  if (atom.type === "plan") {
    console.error(
      `compile.mjs: dropping atom with type='plan' (source='${daily.name}', title='${String(atom.title).slice(0, 40)}'); plans are written only by the ExitPlanMode hook`,
    );
    appendCompileLog({ event: "atom-skip-plan", source: daily.name, atomTitle: atom.title });
    return true;
  }
  // Quality rubric: in strict mode (settings.compile.qualityStrict)
  // atoms failing the heuristic checks are dropped before any LLM
  // round-trip. In lax mode (default) we still surface the verdict in
  // the compile log so the user can decide whether to tighten the
  // signal-density floor. The rubric is intentionally conservative:
  // false negatives here are atoms that should never have been kept.
  const quality = scoreAtomQuality(atom);
  if (!quality.ok) {
    if (QUALITY_STRICT()) {
      console.error(
        `compile.mjs: dropping low-quality atom (source='${daily.name}', title='${String(atom.title).slice(0, 40)}'): ${quality.reasons.join("; ")}`,
      );
      appendCompileLog({
        event: "atom-skip-low-quality",
        source: daily.name,
        atomTitle: atom.title,
        reasons: quality.reasons,
        strict: true,
      });
      return true;
    }
    appendCompileLog({
      event: "atom-low-quality-warn",
      source: daily.name,
      atomTitle: atom.title,
      reasons: quality.reasons,
    });
  }
  const targetDataset = targetDatasetForAtom(atom);
  // auto_distill opt-out: a wiki may set `auto_distill: false` on a category in
  // its layout to keep that category HUMAN-ONLY. Skip promoting into it — a clean
  // skip (return true) so the source daily is disabled without a retry loop,
  // mirroring the `type:plan` drop above. Default is true (compile promotes).
  if (!isAutoDistillCategory(targetDataset)) {
    appendCompileLog({
      event: "atom-skip-no-autodistill",
      source: daily.name,
      target: targetDataset,
      atomTitle: atom.title,
    });
    return true;
  }
  try {
    const candidates = await dedupCandidates(atom, targetDataset);
    // Judge-in-the-loop: regenerate the decision until the would-be leaf passes
    // the quality judge, or keep the best after quality.maxRounds (flagged
    // unverified). A judge/provider outage throws LLMProviderUnavailable, caught
    // below (daily kept enabled for a retry — no unjudged leaf lands).
    const { decision, flagged } = await decideActionJudged(
      atom,
      candidates,
      systemPrompt,
      targetDataset,
    );
    if (!decision || typeof decision !== "object" || !decision.action) {
      throw new LLMOutputInvalid("compile decision missing 'action'", JSON.stringify(decision));
    }
    const result = await executeAction(atom, decision, candidates, targetDataset, { flagged });
    counts[decision.action] = (counts[decision.action] || 0) + 1;

    let metadataResult;
    if (decision.action === "create" || decision.action === "update") {
      metadataResult = await applyMetadataToWritten(atom, result, targetDataset);
    }

    // Metadata-write failure is non-fatal for the doc itself but the
    // doc is now un-filterable. Mark the daily kept-enabled so a later
    // compile retries the metadata write. A `warning` (e.g. "no
    // fields matched") still counts as ok=true so it does NOT trip the
    // retry cap (config issue, not transient).
    const metadataFailed = metadataResult && metadataResult.ok !== true;
    const metadataWarning = metadataResult && metadataResult.ok === true && metadataResult.warning;

    if (metadataWarning && !warnedSchemaMissing.has(targetDataset)) {
      warnedSchemaMissing.add(targetDataset);
      console.error(
        `compile.mjs: WARNING: metadata write failed on slot '${targetDataset}'. Promoted docs may be un-filterable.`,
      );
    }

    // Explicit 3-state log: "ok" (clean write), "warning" (schema missing
    // on dataset; doc is un-filterable but no retry - config issue),
    // "failed" (transient/bridge error; daily kept enabled for retry).
    // undefined when no metadata was attempted (no fields to write).
    let metadataApplied;
    if (!metadataResult) metadataApplied = undefined;
    else if (metadataResult.ok === true && !metadataResult.warning) metadataApplied = "ok";
    else if (metadataResult.ok === true && metadataResult.warning) metadataApplied = "warning";
    else metadataApplied = "failed";

    if (flagged) {
      console.error(
        `compile.mjs: quality judge did not pass after max rounds; kept best attempt flagged unverified (source='${daily.name}', title='${String(atom.title).slice(0, 40)}')`,
      );
    }
    appendCompileLog({
      event: "atom",
      source: daily.name,
      target: targetDataset,
      atomTitle: atom.title,
      action: decision.action,
      supersedes: decision.supersedes,
      dryRun: DRY_RUN,
      qualityFlagged: flagged || undefined,
      metadataApplied,
      metadataWarning: metadataWarning || undefined,
      metadataError: metadataResult?.error || metadataResult?.reason,
    });
    if (!DRY_RUN && result?.ok === false) throw new Error(JSON.stringify(result));
    if (metadataFailed) return false;
    return true;
  } catch (err) {
    counts.error += 1;
    appendCompileLog({
      event: "atom-error",
      source: daily.name,
      target: targetDataset,
      atomTitle: atom.title,
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof WikiStoreUnavailable || err instanceof LLMProviderUnavailable) {
      // Persist any in-memory state mutations (action counts, prior
      // dailies' retry counters) before exiting so the next compile
      // run sees the latest state.
      try {
        writeState(state);
      } catch {
        /* swallow - state write best-effort */
      }
      console.error(`compile.mjs: aborting (${err.constructor.name}): ${err.message}`);
      process.exit(EX_UNAVAILABLE);
    }
    return false;
  }
}
