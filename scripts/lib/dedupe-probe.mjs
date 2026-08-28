import { embedTextForLeaf } from "./wiki-core.mjs";
import { searchMemoryFiltered } from "./wiki-store.mjs";

/**
 * @typedef {Object} DuplicateVerdict
 * @property {"none" | "related" | "duplicate"} verdict
 * @property {number} score top cosine found, 0 when nothing was scored
 * @property {string} [documentId] the nearest leaf, when one was found
 * @property {string} [documentName]
 * @property {string} [reason] set when the probe could not run
 */

// Write-time duplicate detection, as ONE cheap query rather than the exhaustive
// multi-angle search the discipline used to demand before every save.
//
// The thresholds are not new: they are the pair consolidate already uses, and
// they were calibrated empirically for the current embedding model on a 537-leaf
// corpus (true near-duplicates scored >= 0.9925; the closest NON-duplicate pair
// scored < 0.956). Reusing them means "these are the same note" has one
// definition across the write path and the offline pass, and retuning happens in
// one place.
//
// Three bands, so cost tracks the probability of a duplicate actually existing:
//   below probeThreshold      nothing related exists      save silently
//   probeThreshold..duplicate related but distinct        save, report the neighbour
//   at/above duplicate        almost certainly the same   refuse, name the leaf
//
// This runs on the SERVER side of every write door on purpose. A rule asking an
// agent to search first is advice an agent can skip; a check in the save path is
// enforcement. It is also strictly cheaper: one embedding of the draft plus one
// category scan, versus several searches plus a subagent to compare the results.

/**
 * Probe the target category for a leaf that is the same as the one about to be
 * written.
 *
 * FAILS OPEN. If the embedding backend or the search path errors, the verdict is
 * `none` with a `reason`, because a dependency outage must never turn into a save
 * that silently did not happen. The cost of a missed duplicate is one extra leaf
 * that consolidate can merge later; the cost of a refused save is lost work.
 *
 * `search` is injectable so the band logic can be tested without a model: ES
 * module exports are read-only, so there is no way to stub the import.
 * @param {{ dataset: string, name: string, text: string, metadata?: Record<string, unknown>, thresholds: { enabled: boolean, probeThreshold: number, duplicateThreshold: number }, search?: typeof searchMemoryFiltered }} args
 * @returns {Promise<DuplicateVerdict>}
 */
export async function probeForDuplicate({
  dataset,
  name,
  text,
  metadata,
  thresholds,
  search = searchMemoryFiltered,
}) {
  if (!thresholds.enabled) return { verdict: "none", score: 0, reason: "dedupe disabled" };
  try {
    // Embed the DRAFT exactly as a stored leaf would be embedded, so the query
    // and the corpus sit in the same space. This is the same trick consolidate's
    // cluster pass uses when it embeds a leaf as its own query.
    const focus = String((metadata && metadata.subject) || name || "").trim();
    const query = embedTextForLeaf(
      /** @type {import("./types.mjs").LeafFrontmatter} */ ({
        focus: focus || name,
        memory: metadata || {},
      }),
      text,
    );
    const res = await search({
      query,
      datasetId: dataset,
      limit: 1,
      scoreThreshold: thresholds.probeThreshold,
    });
    const top = res?.records?.[0];
    if (!top) return { verdict: "none", score: 0 };
    const score = Number(top.score) || 0;
    // A leaf being REPLACED by name is an upsert, not a duplicate: reporting it
    // would refuse every legitimate edit of an existing leaf.
    if (top.documentName === name) return { verdict: "none", score };
    if (score >= thresholds.duplicateThreshold) {
      return {
        verdict: "duplicate",
        score,
        documentId: top.documentId,
        documentName: top.documentName,
      };
    }
    if (score >= thresholds.probeThreshold) {
      return {
        verdict: "related",
        score,
        documentId: top.documentId,
        documentName: top.documentName,
      };
    }
    return { verdict: "none", score };
  } catch (err) {
    return {
      verdict: "none",
      score: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The refusal message for a duplicate, naming the leaf and the way forward.
 *
 * It has to name BOTH doors: upserting by the same name, and asserting a new
 * leaf. A refusal that only says no turns into a retry loop.
 * @param {DuplicateVerdict} verdict
 * @returns {string}
 */
export function duplicateRefusal(verdict) {
  return (
    `duplicate-suspected: this is ${verdict.score.toFixed(4)} cosine to the existing leaf ` +
    `"${verdict.documentName}" (${verdict.documentId}). Either UPDATE that leaf (save with its ` +
    `name so the write upserts in place), or, if this genuinely records something different, ` +
    `re-send with allowDuplicate:true to assert a new leaf.`
  );
}
