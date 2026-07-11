import { KNOWN_PROVIDERS } from "./settings.mjs";

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normaliseModels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => String(m || "").trim()).filter(Boolean);
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normaliseChain(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of raw) {
    const name = String(entry || "")
      .trim()
      .toLowerCase();
    if (!name || !KNOWN_PROVIDERS.includes(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

// Strict numeric parse for YAML-sourced fields. Accepts a real finite number
// or a NON-EMPTY fully-numeric string; rejects null / "" / "  " / arrays /
// objects / booleans / "high". CRITICAL: `Number("")`, `Number(null)`, and
// `Number([])` all return 0 — which would pass a [0,1] range check and silently
// produce a catastrophic `cosineThreshold: 0` (the dedup pass then archives
// every cluster member). So we must reject those BEFORE any range test.
/**
 * @param {unknown} v
 * @returns {number | null}
 */
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Defensive coercion for YAML-sourced typed fields. Each returns the value
// when it's the right shape, else the supplied structural default.
/**
 * @param {unknown} v
 * @param {number} def
 * @returns {number}
 */
export function coercePos(v, def) {
  const n = toNumber(v);
  return n !== null && n > 0 ? n : def;
}
/**
 * @param {unknown} v
 * @param {number} def
 * @returns {number}
 */
export function coerceNonNeg(v, def) {
  const n = toNumber(v);
  return n !== null && n >= 0 ? n : def;
}
/**
 * @param {unknown} v
 * @param {number} def
 * @returns {number}
 */
export function coerceFloat01(v, def) {
  const n = toNumber(v);
  return n !== null && n >= 0 && n <= 1 ? n : def;
}

// Band floor for the LLM-only merge band. null/0/absent disables the band;
// anything outside [0.8, threshold) also disables it (fail-safe OFF — a low
// floor must never silently widen the deterministic-archive surface).
/**
 * @param {unknown} v
 * @param {number} threshold
 * @returns {number | null}
 */
export function coerceBandFloor(v, threshold) {
  const n = toNumber(v);
  if (n === null || n <= 0) return null;
  if (n < 0.8 || n >= threshold) return null;
  return n;
}
/**
 * @param {unknown} v
 * @param {boolean} def
 * @returns {boolean}
 */
export function coerceBool(v, def) {
  if (typeof v === "boolean") return v;
  return def;
}

/**
 * @param {Record<string, unknown>} into
 * @param {unknown} on
 * @returns {Record<string, unknown>}
 */
export function deepMerge(into, on) {
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
      into[k] = deepMerge({ .../** @type {Record<string, unknown>} */ (into[k]) }, v);
    } else {
      into[k] = v;
    }
  }
  return into;
}
