import path from "node:path";
import { loadEngine } from "./engine.mjs";
import { isWithin } from "./paths.mjs";

const GATED = "self_improvement";
const ATOM_TYPES = new Set([
  "decision",
  "bug-root-cause",
  "feedback-rule",
  "project-lore",
  "reference",
  "pattern-gotcha",
  "self-improvement-lesson",
  "plan",
]);
const TASK_TYPES = new Set([
  "planning",
  "implementation",
  "debugging",
  "refactor",
  "review",
  "deploy",
  "docs",
  "unknown",
]);
const PRIORITIES = new Set(["P0", "P1", "P2"]);

/** @param {string} id @returns {string} */
function firstSegment(id) {
  return String(id).split("/").filter(Boolean)[0] ?? "";
}

/** @param {string} category @param {string} docId @returns {boolean} */
function isGated(category, docId) {
  return category === GATED || firstSegment(docId) === GATED;
}

/** @param {Record<string, unknown>} memory @returns {string | null} */
function vocabError(memory) {
  const atom = memory.atom_type;
  const task = memory.task_type;
  const priority = memory.priority;
  if (typeof atom === "string" && !ATOM_TYPES.has(atom)) return `invalid atom_type: ${atom}`;
  if (typeof task === "string" && !TASK_TYPES.has(task)) return `invalid task_type: ${task}`;
  if (typeof priority === "string" && !PRIORITIES.has(priority))
    return `invalid priority: ${priority}`;
  return null;
}

/**
 * @param {string} root @param {"wiki" | "repo"} ownership @param {string} docId
 * @param {{ body?: string, memory?: Record<string, unknown>, userRequested?: boolean }} edit
 * @returns {Promise<import("../shared/contract.mjs").EditResult>}
 */
export async function editDoc(root, ownership, docId, edit) {
  const { env, search, identity, store, core, render, atomic } = await loadEngine();
  const category = identity.categoryOfId(docId);
  const memory = edit.memory ?? {};
  if (isGated(category, docId) && edit.userRequested !== true) {
    return {
      ok: false,
      error: "write-gate-refused",
      message: "self_improvement edits require confirmation",
    };
  }
  const invalid = vocabError(memory);
  if (invalid) return { ok: false, error: "invalid-metadata", message: invalid };
  return env.withWikiRoot(root, () => {
    if (!isWithin(env.wikiRoot(), identity.toAbs(docId)))
      return { ok: false, error: "no-such-doc" };
    const current = search.readLeafForConsolidate({ documentId: docId });
    if (!current) return { ok: false, error: "no-such-doc" };
    const merged = { ...current.memory, ...memory };
    if (merged.priority === "P0" && edit.userRequested !== true) merged.priority = "P1";
    const override = store.categoryHasTopology(category) ? path.dirname(docId) : undefined;
    const result = store.saveDocument({
      name: current.name,
      text: edit.body ?? current.text,
      datasetId: category,
      metadata: { ...merged, title: current.frontmatter.focus },
      placementOverride: override,
    });
    if (!result.ok) return { ok: false, error: "save-failed", message: result.reason };
    const savedId = result.created?.document.id ?? docId;
    preservePlanFields(core, render, atomic, identity, savedId, current.frontmatter);
    return {
      ok: true,
      id: savedId,
      relocatedFrom: result.relocatedFrom ?? null,
      shared: ownership === "repo",
    };
  });
}

/**
 * saveDocument regenerates the leaf frontmatter and drops the top-level plan
 * lifecycle fields; restore them (they do not affect the embed text or index).
 * @param {any} core @param {any} render @param {any} atomic @param {any} identity
 * @param {string} savedId @param {Record<string, unknown>} original
 */
function preservePlanFields(core, render, atomic, identity, savedId, original) {
  const status = original.status;
  const progress = original.progress;
  if (status === undefined && progress === undefined) return;
  const abs = identity.toAbs(savedId);
  const leaf = core.readLeaf(abs);
  const data = { ...leaf.data };
  if (status !== undefined) data.status = status;
  if (progress !== undefined) data.progress = progress;
  atomic.writeFileAtomic(abs, render.stringifyLeaf(leaf.body, data));
}

/**
 * @param {string} root @param {"wiki" | "repo"} ownership @param {string} docId @param {boolean} archive
 * @returns {Promise<import("../shared/contract.mjs").EditResult>}
 */
export async function setArchived(root, ownership, docId, archive) {
  const { env, identity, store } = await loadEngine();
  const category = identity.categoryOfId(docId);
  return env.withWikiRoot(root, () => {
    if (!isWithin(env.wikiRoot(), identity.toAbs(docId)))
      return { ok: false, error: "no-such-doc" };
    const result = archive
      ? store.disableDocument({ documentId: docId, datasetId: category })
      : store.enableDocument({ documentId: docId, datasetId: category });
    if (!result.ok) return { ok: false, error: "no-such-doc" };
    return { ok: true, id: docId, status: result.status, shared: ownership === "repo" };
  });
}

/**
 * @param {string} root @param {"wiki" | "repo"} ownership
 * @param {{ category: string, name: string, title?: string, body?: string, memory?: Record<string, unknown>, userRequested?: boolean }} create
 * @returns {Promise<import("../shared/contract.mjs").EditResult>}
 */
export async function createDoc(root, ownership, create) {
  const { env, store } = await loadEngine();
  const memory = create.memory ?? {};
  if (isGated(create.category, `${create.category}/x`) && create.userRequested !== true) {
    return {
      ok: false,
      error: "write-gate-refused",
      message: "self_improvement writes require confirmation",
    };
  }
  const invalid = vocabError(memory);
  if (invalid) return { ok: false, error: "invalid-metadata", message: invalid };
  return env.withWikiRoot(root, () => {
    if (!store.getCategories().includes(create.category)) {
      return { ok: false, error: "no-such-category" };
    }
    if (store.categoryHasTopology(create.category)) {
      return {
        ok: false,
        error: "topology-unsupported",
        message: "cannot create in a topology category here",
      };
    }
    if (memory.priority === "P0" && create.userRequested !== true) memory.priority = "P1";
    const result = store.saveDocument({
      name: create.name,
      text: create.body ?? "",
      datasetId: create.category,
      metadata: { ...memory, title: create.title },
    });
    if (!result.ok) return { ok: false, error: "save-failed", message: result.reason };
    return { ok: true, id: result.created?.document.id ?? "", shared: ownership === "repo" };
  });
}
