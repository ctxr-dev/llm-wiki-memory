import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../lib/atomic-write.mjs";
import { STATE_DIR, ensureStateDir, safeSession, logBreadcrumb } from "./flush-state.mjs";

/** @typedef {import("./flush-source.mjs").SourceMaterial} SourceMaterial */
/** @typedef {import("./flush-distill.mjs").DistillAudit} DistillAudit */

// Persist the full distill-failure context to STATE_DIR so `cli.mjs redistill`
// can re-run distillation against the COMPLETE (redacted) body later. The body
// here is already past redact() in buildSourceMaterial — "complete" means
// un-truncated, NOT pre-redaction; secrets are gone before this is written.
// Owner-only 0600. The stash is in addition to the in-leaf raw fallback so an
// install with MEMORY_FLUSH_RAW_FALLBACK_CHARS set to a finite cap still has
// the full body recoverable.
/**
 * @param {{ source: SourceMaterial, errors: unknown[], sessionId: string, audit?: DistillAudit | null }} args
 * @returns {string | null}
 */
export function writeFailedDistillStash({ source, errors, sessionId, audit = null }) {
  try {
    ensureStateDir();
    // Filename carries both the millisecond timestamp (for newest-wins
    // ordering in findStashForSession) AND a short random suffix so two
    // stashes for the same session in the same millisecond don't overwrite
    // each other (e.g. retry-on-the-spot, or a test that writes serially
    // without yielding to the event loop).
    const suffix = randomUUID().slice(0, 8);
    const dest = path.join(
      STATE_DIR,
      `failed-distill-${safeSession(sessionId)}-${Date.now()}-${suffix}.json`,
    );
    const payload = {
      source,
      errors: Array.isArray(errors) ? errors : [],
      audit: audit || null,
      redistill_attempts: 0,
      stashed_at_utc: new Date().toISOString(),
    };
    writeFileAtomic(dest, JSON.stringify(payload, null, 2), { mode: 0o600 });
    return dest;
  } catch (err) {
    logBreadcrumb(
      `stash: could not write failed-distill record (${/** @type {Error} */ (err)?.message || err})`,
    );
    return null;
  }
}

// Per-session lock path. Dedup is keyed by the session, not a single global
// state file: workers for the SAME session (pre-compact + post-compact, or a
// session-end right after a compact) must not both distil+write, while workers
// for DIFFERENT sessions never contend. The session id is sanitised to safe
// filename characters.
/** @param {string} sessionId */
export function flushLockPath(sessionId) {
  return path.join(STATE_DIR, `.flush-${safeSession(sessionId)}.lock`);
}

/** @param {string} [ctxFile] */
export function cleanupContext(ctxFile) {
  try {
    if (ctxFile) fs.rmSync(ctxFile, { force: true });
  } catch {
    /* best effort */
  }
}

// On a store-write failure we cannot record the outcome in the wiki, so persist
// the rendered daily document (already redacted) to the owner-only state dir as
// a recoverable artifact rather than dropping it. The live client transcript
// also remains, so a later hook event can re-distill.
/**
 * @param {string} text
 * @param {string} sessionId
 * @returns {string | null}
 */
export function preserveFailedOutcome(text, sessionId) {
  try {
    ensureStateDir();
    const dest = path.join(STATE_DIR, `failed-flush-${safeSession(sessionId)}-${Date.now()}.md`);
    writeFileAtomic(dest, text, { mode: 0o600 });
    return dest;
  } catch {
    return null;
  }
}

// On spawn failure the hook front has redacted context but no distilled outcome
// yet, so preserve the staged context (owner-only) for manual recovery instead
// of dropping it. The /tmp original is always removed.
/**
 * @param {string} ctxFile
 * @param {string} sessionId
 * @returns {string | null}
 */
export function preserveFailedContext(ctxFile, sessionId) {
  try {
    ensureStateDir();
    const dest = path.join(STATE_DIR, `failed-spawn-${safeSession(sessionId)}-${Date.now()}.json`);
    fs.copyFileSync(ctxFile, dest);
    fs.chmodSync(dest, 0o600);
    return dest;
  } catch {
    return null;
  } finally {
    cleanupContext(ctxFile);
  }
}

// Enumerate every failed-distill stash currently in STATE_DIR. The dir may
// not exist (fresh install / no failures yet) — returns [] in that case.
export function listFailedDistillStashes() {
  try {
    if (!fs.existsSync(STATE_DIR)) return [];
    return fs
      .readdirSync(STATE_DIR)
      .filter((f) => f.startsWith("failed-distill-") && f.endsWith(".json"))
      .map((f) => path.join(STATE_DIR, f));
  } catch {
    return [];
  }
}

// Pick the newest stash for a given session id. Returns null when no stash
// matches; the CLI surfaces that as a clear "nothing to redistill" message.
/**
 * @param {string} sessionId
 * @returns {string | null}
 */
export function findStashForSession(sessionId) {
  const prefix = `failed-distill-${safeSession(sessionId)}-`;
  let best = null;
  let bestTs = -1;
  for (const fullPath of listFailedDistillStashes()) {
    const name = path.basename(fullPath);
    if (!name.startsWith(prefix)) continue;
    // Filename format: failed-distill-<safe-session>-<ms>[-<uuid8>].json
    // Parse the millisecond timestamp from the FIRST dash-separated field
    // after the prefix; the optional uuid suffix is for collision
    // avoidance and not consulted for ordering.
    const tail = name.slice(prefix.length, -".json".length);
    const tsPart = tail.split("-")[0];
    const ts = Number.parseInt(tsPart, 10);
    if (Number.isFinite(ts) && ts > bestTs) {
      bestTs = ts;
      best = fullPath;
    }
  }
  return best;
}
