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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "..");

const STRICT_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_MODEL",
  "MEMORY_LLM_PROVIDER",
  "MEMORY_LLM_MODEL",
  "MEMORY_LLM_BASE_URL",
  "MEMORY_LLM_TIMEOUT_MS",
  "MEMORY_DATA_DIR",
  "LLM_WIKI_MEMORY_ROOT",
  "MEMORY_SETTINGS_PATH",
  "MEMORY_EMBED_CACHE",
  "MEMORY_EMBED_CACHE_DIR",
  "MEMORY_DEFAULT_PROJECT_MODULE",
  "LLM_WIKI_MEMORY_PROJECT",
  "MEMORY_LLM_MOCK_RESPONSE",
  "MEMORY_LLM_MOCK_FILE",
  "MEMORY_LLM_MOCK_FAIL_INDICES",
  "MEMORY_LLM_MOCK_FAIL_ERROR",
  "MEMORY_MCP_SERVER_NAME",
]);

// Env vars renamed in the v2 release: the migrator copies their old value
// to the new name when only the old name is set, so an upgrade preserves
// the user's choice.
const RENAMED_KEYS = {
  MEMORY_LLM_CONFIG_PATH: "MEMORY_SETTINGS_PATH",
};

// Old env var → settings.yaml dotted path. When the old value's range or
// type isn't trivially compatible (e.g. CSV → list) the migrate function
// handles it inline.
const ENV_TO_SETTINGS = {
  MEMORY_CONSOLIDATE_INTERVAL_DAYS: "consolidate.intervalDays",
  MEMORY_CONSOLIDATE_COSINE_THRESHOLD: "consolidate.cosineThreshold",
  MEMORY_CONSOLIDATE_COSINE_LEXICAL_THRESHOLD: "consolidate.cosineLexicalThreshold",
  MEMORY_CONSOLIDATE_CLUSTER_TOP_K: "consolidate.clusterTopK",
  MEMORY_CONSOLIDATE_CLUSTER_SCORE_THRESHOLD: "consolidate.clusterScoreThreshold",
  MEMORY_CONSOLIDATE_ORPHAN_TTL_DAYS: "consolidate.orphanTtlDays",
  MEMORY_CONSOLIDATE_STALE_AFTER_MONTHS: "consolidate.staleAfterMonths",
  MEMORY_CONSOLIDATE_ARCHIVE_BODY_MAX: "consolidate.archiveBodyMax",
  MEMORY_CONSOLIDATE_ARCHIVE_AGE_DAYS: "consolidate.archiveAgeDays",
  MEMORY_CONSOLIDATE_PASSES: "consolidate.passes",
  MEMORY_CONSOLIDATE_LLM_PASSES: "consolidate.llmPassesEnabled",
  MEMORY_CONSOLIDATE_LLM_MAX_RETRIES: "consolidate.llmMaxRetries",
  MEMORY_CONSOLIDATE_REFRESH_MAX_PER_RUN: "consolidate.refreshMaxPerRun",

  MEMORY_FLUSH_SLOT: "flush.slot",
  MEMORY_FLUSH_DISTILL_ATTEMPTS: "flush.distillAttempts",
  MEMORY_FLUSH_DISTILL_RETRY_MS: "flush.distillRetryMs",
  MEMORY_FLUSH_LOCK_STALE_MS: "flush.lockStaleMs",
  MEMORY_FLUSH_CHUNK_TARGET_K: "flush.chunkTargetK",
  MEMORY_FLUSH_CHUNK_PARALLELISM: "flush.chunkParallelism",
  MEMORY_FLUSH_REDUCE_MAX_CHARS: "flush.reduceMaxChars",
  MEMORY_FLUSH_RAW_FALLBACK_CHARS: "flush.rawFallbackChars",

  MEMORY_HOOK_MAX_TURNS: "hook.maxTurns",
  MEMORY_HOOK_MAX_CHARS: "hook.maxChars",
  MEMORY_HOOK_SESSION_END_MIN_TURNS: "hook.sessionEndMinTurns",
  MEMORY_HOOK_PRECOMPACT_MIN_TURNS: "hook.precompactMinTurns",
  MEMORY_HOOK_EXITPLANMODE_DISABLE: "hook.exitPlanModeDisable",
  MEMORY_HOOK_EXITPLANMODE_MAX_BYTES: "hook.exitPlanModeMaxBytes",

  MEMORY_EMBED_BACKEND: "embed.backend",
  MEMORY_EMBED_MODEL: "embed.model",

  MEMORY_RECALL_SCORE_THRESHOLD: "recall.scoreThreshold",
  MEMORY_RECALL_TOUCH: "recall.touchEnabled",
  MEMORY_RECALL_TOUCH_MIN_HOURS: "recall.touchMinHours",

  MEMORY_COMPILE_SLOT: "compile.slot",
  MEMORY_COMPILE_SEARCH_LIMIT: "compile.searchLimit",
  MEMORY_ATOM_BODY_MAX_CHARS: "compile.atomBodyMaxChars",
  MEMORY_COMPILE_QUALITY_STRICT: "compile.qualityStrict",
  MEMORY_COMPILE_LOCK_STALE_MS: "compile.lockStaleMs",
  MEMORY_COMPILE_METADATA_RETRY_LIMIT: "compile.metadataRetryLimit",

  MEMORY_GC_INTERVAL_DAYS: "gc.intervalDays",

  MEMORY_WRITE_GATE_SELF_IMPROVEMENT: "gate.selfImprovementEnabled",

  MEMORY_CROSS_CUTTING_AREAS: "crossCuttingAreas",
};

