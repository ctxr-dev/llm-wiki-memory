import fs from "node:fs";
import { dailyDocName } from "../lib/slug.mjs";
import { acquireLock, installLockReleaseHandlers } from "../lib/lock.mjs";
import { withWikiCommit } from "../lib/wiki-commit.mjs";
import { flushLockStaleMs } from "../lib/settings.mjs";
import { wikiRoot } from "../lib/env.mjs";
import { withBrainContextSafe } from "../lib/wiki-context.mjs";
import { logBreadcrumb, shortId, ensureStateDir } from "./flush-state.mjs";
import {
  flushLockPath,
  cleanupContext,
  writeFailedDistillStash,
  preserveFailedOutcome,
} from "./flush-stash.mjs";
import { distillByChunks } from "./flush-distill.mjs";
import { renderDailyDocument, renderRawFallback, renderErrorMarker } from "./flush-render.mjs";
import { writeFlushDoc, wikiInitialised } from "./flush-write.mjs";
import { WikiStoreUnavailable } from "../lib/wiki-store.mjs";

/** @typedef {import("./flush-source.mjs").SourceMaterial} SourceMaterial */
/** @typedef {import("./flush-distill.mjs").DistillError} DistillError */

// Phase 2: worker (background, decoupled from the hook timeout)

/**
 * @param {string} ctxFile
 * @param {string} sessionId
 * @param {string} mode
 */
export async function runWorker(ctxFile, sessionId, mode) {
  const tag = `worker ${mode} session ${shortId(sessionId)}`;

  // Atomic dedup: take a per-session lock so that of two workers spawned
  // back-to-back for the same session (pre-compact + post-compact), exactly one
  // proceeds and the other skips. lock.mjs uses an atomic openSync('wx') claim
  // with stale-owner reclaim, which a read-then-write timestamp file could not
  // guarantee. The lock is held for the whole distil+write and released in
  // `finally` (and on signals), so a failed worker frees it for a later retry
  // and a crashed worker's lock is reclaimed after the stale TTL.
  ensureStateDir();
  const lockPath = flushLockPath(sessionId);
  const lock = acquireLock(lockPath, { staleMs: flushLockStaleMs(), label: "flush" });
  if (!lock.ok) {
    logBreadcrumb(`${tag}: dedup skip (session lock held: ${lock.reason})`);
    cleanupContext(ctxFile);
    return;
  }
  // Install release handlers only after we actually own the lock, so a worker
  // that lost the dedup race never registers a handler that could unlink the
  // winner's lock (releaseLock matches by pid, which is unsafe under pid reuse).
  installLockReleaseHandlers(lockPath);
  try {
    // Scope the daily-leaf write to the brain wiki (brain-only context). The
    // per-session lock + release live outside the frame (state-dir paths, not
    // wiki-tree-scoped). Behavior-neutral in the single-tree case; a resolve
    // failure falls through so flushSession's own "wiki not initialised" skip
    // still fires and the worker keeps its best-effort contract.
    await withBrainContextSafe(() =>
      withWikiCommit(
        {
          op: "flush",
          actor: "flush-worker",
          summary: `session capture ${shortId(sessionId)} (${mode})`,
        },
        () => flushSession({ ctxFile, sessionId, mode, tag }),
      ),
    );
  } finally {
    /** @type {() => void} */ (lock.release)();
  }
}

/**
 * @param {{ ctxFile: string, sessionId: string, mode: string, tag: string }} args
 */
