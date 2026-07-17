import path from "node:path";
import { pathToFileURL } from "node:url";
import { wikiRoot, workspaceBasename, defaultProjectModule } from "./lib/env.mjs";
import {
  listDocuments,
  readDocument,
  updateDocMetadata,
  categoryHasTopology,
} from "./lib/wiki-store.mjs";
import { validate } from "./lib/wiki-cli.mjs";
import { helpGuard, formatHelp, docsUrl } from "./lib/cli-args.mjs";

/** @typedef {import("./lib/types.mjs").MetadataInput} MetadataInput */

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function normId(value, fallback) {
  return String(value ?? fallback ?? "")
    .trim()
    .toLowerCase();
}

/**
 * @param {string} documentId
 * @param {string} datasetId
 * @param {MetadataInput} existing
 * @param {string} target
 * @returns {boolean}
 */
function restamp(documentId, datasetId, existing, target) {
  const { project_module: _legacy, ...rest } = existing;
  const curDir = String(documentId).split("/").slice(0, -1).join("/");
  const res = updateDocMetadata({
    datasetId,
    documentId,
    metadata: { ...rest, project_module_override: target },
    placementOverride: curDir,
    commitReason: `project_module identity migrated to ${target}`,
  });
  return Boolean(res && res.ok);
}

/**
 * Leaves whose stored `project_module` equals the legacy id, EXCLUDING topology
 * categories (they nest by the path-compiler, not by this facet contract — the
 * sibling `migrate` skips them the same way). A leaf that cannot be read is
 * skipped so one bad leaf never aborts the migration.
 * @param {string} legacy
 * @returns {{ id: string, datasetId: string, meta: MetadataInput }[]}
 */
function collectLegacyCandidates(legacy) {
  const { documents } = listDocuments({});
  /** @type {{ id: string, datasetId: string, meta: MetadataInput }[]} */
  const candidates = [];
  for (const doc of documents) {
    if (categoryHasTopology(doc.datasetId)) continue;
    let meta;
    try {
      meta = readDocument({ documentId: doc.id, datasetId: doc.datasetId }).metadata || {};
    } catch {
      continue;
    }
    if (normId(/** @type {MetadataInput} */ (meta).project_module, "") === legacy) {
      candidates.push({ id: doc.id, datasetId: doc.datasetId, meta });
    }
  }
  return candidates;
}

/**
 * @param {{ newId?: string, oldId?: string, dryRun?: boolean, check?: boolean }} [opts]
 */
export function migrateProjectModuleIdentity({ newId, oldId, dryRun = false, check = false } = {}) {
  const target = normId(newId, defaultProjectModule());
  const legacy = normId(oldId, workspaceBasename());
  const mode = check ? "check" : dryRun ? "dry-run" : "migrate";
  if (!target || target === legacy) {
    return { ok: true, mode, migrated: 0, pending: 0, reason: "identity-unchanged" };
  }

  const candidates = collectLegacyCandidates(legacy);

  if (check) {
    return {
      ok: candidates.length === 0,
      mode,
      pending: candidates.length,
      sample: candidates.slice(0, 10).map((c) => c.id),
    };
  }
  if (dryRun) {
    return { ok: true, mode, pending: candidates.length, changes: candidates.map((c) => c.id) };
  }

  let migrated = 0;
  for (const c of candidates) {
    if (restamp(c.id, c.datasetId, c.meta, target)) migrated += 1;
  }
  const v = validate(wikiRoot());
  return {
    ok: v.ok,
    mode,
    migrated,
    from: legacy,
    to: target,
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
  const HELP = formatHelp({
    name: "migrate-identity",
    summary:
      "one-shot re-stamp of every non-topology leaf's legacy project_module identity to the current workspace id",
    usage: "node scripts/migrate-identity.mjs [--dry-run | --check]",
    docs: docsUrl("AI-INSTALL-PROMPT.md"),
  });
  helpGuard(process.argv.slice(2), HELP);
  const res = migrateProjectModuleIdentity({
    dryRun: process.argv.includes("--dry-run"),
    check: process.argv.includes("--check"),
  });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  if (res.mode === "check" && !res.ok) process.exit(3);
  if (res.mode === "migrate" && !res.ok) process.exit(2);
}
