import { defaultProjectModule } from "./env.mjs";
import { recallScoreThreshold, recallPriorityBand } from "./settings.mjs";
import { searchMemoryFiltered, saveDocument, rerankWithinBands } from "./wiki-store.mjs";
import { lessonDocName } from "./slug.mjs";

// searchMemory lives in recall-search.mjs (the cross-category search door);
// re-exported here so `import { searchMemory } from "./recall.mjs"` still works.
export { searchMemory } from "./recall-search.mjs";

/** @typedef {import("./types.mjs").RecallResponse} RecallResponse */
/** @typedef {import("./types.mjs").RecallRecord} RecallRecord */
/** @typedef {import("./types.mjs").SearchHit} SearchHit */
/** @typedef {import("./types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("./types.mjs").WriteResult} WriteResult */
/** @typedef {import("./wiki-mutate.mjs").SaveDocumentArgs} SaveDocumentArgs */

const LESSON_ATOM_TYPE = "self-improvement-lesson";
const KNOWLEDGE_CROSSREF_ATOM_TYPES = ["bug-root-cause", "feedback-rule"];

/**
 * @param {Record<string, unknown>} filters
 * @returns {string}
 */
function canonicalKey(filters) {
  return JSON.stringify(Object.fromEntries(Object.entries(filters).sort()));
}

// The depth-boosted ranking metric (fan-out) with a fall-back to the honest
// cosine. Single-tree hits carry no adjustedConfidence, so this is `score` there
// — recall's cross-scope ordering stays byte-identical when not federated.
/** @param {SearchHit} r @returns {number} */
function rankOf(r) {
  return r.adjustedConfidence ?? r.score;
}

// Tree-namespaced identity: the same rel path in two DIFFERENT trees is two
// distinct leaves, so key dedupe on (tree root, id). Single-tree hits carry no
// resolvedRoot, collapsing this to the plain id (byte-identical).
/** @param {SearchHit} r @returns {string} */
function dedupKey(r) {
  return r.resolvedRoot ? `${r.resolvedRoot}\0${r.documentId}` : r.documentId;
}

// Recall self-improvement lessons with a fall-back ladder: drop error_pattern ->
// language -> task_type -> area -> project_module, broadening until >= min(3,limit)
// distinct hits. project_module (the workspace) defaults so the base scope matches
// every leaf; `area` narrows to a sub-module. Both are dropped LAST (area, then
// project_module) so an over-tight scope still recovers; `tags` is never dropped.
// Optionally append up to 2 bug-root-cause/feedback-rule knowledge atoms.
/**
 * @param {Object} [args]
 * @param {string} [args.query]
 * @param {string} [args.project_module]
 * @param {string} [args.area]
 * @param {string} [args.language]
 * @param {string} [args.task_type]
 * @param {string} [args.error_pattern]
 * @param {string | string[]} [args.tags]
 * @param {boolean} [args.includeKnowledge]
 * @param {number} [args.scoreThreshold]
 * @param {number} [args.maxResults]
 * @param {string[]} [args.sections]
 * @returns {Promise<RecallResponse>}
 */