async function flushSession({ ctxFile, sessionId, mode, tag }) {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(ctxFile, "utf8"));
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : String(err);
    logBreadcrumb(`${tag}: context unreadable (${reason})`);
    // Always record: surface this in the store too (not only the breadcrumb)
    // when the wiki is initialised.
    if (wikiInitialised()) {
      try {
        await writeFlushDoc(dailyDocName(), renderErrorMarker({ sessionId, mode, reason }));
      } catch (markerErr) {
        logBreadcrumb(
          `${tag}: could not record context-unreadable marker (${markerErr instanceof Error ? markerErr.message : String(markerErr)})`,
        );
      }
    }
    cleanupContext(ctxFile);
    return;
  }

  if (!wikiInitialised()) {
    // Nowhere to save, so do not spend an LLM call. Loud (logged), not silent.
    // The per-session lock releases in runWorker's finally, so a retry after the
    // user runs bootstrap (within the dedup window) is not skipped.
    logBreadcrumb(`${tag}: wiki not initialised at ${wikiRoot()}; nothing saved`);
    cleanupContext(ctxFile);
    return;
  }

  // Decide WHAT to persist. The distiller never blocks the user (it runs here,
  // in the background); a failure becomes a raw-context fallback PLUS a
  // stash record so `cli.mjs redistill` can re-attempt later with no loss.
  // A clean "nothing durable" verdict (zero atoms, no chunk failures) writes
  // NOTHING — leaves are an audit artifact for content worth saving, not a
  // log of every distiller run; the breadcrumb in state/.flush.log keeps
  // visibility for "the worker ran and produced nothing".
  let text = null;
  let outcome;
  try {
    const { atoms, audit, failedChunks = [] } = await distillByChunks(source, tag);
    if (atoms.length > 0) {
      text = renderDailyDocument({ atoms, source, audit, failedChunks });
      outcome = audit.failed_chunks?.length
        ? `wrote ${atoms.length} atom(s) with ${audit.failed_chunks.length} failed chunk(s)`
        : `wrote ${atoms.length} atom(s)`;
      if (audit.failed_chunks?.length) {
        const stashed = writeFailedDistillStash({
          source,
          errors: audit.failure_reasons,
          sessionId,
          audit,
        });
        if (stashed) logBreadcrumb(`${tag}: partial-failure stash at ${stashed}`);
      }
    } else if (audit.failed_chunks?.length) {
      // Zero atoms BUT some chunks failed: the distiller cleanly said
      // "nothing durable" on the surviving chunks, but the failed chunks
      // carry recoverable content that would otherwise be lost. Stash the
      // source so `cli.mjs redistill` can re-attempt the whole session
      // later. No leaf is written (clean verdict on what survived) — the
      // breadcrumb names the stash so the operator can find it.
      const stashed = writeFailedDistillStash({
        source,
        errors: audit.failure_reasons,
        sessionId,
        audit,
      });
      outcome = stashed
        ? `nothing-durable on survivors + ${audit.failed_chunks.length} failed chunk(s) stashed at ${stashed}`
        : `nothing-durable on survivors + ${audit.failed_chunks.length} failed chunk(s) (stash write ALSO failed: the failed chunks' context is LOST; see the stash error above in flush.log)`;
    } else {
      outcome = "nothing-durable (no leaf written)";
    }
  } catch (err) {
    const de = /** @type {DistillError} */ (err);
    const audit = de?.audit || null;
    const reason = de?.message || String(de);
    text = renderRawFallback({ source, reason, audit });
    const stashed = writeFailedDistillStash({
      source,
      errors: de?.chunk_failures || (audit?.failure_reasons ?? []),
      sessionId,
      audit,
    });
    outcome = stashed
      ? `distillation failed, full body + stash saved at ${stashed} (${reason})`
      : `distillation failed, raw context saved (${reason})`;
  }

  if (text === null) {
    // Nothing-durable clean verdict: no write, no leaf, just the breadcrumb.
    logBreadcrumb(`${tag}: ${outcome}`);
    cleanupContext(ctxFile);
    return;
  }

  // Persist. The write is the one step that genuinely cannot proceed if the
  // store is unavailable. On failure nothing was persisted; the per-session
  // lock is released in runWorker's finally, so a later hook event can retry.
  const docName = dailyDocName(source.capturedAtMs ? new Date(source.capturedAtMs) : undefined);
  try {
    const {
      result,
      datasetName: ds,
      rejected,
    } = await writeFlushDoc(docName, text, source.capturedAtMs);
    cleanupContext(ctxFile);
    const note = rejected ? ` (slot '${rejected}' rejected, fell back to daily)` : "";
    // Log the real stored path: the document id includes the daily/YYYY/MM/DD
    // nesting, whereas `${ds}/${docName}` would omit the date dirs and mislead.
    const dest = result?.created?.document?.id || `${ds}/${docName}`;
    logBreadcrumb(`${tag}: ${outcome} -> ${dest}${note}`);
  } catch (writeErr) {
    // Could not persist even after the daily fallback. Preserve the rendered
    // outcome on disk so the distilled result is recoverable instead of lost;
    // the staged context is then removed (the live client transcript still
    // allows a later re-distill).
    const preserved = preserveFailedOutcome(text, sessionId);
    cleanupContext(ctxFile);
    const where = preserved
      ? `; outcome preserved at ${preserved}`
      : "; could not preserve outcome";
    if (writeErr instanceof WikiStoreUnavailable) {
      logBreadcrumb(
        `${tag}: WIKI STORE rejected the write, not saved (${writeErr.message})${where}`,
      );
    } else {
      logBreadcrumb(
        `${tag}: write failed (${writeErr instanceof Error ? writeErr.message : String(writeErr)})${where}`,
      );
    }
  }
}
