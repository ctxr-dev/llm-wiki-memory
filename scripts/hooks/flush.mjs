import fs from "node:fs";
import path from "node:path";
import { PROMPTS_DIR, envInt, envValue, atomBodyMaxChars, wikiRoot } from "../lib/env.mjs";
import { redact } from "../lib/redact.mjs";
import { dailyDocName } from "../lib/slug.mjs";
import { ATOM_TYPES, TASK_TYPES } from "../lib/datasets.mjs";
import { callLLMWithRetry, LLMProviderUnavailable, LLMOutputInvalid } from "../lib/llm.mjs";
import { writeMemory, WikiStoreUnavailable } from "../lib/wiki-store.mjs";

class SkipMemory extends Error {}

const mode = process.argv[2] || "session-end";
const VALID_MODES = new Set(["pre-compact", "post-compact", "session-end"]);
if (!VALID_MODES.has(mode)) {
  console.error(`flush.mjs: unknown mode '${mode}'`);
  process.exit(1);
}

const MAX_TURNS = envInt("MEMORY_HOOK_MAX_TURNS", 30);
const MAX_CHARS = envInt("MEMORY_HOOK_MAX_CHARS", 80_000);
const SESSION_END_MIN_TURNS = envInt("MEMORY_HOOK_SESSION_END_MIN_TURNS", 1);
const PRECOMPACT_MIN_TURNS = envInt("MEMORY_HOOK_PRECOMPACT_MIN_TURNS", 5);

function readStdin() {
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

function parseJsonMaybe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractTextBlocks(value, depth = 0) {
  if (depth > 8 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => extractTextBlocks(v, depth + 1));
  if (typeof value !== "object") return [];
  if (value.type === "tool_use" || value.type === "tool_result") return [];
  if (typeof value.text === "string") return [value.text];
  return ["message", "content", "prompt", "compact_summary", "summary"]
    .flatMap((field) => extractTextBlocks(value[field], depth + 1));
}

function transcriptToMarkdown(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { markdown: "", turnCount: 0 };
  }
  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
  const blocks = [];
  for (const line of lines) {
    const entry = parseJsonMaybe(line);
    if (!entry) continue;
    const role = entry.message?.role || entry.role || entry.type || "entry";
    if (!["user", "assistant", "summary", "system"].includes(role)) continue;
    const text = extractTextBlocks(entry).join("\n").trim();
    if (!text) continue;
    const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role;
    blocks.push(`### ${label}\n\n${text}`);
  }
  const recent = blocks.slice(-MAX_TURNS);
  return { markdown: recent.join("\n\n"), turnCount: recent.length };
}

