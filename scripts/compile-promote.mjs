import { DRY_RUN } from "./compile-flags.mjs";
import { compileMetadataRetryLimit } from "./lib/settings.mjs";
import { readDocument, disableDocument, WikiStoreUnavailable } from "./lib/wiki-store.mjs";
import { parseAtomsFromMarkdown } from "./compile-atoms.mjs";
import { appendCompileLog, writeState } from "./compile-state.mjs";
import { processAtom } from "./compile-atom.mjs";

/** @typedef {import("./lib/types.mjs").DocumentSummary} DocumentSummary */
/** @typedef {import("./compile-state.mjs").CompileState} CompileState */
/** @typedef {import("./compile-state.mjs").CompileCounts} CompileCounts */

// Compile knob — sourced from settings.yaml via a settings.mjs accessor.
// Wrapped as a zero-arg getter so a test-seam override takes effect mid-process.
const METADATA_RETRY_LIMIT = () => compileMetadataRetryLimit();

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
    if (err instanceof WikiStoreUnavailable) {
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
