import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";

// Shared JSON-config merge core for both the merge-config.mjs CLI (per-file,
// template-driven) and the global-register module (in-memory entries). One
// implementation so the "preserve a customized/wrapped entry + user config"
// behavior can never diverge between the two callers.

/**
 * Merge our server entries WITHOUT clobbering a customized launcher. If the user
 * wrapped our own entry (a mandated security shim → its `command` differs from the
 * template's), preserve their entry verbatim; otherwise install/refresh ours. Other
 * servers are never touched.
 * @param {Record<string, unknown>} current @param {Record<string, unknown>} incoming
 */
function mergeServerEntries(current, incoming) {
  for (const [k, v] of Object.entries(incoming)) {
    const existing = /** @type {{ command?: unknown }} */ (current[k]);
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      v &&
      typeof v === "object" &&
      typeof existing.command === "string" &&
      existing.command !== /** @type {{ command?: unknown }} */ (v).command
    ) {
      console.error(`merge-config: preserving customized "${k}" (command differs from template)`);
      continue;
    }
    current[k] = v;
  }
}

/**
 * Merge our hook groups into each event's array, de-duped by the group's command
 * set, so a user's own hooks on the same event survive and a re-run adds nothing
 * new (idempotent).
 * @param {Record<string, unknown>} current @param {Record<string, unknown>} incoming
 */
function mergeHookEvents(current, incoming) {
  /** @param {unknown} g @returns {string} */
  const sig = (g) => {
    if (g && typeof g === "object" && "hooks" in g) {
      const grp = /** @type {{ matcher?: unknown, hooks?: unknown }} */ (g);
      const cmds = Array.isArray(grp.hooks)
        ? grp.hooks
            .map((h) =>
              h && typeof h === "object" && "command" in h
                ? /** @type {{ command: unknown }} */ (h).command
                : h,
            )
            .sort()
        : grp.hooks;
      return JSON.stringify({ matcher: grp.matcher, cmds });
    }
    return JSON.stringify(g);
  };
  for (const [event, groups] of Object.entries(incoming)) {
    const ours = Array.isArray(groups) ? groups : [];
    const prior = Array.isArray(current[event])
      ? /** @type {unknown[]} */ (current[event])
      : current[event] !== undefined
        ? [current[event]]
        : [];
    const have = new Set(prior.map(sig));
    current[event] = [...prior, ...ours.filter((g) => !have.has(sig(g)))];
  }
}

/**
 * null when absent; throws on a present-but-unparseable file so the caller
 * decides (a user config → back up before rewriting). Never silently dropped.
 * @param {string} file
 * @returns {{ raw: string, value: unknown } | null}
 */
export function readJsonOrThrow(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === "ENOENT") return null;
    throw err;
  }
  return { raw, value: JSON.parse(raw) };
}

export class CorruptConfigRefused extends Error {}

/**
 * Merge `incoming` entries into `targetFile[topKey]`, preserving the rest of the
 * user's file. `topKey` "hooks" uses the hook-event merger; anything else uses
 * the server merger.
 *
 * A corrupt target is backed up to `.bak`. Then, by default (a disposable
 * project file), the merge proceeds from empty. But `refuseOnCorrupt` (set when
 * writing a user's CRITICAL global config, e.g. ~/.claude.json — Claude Code's
 * whole state, often being written concurrently) makes a NON-EMPTY unparseable
 * target THROW `CorruptConfigRefused` AFTER backing up, so the caller never
 * replaces live state with a near-empty stub on a transient/partial read.
 *
 * @param {string} targetFile
 * @param {Record<string, unknown>} incoming
 * @param {string} topKey
 * @param {{ refuseOnCorrupt?: boolean }} [opts]
 * @returns {void}
 */
export function mergeIntoJsonFile(targetFile, incoming, topKey, { refuseOnCorrupt = false } = {}) {
  /** @type {Record<string, unknown>} */
  let target = {};
  try {
    const targetRead = readJsonOrThrow(targetFile);
    if (targetRead) target = /** @type {Record<string, unknown>} */ (targetRead.value);
  } catch (err) {
    let raw = "";
    try {
      raw = fs.readFileSync(targetFile, "utf8");
      writeFileAtomic(`${targetFile}.bak`, raw);
    } catch {
      /* best-effort backup */
    }
    if (refuseOnCorrupt && raw.trim() !== "") {
      throw new CorruptConfigRefused(
        `${targetFile} is not valid JSON; backed up to ${targetFile}.bak and REFUSED to rewrite (it may have been read mid-write). Restore it and re-run.`,
      );
    }
    console.error(
      `merge-config: ${targetFile} is not valid JSON (${/** @type {Error} */ (err)?.message || err}); backed up to ${targetFile}.bak and rewriting from template — reconcile any custom keys from the backup.`,
    );
    target = {};
  }

  const existingTop = target[topKey];
  if (
    existingTop !== undefined &&
    (typeof existingTop !== "object" || Array.isArray(existingTop))
  ) {
    console.error(
      `merge-config: ${targetFile} "${topKey}" is not an object; resetting it to merge ${topKey}`,
    );
  }
  target[topKey] =
    existingTop && typeof existingTop === "object" && !Array.isArray(existingTop)
      ? existingTop
      : {};
  const current = /** @type {Record<string, unknown>} */ (target[topKey]);
  if (topKey === "hooks") mergeHookEvents(current, incoming);
  else mergeServerEntries(current, incoming);

  const next = `${JSON.stringify(target, null, 2)}\n`;
  let prior = null;
  try {
    prior = fs.readFileSync(targetFile, "utf8");
  } catch {
    prior = null;
  }
  if (next === prior) return; // no-op merge → don't churn the file (O1)
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  writeFileAtomic(targetFile, next);
}
