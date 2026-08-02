import fs from "node:fs";
import path from "node:path";

// The ordered list of migrations, declared in `migrations/migrations.json`.
//
// Order is the contract, so it is DECLARED rather than derived: sorting by path
// or date would silently reorder migrations whenever a date-nested folder was
// renamed or a same-day release stacked. The JSON array is the order.
//
// An `id` doubles as the module's path under the migrations dir
// (`2026/06/03/001-settings-yaml` -> `2026/06/03/001-settings-yaml.mjs`) and as
// the ledger key, which is why duplicates and traversal are refused outright.
//
// This file FAILS LOUD, unlike the ledger it feeds: the registry is reviewed
// source, so a malformed entry is an authoring bug. Degrading it to a warning
// would turn "I wrote a migration" into "an install silently skipped it".

/** Bootstrap's two ordering slots: settings runs before the wiki exists, data after. */
export const PHASES = Object.freeze(["settings", "data"]);

/** @typedef {{ id: string, phase: string, file: string }} MigrationEntry */

/** @param {string} id @returns {boolean} */
function isSafeId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    !path.isAbsolute(id) &&
    !id.split("/").some((seg) => seg === "" || seg === "." || seg === "..") &&
    !id.includes("\\")
  );
}

/**
 * @param {string} migrationsDir
 * @param {{ phase?: string }} [opts]
 * @returns {MigrationEntry[]}
 */
export function loadRegistry(migrationsDir, { phase } = {}) {
  const manifest = path.join(migrationsDir, "migrations.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${manifest}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = parsed && typeof parsed === "object" ? parsed.migrations : null;
  if (!Array.isArray(list)) throw new Error(`${manifest} must hold a "migrations" array`);

  /** @type {MigrationEntry[]} */
  const entries = [];
  const seen = new Set();
  for (const raw of list) {
    const id = raw && typeof raw === "object" ? raw.id : undefined;
    if (!isSafeId(id)) {
      throw new Error(`${manifest}: invalid migration id ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) throw new Error(`${manifest}: duplicate migration id "${id}"`);
    seen.add(id);
    if (!PHASES.includes(raw.phase)) {
      throw new Error(
        `${manifest}: migration "${id}" has phase ${JSON.stringify(raw.phase)}; expected one of ${PHASES.join(", ")}`,
      );
    }
    const file = path.join(migrationsDir, `${id}.mjs`);
    if (!fs.existsSync(file)) {
      throw new Error(`${manifest}: migration "${id}" is registered but ${file} does not exist`);
    }
    entries.push({ id, phase: raw.phase, file });
  }
  return phase ? entries.filter((e) => e.phase === phase) : entries;
}
