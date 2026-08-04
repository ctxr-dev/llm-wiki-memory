import fs from "node:fs";
import path from "node:path";
import { COMPILE_LOCK_PATH } from "./lib/env.mjs";
import { compileLockStaleMs, flushSlotName } from "./lib/settings.mjs";
import { acquireLock, installLockReleaseHandlers } from "./lib/lock.mjs";
import { withWikiCommit } from "./lib/wiki-commit.mjs";
import { withBrainContextSafe } from "./lib/wiki-context.mjs";
import { listDocuments, WikiStoreUnavailable } from "./lib/wiki-store.mjs";
import { parseDailyDocName } from "./lib/slug.mjs";
import { FORCE, DRY_RUN } from "./compile-flags.mjs";
import { loadPrompt } from "./compile-atoms.mjs";
import { readState, writeState, todayUtcDate } from "./compile-state.mjs";
import { processDaily } from "./compile-promote.mjs";

export { parseAtomsFromMarkdown, scoreAtomQuality, __loadPromptForTest } from "./compile-atoms.mjs";
export { forcedLessonUpdate } from "./compile-dedup.mjs";

async function main() {
  // Acquire an exclusive compile lock. Two SessionStarts can spawn
  // detached compiles concurrently; without this, both would load
  // .compile-state.json, mutate it independently, and the last writer
  // wins. The metadata_retry counter would regress and an atom could be
  // promoted twice (once by each compile).
  const lockStaleMs = compileLockStaleMs();
  fs.mkdirSync(path.dirname(COMPILE_LOCK_PATH), { recursive: true });
  installLockReleaseHandlers(COMPILE_LOCK_PATH);
  const lock = acquireLock(COMPILE_LOCK_PATH, { staleMs: lockStaleMs, label: "compile.mjs" });
  if (!lock.ok) {
    console.error(`compile.mjs: skipping (${lock.reason})`);
    process.exit(0);
  }

  const dailyDataset = flushSlotName();
  let dailies;
  try {
    const listOpts = /** @type {{ prefix: string, datasetId: string, enabled?: string }} */ ({
      prefix: "daily-",
      datasetId: dailyDataset,
    });
    if (!FORCE) listOpts.enabled = "true";
    const result = await listDocuments(listOpts);
    dailies = Array.isArray(result?.documents) ? result.documents : [];
  } catch (err) {
    if (err instanceof WikiStoreUnavailable) {
      console.error(`compile.mjs: bridge unavailable: ${err.message}`);
      process.exit(0);
    }
    throw err;
  }

  const filtered = dailies.filter((d) => parseDailyDocName(d?.name));
  if (filtered.length === 0) {
    console.error("compile.mjs: no enabled daily-* docs to promote");
    return;
  }

  const sorted = filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  console.error(`compile.mjs: found ${sorted.length} daily doc(s) to promote`);

  // Load state up front so the per-daily loop can use + update
  // metadata_retry counts. Saved at the bottom along with action counts.
  const state = readState();
  const systemPrompt = loadPrompt();

  // Schema-missing warnings: print to stderr at most ONCE per dataset per
  // compile run so an operator notices that promoted docs are
  // un-filterable. Without this, the warning was buried in the JSON log
  // and silently lost.
  const warnedSchemaMissing = new Set();
  const counts = { create: 0, update: 0, skip: 0, error: 0 };
  let promotedDocs = 0;

  for (const daily of sorted) {
    const promoted = await processDaily({
      daily,
      dailyDataset,
      systemPrompt,
      state,
      counts,
      warnedSchemaMissing,
    });
    if (promoted) promotedDocs += 1;
  }

  state.last_attempted_date = todayUtcDate();
  state.last_run_iso = new Date().toISOString();
  state.actions = {
    create: (state.actions?.create || 0) + counts.create,
    update: (state.actions?.update || 0) + counts.update,
    skip: (state.actions?.skip || 0) + counts.skip,
    error: (state.actions?.error || 0) + counts.error,
  };
  writeState(state);

  console.error(
    `compile.mjs: promoted ${promotedDocs} daily doc(s); actions create=${counts.create} update=${counts.update} skip=${counts.skip} error=${counts.error}`,
  );
}

// Run main() only when invoked as a script, not when imported by tests.
if (import.meta.main) {
  // One compile run = one wiki commit (promotions + superseded dailies). The
  // exit-hook in wiki-commit flushes the batch even when main() bails out via
  // process.exit (bridge-gone aborts). DRY_RUN writes nothing; noCommit is
  // belt-and-suspenders.
  //
  // The brain context is the OUTERMOST frame so both main()'s reads/writes and
  // the wiki-commit target the brain wiki. Behavior-neutral in the single-tree
  // case (brain root == env wikiRoot() default); structural so a spawned
  // `cli.mjs compile` (from the cron) always runs brain-scoped too.
  await withBrainContextSafe(() =>
    withWikiCommit({ op: "compile", actor: "compile", noCommit: DRY_RUN }, () => main()),
  );
}