export async function recallLessons({
  query,
  project_module,
  area,
  language,
  task_type,
  error_pattern,
  tags,
  includeKnowledge,
  scoreThreshold,
  maxResults,
  sections,
} = {}) {
  const limit = maxResults || 5;
  const withGlance = Array.isArray(sections) && sections.includes("frontmatter");
  // Caller-supplied threshold wins; otherwise fall back to the configured
  // floor (settings.recall.scoreThreshold, default 0.05 — a small floor that
  // drops noise-level matches without over-pruning). Before this the setting was
  // dead config — wired into the loader, template, and migrator but read nowhere.
  const threshold = scoreThreshold ?? recallScoreThreshold();
  // project_module defaults to the workspace, which every leaf carries, so the
  // default scope matches (no more 0-hit-by-default). Pass `area` to narrow to a
  // sub-module. Both are dropped as the LAST ladder rungs so an over-tight scope
  // still recovers.
  const effectiveProjectModule = project_module || defaultProjectModule() || undefined;

  /** @type {Record<string, unknown>} */
  const baseFilters = {
    atom_type: LESSON_ATOM_TYPE,
    ...(effectiveProjectModule ? { project_module: effectiveProjectModule } : {}),
    ...(area ? { area } : {}),
    ...(language ? { language } : {}),
    ...(task_type ? { task_type } : {}),
    ...(error_pattern ? { error_pattern } : {}),
    ...(tags ? { tags } : {}),
  };

  const dropOrder = ["error_pattern", "language", "task_type", "area", "project_module"];
  const ladderRaw = [{ ...baseFilters }];
  const dropped = [];
  for (const key of dropOrder) {
    dropped.push(key);
    const next = { ...baseFilters };
    for (const k of dropped) delete next[k];
    ladderRaw.push(next);
  }
  const ladder = [];
  let prevKey = null;
  for (const f of ladderRaw) {
    const key = canonicalKey(f);
    if (key !== prevKey) ladder.push(f);
    prevKey = key;
  }

  const seen = new Set();
  const lessonHits = [];
  const ladderUsed = [];
  for (let rungIdx = 0; rungIdx < ladder.length; rungIdx += 1) {
    const filters = ladder[rungIdx];
    const { records } = /** @type {{ records: SearchHit[] }} */ (
      await searchMemoryFiltered({
        query,
        datasetId: "self_improvement",
        filters,
        scoreThreshold: threshold,
        limit,
        withGlance,
      })
    );
    let added = 0;
    for (const r of records) {
      const key = dedupKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      lessonHits.push({ ...r, kind: "lesson", rungIndex: rungIdx });
      added += 1;
    }
    if (added > 0) ladderUsed.push({ filters, added });
    if (lessonHits.length >= Math.min(3, limit)) break;
  }
  lessonHits.sort((a, b) => {
    const r = (a.rungIndex ?? 0) - (b.rungIndex ?? 0);
    if (r !== 0) return r;
    return rankOf(b) - rankOf(a);
  });
  // Priority breaks ties WITHIN a rung's cosine band only — rung (scope) stays
  // primary, cosine second, priority third. Reorder per-rung group so a band
  // tie-break never pulls a hit across rungs.
  const band = recallPriorityBand();
  const reranked = [];
  for (let k = 0; k < lessonHits.length;) {
    const rung = lessonHits[k].rungIndex ?? 0;
    let m = k + 1;
    while (m < lessonHits.length && (lessonHits[m].rungIndex ?? 0) === rung) m += 1;
    reranked.push(...rerankWithinBands(lessonHits.slice(k, m), band, rankOf));
    k = m;
  }
  lessonHits.length = 0;
  lessonHits.push(...reranked);

  const supplementary = [];
  if (includeKnowledge !== false && effectiveProjectModule) {
    for (const t of KNOWLEDGE_CROSSREF_ATOM_TYPES) {
      const { records } = /** @type {{ records: SearchHit[] }} */ (
        await searchMemoryFiltered({
          query,
          datasetId: "knowledge",
          filters: { atom_type: t, project_module: effectiveProjectModule },
          scoreThreshold: threshold,
          limit: 1,
          withGlance,
        })
      );
      for (const r of records.slice(0, 1)) supplementary.push({ ...r, kind: "knowledge" });
    }
  }

  const all = [...lessonHits.slice(0, limit), ...supplementary];
  return {
    query,
    lessonDataset: "self_improvement",
    ladderUsed,
    injectedFilters:
      !project_module && effectiveProjectModule ? { project_module: effectiveProjectModule } : null,
    scoreThreshold: threshold,
    lessonHits: lessonHits.length,
    supplementaryHits: supplementary.length,
    totalRecords: all.length,
    records: /** @type {RecallRecord[]} */ (
      all.map((r) => ({
        kind: r.kind,
        datasetId: r.datasetId,
        documentName: r.documentName,
        score: r.score,
        priority: r.priority,
        content: r.content,
        // Glance fields ride along only when the caller asked for the frontmatter
        // view (withGlance); otherwise they are absent and the shape is unchanged.
        ...(r.brief !== undefined ? { brief: r.brief } : {}),
        ...(r.type !== undefined ? { type: r.type } : {}),
        ...(r.status !== undefined ? { status: r.status } : {}),
        ...(r.progress !== undefined ? { progress: r.progress } : {}),
        ...(r.tags !== undefined ? { tags: r.tags } : {}),
      }))
    ),
  };
}

