import { z } from "zod";
import { writeGateSelfImprovementEnabled } from "../scripts/lib/settings.mjs";
import { withWikiCommit } from "../scripts/lib/wiki-commit.mjs";
import { isSystemMaintenance } from "../scripts/lib/maintenance-tag.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse, errorResponse } from "./mcp-responses.mjs";
import { MetadataSchema } from "./mcp-schemas.mjs";
import {
  assertTopologyPathValid,
  refuseWriteGate,
  targetsGatedCategory,
  auditGatedL3,
  guardScarcePriority,
} from "./mcp-write-gate.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */

/** @param {McpServer} server */
function registerWriteTools(server) {
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
            // Apply-strength. Gated saves are user-confirmed, so P0 is allowed
            // here (the user picks it in the propose-then-confirm). Defaults to
            // the rubric (P1 for a lesson) when omitted.
            priority: z.enum(["P0", "P1", "P2"]).optional(),
          })
          // saveLesson needs a sub-module: `area`, or legacy `project_module` as a
          // fallback. Enforce here so clients get a validation error, not a runtime throw.
          .refine((m) => Boolean(m.area || m.project_module), {
            message:
              "metadata.area (the sub-module; legacy metadata.project_module is accepted) is required",
            path: ["area"],
          }),
        tags: z.array(z.string().trim().min(1)).optional(),
        evidence: z.string().trim().max(500).optional(),
      },
    },
    async ({ title, body, userRequested, metadata, tags, evidence }) => {
      try {
        if (writeGateSelfImprovementEnabled() && userRequested !== true && !isSystemMaintenance()) {
          auditGatedL3({ tool: "save_lesson", status: "refused", userRequested, title, metadata });
          return refuseWriteGate("save_lesson");
        }
        const result = /** @type {import("../scripts/lib/types.mjs").WriteResult} */ (
          withWikiCommit({ op: "mcp-save-lesson", actor: "mcp" }, () =>
            getImpl().saveLesson({ title, body, metadata, tags, evidence }),
          )
        );
        auditGatedL3({ tool: "save_lesson", status: "accepted", userRequested, title, metadata });
        return jsonResponse({
          ok: !!result.created,
          .../** @type {Record<string, unknown>} */ (result),
        });
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
        'Write `text` as a wiki leaf with the given exact `name`, replacing any existing leaf in the category that has the same name. Use for plans, investigations, and knowledge artefacts. `dataset` is a category name (knowledge, plans, investigations, self_improvement, or any extra category declared in <wiki>/.layout/layout.yaml). Optional `metadata` applies filterable frontmatter. `path` is a relative directory under the wiki root (e.g. "issues/JIRA/DEV/129/95/7") that overrides facet-derived placement so the leaf is written verbatim at <path>/<name> (casing preserved). `path` is REQUIRED for any category with a `topology:` block in .layout/layout.yaml (e.g. tracker issues): consult the layout, pick the file_kind for your intent (plan vs knowledge), and compute the path from its required facets. A missing or topology-mismatched `path` for such a category is REFUSED. For default facet categories `path` is optional (placement is facet-derived). WRITE-GATED for dataset="self_improvement" only: pass `userRequested:true` after the user explicitly asks (propose-then-confirm); other datasets are not gated.',
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
          auditGatedL3({
            tool: "save_to_dataset",
            status: "refused",
            userRequested,
            title: name,
            metadata,
          });
          return refuseWriteGate(
            dataset === "self_improvement"
              ? 'save_to_dataset(dataset="self_improvement")'
              : `save_to_dataset(path="${path}" lands in self_improvement)`,
          );
        }
        await assertTopologyPathValid({ dataset, name, path });
        const { metadata: md, note: priorityNote } = guardScarcePriority(metadata, userRequested);
        const result = /** @type {import("../scripts/lib/types.mjs").WriteResult} */ (
          withWikiCommit({ op: "mcp-save", actor: "mcp" }, () =>
            getImpl().saveDocument({
              name,
              text,
              datasetId: dataset,
              metadata: md,
              placementOverride: path,
            }),
          )
        );
        if (targetsGatedCategory(dataset, path)) {
          auditGatedL3({
            tool: "save_to_dataset",
            status: "accepted",
            userRequested,
            title: name,
            metadata: md,
          });
        }
        return jsonResponse({
          ok: !!result.created,
          .../** @type {Record<string, unknown>} */ (result),
          ...(priorityNote ? { priorityNote } : {}),
        });
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
        "Create a new wiki leaf from concise memory text. Optionally supersede an existing leaf by passing its documentId (the old leaf is archived, or deleted with supersedesAction='delete'). `path` is a relative directory under the wiki root that overrides facet-derived placement so the leaf is written verbatim at <path>/<name> (casing preserved). `path` is REQUIRED for any category with a `topology:` block in .layout/layout.yaml (e.g. tracker issues) and must match that topology for the leaf file_kind; it is optional for default facet categories. A missing or topology-mismatched path for a topology category is REFUSED. WRITE-GATED for datasetId=\"self_improvement\" only — pass `userRequested:true` (server refuses without it). Other categories are not gated.",
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
    async ({
      name,
      text,
      datasetId,
      userRequested,
      supersedes,
      supersedesAction,
      metadata,
      path,
    }) => {
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
          auditGatedL3({
            tool: "write_memory",
            status: "refused",
            userRequested,
            title: name,
            metadata,
          });
          return refuseWriteGate(
            datasetId === "self_improvement"
              ? 'write_memory(datasetId="self_improvement")'
              : `write_memory(path="${path}" lands in self_improvement)`,
          );
        }
        await assertTopologyPathValid({ dataset: datasetId, name, path });
        const { metadata: md, note: priorityNote } = guardScarcePriority(metadata, userRequested);
        const result = /** @type {import("../scripts/lib/types.mjs").WriteResult} */ (
          withWikiCommit({ op: "mcp-write-memory", actor: "mcp" }, () =>
            getImpl().writeMemory({
              name,
              text,
              datasetId,
              supersedes,
              supersedesAction,
              metadata: md,
              placementOverride: path,
            }),
          )
        );
        if (targetsGatedCategory(datasetId, path)) {
          auditGatedL3({
            tool: "write_memory",
            status: "accepted",
            userRequested,
            title: name,
            metadata: md,
          });
        }
        return jsonResponse({ ...result, ...(priorityNote ? { priorityNote } : {}) });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}

export { registerWriteTools };
