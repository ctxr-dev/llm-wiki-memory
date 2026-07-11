import fs from "node:fs";
import path from "node:path";
import { dailyDocName } from "../lib/slug.mjs";
import { acquireLock, installLockReleaseHandlers } from "../lib/lock.mjs";
import { flushLockStaleMs } from "../lib/settings.mjs";
import { writeFileAtomic } from "../lib/atomic-write.mjs";
import { logBreadcrumb, shortId, ensureStateDir } from "./flush-state.mjs";
import { flushLockPath } from "./flush-stash.mjs";
import { distillByChunks } from "./flush-distill.mjs";
import { renderDailyDocument } from "./flush-render.mjs";
import { writeFlushDoc, wikiInitialised } from "./flush-write.mjs";

export { extractSourceFromLeaf, redistillFromLeaf } from "./flush-redistill-leaf.mjs";

/** @typedef {import("./flush-source.mjs").SourceMaterial} SourceMaterial */
/** @typedef {import("./flush-distill.mjs").DistillResult} DistillResult */

// Recovery: manual redistill against a stashed failure

// Re-run distillation against a stashed `source` and overwrite the failed
// daily leaf in-place (upsert-by-name in wiki-store). Returns the result
// of the write call, augmented with the new audit breadcrumb.
//
// On success the stash file is DELETED — recovery is complete. On failure
// the stash's `redistill_attempts` counter is incremented and the stash is
// preserved so the operator can try again later with (hopefully) a healthy
// provider.
/**
 * @param {string} stashPath
 * @param {{ tag?: string }} [opts]
 */
export async function redistillFromStash(stashPath, { tag = "redistill" } = {}) {
  if (!fs.existsSync(stashPath)) {
    throw new Error(`redistillFromStash: stash file not found at ${stashPath}`);
  }
  // A stash truncated by a crash/disk-full mid-write would JSON.parse-throw
  // here on EVERY `redistill --all` sweep forever (the stash is only deleted
  // on success). Quarantine it to `*.corrupt` so the sweep makes forward
  // progress and the operator gets a clear signal instead of a sticky
  // opaque SyntaxError.
  let stashJson;
  try {
    stashJson = JSON.parse(fs.readFileSync(stashPath, "utf8"));
  } catch (parseErr) {
    const corrupt = `${stashPath}.corrupt`;
    try {
      fs.renameSync(stashPath, corrupt);
    } catch {
      /* best effort */
    }
    throw new Error(
      `redistillFromStash: corrupt stash JSON at ${stashPath} (${parseErr instanceof Error ? parseErr.message : String(parseErr)}); quarantined to ${path.basename(corrupt)} — rm it once reviewed`,
    );
  }
  const source = stashJson?.source;
  if (!source || typeof source !== "object" || typeof source.body !== "string") {
    throw new Error(`redistillFromStash: malformed stash at ${stashPath} (no source.body)`);
  }
  const prevAttempts = Number.isFinite(stashJson.redistill_attempts)
    ? stashJson.redistill_attempts
    : 0;
  const nextAttempts = prevAttempts + 1;

  if (!wikiInitialised()) {
    throw new Error("redistillFromStash: wiki not initialised; run bootstrap.sh first");
  }

  // Take the same per-session lock the flush worker uses, so a manual
  // redistill cannot race a live SessionEnd worker for the same session.
  // Without this gate, the later writer would silently overwrite the
  // earlier one AND the redistill would delete the stash even though a
  // newer flush already produced a leaf.
  ensureStateDir();
  const lockPath = flushLockPath(source.sessionId);
  const lock = acquireLock(lockPath, { staleMs: flushLockStaleMs(), label: "redistill" });
  if (!lock.ok) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(
        `redistillFromStash: session ${shortId(source.sessionId)} is busy (${lock.reason}); try again after the live worker finishes`,
      )
    );
    err.code = "ESESSIONBUSY";
    throw err;
  }
  installLockReleaseHandlers(lockPath);
  try {
    return await redistillUnderLock({ stashPath, stashJson, source, nextAttempts, tag });
  } finally {
    /** @type {() => void} */ (lock.release)();
  }
}

/**
 * @param {{ stashPath: string, stashJson: Record<string, unknown>, source: SourceMaterial, nextAttempts: number, tag: string }} args
 */
async function redistillUnderLock({ stashPath, stashJson, source, nextAttempts, tag }) {
  let result;
  try {
    result = await distillByChunks(source, tag);
  } catch (err) {
    try {
      writeFileAtomic(
        stashPath,
        JSON.stringify(
          {
            ...stashJson,
            redistill_attempts: nextAttempts,
            last_attempt_at_utc: new Date().toISOString(),
            last_error: String(err instanceof Error ? err.message : err).slice(0, 240),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch (writeErr) {
      logBreadcrumb(
        `${tag}: could not update stash attempt counter (${writeErr instanceof Error ? writeErr.message : String(writeErr)})`,
      );
    }
    throw err;
  }

  const audit = {
    ...result.audit,
    redistilled_from: source.capturedAtMs ? new Date(source.capturedAtMs).toISOString() : null,
    redistill_attempts: nextAttempts,
    original_outcome: "distillation-failed",
  };

  const failedChunks = result.failedChunks || [];

  // Nothing-durable redistill: don't write a leaf. Decide what to do with
  // the stash based on whether ANY chunk still failed this run:
  //   - clean "nothing durable" on every chunk → delete the stash (work done).
  //   - some chunks still failed → KEEP the stash (with an incremented
  //     attempt counter) so a future redistill can retry just those.
  if (result.atoms.length === 0) {
    if (audit.failed_chunks?.length) {
      try {
        writeFileAtomic(
          stashPath,
          JSON.stringify(
            {
              ...stashJson,
              redistill_attempts: nextAttempts,
              last_attempt_at_utc: new Date().toISOString(),
              last_audit: audit,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      } catch (writeErr) {
        logBreadcrumb(
          `${tag}: could not update stash attempt counter (${writeErr instanceof Error ? writeErr.message : String(writeErr)})`,
        );
      }
      const outcome = `redistill produced no atoms but ${audit.failed_chunks.length} chunk(s) still failed; stash kept for retry`;
      logBreadcrumb(`${tag}: ${outcome}`);
      return { audit, outcome, written: false };
    }
    try {
      fs.rmSync(stashPath, { force: true });
    } catch {
      /* best effort */
    }
    const outcome = "redistill produced no atoms (no leaf written; stash cleared)";
    logBreadcrumb(`${tag}: ${outcome}`);
    return { audit, outcome, written: false };
  }

  const text = renderDailyDocument({ atoms: result.atoms, source, audit, failedChunks });
  const outcome = `redistilled to ${result.atoms.length} atom(s)`;
  const docName = dailyDocName(source.capturedAtMs ? new Date(source.capturedAtMs) : undefined);
  const write = await writeFlushDoc(docName, text, source.capturedAtMs);

  // Success → drop the stash so future `--all` sweeps don't reprocess it.
  // A crash between the leaf write and this rm leaves the stash around, but
  // a re-run is idempotent (upsert-by-name overwrites the same leaf again
  // with the same audit breadcrumb).
  try {
    fs.rmSync(stashPath, { force: true });
  } catch {
    /* best effort */
  }
  logBreadcrumb(
    `${tag}: ${outcome} -> ${write.result?.created?.document?.id || write.datasetName + "/" + docName} (stash ${path.basename(stashPath)} cleared)`,
  );
  return { ...write, audit, outcome, written: true };
}
