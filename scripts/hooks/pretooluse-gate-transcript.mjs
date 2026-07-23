// Transcript-analysis concern for the L2 PreToolUse memory-write gate.
// Kept in its own module so pretooluse-gate-memory-writes.mjs stays focused on
// the decision + emit contract. No side effects on import.

import fs from "node:fs";
import { isGatedWrite } from "../lib/context/write.mjs";

export const GATED_TOOLS = new Set([
  "mcp__llm-wiki-memory__save_lesson",
  "mcp__llm-wiki-memory__save_to_dataset",
  "mcp__llm-wiki-memory__write_memory",
]);

// True iff a gated tool call lands in a GATED category. save_lesson is always
// gated (self_improvement by construction). For save_to_dataset / write_memory,
// reads the NESTED production tool_input (`input.write.{dataset|datasetId|path}`
// — the pre-H2-fix code read a FLAT shape that never matched production, so L2
// gating was dead for these two tools), falling back to a flat shape for
// robustness, and applies the SAME `isGatedWrite` predicate as the L3 server.
// Layout: this L2 pre-filter uses the name-keyed DEFAULT gated set
// (self_improvement) — cheap, no per-call target-root resolution (F10); the L3
// server enforces each target wiki's actual `gated:` flags authoritatively.
/**
 * @param {string} name
 * @param {Record<string, unknown>} [input]
 * @returns {boolean}
 */
export function isGatedSelfImprovementCall(name, input = {}) {
  if (name === "mcp__llm-wiki-memory__save_lesson") return true;
  const w = /** @type {Record<string, unknown>} */ (
    input && typeof input.write === "object" && input.write ? input.write : input
  );
  if (name === "mcp__llm-wiki-memory__save_to_dataset") {
    return isGatedWrite(String(w?.dataset || ""), /** @type {string} */ (w?.path));
  }
  if (name === "mcp__llm-wiki-memory__write_memory") {
    return isGatedWrite(String(w?.datasetId || ""), /** @type {string} */ (w?.path));
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
// A save-prompt offers exactly these affirmative option labels (memory-write-gate.md /
// self-improvement.md); "Skip" declines. COUPLED to those exact label strings — keep the
// three in sync (drift fails CLOSED: an unrecognised label counts 0 → a redundant `ask`).
const AFFIRMATIVE_LABELS = new Set([
  "Save (P1)",
  "Save as guardrail (P0)",
  "Save as contextual (P2)",
]);

// Claude Code renders an answered AskUserQuestion as `"<question>"="<selected label>"`
// pairs, joined `, `, in the SAME order as the tool_use `questions` (a chosen option may
// append ` selected preview:\n<preview>` after its value). Question and option text are
// MODEL-AUTHORED and rendered VERBATIM WITHOUT ESCAPING embedded quotes — so we cannot
// safely tokenise the flat blob: a model can splice a fake `"="Save (P1)", "` sequence
// into its own question text and mimic a real pair.
//
// Consent is therefore BOUND to the real questions. We walk the tool_use `questions` IN
// ORDER, and for each locate its verbatim `"<question>"="` block searching FORWARD from a
// cursor past the previous answer, then read the selected value up to the next `"`. Two
// properties make this forge-resistant: (a) the value is read immediately after the FULL
// known question string, so an injected token inside that question is part of the needle,
// not the answer; and (b) forward-only scanning means an injected `"<laterQuestion>"="…"`
// placed inside an EARLIER question's text sits before the cursor and is never read as the
// later question's answer. A counted approval thus requires a real question AND the user's
// real selection being one of the exact AFFIRMATIVE_LABELS. A question block absent from
// the render (drift, truncation) is skipped → fail-closed (a redundant `ask`).
//
// This is a strong best-effort heuristic, NOT a tamper-proof control: because option
// PREVIEW text is also model-authored and rendered verbatim, a model that injects a fake
// pair into the preview of an option the user actually selects could still forge one
// count. That residual is accepted — L2 is a UX layer over the airtight L3 server gate
// (`userRequested:true` required on every gated write) and the redacted audit ledger,
// which together make any un-consented save visible and refusable regardless of L2.

/** @param {unknown} block @returns {string} */
function toolResultText(block) {
  const c = /** @type {{ content?: unknown }} */ (block)?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) =>
        typeof p === "string"
          ? p
          : p?.type === "text" && typeof p.text === "string"
            ? p.text
            : typeof p?.content === "string"
              ? p.content
              : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * @param {string | undefined} answerText
 * @param {Array<{ question?: unknown }> | undefined} questions
 * @returns {number}
 */
function countSaveSelections(answerText, questions) {
  if (!answerText || !Array.isArray(questions)) return 0;
  const s = String(answerText);
  let count = 0;
  let cursor = 0;
  for (const q of questions) {
    const qtext = String(q?.question ?? "");
    if (!qtext) continue;
    const needle = `"${qtext}"="`;
    const at = s.indexOf(needle, cursor);
    if (at < 0) continue;
    const start = at + needle.length;
    const end = s.indexOf('"', start);
    if (end < 0) continue;
    if (AFFIRMATIVE_LABELS.has(s.slice(start, end))) count += 1;
    cursor = end + 1;
  }
  return count;
}

/** @param {string} [transcriptPath] */
export function analyzeTranscript(transcriptPath) {
  const out = { lastUserText: "", gatedSince: 0, askApprovals: 0 };
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
  const askUseIds = new Set(); // ids of AskUserQuestion tool_use blocks
  const askQuestionsById = new Map(); // AskUserQuestion id -> its tool_use `questions`
  const resolvedIds = new Set(); // tool_use_ids that have a tool_result
  const resultTextById = new Map(); // tool_use_id -> its tool_result text
  for (let i = lastUserIdx + 1; i < recs.length; i++) {
    const rec = recs[i];
    const c = rec?.content ?? rec?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      if (block?.type === "tool_use" && block?.id) {
        if (isGatedSelfImprovementCall(block?.name, block?.input)) gatedUseIds.add(block.id);
        else if (block?.name === "AskUserQuestion") {
          askUseIds.add(block.id);
          const qs = block?.input?.questions;
          askQuestionsById.set(block.id, Array.isArray(qs) ? qs : []);
        }
      } else if (block?.type === "tool_result" && block?.tool_use_id) {
        resolvedIds.add(block.tool_use_id);
        const text = toolResultText(block);
        if (text) resultTextById.set(block.tool_use_id, text);
      }
    }
  }
  for (const id of gatedUseIds) {
    if (resolvedIds.has(id)) out.gatedSince += 1;
  }
  // Per-lesson consent via AskUserQuestion: an answered save-prompt approves N
  // lessons (its "Save…" selections bound to their real questions); the decision
  // layer allows exactly that many gated writes this turn. Unanswered prompts
  // contribute 0.
  for (const id of askUseIds) {
    if (resolvedIds.has(id)) {
      out.askApprovals += countSaveSelections(resultTextById.get(id), askQuestionsById.get(id));
    }
  }
  return out;
}
