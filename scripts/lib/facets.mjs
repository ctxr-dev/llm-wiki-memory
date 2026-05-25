import fs from "node:fs";
import path from "node:path";
import { wikiRoot, defaultProjectModule, envValue } from "./env.mjs";
import { slugify } from "./slug.mjs";
import { ATOM_TYPE_TO_DATASET, TASK_TYPES } from "./datasets.mjs";
import { callLLMWithRetry } from "./llm.mjs";

// Facet inference & validation. The placement facets (area / atom_type /
// task_type) are what both the on-disk tree and search filters key on, so an
// `unknown`/`unscoped` area, an out-of-set `atom_type`, or a missing
// `task_type` is a classification FAILURE that leaves docs in junk buckets
// (e.g. the doubled `knowledge/<area>/knowledge/`).
//
// Two entry points:
//   inferFacets        - SYNC, heuristic-only, used on the (synchronous) write
//                        path. Guarantees a valid value for every facet via a
//                        deterministic fallback; never `unknown`/invalid. No LLM,
//                        so the save path stays fast and stays non-async.
//   classifyFacetsLLM  - ASYNC, heuristic-first then a single LLM call to pin a
//                        precise sub-module / atom_type. Used by the backfill so
//                        re-identification is accurate, without infecting saves.

// Values that signal "the model did not classify" and must be replaced.
const BAD_AREA = new Set(["", "unknown", "unscoped", "untyped", "misc", "untitled", "none", "n-a", "na"]);

// Cross-cutting areas: legitimate buckets for memory that belongs to no single
// code sub-module (e.g. a universal authoring convention). Configurable; the
// FIRST entry is the deterministic fallback.
export function crossCuttingAreas() {
  const raw = envValue("MEMORY_CROSS_CUTTING_AREAS", "workspace,conventions");
  const workspace = slugify(defaultProjectModule() || "");
  // Defend the "never unknown/unscoped/workspace-name area" guarantee even if
  // the env var is misconfigured: drop bad-sentinel and workspace-name entries.
  const list = String(raw)
    .split(",")
    .map((s) => slugify(s.trim()))
    .filter((s) => s && !BAD_AREA.has(s) && s !== workspace);
  return list.length ? list : ["workspace"];
}

// Valid atom_types for a category (the ones routing to it). For `knowledge`,
// atom_type is a placement facet, so an out-of-set value must be corrected.
export function validAtomTypes(category) {
  return new Set(
    Object.entries(ATOM_TYPE_TO_DATASET)
      .filter(([, ds]) => ds === category)
      .map(([type]) => type),
  );
}

function defaultAtomTypeForCategory(category) {
  if (category === "self_improvement") return "self-improvement-lesson";
  if (category === "plans") return "plan";
  if (category === "investigations") return "investigation";
  return "reference"; // knowledge + anything else: the most generic knowledge type
}

