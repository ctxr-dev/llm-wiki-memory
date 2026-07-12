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
import { ScopesSchema, withToolScopes } from "./mcp-scopes.mjs";
import { withResolvedWriteTarget, annotateSharedWrite } from "./mcp-write-target.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";
import { parseWriteRequest, WRITE_KIND } from "../scripts/lib/context/write.mjs";
import {
  MCP_OPS,
  MCP_ACTOR,
  PrioritySchema,
  SupersedesActionSchema,
  SELF_IMPROVEMENT,
} from "../scripts/lib/context/enums.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */
/** @typedef {import("../scripts/lib/types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("../scripts/lib/types.mjs").WriteResult} WriteResult */

// Shared schema for the OPTIONAL write target: the scope/root a write lands in.
// Omitted -> the brain (writeDefault). Accepts a context level's `root` or
// `mountDir`, or the literal "brain".
const TargetSchema = z.string().trim().min(1).optional();

const TARGET_DESCRIPTION =
  ' Optional `target` routes the write into a chosen scope: pass a context level\'s wiki root or mount directory, or "brain". Omitted, the write lands in your brain (private memory). NEVER write to a shared repo without the user choosing it: ASK first, then pass that repo as `target`; a shared write is only staged in the repo working tree (the engine runs no git) — tell the user to commit and push it.';

/**
 * The L3 gate REFUSAL, decided from RAW args (no resolved context needed) so it
 * runs BEFORE parse-time input validation — a gated write without consent is
 * refused and audited regardless of any other malformed field, preserving the
 * gate-first precedence and a complete refused-audit trail (C8). Returns the
 * refusal response, or null to proceed.
 * @param {{ tool: string, dataset: string, path?: string, name: string, metadata?: MetadataInput, userRequested?: boolean, refuseLabel: string }} a
 * @returns {ReturnType<typeof refuseWriteGate> | null}
 */
function gateRefusal(a) {
  if (
    targetsGatedCategory(a.dataset, a.path) &&
    writeGateSelfImprovementEnabled() &&
    a.userRequested !== true &&
    !isSystemMaintenance()
  ) {
    auditGatedL3({
      tool: a.tool,
      status: "refused",
      userRequested: a.userRequested,
      title: a.name,
      metadata: a.metadata,
    });
    return refuseWriteGate(a.refuseLabel);
  }
  return null;
}

/**
 * Dispatch a parsed WriteRequest (save_lesson / save_to_dataset / write_memory):
 * route into the already-resolved target, then INSIDE the target frame validate
 * topology, coerce a scarce priority, remap out-of-vocab facets against the target
 * layout (skipped when an explicit `path` is given), run `doWrite(placed)` under
 * one commit, audit an accepted gated write (C8), and shape the response
 * (shared-target note + priority/remap notes). The gate REFUSAL was already
 * decided by {@link gateRefusal} before this runs.
 * @param {import("../scripts/lib/context/write.mjs").WriteRequest} req
 * @param {(placed: MetadataInput | undefined) => WriteResult} doWrite
 * @param {{ tool: string, op: string, okFromCreated?: boolean }} cfg
 */
async function dispatchWrite(req, doWrite, cfg) {
  const { gated, target, dataset, path, metadata, userRequested } = req;
  const name = /** @type {string} */ (req.name);
  return await withResolvedWriteTarget(target, async (level) => {
    await assertTopologyPathValid({ dataset, name, path });
    const { metadata: md, note: priorityNote } = guardScarcePriority(metadata, userRequested);
    // Facet placement (only when no explicit path) pre-validates against the
    // target layout, remapping an out-of-vocab subject to `general` rather than
    // throwing (R2).
    const { metadata: placed, remaps } = path
      ? { metadata: md, remaps: [] }
      : getImpl().remapUnknownPathFacets(dataset, md);
    const result = /** @type {WriteResult} */ (
      withWikiCommit({ op: cfg.op, actor: MCP_ACTOR }, () => doWrite(placed))
    );
    if (gated) {
      auditGatedL3({
        tool: cfg.tool,
        status: "accepted",
        userRequested,
        title: name,
        metadata: placed,
      });
    }
    return jsonResponse(
      annotateSharedWrite(level, {
        ...(cfg.okFromCreated ? { ok: !!result.created } : {}),
        .../** @type {Record<string, unknown>} */ (result),
        ...(priorityNote ? { priorityNote } : {}),
        ...(remaps.length ? { facetRemap: remaps } : {}),
      }),
    );
  });
}

