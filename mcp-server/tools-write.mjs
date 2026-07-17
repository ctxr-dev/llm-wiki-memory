import { z } from "zod";
import { getImpl } from "./mcp-reload.mjs";
import { errorResponse } from "./mcp-responses.mjs";
import { MetadataSchema } from "./mcp-schemas.mjs";
import { gateRefusal, dispatchWrite } from "./mcp-write-dispatch.mjs";
import { ScopesSchema, withToolScopes } from "./mcp-scopes.mjs";
import { registerAbsorbTool } from "./tools-absorb.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";
import { parseWriteRequest, WRITE_KIND } from "../scripts/lib/context/write.mjs";
import {
  MCP_OPS,
  PrioritySchema,
  SupersedesActionSchema,
  SELF_IMPROVEMENT,
} from "../scripts/lib/context/enums.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */

// Shared REQUIRED write target: the scope/root a write lands in. Explicit by
// design (no implicit brain default — G1): pass a context level's `root` or
// `mountDir`, or "brain" for private memory. Discoverable via get_memory_config.
const TargetSchema = z.string().trim().min(1);
// The consent envelope. `userRequested` attests an in-turn user OK; the L3 gate
// refuses a self_improvement write without it. Required for save_lesson (always
// gated), optional for the other writes (gated only for self_improvement).
const GateSchema = z.object({ userRequested: z.boolean() }).strict();

const TARGET_DESCRIPTION =
  ' REQUIRED top-level `target` — the write destination is always explicit (there is no default): pass "brain" for your private memory, or a context level\'s wiki root or mount directory for a project (discover the available levels via get_memory_config `levels`). Omitting it is rejected. NEVER write to a shared repo without the user choosing it: ASK first, then pass that repo as `target`; a shared write is only staged in the repo working tree (the engine runs no git) — tell the user to commit and push it.';

const NESTED_NOTE = " Inputs are a single nested context object; unknown keys are rejected.";