const BOOL_KEYS = new Set([
  "consolidate.llmPassesEnabled",
  "hook.exitPlanModeDisable",
  "recall.touchEnabled",
  "compile.qualityStrict",
  "gate.selfImprovementEnabled",
]);

const FLOAT_KEYS = new Set([
  "consolidate.cosineThreshold",
  "consolidate.cosineLexicalThreshold",
  "consolidate.clusterScoreThreshold",
  "recall.scoreThreshold",
]);

function parseEnvValue(raw) {
  let v = String(raw ?? "").trim();
  if (!v) return "";
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end !== -1) return v.slice(1, end);
    return v;
  }
  if (v[0] === "#") return "";
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash);
  return v.trim();
}

function readEnvLines(file) {
  if (!fs.existsSync(file)) return { kv: {}, raw: {}, originalText: "" };
  const text = fs.readFileSync(file, "utf8");
  const kv = {};
  const raw = {};
  for (const line of text.split(/\r?\n/)) {
    const trim = line.trim();
    if (!trim || trim.startsWith("#")) continue;
    const i = trim.indexOf("=");
    if (i === -1) continue;
    const key = trim.slice(0, i).trim();
    const rhs = trim.slice(i + 1);
    kv[key] = parseEnvValue(rhs);
    raw[key] = rhs;
  }
  return { kv, raw, originalText: text };
}

