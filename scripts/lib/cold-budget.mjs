// The cold-embed LEDGER: how much inference one user request may run, how that allowance is
// divided among the reads that share it, and how a shortfall is reported back to the caller.
//
// Split out of embed-chunk.mjs, which owns filling caches and scoring — a different question, and
// the two together exceeded the 300-line module ceiling. Nothing here touches a cache or a vector.

import { embedMaxColdPerRead } from "./settings.mjs";
import { isSystemMaintenance } from "./maintenance-tag.mjs";

/** @typedef {import("./embed-chunk.mjs").ColdBudget} ColdBudget */
/** @typedef {{ skippedLeaves: number, embeddedTexts: number, remedy: string }} ColdShortfall */

// Marks a leaf the cold budget refused: it was never scored, so a caller must
// DROP it rather than treat it as a zero-relevance hit.
export const COLD_SKIP_SCORE = -Infinity;

// How much of the bound each draw must leave behind for the draws after it. DERIVED rather than
// configured: a second knob would have to be kept consistent with the first to mean anything, and
// `settings-defaults.mjs` is at the 300-line ceiling. A quarter of the bound gives the documented
// default (32 -> 8) and scales if the bound is changed.
/** @param {number} maxTexts @returns {number} */
function reserveFloorFor(maxTexts) {
  if (!Number.isFinite(maxTexts) || maxTexts <= 1) return 0;
  return Math.max(1, Math.floor(maxTexts / 4));
}

/**
 * `spent` counts TEXTS actually embedded. `skipped` counts LEAVES DROPPED from the
 * result set — bumped by the caller at the point it drops one, NOT inside `take`:
 * a refused `take` is also how a warm-vector leaf merely DEFERS its chunk
 * refinement, and conflating the two made the counter read as "leaves lost" when
 * nothing had been lost.
 *
 * `makeColdBudget(Infinity)` is the counting-only form: every `take` succeeds, so
 * it bounds nothing and simply reports how much inference a call did. The
 * background warm uses it to tell "this slice did real work" from "this slice was
 * all cache hits" — the difference between pacing correctly and running flat out.
 *
 * `reserveFloor` makes the shared ledger FAIR. Without it the first draw could spend
 * the whole bound, and because a refused leaf is stamped COLD_SKIP_SCORE and then
 * filtered OUT of the result set, every later rung/category returned zero rather
 * than fewer — silently. Each `openDraw()` therefore caps the current draw at
 * `max(floor, remaining - floor)`, keeping a tail for whatever comes next.
 *
 * TOTAL spend is still bounded by `maxTexts`, which is what makes this purely
 * allocative: a cold read costs no more than before, the same texts are just spread
 * across the rungs. A ledger whose `openDraw` is never called (the warm) keeps the
 * full bound as its cap, so those paths are untouched.
 * @param {number} maxTexts
 * @param {number} [reserveFloor] 0 (the default) restores the pre-fair-share behaviour
 * @returns {ColdBudget}
 */
export function makeColdBudget(maxTexts, reserveFloor = 0) {
  // An absolute spend ceiling for the current draw, not a per-draw allowance, so `take`
  // stays a single comparison on the hot path.
  let drawCeiling = maxTexts;
  // Identities of the leaves dropped, not a tally of drop EVENTS. The recall ladder re-scores
  // overlapping candidate sets rung by rung, so one leaf is refused several times per request; a
  // raw counter therefore overstated a number the user is shown and asked to act on.
  /** @type {Set<string>} */
  const skippedKeys = new Set();
  let unkeyedSkips = 0;
  return {
    spent: 0,
    get skipped() {
      return skippedKeys.size + unkeyedSkips;
    },
    openDraw() {
      const remaining = maxTexts - this.spent;
      // A floor at or above the bound cannot reserve anything, so it must not starve THIS
      // draw either — hence max() rather than a subtraction that could go negative.
      const allowance = Math.max(reserveFloor, remaining - reserveFloor);
      drawCeiling = Math.min(maxTexts, this.spent + allowance);
    },
    take(n) {
      if (this.spent + n > drawCeiling) return false;
      this.spent += n;
      return true;
    },
    skipLeaf(key) {
      // An un-keyed caller cannot be deduplicated, so count it rather than collapsing every such
      // call into one.
      if (typeof key === "string" && key) skippedKeys.add(key);
      else unkeyedSkips += 1;
    },
  };
}

// A cold-embed ledger: ONE per user request, shared across every category, wiki
// level and recall rung, so the bound is "this request may run N forward passes"
// — not N per call. It counts TEXTS (chunk sets cost their chunk count; a `full`
// leaf can be 256) because texts are what the model actually runs. Spending is
// all-or-nothing per leaf: a partially embedded chunk set would cache a broken
// entry.
// The ledger a fresh request should carry: the configured bound, or null (no
// bound) inside a maintenance pass.
/**
 * @returns {ColdBudget | null}
 */
export function defaultColdBudget() {
  if (isSystemMaintenance()) return null;
  const max = embedMaxColdPerRead();
  return makeColdBudget(max, reserveFloorFor(max));
}

// Opens the next draw, when the ledger supports it. A null ledger (maintenance) and the
// counting-only warm ledgers have nothing to divide, so this is a no-op for them.
/** @param {ColdBudget | null | undefined} budget @returns {void} */
export function openColdDraw(budget) {
  if (budget && typeof budget.openDraw === "function") budget.openDraw();
}

// What the caller must be told when the bound cut the read short.
//
// This is the ONLY signal that a result set is incomplete: a refused leaf is stamped
// COLD_SKIP_SCORE and filtered out, so a shortened search is byte-indistinguishable from a
// genuinely small one. `skipped` was already counted and simply never read by anything.
/**
 * @param {ColdBudget | null | undefined} budget
 * @returns {ColdShortfall | null}
 */
export function coldShortfall(budget) {
  if (!budget || !budget.skipped) return null;
  return {
    skippedLeaves: budget.skipped,
    embeddedTexts: budget.spent,
    remedy:
      "Some leaves had no cached vector and this read's embedding bound (embed.maxColdPerRead) was reached, so they were EXCLUDED from these results rather than ranked low. Run `cli.mjs warm` to embed the corpus, then repeat the query for complete results.",
  };
}

// Spread-ready form, so a response builder adds one line rather than a conditional.
/** @param {ColdBudget | null | undefined} budget @returns {{ partial?: ColdShortfall }} */
export function coldPartial(budget) {
  const shortfall = coldShortfall(budget);
  return shortfall ? { partial: shortfall } : {};
}
