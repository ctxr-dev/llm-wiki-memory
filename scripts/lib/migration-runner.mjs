import { pathToFileURL } from "node:url";
import { loadRegistry } from "./migration-registry.mjs";
import { readLedger, recordApplied } from "./migration-ledger.mjs";

// Run the registered migrations for one bootstrap phase, in registry order.
//
// Per migration: `detect(ctx)` asks whether THIS install still needs it, and only
// then does `apply(ctx)` run. A migration that was never needed is recorded just
// like one that ran — both mean "settled" — which is what lets a fresh install
// fast-path forever after.
//
// The ledger short-circuits the detect for settled ids. That is a speed-up, not
// the decision: `remigrate` ignores it, and a corrupt/absent ledger reads empty
// so every detection runs again (see migration-ledger.mjs).
//
// A failing migration ABORTS the run: later migrations may assume the earlier
// ones landed, so continuing would produce a half-migrated install that reports
// success — the same reasoning migrate-settings already applies to itself. The
// successful prefix IS recorded, so a re-run resumes rather than redoing.

/** @typedef {{ dataDir: string, wikiRoot?: string, srcDir?: string, home?: string }} MigrationContext */
/** @typedef {{ applied: string[], alreadyCurrent: string[], skipped: string[], decisions: { id: string, decision: string }[] }} MigrationReport */

/**
 * @param {{ dataDir: string, migrationsDir: string, phase: string, remigrate?: boolean, context?: MigrationContext }} args
 * @returns {Promise<MigrationReport>}
 */
export async function runMigrations({ dataDir, migrationsDir, phase, remigrate = false, context }) {
  const entries = loadRegistry(migrationsDir, { phase });
  const settled = remigrate ? new Set() : new Set(readLedger(dataDir).applied);
  const ctx = context ?? { dataDir };

  /** @type {MigrationReport} */
  const report = { applied: [], alreadyCurrent: [], skipped: [], decisions: [] };
  /** @type {string[]} */
  const toRecord = [];

  try {
    for (const entry of entries) {
      if (settled.has(entry.id)) {
        report.skipped.push(entry.id);
        continue;
      }
      const mod = await import(pathToFileURL(entry.file).href);
      if (typeof mod.detect !== "function" || typeof mod.apply !== "function") {
        throw new Error(`migration "${entry.id}" must export detect() and apply()`);
      }
      if (!(await mod.detect(ctx))) {
        report.alreadyCurrent.push(entry.id);
        toRecord.push(entry.id);
        continue;
      }
      await mod.apply(ctx);
      report.applied.push(entry.id);
      toRecord.push(entry.id);
      if (typeof mod.decision === "string" && mod.decision.trim()) {
        report.decisions.push({ id: entry.id, decision: mod.decision.trim() });
      }
    }
  } catch (error) {
    // Record the prefix that DID settle before re-throwing, so a re-run resumes
    // at the failure instead of repeating work that already succeeded.
    recordApplied(dataDir, toRecord);
    throw error;
  }

  recordApplied(dataDir, toRecord);
  return report;
}