function setDeep(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function coerce(yamlPath, raw) {
  if (raw === "" || raw == null) return null;
  if (BOOL_KEYS.has(yamlPath)) {
    const s = String(raw).trim().toLowerCase();
    if (["1", "on", "true", "yes"].includes(s)) return true;
    if (["0", "off", "false", "no"].includes(s)) return false;
    return null;
  }
  if (FLOAT_KEYS.has(yamlPath)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (yamlPath === "crossCuttingAreas") {
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  }
  // Integer-looking values: parse as int when possible (cosmetic only —
  // YAML stores them as numbers either way).
  const intMatch = /^-?\d+$/.test(String(raw).trim());
  if (intMatch) {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  // Otherwise keep as string.
  return String(raw);
}

function serializeEnvStrictSubset(originalKv, originalRaw = {}) {
  // Carry forward only the strict-subset keys. Preserve their existing
  // values verbatim from the old .env; everything else is dropped (the
  // user is told via the runbook that comments next to removed keys are
  // gone in the migration).
  const lines = [
    "# llm-wiki-memory secrets + provider switches + paths.",
    "# Application config lives in ./settings.yaml — this file only carries",
    "# the strict subset that genuinely needs shell precedence:",
    "#   - API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY)",
    "#   - Provider switches (MEMORY_LLM_*)",
    "#   - Deployment paths (MEMORY_DATA_DIR, LLM_WIKI_MEMORY_ROOT, etc.)",
    "#   - Workspace identity (MEMORY_DEFAULT_PROJECT_MODULE)",
    "#   - Test seams (MEMORY_LLM_MOCK_*)",
    "# Everything else — consolidate / flush / hook / embed / recall / compile",
    "# / gc / gate / providers — is in ./settings.yaml.",
    "",
  ];
  for (const key of STRICT_KEYS) {
    if (originalKv[key] != null && originalKv[key] !== "") {
      // Re-emit the ORIGINAL raw RHS text so quotes, spaces and inline '#'
      // survive the round-trip; the PARSED value strips quotes and truncates
      // at ' #', so emitting it would corrupt such values (e.g. mock seams).
      const value = originalRaw[key] != null ? originalRaw[key] : originalKv[key];
      lines.push(`${key}=${value}`);
    }
  }
  return lines.join("\n") + "\n";
}

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
  const renamedKeys = [];
  for (const [oldName, newName] of Object.entries(RENAMED_KEYS)) {
    if (envKv[oldName] != null && envKv[oldName] !== "" && (envKv[newName] == null || envKv[newName] === "")) {
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
  const safeParse = (label, p) => {
    try {
      return parseYaml(fs.readFileSync(p, "utf8")) || {};
    } catch (err) {
      log(`[migrate-settings] WARNING: ${label} at ${p} is malformed (${err?.message || err}); ignoring it for this migration — review/fix it.`);
      return {};
    }
  };
  const templatePath = path.join(SRC_DIR, "templates", "settings.yaml");
  const templateYaml = fs.existsSync(templatePath) ? safeParse("shipped template", templatePath) : {};
  const existingYaml = hasSettingsYaml ? safeParse("existing settings.yaml", settingsYamlPath) : {};
  const oldLlmYaml = hasOldLlmYaml ? safeParse("old llm.yaml", oldLlmYamlPath) : {};

  // Merge in priority order (last wins).
  const merged = JSON.parse(JSON.stringify(templateYaml));
  function deepMerge(into, on) {
    if (!on || typeof on !== "object") return into;
    for (const [k, v] of Object.entries(on)) {
      if (v && typeof v === "object" && !Array.isArray(v) && into[k] && typeof into[k] === "object" && !Array.isArray(into[k])) {
        deepMerge(into[k], v);
      } else {
        into[k] = v;
      }
    }
    return into;
  }
  // Normalise the OLD llm.yaml's snake_case flush keys to the new
  // camelCase schema; without this, both forms coexist in the merged
  // file and a reader looking for `chunkTargetK` finds the right value
  // but the file is noisy.
  function snakeToCamelFlushKeys(flushBlock) {
    if (!flushBlock || typeof flushBlock !== "object") return flushBlock;
    const map = {
      chunk_target_k: "chunkTargetK",
      chunk_parallelism: "chunkParallelism",
      reduce_max_chars: "reduceMaxChars",
      reduce_model_promote: "reduceModelPromote",
      raw_fallback_chars: "rawFallbackChars",
      distill_attempts: "distillAttempts",
      distill_retry_ms: "distillRetryMs",
      lock_stale_ms: "lockStaleMs",
    };
    const out = {};
    for (const [k, v] of Object.entries(flushBlock)) out[map[k] || k] = v;
    return out;
  }
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

  const appliedEnvKeys = [];
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
    log(`[migrate-settings] migrated ${k} → settings.yaml: ${ENV_TO_SETTINGS[k]}`);
  }
  for (const { envKey, raw, yamlPath } of droppedEnvKeys) {
    // Loud, not silent: the operator set a value that isn't a valid number/
    // bool, so it can't migrate. settings.yaml keeps the default; tell them.
    log(`[migrate-settings] WARNING: dropped ${envKey}=${raw} (not a valid value for ${yamlPath}); settings.yaml keeps the default — review it.`);
  }
  for (const { oldName, newName } of renamedKeys) {
    log(`[migrate-settings] renamed ${oldName} → ${newName} (kept in .env strict subset)`);
  }
  if (hasOldLlmYaml) log(`[migrate-settings] merged + removed old llm.yaml`);
  log(`[migrate-settings] wrote ${settingsYamlPath}; .env shrunk to ${Object.keys(envKv).filter((k) => STRICT_KEYS.has(k)).length} strict key(s); backup at ${envBakPath}`);

  return { migrated: true, appliedEnvKeys, droppedEnvKeys, renamedKeys, envBakPath, settingsYamlPath };
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
    process.stderr.write(`[migrate-settings] failed: ${err?.message || err}\n`);
    process.exit(1);
  }
}

export { migrate, ENV_TO_SETTINGS, STRICT_KEYS };
