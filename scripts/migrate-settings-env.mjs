import fs from "node:fs";
import { STRICT_KEYS } from "./migrate-settings-constants.mjs";

/**
 * @param {unknown} raw
 * @returns {string}
 */
function parseEnvValue(raw) {
  let v = String(raw ?? "").trim();
  if (!v) return "";
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end !== -1) return v.slice(1, end);
    return v;
  }
  if (v[0] === "#") return "";
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash);
  return v.trim();
}

/**
 * @param {string} file
 * @returns {{ kv: Record<string, string>, raw: Record<string, string>, originalText: string }}
 */
function readEnvLines(file) {
  if (!fs.existsSync(file)) return { kv: {}, raw: {}, originalText: "" };
  const text = fs.readFileSync(file, "utf8");
  /** @type {Record<string, string>} */
  const kv = {};
  /** @type {Record<string, string>} */
  const raw = {};
  for (const line of text.split(/\r?\n/)) {
    const trim = line.trim();
    if (!trim || trim.startsWith("#")) continue;
    const i = trim.indexOf("=");
    if (i === -1) continue;
    const key = trim.slice(0, i).trim();
    const rhs = trim.slice(i + 1);
    kv[key] = parseEnvValue(rhs);
    raw[key] = rhs;
  }
  return { kv, raw, originalText: text };
}

/**
 * @param {Record<string, string>} originalKv
 * @param {Record<string, string>} [originalRaw]
 * @returns {string}
 */
function serializeEnvStrictSubset(originalKv, originalRaw = {}) {
  // Carry forward only the strict-subset keys. Preserve their existing
  // values verbatim from the old .env; everything else is dropped (the
  // user is told via the runbook that comments next to removed keys are
  // gone in the migration).
  const lines = [
    "# llm-wiki-memory secrets + provider switches + paths.",
    "# Application config lives in ./settings.yaml — this file only carries",
    "# the strict subset that genuinely needs shell precedence:",
    "#   - API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY)",
    "#   - Provider switches (MEMORY_LLM_*)",
    "#   - Deployment paths (MEMORY_DATA_DIR, LLM_WIKI_MEMORY_ROOT, etc.)",
    "#   - Workspace identity (MEMORY_DEFAULT_PROJECT_MODULE)",
    "#   - Test seams (MEMORY_LLM_MOCK_*)",
    "# Everything else — consolidate / flush / hook / embed / recall / compile",
    "# / gc / gate / providers — is in ./settings.yaml.",
    "",
  ];
  for (const key of STRICT_KEYS) {
    if (originalKv[key] != null && originalKv[key] !== "") {
      // Re-emit the ORIGINAL raw RHS text so quotes, spaces and inline '#'
      // survive the round-trip; the PARSED value strips quotes and truncates
      // at ' #', so emitting it would corrupt such values (e.g. mock seams).
      const value = originalRaw[key] != null ? originalRaw[key] : originalKv[key];
      lines.push(`${key}=${value}`);
    }
  }
  return lines.join("\n") + "\n";
}

export { parseEnvValue, readEnvLines, serializeEnvStrictSubset };
