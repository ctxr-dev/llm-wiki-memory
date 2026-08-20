import { embedBackend } from "./settings.mjs";

// Which embedding backend is actually serving right now, and the retryable
// fallback window that governs it.
//
// One state machine, one owner. A model-load failure degrades recall to lexical
// similarity rather than hard-failing, but only for FALLBACK_RETRY_MS — a
// permanent latch once let a degraded process re-stamp real caches lexical/256.
//
// Deliberately knows nothing about workers, inference, or the cache. The cache
// layer depends on THIS module (it must know the resolved backend to stamp and
// to refuse a downgrade); nothing here depends on the cache.

/** @type {string | null} */
let _backend = null; // "transformers" | "lexical"
let _fallbackUntil = 0;
let _warnedDowngrade = false;
const FALLBACK_RETRY_MS = 30_000;

/** @returns {string} */
export function configuredBackend() {
  return (embedBackend() || "").toLowerCase();
}

/**
 * @param {string | null} active @param {number} fallbackUntil @param {number} now @returns {boolean}
 */
export function fallbackActive(active, fallbackUntil, now) {
  return active === "lexical" && fallbackUntil > now;
}

// Degraded = a model backend was configured but recall resolved to lexical.
// Keyed on `!== "lexical"` so a misspelled backend value can't slip the guard.
/**
 * @param {string} configured @param {string | null} active @returns {boolean}
 */
export function persistSuspended(configured, active) {
  return configured !== "lexical" && active === "lexical";
}

/** @returns {boolean} */
export function inFallbackWindow() {
  return fallbackActive(_backend, _fallbackUntil, Date.now());
}

// The RAW resolved backend — null until the first embed settles it. Distinct
// from activeBackend(), which substitutes the optimistic default. The persistence
// guard needs the raw value: "not yet resolved" is not the same as "transformers".
/** @returns {string | null} */
export function resolvedBackend() {
  return _backend;
}

/** @returns {string} */
export function activeBackend() {
  return _backend || configuredBackend() || "transformers";
}

/** The configured backend won; clear the fallback window. @returns {void} */
export function noteSuccess() {
  _backend = "transformers";
  _fallbackUntil = 0;
  _warnedDowngrade = false;
}

/** Force the resolved backend to lexical without opening a retry window. @returns {void} */
export function noteForcedLexical() {
  _backend = "lexical";
}

// Warn at most once per window, THEN mutate: the warning is suppressed while a
// window is already open, so mutating first would silence the first report.
/**
 * @param {unknown} err
 * @returns {void}
 */
export function noteFallback(err) {
  if (!inFallbackWindow()) {
    process.stderr.write(
      `embed.mjs: transformer backend unavailable (${err instanceof Error ? err.message : err}); serving lexical similarity in-memory, cache persistence suspended, retrying the model in ${FALLBACK_RETRY_MS / 1000}s\n`,
    );
  }
  _backend = "lexical";
  _fallbackUntil = Date.now() + FALLBACK_RETRY_MS;
}

// One-shot cache-persistence-suspended warning. The latch and the write it guards
// stay ATOMIC and in this order — write first, arm second — so a throwing stderr
// (a destroyed stream in a piped one-shot CLI) leaves the latch unarmed and the
// diagnostic is retried, exactly as the pre-split code did. Splitting this into a
// read + a separate mark would reintroduce that window.
// The message is built by the caller: the wording is a cache concern, the latch is
// ours (it is cleared by backend recovery, not by the cache).
/** @param {string} message @returns {boolean} whether this call emitted it */
export function warnDowngradeOnce(message) {
  if (_warnedDowngrade) return false;
  process.stderr.write(message);
  _warnedDowngrade = true;
  return true;
}

// `__` prefix deliberate: a TEST-HARNESS mutator on a production module. One call
// clears the resolved backend, the open fallback window AND the downgrade latch, so
// calling it from production would silently make the next embedMany retry the model
// instead of serving lexical. The prefix is the signal that it is off-limits.
/**
 * @param {{ backend?: string | null, fallbackUntil?: number }} [state]
 * @returns {void}
 */
export function __resetForTest({ backend = null, fallbackUntil = 0 } = {}) {
  _backend = backend;
  _fallbackUntil = fallbackUntil;
  _warnedDowngrade = false;
}
