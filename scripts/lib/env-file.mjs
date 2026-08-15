// Reading and parsing the dotenv file at <MEMORY_DATA_DIR>/settings/.env: its value grammar
// (quoting, inline comments) and the mtime-keyed parse cache. Split from env.mjs, which owns the
// resolved environment API and the path constants — this module answers only "what does the file
// say", and knows nothing about process.env precedence.

import fs from "node:fs";

// Parse one .env value. Deliberately small (NOT a full dotenv parser): it
// trims, honours a simple pair of surrounding single or double quotes (the
// content from the first quote to the next matching quote is taken literally,
// including a '#'; escaped quotes / backslashes are NOT handled, which is fine
// for the simple values this project stores), and otherwise drops an inline
// "# comment" (a '#' at the start, or preceded by whitespace). Without this, an
// inline comment on a value line (e.g. `MEMORY_FLUSH_SLOT=daily   # ...`) leaks
// into the value, so the slot name becomes "daily   # ..." and every consumer
// silently reads a polluted string.
/**
 * @param {unknown} raw
 * @returns {string}
 */
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

// The PARSE, memoised on (path, mtime, size) — never a resolved lookup, so `envValue`'s
// process.env-first rule below is untouched and a runtime mutation still wins on every call.
//
// This is the hot path nobody expected. `settings()` already caches its parsed YAML by mtime, but
// building that cache KEY calls envValue 4-6 times, so a settings() cache HIT re-read this file six
// times over: measured at ~33µs per parse of a 695-byte file, that is ~200µs per settings() hit and
// 400-600µs per cacheStamp(). A stat is ~0.8µs, so revalidating instead of re-parsing is ~35x
// cheaper, for every settings consumer rather than just recall.
//
// Same mtime-revalidation shape as ownerConfiguredBackend in embed-cache-guards.mjs. A MISS is
// cached too (mtimeMs 0), because an absent .env is the common case and must still notice the file
// appearing later — hence keying on the stat outcome rather than short-circuiting on existence.
// SECRETS ARE NEVER CACHED. `settings/.env` is the documented home for API keys (templates/env.example
// lists ANTHROPIC_API_KEY / OPENAI_API_KEY, read via envValue by llm-api-providers.mjs), so memoising
// the parse would hold plaintext credentials in a module-level Map for the life of a process that
// runs for DAYS. That grants no new capability — anything that can read this Map could read the file
// — but it lengthens the window in which a heap dump yields a live key, for no benefit: a credential
// is read a handful of times per process, when a provider is invoked. The 35x win comes entirely
// from the MEMORY_* config keys read thousands of times, and those are still cached.
//
// Matched by NAME rather than by inspecting the value: the names are conventional and stable,
// whereas a value heuristic would both miss real keys and quarantine innocent config. A rotated
// credential is also picked up instantly as a side effect, since it never rides the mtime key.
const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;

/** @param {string} name @returns {boolean} */
function isSecretEnvName(name) {
  return SECRET_NAME.test(String(name || ""));
}

// PRESENCE of a secret is cached; its VALUE never is. `settings()` builds its own cache key from
// `envHasAnthropicKey()` / `envHasOpenAiKey()` — booleans, not credentials — so without this a
// settings() hit paid two uncached secret reads and the 35x win collapsed to ~65µs. Knowing that a
// key exists is not the key.
/**
 * @type {Map<string, {
 *   mtimeMs: number, size: number,
 *   parsed: Record<string, string>, secretsPresent: Set<string>,
 * }>}
 */
const envFileCache = new Map();

/** Test seam: drops the memo so a fixture can rewrite .env within one millisecond. @returns {void} */
export function __resetEnvFileCache() {
  envFileCache.clear();
}

// Test seam for the security property: lets a test assert on what is RETAINED, which a
// return-value assertion cannot distinguish.
/** @returns {Record<string, Record<string, string>>} */
export function __envFileCacheSnapshot() {
  /** @type {Record<string, Record<string, string>>} */
  const out = {};
  for (const [file, entry] of envFileCache) out[file] = { ...entry.parsed };
  return out;
}

/** @param {string} file @returns {Record<string, string>} */
function parseEnvFile(file) {
  /** @type {Record<string, string>} */
  const out = {};
  try {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i === -1) continue;
      out[line.slice(0, i).trim()] = parseEnvValue(line.slice(i + 1));
    }
  } catch {
    /* raced with a delete: an empty map is the honest answer */
  }
  return out;
}

// Reads ONE value. Secret-named keys take a fresh read every time and are never stored; everything
// else is served from the mtime-keyed cache. Split from the bulk reader so no caller can obtain a
// map that contains a credential.
/**
 * @param {string} file absolute path — supplied by the caller so this module stays acyclic
 * @param {string} name
 * @returns {string | undefined}
 */
export function readEnvValueFrom(file, name) {
  if (isSecretEnvName(name)) return parseEnvFile(file)[name];
  return readEnvFile(file)[name];
}

// Whether the file declares a NON-EMPTY value for `name`, without materialising a secret. Served
// from the cache for secrets and non-secrets alike, because a boolean is not a credential.
/**
 * @param {string} file absolute path — supplied by the caller so this module stays acyclic
 * @param {string} name
 * @returns {boolean}
 */
export function envFileHas(file, name) {
  if (!isSecretEnvName(name)) return Boolean(String(readEnvFile(file)[name] ?? "").trim());
  return cacheEntry(file).secretsPresent.has(name);
}

// The cached, secret-free view of the file. Module-internal: every external read goes through
// readEnvValueFrom or envFileHas, so no caller can obtain a map and no map can hold a credential.
/**
 * @param {string} file
 * @returns {Record<string, string>}
 */
function readEnvFile(file) {
  return cacheEntry(file).parsed;
}

// The mtime-revalidated cache entry: a secret-FREE value map plus the NAMES of the secrets that
// were present with a non-empty value.
/**
 * @param {string} file
 * @returns {{ parsed: Record<string, string>, secretsPresent: Set<string> }}
 */
function cacheEntry(file) {
  let mtimeMs = 0;
  let size = 0;
  try {
    const stat = fs.statSync(file);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    // Absent (or unreadable): cached as mtime 0 so repeated lookups cost one stat, while a file
    // created later still changes the key and is picked up.
  }
  const memo = envFileCache.get(file);
  if (memo && memo.mtimeMs === mtimeMs && memo.size === size) return memo;
  /** @type {Record<string, string>} */
  const parsed = {};
  /** @type {Set<string>} */
  const secretsPresent = new Set();
  if (mtimeMs !== 0 || size !== 0) {
    for (const [key, value] of Object.entries(parseEnvFile(file))) {
      if (!isSecretEnvName(key)) parsed[key] = value;
      else if (String(value ?? "").trim()) secretsPresent.add(key);
    }
  }
  const entry = { mtimeMs, size, parsed, secretsPresent };
  envFileCache.set(file, entry);
  return entry;
}
