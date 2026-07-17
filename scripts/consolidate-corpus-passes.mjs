// ─── corpus passes ─────────────────────────────────────────────────────────
//
// Corpus-scoped content passes: flag stale leaves, archive orphans, and
// compress old archived bodies. Each runs once after the per-leaf cluster
// loop and is limited to the layout-declared refine-eligible categories.

import {
  consolidateOrphanTtlDays,
  consolidateStaleAfterMonths,
  consolidateArchiveBodyMax,
  consolidateArchiveAgeDays,
} from "./lib/settings.mjs";
import {
  listActiveLeavesForConsolidate,
  readLeafForConsolidate,
  disableDocument,
  truncateArchivedBody,
  listDocuments,
  getCategories,
  isLeafFull,
} from "./lib/wiki-store.mjs";
import { toIso, ageInDays, ageInMonths } from "./consolidate-time.mjs";
import { stampLeafMetadata } from "./consolidate-report.mjs";
import {
  STALENESS_ELIGIBLE_ATOM_TYPES,
  ORPHAN_EXCLUDE_ATOM_TYPES,
} from "./consolidate-constants.mjs";

/** @typedef {import("./consolidate-report.mjs").ConsolidateCtx} ConsolidateCtx */
/** @typedef {import("./consolidate-report.mjs").RunLeaf} RunLeaf */
/** @typedef {import("./consolidate-report.mjs").PassReport} PassReport */
/** @typedef {import("./consolidate-time.mjs").NowInput} NowInput */

/**
 * @returns {string[]}
 */
export function getCategoryListSafe() {
  // Returns the layout-declared category list, or an empty array on error.
  // Empty-on-error is deliberate: with no category list, every category-
  // scoped pass becomes a no-op, which is the safe default. The orchestrator
  // also fails its layout-eligibility check earlier, so this path is rarely
  // reached at all. No fallback to a hardcoded historical default — layout
  // is the only source of truth for which trees exist.
  try {
    return getCategories();
  } catch {
    return [];
  }
}

// 2E — flag stale leaves so the LLM-semantic-refresh pass (3B) can revisit
// them. UNIFORM across every refine-eligible category: a leaf is a
// candidate iff its atom_type is in STALENESS_ELIGIBLE_ATOM_TYPES
// (self-improvement-lesson / bug-root-cause / feedback-rule /
// pattern-gotcha). Category eligibility comes from the layout YAML
// (`consolidate: refine`); the atom-type filter is the within-category
// semantic. NO category-name string is hardcoded here — the layout owns
// "which trees" and atom_types own "which leaves within a tree".
//
// The deterministic flag flips both ways: stale when lastActivity > N
// months; un-flagged otherwise.
/**
 * @param {Object} args
 * @param {ConsolidateCtx} args.ctx
 * @param {NowInput} [args.now]
 * @param {boolean} [args.dryRun]
 */
export function stalenessFlag({ ctx, now, dryRun }) {
  const t0 = Date.now();
  const report = /** @type {PassReport} */ (ctx.report.get("staleness-flag"));
  const months = consolidateStaleAfterMonths();

  /** @type {RunLeaf[]} */
  const candidates = [];
  for (const cat of ctx.refineCategories || []) {
    for (const leaf of listActiveLeavesForConsolidate({ category: cat })) {
      const atom = String(leaf.memory?.atom_type || "");
      if (STALENESS_ELIGIBLE_ATOM_TYPES.has(atom)) {
        candidates.push(/** @type {RunLeaf} */ (leaf));
      }
    }
  }

  for (const leaf of candidates) {
    const m = leaf.memory || {};
    const last = leaf.frontmatter?.updated || null;
    const stale = ageInMonths(last, now) > months;
    if (stale && m.stale !== true) {
      if (!dryRun) stampLeafMetadata(leaf.documentId, { stale: true });
      report.touched++;
    } else if (!stale && m.stale === true) {
      if (!dryRun) stampLeafMetadata(leaf.documentId, { stale: false });
      report.touched++;
    }
  }
  report.ms += Date.now() - t0;
}

// 2F — archive orphan leaves: no inbound `[[link]]`, no non-index `parents:`,
// `frontmatter.updated` older than orphan TTL.
//
// The INBOUND-LINK MAP is built across the WHOLE active wiki (every
// category): a knowledge leaf with one inbound from a plan still counts as
// linked even if `plans` is declared `consolidate: none`. Other categories
// can "save" a refine-eligible leaf from archival.
//
// The ORPHAN-ARCHIVAL DECISION is limited to refine-eligible categories
// (layout-declared `consolidate: refine`). A `consolidate: none` category
// is never mutated by this pass.
/**
 * @param {Object} args
 * @param {ConsolidateCtx} args.ctx
 * @param {NowInput} [args.now]
 * @param {boolean} [args.dryRun]
 */