// Render + persist a self-improvement lesson into the self_improvement
// category. Mirrors the boilerplate's save_lesson doc format.
/**
 * @param {Object} [args]
 * @param {string} [args.title]
 * @param {string} [args.body]
 * @param {MetadataInput} [args.metadata]
 * @param {string | string[]} [args.tags]
 * @param {string} [args.evidence]
 * @returns {WriteResult & { datasetSlot: string, title?: string }}
 */
export function saveLesson({ title, body, metadata = {}, tags, evidence } = {}) {
  const area = String(metadata.area || metadata.project_module || "").trim();
  if (!area || !metadata.task_type || !metadata.error_pattern) {
    throw new Error(
      "save_lesson requires metadata.area (the sub-module; legacy metadata.project_module is accepted), task_type, and error_pattern",
    );
  }
  const tagList = Array.isArray(tags)
    ? tags
    : metadata.tags
      ? String(metadata.tags)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

  // Collapse newlines in the column-0 fields so a title/tag can't inject a
  // forged heading or list item into the rendered lesson.
  const oneLine = (/** @type {unknown} */ v) => String(v || "").replace(/[\r\n]+/g, " ");
  const lines = [`# ${oneLine(title)}`, "", `- type: ${LESSON_ATOM_TYPE}`];
  if (tagList.length) lines.push(`- tags: [${tagList.map(oneLine).join(", ")}]`);
  lines.push(`- area: ${area}`);
  if (metadata.language) lines.push(`- language: ${metadata.language}`);
  lines.push(`- task_type: ${metadata.task_type}`);
  lines.push(`- error_pattern: ${metadata.error_pattern}`);
  if (metadata.priority) lines.push(`- priority: ${oneLine(metadata.priority)}`);
  lines.push(`- updated_at_utc: ${new Date().toISOString()}`);
  lines.push("", /** @type {string} */ (body));
  if (evidence) lines.push("", `evidence: ${evidence}`);
  const text = `${lines.join("\n")}\n`;

  /** @type {MetadataInput} */
  const fullMetadata = {
    atom_type: LESSON_ATOM_TYPE,
    area,
    task_type: metadata.task_type,
    error_pattern: metadata.error_pattern,
  };
  // A repo-TARGET lesson carries the target's identity as project_module_override
  // (stamped by dispatchWrite before this call). fullMetadata is rebuilt from
  // scratch, so pass the override through explicitly — otherwise the lesson is
  // stamped with the writing workspace's defaultProjectModule() instead of the
  // target repo's identity and never gathers under that repo on recall.
  if (metadata.project_module_override)
    fullMetadata.project_module_override = metadata.project_module_override;
  if (metadata.language) fullMetadata.language = metadata.language;
  if (tagList.length) fullMetadata.tags = tagList.join(",");
  // Gated lesson: honour the user-picked priority (P0 allowed here); normaliseMeta
  // fills the rubric default (P1 for a lesson) when omitted.
  if (metadata.priority) fullMetadata.priority = metadata.priority;

  const result = saveDocument(
    /** @type {SaveDocumentArgs} */ ({
      name: lessonDocName(/** @type {string} */ (title)),
      text,
      datasetId: "self_improvement",
      metadata: fullMetadata,
      title,
    }),
  );
  return { ...result, datasetSlot: "self_improvement", title };
}
