#!/usr/bin/env node
// Migrates a pre-settings.yaml install to the new layout. Invoked by
// bootstrap.sh; runnable standalone (`node scripts/migrate-settings.mjs
// <data-dir>`). Idempotent: re-running on an already-migrated install
// detects no-removed-keys + no-old-yaml and exits 0 with no edits.
//
// Migration steps (in order):
//   1. Read old .env + old llm.yaml (if present).
//   2. Build settings.yaml from their values, layered on top of the shipped
//      templates/settings.yaml defaults.
//   3. Back up old .env to .env.bak.
//   4. Rewrite .env to contain ONLY the strict-subset keys.
//   5. Remove old llm.yaml (its content is now in settings.yaml).
//
// Strict-subset keys (these STAY in .env):
//   - ANTHROPIC_API_KEY, OPENAI_API_KEY
//   - MEMORY_LLM_PROVIDER, MEMORY_LLM_MODEL, MEMORY_LLM_BASE_URL,
//     MEMORY_LLM_TIMEOUT_MS, ANTHROPIC_MODEL, OPENAI_MODEL
//   - MEMORY_DATA_DIR, LLM_WIKI_MEMORY_ROOT, MEMORY_SETTINGS_PATH,
//     MEMORY_EMBED_CACHE
//   - MEMORY_DEFAULT_PROJECT_MODULE, LLM_WIKI_MEMORY_PROJECT
//   - MEMORY_LLM_MOCK_RESPONSE, MEMORY_LLM_MOCK_FILE,
//     MEMORY_LLM_MOCK_FAIL_INDICES, MEMORY_LLM_MOCK_FAIL_ERROR
//   - MEMORY_MCP_SERVER_NAME

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { STRICT_KEYS, RENAMED_KEYS, ENV_TO_SETTINGS } from "./migrate-settings-constants.mjs";
import { readEnvLines, serializeEnvStrictSubset } from "./migrate-settings-env.mjs";
import {
  setDeep,
  coerce,
  deepMerge,
  snakeToCamelFlushKeys,
} from "./migrate-settings-transform.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "..");

/**
 * @param {string} dataDir
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} [options]
 */
