import { defaultProjectModule } from "./env.mjs";
import { recallScoreThreshold, recallPriorityBand } from "./settings.mjs";
import { searchMemoryFiltered, saveDocument, getCategories, rerankWithinBands } from "./wiki-store.mjs";
import { lessonDocName } from "./slug.mjs";

export const LESSON_ATOM_TYPE = "self-improvement-lesson";
export const KNOWLEDGE_CROSSREF_ATOM_TYPES = ["bug-root-cause", "feedback-rule"];

function canonicalKey(filters) {
  return JSON.stringify(Object.fromEntries(Object.entries(filters).sort()));
}

// Recall self-improvement lessons with a fall-back ladder: drop error_pattern ->
// language -> task_type -> area -> project_module, broadening until >= min(3,limit)
// distinct hits. project_module (the workspace) defaults so the base scope matches
// every leaf; `area` narrows to a sub-module. Both are dropped LAST (area, then
// project_module) so an over-tight scope still recovers; `tags` is never dropped.
// Optionally append up to 2 bug-root-cause/feedback-rule knowledge atoms.
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
} = {}) {
  const limit = maxResults || 5;
  // Caller-supplied threshold wins; otherwise fall back to the configured
  // floor (settings.recall.scoreThreshold, default 0 = don't over-prune).
  // Before this the setting was dead config — wired into the loader, template,
  // and migrator but read nowhere.
  const threshold = scoreThreshold ?? recallScoreThreshold();
  // project_module defaults to the workspace, which every leaf carries, so the
  // default scope matches (no more 0-hit-by-default). Pass `area` to narrow to a
  // sub-module. Both are dropped as the LAST ladder rungs so an over-tight scope
  // still recovers.
  const effectiveProjectModule = project_module || defaultProjectModule() || undefined;

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
    const { records } = await searchMemoryFiltered({
      query,
      datasetId: "self_improvement",
      filters,
      scoreThreshold: threshold,
      limit,
    });
    let added = 0;
    for (const r of records) {
      if (seen.has(r.documentId)) continue;
      seen.add(r.documentId);
      lessonHits.push({ ...r, kind: "lesson", rungIndex: rungIdx });
      added += 1;
    }
    if (added > 0) ladderUsed.push({ filters, added });
    if (lessonHits.length >= Math.min(3, limit)) break;
  }
  lessonHits.sort((a, b) => {
    const r = (a.rungIndex ?? 0) - (b.rungIndex ?? 0);
    if (r !== 0) return r;
    return (b.score ?? -1) - (a.score ?? -1);
  });
  // Priority breaks ties WITHIN a rung's cosine band only — rung (scope) stays
  // primary, cosine second, priority third. Reorder per-rung group so a band
  // tie-break never pulls a hit across rungs.
  const band = recallPriorityBand();
  const reranked = [];
  for (let k = 0; k < lessonHits.length; ) {
    const rung = lessonHits[k].rungIndex ?? 0;
    let m = k + 1;
    while (m < lessonHits.length && (lessonHits[m].rungIndex ?? 0) === rung) m += 1;
    reranked.push(...rerankWithinBands(lessonHits.slice(k, m), band));
    k = m;
  }
  lessonHits.length = 0;
  lessonHits.push(...reranked);

  const supplementary = [];
  if (includeKnowledge !== false && effectiveProjectModule) {
    for (const t of KNOWLEDGE_CROSSREF_ATOM_TYPES) {
      const { records } = await searchMemoryFiltered({
        query,
        datasetId: "knowledge",
        filters: { atom_type: t, project_module: effectiveProjectModule },
        scoreThreshold: threshold,
        limit: 1,
      });
      for (const r of records.slice(0, 1)) supplementary.push({ ...r, kind: "knowledge" });
    }
  }

  const all = [...lessonHits.slice(0, limit), ...supplementary];
  return {
    query,
    lessonDataset: "self_improvement",
    ladderUsed,
    injectedFilters: !project_module && effectiveProjectModule ? { project_module: effectiveProjectModule } : null,
    scoreThreshold: threshold,
    lessonHits: lessonHits.length,
    supplementaryHits: supplementary.length,
    totalRecords: all.length,
    records: all.map((r) => ({
      kind: r.kind,
      datasetId: r.datasetId,
      documentName: r.documentName,
      score: r.score,
      priority: r.priority,
      content: r.content,
    })),
  };
}

