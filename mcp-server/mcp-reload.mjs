import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { settingsPath } from "../scripts/lib/settings.mjs";

/** @typedef {import("../scripts/lib/types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("../scripts/lib/types.mjs").SearchResponse} SearchResponse */
/** @typedef {import("../scripts/lib/types.mjs").RecallResponse} RecallResponse */
/** @typedef {import("../scripts/lib/types.mjs").WriteResult} WriteResult */
/** @typedef {import("../scripts/lib/types.mjs").MutationResult} MutationResult */
/** @typedef {import("../scripts/lib/types.mjs").DocumentSummary} DocumentSummary */
/** @typedef {import("../scripts/lib/types.mjs").DocumentContent} DocumentContent */

/**
 * The reloadable tool logic folded into `impl` from wiki-store.mjs + recall.mjs.
 * Handlers read it lazily via `getImpl()` at call time (never a captured
 * snapshot) so a hot reload's wholesale reassignment is always observed.
 *
 * @typedef {Object} Impl
 * @property {() => string[]} getCategories
 * @property {() => string[]} scopedCategories
 * @property {() => { datasets: Array<{ name: string, id: string }>, declaredLocally: Array<{ name: string, configuredId: string }> }} listDatasets
 * @property {(category: string) => boolean} categoryHasTopology
 * @property {(categoryOrSlot: string, metadata?: MetadataInput) => { metadata: MetadataInput, remaps: Array<{ facet: string, from: string, to: string }> }} remapUnknownPathFacets
 * @property {(name: string) => { name: string, id: string }} normalizeLeafNamePreservingCase
 * @property {() => void} resetLayoutCache
 * @property {(args: { query: string, datasets?: string[], filters?: MetadataInput, scoreThreshold?: number, maxResults?: number, sections?: string[] }) => Promise<SearchResponse>} searchMemory
 * @property {(args: { query: string, project_module?: string, area?: string, language?: string, task_type?: string, error_pattern?: string, tags?: string, includeKnowledge?: boolean, scoreThreshold?: number, maxResults?: number, sections?: string[] }) => Promise<RecallResponse>} recallLessons
 * @property {(args: { title: string, body: string, metadata?: MetadataInput, tags?: string[], evidence?: string }) => WriteResult} saveLesson
 * @property {(args: { name: string, text: string, datasetId: string, metadata?: MetadataInput, placementOverride?: string }) => WriteResult} saveDocument
 * @property {(args: { name: string, text: string, datasetId: string, supersedes?: string, supersedesAction?: string, metadata?: MetadataInput, placementOverride?: string }) => WriteResult} writeMemory
 * @property {(args: { documentId: string, datasetId?: string }) => MutationResult} disableDocument
 * @property {(args: { documentId: string, datasetId?: string }) => MutationResult} enableDocument
 * @property {(args: { documentId: string, datasetId?: string }) => MutationResult} deleteDocument
 * @property {(args: { documentId: string, datasetId?: string, toPath: string }) => MutationResult} moveDocument
 * @property {(args: { datasetId?: string, enabled?: string, prefix?: string }) => { documents: DocumentSummary[] }} listDocuments
 * @property {(args: { documentId: string, datasetId?: string }) => DocumentContent} readDocument
 */