function migrate(dataDir, { dryRun = false, log = console.error } = {}) {
  const settingsDir = path.join(dataDir, "settings");
  const envPath = path.join(settingsDir, ".env");
  const settingsYamlPath = path.join(settingsDir, "settings.yaml");
  const oldLlmYamlPath = path.join(settingsDir, "llm.yaml");
  const envBakPath = path.join(settingsDir, ".env.bak");

  if (!fs.existsSync(settingsDir)) {
    log(`[migrate-settings] no settings dir at ${settingsDir}; nothing to migrate`);
    return { migrated: false, reason: "no-settings-dir" };
  }

  const { kv: envKv, raw: envRaw, originalText: envOriginal } = readEnvLines(envPath);

  // Rename any old-named env vars to their new names BEFORE detection — so
  // an install that only has MEMORY_LLM_CONFIG_PATH (the old name) is
  // correctly detected as needing migration AND the value is carried
  // forward under MEMORY_SETTINGS_PATH (the new name).
  /** @type {Array<{ oldName: string, newName: string }>} */
  const renamedKeys = [];
  for (const [oldName, newName] of Object.entries(RENAMED_KEYS)) {
    if (
      envKv[oldName] != null &&
      envKv[oldName] !== "" &&
      (envKv[newName] == null || envKv[newName] === "")
    ) {
      envKv[newName] = envKv[oldName];
      envRaw[newName] = envRaw[oldName];
      renamedKeys.push({ oldName, newName });
    }
    // Drop the old key from the kv either way so it never lands in the
    // rewritten .env (strict subset has only the new name).
    delete envKv[oldName];
    delete envRaw[oldName];
  }

  const hasRemovedEnvKeys = Object.keys(envKv).some((k) => k in ENV_TO_SETTINGS);
  const hasOldLlmYaml = fs.existsSync(oldLlmYamlPath);
  const hasSettingsYaml = fs.existsSync(settingsYamlPath);
  const hasRenamedKeys = renamedKeys.length > 0;

  // Idempotency: if nothing changed (no removed keys, no llm.yaml, no
  // renames) AND settings.yaml already exists, we're done.
  if (!hasRemovedEnvKeys && !hasOldLlmYaml && !hasRenamedKeys && hasSettingsYaml) {
    log(`[migrate-settings] already migrated; nothing to do`);
    return { migrated: false, reason: "already-migrated" };
  }
  // Fresh install: bootstrap.sh handles materialising the template; nothing
  // to migrate (no source data to carry forward).
  if (!hasRemovedEnvKeys && !hasOldLlmYaml && !hasRenamedKeys && !hasSettingsYaml) {
    log(`[migrate-settings] fresh install; bootstrap will materialise templates`);
    return { migrated: false, reason: "fresh-install" };
  }

  // Build the settings.yaml content, layered: template defaults → existing
  // settings.yaml (if present) → migrated old llm.yaml (if present) →
  // migrated env values.
  //
  // safeParse: a malformed source YAML (e.g. an existing settings.yaml or
  // llm.yaml truncated by a crash, or a hand-edit typo) must NOT throw and
  // abort the whole migration — that would revert the operator's config to
  // bare defaults AND wedge migration on every re-run. Fall back to {} for the
  // one bad file (loud WARNING) and migrate the rest.
  /**
   * @param {string} label
   * @param {string} p
   * @returns {Record<string, unknown>}
   */
  const safeParse = (label, p) => {
    try {
      return /** @type {Record<string, unknown>} */ (parseYaml(fs.readFileSync(p, "utf8")) || {});
    } catch (err) {
      log(
        `[migrate-settings] WARNING: ${label} at ${p} is malformed (${/** @type {{ message?: string }} */ (err)?.message || err}); ignoring it for this migration — review/fix it.`,
      );
      return {};
    }
  };
  const templatePath = path.join(SRC_DIR, "templates", "settings.yaml");
  const templateYaml = fs.existsSync(templatePath)
    ? safeParse("shipped template", templatePath)
    : {};
  const existingYaml = hasSettingsYaml ? safeParse("existing settings.yaml", settingsYamlPath) : {};
  const oldLlmYaml = hasOldLlmYaml ? safeParse("old llm.yaml", oldLlmYamlPath) : {};

  // Merge in priority order (last wins).
  const merged = /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(templateYaml)));
  // Merge precedence (lowest → highest):
  //   template defaults  <  old llm.yaml (v1-era providers/flush)
  //                      <  migrated env values  <  EXISTING settings.yaml.
  // The existing settings.yaml wins LAST and over everything because it is
  // the current source of truth and may carry a deliberate HAND-EDIT. The
  // normal first-upgrade has no existing settings.yaml (existingYaml === {}),
  // so this ordering is a no-op there; it only matters in the narrow window
  // where a prior migration wrote settings.yaml but crashed before shrinking
  // .env — on re-run the operator's edits must not be reverted by the stale
  // env values being re-applied.
  if (oldLlmYaml.providers) deepMerge(merged, { providers: oldLlmYaml.providers });
  if (oldLlmYaml.flush) deepMerge(merged, { flush: snakeToCamelFlushKeys(oldLlmYaml.flush) });

  /** @type {string[]} */
  const appliedEnvKeys = [];
  /** @type {Array<{ envKey: string, raw: string, yamlPath: string }>} */
  const droppedEnvKeys = [];
  for (const [envKey, yamlPath] of Object.entries(ENV_TO_SETTINGS)) {
    if (envKv[envKey] == null || envKv[envKey] === "") continue;
    const coerced = coerce(yamlPath, envKv[envKey]);
    if (coerced === null) {
      // A non-empty value that failed type coercion (e.g. cosine="0.9x").
      // Don't silently vanish it — record so we can warn the operator.
      droppedEnvKeys.push({ envKey, raw: envKv[envKey], yamlPath });
      continue;
    }
    setDeep(merged, yamlPath, coerced);
    appliedEnvKeys.push(envKey);
  }

  // Existing settings.yaml applied LAST so hand-edits beat migrated env values.
  deepMerge(merged, existingYaml);

  const newEnvText = serializeEnvStrictSubset(envKv, envRaw);

  if (dryRun) {
    return {
      migrated: true,
      dryRun: true,
      appliedEnvKeys,
      droppedEnvKeys,
      settingsYamlText: stringifyYaml(merged),
      newEnvText,
      envBakWouldBeWritten: envOriginal !== "",
      oldLlmYamlWouldBeRemoved: hasOldLlmYaml,
    };
  }

  // Write outputs atomically (temp+fsync+rename). A bare writeFileSync that a
  // crash truncates would leave a corrupt settings.yaml that the idempotent
  // re-run then treats as a trusted hand-edit and bakes in — the exact
  // partial-write corruption class proven live in the disk-full incident.
  // Order: back up the original .env FIRST (fully durable), then settings.yaml,
  // then the shrunk .env, then drop llm.yaml.
  if (envOriginal !== "") writeFileAtomic(envBakPath, envOriginal, { mode: 0o600 });
  writeFileAtomic(settingsYamlPath, stringifyYaml(merged));
  writeFileAtomic(envPath, newEnvText);
  if (hasOldLlmYaml) fs.rmSync(oldLlmYamlPath, { force: true });

  for (const k of appliedEnvKeys) {
    log(
      `[migrate-settings] migrated ${k} → settings.yaml: ${/** @type {Record<string, string>} */ (ENV_TO_SETTINGS)[k]}`,
    );
  }
  for (const { envKey, raw, yamlPath } of droppedEnvKeys) {
    // Loud, not silent: the operator set a value that isn't a valid number/
    // bool, so it can't migrate. settings.yaml keeps the default; tell them.
    log(
      `[migrate-settings] WARNING: dropped ${envKey}=${raw} (not a valid value for ${yamlPath}); settings.yaml keeps the default — review it.`,
    );
  }
  for (const { oldName, newName } of renamedKeys) {
    log(`[migrate-settings] renamed ${oldName} → ${newName} (kept in .env strict subset)`);
  }
  if (hasOldLlmYaml) log(`[migrate-settings] merged + removed old llm.yaml`);
  log(
    `[migrate-settings] wrote ${settingsYamlPath}; .env shrunk to ${Object.keys(envKv).filter((k) => STRICT_KEYS.has(k)).length} strict key(s); backup at ${envBakPath}`,
  );

  return {
    migrated: true,
    appliedEnvKeys,
    droppedEnvKeys,
    renamedKeys,
    envBakPath,
    settingsYamlPath,
  };
}

// CLI entrypoint.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.argv[2] || process.env.MEMORY_DATA_DIR;
  if (!dataDir) {
    process.stderr.write("usage: migrate-settings.mjs <data-dir>\n");
    process.exit(64);
  }
  const dryRun = process.argv.includes("--dry-run");
  try {
    const result = migrate(dataDir, { dryRun });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[migrate-settings] failed: ${/** @type {{ message?: string }} */ (err)?.message || err}\n`,
    );
    process.exit(1);
  }
}

export { migrate, ENV_TO_SETTINGS, STRICT_KEYS };
