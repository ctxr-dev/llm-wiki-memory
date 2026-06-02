// Schema-validating, prompt-file-aware wrapper around callLLMWithRetry.
//
// Two callers today:
//   - compile.mjs (existing decideAction): builds `systemPrompt` from a file
//     loader and `userPrompt` inline; no schema. callJSON here is a strict
//     superset of `callLLMWithRetry`, so the refactor preserves behaviour
//     byte-for-byte.
//   - consolidate.mjs (new 3A / 3B passes): prompts live in
//     prompts/consolidate-merge.md and prompts/consolidate-refresh.md as
//     fixed files; vars are interpolated at call-time; a zod schema validates
//     the LLM's JSON response and the call retries up to `maxRetries` on a
//     schema mismatch (in addition to the existing one-shot strict-JSON
//     retry inside callLLMWithRetry).
//
// The retry budget: each `callLLMWithRetry` invocation = up to 2 attempts (1
// initial + 1 strict-JSON re-prompt). callJSON wraps that with `maxRetries`
// schema-failure retries — so total worst case is `(maxRetries+1) * 2`
// LLM calls. With `maxRetries=2` (the consolidate default), 6 calls max per
// decision before the caller gets a terminal LLMOutputInvalid.

import fs from "node:fs";
import { callLLMWithRetry, LLMOutputInvalid } from "./llm.mjs";

// Interpolate `{{KEY}}` placeholders in `template` from `vars`. Unknown keys
// stay as-is (intentional: lets a prompt template carry literal `{{...}}`
// when needed). Non-string values are JSON-stringified so a complex `vars`
// payload (object / array) renders as JSON in the prompt — matches what
// callers usually want and what the prompts already document.
export function interpolate(template, vars) {
  if (!vars || typeof vars !== "object") return String(template ?? "");
  return String(template ?? "").replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => {
    if (!(key in vars)) return m;
    const v = vars[key];
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  });
}

// Load a prompt file from `promptPath`, then interpolate `vars`. Throws if
// the file is missing — a prompt typo or a missing template file should fail
// loudly at startup, not silently degrade to an empty system prompt.
export function loadPromptFile(promptPath, vars) {
  const raw = fs.readFileSync(promptPath, "utf8");
  return interpolate(raw, vars);
}

// Strict-superset wrapper.
//
//   await callJSON({
//     // Either provide a promptPath (loaded + interpolated as systemPrompt)
//     // OR a systemPrompt inline. promptPath wins if both are passed.
//     promptPath?: string,
//     systemPrompt?: string,
//     userPrompt: string,
//     vars?: Record<string, any>,    // {{KEY}} interpolation; applied to
//                                    // both systemPrompt (if inline) and
//                                    // userPrompt
//     maxTokens?: number,
//     maxRetries?: number,           // schema-failure retries (default 0;
//                                    // behaviour matches callLLMWithRetry)
//     schema?: ZodTypeAny,           // when provided, output is parsed by
//                                    // schema.safeParse; on failure, retry
//                                    // up to maxRetries with a corrective
//                                    // suffix in userPrompt.
//   })
//
// Returns the parsed JSON (post-schema if `schema` was provided). Throws
// LLMOutputInvalid after exhausting retries.
export async function callJSON({
  promptPath,
  systemPrompt,
  userPrompt,
  vars,
  maxTokens,
  maxRetries = 0,
  schema,
} = {}) {
  const resolvedSystem = promptPath
    ? loadPromptFile(promptPath, vars)
    : interpolate(systemPrompt, vars);
  const resolvedUser = interpolate(userPrompt, vars);

  let lastErr;
  let attemptUser = resolvedUser;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const json = await callLLMWithRetry({
      systemPrompt: resolvedSystem,
      userPrompt: attemptUser,
      maxTokens,
    });
    if (!schema) return json;
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    lastErr = new LLMOutputInvalid(
      `LLM JSON failed schema validation: ${formatZodIssues(parsed.error)}`,
      JSON.stringify(json),
    );
    // Surface the specific schema failure back to the model on the next
    // attempt. Without this, the retry asks for the same prompt and the
    // model is likely to produce the same wrong shape.
    attemptUser =
      `${resolvedUser}\n\n---\nPREVIOUS ATTEMPT FAILED SCHEMA VALIDATION:\n${formatZodIssues(parsed.error)}\n` +
      `Output STRICT JSON that satisfies the schema described above. No prose, no markdown fences.`;
  }
  throw lastErr;
}

function formatZodIssues(zerr) {
  try {
    return (zerr.issues || zerr.errors || [])
      .map((iss) => `- ${(iss.path || []).join(".") || "<root>"}: ${iss.message}`)
      .join("\n");
  } catch {
    return String(zerr?.message || zerr || "schema validation failed");
  }
}