// wiki-store.mjs + recall.mjs hold the tool logic. We re-import them
// (cache-busted) whenever a source file changes, so a plain `git pull` takes
// effect WITHOUT restarting this long-lived stdio MCP process: the initialize
// handshake and the stdin/stdout pipe stay intact, and the embedding backend
// (embed.mjs, kept as a static import) is never re-initialised. INSTRUCTIONS is
// sent once at initialize, so discipline.mjs stays static too.
//
// Limitation: a re-import refreshes wiki-store.mjs / recall.mjs themselves; a
// change confined to one of their STATIC deps (slug.mjs, facets.mjs, ...)
// resolves to the cached copy and still needs a one-time restart.
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Directories holding reloadable logic, each watched NON-recursively (recursive
// fs.watch is unsupported on some platforms). scripts/lib holds wiki-store.mjs +
// recall.mjs; scripts/ holds consolidate.mjs; the settings dir holds
// settings.yaml. A non-recursive watch on scripts/ reports its DIRECT files
// only, so scripts/lib is listed separately (no double-fire on nested files).
const SETTINGS_DIR = (() => {
  try {
    return path.dirname(settingsPath());
  } catch {
    return null;
  }
})();
const WATCH_DIRS = [
  path.join(HERE, "../scripts/lib"),
  path.join(HERE, "../scripts"),
  HERE,
  ...(SETTINGS_DIR ? [SETTINGS_DIR] : []),
];

/** @type {Impl} */
let impl = /** @type {Impl} */ ({});
// Monotonic, not Date.now(): each value busts the ESM module cache so a changed
// file is re-evaluated. Node's ESM loader retains prior specifiers, so every
// reload keeps an extra copy of these two small modules in memory. Reloads fire
// only on an actual file change (a `git pull`), which is rare for a memory
// server, so the retained-module growth is negligible. A tear-down-able worker
// was rejected because it would re-initialise the embedding backend on every
// reload, the exact cost this in-process design avoids.
let reloadSeq = 0;

// Accessors, never a captured snapshot: `impl` is reassigned wholesale on every
// hot reload and `reloadSeq` is bumped in place, so a tool handler must read the
// CURRENT value at call time rather than close over a stale binding.
/** @returns {Impl} */
function getImpl() {
  return impl;
}
function getReloadSeq() {
  return reloadSeq;
}

async function loadImpl() {
  const v = reloadSeq;
  const [store, recall] = await Promise.all([
    import(`../scripts/lib/wiki-store.mjs?v=${v}`),
    import(`../scripts/lib/recall.mjs?v=${v}`),
  ]);
  // Only assigned after both imports resolve. A failed/partial import rejects
  // here and the previous `impl` is left untouched: onChange's catch keeps it
  // (at startup there is no previous, so a broken module surfaces immediately).
  impl = { ...store, ...recall };
}

// wiki-store.mjs + recall.mjs are re-imported into `impl` on change. Everything
// they import statically (facets/slug/datasets/embed) and this entry file need a
// restart. consolidate.mjs is re-imported lazily at its call site (see
// DYNAMIC_RELOADABLE); settings.yaml is re-read on the next tool call.
const RELOADABLE = new Set(["wiki-store.mjs", "recall.mjs"]);
// Dynamically imported per tool call (not folded into `impl`); bumping reloadSeq
// makes the next import re-evaluate. consolidate.mjs is the only MCP-invoked
// script module — compile.mjs runs solely via cron/CLI in a fresh process, so it
// never needs in-process reload.
const DYNAMIC_RELOADABLE = new Set(["consolidate.mjs"]);
const SETTINGS_FILE = "settings.yaml";

function watchForReload() {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {string | null} */
  let lastBase = null; // basename of the most recent effective change (for the log)
  // Serialise reloads: chain each onto the previous so two debounced bursts can
  // never run loadImpl() concurrently and race on assigning `impl`.
  let chain = Promise.resolve();
  /**
   * @param {string} _event
   * @param {string | null} filename
   */
  const onChange = (_event, filename) => {
    const base = filename ? path.basename(filename) : null;
    // settings.yaml is not a module: it is re-read on the next settings() call
    // via the mtime cache, so it needs neither a re-import nor a restart. Emit a
    // breadcrumb and stop — bumping reloadSeq would pointlessly re-import code.
    if (base === SETTINGS_FILE) {
      process.stderr.write(
        "[llm-wiki-memory] settings.yaml changed; applied on the next tool call (no restart)\n",
      );
      return;
    }
    // A change to a file we cannot hot-reload (settings.mjs, embed.mjs, llm.mjs,
    // this entry file, or a static dep like slug.mjs/facets.mjs) is a no-op for
    // the running process: tell the operator a restart is needed rather than
    // logging a misleading "hot-reloaded". We deliberately do NOT clear a pending
    // timer here: a git pull often changes a hot module AND a static dep
    // together, and the queued reload (for the hot module) must still fire. When
    // filename is null (platform-dependent), fall through and reload.
    if (base && !RELOADABLE.has(base) && !DYNAMIC_RELOADABLE.has(base)) {
      process.stderr.write(
        `[llm-wiki-memory] '${base}' changed; restart required to pick it up ` +
          `(hot-reload: ${[...RELOADABLE, ...DYNAMIC_RELOADABLE].join("/")}; ` +
          `settings.yaml applies on next call; everything else needs a restart)\n`,
      );
      return;
    }
    lastBase = base;
    clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer));
    timer = setTimeout(() => {
      chain = chain.then(async () => {
        try {
          // Bump the shared cache-bust seq FIRST so the next dynamic import of a
          // DYNAMIC_RELOADABLE module (consolidate.mjs, imported per tool call)
          // re-evaluates. Only RELOADABLE modules are folded into `impl` here;
          // dynamic ones are re-imported lazily at their call site.
          reloadSeq += 1;
          if (!base || RELOADABLE.has(base)) await loadImpl();
          // stderr ONLY: stdout carries the JSON-RPC protocol stream. `lastBase`
          // is null only when the platform did not report a filename, in which
          // case this is a best-effort reload on any change under the watched dir.
          process.stderr.write(
            lastBase
              ? `[llm-wiki-memory] hot-reloaded after change to ${lastBase}\n`
              : "[llm-wiki-memory] hot-reloaded after a file change (filename unavailable; best-effort)\n",
          );
        } catch (err) {
          process.stderr.write(
            `[llm-wiki-memory] hot-reload failed, keeping previous code: ${/** @type {{ message?: string }} */ (err)?.message || err}\n`,
          );
        }
      });
    }, 200);
  };
  const watchers = [];
  for (const dir of WATCH_DIRS) {
    try {
      // Retain the FSWatcher: an unreferenced watcher can be garbage-collected,
      // silently stopping hot reload. The caller keeps the returned array alive
      // for the process lifetime.
      watchers.push(fs.watch(dir, onChange));
    } catch (err) {
      process.stderr.write(
        `[llm-wiki-memory] watch failed for ${dir}: ${/** @type {{ message?: string }} */ (err)?.message || err}\n`,
      );
    }
  }
  return watchers;
}

export { getImpl, getReloadSeq, loadImpl, watchForReload };
