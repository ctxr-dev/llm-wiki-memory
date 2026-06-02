import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  wikiRoot,
  embedCachePath,
  defaultProjectModule,
  envValue,
  writeGateSelfImprovementEnabled,
} from "../scripts/lib/env.mjs";
import { activeBackend } from "../scripts/lib/embed.mjs";
import { INSTRUCTIONS } from "../scripts/lib/discipline.mjs";
import { isSystemMaintenance } from "../scripts/lib/maintenance-tag.mjs";

// ---- in-process hot reload ----
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
// Flat directories that hold the reloadable logic (no nested subdirs), so a
// NON-recursive watch suffices. Recursive fs.watch is unsupported on some
// platforms (historically throws on Linux), so avoiding it keeps reload working
// cross-platform.
const WATCH_DIRS = [path.join(HERE, "../scripts/lib"), HERE];

let impl = {};
// Monotonic, not Date.now(): each value busts the ESM module cache so a changed
// file is re-evaluated. Node's ESM loader retains prior specifiers, so every
// reload keeps an extra copy of these two small modules in memory. Reloads fire
// only on an actual file change (a `git pull`), which is rare for a memory
// server, so the retained-module growth is negligible. A tear-down-able worker
// was rejected because it would re-initialise the embedding backend on every
// reload, the exact cost this in-process design avoids.
let reloadSeq = 0;
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
await loadImpl();

// Only these modules are re-imported on change; everything else they import
// statically (facets/slug/datasets/embed) and this entry file itself need a
// restart, so a reload would be a no-op for them.
const RELOADABLE = new Set(["wiki-store.mjs", "recall.mjs"]);

