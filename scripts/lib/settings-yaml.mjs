import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { MEMORY_DIR } from "./env.mjs";

export const TEMPLATE_PATH = path.join(MEMORY_DIR, "templates", "settings.yaml");

/**
 * @typedef {{ ok: true, value: unknown } | { ok: false, error: unknown }} ParseResult
 */

// Parse a YAML file. Returns { ok, value } | { ok: false, error }. Never
// throws on a parse error (the caller decides whether a bad file is fatal).
/**
 * @param {string} p
 * @returns {ParseResult}
 */
function parseYamlFile(p) {
  if (!fs.existsSync(p)) return { ok: true, value: null };
  try {
    return { ok: true, value: parseYaml(fs.readFileSync(p, "utf8")) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * @param {string} file
 * @returns {unknown}
 */
export function readEffectiveYaml(file) {
  const user = parseYamlFile(file);
  if (!user.ok) {
    // A malformed USER settings.yaml (a hand-edit typo, or a crash-truncated
    // write) must NOT take down the whole memory system — every flush, recall,
    // compile, and cron tick reads settings(). Warn loudly and fall back to
    // the shipped template so the system stays UP on safe defaults; the
    // operator sees the path to fix (or restore from .env.bak). Throwing here
    // would crash every hook + the MCP server until the file is hand-repaired.
    process.stderr.write(
      `[llm-wiki-memory] WARNING: settings file ${file} is malformed ` +
        `(${/** @type {{ message?: unknown }} */ (user.error)?.message || user.error}); falling back to shipped defaults. ` +
        `Fix the YAML to re-apply your configuration.\n`,
    );
  } else if (user.value) {
    return user.value;
  }
  // Fall back to the shipped template. If the TEMPLATE is malformed, that's a
  // packaging bug, not an operator error — fail loudly.
  const tmpl = parseYamlFile(TEMPLATE_PATH);
  if (!tmpl.ok) {
    throw new Error(
      `settings: shipped template ${TEMPLATE_PATH} failed to parse: ${/** @type {{ message?: unknown }} */ (tmpl.error)?.message || tmpl.error}`,
    );
  }
  return tmpl.value;
}