export function pruneOrphanLeaves({ ctx, now, dryRun }) {
  const t0 = Date.now();
  const report = /** @type {PassReport} */ (ctx.report.get("prune-orphan-leaves"));
  const ttlDays = consolidateOrphanTtlDays();
  const refineSet = new Set(ctx.refineCategories || []);

  /** @type {RunLeaf[]} */
  const allActive = [];
  for (const cat of getCategoryListSafe()) {
    allActive.push(.../** @type {RunLeaf[]} */ (listActiveLeavesForConsolidate({ category: cat })));
  }
  /** @type {Map<string, Set<string>>} */
  const inbound = new Map();
  const linkRe = /\[\[([^\]]+)\]\]/g;
  for (const leaf of allActive) {
    let mm;
    linkRe.lastIndex = 0;
    while ((mm = linkRe.exec(leaf.text)) !== null) {
      const target = mm[1].trim();
      if (!target) continue;
      const set = inbound.get(target) || new Set();
      set.add(leaf.documentId);
      inbound.set(target, set);
    }
    const parents = Array.isArray(leaf.frontmatter?.parents) ? leaf.frontmatter.parents : [];
    for (const p of parents) {
      const pp = String(p || "").trim();
      if (!pp || pp === "index.md") continue;
      const set = inbound.get(pp) || new Set();
      set.add(leaf.documentId);
      inbound.set(pp, set);
    }
  }

  for (const leaf of allActive) {
    // Layout-eligibility guard: never archive a leaf in a non-refine category.
    const cat = String(leaf.documentId).split("/")[0];
    if (!refineSet.has(cat)) continue;
    const m = leaf.memory || {};
    if (ORPHAN_EXCLUDE_ATOM_TYPES.has(String(m.atom_type || ""))) continue;
    if (ageInDays(leaf.frontmatter?.updated, now) <= ttlDays) continue;
    // Has inbound link via document id, leaf name, or frontmatter parent?
    const candidates = [leaf.documentId, leaf.name].filter(Boolean);
    let hasInbound = candidates.some((k) => {
      const set = inbound.get(k);
      return set && set.size > 0;
    });
    if (hasInbound) continue;
    // Last check: frontmatter.parents with a non-index entry counts as linked.
    const parents = Array.isArray(leaf.frontmatter?.parents)
      ? leaf.frontmatter.parents.map((p) => String(p || "").trim()).filter(Boolean)
      : [];
    if (parents.some((p) => p && p !== "index.md")) continue;
    if (dryRun) {
      report.archived++;
      continue;
    }
    try {
      stampLeafMetadata(leaf.documentId, { consolidated_at: toIso(now) });
      disableDocument({ documentId: leaf.documentId });
      ctx.touchedThisRun.add(leaf.documentId);
      report.archived++;
    } catch (err) {
      const e = /** @type {Error} */ (err);
      report.errors++;
      process.stderr.write(
        `[consolidate] orphan archive failed for ${leaf.documentId}: ${e?.message || e}\n`,
      );
    }
  }
  report.ms += Date.now() - t0;
}

// 2G — compress old archived bodies. Keeps the original sha256 in
// frontmatter as the recovery handle (truncateArchivedBody preserves it).
/**
 * @param {Object} args
 * @param {ConsolidateCtx} args.ctx
 * @param {NowInput} [args.now]
 * @param {boolean} [args.dryRun]
 */
export function compressArchived({ ctx, now, dryRun }) {
  const t0 = Date.now();
  const report = /** @type {PassReport} */ (ctx.report.get("compress-archived"));
  const max = consolidateArchiveBodyMax();
  const ageDays = consolidateArchiveAgeDays();
  // Limit body truncation to refine-eligible categories. A `consolidate: none`
  // category's archived leaves are kept verbatim (those trees are owned by
  // other lifecycles — plans/investigations/daily — and shouldn't have their
  // bodies rewritten by consolidate even when archived).
  const refineCats = new Set(ctx.refineCategories || []);
  for (const cat of getCategoryListSafe()) {
    if (!refineCats.has(cat)) continue;
    const { documents } = listDocuments({ datasetId: cat, enabled: false });
    for (const d of documents) {
      const leaf = readLeafForConsolidate({ documentId: d.id });
      if (!leaf) continue;
      const m = leaf.memory || {};
      if (m.status !== "archived") continue;
      if (m.consolidate_truncated_at) continue;
      if (isLeafFull(cat, m)) continue; // a full leaf is a whole document — never compress it
      if (String(leaf.text).length <= max) continue;
      if (ageInDays(leaf.frontmatter?.updated, now) <= ageDays) continue;
      if (dryRun) {
        report.touched++;
        continue;
      }
      try {
        const r = truncateArchivedBody({
          documentId: leaf.documentId,
          max,
          nowIso: toIso(now),
        });
        if (r?.ok) {
          report.touched++;
          report.freedBytes += Number(r.freedBytes) || 0;
        }
      } catch (err) {
        const e = /** @type {Error} */ (err);
        report.errors++;
        process.stderr.write(
          `[consolidate] compress failed for ${leaf.documentId}: ${e?.message || e}\n`,
        );
      }
    }
  }
  report.ms += Date.now() - t0;
}