// Cross-category search with optional project_module auto-injection.
export async function searchMemory({ query, datasets, filters, scoreThreshold, maxResults } = {}) {
  const limit = maxResults || 8;
  // Caller threshold wins; else the configured floor (settings.recall.scoreThreshold).
  const effectiveThreshold = scoreThreshold ?? recallScoreThreshold();
  // Use getCategories() not the raw CATEGORIES export — getCategories()
  // calls ensureLayoutLoaded() so fresh CLI invocations see the
  // YAML-declared categories (including any custom ones like `issues`).
  const slots = Array.isArray(datasets) && datasets.length ? datasets : getCategories();
  const effectiveFilters = filters
    ? filters.project_module
      ? filters
      : { ...filters, ...(defaultProjectModule() ? { project_module: defaultProjectModule() } : {}) }
    : null;

  const all = [];
  const errors = [];
  for (const slot of slots) {
    try {
      const { records } = await searchMemoryFiltered({
        query,
        datasetId: slot,
        filters: effectiveFilters,
        scoreThreshold: effectiveThreshold,
        limit,
      });
      all.push(...records);
    } catch (err) {
      errors.push({ datasetId: slot, message: err instanceof Error ? err.message : String(err) });
    }
  }
  all.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return {
    query,
    datasetsSearched: slots,
    filters: filters || null,
    injectedFilters:
      filters && !filters.project_module && defaultProjectModule()
        ? { project_module: defaultProjectModule() }
        : null,
    scoreThreshold: scoreThreshold ?? null,
    errors,
    totalRecords: all.length,
    records: all.slice(0, limit),
  };
}

// Render + persist a self-improvement lesson into the self_improvement
// category. Mirrors the boilerplate's save_lesson doc format.
export function saveLesson({ title, body, metadata = {}, tags, evidence } = {}) {
  const area = String(metadata.area || metadata.project_module || "").trim();
  if (!area || !metadata.task_type || !metadata.error_pattern) {
    throw new Error("save_lesson requires metadata.area (the sub-module; legacy metadata.project_module is accepted), task_type, and error_pattern");
  }
  const tagList = Array.isArray(tags)
    ? tags
    : metadata.tags
      ? String(metadata.tags).split(",").map((t) => t.trim()).filter(Boolean)
      : [];

  // Collapse newlines in the column-0 fields so a title/tag can't inject a
  // forged heading or list item into the rendered lesson.
  const oneLine = (v) => String(v || "").replace(/[\r\n]+/g, " ");
  const lines = [`# ${oneLine(title)}`, "", `- type: ${LESSON_ATOM_TYPE}`];
  if (tagList.length) lines.push(`- tags: [${tagList.map(oneLine).join(", ")}]`);
  lines.push(`- area: ${area}`);
  if (metadata.language) lines.push(`- language: ${metadata.language}`);
  lines.push(`- task_type: ${metadata.task_type}`);
  lines.push(`- error_pattern: ${metadata.error_pattern}`);
  if (metadata.priority) lines.push(`- priority: ${oneLine(metadata.priority)}`);
  lines.push(`- updated_at_utc: ${new Date().toISOString()}`);
  lines.push("", body);
  if (evidence) lines.push("", `evidence: ${evidence}`);
  const text = `${lines.join("\n")}\n`;

  const fullMetadata = {
    atom_type: LESSON_ATOM_TYPE,
    area,
    task_type: metadata.task_type,
    error_pattern: metadata.error_pattern,
  };
  if (metadata.language) fullMetadata.language = metadata.language;
  if (tagList.length) fullMetadata.tags = tagList.join(",");
  // Gated lesson: honour the user-picked priority (P0 allowed here); normaliseMeta
  // fills the rubric default (P1 for a lesson) when omitted.
  if (metadata.priority) fullMetadata.priority = metadata.priority;

  const result = saveDocument({
    name: lessonDocName(title),
    text,
    datasetId: "self_improvement",
    metadata: fullMetadata,
    title,
  });
  return { ...result, datasetSlot: "self_improvement", title };
}
