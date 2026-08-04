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
/** @type {Map<string, { mtimeMs: number, size: number, parsed: Record<string, string> }>} */
const envFileCache = new Map();

/** Test seam: drops the memo so a fixture can rewrite .env within one millisecond. @returns {void} */
export function __resetEnvFileCache() {
  envFileCache.clear();
}

/**
 * @param {string} file absolute path — supplied by the caller so this module stays acyclic
 * @returns {Record<string, string>}
 */
export function readEnvFile(file) {
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
  if (memo && memo.mtimeMs === mtimeMs && memo.size === size) return memo.parsed;
  /** @type {Record<string, string>} */
  const out = {};
  if (mtimeMs !== 0 || size !== 0) {
    try {
      for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const i = line.indexOf("=");
        if (i === -1) continue;
        out[line.slice(0, i).trim()] = parseEnvValue(line.slice(i + 1));
      }
    } catch {
      /* raced with a delete: an empty map is the honest answer, and it is not cached as valid */
    }
  }
  envFileCache.set(file, { mtimeMs, size, parsed: out });
  return out;
}
