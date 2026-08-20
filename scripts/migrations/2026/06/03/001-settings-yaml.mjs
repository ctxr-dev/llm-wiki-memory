import { migrate } from "../../../../migrate-settings.mjs";

// Application config moved from `.env` into `settings/settings.yaml`; every
// MEMORY_* env var outside the strict allow-list became a silent no-op.
//
// An ADAPTER: the migration logic and its own tests stay in migrate-settings.mjs.
// This file only declares WHEN it is needed and delegates, so folding it into the
// registry changed no behaviour.

export const id = "2026/06/03/001-settings-yaml";
export const title = "settings.yaml replaces .env application config";

// migrate() reports what it WOULD do under dryRun; anything other than a
// no-op reason means this install still carries the old shape.
const SETTLED = new Set(["already-migrated", "fresh-install", "no-settings-dir"]);

/** @param {{ dataDir: string }} ctx @returns {boolean} */
export function detect({ dataDir }) {
  const res = migrate(dataDir, { dryRun: true, log: () => {} });
  return !(res.migrated === false && SETTLED.has(String(res.reason)));
}

/** @param {{ dataDir: string }} ctx */
export function apply({ dataDir }) {
  const res = migrate(dataDir, { dryRun: false });
  return { changed: res.migrated !== false };
}