function sliceForLLM(text) {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(-MAX_CHARS)}\n\n[Truncated to last ${MAX_CHARS} chars by flush.mjs.]`;
}

function buildSourceMaterial(rawInput) {
  const hookInput = parseJsonMaybe(rawInput) || {};
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

  const minTurns = mode === "pre-compact" ? PRECOMPACT_MIN_TURNS : SESSION_END_MIN_TURNS;
  if (!fromCompactSummary && turnCount < minTurns) {
    throw new SkipMemory(`only ${turnCount} transcript turns; minimum for ${mode} is ${minTurns}`);
  }
  if (!body) {
    throw new SkipMemory(`no usable transcript content for ${mode}`);
  }

  return { sessionId, cwd, hookEvent, body: sliceForLLM(body), turnCount };
}

function loadPrompt() {
  const file = path.join(PROMPTS_DIR, "flush.md");
  if (!fs.existsSync(file)) {
    throw new Error(`flush prompt missing at ${file}`);
  }
  const cap = atomBodyMaxChars();
  return fs.readFileSync(file, "utf8").replace(/\{\{ATOM_BODY_MAX_CHARS\}\}/g, String(cap));
}

function normaliseMetadata(raw) {
  const md = (raw && typeof raw === "object") ? raw : {};
  // Strip CR/LF before trim so a metadata value cannot break the line-based
  // parser in compile.mjs (every flush atom is rendered as a single
  // `- metadata: <json>` line).
  const clean = (v) => String(v || "").replace(/[\r\n]+/g, " ").trim();
  const taskType = clean(md.task_type).toLowerCase();
  return {
    project_module: clean(md.project_module).toLowerCase(),
    language: clean(md.language).toLowerCase(),
    // Out-of-set task_type collapses to "unknown" so the lesson is still
    // filterable; previously it became "" which dropped the atom.
    task_type: TASK_TYPES.has(taskType) ? taskType : (taskType ? "unknown" : ""),
    error_pattern: clean(md.error_pattern).toLowerCase(),
  };
}

function validateAtoms(parsed) {
  if (!parsed || !Array.isArray(parsed.atoms)) {
    throw new LLMOutputInvalid("LLM JSON missing 'atoms' array", JSON.stringify(parsed));
  }
  // Compute the body cap ONCE, not per atom. atomBodyMaxChars() walks
  // envValue() -> readEnvFile() which re-reads ./.memory/settings/.env from disk on
  // every call; reading it once per flush (instead of once per atom)
  // avoids N filesystem reads in the validation loop.
  const bodyMaxChars = atomBodyMaxChars();
  const cleaned = [];
  for (const atom of parsed.atoms) {
    if (!atom || typeof atom !== "object") continue;
    const type = String(atom.type || "").toLowerCase();
    const title = String(atom.title || "").trim();
    const body = String(atom.body || "").trim();
    if (!ATOM_TYPES.has(type) || !title || !body) continue;
    // `plan` is in ATOM_TYPES because the ExitPlanMode hook tags docs
    // with it, but the flush+compile path must NOT produce plans (they
    // are upsert-by-name into the `plans` slot, not dedup-merged
    // dailies). Drop any LLM hallucination silently.
    if (type === "plan") {
      console.error(`flush.mjs: dropped plan-typed atom '${title.slice(0, 40)}' (plans are hook-only)`);
      continue;
    }
    const tags = Array.isArray(atom.tags)
      ? atom.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
      : [];
    if (tags.length === 0) continue;
    const metadata = normaliseMetadata(atom.metadata);
    if (type === "self-improvement-lesson") {
      // Lessons MUST have project_module, task_type, and error_pattern so
      // recall_lessons can filter them precisely. Drop malformed lessons
      // rather than flooding the store with un-filterable noise.
      if (!metadata.project_module || !metadata.task_type || !metadata.error_pattern) {
        console.error(
          `flush.mjs: dropped self-improvement-lesson '${title.slice(0, 40)}' (missing required metadata)`,
        );
        continue;
      }
    }
    cleaned.push({
      type,
      title: title.slice(0, 80),
      body: body.slice(0, bodyMaxChars),
      tags,
      metadata,
      evidence: atom.evidence ? String(atom.evidence).slice(0, 240).trim() : undefined,
    });
  }
  return cleaned;
}

function renderDailyDocument({ atoms, source }) {
  const sid = String(source.sessionId).slice(0, 8);
  const headerLines = [
    `# Daily flush ${source.hookEvent}`,
    "",
    `- captured_at_utc: ${new Date().toISOString()}`,
    `- hook_event: ${source.hookEvent}`,
    `- session_id: ${source.sessionId}`,
    `- session_short: ${sid}`,
    `- workspace: ${path.basename(String(source.cwd || ""))}`,
    `- atom_count: ${atoms.length}`,
    `- pending_promotion: true`,
    "",
  ];

  const blocks = atoms.map((atom) => {
    const lines = [
      `### Atom · ${atom.type} · ${atom.title}`,
      `- type: ${atom.type}`,
      `- title: ${atom.title}`,
      `- tags: [${atom.tags.join(", ")}]`,
      `- metadata: ${JSON.stringify(atom.metadata)}`,
      `- body: |`,
      ...atom.body.split(/\r?\n/).map((l) => `    ${l}`),
    ];
    if (atom.evidence) lines.push(`- evidence: ${JSON.stringify(atom.evidence)}`);
    return lines.join("\n");
  });

  return [...headerLines, ...blocks].join("\n").concat("\n");
}

async function main() {
  const rawInput = readStdin();
  const source = buildSourceMaterial(rawInput);
  const systemPrompt = loadPrompt();

  let parsed;
  try {
    parsed = await callLLMWithRetry({
      systemPrompt,
      userPrompt:
        `Hook event: ${source.hookEvent}\nSession id: ${source.sessionId}\nCwd: ${source.cwd}\n\n` +
        `--- TRANSCRIPT ---\n\n${source.body}`,
      maxTokens: 1500,
    });
  } catch (err) {
    if (err instanceof LLMProviderUnavailable) {
      throw new SkipMemory(`LLM provider unavailable: ${err.message}`);
    }
    if (err instanceof LLMOutputInvalid) {
      throw new SkipMemory(`LLM output invalid after retry: ${err.message}`);
    }
    throw err;
  }

  const atoms = validateAtoms(parsed);
  if (atoms.length === 0) {
    throw new SkipMemory("LLM returned no usable atoms (transcript not durable)");
  }

  const docName = dailyDocName();
  const text = renderDailyDocument({ atoms, source });
  const datasetName = envValue("MEMORY_FLUSH_SLOT", "daily");

  // Preflight: refuse cleanly if the wiki hasn't been materialised yet, so the
  // user gets a useful skip message instead of a crash inside the skill CLI.
  const wiki = wikiRoot();
  if (!fs.existsSync(path.join(wiki, ".llmwiki.layout.yaml"))) {
    throw new SkipMemory(
      `wiki not initialised at ${wiki} (no .llmwiki.layout.yaml). Run ./.llm-wiki-memory/src/bootstrap.sh.`,
    );
  }

  try {
    const result = await writeMemory({ name: docName, text, datasetId: datasetName });
    console.error(
      `flush.mjs: wrote ${atoms.length} atom(s) to wiki slot '${datasetName}' as ${docName} (id=${result?.created?.document?.id || "?"})`,
    );
  } catch (err) {
    if (err instanceof WikiStoreUnavailable) {
      throw new SkipMemory(`wiki store unavailable: ${err.message}`);
    }
    throw err;
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof SkipMemory) {
    console.error(`flush.mjs: skipped (${mode}): ${err.message}`);
    process.exit(0);
  }
  console.error(`flush.mjs: failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
