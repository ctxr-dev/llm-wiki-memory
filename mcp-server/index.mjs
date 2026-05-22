import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wikiRoot, embedCachePath, defaultProjectModule, envValue } from "../scripts/lib/env.mjs";
import {
  CATEGORIES,
  writeMemory,
  saveDocument,
  disableDocument,
  enableDocument,
  deleteDocument,
  listDocuments,
  readDocument,
  listDatasets,
} from "../scripts/lib/wiki-store.mjs";
import { recallLessons, searchMemory, saveLesson } from "../scripts/lib/recall.mjs";
import { activeBackend } from "../scripts/lib/embed.mjs";
import { INSTRUCTIONS } from "../scripts/lib/discipline.mjs";

const FilterSchema = z
  .object({
    atom_type: z.string().trim().min(1).optional(),
    project_module: z.string().trim().min(1).optional(),
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
    description: "Inspect the local LLM-wiki memory configuration (wiki root, embed backend, categories).",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResponse({
        wikiRoot: wikiRoot(),
        embedCache: embedCachePath(),
        embedBackend: activeBackend(),
        defaultProjectModule: defaultProjectModule(),
        categories: CATEGORIES,
      });
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
      return jsonResponse(listDatasets());
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
      "Search the local wiki memory and return scored chunks. Pass `filters` (atom_type, project_module, language, task_type, error_pattern, tags) to pre-filter by frontmatter metadata before embedding rank. `datasets` accepts category names; default searches every category. If you pass `filters` without `project_module`, the workspace identifier is auto-injected to avoid cross-project leakage.",
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
      return jsonResponse(await searchMemory({ query, datasets, filters, scoreThreshold, maxResults }));
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
      "BEFORE a non-trivial task, call this with the inferred context (project_module, language, task_type, optional error_pattern). Filters the self_improvement category, broadening via a fall-back ladder (drop error_pattern, then language, then task_type) until enough hits. project_module/tags are never dropped. When project_module is provided and includeKnowledge !== false, up to 2 bug-root-cause/feedback-rule knowledge atoms are appended. Omit project_module to auto-scope to this workspace.",
    inputSchema: {
      query: z.string().trim().min(1).max(1000),
      project_module: z.string().trim().min(1).optional(),
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
      return jsonResponse(await recallLessons(args));
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "save_lesson",
  {
    title: "Save a self-improvement lesson",
    description:
      "Persist a self-improvement lesson into the self_improvement category. Use MID-SESSION the moment the user corrects you so the next turn can recall it. metadata.project_module, task_type, and error_pattern are required. Same title overwrites in place.",
    inputSchema: {
      title: z.string().trim().min(1).max(180),
      body: z.string().trim().min(1).max(10_000),
      metadata: z.object({
        project_module: z.string().trim().min(1),
        task_type: z.string().trim().min(1),
        error_pattern: z.string().trim().min(1),
        language: z.string().trim().optional(),
        tags: z.string().trim().optional(),
      }),
      tags: z.array(z.string().trim().min(1)).optional(),
      evidence: z.string().trim().max(500).optional(),
    },
  },
  async ({ title, body, metadata, tags, evidence }) => {
    try {
      const result = saveLesson({ title, body, metadata, tags, evidence });
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
      "Write `text` as a wiki leaf with the given exact `name`, replacing any existing leaf in the category that has the same name. Use for plans, investigations, and knowledge artefacts. `dataset` is a category name (knowledge, plans, investigations, self_improvement). Optional `metadata` applies filterable frontmatter.",
    inputSchema: {
      dataset: z.string().trim().min(1),
      name: z.string().trim().min(1).max(180),
      text: z.string().trim().min(1).max(500_000),
      metadata: MetadataSchema.optional(),
    },
  },
  async ({ dataset, name, text, metadata }) => {
    try {
      const result = saveDocument({ name, text, datasetId: dataset, metadata });
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
      "Create a new wiki leaf from concise memory text. Optionally supersede an existing leaf by passing its documentId (the old leaf is archived, or deleted with supersedesAction='delete').",
    inputSchema: {
      name: z.string().trim().min(1).max(180),
      text: z.string().trim().min(20).max(200_000),
      datasetId: z.string().trim().min(1),
      supersedes: z.string().trim().min(1).optional(),
      supersedesAction: z.enum(["disable", "delete"]).optional(),
      metadata: MetadataSchema.optional(),
    },
  },
  async ({ name, text, datasetId, supersedes, supersedesAction, metadata }) => {
    try {
      return jsonResponse(writeMemory({ name, text, datasetId, supersedes, supersedesAction, metadata }));
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
      return jsonResponse(disableDocument({ documentId, datasetId: dataset }));
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
      return jsonResponse(enableDocument({ documentId, datasetId: dataset }));
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
      return jsonResponse(deleteDocument({ documentId, datasetId: dataset }));
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
      const requested = new Set(classes && classes.length ? classes : ["duplicate-error-pattern", "missing-metadata"]);
      const findings = [];
      const byErrorPattern = new Map();
      for (const slot of ["self_improvement", "knowledge"]) {
        const { documents } = listDocuments({ datasetId: slot, enabled: "true" });
        for (const doc of documents) {
          const { metadata } = readDocument({ documentId: doc.id, datasetId: slot });
          if (requested.has("missing-metadata")) {
            const at = metadata.atom_type;
            if (
              (at === "self-improvement-lesson" || at === "bug-root-cause") &&
              (!metadata.project_module || (at === "self-improvement-lesson" && !metadata.error_pattern))
            ) {
              findings.push({ class: "missing-metadata", slot, documentId: doc.id, atom_type: at });
            }
          }
          if (requested.has("duplicate-error-pattern") && slot === "self_improvement" && metadata.error_pattern) {
            const key = `${metadata.project_module || ""}:${metadata.error_pattern}`;
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

const transport = new StdioServerTransport();
await server.connect(transport);
