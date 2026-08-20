import { migrateProjectModuleIdentity } from "../../../../migrate-identity.mjs";

// Legacy leaves stamped `project_module` from the workspace BASENAME are
// restamped with the deterministic git/file identity.
//
// An ADAPTER over migrate-identity.mjs, which already exposes a read-only
// `check` mode — exactly the detect() this contract wants.

export const id = "2026/06/11/002-project-identity";
export const title = "project_module restamped to the deterministic git identity";

/** @returns {boolean} */
export function detect() {
  return !migrateProjectModuleIdentity({ check: true }).ok;
}

export function apply() {
  const res = migrateProjectModuleIdentity({});
  return { changed: Number(res.migrated || 0) > 0 };
}
