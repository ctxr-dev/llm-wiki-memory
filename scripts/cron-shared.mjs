import path from "node:path";
import { MEMORY_DATA_DIR, wikiRoot } from "./lib/env.mjs";
import {
  consolidateAttemptsKeep,
  consolidateFullLogRetentionDays,
  consolidateEscalateAfterAttempts,
} from "./lib/settings.mjs";

// Settings readers that can never fail the cron path.
export function attemptsKeepSafe() {
  try {
    return consolidateAttemptsKeep();
  } catch {
    return 50;
  }
}
export function retentionDaysSafe() {
  try {
    return consolidateFullLogRetentionDays();
  } catch {
    return 90;
  }
}
export function escalateAfterSafe() {
  try {
    return consolidateEscalateAfterAttempts();
  } catch {
    return 3;
  }
}

/** @param {unknown} v */
export const collapse = (v) =>
  String(v || "")
    .replace(/\s+/g, " ")
    .trim();

/** @param {string} abs */
export function relToDataDir(abs) {
  return path.relative(MEMORY_DATA_DIR, abs);
}

/**
 * Offer the gradual warm, swallowing every failure. Isolated from the cron's
 * pass/fail bookkeeping on purpose (see the call site).
 * @returns {Promise<void>}
 */
export async function warmIfDueQuietly() {
  try {
    const { warmWikiEmbeddingsIfDue } = await import("./lib/embed-warm.mjs");
    const res = await warmWikiEmbeddingsIfDue(wikiRoot());
    if (!res.skipped && res.embedded > 0) {
      process.stderr.write(`cron-job: warmed ${res.embedded} texts across ${res.leaves} leaves\n`);
    }
  } catch (error) {
    process.stderr.write(
      `cron-job: warm skipped (${error instanceof Error ? error.message : String(error)})\n`,
    );
  }
}