// Discover existing sub-module folders for a category from the on-disk tree,
// unioned with the cross-cutting set. Self-adapting: no hardcoded vocabulary.
export function knownAreas(category) {
  const areas = new Set();
  try {
    const catAbs = path.join(wikiRoot(), category);
    for (const entry of fs.readdirSync(catAbs, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const a = slugify(entry.name);
      if (a && !BAD_AREA.has(a)) areas.add(a);
    }
  } catch {
    /* category dir may not exist yet */
  }
  for (const cc of crossCuttingAreas()) areas.add(cc);
  return areas;
}

function tagList(tags) {
  if (Array.isArray(tags)) return tags.map((t) => slugify(String(t))).filter(Boolean);
  return String(tags || "")
    .split(",")
    .map((t) => slugify(t.trim()))
    .filter(Boolean);
}

// Cheap (no-LLM) check: which placement facets of an existing leaf are bad and
// should be re-identified. Scoped to the two failure modes that corrupt the
// tree: an unknown/unscoped/workspace-name `area`, and (for knowledge, where
// atom_type is a facet) an out-of-set `atom_type` (e.g. the doubled
// `knowledge/<area>/knowledge/` bucket). task_type is left to save-time
// best-effort since `unknown` is a documented valid sentinel.
export function facetIssues(category, meta = {}) {
  if (category === "daily") return [];
  const issues = [];
  const workspace = slugify(defaultProjectModule() || "");
  const area = slugify(String(meta.area || "").trim());
  if (!area || BAD_AREA.has(area) || area === workspace) issues.push("area");
  if (category === "knowledge") {
    const at = String(meta.atom_type || "").trim().toLowerCase();
    if (!validAtomTypes(category).has(at)) issues.push("atom_type");
  }
  return issues;
}

// Heuristic area: provided real area -> project_module-as-sub-module -> a tag
// that names a known sub-module -> the cross-cutting fallback. Never bad.
function heuristicArea(category, meta, tags2) {
  const cc = crossCuttingAreas();
  const fallbackArea = cc[0] || "workspace";
  const areas = knownAreas(category);
  const subModules = [...areas].filter((a) => !cc.includes(a));
  const workspace = slugify(defaultProjectModule() || "");

  let area = slugify(String(meta.area || "").trim());
  if (!area || BAD_AREA.has(area) || area === workspace) {
    area = "";
    // Accept a legacy `project_module`-as-sub-module value (any name), EXCEPT
    // the workspace identifier itself (post-split that is the project, not a
    // sub-module, which is exactly how `tradingtune` leaked in as an area).
    const pm = slugify(String(meta.project_module || "").trim());
    if (pm && pm !== workspace && !BAD_AREA.has(pm)) area = pm;
    else {
      const hit = tags2.find((t) => subModules.includes(t));
      if (hit) area = hit;
    }
  }
  if (!area || BAD_AREA.has(area)) area = fallbackArea;
  return area;
}

// SYNC: a valid facet patch { area, atom_type?, task_type? } to merge into the
// caller's metadata before normaliseMeta. `daily` has no placement facets.
export function inferFacets({ category, meta = {}, tags = [] } = {}) {
  if (category === "daily") return {};
  const tags2 = tagList(tags);
  const validTypes = validAtomTypes(category);

  const patch = { area: heuristicArea(category, meta, tags2) };

  const atomType = String(meta.atom_type || "").trim().toLowerCase();
  if (category === "knowledge") {
    patch.atom_type = validTypes.has(atomType) ? atomType : defaultAtomTypeForCategory(category);
  } else if (atomType) {
    patch.atom_type = atomType;
  }

  const taskType = String(meta.task_type || "").trim().toLowerCase();
  if (category === "self_improvement") {
    patch.task_type = taskType && TASK_TYPES.has(taskType) ? taskType : "unknown";
  } else if (taskType) {
    patch.task_type = taskType;
  }
  return patch;
}

async function classifyWithLLM({ category, title, text, tags, areaChoices, typeChoices, want }) {
  const keys = [];
  if (want.area) keys.push(`"area": one of ${JSON.stringify(areaChoices)} — the sub-module it belongs to; use a cross-cutting value ONLY for genuinely project-wide content`);
  if (want.atom_type) keys.push(`"atom_type": one of ${JSON.stringify(typeChoices)}`);
  const systemPrompt =
    `You classify a project-memory note into facet metadata for category "${category}". ` +
    `Respond with STRICT JSON only (no prose, no code fences): an object with exactly these keys: ${keys.join("; ")}. ` +
    `Choose the single best value from the allowed list for each key.`;
  const userPrompt =
    `Title: ${String(title || "").slice(0, 200)}\n` +
    `Tags: ${tags.join(", ")}\n\n--- CONTENT ---\n${String(text || "").slice(0, 2000)}`;
  const res = await callLLMWithRetry({ systemPrompt, userPrompt, maxTokens: 200 });
  return res && typeof res === "object" && !Array.isArray(res) ? res : {};
}

// ASYNC: heuristic baseline, then ONE LLM call to pin a precise sub-module /
// atom_type when the heuristic could not. Used by the backfill so an offender is
// re-identified accurately. Falls back to the heuristic baseline on any error.
export async function classifyFacetsLLM({ category, meta = {}, title = "", text = "", tags = [] } = {}) {
  if (category === "daily") return {};
  const base = inferFacets({ category, meta, tags });
  const cc = crossCuttingAreas();
  const areas = knownAreas(category);
  const subModules = [...areas].filter((a) => !cc.includes(a));
  const validTypes = validAtomTypes(category);
  const tags2 = tagList(tags);
  const workspace = slugify(defaultProjectModule() || "");

  const origArea = slugify(String(meta.area || "").trim());
  // If the stored area was bad, let the LLM pick a precise sub-module even when
  // the heuristic guessed one from tags (e.g. a cross-repo note tagged with two
  // sub-modules) — this is the one-off backfill, so accuracy beats LLM frugality.
  const wantArea = !origArea || BAD_AREA.has(origArea) || origArea === workspace;

  const origType = String(meta.atom_type || "").trim().toLowerCase();
  const wantAtom = category === "knowledge" && !validTypes.has(origType);

  if (!wantArea && !wantAtom) return base;

  try {
    const llm = await classifyWithLLM({
      category,
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
