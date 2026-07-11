import path from "node:path";
import { MEMORY_DATA_DIR } from "./lib/env.mjs";
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
