import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/env.mjs -> project clone root is two levels up.
export const MEMORY_DIR = path.resolve(here, "../..");

// Resolve the host workspace root from the clone location.
// Installed layout (<workspace>/.llm-wiki-memory/src) -> workspace is two
// levels up. A bare repo checkout / repo-dev workflow -> one level up.
const inMemorySrc =
  path.basename(MEMORY_DIR) === "src" &&
  path.basename(path.dirname(MEMORY_DIR)) === ".llm-wiki-memory";
export const WORKSPACE_DIR = path.resolve(MEMORY_DIR, inMemorySrc ? "../.." : "..");

// Durable, (by default) gitignored data dir holding the wiki, the embedding
// index, and settings. Overridable via MEMORY_DATA_DIR for tests.
export const MEMORY_DATA_DIR =
  process.env.MEMORY_DATA_DIR && process.env.MEMORY_DATA_DIR !== ""
    ? process.env.MEMORY_DATA_DIR
    : path.join(WORKSPACE_DIR, ".llm-wiki-memory");

export const ENV_PATH = path.join(MEMORY_DATA_DIR, "settings", ".env");
// Runtime compile state/lock live under the durable data dir (not the repo
// clone), so the source tree stays clean and parallel installs don't collide.
export const COMPILE_STATE_PATH = path.join(MEMORY_DATA_DIR, "state", ".compile-state.json");
export const COMPILE_LOCK_PATH = path.join(MEMORY_DATA_DIR, "state", ".compile.lock");
export const PROMPTS_DIR = path.join(MEMORY_DIR, "prompts");

// Parse one .env value. Deliberately small (NOT a full dotenv parser): it
// trims, honours a simple pair of surrounding single or double quotes (the
// content from the first quote to the next matching quote is taken literally,
// including a '#'; escaped quotes / backslashes are NOT handled, which is fine
// for the simple values this project stores), and otherwise drops an inline
// "# comment" (a '#' at the start, or preceded by whitespace). Without this, an
// inline comment on a value line (e.g. `MEMORY_FLUSH_SLOT=daily   # ...`) leaks
// into the value, so the slot name becomes "daily   # ..." and every consumer
// silently reads a polluted string.
export function parseEnvValue(raw) {
  let v = String(raw ?? "").trim();
  if (!v) return "";
  // Quoted value: return the literal inside the first matching quote pair and
  // ignore anything after the closing quote (e.g. a trailing inline comment,
  // `"value" # note`). A '#' inside the quotes is kept.
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end !== -1) return v.slice(1, end);
    // Unterminated quote (malformed): return the trimmed value literally rather
    // than guessing, so a stray '#' inside it is not mistaken for a comment.
    return v;
  }
  if (v[0] === "#") return "";
  // Unquoted: a '#' preceded by whitespace starts an inline comment.
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash);
  return v.trim();
}

export function readEnvFile(file = ENV_PATH) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = parseEnvValue(line.slice(i + 1));
  }
  return out;
}

export function envValue(name, fallback = "") {
  if (process.env[name] != null && process.env[name] !== "") return process.env[name];
  const file = readEnvFile();
  return file[name] ?? fallback;
}

export function envInt(name, fallback) {
  const raw = envValue(name, "");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const ATOM_BODY_MAX_CHARS_DEFAULT = 700;
export function atomBodyMaxChars() {
  return envInt("MEMORY_ATOM_BODY_MAX_CHARS", ATOM_BODY_MAX_CHARS_DEFAULT);
}

// Absolute path to the hosted wiki root. Override with LLM_WIKI_MEMORY_ROOT
// (absolute, or relative to the workspace). Defaults to <data>/wiki.
export function wikiRoot() {
  const configured = envValue("LLM_WIKI_MEMORY_ROOT", "");
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(WORKSPACE_DIR, configured);
  }
  return path.join(MEMORY_DATA_DIR, "wiki");
}

// Absolute path to the embedding cache JSON.
export function embedCachePath() {
  const configured = envValue("MEMORY_EMBED_CACHE", "");
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(WORKSPACE_DIR, configured);
  }
  return path.join(MEMORY_DATA_DIR, "index", "embeddings.json");
}

// Workspace identifier used to scope recall so two installs don't cross-leak.
// Mirrors the boilerplate's COMPOSE_PROJECT_NAME / MEMORY_DEFAULT_PROJECT_MODULE.
export function defaultProjectModule() {
  return (
    envValue("MEMORY_DEFAULT_PROJECT_MODULE", "") ||
    envValue("LLM_WIKI_MEMORY_PROJECT", "") ||
    path.basename(WORKSPACE_DIR) ||
    ""
  );
}
