import fs from "node:fs";
import path from "node:path";
import { MEMORY_DATA_DIR } from "../lib/env.mjs";

// Operational state under the durable data dir (not the repo clone), mirroring
// where compile keeps its state/lock. In a dev checkout this dir is outside the
// repo; in an install it is the gitignored data dir, so nothing here is ever
// tracked. The .flush.log breadcrumb and per-session .flush-<id>.lock claim
// files (atomic dedup via lock.mjs) both live here.
export const STATE_DIR = path.join(MEMORY_DATA_DIR, "state");
export const FLUSH_LOG_PATH = path.join(STATE_DIR, ".flush.log");

// The breadcrumb and any preserved-failure files can carry session ids, atom
// titles, and error text, so the state dir is owner-only (0700) and the files
// 0600. mkdir / appendFileSync `mode` only applies on creation, so we also chmod
// once per process to tighten a dir or log that an earlier run left broader.
let stateDirSecured = false;
let flushLogSecured = false;
export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (!stateDirSecured) {
    try {
      fs.chmodSync(STATE_DIR, 0o700);
    } catch {
      /* best effort */
    }
    stateDirSecured = true;
  }
}

/** @param {unknown} sessionId @returns {string} */
export function safeSession(sessionId) {
  return String(sessionId || "manual")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
}

/** @param {unknown} id @returns {string} */
export function shortId(id) {
  return String(id || "").slice(0, 8);
}

/** @param {number} ms @returns {Promise<void>} */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} line @returns {void} */
export function logBreadcrumb(line) {
  // The worker is detached with stdio ignored, so a file log is the only
  // observability channel. Best-effort: a logging failure must never break
  // the flush.
  try {
    ensureStateDir();
    // Single atomic append: appendFileSync uses flag "a" (create-if-absent, no
    // truncation) and applies mode 0o600 only when it creates the file, so two
    // concurrent workers never race to truncate it.
    fs.appendFileSync(FLUSH_LOG_PATH, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    if (!flushLogSecured) {
      // The mode above is ignored when the file already exists; chmod once so a
      // pre-existing log with broader perms is tightened to owner-only too.
      try {
        fs.chmodSync(FLUSH_LOG_PATH, 0o600);
      } catch {
        /* best effort */
      }
      flushLogSecured = true;
    }
  } catch {
    /* best effort */
  }
}
