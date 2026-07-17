import path from "node:path";
import { slugify } from "./slug.mjs";
import { classifyWithLLM } from "./facets-classify-llm.mjs";
import { knownAreas, validAtomTypes } from "./facets-core.mjs";
import { placementDirForMeta, remapUnknownPathFacets } from "./wiki-placement.mjs";
import {
  placementRulesFor,
  vocabularyFor,
  categoryHasTopology,
  isFullCategory,
  getCategories,
} from "./wiki-layout-state.mjs";
import { SELF_IMPROVEMENT } from "./wiki-layout-parse.mjs";
import { findByName, root } from "./wiki-core.mjs";
import { toRel } from "./wiki-identity.mjs";
import { saveDocument } from "./wiki-mutate.mjs";

// Absorb a WHOLE external markdown document into a wiki as one full leaf: the
// model infers where within a (caller-named) facet-placed category it belongs,
// the caller may override, and the body is stored verbatim + marked full so it
// is embedded whole. Gated (self_improvement) and topology (issues) categories
// are refused — they can't be auto-placed from content.

/**
 * The leaf title: the first ATX `# ` heading, else a slug of the name.
 * @param {string} text @param {string} name @returns {string}
 */
function deriveTitle(text, name) {
  const m = String(text || "").match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return slugify(String(name || "").replace(/\.[a-z0-9]+$/i, "")) || "untitled";
}

/**
 * @param {{ text: string, name: string, category: string, overrides?: Record<string, unknown>, dryRun?: boolean }} args
 * @returns {Promise<{ id?: string, category: string, dir: string, name: string, metadata: Record<string, unknown> }>}
 */
export async function absorbDocument({ text, name, category, overrides = {}, dryRun = false }) {
  const body = String(text || "");
  if (!body.trim()) throw new Error("absorb: empty document (nothing to absorb)");
  if (!name) throw new Error("absorb: a leaf name is required");
  const cats = getCategories();
  if (!cats.includes(category))
    throw new Error(`absorb: unknown category '${category}' (declared: ${cats.join(", ")})`);
  if (category === SELF_IMPROVEMENT)
    throw new Error("absorb: the gated 'self_improvement' category is not an absorb target");
  if (categoryHasTopology(category))
    throw new Error(
      `absorb: '${category}' is a topology category — it needs explicit path facets, not content auto-placement`,
    );

  const title = deriveTitle(body, name);
  const subjRule = (placementRulesFor(category) || {}).subject;
  const vocab = subjRule && subjRule.vocabulary ? vocabularyFor(subjRule.vocabulary) : null;
  const subjectChoices = vocab ? [...vocab] : [];
  /** @type {Record<string, unknown>} */
  let inferred = {};
  try {
    inferred = await classifyWithLLM({
      category,
      title,
      text: body,
      tags: [],
      areaChoices: [...knownAreas(category)],
      typeChoices: [...validAtomTypes(category)],
      subjectChoices,
      want: { area: true, atom_type: true, subject: subjectChoices.length > 0 },
    });
  } catch {
    // LLM unavailable/offline — place under the sentinel area; subject omitted so
    // placement applies its own fallback. Never hard-fail an import.
    inferred = { area: "unscoped" };
  }

  // Remap any out-of-vocab path facet to its fallback so placement can't throw.
  const { metadata } = remapUnknownPathFacets(category, { ...inferred, ...overrides, title });
  // Mark full unless the whole category already is — so the leaf embeds whole.
  if (!isFullCategory(category)) metadata.full = true;

  // Idempotent: if a leaf with this name already exists ANYWHERE in the category,
  // overwrite it in place (reuse its dir) — re-absorbing never duplicates even if
  // the model now infers a different area/subject.
  const existing = findByName(path.join(root(), category), name);
  let dir;
  if (existing) {
    dir = path.posix.dirname(toRel(existing));
  } else {
    try {
      dir = placementDirForMeta(category, metadata);
    } catch {
      // A caller-supplied override subject that is out-of-vocab AND whose layout
      // fallback is itself out-of-vocab still throws past the remap. Drop subject
      // (from placement AND the stored metadata) and let the empty→fallback path
      // place it, so absorb never hard-fails on placement.
      delete metadata.subject;
      dir = placementDirForMeta(category, metadata);
    }
  }
  if (!dir)
    throw new Error(`absorb: category '${category}' has no facet placement (not an absorb target)`);

  if (dryRun) return { category, dir, name, metadata };
  const res = saveDocument({
    name,
    text: body,
    datasetId: category,
    metadata,
    placementOverride: dir,
  });
  return { id: res?.created?.document?.id, category, dir, name, metadata };
}
