#!/usr/bin/env node
// Merge a top-level key from a template JSON into a target JSON file,
// creating the target if absent. Used by bootstrap.sh to add our hooks to
// .claude/settings.json and our server to .mcp.json without clobbering the
// user's existing config.
//
//   node merge-config.mjs <targetFile> <templateFile> <topKey>
import fs from "node:fs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";

const [targetFile, templateFile, topKey] = process.argv.slice(2);
if (!targetFile || !templateFile || !topKey) {
  console.error("usage: merge-config.mjs <targetFile> <templateFile> <topKey>");
  process.exit(1);
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

target[topKey] = target[topKey] && typeof target[topKey] === "object" ? target[topKey] : {};
// Shallow-merge per server / per hook-event: our keys win, the user's other
// keys are preserved. We do NOT deep-merge hook arrays - a same-named event
// is replaced wholesale by ours (idempotent re-runs stay stable).
for (const [k, v] of Object.entries(incoming)) {
  /** @type {Record<string, unknown>} */ (target[topKey])[k] = v;
}

fs.mkdirSync(targetFile.replace(/\/[^/]*$/, "") || ".", { recursive: true });
writeFileAtomic(targetFile, `${JSON.stringify(target, null, 2)}\n`);
console.error(`merged ${topKey} into ${targetFile}`);
