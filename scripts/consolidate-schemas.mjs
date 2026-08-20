// Zod schemas for the two consolidate LLM passes (3A merge, 3B refresh). Same
// JSON-output-with-retry contract as compile's decideAction — the callJSON
// helper validates, throws LLMOutputInvalid on schema failure, retries up to
// consolidateLlmMaxRetries() with a corrective suffix, then bubbles a terminal
// failure to the caller (which falls back to the deterministic
// archive-without-merge / leave-stale-flag path).

import { z } from "zod";

/**
 * The adjudication the 3B LLM emits per stale leaf (the REFRESH_SCHEMA output).
 * @typedef {Object} RefreshDecision
 * @property {"keep" | "rewrite" | "archive"} action
 * @property {string} leaf_id
 * @property {string} [rewritten_body]
 * @property {string} [archive_reason]
 * @property {boolean} stale_after
 * @property {string} reason
 */

export const REFRESH_SCHEMA = z
  .object({
    action: z.enum(["keep", "rewrite", "archive"]),
    leaf_id: z.string().min(1),
    rewritten_body: z.string().min(1).optional(),
    archive_reason: z.string().min(1).optional(),
    stale_after: z.boolean(),
    reason: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.action === "rewrite" && !v.rewritten_body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rewritten_body"],
        message: "rewritten_body is required when action='rewrite'",
      });
    }
    if (v.action === "archive" && !v.archive_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archive_reason"],
        message: "archive_reason is required when action='archive'",
      });
    }
  });

export const MERGE_SCHEMA = z
  .object({
    action: z.enum(["merge", "keep-keeper-unchanged", "skip"]),
    merged_body: z.string().min(1).optional(),
    keeper_id: z.string().min(1),
    loser_id: z.string().min(1),
    reason: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.action === "merge" && !v.merged_body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["merged_body"],
        message: "merged_body is required when action='merge'",
      });
    }
  });
