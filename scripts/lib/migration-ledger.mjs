import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";

// Which migrations this install has already settled, recorded beside the other
// per-install markers (.embed-warm.json, .consolidate.json, …).
//
// This ledger is a FAST PATH and nothing more. Correctness rests on each
// migration's own `detect()`, so every failure here degrades to "detect again":
// an absent, truncated, or malformed file reads as EMPTY, and an unwritable
// state dir is swallowed. Re-detecting costs a few cheap reads; wrongly SKIPPING
// a migration would silently leave an install half-upgraded, which is why the
// ledger is never allowed to be the thing that decides.
//
// Written ONLY by the migration runner. It is engine bookkeeping, not a document:
// the PreToolUse deny-hook blocks agent writes to the whole state/ directory.

/** @param {string} dataDir @returns {string} */
export function ledgerPath(dataDir) {
  return path.join(dataDir, "state", ".migrations.json");
}

/**
 * @param {string} dataDir
 * @returns {{ applied: string[] }}
 */
export function readLedger(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(dataDir), "utf8"));
    const applied = parsed && typeof parsed === "object" ? parsed.applied : null;
    if (!Array.isArray(applied)) return { applied: [] };
    return { applied: applied.filter((id) => typeof id === "string" && id) };
  } catch {
    return { applied: [] };
  }
}

/**
 * Append ids to the ledger, preserving first-seen order and never duplicating.
 * Best-effort by design (see the module note): a write failure leaves the run
 * correct but unmemoised, so the next bootstrap simply re-detects.
 * @param {string} dataDir
 * @param {readonly string[]} ids
 * @returns {void}
 */
export function recordApplied(dataDir, ids) {
  const fresh = (ids || []).filter((id) => typeof id === "string" && id);
  if (fresh.length === 0) return;
  const applied = [...new Set([...readLedger(dataDir).applied, ...fresh])];
  try {
    fs.mkdirSync(path.dirname(ledgerPath(dataDir)), { recursive: true });
    writeFileAtomic(
      ledgerPath(dataDir),
      `${JSON.stringify({ applied, updated: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    /* unwritable state dir: the run stands, it is just not memoised */
  }
}
