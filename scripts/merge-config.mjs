#!/usr/bin/env node
// Merge a top-level key from a template JSON into a target JSON file,
// creating the target if absent. Used by bootstrap.sh to add our hooks to
// .claude/settings.json and our server to .mcp.json without clobbering the
// user's existing config.
//
//   node merge-config.mjs <targetFile> <templateFile> <topKey>
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./lib/atomic-write.mjs";

const [targetFile, templateFile, topKey] = process.argv.slice(2);
if (!targetFile || !templateFile || !topKey) {
  console.error("usage: merge-config.mjs <targetFile> <templateFile> <topKey>");
  process.exit(1);
}

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
  // Dedup identity = (matcher, the SET of command strings) — NOT the raw hook objects,
  // so a user's edit to a hook's `timeout` (or a client reserializing the object keys)
  // can't defeat dedup and duplicate our group on re-bootstrap.
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
 * @param {string} file
 * @returns {{ raw: string, value: unknown } | null}
 */
function readJsonOrThrow(file) {
  // null when absent; throws on a present-but-unparseable file so the caller
  // decides (template = packaging bug → surface; target = user config → back
  // up before rewriting). A malformed file is never silently dropped.
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === "ENOENT") return null;
    throw err;
  }
  return { raw, value: JSON.parse(raw) };
}

// The template ships in the package; a parse failure is a packaging bug, so
// let it surface rather than silently merging nothing.
const templateRead = readJsonOrThrow(templateFile);
const template = /** @type {Record<string, unknown>} */ (templateRead ? templateRead.value : {});

// The target is the user's real config. If it exists but is corrupt, preserve
// it to a .bak before rewriting, so a hand-edited file is never silently lost.
/** @type {Record<string, unknown>} */
let target = {};
try {
  const targetRead = readJsonOrThrow(targetFile);
  if (targetRead) target = /** @type {Record<string, unknown>} */ (targetRead.value);
} catch (err) {
  try {
    const raw = fs.readFileSync(targetFile, "utf8");
    writeFileAtomic(`${targetFile}.bak`, raw);
    console.error(
      `merge-config: ${targetFile} is not valid JSON (${/** @type {Error} */ (err)?.message || err}); backed up to ${targetFile}.bak and rewriting from template — reconcile any custom keys from the backup.`,
    );
  } catch {
    /* best-effort backup; proceed from empty */
  }
  target = {};
}
const incoming = /** @type {Record<string, unknown>} */ (template[topKey] || {});

// Must be a PLAIN object: an array (`typeof [] === "object"`, truthy) would silently
// swallow our string-keyed merge (JSON.stringify emits only an array's numeric indices).
const existingTop = target[topKey];
if (existingTop !== undefined && (typeof existingTop !== "object" || Array.isArray(existingTop))) {
  console.error(
    `merge-config: ${targetFile} "${topKey}" is not an object; resetting it to merge ${topKey}`,
  );
}
target[topKey] =
  existingTop && typeof existingTop === "object" && !Array.isArray(existingTop) ? existingTop : {};
const current = /** @type {Record<string, unknown>} */ (target[topKey]);
if (topKey === "hooks") mergeHookEvents(current, incoming);
else mergeServerEntries(current, incoming);

fs.mkdirSync(path.dirname(targetFile), { recursive: true });
writeFileAtomic(targetFile, `${JSON.stringify(target, null, 2)}\n`);
console.error(`merged ${topKey} into ${targetFile}`);