/** @param {McpServer} server */
function registerWriteTools(server) {
  server.registerTool(
    "save_lesson",
    {
      title: "Save a self-improvement lesson (write-gated)",
      description:
        "Persist a self-improvement lesson into the self_improvement category. Send `write:{title, body, metadata, tags?, evidence?}` and `gate:{userRequested}`. WRITE-GATED: propose to the user in chat first, and only call AFTER explicit yes in this turn — passing `gate.userRequested:true`. The server refuses without it. write.metadata.area, task_type, and error_pattern are required; project_module is stamped to the workspace automatically. Same title overwrites in place. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki." +
        NESTED_NOTE +
        TARGET_DESCRIPTION,
      inputSchema: z
        .object({
          target: TargetSchema,
          write: z
            .object({
              title: z.string().trim().min(1).max(180),
              body: z.string().trim().min(1).max(10_000),
              metadata: z
                .object({
                  area: z.string().trim().min(1).optional(),
                  project_module: z.string().trim().min(1).optional(),
                  task_type: z.string().trim().min(1),
                  error_pattern: z.string().trim().min(1),
                  language: z.string().trim().optional(),
                  tags: z.string().trim().optional(),
                  priority: PrioritySchema.optional(),
                })
                .strict()
                .refine((m) => Boolean(m.area || m.project_module), {
                  message:
                    "metadata.area (the sub-module; legacy metadata.project_module is accepted) is required",
                  path: ["area"],
                }),
              tags: z.array(z.string().trim().min(1)).optional(),
              evidence: z.string().trim().max(500).optional(),
            })
            .strict(),
          gate: GateSchema,
          scopes: ScopesSchema,
        })
        .strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { write, gate, target } = args;
        const { title, body, metadata, tags, evidence } = write;
        const userRequested = gate.userRequested;
        try {
          const refusal = gateRefusal({
            tool: "save_lesson",
            dataset: SELF_IMPROVEMENT,
            name: title,
            metadata,
            userRequested,
            refuseLabel: "save_lesson",
          });
          if (refusal) return refusal;
          const req = parseWriteRequest(getActiveWikiContext(), {
            kind: WRITE_KIND.LESSON,
            dataset: SELF_IMPROVEMENT,
            name: title,
            text: body,
            metadata,
            userRequested,
            target,
          });
          return await dispatchWrite(
            req,
            (placed) => getImpl().saveLesson({ title, body, metadata: placed, tags, evidence }),
            { tool: "save_lesson", op: MCP_OPS.SAVE_LESSON, okFromCreated: true },
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "save_to_dataset",
    {
      title: "Upsert a document into a named category",
      description:
        'Write `write.text` as a wiki leaf with the exact `write.name`, replacing any existing leaf in the category with the same name. Send `write:{dataset, name, text, path?, metadata?}` and, only for a self_improvement write, `gate:{userRequested:true}`. `write.dataset` is a category name (knowledge, plans, investigations, self_improvement, or any extra category declared in <wiki>/.layout/layout.yaml). `write.path` is a relative directory under the wiki root (e.g. "issues/JIRA/DEV/129/95/7") that overrides facet-derived placement so the leaf is written verbatim at <path>/<name>. `write.path` is REQUIRED for any category with a `topology:` block (e.g. tracker issues) and REFUSED if missing/mismatched; optional for default facet categories. WRITE-GATED for dataset="self_improvement" only. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.' +
        NESTED_NOTE +
        TARGET_DESCRIPTION,
      inputSchema: z
        .object({
          target: TargetSchema,
          write: z
            .object({
              dataset: z.string().trim().min(1),
              name: z.string().trim().min(1).max(180),
              text: z.string().trim().min(1).max(500_000),
              path: z.string().trim().min(1).max(500).optional(),
              metadata: MetadataSchema.optional(),
            })
            .strict(),
          gate: GateSchema.optional(),
          scopes: ScopesSchema,
        })
        .strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { write, gate, target } = args;
        const { dataset, name, text, path, metadata } = write;
        const userRequested = gate?.userRequested;
        try {
          const refusal = gateRefusal({
            tool: "save_to_dataset",
            dataset,
            path,
            name,
            metadata,
            userRequested,
            refuseLabel:
              dataset === SELF_IMPROVEMENT
                ? `save_to_dataset(dataset="${SELF_IMPROVEMENT}")`
                : `save_to_dataset(path="${path}" lands in ${SELF_IMPROVEMENT})`,
          });
          if (refusal) return refusal;
          const req = parseWriteRequest(getActiveWikiContext(), {
            kind: WRITE_KIND.DOCUMENT,
            dataset,
            name,
            text,
            path,
            metadata,
            userRequested,
            target,
          });
          return await dispatchWrite(
            req,
            (placed) =>
              getImpl().saveDocument({
                name,
                text,
                datasetId: dataset,
                metadata: placed,
                placementOverride: path,
              }),
            { tool: "save_to_dataset", op: MCP_OPS.SAVE, okFromCreated: true },
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "write_memory",
    {
      title: "Write project memory",
      description:
        'Create a new wiki leaf from concise memory text. Send `write:{name, text, datasetId, supersedes?, supersedesAction?, path?, metadata?}` and, only for a self_improvement write, `gate:{userRequested:true}`. Optionally supersede an existing leaf by passing `write.supersedes` (its documentId; the old leaf is archived, or deleted with supersedesAction="delete"). `write.path` overrides facet-derived placement and is REQUIRED for a topology category (REFUSED if missing/mismatched), optional otherwise. WRITE-GATED for datasetId="self_improvement" only. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.' +
        NESTED_NOTE +
        TARGET_DESCRIPTION,
      inputSchema: z
        .object({
          target: TargetSchema,
          write: z
            .object({
              name: z.string().trim().min(1).max(180),
              text: z.string().trim().min(20).max(200_000),
              datasetId: z.string().trim().min(1),
              supersedes: z.string().trim().min(1).optional(),
              supersedesAction: SupersedesActionSchema.optional(),
              path: z.string().trim().min(1).max(500).optional(),
              metadata: MetadataSchema.optional(),
            })
            .strict(),
          gate: GateSchema.optional(),
          scopes: ScopesSchema,
        })
        .strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { write, gate, target } = args;
        const { name, text, datasetId, supersedes, supersedesAction, path, metadata } = write;
        const userRequested = gate?.userRequested;
        try {
          const refusal = gateRefusal({
            tool: "write_memory",
            dataset: datasetId,
            path,
            name,
            metadata,
            userRequested,
            refuseLabel:
              datasetId === SELF_IMPROVEMENT
                ? `write_memory(datasetId="${SELF_IMPROVEMENT}")`
                : `write_memory(path="${path}" lands in ${SELF_IMPROVEMENT})`,
          });
          if (refusal) return refusal;
          const req = parseWriteRequest(getActiveWikiContext(), {
            kind: WRITE_KIND.MEMORY,
            dataset: datasetId,
            name,
            text,
            path,
            metadata,
            userRequested,
            target,
          });
          return await dispatchWrite(
            req,
            (placed) =>
              getImpl().writeMemory({
                name,
                text,
                datasetId,
                supersedes,
                supersedesAction,
                metadata: placed,
                placementOverride: path,
              }),
            { tool: "write_memory", op: MCP_OPS.WRITE_MEMORY },
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  registerAbsorbTool(server);
}

export { registerWriteTools };
