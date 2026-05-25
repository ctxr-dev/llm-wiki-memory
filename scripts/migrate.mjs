import path from "node:path";
import { pathToFileURL } from "node:url";
import { wikiRoot, defaultProjectModule } from "./lib/env.mjs";
import { listDocuments, readDocument, updateDocMetadata } from "./lib/wiki-store.mjs";
import { indexRebuildAll, validate } from "./lib/wiki-cli.mjs";

// One-shot upgrade for wikis built before the project_module/area split:
//   - move each leaf's legacy sub-module `project_module` into `area` and stamp
//     `project_module` to the workspace, so recall's default scope matches every
//     leaf (no more 0-hit-by-default) and faceting keys off `area`. A leaf that
//     was flat (pre-nesting) is relocated to its `area` facet folder as a side
//     effect of updateDocMetadata's placement check.
//   - regenerate every index.md so focuses become the new descriptive
//     aggregation instead of the old "subtree under <path>" placeholder.
// The embedding cache self-invalidates on a model change (see embed.mjs loadCache),
// so no explicit cache step is needed. Idempotent: a re-run finds nothing to do.
//
// `--check` reports leaves still on the legacy shape (exit non-zero if any);
// `--dry-run` lists them without mutating.

export function migrate({ dryRun = false, check = false } = {}) {
  // wiki-store ops (listDocuments / readDocument / updateDocMetadata) and wiki-cli
  // (indexRebuildAll / validate) all resolve the wiki from env via wikiRoot(), so
  // migrate always targets the env-configured wiki. Bind it once for the calls
  // that take an explicit path, so scan + rebuild + validate cannot diverge.
  const wiki = wikiRoot();
  const workspace = String(defaultProjectModule() || "").trim().toLowerCase();
  const { documents } = listDocuments({});
  const candidates = [];
  for (const doc of documents) {
    let meta;
    try {
      meta = readDocument({ documentId: doc.id, datasetId: doc.datasetId }).metadata || {};
    } catch {
      continue;
    }
    const pm = String(meta.project_module || "").trim().toLowerCase();
    // Migrate only leaves whose project_module is a legacy sub-module value
    // (anything other than the workspace) -> the pre-split shape. Leaves already
    // carrying project_module == workspace are skipped on purpose: either they are
    // already migrated, or they are post-split leaves written without a sub-module
    // (correctly placed under the "unscoped" facet). There is no reliable
    // sub-module to backfill an `area` from when project_module is already the
    // workspace, so leaving them unscoped is correct rather than guessing.
    if (pm && pm !== workspace) {
      candidates.push({
        id: doc.id,
        datasetId: doc.datasetId,
        area: String(meta.area || meta.project_module || "").trim().toLowerCase(),
      });
    }
  }

  if (check) {
    return { ok: candidates.length === 0, mode: "check", pending: candidates.length, sample: candidates.slice(0, 10).map((c) => c.id) };
  }
  if (dryRun) {
    return { ok: true, mode: "dry-run", pending: candidates.length, changes: candidates.map((c) => ({ id: c.id, area: c.area })) };
  }

  let migrated = 0;
  let relocated = 0;
  for (const c of candidates) {
    const res = updateDocMetadata({ datasetId: c.datasetId, documentId: c.id, metadata: { area: c.area } });
    if (res && res.ok) {
      migrated += 1;
      if (res.relocated) relocated += 1;
    }
  }

  // Regenerate every index.md so focuses use the new descriptive aggregation.
  indexRebuildAll(wiki);
  const v = validate(wiki);
  return {
    ok: v.ok,
    mode: "migrate",
    migrated,
    relocated,
    validate: { ok: v.ok, errors: v.errors, warnings: v.warnings },
  };
}

const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  const res = migrate({ dryRun: process.argv.includes("--dry-run"), check: process.argv.includes("--check") });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  if (res.mode === "check" && !res.ok) process.exit(3);
  if (res.mode === "migrate" && !res.ok) process.exit(2);
}
