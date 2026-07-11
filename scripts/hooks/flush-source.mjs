import fs from "node:fs";
import {
  hookMaxTurns,
  hookMaxChars,
  hookSessionEndMinTurns,
  hookPrecompactMinTurns,
} from "../lib/settings.mjs";
import { redact } from "../lib/redact.mjs";

export class SkipMemory extends Error {}

/**
 * The staged capture material the hook front produces and the worker distils.
 * `capturedAtMs` is stamped at capture time; synthesised sources (error marker)
 * may omit it.
 * @typedef {Object} SourceMaterial
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string} hookEvent
 * @property {string} body
 * @property {number} turnCount
 * @property {number} [capturedAtMs]
 */

/**
 * The Claude Code hook envelope fields this module reads off stdin.
 * @typedef {Object} FlushHookInput
 * @property {string} [session_id]
 * @property {string} [cwd]
 * @property {string} [hook_event_name]
 * @property {string} [transcript_path]
 * @property {string} [compact_summary]
 */

// Hook + flush thresholds — sourced from settings.yaml (see settings.mjs).
// Wrapped as zero-arg getters (NOT module-level constants) so test-seam
// overrides + hot-edited settings.yaml take effect mid-process.
const MAX_TURNS = () => hookMaxTurns();
const MAX_CHARS = () => hookMaxChars();
const SESSION_END_MIN_TURNS = () => hookSessionEndMinTurns();
const PRECOMPACT_MIN_TURNS = () => hookPrecompactMinTurns();

export function readStdin() {
  // When invoked outside a hook context (a curious user runs the .sh
  // directly with no pipe) fd 0 is a TTY and readFileSync(0) blocks until
  // Ctrl-D. Short-circuit to "" so manual debug runs are non-blocking.
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** @param {string} raw @returns {unknown} */
function parseJsonMaybe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string[]}
 */
function extractTextBlocks(value, depth = 0) {
  if (depth > 8 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => extractTextBlocks(v, depth + 1));
  if (typeof value !== "object") return [];
  const obj = /** @type {Record<string, unknown>} */ (value);
  if (obj.type === "tool_use" || obj.type === "tool_result") return [];
  if (typeof obj.text === "string") return [obj.text];
  return ["message", "content", "prompt", "compact_summary", "summary"].flatMap((field) =>
    extractTextBlocks(obj[field], depth + 1),
  );
}

/** @param {string} transcriptPath @returns {{ markdown: string, turnCount: number }} */
function transcriptToMarkdown(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { markdown: "", turnCount: 0 };
  }
  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
  /** @type {string[]} */
  const blocks = [];
  for (const line of lines) {
    const entry =
      /** @type {{ message?: { role?: string }, role?: string, type?: string } | null} */ (
        parseJsonMaybe(line)
      );
    if (!entry) continue;
    const role = entry.message?.role || entry.role || entry.type || "entry";
    if (!["user", "assistant", "summary", "system"].includes(role)) continue;
    const text = extractTextBlocks(entry).join("\n").trim();
    if (!text) continue;
    const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role;
    blocks.push(`### ${label}\n\n${text}`);
  }
  const recent = blocks.slice(-MAX_TURNS());
  return { markdown: recent.join("\n\n"), turnCount: recent.length };
}

/** @param {string} text @returns {string} */
function sliceForLLM(text) {
  const cap = MAX_CHARS();
  if (text.length <= cap) return text;
  return `${text.slice(-cap)}\n\n[Truncated to last ${cap} chars by flush.mjs.]`;
}

/**
 * @param {string} rawInput
 * @param {string} mode
 * @returns {SourceMaterial}
 */
export function buildSourceMaterial(rawInput, mode) {
  const hookInput = /** @type {FlushHookInput} */ (parseJsonMaybe(rawInput) || {});
  const sessionId = hookInput.session_id || "manual";
  const cwd = hookInput.cwd || process.cwd();
  const hookEvent = hookInput.hook_event_name || mode;
  const transcriptPath = hookInput.transcript_path || "";

  let body;
  let turnCount;
  let fromCompactSummary = false;
  if (hookInput.compact_summary) {
    body = `## Compact Summary\n\n${hookInput.compact_summary}`;
    turnCount = 1;
    fromCompactSummary = true;
  } else if (transcriptPath) {
    const transcript = transcriptToMarkdown(transcriptPath);
    body = transcript.markdown;
    turnCount = transcript.turnCount;
  } else {
    body = "";
    turnCount = 0;
  }

  body = redact(body).trim();

  const minTurns = mode === "pre-compact" ? PRECOMPACT_MIN_TURNS() : SESSION_END_MIN_TURNS();
  if (!fromCompactSummary && turnCount < minTurns) {
    throw new SkipMemory(`only ${turnCount} transcript turns; minimum for ${mode} is ${minTurns}`);
  }
  if (!body) {
    throw new SkipMemory(`no usable transcript content for ${mode}`);
  }

  // Stamp capture time in the hook front: the worker runs later, so a
  // render-time timestamp would record persist time, not capture time.
  return {
    sessionId,
    cwd,
    hookEvent,
    body: sliceForLLM(body),
    turnCount,
    capturedAtMs: Date.now(),
  };
}
