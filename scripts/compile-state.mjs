import fs from "node:fs";
import { COMPILE_STATE_PATH } from "./lib/env.mjs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";

/**
 * Per-action promotion counters accumulated over a compile run.
 * @typedef {Object} CompileCounts
 * @property {number} create
 * @property {number} update
 * @property {number} skip
 * @property {number} error
 */

/**
 * The persisted compile state (state/.compile-state.json).
 * @typedef {Object} CompileState
 * @property {string} last_attempted_date
 * @property {string} last_run_iso
 * @property {CompileCounts} actions
 * @property {Record<string, number>} metadata_retry - dailyDocId -> attempt count.
 */

/** @returns {CompileState} */
export function defaultState() {
  return {
    last_attempted_date: "",
    last_run_iso: "",
    actions: { create: 0, update: 0, skip: 0, error: 0 },
    metadata_retry: {}, // dailyDocId -> attempt count
  };
}

/** @returns {CompileState} */
export function readState() {
  if (!fs.existsSync(COMPILE_STATE_PATH)) return defaultState();
  try {
    const raw = /** @type {Partial<CompileState>} */ (
      JSON.parse(fs.readFileSync(COMPILE_STATE_PATH, "utf8"))
    );
    return { ...defaultState(), ...raw, metadata_retry: raw.metadata_retry || {} };
  } catch {
    return defaultState();
  }
}

/** @param {CompileState} state */
export function writeState(state) {
  // The lockfile serialises healthy concurrent writers, but a SIGKILL or
  // hard crash mid-write would truncate the state file. readState recovers
  // to defaultState() — which silently wipes metadata_retry counters, the
  // bounded-retry cap that prevents duplicate-create loops on a stuck daily.
  // writeFileAtomic (unique temp + data fsync + rename) closes that window
  // and matches the rest of the durable-write surface.
  writeFileAtomic(COMPILE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/** @param {Record<string, unknown>} entry */
export function appendCompileLog(entry) {
  const log = `${COMPILE_STATE_PATH}.log`;
  try {
    fs.appendFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    // A log-append failure (e.g. a transient Windows lock) must not fail compile.
    process.stderr.write(
      `[compile] failed to append compile log: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

export function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}