function watchForReload() {
  let timer = null;
  let lastBase = null; // basename of the most recent effective change (for the log)
  // Serialise reloads: chain each onto the previous so two debounced bursts can
  // never run loadImpl() concurrently and race on assigning `impl`.
  let chain = Promise.resolve();
  const onChange = (_event, filename) => {
    const base = filename ? path.basename(filename) : null;
    // When we can identify the changed file and it is NOT one of the hot-reloaded
    // modules, skip the no-op reload and tell the operator a restart is needed,
    // rather than logging a misleading "hot-reloaded". We deliberately do NOT
    // clear a pending timer here: a git pull often changes a hot module AND a
    // static dep together, and the queued reload (for the hot module) must still
    // fire. When filename is null (platform-dependent), fall through and reload.
    if (base && !RELOADABLE.has(base)) {
      process.stderr.write(
        `[llm-wiki-memory] '${base}' changed; restart required to pick it up (only ${[...RELOADABLE].join("/")} hot-reload)\n`,
      );
      return;
    }
    lastBase = base;
    clearTimeout(timer);
    timer = setTimeout(() => {
      chain = chain.then(async () => {
        try {
          reloadSeq += 1;
          await loadImpl();
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
            `[llm-wiki-memory] hot-reload failed, keeping previous code: ${err?.message || err}\n`,
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
      process.stderr.write(`[llm-wiki-memory] watch failed for ${dir}: ${err?.message || err}\n`);
    }
  }
  return watchers;
}

const FilterSchema = z
  .object({
    atom_type: z.string().trim().min(1).optional(),
    project_module: z.string().trim().min(1).optional(),
    area: z.string().trim().min(1).optional(),
    language: z.string().trim().min(1).optional(),
    task_type: z.string().trim().min(1).optional(),
    error_pattern: z.string().trim().min(1).optional(),
    tags: z.string().trim().min(1).optional(),
  })
  .partial();

const MetadataSchema = z
  .object({
    atom_type: z.string().optional(),
    tags: z.string().optional(),
    project_module: z.string().optional(),
    area: z.string().optional(),
    language: z.string().optional(),
    task_type: z.string().optional(),
    error_pattern: z.string().optional(),
  })
  .partial();

function jsonResponse(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
function errorResponse(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

const server = new McpServer(
  {
    name: envValue("MEMORY_MCP_SERVER_NAME") || "llm-wiki-memory",
    version: "0.1.0",
  },
  // `instructions` is returned on initialize, so every MCP client receives the
  // memory discipline on connect (the cross-client carrier hooks cannot provide).
  { instructions: INSTRUCTIONS, capabilities: {} },
);

server.registerTool(
  "get_memory_config",
  {
    title: "Get memory configuration",
    description:
      "Inspect the local LLM-wiki memory configuration (wiki root, embed backend, categories, active LLM provider). The `llm` block reports the resolved provider, model, baseUrl (for openai / openai-compatible), and a cheap local-only `available` probe (CLI on PATH / API key in env). It does NOT touch the network.",
    inputSchema: {},
  },
  async () => {
    try {
      const { health } = await import("../scripts/lib/llm.mjs");
      const llmHealth = await health().catch((err) => ({
        provider: "unknown",
        available: false,
        reason: err?.message || String(err),
      }));
      return jsonResponse({
        wikiRoot: wikiRoot(),
        embedCache: embedCachePath(),
        embedBackend: activeBackend(),
        defaultProjectModule: defaultProjectModule(),
        categories: impl.getCategories(),
        llm: llmHealth,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "reload_provider",
  {
    title: "Re-probe the active LLM provider",
    description:
      "Re-run the cheap availability probe for the resolved LLM provider (CLI on PATH / API key in env / base URL set) and return the same `llm` block `get_memory_config` reports. Use after editing settings/.env or installing a CLI without restarting the MCP server.",
    inputSchema: {},
  },
  async () => {
    try {
      const { health } = await import("../scripts/lib/llm.mjs");
      const llmHealth = await health().catch((err) => ({
        provider: "unknown",
        available: false,
        reason: err?.message || String(err),
      }));
      return jsonResponse({ ok: true, llm: llmHealth });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "list_datasets",
  {
    title: "List memory categories",
    description: "List the wiki memory categories (knowledge, self_improvement, plans, investigations, daily).",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResponse(impl.listDatasets());
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "search_memory",
  {
    title: "Search project memory",
    description:
      "Search the local wiki memory and return scored chunks. Pass `filters` (atom_type, area, language, task_type, error_pattern, tags) to pre-filter by frontmatter metadata before embedding rank. `area` scopes to a sub-module. `datasets` accepts category names; default searches every category. project_module is the workspace identifier and is auto-injected when you pass `filters` (so results stay within this install).",
    inputSchema: {
      query: z.string().trim().min(1).max(1000),
      datasets: z.array(z.string().trim().min(1)).optional(),
      filters: FilterSchema.optional(),
      scoreThreshold: z.number().min(0).max(1).optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ query, datasets, filters, scoreThreshold, maxResults }) => {
    try {
      return jsonResponse(await impl.searchMemory({ query, datasets, filters, scoreThreshold, maxResults }));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "recall_lessons",
  {
    title: "Recall relevant self-improvement lessons",
    description:
      "BEFORE a non-trivial task, call this. It scopes to THIS workspace by default (so it returns hits without you guessing a module); pass `area` (the sub-module, e.g. frontend/billing/infra) to narrow, plus language/task_type (optional error_pattern). Broadens via a fall-back ladder (drop error_pattern, language, task_type, area, then project_module last) until enough hits; tags is never dropped. When includeKnowledge !== false, up to 2 bug-root-cause/feedback-rule knowledge atoms are appended.",
    inputSchema: {
      query: z.string().trim().min(1).max(1000),
      project_module: z.string().trim().min(1).optional(),
      area: z.string().trim().min(1).optional(),
      language: z.string().trim().min(1).optional(),
      task_type: z.string().trim().min(1).optional(),
      error_pattern: z.string().trim().min(1).optional(),
      tags: z.string().trim().min(1).optional(),
      includeKnowledge: z.boolean().optional(),
      scoreThreshold: z.number().min(0).max(1).optional(),
      maxResults: z.number().int().min(1).max(20).optional(),
    },
  },
  async (args) => {
    try {
      return jsonResponse(await impl.recallLessons(args));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// L3 of the memory-write hardening stack. Refuses gated self_improvement
// writes that lack `userRequested:true` UNLESS the call is inside a
// system-maintenance scope (the consolidate orchestrator runs every internal
// write under `withSystemMaintenance(...)`, the recall-touch instrumentation
// in searchMemoryFiltered / recallLessons does the same — see
// scripts/lib/maintenance-tag.mjs). The exemption is impossible to set from
// outside the orchestrator process (AsyncLocalStorage frame, not an
// arg / env var). Returning a structured error instead of throwing lets the
// model see and act on the refusal in the next turn.
function refuseWriteGate(toolName) {
  return jsonResponse({
    ok: false,
    error: "write-gate-refused",
    message:
      `${toolName} refused: self_improvement writes require userRequested:true (propose to the user in chat and wait for explicit yes; only then call the tool with the flag). The discipline rule in your initialize-time instructions documents the contract. Knowledge / plans / investigations / daily / issues writes are NOT gated and do not require the flag.`,
  });
}

// True iff the resolved write would land under the self_improvement category,
// regardless of the declared `dataset` field. Closes the gate-bypass where a
// caller passes `dataset:"knowledge"` (or any non-gated value) together with
// `path:"self_improvement/..."`. The L3 gate routes through this so the
// effective target — not the caller's claim — governs the refusal.
function targetsGatedCategory(dataset, placementOverride) {
  if (dataset === "self_improvement") return true;
  if (typeof placementOverride !== "string" || !placementOverride.trim()) return false;
  const segs = placementOverride.replace(/^\/+/, "").split(/[\\/]+/).filter(Boolean);
  return segs[0] === "self_improvement";
}

server.registerTool(
  "save_lesson",
  {
    title: "Save a self-improvement lesson (write-gated)",
    description:
      "Persist a self-improvement lesson into the self_improvement category. WRITE-GATED: propose to the user in chat first, and only call AFTER explicit yes in this turn — passing `userRequested:true`. The server refuses without that flag. metadata.area, task_type, and error_pattern are required; project_module is stamped to the workspace automatically. Same title overwrites in place.",
    inputSchema: {
      title: z.string().trim().min(1).max(180),
      body: z.string().trim().min(1).max(10_000),
      // REQUIRED: set to true ONLY when the user explicitly asked to save in
      // this turn. The L2 PreToolUse hook in Claude Code also returns "ask"
      // when the latest user turn has no save phrase — but this server-side
      // check is the airtight layer because it covers Cursor / Codex too.
      userRequested: z.boolean(),
      metadata: z
        .object({
          area: z.string().trim().min(1).optional(),
          project_module: z.string().trim().min(1).optional(),
          task_type: z.string().trim().min(1),
          error_pattern: z.string().trim().min(1),
          language: z.string().trim().optional(),
          tags: z.string().trim().optional(),
        })
        // saveLesson needs a sub-module: `area`, or legacy `project_module` as a
        // fallback. Enforce here so clients get a validation error, not a runtime throw.
        .refine((m) => Boolean(m.area || m.project_module), {
          message: "metadata.area (the sub-module; legacy metadata.project_module is accepted) is required",
          path: ["area"],
        }),
      tags: z.array(z.string().trim().min(1)).optional(),
      evidence: z.string().trim().max(500).optional(),
    },
  },
  async ({ title, body, userRequested, metadata, tags, evidence }) => {
    try {
      if (
        writeGateSelfImprovementEnabled() &&
        userRequested !== true &&
        !isSystemMaintenance()
      ) {
        return refuseWriteGate("save_lesson");
      }
      const result = impl.saveLesson({ title, body, metadata, tags, evidence });
      return jsonResponse({ ok: !!result.created, ...result });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "save_to_dataset",
  {
    title: "Upsert a document into a named category",
    description:
      "Write `text` as a wiki leaf with the given exact `name`, replacing any existing leaf in the category that has the same name. Use for plans, investigations, and knowledge artefacts. `dataset` is a category name (knowledge, plans, investigations, self_improvement, or any extra category declared in <wiki>/.layout/layout.yaml). Optional `metadata` applies filterable frontmatter. Optional `path` is a relative directory under the wiki root (e.g. \"issues/JIRA/DEV/129/95/7\") and, when supplied, overrides facet-derived placement so the leaf is written verbatim at <path>/<name>; casing is preserved. Use `path` for custom topologies (Jira/GitHub/Linear issue trees, multi-faceted hierarchies) the default facet machinery cannot express. WRITE-GATED for dataset=\"self_improvement\" only: pass `userRequested:true` after the user explicitly asks (propose-then-confirm); other datasets are not gated.",
    inputSchema: {
      dataset: z.string().trim().min(1),
      name: z.string().trim().min(1).max(180),
      text: z.string().trim().min(1).max(500_000),
      // Optional: required only when dataset === "self_improvement". The
      // server refuses gated writes without it (see save_lesson description).
      userRequested: z.boolean().optional(),
      metadata: MetadataSchema.optional(),
      path: z.string().trim().min(1).max(500).optional(),
    },
  },
  async ({ dataset, name, text, userRequested, metadata, path }) => {
    try {
      if (
        targetsGatedCategory(dataset, path) &&
        writeGateSelfImprovementEnabled() &&
        userRequested !== true &&
        !isSystemMaintenance()
      ) {
        return refuseWriteGate(
          dataset === "self_improvement"
            ? "save_to_dataset(dataset=\"self_improvement\")"
            : `save_to_dataset(path=\"${path}\" lands in self_improvement)`,
        );
      }
      const result = impl.saveDocument({
        name,
        text,
        datasetId: dataset,
        metadata,
        placementOverride: path,
      });
      return jsonResponse({ ok: !!result.created, ...result });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "write_memory",
  {
    title: "Write project memory",
    description:
      "Create a new wiki leaf from concise memory text. Optionally supersede an existing leaf by passing its documentId (the old leaf is archived, or deleted with supersedesAction='delete'). Optional `path` is a relative directory under the wiki root and, when supplied, overrides facet-derived placement so the leaf is written verbatim at <path>/<name>; casing is preserved. Use `path` for custom topologies the default facet machinery cannot express. WRITE-GATED for datasetId=\"self_improvement\" only — pass `userRequested:true` (server refuses without it). Other categories are not gated.",
    inputSchema: {
      name: z.string().trim().min(1).max(180),
      text: z.string().trim().min(20).max(200_000),
      datasetId: z.string().trim().min(1),
      userRequested: z.boolean().optional(),
      supersedes: z.string().trim().min(1).optional(),
      supersedesAction: z.enum(["disable", "delete"]).optional(),
      metadata: MetadataSchema.optional(),
      path: z.string().trim().min(1).max(500).optional(),
    },
  },
  async ({ name, text, datasetId, userRequested, supersedes, supersedesAction, metadata, path }) => {
    try {
      // Same L3 gate as save_to_dataset: self_improvement writes require an
      // explicit user-attestation flag. Closes the bypass available to
      // clients that don't fire the Claude-Code-only L2 hook AND the
      // gate-via-path bypass (path="self_improvement/..." with non-gated
      // datasetId).
      if (
        targetsGatedCategory(datasetId, path) &&
        writeGateSelfImprovementEnabled() &&
        userRequested !== true &&
        !isSystemMaintenance()
      ) {
        return refuseWriteGate(
          datasetId === "self_improvement"
            ? "write_memory(datasetId=\"self_improvement\")"
            : `write_memory(path=\"${path}\" lands in self_improvement)`,
        );
      }
      return jsonResponse(
        impl.writeMemory({
          name,
          text,
          datasetId,
          supersedes,
          supersedesAction,
          metadata,
          placementOverride: path,
        }),
      );
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "disable_document",
  {
    title: "Archive a document (hide from recall) without deleting",
    description:
      "Soft-delete: mark a leaf archived so search_memory / recall_lessons skip it, while keeping it on disk and in git history. Reversible via enable_document.",
    inputSchema: { dataset: z.string().trim().min(1), documentId: z.string().trim().min(1) },
  },
  async ({ dataset, documentId }) => {
    try {
      return jsonResponse(impl.disableDocument({ documentId, datasetId: dataset }));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "enable_document",
  {
    title: "Re-enable a previously archived document",
    description: "Symmetric counterpart to disable_document: brings an archived leaf back into recall results.",
    inputSchema: { dataset: z.string().trim().min(1), documentId: z.string().trim().min(1) },
  },
  async ({ dataset, documentId }) => {
    try {
      return jsonResponse(impl.enableDocument({ documentId, datasetId: dataset }));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "delete_document",
  {
    title: "Delete a document (PERMANENT on disk; recoverable via git)",
    description:
      "Permanently remove a leaf file. Prefer disable_document unless you are sure. Primary safe use: clean up a stale plan-<old-slug>.md after a rename.",
    inputSchema: { dataset: z.string().trim().min(1), documentId: z.string().trim().min(1) },
  },
  async ({ dataset, documentId }) => {
    try {
      return jsonResponse(impl.deleteDocument({ documentId, datasetId: dataset }));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "consolidate_memory",
  {
    title: "Run search-driven memory consolidation",
    description:
      "Run the AutoDream-style consolidation orchestrator. For each active leaf in self_improvement + knowledge, finds its similarity cluster via internal vector search, then applies deterministic passes (sha256 dedup, lesson-key dedup, cosine archive, staleness flag, orphan archive, compress-archived bodies, embedding-cache GC, index rebuild) and the LLM passes (merge near-duplicate bodies, refresh stale leaves) when enabled. Never hard-deletes; always uses disable_document. Throttled via MEMORY_CONSOLIDATE_INTERVAL_DAYS when ifDue=true. Internal writes are system-maintenance-tagged so the write-gate exempts them. Daily cron + the hook-less `consolidate` skill rule run this on a schedule; invoke manually only when the user asks. NOT subject to the L3 write-gate (it's a system tool, not a save).",
    inputSchema: {
      dryRun: z.boolean().optional(),
      ifDue: z.boolean().optional(),
      force: z.boolean().optional(),
      llm: z.boolean().optional(),
      passes: z.array(z.string().trim().min(1)).optional(),
      cosineThreshold: z.number().min(0).max(1).optional(),
    },
  },
  async ({ dryRun, ifDue, force, llm, passes, cosineThreshold }) => {
    try {
      // Honour per-call cosine override via env (process.env wins over .env).
      const restore = process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD;
      if (cosineThreshold != null) {
        process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD = String(cosineThreshold);
      }
      try {
        const { consolidateMemory } = await import("../scripts/consolidate.mjs");
        return jsonResponse(
          await consolidateMemory({ dryRun, ifDue, force, llm, passes }),
        );
      } finally {
        if (cosineThreshold != null) {
          if (restore == null) delete process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD;
          else process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD = restore;
        }
      }
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "audit_memory",
  {
    title: "Audit memory for stale or low-quality leaves (list-only)",
    description:
      "Walk categories for cleanup candidates; never mutates. Classes: duplicate-error-pattern (self_improvement lessons sharing an error_pattern), missing-metadata (lessons/bug-root-cause missing required fields).",
    inputSchema: {
      classes: z.array(z.enum(["duplicate-error-pattern", "missing-metadata"])).optional(),
    },
  },
  async ({ classes }) => {
    try {
      // Snapshot the implementation for the whole audit: this is the only
      // handler that makes MULTIPLE impl calls (listDocuments + readDocument in a
      // loop), so pinning one version prevents a mid-audit hot-reload from mixing
      // functions across module versions. (Single-call handlers capture their one
      // impl.* reference atomically, so they need no snapshot.)
      const api = impl;
      const requested = new Set(classes && classes.length ? classes : ["duplicate-error-pattern", "missing-metadata"]);
      const findings = [];
      const byErrorPattern = new Map();
      for (const slot of ["self_improvement", "knowledge"]) {
        const { documents } = api.listDocuments({ datasetId: slot, enabled: "true" });
        for (const doc of documents) {
          const { metadata } = api.readDocument({ documentId: doc.id, datasetId: slot });
          if (requested.has("missing-metadata")) {
            const at = metadata.atom_type;
            if (
              (at === "self-improvement-lesson" || at === "bug-root-cause") &&
              (!(metadata.area || metadata.project_module) || (at === "self-improvement-lesson" && !metadata.error_pattern))
            ) {
              findings.push({ class: "missing-metadata", slot, documentId: doc.id, atom_type: at });
            }
          }
          if (requested.has("duplicate-error-pattern") && slot === "self_improvement" && metadata.error_pattern) {
            const key = `${metadata.area || metadata.project_module || ""}:${metadata.error_pattern}`;
            if (!byErrorPattern.has(key)) byErrorPattern.set(key, []);
            byErrorPattern.get(key).push(doc.id);
          }
        }
      }
      if (requested.has("duplicate-error-pattern")) {
        for (const [key, ids] of byErrorPattern) {
          if (ids.length > 1) findings.push({ class: "duplicate-error-pattern", key, documentIds: ids });
        }
      }
      return jsonResponse({ ok: true, findings, total: findings.length });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "reload_layout",
  {
    title: "Force-reload the layout contract + topology caches",
    description:
      "Clear the in-process layout/topology caches so the next operation re-reads <wiki>/.layout/layout.yaml and its sibling to_path/from_path .mjs helpers. Edits are normally picked up automatically (the caches revalidate by file mtime), so you only need this as an explicit escape hatch — e.g. after a copy/restore that preserved mtimes, or to force a refresh immediately. No inputs.",
    inputSchema: {},
  },
  async () => {
    try {
      if (typeof impl.resetLayoutCache === "function") impl.resetLayoutCache();
      const topo = await import("../scripts/lib/topology-runtime.mjs");
      topo.resetTopologyCache();
      return jsonResponse({ ok: true, reloaded: ["layout", "topology"] });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "validate_layout",
  {
    title: "Validate a wiki's layout contract YAML (schema + line:col errors)",
    description:
      "Parse and schema-validate a layout contract. Reports each problem with a line:column pointer (facet_rules without placement_facets, a vocabulary reference that isn't declared, a fallback that isn't a vocab member, bad topology block, etc.). Inputs: optional `path` (an explicit layout.yaml path) OR optional `wiki_root` (defaults to the env-resolved wiki; reads <wiki_root>/.layout/layout.yaml). Returns {ok, errors:[{line,col,message}]}.",
    inputSchema: {
      path: z.string().trim().min(1).optional(),
      wiki_root: z.string().trim().min(1).optional(),
    },
  },
  async ({ path: layoutPath, wiki_root }) => {
    try {
      const { validateLayoutFile } = await import("../scripts/lib/layout-validator.mjs");
      const nodePath = await import("node:path");
      const target =
        layoutPath || nodePath.join(wiki_root || wikiRoot(), ".layout", "layout.yaml");
      return jsonResponse(validateLayoutFile(target));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "validate_topology",
  {
    title: "Pre-flight check that a topology's path compilers round-trip",
    description:
      "Iterates every declared file_kind in the topology, picks sample facets from facet_inputs (examples / enum-first / type defaults), runs pathFor with the round-trip safety net ON, and reports pass/fail per kind. Use BEFORE the first write against a layout to catch ambiguous from_path regexes, dropped facets, or no-placeholder templates. Inputs: optional `wiki_root` (defaults to env-resolved wiki) + optional `category` (defaults to 'issues').",
    inputSchema: {
      wiki_root: z.string().trim().min(1).optional(),
      category: z.string().trim().min(1).optional(),
    },
  },
  async ({ wiki_root, category }) => {
    try {
      const { validateTopologyAgainstSamples } = await import(
        "../scripts/lib/topology-validator.mjs"
      );
      const root = wiki_root || wikiRoot();
      const result = await validateTopologyAgainstSamples(root, {
        categoryPath: category || "issues",
      });
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "test_path_compiler",
  {
    title: "Test a custom-topology path compiler",
    description:
      "Dry-run a topology file_kind's path_compiler (or path_template) against caller-supplied facets and return the computed relative path. Use this to sanity-check a layout's topology block before writing real leaves; reports validation errors, runtime errors from the compiler, and any unresolved {variable} placeholders in the result. Reads <wiki>/.layout/layout.yaml (or the supplied `wiki_root` override).",
    inputSchema: {
      file_kind: z.string().trim().min(1),
      facets: z.record(z.string(), z.any()),
      category: z.string().trim().min(1).optional(),
      wiki_root: z.string().trim().min(1).optional(),
    },
  },
  async ({ file_kind, facets, category, wiki_root }) => {
    try {
      const { loadTopology, pathFor, validateFacets, findUnresolvedPlaceholders } =
        await import("../scripts/lib/topology-runtime.mjs");
      const root = wiki_root || wikiRoot();
      const topology = await loadTopology(root, { categoryPath: category || "issues" });
      const v = validateFacets(topology, file_kind, facets || {});
      if (!v.ok) {
        return jsonResponse({
          ok: false,
          file_kind,
          facets: facets || {},
          stage: "validate_facets",
          errors: v.errors,
        });
      }
      try {
        const resolved = pathFor(topology, file_kind, facets || {});
        const unresolved = findUnresolvedPlaceholders(resolved);
        return jsonResponse({
          ok: unresolved.length === 0,
          file_kind,
          facets,
          path: resolved,
          unresolved_placeholders: unresolved,
          warnings:
            unresolved.length > 0
              ? [`compiler left unresolved placeholders in the result: ${unresolved.join(", ")}`]
              : [],
        });
      } catch (err) {
        return jsonResponse({
          ok: false,
          file_kind,
          facets,
          stage: "compile",
          error: err.message,
        });
      }
    } catch (error) {
      return errorResponse(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// Module-level binding keeps the FSWatcher handles reachable for the process
// lifetime (an unreferenced watcher can be GC'd, stopping hot reload).
const activeWatchers = watchForReload();
void activeWatchers;
