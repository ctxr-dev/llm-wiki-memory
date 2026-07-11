// Transcript-analysis concern for the L2 PreToolUse memory-write gate.
// Kept in its own module so pretooluse-gate-memory-writes.mjs stays focused on
// the decision + emit contract. No side effects on import.

import fs from "node:fs";
import { placementTargetsCategory } from "../lib/gate-target.mjs";

export const GATED_TOOLS = new Set([
  "mcp__llm-wiki-memory__save_lesson",
  "mcp__llm-wiki-memory__save_to_dataset",
  "mcp__llm-wiki-memory__write_memory",
]);

// True iff a gated tool call actually lands in the self_improvement category
// (the only gated one). Uses the SAME shared path predicate as the L3 server's
// targetsGatedCategory so the hook gates AND counts exactly the writes the server
// gates, including the dataset:"knowledge" + path:"self_improvement/..." bypass.
/**
 * @param {string} name
 * @param {Record<string, unknown>} [input]
 * @returns {boolean}
 */
export function isGatedSelfImprovementCall(name, input = {}) {
  if (name === "mcp__llm-wiki-memory__save_lesson") return true;
  if (name === "mcp__llm-wiki-memory__save_to_dataset") {
    return (
      input?.dataset === "self_improvement" ||
      placementTargetsCategory(input?.path, "self_improvement")
    );
  }
  if (name === "mcp__llm-wiki-memory__write_memory") {
    return (
      input?.datasetId === "self_improvement" ||
      placementTargetsCategory(input?.path, "self_improvement")
    );
  }
  return false;
}

// One pass over the JSONL transcript. Returns BOTH the latest typed-by-the-user
// prose AND the number of gated self_improvement tool calls the assistant has
// already made SINCE that user turn. The count powers per-lesson consent: a save
// phrase authorises only the FIRST gated write of a turn; a 2nd+ write in the
// same turn must be confirmed, so a session-end flush can no longer ride one
// approval. Shapes vary across Claude Code versions, so several common paths are
// tried and the first that parses wins. Any failure yields the empty/zero result
// (the caller then falls back to "ask").
/** @param {string} [transcriptPath] */
export function analyzeTranscript(transcriptPath) {
  const out = { lastUserText: "", gatedSince: 0 };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return out;
  let recs;
  try {
    recs = fs
      .readFileSync(transcriptPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return out;
  }
  // Most recent user PROSE record (skip synthetic tool_result user records,
  // which carry only a content array of tool_result blocks).
  let lastUserIdx = -1;
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i];
    const role = rec?.role || rec?.type || rec?.message?.role;
    if (role !== "user") continue;
    const c = rec?.content ?? rec?.message?.content;
    let text = "";
    if (typeof c === "string") text = c.trim();
    else if (Array.isArray(c)) {
      text = c
        .map((p) =>
          typeof p === "string"
            ? p
            : p?.type === "text" && typeof p.text === "string"
              ? p.text
              : "",
        )
        .filter(Boolean)
        .join(" ")
        .trim();
    }
    if (text) {
      out.lastUserText = text;
      lastUserIdx = i;
      break;
    }
  }
  // Count gated self_improvement writes that have already COMPLETED since that
  // user turn: a tool_use with a matching tool_result. The current pending call
  // has no tool_result yet, so it is never counted. Keying on completion (not on
  // mere presence of the tool_use) makes this robust to whether Claude Code has
  // already appended the current call's tool_use block to the transcript at
  // PreToolUse time. gatedSince > 0 means "a prior lesson this turn already used
  // the approval".
  //
  // KNOWN LIMITATION (accepted): if the model emits N gated writes in ONE
  // assistant message (parallel tool use), none have a tool_result yet, so all N
  // ride the single save phrase. Per-lesson consent therefore assumes the common
  // case where MCP writes serialise (each completes before the next fires). It is
  // a UX layer: the airtight L3 server still requires userRequested:true on EVERY
  // call regardless of parallelism, and the audit ledger records each one, so a
  // parallel batch is never silently un-gated, only un-prompted. Counting
  // unresolved tool_use to close this would reintroduce the transcript-timing
  // fragility the completion-keying was chosen to avoid (the current call's own
  // already-appended tool_use would be miscounted), so it is deliberately not done.
  const gatedUseIds = new Set(); // ids of gated self_improvement tool_use blocks
  const resolvedIds = new Set(); // tool_use_ids that have a tool_result
  for (let i = lastUserIdx + 1; i < recs.length; i++) {
    const rec = recs[i];
    const c = rec?.content ?? rec?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      if (
        block?.type === "tool_use" &&
        block?.id &&
        isGatedSelfImprovementCall(block?.name, block?.input)
      ) {
        gatedUseIds.add(block.id);
      } else if (block?.type === "tool_result" && block?.tool_use_id) {
        resolvedIds.add(block.tool_use_id);
      }
    }
  }
  for (const id of gatedUseIds) {
    if (resolvedIds.has(id)) out.gatedSince += 1;
  }
  return out;
}
