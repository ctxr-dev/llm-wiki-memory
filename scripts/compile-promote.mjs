import { DRY_RUN, EX_UNAVAILABLE } from "./compile-flags.mjs";
import { compileQualityStrict, compileMetadataRetryLimit } from "./lib/settings.mjs";
import {
  readDocument,
  disableDocument,
  WikiStoreUnavailable as DifyBridgeUnavailable,
} from "./lib/wiki-store.mjs";
import { LLMProviderUnavailable, LLMOutputInvalid } from "./lib/llm.mjs";
import { parseAtomsFromMarkdown, scoreAtomQuality } from "./compile-atoms.mjs";
import { targetDatasetForAtom } from "./compile-routing.mjs";
import { dedupCandidates } from "./compile-dedup.mjs";
import { decideAction, executeAction, applyMetadataToWritten } from "./compile-actions.mjs";
import { appendCompileLog, writeState } from "./compile-state.mjs";

/** @typedef {import("./lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./lib/types.mjs").DocumentSummary} DocumentSummary */
/** @typedef {import("./compile-state.mjs").CompileState} CompileState */
/** @typedef {import("./compile-state.mjs").CompileCounts} CompileCounts */

// Compile knobs — sourced from settings.yaml via settings.mjs accessors.
// Wrapped as zero-arg getters so test-seam overrides take effect mid-process.
const METADATA_RETRY_LIMIT = () => compileMetadataRetryLimit();
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
async function processAtom({ atom, daily, systemPrompt, warnedSchemaMissing, counts, state }) {
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
  try {
    const candidates = await dedupCandidates(atom, targetDataset);
    const decision = await decideAction(atom, candidates, systemPrompt);
    if (!decision || typeof decision !== "object" || !decision.action) {
      throw new LLMOutputInvalid("compile decision missing 'action'", JSON.stringify(decision));
    }
    const result = await executeAction(atom, decision, candidates, targetDataset);
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

    appendCompileLog({
      event: "atom",
      source: daily.name,
      target: targetDataset,
      atomTitle: atom.title,
      action: decision.action,
      supersedes: decision.supersedes,
      dryRun: DRY_RUN,
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
    if (err instanceof DifyBridgeUnavailable || err instanceof LLMProviderUnavailable) {
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

// Promote one daily doc: read it, parse atoms, promote each, then disable the
// daily on full success or bump its bounded retry counter on failure. Returns
// true when the daily was promoted (disabled after a clean run).
/**
 * @param {Object} args
 * @param {DocumentSummary} args.daily
 * @param {string} args.dailyDataset
 * @param {string} args.systemPrompt
 * @param {CompileState} args.state
 * @param {CompileCounts} args.counts
 * @param {Set<string>} args.warnedSchemaMissing
 * @returns {Promise<boolean>}
 */
export async function processDaily({
  daily,
  dailyDataset,
  systemPrompt,
  state,
  counts,
  warnedSchemaMissing,
}) {
  let docText;
  try {
    const r = await readDocument({ documentId: daily.id, datasetId: dailyDataset });
    docText = r?.text || "";
  } catch (err) {
    counts.error += 1;
    appendCompileLog({
      event: "read-error",
      document: daily.name,
      error: /** @type {{ message?: string }} */ (err).message || String(err),
    });
    if (err instanceof DifyBridgeUnavailable) {
      console.error(`compile.mjs: aborting, bridge gone: ${err.message}`);
      process.exit(0);
    }
    return false;
  }

  const atoms = parseAtomsFromMarkdown(docText);
  if (atoms.length === 0) {
    if (!DRY_RUN) {
      try {
        await disableDocument({ documentId: daily.id, datasetId: dailyDataset });
        appendCompileLog({ event: "disable-empty", document: daily.name });
      } catch (err) {
        counts.error += 1;
        appendCompileLog({
          event: "disable-error",
          document: daily.name,
          error: /** @type {{ message?: string }} */ (err).message || String(err),
        });
      }
    }
    return false;
  }

  let allOk = true;
  for (const atom of atoms) {
    const atomOk = await processAtom({
      atom,
      daily,
      systemPrompt,
      warnedSchemaMissing,
      counts,
      state,
    });
    if (!atomOk) allOk = false;
  }

  let promoted = false;
  if (allOk && !DRY_RUN) {
    try {
      await disableDocument({ documentId: daily.id, datasetId: dailyDataset });
      appendCompileLog({ event: "disable", document: daily.name });
      promoted = true;
      // Clear any retry counter for this daily on success.
      if (state.metadata_retry?.[daily.id]) {
        delete state.metadata_retry[daily.id];
      }
    } catch (err) {
      counts.error += 1;
      appendCompileLog({
        event: "disable-error",
        document: daily.name,
        error: /** @type {{ message?: string }} */ (err).message || String(err),
      });
    }
  } else if (!allOk && !DRY_RUN) {
    // Bounded retry for metadata-write failures: after N attempts, give
    // up and disable the daily anyway so we don't accumulate duplicate
    // knowledge-* docs forever. Atom-level errors (LLM, network) get
    // the same cap because we can't tell them apart at this layer.
    const attempts = (state.metadata_retry?.[daily.id] || 0) + 1;
    state.metadata_retry = state.metadata_retry || {};
    state.metadata_retry[daily.id] = attempts;
    if (attempts >= METADATA_RETRY_LIMIT()) {
      try {
        await disableDocument({ documentId: daily.id, datasetId: dailyDataset });
        appendCompileLog({
          event: "give-up-disable",
          document: daily.name,
          attempts,
          reason: `${attempts} consecutive failed attempts; disabling daily to avoid duplicate-create loop`,
        });
        delete state.metadata_retry[daily.id];
      } catch (err) {
        appendCompileLog({
          event: "give-up-disable-error",
          document: daily.name,
          error: /** @type {{ message?: string }} */ (err).message || String(err),
        });
      }
    } else {
      appendCompileLog({
        event: "kept-enabled",
        document: daily.name,
        reason: `atom errors; will retry next compile (attempt ${attempts}/${METADATA_RETRY_LIMIT()})`,
        attempts,
      });
    }
  }

  // Persist state per-daily so a crash mid-loop doesn't lose retry
  // counters. Without this, a process.exit(0) on bridge/LLM unavailable
  // (lines above) would never let the retry cap kick in.
  try {
    writeState(state);
  } catch (err) {
    console.error(
      `compile.mjs: state write failed (continuing): ${err instanceof Error ? err.message : err}`,
    );
  }

  return promoted;
}
