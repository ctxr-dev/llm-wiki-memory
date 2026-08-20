import { loadEngine } from "./engine.mjs";
import { knownAreas } from "../../../scripts/lib/facets-core.mjs";

/**
 * @param {any} core @param {string} absDir @param {Set<string>} into
 */
function collectSubjects(core, absDir, into) {
  let leaves;
  try {
    leaves = core.walkLeaves(absDir);
  } catch {
    return;
  }
  for (const leaf of leaves) {
    let data;
    try {
      data = core.readLeaf(leaf).data;
    } catch {
      continue;
    }
    const mem = core.leafMemory(data);
    const subjects = Array.isArray(mem?.subject) ? mem.subject : [];
    for (const subject of subjects) {
      const value = String(subject).trim();
      if (value) into.add(value);
    }
  }
}

/**
 * Facet help + autocomplete values for one wiki: the per-facet help metadata
 * (built-in defaults + layout overrides), the distinct areas already in use,
 * and the subject suggestions (declared vocabulary + distinct in-use subjects).
 * @param {string} root
 * @returns {Promise<{ meta: Record<string, { description?: string, examples?: string[] }>, areas: string[], subjects: string[] }>}
 */
export async function facetsFor(root) {
  const { env, layout, core, identity } = await loadEngine();
  return env.withWikiRoot(root, () => {
    const areas = new Set();
    const subjects = new Set();
    for (const category of layout.getCategories()) {
      const facets = layout.getPlacementFacets(category);
      if (facets.includes("area")) {
        for (const area of knownAreas(category)) areas.add(area);
      }
      if (facets.includes("subject")) {
        const rule = layout.placementRulesFor(category).subject;
        const vocab = rule && rule.vocabulary ? layout.vocabularyFor(rule.vocabulary) : null;
        if (vocab) for (const value of vocab) subjects.add(value);
        collectSubjects(core, identity.toAbs(category), subjects);
      }
    }
    return {
      meta: layout.getFacetMeta(),
      areas: [...areas].sort(),
      subjects: [...subjects].sort(),
    };
  });
}
