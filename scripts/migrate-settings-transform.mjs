import { BOOL_KEYS, FLOAT_KEYS } from "./migrate-settings-constants.mjs";

/**
 * @param {Record<string, unknown>} obj
 * @param {string} dotted
 * @param {unknown} value
 */
function setDeep(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = /** @type {Record<string, unknown>} */ (cur[k]);
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * @param {string} yamlPath
 * @param {string | null | undefined} raw
 * @returns {boolean | number | string | string[] | null}
 */
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
    return String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
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

/**
 * @param {Record<string, unknown>} into
 * @param {unknown} on
 * @returns {Record<string, unknown>}
 */
function deepMerge(into, on) {
  if (!on || typeof on !== "object") return into;
  for (const [k, v] of Object.entries(on)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      into[k] &&
      typeof into[k] === "object" &&
      !Array.isArray(into[k])
    ) {
      deepMerge(/** @type {Record<string, unknown>} */ (into[k]), v);
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
/**
 * @param {unknown} flushBlock
 * @returns {unknown}
 */
function snakeToCamelFlushKeys(flushBlock) {
  if (!flushBlock || typeof flushBlock !== "object") return flushBlock;
  /** @type {Record<string, string>} */
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
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(flushBlock)) out[map[k] || k] = v;
  return out;
}

export { setDeep, coerce, deepMerge, snakeToCamelFlushKeys };
