import fs from "node:fs";
import path from "node:path";
import { dailyDocName } from "../lib/slug.mjs";
import { redact } from "../lib/redact.mjs";
import { acquireLock, installLockReleaseHandlers } from "../lib/lock.mjs";
import { flushLockStaleMs } from "../lib/settings.mjs";
import { logBreadcrumb, shortId, ensureStateDir } from "./flush-state.mjs";
import { flushLockPath } from "./flush-stash.mjs";
import { distillByChunks } from "./flush-distill.mjs";
import { renderDailyDocument } from "./flush-render.mjs";
import { writeFlushDoc, wikiInitialised } from "./flush-write.mjs";

/** @typedef {import("./flush-source.mjs").SourceMaterial} SourceMaterial */

// Parse a daily leaf written by renderRawFallback and rebuild a `source`
// object from its frontmatter + the UNTRUSTED MEMORY BODY fence. Used when
// the operator runs `redistill --leaf <path>` against a leaf that has no
// associated stash — typically a pre-map-reduce leaf that pre-dates the
// stash mechanism. Returns null if the leaf is not a recoverable raw-
// fallback (no UNTRUSTED block, or no session_id).
/**
 * @param {string} leafPath
 * @returns {SourceMaterial | null}
 */
export function extractSourceFromLeaf(leafPath) {
  let text;
  try {
    text = fs.readFileSync(leafPath, "utf8");
  } catch {
    return null;
  }
  const sessionMatch = text.match(/^- session_id:\s*(.+)$/m);
  if (!sessionMatch) return null;
  const sessionId = sessionMatch[1].trim();
  const hookEventMatch = text.match(/^- hook_event:\s*(.+)$/m);
  const hookEvent = hookEventMatch ? hookEventMatch[1].trim() : "redistill";
  const capturedMatch = text.match(/^- captured_at_utc:\s*(.+)$/m);
  const capturedAtMs = capturedMatch ? Date.parse(capturedMatch[1].trim()) : Date.now();
  const workspaceMatch = text.match(/^- workspace:\s*(.+)$/m);
  const cwd = workspaceMatch ? workspaceMatch[1].trim() : "";

  // Body lives between BEGIN UNTRUSTED MEMORY BODY and END markers, with
  // every line indented 4 spaces. Strip the indent verbatim to recover the
  // body. (If the original body contained a forged UNTRUSTED marker, renderRaw-
  // Fallback defanged it with a zero-width space, so recovery is non-lossy but
  // not byte-identical — the injected ZWSP remains; harmless for redistill.)
  const begin = text.indexOf("<!-- BEGIN UNTRUSTED MEMORY BODY -->");
  const end = text.indexOf("<!-- END UNTRUSTED MEMORY BODY -->");
  if (begin === -1 || end === -1 || end < begin) return null;
  const between = text.slice(begin + "<!-- BEGIN UNTRUSTED MEMORY BODY -->".length, end);
  // Re-redact defensively: a leaf written by a pre-redaction-era build, or one
  // a human hand-edited and pasted a secret into, would otherwise feed that
  // secret straight back into the redistill prompt (and any leaf it rewrites).
  // redact() is idempotent, so this is a no-op on an already-clean body.
  const body = redact(
    between
      .split(/\r?\n/)
      .map((line) => (line.startsWith("    ") ? line.slice(4) : line))
      .join("\n"),
  ).trim();
  if (!body) return null;

  return { sessionId, cwd, hookEvent, body, turnCount: 0, capturedAtMs };
}

// Manual recovery path when the operator points `redistill --leaf` at a
// daily leaf that has no matching stash — typically a leaf from before the
// stash mechanism existed. Reconstructs `source` from the leaf, runs
// distillByChunks, overwrites the leaf in place with the new audit
// breadcrumb. No stash file is involved, so success leaves nothing to
// clean up; failure re-throws (the caller can inspect or retry).
/**
 * @param {string} leafPath
 * @param {{ tag?: string }} [opts]
 */
export async function redistillFromLeaf(leafPath, { tag = "redistill-leaf" } = {}) {
  const source = extractSourceFromLeaf(leafPath);
  if (!source) {
    throw new Error(
      `redistillFromLeaf: ${leafPath} has no recoverable raw-fallback body (missing session_id or UNTRUSTED block)`,
    );
  }
  if (!wikiInitialised()) {
    throw new Error("redistillFromLeaf: wiki not initialised; run bootstrap.sh first");
  }
  ensureStateDir();
  const lockPath = flushLockPath(source.sessionId);
  const lock = acquireLock(lockPath, { staleMs: flushLockStaleMs(), label: "redistill-leaf" });
  if (!lock.ok) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`redistillFromLeaf: session ${shortId(source.sessionId)} is busy (${lock.reason})`)
    );
    err.code = "ESESSIONBUSY";
    throw err;
  }
  installLockReleaseHandlers(lockPath);
  try {
    const result = await distillByChunks(source, tag);
    const audit = {
      ...result.audit,
      redistilled_from: source.capturedAtMs ? new Date(source.capturedAtMs).toISOString() : null,
      // Pre-map-reduce leaves have no stash + no attempt counter; treat
      // the manual recovery as attempt 1.
      redistill_attempts: 1,
      original_outcome: "distillation-failed",
      recovered_from_leaf: path.basename(leafPath),
    };
    const failedChunks = result.failedChunks || [];
    if (result.atoms.length === 0) {
      const outcome = "redistill-from-leaf produced no atoms (leaf left untouched)";
      logBreadcrumb(`${tag}: ${outcome}`);
      return { audit, outcome, written: false };
    }
    const text = renderDailyDocument({ atoms: result.atoms, source, audit, failedChunks });
    const outcome = `recovered ${result.atoms.length} atom(s) from in-leaf raw fallback`;
    const docName = dailyDocName(source.capturedAtMs ? new Date(source.capturedAtMs) : undefined);
    const write = await writeFlushDoc(docName, text, source.capturedAtMs);
    logBreadcrumb(
      `${tag}: ${outcome} -> ${write.result?.created?.document?.id || write.datasetName + "/" + docName}`,
    );
    return { ...write, audit, outcome, written: true };
  } finally {
    /** @type {() => void} */ (lock.release)();
  }
}
