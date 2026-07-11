import { defaultProjectModule } from "./env.mjs";
import { slugify } from "./slug.mjs";
import { callLLMWithRetry } from "./llm.mjs";
import {
  BAD_AREA,
  crossCuttingAreas,
  validAtomTypes,
  knownAreas,
  tagList,
  inferFacets,
} from "./facets-core.mjs";

/** @typedef {import("./types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("./types.mjs").FacetPatch} FacetPatch */

/**
 * @param {Object} args
 * @param {string} args.category
 * @param {string} args.title
 * @param {string} args.text
 * @param {string[]} args.tags
 * @param {string[]} args.areaChoices
 * @param {string[]} args.typeChoices
 * @param {{ area: boolean, atom_type: boolean }} args.want
 * @returns {Promise<Record<string, unknown>>}
 */
async function classifyWithLLM({ category, title, text, tags, areaChoices, typeChoices, want }) {
  /** @type {string[]} */
  const keys = [];
  if (want.area)
    keys.push(
      `"area": one of ${JSON.stringify(areaChoices)} — the sub-module it belongs to; use a cross-cutting value ONLY for genuinely project-wide content`,
    );
  if (want.atom_type) keys.push(`"atom_type": one of ${JSON.stringify(typeChoices)}`);
  const systemPrompt =
    `You classify a project-memory note into facet metadata for category "${category}". ` +
    `Respond with STRICT JSON only (no prose, no code fences): an object with exactly these keys: ${keys.join("; ")}. ` +
    `Choose the single best value from the allowed list for each key.`;
  const userPrompt =
    `Title: ${String(title || "").slice(0, 200)}\n` +
    `Tags: ${tags.join(", ")}\n\n--- CONTENT ---\n${String(text || "").slice(0, 2000)}`;
  const res = await callLLMWithRetry({ systemPrompt, userPrompt, maxTokens: 200 });
  return res && typeof res === "object" && !Array.isArray(res)
    ? /** @type {Record<string, unknown>} */ (res)
    : {};
}

// ASYNC: heuristic baseline, then ONE LLM call to pin a precise sub-module /
// atom_type when the heuristic could not. Used by the backfill so an offender is
// re-identified accurately. Falls back to the heuristic baseline on any error.
/**
 * @param {{ category?: string, meta?: MetadataInput, title?: string, text?: string, tags?: string | string[] }} [args]
 * @returns {Promise<FacetPatch>}
 */
export async function classifyFacetsLLM({
  category,
  meta = {},
  title = "",
  text = "",
  tags = [],
} = {}) {
  if (category === "daily") return {};
  const base = inferFacets({ category, meta, tags });
  const cc = crossCuttingAreas();
  const areas = knownAreas(/** @type {string} */ (category));
  const subModules = [...areas].filter((a) => !cc.includes(a));
  const validTypes = validAtomTypes(/** @type {string} */ (category));
  const tags2 = tagList(tags);
  const workspace = slugify(defaultProjectModule() || "");

  const origArea = slugify(String(meta.area || "").trim());
  // If the stored area was bad, let the LLM pick a precise sub-module even when
  // the heuristic guessed one from tags (e.g. a cross-repo note tagged with two
  // sub-modules) — this is the one-off backfill, so accuracy beats LLM frugality.
  const wantArea = !origArea || BAD_AREA.has(origArea) || origArea === workspace;

  const origType = String(meta.atom_type || "")
    .trim()
    .toLowerCase();
  const wantAtom = category === "knowledge" && !validTypes.has(origType);

  if (!wantArea && !wantAtom) return base;

  try {
    const llm = await classifyWithLLM({
      category: /** @type {string} */ (category),
      title,
      text,
      tags: tags2,
      areaChoices: [...subModules, ...cc],
      typeChoices: [...validTypes],
      want: { area: wantArea, atom_type: wantAtom },
    });
    const patch = { ...base };
    if (wantArea && llm.area) {
      const a = slugify(String(llm.area));
      if (a && (areas.has(a) || cc.includes(a))) patch.area = a;
    }
    if (wantAtom && llm.atom_type) {
      const t = String(llm.atom_type).trim().toLowerCase();
      if (validTypes.has(t)) patch.atom_type = t;
    }
    return patch;
  } catch {
    return base;
  }
}