/** @param {McpServer} server */
function registerWriteTools(server) {
  server.registerTool(
    "save_lesson",
    {
      title: "Save a self-improvement lesson (write-gated)",
      description:
        "Persist a self-improvement lesson into the self_improvement category. WRITE-GATED: propose to the user in chat first, and only call AFTER explicit yes in this turn — passing `userRequested:true`. The server refuses without that flag. metadata.area, task_type, and error_pattern are required; project_module is stamped to the workspace automatically. Same title overwrites in place. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki." +
        TARGET_DESCRIPTION,
      inputSchema: {
        title: z.string().trim().min(1).max(180),
        body: z.string().trim().min(1).max(10_000),
        target: TargetSchema,
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
            priority: PrioritySchema.optional(),
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
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { title, body, userRequested, metadata, tags, evidence, target } = args;
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
        'Write `text` as a wiki leaf with the given exact `name`, replacing any existing leaf in the category that has the same name. Use for plans, investigations, and knowledge artefacts. `dataset` is a category name (knowledge, plans, investigations, self_improvement, or any extra category declared in <wiki>/.layout/layout.yaml). Optional `metadata` applies filterable frontmatter. `path` is a relative directory under the wiki root (e.g. "issues/JIRA/DEV/129/95/7") that overrides facet-derived placement so the leaf is written verbatim at <path>/<name> (casing preserved). `path` is REQUIRED for any category with a `topology:` block in .layout/layout.yaml (e.g. tracker issues): consult the layout, pick the file_kind for your intent (plan vs knowledge), and compute the path from its required facets. A missing or topology-mismatched `path` for such a category is REFUSED. For default facet categories `path` is optional (placement is facet-derived). WRITE-GATED for dataset="self_improvement" only: pass `userRequested:true` after the user explicitly asks (propose-then-confirm); other datasets are not gated. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.' +
        TARGET_DESCRIPTION,
      inputSchema: {
        dataset: z.string().trim().min(1),
        name: z.string().trim().min(1).max(180),
        text: z.string().trim().min(1).max(500_000),
        // Optional: required only when dataset === "self_improvement". The
        // server refuses gated writes without it (see save_lesson description).
        userRequested: z.boolean().optional(),
        metadata: MetadataSchema.optional(),
        path: z.string().trim().min(1).max(500).optional(),
        target: TargetSchema,
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { dataset, name, text, userRequested, metadata, path, target } = args;
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
        "Create a new wiki leaf from concise memory text. Optionally supersede an existing leaf by passing its documentId (the old leaf is archived, or deleted with supersedesAction='delete'). `path` is a relative directory under the wiki root that overrides facet-derived placement so the leaf is written verbatim at <path>/<name> (casing preserved). `path` is REQUIRED for any category with a `topology:` block in .layout/layout.yaml (e.g. tracker issues) and must match that topology for the leaf file_kind; it is optional for default facet categories. A missing or topology-mismatched path for a topology category is REFUSED. WRITE-GATED for datasetId=\"self_improvement\" only — pass `userRequested:true` (server refuses without it). Other categories are not gated. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki." +
        TARGET_DESCRIPTION,
      inputSchema: {
        name: z.string().trim().min(1).max(180),
        text: z.string().trim().min(20).max(200_000),
        datasetId: z.string().trim().min(1),
        userRequested: z.boolean().optional(),
        supersedes: z.string().trim().min(1).optional(),
        supersedesAction: SupersedesActionSchema.optional(),
        metadata: MetadataSchema.optional(),
        path: z.string().trim().min(1).max(500).optional(),
        target: TargetSchema,
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const {
          name,
          text,
          datasetId,
          userRequested,
          supersedes,
          supersedesAction,
          metadata,
          path,
          target,
        } = args;
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
}

export { registerWriteTools };
