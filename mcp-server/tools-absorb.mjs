import { z } from "zod";
import { errorResponse, jsonResponse } from "./mcp-responses.mjs";
import { MetadataSchema } from "./mcp-schemas.mjs";
import { ScopesSchema, withToolScopes } from "./mcp-scopes.mjs";
import { withWriteTarget, annotateSharedWrite } from "./mcp-write-target.mjs";
import { absorbDocument } from "../scripts/lib/absorb.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */

const TargetSchema = z.string().trim().min(1);

const DESCRIPTION =
  "Absorb ONE whole markdown document into a wiki as a single FULL leaf (stored verbatim, embedded whole — never shortened into an atomic note). " +
  'Send `write:{ text, name, category, metadata?, dryRun? }`. `write.text` is the full document; `write.name` is the leaf filename (e.g. "checkout-design.md"); `write.category` is a FACET-PLACED category (knowledge or any non-gated, non-topology category in <wiki>/.layout/layout.yaml) — the model infers the within-category placement (area / subject) from the content, and `write.metadata` overrides any inferred facet. `write.dryRun:true` returns the proposed placement without writing. ' +
  "Gated (self_improvement) and topology (issues) categories are REFUSED — they cannot be auto-placed from content. To absorb a directory / glob of files, use the `cli.mjs absorb` command (it reads the filesystem); this tool takes one inline document. " +
  "REQUIRES `scopes`: the directories you are working in. Inputs are a single nested context object; unknown keys are rejected. " +
  'REQUIRED top-level `target` — the destination is explicit (no default): pass "brain" for private memory, or a context level\'s wiki root / mount directory for a project (discover levels via get_memory_config). NEVER absorb into a shared repo without the user choosing it; a shared write is only staged (the engine runs no git) — tell the user to commit and push it.';

/** @param {McpServer} server */
export function registerAbsorbTool(server) {
  server.registerTool(
    "absorb_document",
    {
      title: "Absorb a whole document as one full leaf",
      description: DESCRIPTION,
      inputSchema: z
        .object({
          target: TargetSchema,
          write: z
            .object({
              text: z.string().trim().min(1).max(500_000),
              name: z.string().trim().min(1).max(180),
              category: z.string().trim().min(1),
              metadata: MetadataSchema.optional(),
              dryRun: z.boolean().optional(),
            })
            .strict(),
          scopes: ScopesSchema,
        })
        .strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { write, target } = args;
        const { text, name, category, metadata, dryRun } = write;
        try {
          const { level, result } = await withWriteTarget(target, async (lvl) => ({
            level: lvl,
            result: await absorbDocument({
              text,
              name,
              category,
              overrides: metadata || {},
              dryRun: Boolean(dryRun),
            }),
          }));
          if (dryRun) {
            return jsonResponse({
              ok: true,
              dryRun: true,
              proposal: {
                category: result.category,
                dir: result.dir,
                name: result.name,
                metadata: result.metadata,
              },
            });
          }
          return jsonResponse(
            annotateSharedWrite(level, {
              ok: true,
              created: { document: { id: result.id } },
              category: result.category,
              dir: result.dir,
              metadata: result.metadata,
            }),
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );
}
